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
  getCatalogProvider,
  getCatalogTreeUrl,
  getSourceFileUrl,
  getSourcePullRequestInfo,
  resolvePullRequestContext,
} from '@/src/providers';
import { bitbucketAuthorization, parseBitbucketRepository, toBitbucketMarkdown } from '@/src/providers/bitbucket';
import { retryOptions } from '@/src/providers/http';
import type { ImpactPlanResponse } from '@/src/review-output';
import { createOrUpdateCatalogPullRequest, preflightCatalogPullRequestAccess } from '@/src/utils/pull-requests/catalog-pr';
import { formatPullRequestReference } from '@/src/utils/pull-requests/format';
import {
  getPullRequestBody,
  postAdrComplianceSummary,
  postBreakingChangesSummary,
  postPullRequestSummary,
  resolveAdrComplianceSummary,
  type BreakingSchemaReport,
} from '@/src/utils/pull-requests/reporter';

/**
 * Offline tests for running the agents in Bitbucket Pipelines against Bitbucket Cloud: reading the
 * pipeline's pull request from the default variables, the REST calls for comments and catalog pull
 * requests (with `fetch` mocked), and the commits a pipeline diffs. No model, no network.
 */

const exec = promisify(execFile);

/** The default variables Bitbucket Pipelines sets for a pull request pipeline on pull request 7. */
const PR_PIPELINE_ENV: NodeJS.ProcessEnv = {
  CI: 'true',
  BITBUCKET_BUILD_NUMBER: '12',
  BITBUCKET_WORKSPACE: 'acme',
  BITBUCKET_REPO_SLUG: 'shop',
  BITBUCKET_REPO_FULL_NAME: 'acme/shop',
  BITBUCKET_CLONE_DIR: '/opt/atlassian/pipelines/agent/build',
  BITBUCKET_BRANCH: 'feature/orders',
  BITBUCKET_COMMIT: 'sourcecommit',
  BITBUCKET_PR_ID: '7',
  BITBUCKET_PR_DESTINATION_BRANCH: 'main',
  BITBUCKET_PR_DESTINATION_COMMIT: 'destcommit',
  EVENTCATALOG_BITBUCKET_TOKEN: 'source-access-token',
  EVENTCATALOG_CATALOG_REPO: 'eventcatalog',
};

/** The branch pipeline of `main` after pull request 7 merged: no pull request variables. */
const BRANCH_PIPELINE_ENV: NodeJS.ProcessEnv = {
  ...PR_PIPELINE_ENV,
  BITBUCKET_BRANCH: 'main',
  BITBUCKET_COMMIT: 'mergecommit',
  BITBUCKET_PR_ID: undefined,
  BITBUCKET_PR_DESTINATION_BRANCH: undefined,
  BITBUCKET_PR_DESTINATION_COMMIT: undefined,
};

type Call = { method: string; url: URL; body?: unknown; authorization?: string };

