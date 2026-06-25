import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { flueSkillPlugin } from './evals/support/skill-vite-plugin';

export default defineConfig({
  plugins: [flueSkillPlugin()],
  resolve: {
    alias: {
      // Mirrors tsconfig `paths`: `@/...` resolves from the project root, so `@/src/x` -> ./src/x.
      '@': fileURLToPath(new URL('.', import.meta.url)),
    },
  },
  test: {
    env: {
      VITEST_EVALS_REPLAY_DIR: '.vitest-evals/recordings',
      VITEST_EVALS_REPLAY_MODE: 'auto',
    },
    include: ['evals/**/*.eval.ts'],
    // Live model evals run a real agent through multi-step tool calls (plan + apply). A healthy run
    // is ~1-2 min even on slow reasoning models; 3 min leaves headroom while failing a stuck/looping
    // agent reasonably fast. Watch live activity with EVAL_TRACE=1 to spot loops early.
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
