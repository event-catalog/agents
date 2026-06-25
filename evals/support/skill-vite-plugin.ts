import { resolve as resolvePath } from 'node:path';
import type { Plugin } from 'vite';

const SUFFIX = '?flue-skill';

/**
 * Vitest/Vite plugin that resolves Flue skill imports the way the Flue build plugin does.
 *
 * The agent does `import skill from '.../SKILL.md' with { type: 'skill' }`. Vite cannot load a
 * raw `.md` file as a module, so this plugin intercepts that import and replaces it with a tiny
 * module that builds the {@link SkillReference} at runtime via {@link loadSkillFromDirectory}.
 *
 * The packaged skill directory built alongside the reference is registered globally so the eval
 * harness can pass it to `createFlueContext` as `agentConfig.packagedSkills`. See
 * `evals/support/skill-registry.ts`.
 */
export const flueSkillPlugin = (): Plugin => ({
  name: 'flue-skill-loader',
  enforce: 'pre',
  async resolveId(source, importer, options) {
    // Rollup passes import attributes (`with { type: 'skill' }`) on the resolve options at runtime,
    // but Vite's narrower type doesn't declare them — read the field through a typed view.
    const attributes = (options as { attributes?: Record<string, string> }).attributes;
    const isSkillImport = attributes?.type === 'skill' || /SKILL\.md$/.test(source);
    if (!isSkillImport) return null;

    const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
    const target = resolved?.id ?? (importer ? resolvePath(importer, '..', source) : source);
    return `${target.split('?')[0]}${SUFFIX}`;
  },
  load(id) {
    if (!id.endsWith(SUFFIX)) return null;
    const skillPath = id.slice(0, -SUFFIX.length);
    return `
import { loadSkillFromDirectory } from ${JSON.stringify(resolvePath(import.meta.dirname ?? __dirname, 'skill-loader.ts'))};
import { registerPackagedSkill } from ${JSON.stringify(resolvePath(import.meta.dirname ?? __dirname, 'skill-registry.ts'))};
const loaded = loadSkillFromDirectory(${JSON.stringify(skillPath)});
registerPackagedSkill(loaded.packaged);
export default loaded.reference;
`;
  },
});
