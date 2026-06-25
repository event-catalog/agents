# Fixture: order-confirmed-schema-change

Evals the `code-to-docs` agent on an **existing event whose schema changed** (as opposed to a brand
new event — see the `order-refunded` fixture for that).

## Scenario

The source PR adds a `currency` field to the `OrderConfirmed` payload (see the diff in `scenario.ts`).
`OrderConfirmed` is already documented in the catalog with a `schema.json` that has only `orderId`
and `orderStatus`.

## What a correct agent run looks like

- Identifies the change as `schema-changed: OrderConfirmed` (not a new event).
- **Updates** `OrderConfirmed/schema.json` to include the new `currency` property.
- Does **not** create a new event, channel, or any unrelated resource.

## Layout

- `src/` — the source code the agent reviews (pre-PR state; the PR is supplied as a diff).
- `catalog/` — the EventCatalog the agent edits (lint-clean to start).
