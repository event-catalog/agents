# Fixture: breaking-change-order-confirmed

Evals the **breaking-changes** agent: it scores a changed schema for breaking changes and traces a
breaking change to its consumers in the catalog.

## Catalog

- `OrdersService` (Orders domain) **sends** `OrderConfirmed` — the producer.
- `NotificationsService` (Notifications domain) **receives** `OrderConfirmed` — a consumer.
- `OrderConfirmed` has a `schema.json` with required `orderId` and `orderStatus`.

## Scenarios (`scenario.ts`)

- `orderConfirmedBreaking` — the schema **removes the required `orderStatus` field**. This breaks
  consumers that read it.
- `orderConfirmedAdditive` — the schema **adds an optional `currency` field**. This is additive and
  non-breaking.

## What a correct agent run looks like

For the breaking scenario:

- Marks the change `isBreaking: true` and highlights the removed `orderStatus`.
- Traces it to `NotificationsService` (the consumer that receives `OrderConfirmed`).
- Does **not** report `OrdersService` as a consumer (it is the producer).

For the additive scenario:

- Marks the change `isBreaking: false`.
