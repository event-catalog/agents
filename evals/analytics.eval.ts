import { expect, test } from 'vitest';
import { classifyError } from '@/src/utils/analytics';

/** Offline tests for the anonymous error categories reported with failed runs. */

/** Flue's shape for a failed model call: `AgentRunError` → `OperationFailedError` with `meta.reason`. */
const flueFailure = (reason: string) =>
  Object.assign(new Error('[flue] Agent run failed (submission sub_1).'), {
    name: 'AgentRunError',
    cause: Object.assign(new Error(`dispatch(sub_1) failed: ${reason}`), { name: 'OperationFailedError', meta: { reason } }),
  });

test('classifies model provider failures from the wrapped cause', () => {
  expect(
    classifyError(flueFailure('401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}'))
  ).toBe('model_provider_auth');
  expect(classifyError(flueFailure('400 Your credit balance is too low to access the Anthropic API.'))).toBe(
    'model_provider_billing'
  );
  expect(classifyError(flueFailure('429 {"error":{"type":"rate_limit_error"}}'))).toBe('model_rate_limit');
});

test('classifies the agent not returning its structured result', () => {
  expect(classifyError(new Error('The agent finished without calling submit_impact_plan.'))).toBe('invalid_model_output');
});

test('classifies GitHub access failures and timeouts', () => {
  expect(classifyError(Object.assign(new Error('Not Found'), { status: 404 }))).toBe('github_access');
  expect(classifyError(new Error('Bad credentials'))).toBe('github_access');
  expect(classifyError(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }))).toBe('timeout');
});

test('falls back to unknown', () => {
  expect(classifyError(new Error('Something unexpected'))).toBe('unknown');
  expect(classifyError('a string')).toBe('unknown');
});
