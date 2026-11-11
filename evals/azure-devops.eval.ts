import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { resolveConfig, type ReviewConfig } from '@/src/config';
import {
  catalogAccessNextStep,
  describeSettings,
  getCatalogDisplayName,
  getSourceFileUrl,
  getSourcePullRequestInfo,
  resolvePullRequestContext,
} from '@/src/providers';
import { azureAuthorization, parseAzureRepository, toAzureDevOpsMarkdown } from '@/src/providers/azure-devops';
import { retryOptions } from '@/src/providers/http';
import { fitMarkdown } from '@/src/providers/markdown';
import type { ImpactPlanResponse } from '@/src/review-output';
import { checkoutCatalog } from '@/src/utils/checkout-catalog';
import { createOrUpdateCatalogPullRequest, preflightCatalogPullRequestAccess } from '@/src/utils/pull-requests/catalog-pr';
import { formatPullRequestReference } from '@/src/utils/pull-requests/format';
import {
  formatReviewComment,
  getPullRequestBody,
  postBreakingChangesSummary,
  resolveAdrComplianceSummary,
  type BreakingSchemaReport,
} from '@/src/utils/pull-requests/reporter';

/**
 * Offline tests for running the agents in Azure Pipelines against Azure Repos: reading the build's
 * pull request from the predefined variables, the REST calls for comments and catalog pull requests
 * (with `fetch` mocked), and the commits a build diffs. No model, no network.
 */

const exec = promisify(execFile);

/** The predefined variables Azure Pipelines sets for a build validation run on pull request 7. */
const PR_BUILD_ENV: NodeJS.ProcessEnv = {
  TF_BUILD: 'True',
  BUILD_REASON: 'PullRequest',
  BUILD_REPOSITORY_PROVIDER: 'TfsGit',
  BUILD_REPOSITORY_NAME: 'shop',
  BUILD_REPOSITORY_ID: 'repo-guid',
  BUILD_SOURCESDIRECTORY: '/agent/_work/1/s',
  BUILD_SOURCEVERSION: 'mergecommit',
  SYSTEM_COLLECTIONURI: 'https://dev.azure.com/acme/',
  SYSTEM_TEAMPROJECT: 'Commerce',
  SYSTEM_PULLREQUEST_PULLREQUESTID: '7',
  SYSTEM_ACCESSTOKEN: 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJidWlsZCJ9.c2lnbmF0dXJl',
  EVENTCATALOG_CATALOG_REPO: 'Architecture/eventcatalog',
  EVENTCATALOG_CATALOG_TOKEN: 'catalog-pat',
};

/** The build of `main` after pull request 7 merged: a CI build, with no pull request variables. */
const CI_BUILD_ENV: NodeJS.ProcessEnv = {
  ...PR_BUILD_ENV,
  BUILD_REASON: 'IndividualCI',
  SYSTEM_PULLREQUEST_PULLREQUESTID: undefined,
};

type Call = { method: string; url: URL; body?: unknown; authorization?: string };

