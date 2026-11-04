# Fixture: message-version-bump

Evals the `code-to-docs` agent on a **breaking change that bumps a message's version**, where other
catalog resources pin that version.

## Scenario

The source PR replaces `OrderConfirmed`'s `totalAmount` number with a required `total` object and
bumps the contract from 1.0.0 to 2.0.0 (see the diff in `scenario.ts`). In the catalog:

- `OrdersService` sends `OrderConfirmed` 1.0.0 (the producer).
- `InventoryService` receives `OrderConfirmed` 1.0.0. Its code doesn't change in the PR.
- `BillingService` receives `OrderConfirmed` at `latest`.
- `fitness/` has one fitness function: producers must send the latest version of their messages.

## What a correct agent run looks like

- Updates `OrderConfirmed/schema.json` and bumps the event to 2.0.0.
- Updates `OrdersService`'s `sends` pin to 2.0.0. The workflow adds `OrdersService` and
  `InventoryService` to the plan because they pin 1.0.0, so these edits are not off-plan.
- Leaves `InventoryService` on 1.0.0 and doesn't touch `BillingService`.
- The workflow archives the previous version to `OrderConfirmed/versioned/1.0.0/`.

## Layout

- `src/` — the source code the agent reviews (pre-PR state; the PR is supplied as a diff).
- `catalog/` — the EventCatalog the agent documents into.
