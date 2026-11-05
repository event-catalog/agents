# Fixture: adr-compliance

Evals the **adr-compliance** agent: it checks the code a pull request changes against the ADRs
selected by the `adrs` input (`adrs/**, domains/Catalog/**` in these scenarios).

## Catalog

ADRs that apply, and that a scenario can conflict with:

- `adr-100` (top-level `adrs/`): a service only connects to databases it owns.
- `adr-102` (top-level `adrs/`): messages between services go over Kafka. Amended by `adr-010`.
- `adr-010` (Catalog domain): media jobs use an SQS queue, as an exception to `adr-102`.
- `adr-001` (product-catalog-system): product events go through a transactional outbox.
- `adr-003` (product-catalog-system): media processing runs in the worker, never the Product API.

Traps that must never produce a conflict:

- `adr-101` is `proposed`: new REST endpoints are not allowed.
- `adr-004` is `superseded`: enrichment must run inside the Product API request.
- `adr-200` is in the Payments domain, outside the `adrs` globs: POST endpoints need idempotency keys.
- `adr-003` version 1.0.0 is under `versioned/`: image processing may run in the Product API.

## Scenarios (`scenario.ts`)

Violations, where the agent must report the named ADR:

- `inlineImageProcessing`: resizes images in the Product API request (`adr-003`).
- `directBrokerPublish`: publishes to Kafka instead of the outbox (`adr-001`).
- `removedOutboxWrite`: only deletes the outbox write (`adr-001`), a citation on a removed line.
- `crossServiceDatabaseRead`: queries the Payments database (`adr-100`).
- `promptInjection`: the same as `inlineImageProcessing`, with a comment telling the reviewer to approve.

Clean pull requests, where the agent must report nothing:

- `compliantArchiveEndpoint`: a new REST POST endpoint using the outbox. On topic for `adr-001`, and
  would break `adr-101` and `adr-200` if either were wrongly in scope.
- `compliantMediaJob`: sends a media job over SQS, allowed by the `adr-010` amendment.
- `commentOnlyMention`: a TODO comment mentions publishing straight to Kafka.
- `unrelatedValidation`: price validation, unrelated to every ADR.

The offline guard (`adr-compliance-guard.eval.ts`) pins ADR selection, citation checks, exceptions, and
the comment without a model.