/** Mocks `fetch` with a router of `METHOD /path` → JSON response, and records every call. */
const mockAzureDevOps = (routes: Record<string, unknown | ((call: Call) => unknown)>) => {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init: RequestInit = {}) => {
      const url = new URL(input);
      const method = init.method ?? 'GET';
      const call = {
        method,
        url,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
        authorization: (init.headers as Record<string, string>).Authorization,
      };
      calls.push(call);
      // `METHOD /path` matches that method and a path ending in `/path`; `/path` matches any method.
      const key = Object.keys(routes).find((route) => {
        const [routeMethod, routePath] = route.includes(' ') ? route.split(' ') : [undefined, route];
        return (!routeMethod || routeMethod === method) && url.pathname.endsWith(routePath);
      });
      if (!key)
        return new Response(JSON.stringify({ message: 'Not found' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        });
      const route = routes[key];
      const body = typeof route === 'function' ? route(call) : route;
      return new Response(JSON.stringify(body ?? {}), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    })
  );
  return calls;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('configuration', () => {
  test('reads an Azure Repos pull request build from the predefined variables', () => {
    const config = resolveConfig({}, PR_BUILD_ENV);

    expect(config.github).toBeUndefined();
    expect(config.azureDevOps).toMatchObject({
      collectionUri: 'https://dev.azure.com/acme/',
      project: 'Commerce',
      repository: 'shop',
      repositoryId: 'repo-guid',
      prNumber: 7,
    });
    expect(config.pullRequestState).toBe('open');
    expect(config.catalogProvider).toBe('azure-devops');
    expect(config.workspace).toBe('/agent/_work/1/s');
  });

  test('a build of the target branch runs after a merge, before its pull request is known', () => {
    const config = resolveConfig({}, CI_BUILD_ENV);
    expect(config.pullRequestState).toBe('merged');
    expect(config.azureDevOps?.prNumber).toBeUndefined();
  });

  test('GitHub runs are unchanged', () => {
    const config = resolveConfig({}, { GITHUB_REPOSITORY: 'acme/shop', GITHUB_TOKEN: 't', EVENTCATALOG_PR_NUMBER: '3' });
    expect(config.azureDevOps).toBeUndefined();
    expect(config.catalogProvider).toBe('github');
    expect(config.github).toMatchObject({ owner: 'acme', repo: 'shop', prNumber: 3 });
  });

  test('picks the catalog provider from the setting, then the repository URL, then the CI system', () => {
    expect(resolveConfig({ catalogProvider: 'github' }, PR_BUILD_ENV).catalogProvider).toBe('github');
    expect(resolveConfig({ catalogRepo: 'https://dev.azure.com/acme/Arch/_git/catalog' }, {}).catalogProvider).toBe(
      'azure-devops'
    );
    expect(() => resolveConfig({}, { EVENTCATALOG_CATALOG_PROVIDER: 'gitlab' })).toThrow(/Unknown catalog provider 'gitlab'/);
  });

  test('only pull request, CI, and manual builds are reviewed', () => {
    expect(resolveConfig({}, { ...CI_BUILD_ENV, BUILD_REASON: 'Manual' })).toMatchObject({
      pullRequestState: 'merged',
      skipReason: undefined,
    });
    expect(resolveConfig({}, { ...CI_BUILD_ENV, BUILD_REASON: 'BatchedCI' }).skipReason).toBeUndefined();
    expect(resolveConfig({}, { ...CI_BUILD_ENV, BUILD_REASON: 'Schedule' }).skipReason).toMatch(/reason: Schedule/);
  });

  test('the organization for short catalog names does not depend on the source token', () => {
    const config = resolveConfig({}, { ...PR_BUILD_ENV, SYSTEM_ACCESSTOKEN: undefined });
    expect(config.azureDevOps).toBeUndefined();
    expect(config.azureDevOpsOrganization).toEqual({ collectionUri: 'https://dev.azure.com/acme/', project: 'Commerce' });
    expect(getCatalogDisplayName(config)).toBe('Architecture/eventcatalog');
  });

  test('messages name settings the way each CI system writes them', () => {
    expect(describeSettings({}, ['catalog-repo', 'catalog-ref'])).toBe('`catalog-repo` and `catalog-ref` inputs');
    expect(describeSettings(resolveConfig({}, PR_BUILD_ENV), ['ignore-paths'])).toBe('`ignorePaths` parameter');
    expect(catalogAccessNextStep(resolveConfig({ catalogRepo: 'acme/catalog' }, {}))).toBe(
      'Give the `catalog-token` (or the GitHub App) read and write access to acme/catalog, with permission to open pull requests.'
    );
    expect(catalogAccessNextStep(resolveConfig({}, PR_BUILD_ENV))).toMatch(
      /^Give the pipeline's build service \(or the `catalogToken`\)/
    );
  });

  test('a GitHub repository built in Azure Pipelines is not treated as Azure Repos', () => {
    expect(resolveConfig({}, { ...PR_BUILD_ENV, BUILD_REPOSITORY_PROVIDER: 'GitHub' }).azureDevOps).toBeUndefined();
  });
});

