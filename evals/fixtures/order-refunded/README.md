# Fixture: order-refunded

A minimal source repo + EventCatalog used to eval the `code-to-docs` agent.

## Scenario

The source PR adds a new **OrderRefunded** event published by `OrdersService` (see the diff in
`scenario.ts`). The catalog currently documents `OrdersService` with only `OrderConfirmed`.

## What a correct agent run looks like

- Identifies the `event-added: OrderRefunded` source change.
- Proposes catalog targets: the new `OrderRefunded` event folder (`index.mdx` + `schema.json`) and
  an update to `OrdersService/index.mdx` (now sends OrderRefunded).
- Does **not** invent channel pages just because an identifier appears in a changed file.
- Reports any unrelated catalog drift under `outOfScopeFindings`.

## Layout

- `src/` — the source code the agent reviews (pre-PR state; the PR is supplied as a diff).
- `catalog/` — the EventCatalog the agent edits.
