# Fixture: new-service-with-openapi

Evals the `code-to-docs` agent on a PR that **adds a new service with an OpenAPI spec** — it should
document the service in EventCatalog and attach the spec to it.

## Scenario

The source PR adds a brand-new `PaymentsService` with a REST API and an `openapi.yml` spec. The
catalog has a `Payments` domain but no `PaymentsService` yet.

## What a correct agent run looks like

- Classifies the change as `service-added` for `PaymentsService`.
- **Creates** the service under the domain:
  `domains/Payments/services/PaymentsService/index.mdx`.
- **Writes the OpenAPI spec file** alongside the service (e.g. `.../PaymentsService/openapi.yml`).
- **References the spec** from the service frontmatter via `specifications` (type `openapi`) and/or
  `schemaPath`.
- Does **not** invent events, channels, or unrelated resources.

See `references/services.md` in the skill for the spec conventions.

## Layout

- `src/` — the source code the agent reviews (pre-PR state; the PR is supplied as a diff).
- `catalog/` — the EventCatalog the agent edits (lint-clean to start).