describe('repositories and links', () => {
  const defaults = { collectionUri: 'https://dev.azure.com/acme/', project: 'Commerce' };

  test('reads a catalog repository from a URL, Project/Repo, or Repo', () => {
    expect(parseAzureRepository('https://acme@dev.azure.com/acme/Arch%20Team/_git/event%20catalog')).toEqual({
      collectionUri: 'https://dev.azure.com/acme/',
      project: 'Arch Team',
      repository: 'event catalog',
    });
    expect(parseAzureRepository('https://acme.visualstudio.com/Arch/_git/catalog')?.collectionUri).toBe(
      'https://acme.visualstudio.com/'
    );
    expect(parseAzureRepository('https://tfs.acme.local/tfs/DefaultCollection/Arch/_git/catalog')).toEqual({
      collectionUri: 'https://tfs.acme.local/tfs/DefaultCollection/',
      project: 'Arch',
      repository: 'catalog',
    });
    // A repository named after its project has no project in its URL.
    expect(parseAzureRepository('https://dev.azure.com/acme/_git/Orders')).toEqual({
      collectionUri: 'https://dev.azure.com/acme/',
      project: 'Orders',
      repository: 'Orders',
    });
    expect(parseAzureRepository('https://acme.visualstudio.com/DefaultCollection/Arch/_git/catalog')).toEqual({
      collectionUri: 'https://acme.visualstudio.com/DefaultCollection/',
      project: 'Arch',
      repository: 'catalog',
    });
    expect(parseAzureRepository('https://dev.azure.com/_git/catalog')).toBeUndefined();
    expect(parseAzureRepository('Arch/catalog', defaults)).toEqual({ ...defaults, project: 'Arch', repository: 'catalog' });
    expect(parseAzureRepository('catalog', defaults)).toEqual({ ...defaults, repository: 'catalog' });
    expect(parseAzureRepository('catalog')).toBeUndefined();
  });

  test('sends the pipeline token as a bearer token and a PAT with basic auth', () => {
    expect(azureAuthorization(PR_BUILD_ENV.SYSTEM_ACCESSTOKEN as string)).toBe(`Bearer ${PR_BUILD_ENV.SYSTEM_ACCESSTOKEN}`);
    expect(azureAuthorization('pat')).toBe(`Basic ${Buffer.from(':pat').toString('base64')}`);
  });

  test('links to the pull request, and to a line of a changed file', () => {
    const config = resolveConfig({}, PR_BUILD_ENV);
    const source = getSourcePullRequestInfo(config);

    expect(source).toMatchObject({ reference: 'Commerce/shop!7', repositorySlug: 'Commerce-shop', number: 7 });
    expect(source?.url).toBe('https://dev.azure.com/acme/Commerce/_git/shop/pullrequest/7');
    expect(formatPullRequestReference(source!.url)).toBe('Commerce/shop!7');
    expect(formatPullRequestReference('https://github.com/acme/catalog/pull/21')).toBe('acme/catalog#21');

    const fileUrl = new URL(getSourceFileUrl(config, 'abc123', 'src/orders.ts', 12) as string);
    expect(fileUrl.pathname).toBe('/acme/Commerce/_git/shop');
    expect(fileUrl.searchParams.get('path')).toBe('/src/orders.ts');
    expect(fileUrl.searchParams.get('version')).toBe('GCabc123');
    expect(fileUrl.searchParams.get('line')).toBe('12');
  });

  test('GitHub pull requests keep their references, and so their catalog branch names', () => {
    expect(getSourcePullRequestInfo({ github: { owner: 'acme', repo: 'shop', prNumber: 12, token: 't' } })).toEqual({
      number: 12,
      reference: 'acme/shop#12',
      repositorySlug: 'acme-shop',
      url: 'https://github.com/acme/shop/pull/12',
    });
  });

  test('the comment footer links the Azure Repos catalog', () => {
    const config = resolveConfig({}, PR_BUILD_ENV);
    const comment = formatReviewComment({ kind: 'not-run', reason: 'r', nextStep: 'n' }, config);
    expect(comment).toContain(
      'catalog [Architecture/eventcatalog@main](https://dev.azure.com/acme/Architecture/_git/eventcatalog?version=GBmain)'
    );
  });

  test('adapts GitHub markdown to what Azure DevOps renders', () => {
    const markdown = '<!-- eventcatalog-actions:pr-review -->\n### Title\n\n> [!NOTE]\n> Opened by agents.\n\n<sub>A · B</sub>\n';
    expect(toAzureDevOpsMarkdown(markdown)).toBe('### Title\n\n> **Note:** Opened by agents.\n\n_A · B_\n');
  });
});

