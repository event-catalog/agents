import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/**
 * Git config passed through the environment (`GIT_CONFIG_COUNT`, git 2.31+), so a value such as an
 * auth header never shows on a command line, where a failed command's error message would print it.
 */
export const gitConfigEnv = (entries: [key: string, value: string][]): Record<string, string> =>
  Object.fromEntries([
    ['GIT_CONFIG_COUNT', String(entries.length)],
    ...entries.flatMap(([key, value], index) => [
      [`GIT_CONFIG_KEY_${index}`, key],
      [`GIT_CONFIG_VALUE_${index}`, value],
    ]),
  ]);

const execFileAsync = promisify(execFile);

/** Runs `git` in `workspace` and returns its trimmed output. */
export const git = async (workspace: string, args: string[]): Promise<string> =>
  (await execFileAsync('git', ['-C', workspace, ...args], { maxBuffer: 1024 * 1024 * 20 })).stdout.trim();

/** The full hash of `ref` if the checkout has that commit (CI systems can give abbreviated hashes). */
export const resolveCommit = (workspace: string, ref: string | undefined): Promise<string | undefined> =>
  ref
    ? git(workspace, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).then(
        (sha) => sha || undefined,
        () => undefined
      )
    : Promise.resolve(undefined);

/** The parents of `ref`, first parent first. Empty for a root commit, or the oldest commit of a shallow clone. */
export const commitParents = async (workspace: string, ref: string): Promise<string[]> =>
  (await git(workspace, ['rev-list', '--parents', '-n', '1', ref])).split(/\s+/).slice(1);
