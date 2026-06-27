# Repository Guidelines

**EventCatalog Agents** are [Flue](https://flueframework.com)-powered AI agents that keep
EventCatalog documentation in sync with your code. The product is the agent; today it is delivered as
a composite **GitHub Action** that runs in CI, but CI is a delivery surface, not the limit of the
agent. Keep this distinction in mind when naming things and writing docs: reach for "the agent" for
behavior, and "the action" only for GitHub Action mechanics (inputs, checkout, `$GITHUB_ACTION_PATH`,
permissions).

There are two agents today. Each Action invocation runs exactly one, selected by the `agent` input.

**Code-to-Docs** (`agent: code-to-docs`, workflow `pr-review`) is a PR reviewer that:

- reads source pull request diffs,
- understands services, events, commands, queries, schemas, channels, containers, and domain changes,
- inspects the checked-out EventCatalog catalog,
- plans which catalog resources should change, then updates the matching documentation,
- opens or updates a pull request in the catalog repository,
- comments back on the source pull request with a concise summary and catalog PR link.

**Breaking Changes** (`agent: breaking-changes`, workflow `breaking-changes`) is a read-only PR
reviewer that:

- finds changed message schema files in the diff (`.json`, `.yml`, Avro, Protobuf, GraphQL, etc.),
- scores each schema change for whether it is breaking for existing consumers,
- traces breaking changes through the catalog to the resources that consume the message,
- comments back on the source pull request with the breaking lines and affected consumers.
- It never edits the catalog.

Keep deterministic behavior in TypeScript. Let the agents reason about documentation and breakage,
but keep GitHub writes, path resolution, diff parsing, token preflight, impact-plan enforcement, and
catalog change detection explicit in code.

## Project Structure

- `action.yml` — composite GitHub Action. Sets up pnpm and Node 24, checks out the configured catalog
  repo into `eventcatalog/`, installs dependencies into `$GITHUB_ACTION_PATH`, then maps the `agent`
  input to its workflow (`code-to-docs` → `pr-review`, `breaking-changes` → `breaking-changes`) and
  runs `pnpm exec flue run <workflow> --root "$GITHUB_ACTION_PATH" --target node`.
- `flue.config.ts` — Flue config for the Node target.
- `src/workflows/pr-review.ts` — the Code-to-Docs workflow orchestrating PR review and catalog update.
- `src/workflows/breaking-changes.ts` — the Breaking Changes workflow: detect schema changes, score
  them, trace consumers, and comment back. Read-only.
- `src/agents/code-to-docs.ts` — Flue agent: model selection, sandbox setup, EventCatalog skill
  registration, and `dump_catalog` / `linter` tool wiring.
- `src/agents/breaking-changes.ts` — read-only Flue agent for the Breaking Changes workflow
  (`dump_catalog` only, no linter; contract-focused instructions).
- `src/prompts/` — the agent prompts run by the workflows:
  - `create-documentation-plan-from-code-changes.ts` — Code-to-Docs read-only impact-planning pass.
  - `apply-documentation-plan-to-catalog.ts` — Code-to-Docs: applies the approved plan to the catalog.
  - `detect-breaking-schema-changes.ts` — Breaking Changes: scores one schema diff.
  - `find-schema-consumers.ts` — Breaking Changes: traces a breaking schema to its catalog consumers.
- `src/skills/eventcatalog-documentation/` — local Agent Skill (`SKILL.md` + `references/`) telling
  the agent how to generate EventCatalog resources correctly.
- `src/tools/dump-catalog.ts` — deterministic tool returning the EventCatalog SDK catalog dump.
- `src/tools/linter.ts` — deterministic tool that lints the catalog after changes.
- `src/utils/eventcatalog-utils.ts` — catalog path resolution and catalog checkout inspection.
- `src/utils/diff.ts` — changed-file discovery and ignore-path filtering.
- `src/utils/schema-detection.ts` — pure helper: which changed files are message schemas (Breaking
  Changes).
- `src/utils/impact-plan.ts` — detects catalog changes made outside the approved impact plan.
- `src/utils/github/catalog-pr.ts` — catalog repo preflight, git commit/push, and catalog PR
  create/update logic.
- `src/utils/github/reporter.ts` — source PR comment create/update logic (one self-updating comment
  per agent: Code-to-Docs summary and Breaking Changes report use separate markers).
- `src/utils/analytics.ts` — anonymous PostHog usage analytics (one event per run, per agent).
- `src/review-output.ts` — Valibot schemas for the structured agent responses (impact plan + apply
  result; breaking-change score + schema consumers).
- `evals/` — the eval suite that runs the real agent against fixtures. See `evals/README.md`.
- `README.md` — user-facing action usage and setup notes.

## Runtime Flow

### Code-to-Docs (`pr-review`)

The `pr-review` workflow does the following:

1. Resolve config from the Flue payload and GitHub Action environment variables.
2. Inspect the checked-out catalog directory and exit early with a source PR comment if it is missing
   or invalid.
3. Preflight the catalog repository and target branch with the catalog token before doing model work.
4. Collect changed source files from the pull request, applying default and user-provided ignore
   paths. Exit early if no relevant files changed.
5. **Plan**: run the read-only documentation-plan prompt. The agent decides whether the diff requires
   catalog changes and, if so, the exact set of approved target resources. If no changes are required,
   the workflow stops and reports that.
6. **Apply**: run the apply prompt. The agent updates the catalog for the approved targets only,
   using the EventCatalog skill and the `linter` tool.
7. Detect any catalog changes made **outside** the approved plan; if found, skip the catalog PR and
   report it (the agent went off-plan).
8. Commit the catalog changes, push an `eventcatalog-actions/...` branch, and create or update a
   catalog PR against `catalog-ref`.
9. Create or update the source PR summary comment with the high-level summary and catalog PR link.
10. Send one anonymous analytics event describing the run outcome (see Safety / Analytics below).

### Breaking Changes (`breaking-changes`)

The `breaking-changes` workflow is read-only and does the following:

1. Resolve config and collect changed source files (same as Code-to-Docs). Exit early if none.
2. Narrow to changed schema files via `getChangedSchemaFiles`. Exit early if the PR touches no schemas.
3. **Detect**: for each schema, run the read-only `detect-breaking-schema-changes` prompt. Drop any
   change scored non-breaking.
4. **Trace**: for each breaking change, run the read-only `find-schema-consumers` prompt, which uses
   `dump_catalog` to resolve the owning resource and find its consumers (producers are excluded).
5. Post (or update) a single Breaking Changes comment on the source PR. If no breaking changes are
   found, or none have catalog consumers, log it and skip the comment.
6. Send one anonymous analytics event describing the run outcome.

The catalog checkout path is intentionally `eventcatalog/` under `$GITHUB_WORKSPACE`. In TypeScript,
always resolve it through `resolveCatalogPath(config)` before passing it to SDKs, tools, or git
operations.

## Action Contract

| Input           | Default                       | Description                                                    |
| --------------- | ----------------------------- | -------------------------------------------------------------- |
| `agent`         | `code-to-docs`                | Which agent to run: `code-to-docs` or `breaking-changes`.      |
| `catalog-repo`  | _(required)_                  | `owner/repo` catalog repository.                               |
| `catalog-ref`   | `main`                        | Target catalog branch.                                         |
| `catalog-token` | `github.token`                | Token used to check out, push to, and open PRs in the catalog. |
| `model`         | `anthropic/claude-sonnet-4-6` | Model specifier ([available models](https://pi.dev/models)).   |
| `ignore-paths`  | see `action.yml`              | Comma-separated paths/globs excluded from diff review.         |

Provider keys are supplied through normal workflow env vars (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`OPENROUTER_API_KEY`). Analytics can be disabled with `POSTHOG_KEY: ""`.

## Build, Test, And Development

This project uses **pnpm**. Flue requires Node.js `>=22.19.0`; CI uses Node 24.

- Install dependencies: `pnpm install`
- Build + typecheck + evals: `pnpm test`
- Build TypeScript only: `pnpm run build`
- Format check: `pnpm run format:check`
- Run the workflow locally:

```sh
pnpm exec flue run pr-review --root . --target node --payload '{"workspace":"/tmp/example"}'
```

## Coding Style

- TypeScript strict mode, ESM (`"type": "module"`).
- Use the `@/*` path alias for absolute imports from the project root.
- Prefer small pure helper modules for deterministic behavior.
- Keep model-backed behavior inside Flue workflows, agents, tools, and Agent Skills.
- Use structured (schema-checked) model results when TypeScript code depends on exact fields.
- Match existing EventCatalog skill guidance before creating or updating catalog files.
- Avoid broad refactors while the action contract is still settling.

## Safety

- Keep diffs scoped and easy to review.
- Do not commit secrets, tokens, provider API keys, local reports, or generated temporary files.
- Do not edit outside the resolved catalog path when making catalog documentation changes, and never
  edit catalog resources outside the approved impact plan.
- Do not broaden GitHub Action permissions without a concrete reason.
- Treat source PR comments and model output as untrusted data; validate or schema-check anything used
  by deterministic code.
- Analytics must stay anonymous: report only run outcome, model, duration, and repository — never the
  contents of a user's repository (file counts, paths, diffs, or source).
- Be careful with path handling in composite actions: `$GITHUB_ACTION_PATH` is the action package,
  while `$GITHUB_WORKSPACE` is the source repository checkout.