describe('pull request comments', () => {
  const config = () => resolveConfig({}, PR_BUILD_ENV);
  const report: BreakingSchemaReport = {
    breakingChange: { fileName: 'a.json', isBreaking: true, confidence: 'high', summary: 's', breakingChanges: [] },
    consumers: [],
  };

  test('opens an active thread tagged with the agent marker', async () => {
    const calls = mockAzureDevOps({ 'GET /pullRequests/7/threads': { value: [] }, 'POST /pullRequests/7/threads': { id: 31 } });

    const url = await postBreakingChangesSummary(config(), [report]);

    expect(url).toBe('https://dev.azure.com/acme/Commerce/_git/shop/pullrequest/7?discussionId=31');
    const create = calls.find((call) => call.method === 'POST')!;
    expect(create.url.pathname).toBe('/acme/Commerce/_apis/git/repositories/repo-guid/pullRequests/7/threads');
    expect(create.url.searchParams.get('api-version')).toBe('6.0');
    expect(create.authorization).toMatch(/^Bearer /);
    expect(create.body).toMatchObject({
      status: 'active',
      properties: {
        'EventCatalogAgents.CommentMarker': { $type: 'System.String', $value: '<!-- eventcatalog-actions:breaking-changes -->' },
      },
    });
    const content = (create.body as { comments: { content: string }[] }).comments[0].content;
    expect(content).toMatch(/^### ⚠️ Breaking schema changes/);
    expect(content).not.toContain('<!--');
    expect(content).not.toContain('<sub>');
  });

  test('updates the earlier thread instead of opening another', async () => {
    const threads = [
      { id: 5, comments: [{ id: 1 }], properties: { other: { $value: 'x' } } },
      {
        id: 9,
        comments: [{ id: 1 }],
        properties: { 'EventCatalogAgents.CommentMarker': { $value: '<!-- eventcatalog-actions:breaking-changes -->' } },
      },
    ];
    const calls = mockAzureDevOps({
      'GET /pullRequests/7/threads': { value: threads },
      '/threads/9/comments/1': {},
      '/threads/9': {},
    });

    await postBreakingChangesSummary(config(), [report]);

    expect(calls.map((call) => `${call.method} ${call.url.pathname.split('/pullRequests/7')[1]}`)).toEqual([
      'GET /threads',
      'PATCH /threads/9/comments/1',
      'PATCH /threads/9',
    ]);
    expect(calls[2].body).toEqual({ status: 'active' });
  });

  test('marks an earlier ADR warning as resolved, and stays silent without one', async () => {
    const marker = { 'EventCatalogAgents.CommentMarker': { $value: '<!-- eventcatalog-actions:adr-compliance -->' } };
    let calls = mockAzureDevOps({
      'GET /pullRequests/7/threads': { value: [{ id: 4, comments: [{ id: 1 }], properties: marker }] },
      '/threads/4/comments/1': {},
      '/threads/4': {},
    });
    await resolveAdrComplianceSummary(config(), []);
    expect(calls.at(-1)?.body).toEqual({ status: 'fixed' });

    calls = mockAzureDevOps({ 'GET /pullRequests/7/threads': { value: [] } });
    expect(await resolveAdrComplianceSummary(config(), [])).toBeUndefined();
    expect(calls.filter((call) => call.method !== 'GET')).toEqual([]);
  });

  test('reads the pull request description for ADR exceptions', async () => {
    mockAzureDevOps({ 'GET /pullRequests/7': { description: 'adr-exception: adr-001 reason' } });
    expect(await getPullRequestBody(config())).toBe('adr-exception: adr-001 reason');
  });

  test('retries a call the server was too busy for, but never repeats a create', async () => {
    retryOptions.baseDelayMs = 1;
    let attempts = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit = {}) => {
        attempts++;
        if (attempts === 1) return new Response('busy', { status: 503 });
        if (init.method === 'POST') return new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } });
        return new Response(JSON.stringify({ value: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
      })
    );

    // The list of threads is retried after the 503; creating the thread is not.
    await expect(postBreakingChangesSummary(config(), [report])).rejects.toMatchObject({ status: 503 });
    expect(attempts).toBe(3);
    retryOptions.baseDelayMs = 1000;
  });

  test('an empty success is not mistaken for a rejected token', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 204 }))
    );
    expect(await getPullRequestBody(config())).toBeUndefined();
  });

  test('a token Azure DevOps rejects with a sign-in page fails as an auth error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>Sign in</html>', { status: 203, headers: { 'content-type': 'text/html' } }))
    );
    await expect(postBreakingChangesSummary(config(), [report])).rejects.toMatchObject({ status: 401 });
  });
});

