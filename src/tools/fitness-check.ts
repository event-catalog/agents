import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { defineTool } from '@flue/runtime';
import type { FitnessReport } from '@eventcatalog/fitness';
import { archivePreviousVersions } from '@/src/utils/archive-versions';
import { childProcessEnv } from '@/src/utils/child-process-env';
import { getChangedCatalogFiles } from '@/src/utils/eventcatalog-utils';

const execFileAsync = promisify(execFile);

/** This package's root, so the runner resolves `@eventcatalog/fitness` from our own dependencies. */
const PACKAGE_ROOT = join(import.meta.dirname, '..', '..');

// Fitness functions are code from the catalog repository. They run in a separate node process with
// only the environment it needs (see `childProcessEnv`), never in this process, which holds the
// model provider key and GitHub tokens.
const RUNNER = `
import { evaluateFitness } from '@eventcatalog/fitness';
const report = await evaluateFitness({ dir: process.argv[1] });
process.stdout.write(JSON.stringify(report));
`;

export type FitnessProblem = {
  function: string;
  severity: string;
  message: string;
  suggestion?: string;
  resources?: string[];
};

type FitnessCheckResult = {
  skipped?: boolean;
  message: string;
  /** Problems that are not in the catalog as it was before this review: these are yours. */
  newProblems: FitnessProblem[];
  /** How many problems were already in the catalog before this review. Not yours to fix. */
  preExistingProblems: number;
};

/** Runs a catalog's fitness functions in a separate node process and returns the report. */
export const runFitnessFunctions = async (catalogDir: string, signal?: AbortSignal): Promise<FitnessReport> => {
  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', RUNNER, catalogDir], {
    cwd: PACKAGE_ROOT,
    env: childProcessEnv(),
    maxBuffer: 1024 * 1024 * 20,
    signal,
  });
  return JSON.parse(stdout) as FitnessReport;
};

/** Every problem in a report: violations, and functions that could not be evaluated. */
export const listFitnessProblems = (report: FitnessReport): FitnessProblem[] =>
  report.functions.flatMap((fn) => {
    if (fn.status === 'error') {
      return [{ function: fn.id, severity: 'error', message: `Could not evaluate: ${fn.error?.message ?? 'unknown error'}` }];
    }
    return fn.violations.map((violation) => ({
      function: fn.id,
      severity: fn.severity,
      message: violation.message,
      suggestion: violation.suggestion,
      resources: violation.resources.map(
        (resource) => `${resource.type} ${resource.id}${resource.version ? ` ${resource.version}` : ''}`
      ),
    }));
  });

const problemKey = (problem: FitnessProblem): string => `${problem.function}\u0000${problem.message}`;

/** The problems in `current` that were not already in `baseline`. */
export const newFitnessProblems = (baseline: FitnessProblem[], current: FitnessProblem[]): FitnessProblem[] => {
  const known = new Set(baseline.map(problemKey));
  return current.filter((problem) => !known.has(problemKey(problem)));
};

/** Evaluates the catalog as committed at HEAD, before this review changed anything. */
const evaluateCommittedCatalog = async (catalogPath: string, signal?: AbortSignal): Promise<FitnessReport> => {
  const snapshot = await mkdtemp(join(tmpdir(), 'ec-fitness-baseline-'));
  try {
    const { stdout: prefix } = await execFileAsync('git', ['rev-parse', '--show-prefix'], { cwd: catalogPath });
    const archive = join(snapshot, 'catalog.tar');
    await execFileAsync('git', ['archive', '--format=tar', '-o', archive, `HEAD:${prefix.trim()}`], { cwd: catalogPath });
    await execFileAsync('tar', ['-xf', archive, '-C', snapshot]);
    return await runFitnessFunctions(snapshot, signal);
  } finally {
    await rm(snapshot, { recursive: true, force: true });
  }
};

/**
 * Runs the catalog's architecture fitness functions (`fitness/*.fitness.ts`, see
 * https://www.eventcatalog.dev) and reports only the problems this review introduced.
 */
export const createFitnessCheckTool = (catalogPath: string) => {
  let baseline: Promise<FitnessProblem[]> | undefined;

  return defineTool({
    name: 'fitness_check',
    description:
      "Run the catalog's architecture fitness functions and return the problems your changes introduced (problems that were already in the catalog are only counted)",
    run: async ({ signal }) => {
      const changedFiles = await getChangedCatalogFiles(catalogPath);
      if (changedFiles.length === 0) {
        const result: FitnessCheckResult = {
          skipped: true,
          message: 'No EventCatalog files have been changed by this review yet. Run fitness_check after making your changes.',
          newProblems: [],
          preExistingProblems: 0,
        };
        return { output: result };
      }

      // Archive the previous version of anything re-versioned first, as the workflow will.
      await archivePreviousVersions(catalogPath);
      console.error(`[eventcatalog:fitness] Running fitness functions in ${catalogPath}`);
      const current = await runFitnessFunctions(catalogPath, signal);

      if (current.summary.total === 0) {
        const result: FitnessCheckResult = {
          skipped: true,
          message: 'This catalog has no fitness functions. Nothing to check.',
          newProblems: [],
          preExistingProblems: 0,
        };
        return { output: result };
      }

      baseline ??= evaluateCommittedCatalog(catalogPath, signal).then(listFitnessProblems);
      const before = await baseline;
      const newProblems = newFitnessProblems(before, listFitnessProblems(current));
      const errors = newProblems.filter((problem) => problem.severity === 'error').length;

      console.error(
        `[eventcatalog:fitness] ${current.summary.total} functions: ${newProblems.length} new problem(s) (${errors} error(s)), ${before.length} pre-existing`
      );

      const result: FitnessCheckResult = {
        message:
          errors > 0
            ? 'Your changes broke the architecture rules below. Fix the error-severity problems in the files you changed (at most two rounds, as with the linter). Warnings are acceptable. Never edit fitness functions.'
            : newProblems.length > 0
              ? 'Your changes only produced warnings. Warnings are acceptable; mention them in your summary.'
              : 'Your changes pass the catalog fitness functions.',
        newProblems,
        preExistingProblems: before.length,
      };
      return { output: result };
    },
  });
};
