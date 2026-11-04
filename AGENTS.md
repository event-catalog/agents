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
  repo into `eventcatalog/`, installs dependencies into `$GITHUB_ACTION_PATH`, then runs
  `pnpm exec tsx src/run.ts <agent> --payload <json>`.
- `src/run.ts` — the entry point. Maps the `agent` input to its workflow (`code-to-docs` →
  `pr-review`, `breaking-changes` → `breaking-changes`), boots the Flue runtime in-process with
  `start()`, runs the workflow, prints the result, and exits non-zero on failure.
- `src/workflows/pr-review.ts` — the Code-to-Docs workflow orchestrating PR review and catalog update.
- `src/workflows/breaking-changes.ts` — the Breaking Changes workflow: detect schema changes, score
  them, trace consumers, and comment back. Read-only.
- `src/agents/code-to-docs.ts` — the `CodeToDocs` Flue agent function: model selection, sandbox
  setup, EventCatalog skill, and `dump_catalog` / `linter` tool wiring, via Flue agent hooks.
- `src/agents/code-to-docs-pr-review.md` — Code-to-Docs' pull-request review workflow and
  PR-to-catalog mapping rules (e.g. a new database becomes a container, a Kafka topic a channel, an
  OpenAPI file is copied next to its service). Loaded into the agent's instructions rather than the
  skill so the planning step always has them.
- `src/agents/breaking-changes.ts` — the read-only `BreakingChanges` Flue agent function
  (`dump_catalog` only, no linter; contract-focused instructions).
- `src/agents/structured-results.ts` — how workflows get schema-checked results from an agent: each
  step gets a `submit_<name>` tool (validated input, recorded via `useDataWriter`, ends the turn),
  `promptForResult` sends a step and reads the result back, and `initWithData` opens a conversation
  seeded with the review payload.
- `src/prompts/` — the agent prompts run by the workflows:
  - `create-documentation-plan-from-code-changes.ts` — Code-to-Docs read-only impact-planning pass.
  - `apply-documentation-plan-to-catalog.ts` — Code-to-Docs: applies the approved plan to the catalog.
  - `detect-breaking-schema-changes.ts` — Breaking Changes: scores one schema diff.
  - `find-schema-consumers.ts` — Breaking Changes: traces a breaking schema to its catalog consumers.