/** Mocks `fetch` with a router of `METHOD /path` → JSON response, and records every call. */
const mockBitbucket = (routes: Record<string, unknown | ((call: Call) => unknown)>) => {
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
        return new Response(JSON.stringify({ type: 'error', error: { message: 'Not found' } }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        });
      const route = routes[key];
      const body = typeof route === 'function' ? route(call) : route;
      return new Response(JSON.stringify(body ?? {}), { status: 200, headers: { 'content-type': 'application/json' } });
    })
  );
  return calls;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('configuration', () => {
  test('reads a pull request pipeline from the default variables', () => {
    const config = resolveConfig(undefined, PR_PIPELINE_ENV);

    expect(config.bitbucket).toEqual({
      branch: 'feature/orders',
      commit: 'sourcecommit',
      destinationCommit: 'destcommit',
      prNumber: 7,
      repository: 'shop',
      token: 'source-access-token',
      workspace: 'acme',
    });
    expect(config).toMatchObject({
      bitbucketWorkspace: 'acme',
      catalogProvider: 'bitbucket',
      pullRequestState: 'open',
      workspace: '/opt/atlassian/pipelines/agent/build',
    });
    expect(config.github).toBeUndefined();
    expect(config.azureDevOps).toBeUndefined();
  });

  test('a branch pipeline runs after a merge, before its pull request is known', () => {
    const config = resolveConfig(undefined, BRANCH_PIPELINE_ENV);
    expect(config.pullRequestState).toBe('merged');
    expect(config.bitbucket?.prNumber).toBeUndefined();
    expect(config.skipReason).toBeUndefined();
  });

  test('a tag pipeline has nothing to review', () => {
    expect(resolveConfig(undefined, { ...BRANCH_PIPELINE_ENV, BITBUCKET_TAG: 'v1.0.0' }).skipReason).toMatch(
      /built the tag v1.0.0/
    );
  });

  test('the source token is the catalog token unless one is set, for a catalog on Bitbucket only', () => {
    expect(resolveConfig(undefined, PR_PIPELINE_ENV).catalogToken).toBe('source-access-token');
    expect(resolveConfig(undefined, { ...PR_PIPELINE_ENV, EVENTCATALOG_CATALOG_TOKEN: 'catalog' }).catalogToken).toBe('catalog');
    const github = resolveConfig(undefined, { ...PR_PIPELINE_ENV, EVENTCATALOG_CATALOG_PROVIDER: 'github' });
    expect(github.catalogToken).toBeUndefined();
  });

  test('picks the catalog provider from the setting, then the repository URL, then the CI system', () => {
    expect(resolveConfig({ catalogRepo: 'https://bitbucket.org/acme/catalog' }, {}).catalogProvider).toBe('bitbucket');
    expect(resolveConfig({ catalogRepo: 'acme/catalog' }, {}).catalogProvider).toBe('github');
    expect(resolveConfig({ catalogProvider: 'github' }, PR_PIPELINE_ENV).catalogProvider).toBe('github');
    expect(() => resolveConfig({ catalogProvider: 'gitlab' as never }, {})).toThrow(/bitbucket/);
  });

  test('GitHub and Azure Pipelines runs are unchanged', () => {
    const github = resolveConfig(undefined, {
      GITHUB_ACTIONS: 'true',
      GITHUB_REPOSITORY: 'acme/shop',
      GITHUB_TOKEN: 't',
      GITHUB_PR_NUMBER: '3',
    } as NodeJS.ProcessEnv);
    expect(github.bitbucket).toBeUndefined();
    expect(github.bitbucketWorkspace).toBeUndefined();
    expect(github.catalogProvider).toBe('github');
    expect(describeSettings(github, ['catalog-repo'])).toBe('`catalog-repo` input');
  });

  test('messages name settings the way the pipeline script takes them', () => {
    const config = resolveConfig(undefined, PR_PIPELINE_ENV);
    expect(describeSettings(config, ['catalog-repo', 'catalog-ref'])).toBe('`--catalog-repo` and `--catalog-ref` options');
    expect(catalogAccessNextStep(config)).toBe(
      'Give the access token in `EVENTCATALOG_CATALOG_TOKEN` (or `EVENTCATALOG_BITBUCKET_TOKEN`, when that is unset) the Repositories: Write and Pull requests: Write permissions on acme/eventcatalog.'
    );
  });
});

