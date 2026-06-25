# Fixture: service-publishes-over-kafka

Evals the `code-to-docs` agent on a service that **starts publishing an event over Kafka** — it
should document the event, create a channel for the Kafka topic, and wire the service to send the
event _to_ that channel.

## Scenario

The source PR makes `OrdersService.confirmOrder` publish a new `OrderConfirmed` event onto the Kafka
topic `orders.confirmed`. The catalog documents `OrdersService` but has no events or channels yet.

## What a correct agent run looks like

- Classifies the change as `event-added` for `OrderConfirmed`.
- **Creates** the `OrderConfirmed` event under the service.
- **Creates** a channel representing the Kafka topic (top-level `channels/...` or nested under the
  service — either is valid), with `protocols: [kafka]` and the topic as its `address`.
- **Updates** `OrdersService/index.mdx` so it `sends` OrderConfirmed, with `to:` referencing the new
  channel.
- Does **not** invent unrelated resources.

See `references/channels.md` and `references/services.md` in the skill for conventions.

## Layout

- `src/` — the source code the agent reviews (pre-PR state; the PR is supplied as a diff).
- `catalog/` — the EventCatalog the agent edits (lint-clean to start).
