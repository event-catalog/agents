import type { PackagedSkillDirectory } from '@flue/runtime';

/**
 * Global registry of skills loaded via the {@link flueSkillPlugin}. When the agent module imports
 * its `SKILL.md`, the plugin registers the packaged directory here so the eval harness can hand it
 * to `createFlueContext` as `agentConfig.packagedSkills`.
 */
const registry = new Map<string, PackagedSkillDirectory>();

export const registerPackagedSkill = (skill: PackagedSkillDirectory): void => {
  registry.set(skill.id, skill);
};

export const getPackagedSkills = (): Record<string, PackagedSkillDirectory> => Object.fromEntries(registry.entries());