describe('repositories and links', () => {
  test('reads a catalog repository from a URL, workspace/repo, or repo', () => {
    expect(parseBitbucketRepository('https://bitbucket.org/acme/catalog')).toEqual({ workspace: 'acme', repository: 'catalog' });
    expect(parseBitbucketRepository('https://dave@bitbucket.org/acme/catalog.git')).toEqual({
      workspace: 'acme',
      repository: 'catalog',
    });
    expect(parseBitbucketRepository('https://bitbucket.org/acme/catalog/src/main/')).toEqual({
      workspace: 'acme',
      repository: 'catalog',
    });
    expect(parseBitbucketRepository('bitbucket.org/acme/catalog')).toEqual({ workspace: 'acme', repository: 'catalog' });
    expect(resolveConfig({ catalogRepo: 'bitbucket.org/acme/catalog' }, {}).catalogProvider).toBe('bitbucket');
    expect(parseBitbucketRepository('acme/catalog')).toEqual({ workspace: 'acme', repository: 'catalog' });
    expect(parseBitbucketRepository('catalog', 'acme')).toEqual({ workspace: 'acme', repository: 'catalog' });
    expect(parseBitbucketRepository('catalog')).toBeUndefined();
    expect(parseBitbucketRepository('https://github.com/acme/catalog')).toBeUndefined();
    expect(parseBitbucketRepository('a/b/c')).toBeUndefined();
  });

  test('sends an access token as a bearer token and an API token with basic auth', () => {
    expect(bitbucketAuthorization('ATCTT3x')).toBe('Bearer ATCTT3x');
    expect(bitbucketAuthorization('dev@acme.com:ATATT3x')).toBe(
      `Basic ${Buffer.from('dev@acme.com:ATATT3x').toString('base64')}`
    );
  });

  test('git credentials go in the environment, scoped to the catalog repository', () => {
    const access = getCatalogProvider(resolveConfig(undefined, PR_PIPELINE_ENV));
    expect(access.cloneUrl()).toBe('https://bitbucket.org/acme/eventcatalog.git');
    expect(access.gitEnv()).toEqual({
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.https://bitbucket.org/acme/eventcatalog.git.extraheader',
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: Basic ${Buffer.from('x-token-auth:source-access-token').toString('base64')}`,
    });

    const api = getCatalogProvider(resolveConfig({ catalogToken: 'dev@acme.com:ATATT3x' }, PR_PIPELINE_ENV));
    expect(api.gitEnv().GIT_CONFIG_VALUE_0).toBe(
      `AUTHORIZATION: Basic ${Buffer.from('x-bitbucket-api-token-auth:ATATT3x').toString('base64')}`
    );
  });

  test('links to the pull request, a line of a changed file, and the catalog', () => {
    const config = resolveConfig(undefined, PR_PIPELINE_ENV);
    expect(getSourcePullRequestInfo(config)).toEqual({
      number: 7,
      reference: 'acme/shop#7',
      repositorySlug: 'acme-shop',
      url: 'https://bitbucket.org/acme/shop/pull-requests/7',
    });
    expect(getSourceFileUrl(config, 'abc123', 'src/orders api.ts', 12)).toBe(
      'https://bitbucket.org/acme/shop/src/abc123/src/orders%20api.ts#lines-12'
    );
    expect(getCatalogDisplayName(config)).toBe('acme/eventcatalog');
    expect(getCatalogTreeUrl(config, 'adrs/adr-001')).toBe('https://bitbucket.org/acme/eventcatalog/src/main/adrs/adr-001');
    expect(formatPullRequestReference('https://bitbucket.org/acme/eventcatalog/pull-requests/21')).toBe('acme/eventcatalog#21');
  });

  test('adapts GitHub markdown to what Bitbucket renders, keeping the marker out of sight', () => {
    const markdown = toBitbucketMarkdown(
      '<!-- eventcatalog-actions:adr-compliance -->\n### Title\n\n> [!WARNING]\n> Careful.\n\n<sub>footer</sub>'
    );
    expect(markdown).toBe('[//]: # (eventcatalog-actions:adr-compliance)\n\n### Title\n\n> **Warning:** Careful.\n\n_footer_');
  });
});

describe('pull request comments', () => {
  const config = () => resolveConfig(undefined, PR_PIPELINE_ENV);
  const report: BreakingSchemaReport = {
    breakingChange: { fileName: 'a.json', isBreaking: true, confidence: 'high', summary: 's', breakingChanges: [] },
    consumers: [],
  };
  const marked = (id: string) => `[//]: # (eventcatalog-actions:${id})\n\nold`;

  test('creates a comment carrying the agent marker', async () => {
    const calls = mockBitbucket({
      'GET /pullrequests/7/comments': { values: [] },
      'POST /pullrequests/7/comments': {
        id: 31,
        links: { html: { href: 'https://bitbucket.org/acme/shop/pull-requests/7#comment-31' } },
      },
    });

    const url = await postBreakingChangesSummary(config(), [report]);

    expect(url).toBe('https://bitbucket.org/acme/shop/pull-requests/7#comment-31');
    const create = calls.find((call) => call.method === 'POST')!;
    expect(create.url.href).toBe('https://api.bitbucket.org/2.0/repositories/acme/shop/pullrequests/7/comments');
    expect(create.authorization).toBe('Bearer source-access-token');
    const raw = (create.body as { content: { raw: string } }).content.raw;
    expect(raw).toMatch(/^\[\/\/\]: # \(eventcatalog-actions:breaking-changes\)\n\n### ⚠️ Breaking schema changes/);
    expect(raw).not.toContain('<!--');
    expect(raw).not.toContain('<sub>');
  });

  test('updates the earlier comment, found across pages, instead of creating another', async () => {
    const calls = mockBitbucket({
      'GET /pullrequests/7/comments': ({ url }: Call) =>
        url.searchParams.get('page') === '2'
          ? {
              values: [
                { id: 8, deleted: true, content: { raw: marked('breaking-changes') } },
                { id: 9, content: { raw: marked('breaking-changes') } },
              ],
            }
          : {
              values: [
                { id: 5, content: { raw: marked('adr-compliance') } },
                { id: 6, parent: { id: 9 }, content: { raw: marked('breaking-changes') } },
              ],
              next: 'https://api.bitbucket.org/2.0/repositories/acme/shop/pullrequests/7/comments?pagelen=100&page=2',
            },
      'PUT /comments/9': { id: 9 },
    });

    const url = await postBreakingChangesSummary(config(), [report]);

    expect(calls.map((call) => `${call.method} ${call.url.pathname.split('/pullrequests/7')[1]}`)).toEqual([
      'GET /comments',
      'GET /comments',
      'PUT /comments/9',
    ]);
    expect(url).toBe('https://bitbucket.org/acme/shop/pull-requests/7#comment-9');
  });

  test('resolves an earlier ADR warning once it no longer applies, and stays silent without one', async () => {
    let calls = mockBitbucket({
      'GET /pullrequests/7/comments': { values: [{ id: 4, content: { raw: marked('adr-compliance') } }] },
      'PUT /comments/4': { id: 4 },
      'POST /comments/4/resolve': {},
    });
    await resolveAdrComplianceSummary(config(), []);
    expect(calls.map((call) => `${call.method} ${call.url.pathname.split('/pullrequests/7')[1]}`)).toEqual([
      'GET /comments',
      'PUT /comments/4',
      'POST /comments/4/resolve',
    ]);

    calls = mockBitbucket({ 'GET /pullrequests/7/comments': { values: [] } });
    expect(await resolveAdrComplianceSummary(config(), [])).toBeUndefined();
    expect(calls.filter((call) => call.method !== 'GET')).toEqual([]);
  });

  test('reopens a resolved comment when there is a warning again', async () => {
    const calls = mockBitbucket({
      'GET /pullrequests/7/comments': {
        values: [{ id: 4, resolution: { type: 'resolved' }, content: { raw: marked('breaking-changes') } }],
      },
      'PUT /comments/4': { id: 4 },
      'DELETE /comments/4/resolve': {},
    });
    await postBreakingChangesSummary(config(), [report]);
    expect(calls.at(-1)?.method).toBe('DELETE');
  });

  test('information leaves a comment resolved by hand as it is', async () => {
    const calls = mockBitbucket({
      'GET /pullrequests/7/comments': {
        values: [{ id: 4, resolution: { type: 'resolved' }, content: { raw: marked('pr-review') } }],
      },
      'PUT /comments/4': { id: 4 },
    });
    await postPullRequestSummary(config(), { kind: 'not-run', reason: 'r', nextStep: 'n' });
    expect(calls.map((call) => call.method)).toEqual(['GET', 'PUT']);
  });

  test('a comment that cannot be resolved is still updated', async () => {
    mockBitbucket({
      'GET /pullrequests/7/comments': { values: [{ id: 4, content: { raw: marked('adr-compliance') } }] },
      'PUT /comments/4': { id: 4 },
    });
    await expect(resolveAdrComplianceSummary(config(), [])).resolves.toBe(
      'https://bitbucket.org/acme/shop/pull-requests/7#comment-4'
    );
  });

  test('reads the pull request description for ADR exceptions', async () => {
    mockBitbucket({ 'GET /pullrequests/7': { description: 'adr-exception: adr-001 reason' } });
    expect(await getPullRequestBody(config())).toBe('adr-exception: adr-001 reason');
  });

  test('retries a call the server was too busy for, but never repeats a create', async () => {
    retryOptions.baseDelayMs = 0;
    try {
      const statuses: number[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string, init: RequestInit = {}) => {
          const isCreate = init.method === 'POST';
          const status = isCreate ? 500 : statuses.length === 0 ? 429 : 200;
          statuses.push(status);
          return new Response(JSON.stringify({ values: [] }), {
            status,
            headers: { 'content-type': 'application/json' },
          });
        })
      );
      await expect(postBreakingChangesSummary(config(), [report])).rejects.toThrow(/Bitbucket POST .* failed \(500\)/);
      expect(statuses).toEqual([429, 200, 500]);
    } finally {
      retryOptions.baseDelayMs = 1000;
    }
  });

  test('a rejected token fails with an auth error that names the problem', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"type":"error","error":{"message":"Unauthorized"}}', { status: 401 }))
    );
    await expect(postBreakingChangesSummary(config(), [report])).rejects.toMatchObject({
      status: 401,
      message: expect.stringMatching(/failed \(401\): Unauthorized: the token was not accepted/),
    });
  });

  test('a missing token says which variable to set', async () => {
    const noToken = resolveConfig(undefined, { ...PR_PIPELINE_ENV, EVENTCATALOG_BITBUCKET_TOKEN: undefined });
    await expect(resolvePullRequestContext(noToken)).rejects.toThrow(/EVENTCATALOG_BITBUCKET_TOKEN secured repository variable/);
    await expect(postAdrComplianceSummary(noToken, { conflicts: [], exceptions: [], adrs: [] })).rejects.toThrow(
      /EVENTCATALOG_BITBUCKET_TOKEN/
    );
  });
});

describe('the commits a pipeline diffs', () => {
  let workspace: string;
  let shas: { initial: string; base: string; feature: string; merge: string; squash: string };
  const git = async (...args: string[]) =>
    (
      await exec('git', ['-c', 'user.email=eval@eventcatalog.dev', '-c', 'user.name=eval', ...args], { cwd: workspace })
    ).stdout.trim();

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'ec-bitbucket-'));
    await git('init', '-q', '-b', 'main');
    await writeFile(join(workspace, 'a.txt'), 'a\n');
    await git('add', '-A');
    await git('commit', '-qm', 'base');
    const initial = await git('rev-parse', 'HEAD');
    await git('checkout', '-qb', 'feature');
    await writeFile(join(workspace, 'b.txt'), 'b\n');
    await git('add', '-A');
    await git('commit', '-qm', 'feature');
    const feature = await git('rev-parse', 'HEAD');
    await git('checkout', '-q', 'main');
    await writeFile(join(workspace, 'c.txt'), 'c\n');
    await git('add', '-A');
    await git('commit', '-qm', 'main moved on');
    const base = await git('rev-parse', 'HEAD');
    // A squash merge: one commit on main with the feature's change.
    await git('checkout', '-qb', 'squashed');
    await git('merge', '-q', '--squash', 'feature');
    await git('commit', '-qm', 'Squashed PR 7');
    const squash = await git('rev-parse', 'HEAD');
    await git('checkout', '-q', 'main');
    await git('merge', '-q', '--no-ff', '-m', 'Merged in feature (pull request #7)', 'feature');
    shas = { initial, base, feature, merge: await git('rev-parse', 'HEAD'), squash };
  });

  afterEach(() => rm(workspace, { recursive: true, force: true }));

  const mergedPullRequests = (values: unknown[], commitMessages: string[] = []) =>
    mockBitbucket({
      'GET /pullrequests': { values },
      'GET /commits': { values: commitMessages.map((message) => ({ message: `${message}\n` })) },
    });

  /** Commits `messages` on top of `onto`, as a rebase onto the target branch would. Returns the last. */
  const commitOnto = async (onto: string, messages: string[]) => {
    await git('checkout', '-q', '--detach', onto);
    for (const [index, message] of messages.entries()) {
      await writeFile(join(workspace, `rebased-${index}.txt`), `${index}\n`);
      await git('add', '-A');
      await git('commit', '-qm', message);
    }
    return git('rev-parse', 'HEAD');
  };

  test('a pull request pipeline diffs the source commit against the target branch', async () => {
    const env = { ...PR_PIPELINE_ENV, BITBUCKET_COMMIT: shas.feature, BITBUCKET_PR_DESTINATION_COMMIT: shas.base.slice(0, 12) };
    const config = await resolvePullRequestContext(resolveConfig({ workspace }, env));
    expect(config).toMatchObject({ baseSha: shas.base, headSha: shas.feature, pullRequestState: 'open' });
  });

  test('without the target branch variable, uses the target branch Bitbucket merged into the checkout', async () => {
    // Bitbucket checks out the source commit and merges the target branch into it.
    await git('checkout', '-q', shas.feature);
    await git('merge', '-q', '--no-ff', '-m', 'Merge main', shas.base);
    const env = { ...PR_PIPELINE_ENV, BITBUCKET_COMMIT: shas.feature, BITBUCKET_PR_DESTINATION_COMMIT: undefined };
    const config = await resolvePullRequestContext(resolveConfig({ workspace }, env));
    expect(config).toMatchObject({ baseSha: shas.base, headSha: shas.feature });
  });

  test('after a merge commit, finds the pull request and diffs against the target branch before it', async () => {
    const calls = mergedPullRequests([
      { id: 6, merge_commit: { hash: 'aaaaaaaaaaaa' } },
      { id: 7, merge_commit: { hash: shas.merge.slice(0, 12) }, source: { commit: { hash: shas.feature.slice(0, 12) } } },
    ]);
    const env = { ...BRANCH_PIPELINE_ENV, BITBUCKET_COMMIT: shas.merge };

    const config = await resolvePullRequestContext(resolveConfig({ workspace }, env));

    expect(config).toMatchObject({ baseSha: shas.base, headSha: shas.merge, pullRequestState: 'merged' });
    expect(config.bitbucket?.prNumber).toBe(7);
    expect(calls[0].url.searchParams.get('state')).toBe('MERGED');
    expect(calls[0].url.searchParams.get('q')).toBe('destination.branch.name = "main"');
  });

  test('a squashed pull request diffs against its parent', async () => {
    mergedPullRequests([{ id: 7, merge_commit: { hash: shas.squash.slice(0, 12) } }], ['feature', 'feature: fix']);
    const config = await resolvePullRequestContext(
      resolveConfig({ workspace }, { ...BRANCH_PIPELINE_ENV, BITBUCKET_COMMIT: shas.squash })
    );
    expect(config).toMatchObject({ baseSha: shas.base, headSha: shas.squash });
  });

  test('a fast-forwarded pull request of one commit diffs against its parent', async () => {
    // Fast-forward: main moves to the feature commit, whose parent is the older initial commit.
    mergedPullRequests([{ id: 8, merge_commit: { hash: shas.feature.slice(0, 12) } }], ['feature']);
    const config = await resolvePullRequestContext(
      resolveConfig({ workspace }, { ...BRANCH_PIPELINE_ENV, BITBUCKET_COMMIT: shas.feature })
    );
    expect(config).toMatchObject({ baseSha: shas.initial, headSha: shas.feature });
    expect(config.bitbucket?.prNumber).toBe(8);
  });

  test('a rebased and fast-forwarded pull request diffs all of its commits', async () => {
    const messages = ['orders: add OrderShipped', 'orders: add the schema\n\nWith a body.', 'orders: fix a typo'];
    const head = await commitOnto(shas.base, messages);
    // The API lists the pull request's original commits, newest first, with the messages the rebase kept.
    mergedPullRequests([{ id: 9, merge_commit: { hash: head.slice(0, 12) } }], [...messages].reverse());

    const config = await resolvePullRequestContext(
      resolveConfig({ workspace }, { ...BRANCH_PIPELINE_ENV, BITBUCKET_COMMIT: head })
    );

    expect(config).toMatchObject({ baseSha: shas.base, headSha: head });
  });

  test('a squash whose commit differs from the pull request commits diffs only the squashed commit', async () => {
    const head = await commitOnto(shas.base, ['Merged in feature (pull request #9)']);
    mergedPullRequests([{ id: 9, merge_commit: { hash: head.slice(0, 12) } }], ['one', 'two']);
    const config = await resolvePullRequestContext(
      resolveConfig({ workspace }, { ...BRANCH_PIPELINE_ENV, BITBUCKET_COMMIT: head })
    );
    expect(config).toMatchObject({ baseSha: shas.base, headSha: head });
  });

  test('a scheduled pipeline has nothing to review', async () => {
    const calls = mockBitbucket({
      'GET /pipelines/%7Bpipeline-uuid%7D': { trigger: { type: 'pipeline_trigger_schedule' } },
    });
    const env = { ...BRANCH_PIPELINE_ENV, BITBUCKET_COMMIT: shas.merge, BITBUCKET_PIPELINE_UUID: '{pipeline-uuid}' };

    const config = await resolvePullRequestContext(resolveConfig({ workspace }, env));

    expect(config.skipReason).toMatch(/ran on a schedule/);
    expect(calls).toHaveLength(1);
  });

  test('a pipeline whose trigger cannot be read is taken to be a push', async () => {
    // No route for the pipeline: the token lacks Pipelines: Read.
    mergedPullRequests([{ id: 7, merge_commit: { hash: shas.merge.slice(0, 12) } }]);
    const env = { ...BRANCH_PIPELINE_ENV, BITBUCKET_COMMIT: shas.merge, BITBUCKET_PIPELINE_UUID: '{pipeline-uuid}' };
    const config = await resolvePullRequestContext(resolveConfig({ workspace }, env));
    expect(config.bitbucket?.prNumber).toBe(7);
  });

  test('a direct push has nothing to review', async () => {
    mergedPullRequests([
      { id: 6, merge_commit: { hash: 'aaaaaaaaaaaa' } },
      { id: 5, merge_commit: null },
    ]);
    const config = await resolvePullRequestContext(
      resolveConfig({ workspace }, { ...BRANCH_PIPELINE_ENV, BITBUCKET_COMMIT: shas.merge })
    );
    expect(config.skipReason).toMatch(/No pull request merged as commit .* into main/);
    expect(config.bitbucket?.prNumber).toBeUndefined();
  });

  test('a shallow clone explains how to fix it', async () => {
    const shallow = await mkdtemp(join(tmpdir(), 'ec-bitbucket-shallow-'));
    try {
      await exec('git', ['clone', '-q', '--depth', '1', `file://${workspace}`, shallow]);
      const env = { ...PR_PIPELINE_ENV, BITBUCKET_COMMIT: shas.merge, BITBUCKET_PR_DESTINATION_COMMIT: shas.base };
      await expect(resolvePullRequestContext(resolveConfig({ workspace: shallow }, env))).rejects.toThrow(/clone: depth: full/);
    } finally {
      await rm(shallow, { recursive: true, force: true });
    }
  });
});