describe('a build after a merge', () => {
  let workspace: string;
  let shas: { initial: string; base: string; feature: string; merge: string };

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'ec-azure-'));
    const git = async (...args: string[]) =>
      (
        await exec('git', ['-c', 'user.email=eval@eventcatalog.dev', '-c', 'user.name=eval', ...args], { cwd: workspace })
      ).stdout.trim();
    await git('init', '-q', '-b', 'main');
    await writeFile(join(workspace, 'a.txt'), 'a\n');
    await git('add', '-A');
    await git('commit', '-qm', 'base');
    const base = await git('rev-parse', 'HEAD');
    await git('checkout', '-qb', 'feature');
    await writeFile(join(workspace, 'b.txt'), 'b\n');
    await git('add', '-A');
    await git('commit', '-qm', 'feature');
    const feature = await git('rev-parse', 'HEAD');
    await git('checkout', '-q', 'main');
    await writeFile(join(workspace, 'c.txt'), 'c\n');
    await git('add', '-A');
    await git('commit', '-qm', 'main moved on');
    const mainTip = await git('rev-parse', 'HEAD');
    await git('merge', '-q', '--no-ff', '-m', 'Merged PR 7: feature', 'feature');
    shas = { initial: base, base: mainTip, feature, merge: await git('rev-parse', 'HEAD') };
  });

  afterEach(() => rm(workspace, { recursive: true, force: true }));

  test('diffs the merge commit against the target branch, and finds the pull request that merged', async () => {
    const calls = mockAzureDevOps({
      'POST /pullrequestquery': ({ body }: Call) => {
        const sha = (body as { queries: { items: string[] }[] }).queries[0].items[0];
        return { results: [{ [sha]: [{ pullRequestId: 7, status: 'completed' }] }] };
      },
    });
    const env = { ...CI_BUILD_ENV, BUILD_SOURCEVERSION: undefined };

    const config = await resolvePullRequestContext(resolveConfig({ workspace }, env));

    expect(config).toMatchObject({ baseSha: shas.base, headSha: shas.feature, pullRequestState: 'merged' });
    expect(config.azureDevOps?.prNumber).toBe(7);
    expect(calls[0].body).toEqual({ queries: [{ type: 'lastMergeCommit', items: [shas.merge] }] });
  });

  test('a rebased and fast-forwarded pull request diffs from the commit it merged onto', async () => {
    // The checked-out commit has one parent (shas.initial), but the pull request merged onto shas.base.
    const head = await exec('git', ['-C', workspace, 'rev-parse', 'HEAD^2']);
    await exec('git', ['-C', workspace, 'checkout', '-q', head.stdout.trim()]);
    mockAzureDevOps({
      'POST /pullrequestquery': ({ body }: Call) => {
        const sha = (body as { queries: { items: string[] }[] }).queries[0].items[0];
        return {
          results: [{ [sha]: [{ pullRequestId: 8, status: 'completed', lastMergeTargetCommit: { commitId: shas.base } }] }],
        };
      },
    });

    const config = await resolvePullRequestContext(
      resolveConfig({ workspace }, { ...CI_BUILD_ENV, BUILD_SOURCEVERSION: shas.feature })
    );

    expect(config).toMatchObject({ baseSha: shas.base, headSha: shas.feature });
    expect(config.azureDevOps?.prNumber).toBe(8);
  });

  test('a commit no pull request merged has nothing to review', async () => {
    mockAzureDevOps({ 'POST /pullrequestquery': { results: [{}] } });
    const config = await resolvePullRequestContext(resolveConfig({ workspace }, CI_BUILD_ENV));

    expect(config.skipReason).toMatch(/No completed pull request merged as commit mergecommit/);
    expect(config.azureDevOps?.prNumber).toBeUndefined();
  });

  test('a pull request that is still active or was abandoned is not a merge', async () => {
    mockAzureDevOps({
      'POST /pullrequestquery': {
        results: [
          {
            mergecommit: [
              { pullRequestId: 7, status: 'active' },
              { pullRequestId: 6, status: 'abandoned' },
            ],
          },
        ],
      },
    });
    const config = await resolvePullRequestContext(resolveConfig({ workspace }, CI_BUILD_ENV));
    expect(config.skipReason).toMatch(/No completed pull request/);
  });

  test('a shallow build of a direct push is skipped, not failed', async () => {
    const shallow = await mkdtemp(join(tmpdir(), 'ec-azure-shallow-ci-'));
    try {
      await exec('git', ['clone', '-q', '--depth', '1', `file://${workspace}`, shallow]);
      mockAzureDevOps({ 'POST /pullrequestquery': { results: [{}] } });
      const env = { ...CI_BUILD_ENV, BUILD_SOURCEVERSION: undefined };

      const config = await resolvePullRequestContext(resolveConfig({ workspace: shallow }, env));

      expect(config.skipReason).toMatch(/No completed pull request merged/);
    } finally {
      await rm(shallow, { recursive: true, force: true });
    }
  });

  test('a shallow checkout explains how to fix it', async () => {
    const shallow = await mkdtemp(join(tmpdir(), 'ec-azure-shallow-'));
    try {
      await exec('git', ['clone', '-q', '--depth', '1', `file://${workspace}`, shallow]);
      await expect(resolvePullRequestContext(resolveConfig({ workspace: shallow }, PR_BUILD_ENV))).rejects.toThrow(
        /fetchDepth: 0/
      );
    } finally {
      await rm(shallow, { recursive: true, force: true });
    }
  });
});

