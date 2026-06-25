import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ReviewConfig } from '@/src/config';

const execFileAsync = promisify(execFile);

export type ChangedLineRange = {
  end: number;
  isPureDeletion?: boolean;
  start: number;
};

export type ChangedFile = {
  changedLines: ChangedLineRange[];
  diff: string;
  fileContent: string;
  fileName: string;
  relativePath: string;
};

type ParsedDiffFile = {
  changedLines: ChangedLineRange[];
  diff: string;
  fileName: string;
  relativePath: string;
};

const DIFF_OPTIONS = ['--diff-filter=AMRT', '-U0'];
const SAFE_REF = /^[\w./~^-]+$/;
const REGEX_SPECIAL_CHARS = /[.+^${}()|[\]\\]/g;

const assertSafeRef = (value: string, label: string): string => {
  if (!SAFE_REF.test(value) || value.startsWith('-')) {
    throw new Error(`Invalid ${label}: ${JSON.stringify(value)}`);
  }

  return value;
};

export const buildDiffArgs = (config: ReviewConfig): string[] => {
  const args = ['-C', config.workspace, 'diff', ...DIFF_OPTIONS];

  if (config.baseSha && config.headSha) {
    const baseSha = assertSafeRef(config.baseSha, 'baseSha');
    const headSha = assertSafeRef(config.headSha, 'headSha');
    args.push(`${baseSha}...${headSha}`);
  } else {
    args.push('--cached');
  }

  return args;
};

const normalizePath = (value: string): string =>
  value
    .replaceAll('\\', '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');

const globToRegex = (pattern: string): RegExp => {
  const source = normalizePath(pattern)
    .split('**')
    .map((part) => part.replace(REGEX_SPECIAL_CHARS, '\\$&').replaceAll('*', '[^/]*'))
    .join('.*');

  return new RegExp(`(^|/)${source}($|/)`);
};

export const isIgnoredPath = (relativePath: string, ignorePaths: string[]): boolean => {
  const normalizedPath = normalizePath(relativePath);

  return ignorePaths.some((ignorePath) => {
    const normalizedIgnorePath = normalizePath(ignorePath);
    if (!normalizedIgnorePath) return false;

    if (normalizedIgnorePath.includes('*')) {
      return globToRegex(normalizedIgnorePath).test(normalizedPath);
    }

    return (
      normalizedPath === normalizedIgnorePath ||
      normalizedPath.startsWith(`${normalizedIgnorePath}/`) ||
      normalizedPath.includes(`/${normalizedIgnorePath}/`)
    );
  });
};

export const parseDiff = (rawDiff: string, workspace: string): ParsedDiffFile[] => {
  const diffHeaderRegex = /^diff --git a\/(.+) b\/(.+)$/;
  const hunkHeaderRegex = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

  const files: ParsedDiffFile[] = [];
  let current: ParsedDiffFile | null = null;

  for (const line of rawDiff.split('\n')) {
    const headerMatch = line.match(diffHeaderRegex);

    if (headerMatch) {
      const relativePath = normalizePath(headerMatch[2]);

      current = {
        changedLines: [],
        diff: line,
        fileName: join(workspace, relativePath),
        relativePath,
      };
      files.push(current);
      continue;
    }

    if (!current) continue;

    current.diff += `\n${line}`;

    const hunkMatch = line.match(hunkHeaderRegex);
    if (!hunkMatch) continue;

    const oldLineCount = hunkMatch[2] ? Number.parseInt(hunkMatch[2], 10) : 1;
    const newStartLine = Number.parseInt(hunkMatch[3], 10);
    const newLineCount = hunkMatch[4] ? Number.parseInt(hunkMatch[4], 10) : 1;

    if (newLineCount > 0) {
      current.changedLines.push({
        end: newStartLine + newLineCount - 1,
        start: newStartLine,
      });
    } else if (oldLineCount > 0) {
      current.changedLines.push({
        end: newStartLine,
        isPureDeletion: true,
        start: newStartLine,
      });
    }
  }

  return files;
};

export const getChangedFiles = async (config: ReviewConfig): Promise<{ files: ChangedFile[]; rawDiff: string }> => {
  const { stdout: rawDiff } = await execFileAsync('git', buildDiffArgs(config), {
    maxBuffer: 1024 * 1024 * 20,
  });

  if (!rawDiff.trim()) {
    return { files: [], rawDiff: '' };
  }

  const files = await Promise.all(
    parseDiff(rawDiff, config.workspace)
      .filter((file) => !isIgnoredPath(file.relativePath, config.ignorePaths))
      .map(async (file): Promise<ChangedFile> => {
        let fileContent = '';

        try {
          fileContent = await readFile(file.fileName, 'utf8');
        } catch {
          // The diff can include files that are not readable in the current checkout.
        }

        return { ...file, fileContent };
      })
  );

  return { files, rawDiff };
};
