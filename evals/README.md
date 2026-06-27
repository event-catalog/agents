# Evals

A repeatable testing space for the EventCatalog agents. The question these evals answer:

> **Given this model, our real harness, and these conditions — what does the agent score?**

Unlike a unit test, an eval runs the **real agent** (real model, real tools, real skill) against a
realistic fixture and scores its actual output. Change the model, the instructions, or the tools and
re-run to see the score move.

Two agents are covered today:

- **`code-to-docs`** — turns source-code PRs into EventCatalog documentation.
- **`breaking-changes`** — scores a changed schema for breaking changes and traces it to the catalog
  resources that consume it.

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

### Running a subset

Everything after `--` is forwarded to vitest, so you can filter by **test name** (`-t`) or by **file
path** (a positional substring):

```bash
# By test name — runs both breaking-changes live tests (matches the describeEval title):
OPENAI_API_KEY=sk-... npm run evals -- -t "breaking-changes agent"

# By file path substring — both breaking-changes files (live + offline guard):
npm run evals -- breaking-changes

# A single test:
OPENAI_API_KEY=sk-... npm run evals -- -t "removed required field"
```

Set `EVAL_TRACE=1` to stream each tool call live (handy for watching the agent dump the catalog and
grep for consumers), and `EVAL_DUMP=1` to print the full contents of every file a `code-to-docs` run
wrote.

## What's here

| File                                  | Role                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `code-to-docs.eval.ts`                | Live eval for the `code-to-docs` agent: runs the real agent, scores the real output. Skips without a key.                                                                                                                                                                                                                                                                                                                          |
| `breaking-changes.eval.ts`            | Live eval for the `breaking-changes` agent: scores a schema change and traces it to its consumers. Skips without a key.                                                                                                                                                                                                                                                                                                            |
| `impact-plan-scorer.eval.ts`          | Offline guard: pins the `code-to-docs` impact-plan scorer. Always runs.                                                                                                                                                                                                                                                                                                                                                            |
| `breaking-changes-scorer.eval.ts`     | Offline guard: pins the `breaking-changes` scorers (breaking detection + consumer tracing). Always runs.                                                                                                                                                                                                                                                                                                                           |
| `support/harness.ts`                  | The `code-to-docs` engine. Copies a fixture to a temp git repo, runs the agent's two-phase loop via the **shared** review logic, captures the impact plan + applied file changes + unauthorized edits.                                                                                                                                                                                                                             |
| `support/breaking-changes-harness.ts` | The `breaking-changes` engine. Runs the two real prompts (detect, then trace consumers) against a fixture catalog and captures the structured output.                                                                                                                                                                                                                                                                              |
| `../src/prompts/*.ts`                 | **Single source of truth** for each agent step — the prompt _and_ its run function together. `code-to-docs`: `create-documentation-plan-from-code-changes.ts`, `apply-documentation-plan-to-catalog.ts`. `breaking-changes`: `detect-breaking-schema-changes.ts`, `find-schema-consumers.ts`. Both these harnesses and the production workflows (`src/workflows/`) call them, so the evals test the same prompts that run in prod. |
| `support/scorers.ts`                  | Deterministic, model-free scoring of a `code-to-docs` impact plan (required/forbidden targets, drift).                                                                                                                                                                                                                                                                                                                             |
| `support/breaking-changes-scorers.ts` | Deterministic scoring for `breaking-changes`: was the change correctly flagged, and were the right consumers found (and the producer excluded).                                                                                                                                                                                                                                                                                    |
| `support/skill-*.ts`                  | Lets the real agent (which imports `SKILL.md` via the Flue build plugin) load under plain vitest. See note below.                                                                                                                                                                                                                                                                                                                  |
| `fixtures/<name>/`                    | One scenario each: a source repo and/or an EventCatalog + a `scenario.ts` (the diff and expectations).                                                                                                                                                                                                                                                                                                                             |

## How scoring works

Scoring is **deterministic and model-free** so the bar can't drift. Each agent has its own scorers:

- **`code-to-docs`** (`scoreImpactPlan`) — the right catalog targets are proposed, forbidden ones
  aren't, the source change is identified, unrelated drift goes to `outOfScopeFindings`. Plus
  structural assertions on the applied files (only approved targets edited, the docs were actually
  written, a usable catalog-PR title/summary came back).
- **`breaking-changes`** (`scoreBreakingChange`, `scoreConsumers`) — the change was correctly flagged
  as breaking or additive (with the breaking lines highlighted), and the right consumers were found
  while the producer was excluded.

Each scorer returns a `0..1` score and a list of failures. Add an LLM judge (e.g. `FactualityJudge`
from `vitest-evals/judges`) on top for prose quality when you want to grade doc clarity — keep the
grading model independent from the model under test.

## Adding a scenario

### `code-to-docs`

1. Create `fixtures/<name>/` with a `src/` (pre-PR source state) and a `catalog/` (the EventCatalog
   to edit). Don't `git init` it — the harness does that per run in a temp copy.
2. Add `fixtures/<name>/scenario.ts` exporting the `diff` and an `ImpactPlanExpectation`.
3. Reference it from a `describeEval` block (or add an `it` to `code-to-docs.eval.ts`).

### `breaking-changes`

1. Create `fixtures/<name>/catalog/` with the resources involved — at least a message with a
   `schema.json`, a producer that `sends` it, and a consumer that `receives` it.
2. Add `fixtures/<name>/scenario.ts` exporting a `schemaFile` (the diff + file name) plus a
   `BreakingChangeExpectation` and, when tracing consumers, a `ConsumersExpectation`.
3. Reference it from `breaking-changes.eval.ts` (and pin the expectation in
   `breaking-changes-scorer.eval.ts`).

## Note: the skill-loader shim

The agent imports its skill via `import skill from './SKILL.md' with { type: 'skill' }`. That import
attribute is resolved by Flue's build plugin, which doesn't run under vitest. `support/skill-vite-plugin.ts`
reproduces it: it intercepts the import, builds the skill from disk with `parseSkillMarkdown`, and
registers the packaged skill directory so the harness can hand it to `createFlueContext`. This keeps
the eval running the **unmodified real agent** rather than a re-declared copy.
