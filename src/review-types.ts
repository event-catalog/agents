import type { ChangedLineRange } from './utils/diff';

/** A source file change handed to the agent. Matches the workflow's `changedFiles` shape. */
export type ChangedFile = {
  changedLines?: ChangedLineRange[];
  diff: string;
  fileName: string;
};
