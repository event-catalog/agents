import { expect, test } from 'vitest';
import { resolveConfig, runTrigger } from '@/src/config';

/** Offline test: the pull request state comes from the GitHub event, so workflows can run on merge. */

const stateFor = (env: NodeJS.ProcessEnv) => resolveConfig({}, env).pullRequestState;

test('reads the pull request state from the GitHub event', () => {
  expect(stateFor({})).toBe('open');
  expect(stateFor({ EVENTCATALOG_EVENT_ACTION: 'synchronize', EVENTCATALOG_PR_MERGED: 'false' })).toBe('open');
  expect(stateFor({ EVENTCATALOG_EVENT_ACTION: 'closed', EVENTCATALOG_PR_MERGED: 'true' })).toBe('merged');
  expect(stateFor({ EVENTCATALOG_EVENT_ACTION: 'closed', EVENTCATALOG_PR_MERGED: 'false' })).toBe('closed');
  expect(resolveConfig({ pullRequestState: 'merged' }, {}).pullRequestState).toBe('merged');
});

test('reports the trigger for analytics', () => {
  expect(runTrigger({ pullRequestState: 'merged' })).toBe('merged');
  expect(runTrigger({ pullRequestState: 'open' })).toBe('pull_request');
});
