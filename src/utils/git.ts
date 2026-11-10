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
