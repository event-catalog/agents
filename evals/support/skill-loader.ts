import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { parseSkillMarkdown } from '@flue/runtime/internal';
import type { PackagedSkillDirectory, PackagedSkillFile, SkillReference } from '@flue/runtime';

/**
 * Build a Flue skill from a `SKILL.md` directory at runtime.
 *
 * The Flue build plugin normally resolves `import skill from './SKILL.md' with { type: 'skill' }`
 * into a {@link SkillReference} plus a {@link PackagedSkillDirectory} registered on the agent
 * config. That plugin does not run under plain vitest/tsx, so we reproduce the same two artifacts
 * here from the skill directory on disk. See `evals/support/skill-resolver.ts` for the vitest
 * import shim that uses this.
 */
export type LoadedSkill = {
  reference: SkillReference;
  packaged: PackagedSkillDirectory;
};

const walkFiles = (root: string): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    const full = join(root, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walkFiles(full));
    } else {
      out.push(full);
    }
  }
  return out;
};

const isTextFile = (path: string): boolean => /\.(md|mdx|txt|json|ya?ml|ts|js|mjs|cjs)$/i.test(path);

export const loadSkillFromDirectory = (skillMarkdownPath: string): LoadedSkill => {
  const directory = skillMarkdownPath.replace(new RegExp(`${sep}SKILL\\.md$`), '');
  const directoryName = directory.split(sep).pop() ?? 'skill';
  const content = readFileSync(skillMarkdownPath, 'utf8');

  const parsed = parseSkillMarkdown(content, { directoryName, path: skillMarkdownPath });

  const files: Record<string, PackagedSkillFile> = {};
  for (const filePath of walkFiles(directory)) {
    const relPath = relative(directory, filePath).split(sep).join('/');
    const kind = isTextFile(filePath) ? 'text' : 'binary';
    files[relPath] = {
      encoding: 'base64',
      kind,
      content: readFileSync(filePath).toString('base64'),
    };
  }

  const packaged: PackagedSkillDirectory = {
    id: parsed.name,
    name: parsed.name,
    description: parsed.description,
    files,
  };

  const reference: SkillReference = {
    __flueSkillReference: true,
    id: parsed.name,
    name: parsed.name,
    description: parsed.description,
  };

  return { reference, packaged };
};
