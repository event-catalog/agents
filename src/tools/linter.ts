import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { defineTool } from '@flue/runtime';
import { archivePreviousVersions } from '@/src/utils/archive-versions';
import { childProcessEnv, getCatalogPackageVersion } from '@/src/utils/child-process-env';
import { getChangedCatalogFiles } from '@/src/utils/eventcatalog-utils';

const execFileAsync = promisify(execFile);

/** Used when the catalog doesn't pin `@eventcatalog/linter` itself. */
export const DEFAULT_LINTER_VERSION = '1.3.1';

type LinterResult = {
  changedFiles: string[];
  command: string;
  exitCode: number;
  message?: string;
  skipped?: boolean;
  stderr: string;
  stdout: string;
  success: boolean;
};

type ExecFileError = Error & {
  code?: number | string;
  stderr?: string;
  stdout?: string;
};

const isExecFileError = (error: unknown): error is ExecFileError =>
  error instanceof Error && ('stdout' in error || 'stderr' in error || 'code' in error);

const getExitCode = (code: number | string | undefined): number => {
  if (typeof code === 'number') return code;
  if (typeof code === 'string') {
    const parsed = Number.parseInt(code, 10);
    return Number.isNaN(parsed) ? 1 : parsed;
  }
  return 1;
};

export const createLinterTool = (catalogPath: string) =>
  defineTool({
    name: 'linter',
    description: 'Run the EventCatalog linter in the catalog directory and return stdout, stderr, and exit code',
    run: async ({ signal }) => {
      if (!catalogPath) {
        throw new Error('Catalog path is not defined. Please provide a valid catalog path.');
      }

      // The catalog's own linter version, so results match its CI; never an unpinned "latest".
      const linterPackage = `@eventcatalog/linter@${getCatalogPackageVersion(catalogPath, '@eventcatalog/linter') ?? DEFAULT_LINTER_VERSION}`;
      const command = `npx --yes ${linterPackage}`;

      const changedFiles = await getChangedCatalogFiles(catalogPath);

      if (changedFiles.length === 0) {
        const result: LinterResult = {
          changedFiles,
          command,
          exitCode: 0,
          message:
            'No EventCatalog files have been changed by this review yet. Do not use the linter to find unrelated catalog work; review the source PR and update documentation first.',
          skipped: true,
          stderr: '',
          stdout: '',
          success: true,
        };

        console.error('[eventcatalog:linter] Skipping linter because no catalog files have changed yet');
        return { output: result };
      }

      // Archive the previous version of anything re-versioned first, so pins to it still resolve.
      await archivePreviousVersions(catalogPath);
      console.error(`[eventcatalog:linter] Running "${command}" in ${catalogPath}`);

      try {
        const { stderr, stdout } = await execFileAsync('npx', ['--yes', linterPackage], {
          cwd: catalogPath,
          env: childProcessEnv(),
          maxBuffer: 1024 * 1024 * 20,
          signal,
        });
        const result: LinterResult = {
          changedFiles,
          command,
          exitCode: 0,
          stderr,
          stdout,
          success: true,
        };

        console.error(
          `[eventcatalog:linter] Completed successfully (${stdout.length} stdout chars, ${stderr.length} stderr chars)`
        );
        return { output: result };
      } catch (error) {
        if (!isExecFileError(error)) {
          throw error;
        }

        const result: LinterResult = {
          changedFiles,
          command,
          exitCode: getExitCode(error.code),
          message:
            'The linter failed after catalog changes were made. Only fix linter errors that are caused by the changed files listed in changedFiles. Do not edit unrelated catalog files to fix pre-existing catalog issues.',
          stderr: error.stderr ?? '',
          stdout: error.stdout ?? '',
          success: false,
        };

        console.error(
          `[eventcatalog:linter] Completed with exit code ${result.exitCode} (${result.stdout.length} stdout chars, ${result.stderr.length} stderr chars)`
        );
        return { output: result };
      }
    },
  });
