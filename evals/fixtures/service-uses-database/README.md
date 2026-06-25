# Fixture: service-uses-database

Evals the `code-to-docs` agent on a **service that starts using a database** — it should document the
data store as an EventCatalog container and map the service's read/write relationship to it.

## Scenario

The source PR makes `OrdersService` connect to a Postgres `orders-db`: `confirmOrder` now writes the
order status and reads it back (readWrite). The catalog documents `OrdersService` but has no
container for it yet.

## What a correct agent run looks like

- Classifies the change as `service-changed` for `OrdersService`.
- **Creates** a new container under the service:
  `domains/Orders/services/OrdersService/containers/<orders-db>/index.mdx`
  (frontmatter `container_type: database`, a `technology` like `postgres`).
- **Updates** `OrdersService/index.mdx` to map the relationship — both `writesTo` and `readsFrom`
  the new container.
- Does **not** invent events, channels, or unrelated resources.

See `references/containers.md` in the skill for the container conventions.

## Layout

- `src/` — the source code the agent reviews (pre-PR state; the PR is supplied as a diff).
- `catalog/` — the EventCatalog the agent edits (lint-clean to start).