- `src/skills/vendor/catalog-documentation-creator/` — EventCatalog's own documentation skill
  (`SKILL.md` + `references/`), copied unchanged from
  [event-catalog/skills](https://github.com/event-catalog/skills). Do not edit it here; update it
  with `pnpm run skills:sync` (see `src/skills/vendor/README.md`).
- `src/skills/agent-guidance.md` — how both agents use that interactive skill unattended (no user to
  ask, no scaffolding, no MCP server). Edit this, not the vendored copy.
- `src/skills/load-skill.ts` — loads the vendored skill at runtime with `defineSkill`, places
  `agent-guidance.md` in front of its instructions, and names it `eventcatalog-documentation`
  (Flue's `SKILL.md` imports need its Vite build, which neither the action nor the evals run).
- `scripts/sync-skill.sh` — replaces the vendored skill with the latest upstream copy.
- `src/tools/dump-catalog.ts` — deterministic tool returning a compact index of the EventCatalog SDK
  catalog dump: domains, systems (with the services and data stores they contain), services, agents,
  messages, channels, entities, data stores, flows, and ADRs.
- `src/tools/linter.ts` — deterministic tool that lints the catalog after changes, with the linter
  version the catalog pins (or a pinned default), never an unpinned latest.
- `src/tools/fitness-check.ts` — deterministic tool that runs the catalog's fitness functions
  (`fitness/*.fitness.ts`) in a child process and reports only the problems the agent introduced
  (compared with the catalog at `HEAD`).
- `src/utils/child-process-env.ts` — the minimal environment for child processes that run catalog
  code or npm packages (no provider keys or GitHub tokens), and the catalog's pinned tool versions.
- `src/utils/eventcatalog-utils.ts` — catalog path resolution and catalog checkout inspection.
- `src/utils/diff.ts` — changed-file discovery and ignore-path filtering.
- `src/utils/schema-detection.ts` — pure helper: which changed files are message schemas (Breaking
  Changes).
- `src/utils/impact-plan.ts` — detects catalog changes made outside the approved impact plan. Edits to
  fitness functions are always outside it.
- `src/utils/version-pins.ts` — adds the services, agents, and domains that pin a planned message's
  current version to the plan, so a version bump can update them without being blocked as off-plan.
- `src/utils/archive-versions.ts` — after the off-plan check, archives the previous version of any
  resource whose `version` changed to `versioned/<version>/`.
- `src/utils/catalog-changes.ts` — lists changed catalog files and groups them by resource, for the
  source PR comment and the catalog PR body.
- `src/utils/github/catalog-pr.ts` — catalog repo preflight, git commit/push, and catalog PR
  create/update logic.
- `src/utils/github/reporter.ts` — source PR comment create/update logic (one self-updating comment
  per agent: Code-to-Docs summary and Breaking Changes report use separate markers). The Code-to-Docs
  comment is a `ReviewComment` (`catalog-updated`, `no-changes`, `off-plan`, `not-run`), formatted
  from the run's deterministic results, not from model prose about the source PR.
- `src/utils/github/format.ts` — markdown shared by the comments and the catalog PR body (the
  resource-changes table, "worth checking" notes from the plan, heading nesting).
- `src/utils/analytics.ts` — anonymous PostHog usage analytics (one event per run, per agent).
- `src/review-output.ts` — Valibot schemas for the structured agent responses (impact plan + apply
  result; breaking-change score + schema consumers).
- `evals/` — the eval suite that runs the real agent against fixtures. See `evals/README.md`.
- `README.md` — user-facing action usage and setup notes.

## Runtime Flow

### Code-to-Docs (`pr-review`)

The `pr-review` workflow does the following:

1. Resolve config from the `--payload` JSON and GitHub Action environment variables.
2. Inspect the checked-out catalog directory and exit early with a source PR comment if it is missing
   or invalid.
3. Preflight the catalog repository and target branch with the catalog token before doing model work.
4. Collect changed source files from the pull request, applying default and user-provided ignore
   paths. Exit early if no relevant files changed.
5. **Plan**: run the read-only documentation-plan prompt. The agent decides whether the diff requires
   catalog changes and, if so, the exact set of approved target resources. If no changes are required,
   the workflow stops and reports that.
6. Add the resources that pin a planned message's current exact version to the plan
   (`withVersionPinTargets`), so a version bump can update them.
7. **Apply**: run the apply prompt. The agent updates the catalog for the approved targets only,
   using the EventCatalog skill and the `linter` and `fitness_check` tools.
8. Detect any catalog changes made **outside** the approved plan; if found, skip the catalog PR and
   report it (the agent went off-plan).
9. Archive the previous version of anything the agent re-versioned (`archivePreviousVersions`).
10. Commit the catalog changes, push an `eventcatalog-actions/...` branch, and create or update a
    catalog PR against `catalog-ref`.
11. Create or update the source PR comment with the catalog PR link and the resources that changed.
12. Send one anonymous analytics event describing the run outcome (see Safety / Analytics below).

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

| Input                                             | Default                       | Description                                                    |
| ------------------------------------------------- | ----------------------------- | -------------------------------------------------------------- |
| `agent`                                           | `code-to-docs`                | Which agent to run: `code-to-docs` or `breaking-changes`.      |
| `catalog-repo`                                    | _(required)_                  | `owner/repo` catalog repository.                               |
| `catalog-ref`                                     | `main`                        | Target catalog branch.                                         |
| `catalog-token`                                   | `github.token`                | Token used to check out, push to, and open PRs in the catalog. |
| `github-app-client-id` / `github-app-private-key` |                               | Optional GitHub App used instead of `catalog-token`.           |
| `model`                                           | `anthropic/claude-sonnet-4-6` | Model specifier ([available models](https://pi.dev/models)).   |
| `ignore-paths`                                    | see `action.yml`              | Comma-separated paths/globs excluded from diff review.         |
| `schema-extensions`                               | see `action.yml`              | Comma-separated extensions Breaking Changes treats as schemas. |

Provider keys are supplied through normal workflow env vars (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`OPENROUTER_API_KEY`). Analytics can be disabled with `POSTHOG_KEY: ""`.

## Build, Test, And Development

This project uses **pnpm**. Flue requires Node.js `>=22.19.0`; CI uses Node 24.

- Install dependencies: `pnpm install`
- Build + typecheck + evals: `pnpm test`
- Build TypeScript only: `pnpm run build`
- Format check: `pnpm run format:check`
- Run an agent locally (`code-to-docs` or `breaking-changes`):

```sh
pnpm exec tsx src/run.ts code-to-docs --payload '{"workspace":"/tmp/example"}'
```

Flue 2 has no workflow primitive: `src/workflows/*` are plain TypeScript that drive the agents through
`init()` handles, so they need a running runtime (`start()` in `src/run.ts` or the eval harness).
Agents are synchronous functions composed with hooks (`useModel`, `useSandbox`, `useSkill`,
`useTool`); they read the review payload with `useInitialData()`. Flue's own docs ship in
`node_modules/@flue/runtime/docs/`.

## Coding Style

- TypeScript strict mode, ESM (`"type": "module"`).
- Use the `@/*` path alias for absolute imports from the project root.
- Prefer small pure helper modules for deterministic behavior.
- Keep model-backed behavior inside Flue agents, tools, and Agent Skills.
- Use structured (schema-checked) model results when TypeScript code depends on exact fields:
  define them with `defineStructuredResult` and read them with `promptForResult`.
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
- Analytics must stay anonymous: report only run outcome, error category (`classifyError`), model,
  duration, repository, and counts of the agent's own catalog PRs by state — never the contents of a
  user's repository (file counts, paths, diffs, source, or error messages).
- Fitness functions and npm tools are catalog or third-party code: run them only through
  `childProcessEnv()`, never in-process, and never let the agent write them.
- Be careful with path handling in composite actions: `$GITHUB_ACTION_PATH` is the action package,
  while `$GITHUB_WORKSPACE` is the source repository checkout.
