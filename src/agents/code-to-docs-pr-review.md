# Pull Request Review Workflow

Follow this procedure in the planning phase, before proposing catalog targets, and again before writing files:

1. Read the actual diff hunks, not only the current file contents. The diff shows what this pull request introduced, removed, or changed.
2. Identify the pull request intent in domain terms: new event, changed event payload, new command, new query, changed service relationship, new endpoint, renamed message, deleted capability, or documentation-only change.
3. Classify each change with a consistent type. When an existing event/command/query's payload or schema changes (for example a field is added to its published message), the change is `schema-changed` — not `event-added` or `service-changed`. Use `*-added` only for a brand-new resource and `*-removed` when one is deleted.
4. Map only those changed concepts to EventCatalog resources.
5. Check whether each mapped resource already exists before creating a new one.
6. Build a small edit plan that lists the exact catalog resource folders or files to change. Every file you will create must sit inside a planned target, so plan a new resource by its folder (for example `services/OrdersService/containers/orders-db`), not only the files around it.
7. Do not edit catalog files outside that plan.

Common PR-review mappings:

- A new event constant plus publish code means create or update that event resource and update the producing service `sends`.
- A changed event payload means update that event schema, examples, and summary where needed. Bump the message `version` when the change is breaking for consumers (a removed, renamed, or retyped field, or a new required field); additive changes keep their version.
- When you bump a message's `version`:
  - The workflow adds every service, agent, or domain that pins the current version to the approved plan for you, so you don't need to plan those files yourself.
  - Update the producer's `sends` pin to the new version.
  - Update a consumer's `receives` pin only if this pull request moves that consumer to the new version; otherwise leave it on the old one.
  - Do not create `versioned/` copies of the old version. The `linter` and `fitness_check` tools archive the previous version automatically before they run, so consumers left on the old version still resolve. Don't move a consumer to the new version just to satisfy the linter.
- A renamed or fixed message ID means update the existing message relationship; do not create a new resource unless the new message is genuinely new.
- A new service, agent, or system nested under a domain means also plan that domain's `index.mdx`: the domain must list it in its `services`, `agents`, or `systems` frontmatter.
- A new command/query handler or endpoint means create or update the matching command/query resource and the service's `receives` relationship, but only where the catalog already models that service's endpoints this way. Check the service first: if its existing HTTP endpoints are documented as commands or queries, document the new endpoint the same way; if they are only described by its API specification, update the specification and don't add a command or query. Follow the catalog's existing conventions over your own preference, so repeated reviews of the same change give the same result.
- A service that starts using a data store (a database, cache, or object store that holds state — e.g. new code that opens a DB connection pool, runs SQL, or reads/writes a cache) means create a container for that data store under the service (`services/{Service}/containers/{container}/index.mdx`) with a `container_type` and `technology`, and map the service to it: add the data store id to the service's `writesTo` when it persists/updates data and `readsFrom` when it queries data (both when it does both). Plan the new container folder as its own target alongside the service. A connection string or client appearing in a changed file is enough to document the container only when this pull request introduced that data-store usage.
- A new or changed API specification file in the pull request (OpenAPI, AsyncAPI, or a GraphQL schema) means copy that file into the owning service's catalog folder, next to its `index.mdx` (for example `services/PaymentsService/openapi.yml`), and reference it from the service's `specifications` frontmatter. Copy the file contents from the source repository unchanged rather than retyping them. Documenting the operations it describes does not replace storing the spec file itself.
- A channel constant appearing in a changed file is not enough to create a channel. Only create or update channel resources when the channel itself was introduced, renamed, or its routing changed in the pull request.
- Message-transport infrastructure (a Kafka topic, message queue, event bus, SNS/SQS, Pub/Sub subject, etc.) is a CHANNEL, never a container/data store. When a service starts publishing or consuming messages over such transport, create a `channel` (with the relevant `protocols`, e.g. `kafka`) and wire the service's `sends[].to` / `receives[].from` to it — do NOT model it as a container with `writesTo`/`readsFrom`. Containers are only for stateful stores (databases, caches, object stores) that hold data, not for moving messages.
- Existing catalog issues discovered during review but not introduced by the pull request are out of scope. Report them, but do not edit them.
- Never create or edit fitness functions (files in a `fitness/` folder or named `*.fitness.ts`). They are the catalog's architecture rules, maintained by its owners; changes to them are always rejected.
- If no EventCatalog documentation changes are needed, return a clear no-op rationale.