describe('catalog pull requests in Bitbucket', () => {
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
    root = await mkdtemp(join(tmpdir(), 'ec-bitbucket-catalog-'));
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
    config = resolveConfig({ workspace: join(root, 'workspace'), catalogToken: 'catalog-token' }, PR_PIPELINE_ENV);
  });

  afterEach(() => rm(root, { recursive: true, force: true }));

  test('pushes the branch and opens a pull request', async () => {
    const calls = mockBitbucket({
      'GET /pullrequests': { values: [] },
      'POST /pullrequests': { id: 42, links: { html: { href: 'https://bitbucket.org/acme/eventcatalog/pull-requests/42' } } },
    });

    const result = await createOrUpdateCatalogPullRequest(config, {
      impactPlan: plan,
      result: { prTitle: 'docs: update', prSummary: 'Updated the orders service.', sourcePrSummary: '' },
    });

    expect(result.pullRequestUrl).toBe('https://bitbucket.org/acme/eventcatalog/pull-requests/42');
    const { stdout } = await exec('git', ['--git-dir', join(root, 'remote.git'), 'branch', '--list']);
    expect(stdout).toContain('eventcatalog-actions/acme-shop/pr-7');

    expect(calls[0].url.searchParams.get('q')).toBe(
      'source.branch.name = "eventcatalog-actions/acme-shop/pr-7" AND destination.branch.name = "main"'
    );
    const create = calls.find((call) => call.method === 'POST')!;
    expect(create.url.pathname).toBe('/2.0/repositories/acme/eventcatalog/pullrequests');
    expect(create.authorization).toBe('Bearer catalog-token');
    expect(create.body).toMatchObject({
      title: 'docs: update',
      source: { branch: { name: 'eventcatalog-actions/acme-shop/pr-7' } },
      destination: { branch: { name: 'main' } },
      close_source_branch: true,
    });
    expect((create.body as { description: string }).description).toMatch(
      /^> \*\*Note:\*\* Opened by \[EventCatalog Agents\].* for \[acme\/shop#7\]\(https:\/\/bitbucket\.org\/acme\/shop\/pull-requests\/7\)/
    );
  });

  test('updates the open pull request for the same branch, keeping its reviewers', async () => {
    const calls = mockBitbucket({
      'GET /pullrequests': { values: [{ id: 42 }] },
      'GET /pullrequests/42': { id: 42, reviewers: [{ uuid: '{reviewer}', display_name: 'Dana' }] },
      'PUT /pullrequests/42': { id: 42 },
    });

    await createOrUpdateCatalogPullRequest(config, {
      impactPlan: plan,
      result: { prTitle: 't', prSummary: 's', sourcePrSummary: '' },
    });

    expect(calls.map((call) => call.method)).toEqual(['GET', 'GET', 'PUT']);
    expect(calls[0].url.searchParams.get('state')).toBe('OPEN');
    expect(calls[2].body).toMatchObject({ title: 't', reviewers: [{ uuid: '{reviewer}' }] });
  });

  test('preflight checks the repository and the branch', async () => {
    mockBitbucket({
      'GET /repositories/acme/eventcatalog': { full_name: 'acme/eventcatalog' },
      'GET /refs/branches/main': { target: { hash: 'sha1' } },
    });
    expect(await preflightCatalogPullRequestAccess(config)).toEqual({ branchSha: 'sha1', fullName: 'acme/eventcatalog' });

    mockBitbucket({ 'GET /repositories/acme/eventcatalog': { full_name: 'acme/eventcatalog' } });
    await expect(preflightCatalogPullRequestAccess(config)).rejects.toMatchObject({
      status: 404,
      message: expect.stringMatching(/^Catalog ref "main" was not found in acme\/eventcatalog/),
    });
  });

  test('counts the agent pull requests by state', async () => {
    const recent = new Date().toISOString();
    const calls = mockBitbucket({
      'GET /pullrequests': {
        values: [
          { id: 1, state: 'OPEN', source: { branch: { name: 'eventcatalog-actions/acme-shop/pr-1' } } },
          { id: 2, state: 'MERGED', updated_on: recent, source: { branch: { name: 'eventcatalog-actions/acme-shop/pr-2' } } },
          { id: 3, state: 'DECLINED', updated_on: recent, source: { branch: { name: 'eventcatalog-actions/acme-shop/pr-3' } } },
          { id: 4, state: 'MERGED', updated_on: '2020-01-01T00:00:00Z', source: { branch: { name: 'eventcatalog-actions/x' } } },
          { id: 5, state: 'OPEN', source: { branch: { name: 'feature/eventcatalog-actions/x' } } },
        ],
      },
    });

    expect(await getCatalogProvider(config).getAgentPullRequestStats('eventcatalog-actions/')).toEqual({
      open: 1,
      merged30d: 1,
      closedUnmerged30d: 1,
    });
    expect(calls[0].url.searchParams.getAll('state')).toEqual(['OPEN', 'MERGED', 'DECLINED']);
  });
});
