import { AdrCompliance } from '@/src/agents/adr-compliance';
import { initWithData } from '@/src/agents/structured-results';
import { CLOSED_WITHOUT_MERGE_MESSAGE, resolveConfig, runTrigger, type ReviewConfig, type ReviewPayload } from '@/src/config';
import { checkAdrCompliance } from '@/src/prompts/check-adr-compliance';
import { findRelevantAdrs } from '@/src/prompts/find-relevant-adrs';
import type { AdrConflict } from '@/src/review-output';
import {
  loadCatalogAdrs,
  MISSING_ADRS_MESSAGE,
  noMatchingAdrsMessage,
  parseAdrExceptions,
  selectAdrs,
  verifyConflicts,
  type CatalogAdr,
} from '@/src/utils/adrs';
import { trackAdrComplianceCompleted, trackAdrComplianceError, type AdrComplianceOutcome } from '@/src/utils/analytics';
import { getChangedFiles } from '@/src/utils/diff';
import { doesCatalogExist, MISSING_CATALOG_MESSAGE, resolveCatalogPath } from '@/src/utils/eventcatalog-utils';
import { getPullRequestBody, postAdrComplianceSummary, resolveAdrComplianceSummary } from '@/src/utils/github/reporter';

/** The result of an ADR Compliance run, plus the outcome we report to analytics. */
export type AdrComplianceResult = {
  outcome: AdrComplianceOutcome;
  /** Ids of the accepted ADRs the globs selected, plus any amendments to them. */
  checkedAdrIds: string[];
  /** Ids of the ADRs that triage sent to the full review. */
  relevantAdrIds: string[];
  /** Conflicts that passed verification and have no recorded exception. */
  conflicts: AdrConflict[];
  /** ADRs with a conflict that the author recorded an exception for. */
  exceptions: { adrId: string; reason: string }[];
  /** Conflicts the model reported whose citations failed verification. */
  rejected: { conflict: AdrConflict; reason: string }[];
  /** The ADRs behind `checkedAdrIds`, for the comment. */
  adrs: CatalogAdr[];
};

/**
 * The ADR Compliance workflow. Expects a running Flue runtime (`start()` in `src/run.ts`, or the eval
 * harness) with the `AdrCompliance` agent registered.
 */
export async function run(payload: ReviewPayload | undefined, env: NodeJS.ProcessEnv = process.env) {
  const startedAt = Date.now();
  const config = resolveConfig(payload, env);
  const context = { model: config.model, trigger: runTrigger(config) };

  try {
    const result = await review(payload, config);
    await trackAdrComplianceCompleted(result.outcome, { ...context, durationMs: Date.now() - startedAt });
    return result;
  } catch (error) {
    await trackAdrComplianceError(error, { ...context, durationMs: Date.now() - startedAt });
    throw error;
  }
}

const emptyResult = (outcome: AdrComplianceOutcome, adrs: CatalogAdr[] = []): AdrComplianceResult => ({
  outcome,
  checkedAdrIds: adrs.map((adr) => adr.id),
  relevantAdrIds: [],
  conflicts: [],
  exceptions: [],
  rejected: [],
  adrs,
});

export async function review(payload: ReviewPayload | undefined, config: ReviewConfig): Promise<AdrComplianceResult> {
  console.error('[eventcatalog:flue] ADR Compliance workflow started');

  if (config.pullRequestState === 'closed') {
    console.error(`[eventcatalog:flue] ${CLOSED_WITHOUT_MERGE_MESSAGE}`);
    return emptyResult('closed_without_merge');
  }

  // 1. Select the ADRs. Bad configuration fails the run, because a typo that silently selected nothing
  //    would look exactly like a clean pass.
  if (config.adrs.length === 0) {
    throw new Error(MISSING_ADRS_MESSAGE);
  }
  if (!(await doesCatalogExist(config))) {
    throw new Error(MISSING_CATALOG_MESSAGE);
  }

  const allAdrs = await loadCatalogAdrs(resolveCatalogPath(config));
  const { matched, active: adrs } = selectAdrs(allAdrs, config.adrs);

  if (matched.length === 0) {
    throw new Error(noMatchingAdrsMessage(config.adrs, allAdrs));
  }
  console.error(`[eventcatalog:flue] Checking against ${adrs.length} accepted ADR(s) of ${matched.length} matched`);

  // 2. Collect the changed files.
  const { files } = await getChangedFiles(config);
  const changedFiles = files.map((file) => ({
    changedLines: file.changedLines,
    diff: file.diff,
    fileName: file.relativePath,
  }));

  if (changedFiles.length === 0) {
    console.error('[eventcatalog:flue] No changed files found; nothing to check');
    // The pull request may have reverted the code an earlier comment warned about.
    await resolveAdrComplianceSummary(config, adrs);
    return emptyResult('no_changed_files', adrs);
  }

  if (adrs.length === 0) {
    console.error('[eventcatalog:flue] None of the matched ADRs are accepted; nothing to check against');
    // The ADR an earlier comment warned about may have since been superseded or rejected.
    await resolveAdrComplianceSummary(config, adrs);
    return emptyResult('no_accepted_adrs', adrs);
  }

  // 3. Triage on summaries, so only ADRs on the same topic are reviewed in full.
  const agent = initWithData(AdrCompliance, payload);
  const relevantAdrs = await findRelevantAdrs(agent, changedFiles, adrs);
  console.error(`[eventcatalog:flue] ${relevantAdrs.length} ADR(s) relevant to this pull request`);

  if (relevantAdrs.length === 0) {
    await resolveAdrComplianceSummary(config, adrs);
    return emptyResult('no_relevant_adrs', adrs);
  }

  // 4. Review the changed code against the full ADRs, then keep only the conflicts we can prove.
  const reported = await checkAdrCompliance(agent, relevantAdrs);
  const { verified, rejected } = verifyConflicts(reported, relevantAdrs, changedFiles);
  for (const { conflict, reason } of rejected) {
    console.error(`[eventcatalog:flue] Dropped a conflict with ${conflict.adrId}: ${reason}`);
  }

  // 5. Honour exceptions the author recorded, and report them so reviewers can see them.
  const recorded = verified.length > 0 ? parseAdrExceptions(await getPullRequestBody(config)) : new Map<string, string>();
  const conflicts = verified.filter((conflict) => !recorded.has(conflict.adrId));
  const exceptionIds = [...new Set(verified.map((conflict) => conflict.adrId))].filter((id) => recorded.has(id));
  const exceptions = exceptionIds.map((adrId) => ({ adrId, reason: recorded.get(adrId) as string }));

  const result: AdrComplianceResult = {
    outcome: conflicts.length > 0 ? 'conflicts_reported' : exceptions.length > 0 ? 'only_exceptions' : 'no_conflicts',
    checkedAdrIds: adrs.map((adr) => adr.id),
    relevantAdrIds: relevantAdrs.map((adr) => adr.id),
    conflicts,
    exceptions,
    rejected,
    adrs,
  };

  if (result.outcome === 'no_conflicts') {
    await resolveAdrComplianceSummary(config, adrs);
  } else {
    await postAdrComplianceSummary(config, { conflicts, exceptions, adrs });
  }

  return result;
}
