import type { AgentInstanceHandle } from '@flue/runtime';
import { promptForResult } from '@/src/agents/structured-results';
import { adrComplianceResult, type AdrConflict } from '@/src/review-output';
import type { CatalogAdr } from '@/src/utils/adrs';

/**
 * Asks the agent to check the changed code, which it saw in the triage step of the same conversation,
 * against the full text of the relevant ADRs. This is a read-only step.
 *
 * This file is the single source of truth for the prompt wording. Edit it in
 * `buildCheckAdrCompliancePrompt`.
 */
export const buildCheckAdrCompliancePrompt = (adrs: CatalogAdr[]): string => {
  const fullAdrs = adrs.map(({ id, name, path, appliesTo, amends, amendedBy, markdown }) => ({
    id,
    name,
    path,
    appliesTo,
    amends,
    amendedBy,
    markdown,
  }));

  return (
    'Here are the full ADRs to check the changed code in this pull request against:\n\n' +
    JSON.stringify(fullAdrs, null, 2) +
    `\n\nThis is a READ-ONLY review step. You MUST NOT create, edit, write, or delete any files. Use your read, grep, and glob tools if you need the code around a change.

For each ADR, decide whether the changed lines clearly conflict with its decision, following the rules in your instructions. Only an accepted ADR's decision counts, and all of these are accepted.

Report each clear conflict with:
- adrId: the ADR's id.
- file: the changed file's path, exactly as it appears in the diff.
- line: the line number labelled on the changed line that conflicts. A removed line counts when removing it is the conflict.
- adrQuote: the sentence from the ADR that the change conflicts with, copied word for word. Do not shorten it or join separate sentences.
- explanation: what the changed code does and why it conflicts, written for the pull request author.
- suggestion: how to change the code so it follows the ADR.

Report one conflict per problem. When one change conflicts with several ADRs for the same reason, report it once, under the ADR that most directly rules it out. An ADR that describes how to do something is not broken by code that doesn't try to do that thing.

Most pull requests have no conflicts, so return an empty list unless a conflict is clear.`
  );
};

/** The conflicts the agent reports. They are unverified until the workflow checks their citations. */
export const checkAdrCompliance = async (agent: AgentInstanceHandle, adrs: CatalogAdr[]): Promise<AdrConflict[]> => {
  const { conflicts } = await promptForResult(agent, buildCheckAdrCompliancePrompt(adrs), adrComplianceResult);
  return conflicts;
};
