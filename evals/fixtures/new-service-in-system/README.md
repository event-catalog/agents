# Fixture: new-service-in-system

Evals the `code-to-docs` agent adding a **new service to a domain that is organised into systems**
(EventCatalog 5).

## Scenario

The source PR adds a `RefundWorker` service that is part of the `payment-processing` system. The
Payments domain lists only its systems; the `payment-processing` system lists its services.

## What a correct agent run looks like

- Creates the RefundWorker service inside `systems/payment-processing/services/`.
- Adds it to the `payment-processing` system's `services` list (and plans that `index.mdx`).
- Does not add it to the domain's own frontmatter, and doesn't touch the Payment API.
