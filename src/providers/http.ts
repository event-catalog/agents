/**
 * Retries for provider REST calls (Azure DevOps, Bitbucket). Octokit has its own for GitHub.
 */

const MAX_ATTEMPTS = 3;
/** The first retry's wait; each retry doubles it, unless the response says how long to wait. */
export const retryOptions = { baseDelayMs: 1000 };

/**
 * Whether a failed call can be sent again. A 429 was never processed, so any call can retry; a server
 * error can only retry a call that is safe to repeat: not a POST that creates a comment or pull request,
 * unless the caller says it only reads.
 */
const isRetryable = (status: number, safeToRepeat: boolean): boolean => status === 429 || (status >= 500 && safeToRepeat);

const retryDelay = (response: Response, attempt: number): number => {
  const retryAfter = Number(response.headers.get('retry-after'));
  return Number.isFinite(retryAfter) && retryAfter > 0
    ? Math.min(retryAfter, 30) * 1000
    : retryOptions.baseDelayMs * 2 ** (attempt - 1);
};

/** Sends a request, and sends it again (up to three times in all) while the server is busy. */
export const sendWithRetry = async (send: () => Promise<Response>, safeToRepeat: boolean): Promise<Response> => {
  let response = await send();
  for (let attempt = 1; attempt < MAX_ATTEMPTS && isRetryable(response.status, safeToRepeat); attempt++) {
    // Release the connection held by the response we're discarding.
    await response.body?.cancel();
    await new Promise((resolve) => setTimeout(resolve, retryDelay(response, attempt)));
    response = await send();
  }
  return response;
};