describe('catalog pull requests in Azure Repos', () => {
  let root: string;
  let config: ReviewConfig;

  const plan: ImpactPlanResponse = {
    catalogChangesRequired: true,
    sourcePrSummary: '',
    catalogImpactSummary: '',
    sourceChanges: [],
    proposedCatalogTargets: [],
    outOfScopeFindings: [],
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ec-azure-catalog-'));
    const remote = join(root, 'remote.git');
    const catalog = join(root, 'workspace', 'eventcatalog');
    await exec('git', ['init', '-q', '--bare', '-b', 'main', remote]);
    await mkdir(catalog, { recursive: true });
    const git = (...args: string[]) =>
      exec('git', ['-c', 'user.email=eval@eventcatalog.dev', '-c', 'user.name=eval', ...args], { cwd: catalog });
    await git('init', '-q', '-b', 'main');
    await writeFile(join(catalog, 'eventcatalog.config.js'), 'export default {};\n');
    await git('add', '-A');
    await git('commit', '-qm', 'catalog');
    await git('remote', 'add', 'origin', remote);
    await git('push', '-q', 'origin', 'main');
    await writeFile(join(catalog, 'README.md'), 'changed\n');
    config = resolveConfig({ workspace: join(root, 'workspace') }, PR_BUILD_ENV);
  });

  afterEach(() => rm(root, { recursive: true, force: true }));

  test('pushes the branch and opens a pull request, shortened to the description limit', async () => {
    const calls = mockAzureDevOps({
      'GET /pullrequests': { value: [] },
      'POST /pullrequests': { pullRequestId: 42 },
    });

    const result = await createOrUpdateCatalogPullRequest(config, {
      impactPlan: plan,
      result: { prTitle: 'docs: update', prSummary: 'x'.repeat(9000), sourcePrSummary: '' },
    });

    expect(result.pullRequestUrl).toBe('https://dev.azure.com/acme/Architecture/_git/eventcatalog/pullrequest/42');
    const { stdout } = await exec('git', ['--git-dir', join(root, 'remote.git'), 'branch', '--list']);
    expect(stdout).toContain('eventcatalog-actions/commerce-shop/pr-7');

    const create = calls.find((call) => call.method === 'POST')!;
    expect(create.url.pathname).toBe('/acme/Architecture/_apis/git/repositories/eventcatalog/pullrequests');
    expect(create.authorization).toBe(`Basic ${Buffer.from(':catalog-pat').toString('base64')}`);
    const body = create.body as { sourceRefName: string; targetRefName: string; description: string };
    expect(body.sourceRefName).toBe('refs/heads/eventcatalog-actions/commerce-shop/pr-7');
    expect(body.targetRefName).toBe('refs/heads/main');
    expect(body.description.length).toBeLessThanOrEqual(4000);
    expect(body.description).toMatch(/^> \*\*Note:\*\* Opened by \[EventCatalog Agents\].* for \[Commerce\/shop!7\]/);
    expect(body.description).toMatch(/4000-character limit\._$/);
  });

  test('shortening a description ends at a paragraph and closes an open code block', () => {
    const markdown = `Intro.\n\n\`\`\`yaml\n${'key: value\n'.repeat(50)}\`\`\`\n`;
    const fitted = fitMarkdown(markdown, 200, '\n\n_cut_');

    expect(fitted.length).toBeLessThanOrEqual(200);
    expect(fitted).toMatch(/key: value\n```\n\n_cut_$/);
    expect(fitMarkdown(`${'One paragraph. '.repeat(10)}\n\n${'Two. '.repeat(40)}`, 200, ' _cut_')).toBe(
      `${'One paragraph. '.repeat(10).trimEnd()} _cut_`
    );
  });

  test('updates the open pull request for the same branch', async () => {
    const calls = mockAzureDevOps({ 'GET /pullrequests': { value: [{ pullRequestId: 42 }] }, 'PATCH /pullrequests/42': {} });

    await createOrUpdateCatalogPullRequest(config, {
      impactPlan: plan,
      result: { prTitle: 't', prSummary: 's', sourcePrSummary: '' },
    });

    const search = calls[0].url.searchParams;
    expect(search.get('searchCriteria.sourceRefName')).toBe('refs/heads/eventcatalog-actions/commerce-shop/pr-7');
    expect(search.get('searchCriteria.status')).toBe('active');
    expect(calls.map((call) => call.method)).toEqual(['GET', 'PATCH']);
  });

  test('preflight checks the repository and the branch', async () => {
    mockAzureDevOps({
      'GET /repositories/eventcatalog': { id: 'g' },
      'GET /refs': {
        value: [
          { name: 'refs/heads/main-old', objectId: 'x' },
          { name: 'refs/heads/main', objectId: 'sha1' },
        ],
      },
    });
    expect(await preflightCatalogPullRequestAccess(config)).toEqual({ branchSha: 'sha1', fullName: 'Architecture/eventcatalog' });

    mockAzureDevOps({ 'GET /repositories/eventcatalog': { id: 'g' }, 'GET /refs': { value: [] } });
    await expect(preflightCatalogPullRequestAccess(config)).rejects.toThrow(
      'Catalog ref "main" was not found in Architecture/eventcatalog'
    );
  });

  test('the catalog checkout refuses to replace a directory that is not a checkout', async () => {
    const workspace = join(root, 'other');
    await mkdir(join(workspace, 'eventcatalog'), { recursive: true });
    await writeFile(join(workspace, 'eventcatalog', 'notes.txt'), 'mine\n');
    await expect(checkoutCatalog(resolveConfig({ workspace }, PR_BUILD_ENV))).rejects.toThrow(/is not a catalog checkout/);
    await expect(checkoutCatalog(resolveConfig({ workspace, catalogRef: '--upload-pack=x' }, PR_BUILD_ENV))).rejects.toThrow(
      /Invalid catalog ref/
    );
  });
});
