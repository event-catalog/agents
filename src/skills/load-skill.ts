import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { defineSkill, type SkillDefinition } from '@flue/runtime';

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** Reads a top-level `key: value` line from SKILL.md frontmatter (quotes are stripped). */
const readField = (frontmatter: string, key: string): string | undefined => {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
  return match?.[1].trim().replace(/^(['"])(.*)\1$/, '$2');
};

const listFiles = (root: string): string[] =>
  readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));

/**
 * Builds a Flue skill from a `SKILL.md` directory on disk.
 *
 * Flue 2 can package `import skill from './SKILL.md'` at build time, but only under its Vite plugin.
 * The action runs as a plain Node script and the evals run under vitest, so we read the directory at
 * runtime instead and hand it to `defineSkill`. Supporting files (e.g. `references/*.md`) are carried
 * as skill resources, exactly as a directory import would.
 */
export const loadSkill = (directory: string): SkillDefinition => {
  const markdown = readFileSync(join(directory, 'SKILL.md'), 'utf8');
  const frontmatter = markdown.match(FRONTMATTER)?.[1];
  if (!frontmatter) {
    throw new Error(`Skill at ${directory} is missing SKILL.md frontmatter`);
  }

  const name = readField(frontmatter, 'name');
  const description = readField(frontmatter, 'description');
  if (!name || !description) {
    throw new Error(`Skill at ${directory} must declare a name and description in its frontmatter`);
  }

  const files = Object.fromEntries(
    listFiles(directory)
      .filter((path) => relative(directory, path) !== 'SKILL.md')
      .map((path) => [relative(directory, path).split(sep).join('/'), readFileSync(path, 'utf8')])
  );

  return defineSkill({
    name,
    description,
    license: readField(frontmatter, 'license'),
    instructions: markdown.replace(FRONTMATTER, ''),
    files,
  });
};

/** The EventCatalog documentation skill shared by every agent. */
export const eventCatalogSkill = loadSkill(join(import.meta.dirname, 'eventcatalog-documentation'));
