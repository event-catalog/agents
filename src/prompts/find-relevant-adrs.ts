import type { AgentInstanceHandle } from '@flue/runtime';
import { promptForResult } from '@/src/agents/structured-results';
import { relevantAdrsResult } from '@/src/review-output';
import type { ChangedFile } from '@/src/review-types';
import type { CatalogAdr } from '@/src/utils/adrs';
import { formatNumberedDiff } from '@/src/utils/diff';

/**
 * Asks the agent which ADRs this pull request could conflict with, from their summaries alone, so a
 * catalog with many ADRs doesn't put every full ADR in front of the model. This is a read-only step.
 *
 * This file is the single source of truth for the prompt wording. Edit it in
 * `buildFindRelevantAdrsPrompt`.
 */
export const buildFindRelevantAdrsPrompt = (changedFiles: ChangedFile[], adrs: CatalogAdr[]): string => {
  const diff = changedFiles.map((file) => formatNumberedDiff(file.diff)).join('\n');
  const index = adrs.map(({ id, name, summary, appliesTo }) => ({ id, name, summary, appliesTo }));

  return (
    'Here are the source file changes for this pull request. Each changed line is labelled with its line number:\n\n' +
    diff +
    '\n\nHere are the ADRs to check this pull request against:\n\n' +
    JSON.stringify(index, null, 2) +
    `\n\nThis is a READ-ONLY triage step. You MUST NOT create, edit, write, or delete any files.

List the ADRs whose decision the changed code could plausibly affect, because the code touches the same topic or the same part of the system. You will review those in full next, so don't decide here whether the code conflicts with them. If you are unsure whether an ADR is relevant, include it. Leave out ADRs on unrelated topics. Return an empty list if none are relevant.`
  );
};

/** The ids of the ADRs worth reviewing in full. Ids the agent made up are dropped. */
export const findRelevantAdrs = async (
  agent: AgentInstanceHandle,
  changedFiles: ChangedFile[],
  adrs: CatalogAdr[]
): Promise<CatalogAdr[]> => {
  const { relevantAdrIds } = await promptForResult(agent, buildFindRelevantAdrsPrompt(changedFiles, adrs), relevantAdrsResult);
  return adrs.filter((adr) => relevantAdrIds.includes(adr.id));
};
