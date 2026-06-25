# Evals

A repeatable testing space for the `code-to-docs` agent. The question these evals answer:

> **Given this model, our real harness, and these conditions — what does the agent score?**

Unlike a unit test, an eval runs the **real agent** (real model, real tools, real skill) against a
realistic fixture and scores its actual output. Change the model, the instructions, or the tools and
re-run to see the score move.

## Quick start

```bash
# Offline guard only (no key needed, always runs, free):
npm run evals

# Full live eval against the real model (default: openai/gpt-4o-mini):
OPENAI_API_KEY=sk-... npm run evals

# Score a different model under the same harness + conditions (supply its provider key):
ANTHROPIC_API_KEY=sk-ant-... EVENTCATALOG_MODEL=anthropic/claude-opus-4-8 npm run evals

# Machine-readable results for CI/visualization:
OPENAI_API_KEY=sk-... npm run evals:json   # -> vitest-results.json
```

Live suites **auto-skip** when the model provider's API key is absent, so CI stays green and free
until you opt in. The model defaults to `openai/gpt-4o-mini` (override with `EVENTCATALOG_MODEL`);
the suite checks the matching provider key — `OPENAI_API_KEY` for `openai/*`, `ANTHROPIC_API_KEY`
for `anthropic/*`.

## What's here

| File                          | Role                                                                                                                                                                                                           |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `code-to-docs.eval.ts`        | The live eval: runs the real agent, scores the real output. Skips without a key.                                                                                                                               |
| `impact-plan-scorer.eval.ts`  | Offline guard: pins the deterministic scorer's behavior. Always runs.                                                                                                                                          |
| `support/harness.ts`          | The engine. Copies a fixture to a temp git repo, runs the agent's two-phase loop via the **shared** review logic, captures the impact plan + applied file changes + unauthorized edits.                        |
| `../src/prompts/*.ts`         | **Single source of truth** for each review step — the prompt _and_ its run function together (`create-documentation-plan-from-code-changes.ts`, `apply-documentation-plan-to-catalog.ts`). Both this harness and the production workflow (`src/workflows/pr-review.ts`) call them, so the eval tests the same prompts that run in prod. |
| `support/scorers.ts`          | Deterministic, model-free scoring of an impact plan (required/forbidden targets, drift).                                                                                                                       |
| `support/skill-*.ts`          | Lets the real agent (which imports `SKILL.md` via the Flue build plugin) load under plain vitest. See note below.                                                                                              |
| `fixtures/<name>/`            | One scenario each: a source repo + an EventCatalog + a `scenario.ts` (the PR diff and expectations).                                                                                                           |

## How scoring works

Two complementary layers:

1. **Deterministic scorers** (`scoreImpactPlan`) — the hard constraints we never want to regress:
   the right catalog targets are proposed, forbidden ones aren't, the source change is identified,
   unrelated drift goes to `outOfScopeFindings`. Returns a `0..1` score and a list of failures.
2. **Structural assertions on applied files** — the agent only edited approved targets, the new
   docs were actually written, and a usable catalog-PR title/summary came back.

Add an LLM judge (e.g. `FactualityJudge` from `vitest-evals/judges`) on top for prose quality when
you want to grade doc clarity — keep the grading model independent from the model under test.

## Adding a scenario

1. Create `fixtures/<name>/` with a `src/` (pre-PR source state) and a `catalog/` (the EventCatalog
   to edit). Don't `git init` it — the harness does that per run in a temp copy.
2. Add `fixtures/<name>/scenario.ts` exporting the `diff` and an `ImpactPlanExpectation`.
3. Reference it from a `describeEval` block (or add an `it` to `code-to-docs.eval.ts`).

## Note: the skill-loader shim

The agent imports its skill via `import skill from './SKILL.md' with { type: 'skill' }`. That import
attribute is resolved by Flue's build plugin, which doesn't run under vitest. `support/skill-vite-plugin.ts`
reproduces it: it intercepts the import, builds the skill from disk with `parseSkillMarkdown`, and
registers the packaged skill directory so the harness can hand it to `createFlueContext`. This keeps
the eval running the **unmodified real agent** rather than a re-declared copy.
