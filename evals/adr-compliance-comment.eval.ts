import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { resolveConfig } from '@/src/config';
import { review } from '@/src/workflows/adr-compliance';

/**
 * Offline test: a run with nothing left to check must not leave an earlier warning on the pull request.
 * GitHub is mocked, and the run ends before any model call, so this needs no API key.
 */

const github = vi.hoisted(() => ({
  listComments: vi.fn(),
  updateComment: vi.fn(),
  createComment: vi.fn(),
}));

vi.mock('octokit', () => ({
  Octokit: class {
    rest = { issues: github };
  },
}));

const exec = promisify(execFile);
const CATALOG = join(import.meta.dirname, 'fixtures', 'adr-compliance', 'catalog');
const EARLIER_WARNING = { id: 42, body: '<!-- eventcatalog-actions:adr-compliance -->\n### ⚠️ Possible conflict' };

let workspace: string;
let sha: string;

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'ec-adr-comment-'));
  const git = (...args: string[]) =>
    exec('git', ['-c', 'user.email=eval@eventcatalog.dev', '-c', 'user.name=eval', ...args], { cwd: workspace });
  await writeFile(join(workspace, 'file.txt'), 'content\n');
  await git('init', '-q');
  await git('add', '-A');
  await git('commit', '-qm', 'base');
  sha = (await git('rev-parse', 'HEAD')).stdout.trim();
});

afterAll(() => rm(workspace, { recursive: true, force: true }));

beforeEach(() => {
  vi.clearAllMocks();
  github.updateComment.mockResolvedValue({ data: { html_url: 'https://github.com/acme/shop/pull/7#comment' } });
});

/** A pull request with no changes left: the base and head are the same commit. */
const reviewEmptyPullRequest = (adrs: string) => {
  const payload = {
    adrs,
    baseSha: sha,
    catalogPath: CATALOG,
    githubRepository: 'acme/shop',
    githubToken: 'token',
    headSha: sha,
    prNumber: 7,
    workspace,
  };
  return review(payload, resolveConfig(payload, {}));
};

test('a fully reverted pull request marks an earlier warning as resolved', async () => {
  github.listComments.mockResolvedValue({ data: [EARLIER_WARNING] });

  const { outcome } = await reviewEmptyPullRequest('adrs/**');

  expect(outcome).toBe('no_changed_files');
  expect(github.updateComment).toHaveBeenCalledOnce();
  expect(github.updateComment.mock.calls[0][0]).toMatchObject({ comment_id: 42 });
  expect(github.updateComment.mock.calls[0][0].body).toContain('### ✅ No architecture decision conflicts');
  expect(github.createComment).not.toHaveBeenCalled();
});

test('a pull request with no earlier warning stays silent', async () => {
  github.listComments.mockResolvedValue({ data: [{ id: 1, body: 'A comment from a person' }] });

  await reviewEmptyPullRequest('adrs/**');

  expect(github.createComment).not.toHaveBeenCalled();
  expect(github.updateComment).not.toHaveBeenCalled();
});
