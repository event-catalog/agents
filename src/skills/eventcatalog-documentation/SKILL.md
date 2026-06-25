---
name: eventcatalog-documentation
description: Generates EventCatalog documentation files (services, agents, events, commands, queries, domains, flows, channels, containers, ADRs, data products, entities, diagrams) with correct frontmatter, folder structure, and best practices. Use when user asks to "document a service", "document an agent", "document an AI agent", "create EventCatalog files", "add an event to the catalog", "document my architecture", "generate catalog documentation", "create documentation for my microservice", "document a database", "create an ADR", "document a data product", or "document an entity".
license: BUSL-1.1
metadata:
  author: eventcatalog
  version: '1.0.0'
---

# EventCatalog Documentation Skill

This skill tells and agent how to generate EventCatalog documentation files (services, agents, events, commands, queries, domains, flows, channels, containers, ADRs, data products, entities, diagrams) with correct frontmatter, folder structure, and best practices.

If the catalog directory already has resources, read the existing files to understand:

- Naming conventions (PascalCase IDs? kebab-case?)
- Folder structure (nested under domains or flat?)
- Which owners/teams are already defined
- Badge styles and patterns used
- Schema formats in use (JSON Schema, Avro, etc.)

Match new documentation to these existing conventions.

This ensures new documentation is consistent with what's already in the catalog.

## Pull Request Review Workflow

When using this skill to update EventCatalog documentation from a source-code pull request, follow this procedure before writing files:

1. Read the actual diff hunks, not only the current file contents. The diff shows what this pull request introduced, removed, or changed.
2. Identify the pull request intent in domain terms: new event, changed event payload, new command, new query, changed service relationship, new endpoint, renamed message, deleted capability, or documentation-only change.
3. Classify each change with a consistent type. When an existing event/command/query's payload or schema changes (for example a field is added to its published message), the change is `schema-changed` — not `event-added` or `service-changed`. Use `*-added` only for a brand-new resource and `*-removed` when one is deleted.
4. Map only those changed concepts to EventCatalog resources.
5. Check whether each mapped resource already exists before creating a new one.
6. Build a small edit plan that lists the exact catalog resource folders or files to change.
7. Do not edit catalog files outside that plan.

Common PR-review mappings:

- A new event constant plus publish code means create or update that event resource and update the producing service `sends`.
- A changed event payload means update that event schema, examples, and summary where needed.
- A renamed or fixed message ID means update the existing message relationship; do not create a new resource unless the new message is genuinely new.
- A new command/query handler or endpoint means create or update the matching command/query resource and service `receives`/`queries` relationship where the catalog models it that way.
- A service that starts using a data store (a database, cache, or object store that holds state — e.g. new code that opens a DB connection pool, runs SQL, or reads/writes a cache) means create a container for that data store under the service (`services/{Service}/containers/{container}/index.mdx`) with a `container_type` and `technology`, and map the service to it: add the data store id to the service's `writesTo` when it persists/updates data and `readsFrom` when it queries data (both when it does both). A connection string or client appearing in a changed file is enough to document the container only when this pull request introduced that data-store usage.
- A channel constant appearing in a changed file is not enough to create a channel. Only create or update channel resources when the channel itself was introduced, renamed, or its routing changed in the pull request.
- Message-transport infrastructure (a Kafka topic, message queue, event bus, SNS/SQS, Pub/Sub subject, etc.) is a CHANNEL, never a container/data store. When a service starts publishing or consuming messages over such transport, create a `channel` (with the relevant `protocols`, e.g. `kafka`) and wire the service's `sends[].to` / `receives[].from` to it — do NOT model it as a container with `writesTo`/`readsFrom`. Containers are only for stateful stores (databases, caches, object stores) that hold data, not for moving messages.
- Existing catalog issues discovered during review but not introduced by the pull request are out of scope. Report them, but do not edit them.
- If no EventCatalog documentation changes are needed, return a clear no-op rationale.

## Understanding format of resources

Generate files following the resource-specific references. Consult the appropriate reference file for the resource type:

- `references/services.md` — Services with sends/receives, channel routing, containers
- `references/agents.md` — Agents with model metadata, tools, sends/receives, containers, and flows
- `references/events.md` — Events with schemas, payload examples, producer/consumer code
- `references/commands.md` — Commands with REST operations and schemas
- `references/queries.md` — Queries with REST operations and response schemas
- `references/domains.md` — Domains with subdomains, services, and business context
- `references/flows.md` — Business flows with steps, branching, and external systems
- `references/channels.md` — Channels with routing, protocols, and parameters
- `references/containers.md` — Containers (stateful data stores: databases, caches, object stores) with data classification
- `references/adrs.md` — Architecture decision records with status, date, decision makers, appliesTo, and relationships
- `references/data-products.md` — Data products with inputs, outputs, data contracts, lineage, and SLAs
- `references/entities.md` — DDD/domain entities with identifiers, properties, relationships, and aggregate roots
- `references/diagrams.md` — Reusable diagram resources (Mermaid, PlantUML, architecture diagrams)
- `references/ubiquitous-language.md` — Ubiquitous language terms per domain (DDD glossary/dictionary)
- `references/teams-and-users.md` — Teams and users (ownership)
- `references/components.md` — Components (NodeGraph, Schema, Mermaid, Tabs, etc.) and resource references (`[[type|Name]]` wiki-style links)
- `references/supporting-collections.md` — Changelogs, resource docs, custom docs, schemas, and Studio designs

Every resource file MUST include:

- Valid YAML frontmatter between `---` delimiters
- `id` field matching existing catalog conventions
- `name` as human-readable display name
- `version` as semantic version string
- `summary` as a concise 1-2 sentence description

CRITICAL: Always use `index.mdx` as the filename for versioned resources (services, agents, events, commands, queries, domains, flows, channels, containers, ADRs, data products, entities, diagrams). Teams and users use `{id}.mdx` files directly. Ubiquitous language uses `ubiquitous-language.mdx`. Place files in the correct folder path following the nested structure pattern:

```
domains/{DomainName}/services/{ServiceName}/events/{EventName}/index.mdx
domains/{DomainName}/agents/{AgentName}/index.mdx
domains/{DomainName}/data-products/{DataProductName}/index.mdx
domains/{DomainName}/entities/{EntityName}/index.mdx
domains/{DomainName}/diagrams/{DiagramName}/index.mdx
```

Or flat structure if the catalog uses that pattern:

```
services/{ServiceName}/index.mdx
agents/{AgentName}/index.mdx
events/{EventName}/index.mdx
adrs/{adr-id}/index.mdx
data-products/{DataProductName}/index.mdx
entities/{EntityName}/index.mdx
diagrams/{DiagramName}/index.mdx
```

Do not generate `schemas` collection entries directly. Generate or reference schema files from events, commands, or queries using `schemaPath` or `schemas`; EventCatalog creates the `schemas` collection from those references.

### Validation

Before presenting the files to the user, verify:

- YAML frontmatter has `---` delimiters on both sides
- All `id` fields are consistent (no spaces, match folder name)
- All `version` fields are valid semver strings (e.g., `0.0.1`)
- All message references in `sends`/`receives` include `id` and optionally `version`
- Channel routing uses `to`/`from` fields correctly in sends/receives
- Schema files referenced in `schemaPath` actually exist or are generated
- `<NodeGraph />` component is included for architecture visualization
- Owner IDs reference real teams/users in the catalog
- Run the EventCatalog linter after making documentation changes and fix any errors before finishing

## Common Patterns

### Documenting a Service That Processes Messages

1. Generate the service `index.mdx` with `receives` and `sends` arrays
2. If messages flow through channels, add `to`/`from` fields to the sends/receives
3. Generate each event `index.mdx` if they don't already exist in the catalog
4. Include `<NodeGraph />` in the service body to show message flow
5. Generate related entities if the service owns important domain objects
6. Add example payload sections for each message
7. Place files in the correct nested folder structure

### Documenting an Agent

When a user says "document my support agent that reads order data and uses Zendesk":

1. Generate the agent `index.mdx` with `model`, `tools`, `receives`/`sends`, `readsFrom`/`writesTo`, and `flows` where known
2. Generate or reference events/commands/queries the agent consumes or produces
3. Generate containers for data stores the agent reads or writes
4. Include `<AgentTools />` when tools are documented
5. Include `<NodeGraph />` so the agent appears in architecture visualizations
6. If the agent belongs to a domain, add it to the domain's `agents` frontmatter

### Documenting a Domain

CRITICAL: A domain MUST have at least one service or agent. Never create an empty domain. If the user describes a domain, ensure services or agents are identified and generated for it.

When a user wants to document a full domain:

1. Identify the services and agents that belong to this domain. If the user hasn't specified any, ask them: "What services or agents belong to this domain?" Do NOT create an empty domain.
2. Generate the domain `index.mdx` with the `services` field listing every service and the `agents` field listing every agent
3. Include `entities`, `data-products`, `flows`, and `diagrams` fields when those resources belong to the domain
4. Generate each service and agent within the domain
5. Generate each message referenced by the services and agents
6. Generate entities, data products, diagrams, and channels if the user describes them
7. Use the nested folder structure: `domains/{Domain}/services/{Service}/events/{Event}/`, `domains/{Domain}/agents/{Agent}/`, `domains/{Domain}/entities/{Entity}/`, and `domains/{Domain}/data-products/{DataProduct}/`
8. Generate a `ubiquitous-language.mdx` file for the domain by extracting domain-specific terms from service names, agent names, event/command names, entities, and business processes. Place it at `domains/{Domain}/ubiquitous-language.mdx`. See `references/ubiquitous-language.md` for format and examples.
9. CRITICAL: After generating all files, verify the domain's frontmatter `services` field lists every service and `agents` lists every agent that belongs to it. Every service or agent created under a domain MUST be referenced in the domain's `index.mdx`:
   ```yaml
   services:
     - id: OrdersService
     - id: InventoryService
     - id: PaymentService
   agents:
     - id: OrderSupportAgent
   ```
   If a service or agent is nested inside the domain folder but not listed in the domain's frontmatter, it will not appear as part of that domain. Always cross-check.

### Documenting an ADR

When a user describes an architecture decision:

1. Generate `adrs/{adr-id}/index.mdx`
2. Use one of the supported statuses: `proposed`, `accepted`, `rejected`, `deprecated`, or `superseded`
3. Include a `date` in `YYYY-MM-DD` format
4. Add `decisionMakers` and `owners` using existing team/user IDs where known
5. Use `appliesTo` to link the decision to impacted resources (`service`, `event`, `domain`, `flow`, `data-product`, `entity`, etc.)
6. Use `supersedes`, `supersededBy`, `amends`, `amendedBy`, or `related` when linking ADRs together
7. Structure the body with `Context`, `Decision`, and `Consequences`

### Documenting a Data Product

When a user describes analytics, reporting, BI, ML feature, or derived operational data:

1. Generate `data-products/{DataProductName}/index.mdx` or nest it under the relevant domain/subdomain
2. Add `inputs` for upstream messages, services, containers, channels, or other resources
3. Add `outputs` for produced messages, services, containers, channels, or contracts
4. If an output has a data contract, include `contract.path`, `contract.name`, and `contract.type`
5. Include `<NodeGraph />` and any relevant `<SchemaViewer />` for contract files
6. Document lineage, freshness, ownership, access patterns, and SLAs

### Documenting an Entity

When a user describes a domain model, aggregate, data object, or business concept with properties:

1. Generate `entities/{EntityName}/index.mdx`, `domains/{Domain}/entities/{EntityName}/index.mdx`, or `services/{Service}/entities/{EntityName}/index.mdx` depending on catalog structure
2. Include `identifier` and `aggregateRoot: true` when applicable
3. Add `properties` with `name`, `type`, `required`, and `description`
4. Use `references`, `referencesIdentifier`, and `relationType` for relationships to other entities
5. Include `<EntityPropertiesTable />` in the body to render the property table
6. Link entities from domain/service frontmatter using `entities`

### Documenting a Diagram

When a user provides or asks for a reusable architecture, sequence, flow, or model diagram:

1. Generate `diagrams/{DiagramName}/index.mdx` or nest it under the relevant domain/subdomain
2. Include `id`, `name`, `version`, and `summary`
3. Put the diagram in the body as a fenced `mermaid`, `plantuml`, or other supported diagram block
4. Reference the diagram from related resources using the `diagrams` frontmatter field

### Documenting a Business Flow

When a user describes a multi-step process:

1. Identify distinct steps (user actions, service calls, message exchanges, external systems)
2. Generate the flow `index.mdx` with `steps` array
3. Each step should have `id`, `title`, and appropriate type (`actor`, `service`, `agent`, `message`, `externalSystem`)
4. Connect steps with `next_step` or `next_steps` for branching

### Documenting Channel Routing

When a user describes how messages flow through infrastructure:

1. Generate channel `index.mdx` files with `routes` for channel-to-channel routing
2. Update service or agent `sends`/`receives` with `to`/`from` fields pointing to channels
3. The full picture should show: Service or agent sends → Channel → routes to → Channel → service or agent receives

## Quality Checklist

- Take your time to do this thoroughly
- Quality is more important than speed
- Do not skip validation steps

Before delivering documentation to the user, verify every file against this checklist:

1. Frontmatter has valid YAML between `---` delimiters
2. `id` matches the folder name
3. `version` is a valid semver string
4. `summary` is concise and meaningful (not generic)
5. Message relationships (`sends`/`receives`) include `id`
6. Channel routing (`to`/`from`) references valid channel IDs
7. Body includes `<NodeGraph />` for visualization when the resource has graph relationships
8. Schema references point to real files
9. Folder structure follows catalog conventions
10. No duplicate resources (checked against existing catalog)
11. Versioned resources use `index.mdx` (or match the catalog's existing `.md`/`.mdx` convention); teams and users use `{id}.mdx`; changelogs use `changelog.mdx`/`changelog.md`
12. Every domain has at least one service or agent — never create an empty domain
13. Domain `services` and `agents` frontmatter lists every service and agent that belongs to that domain
14. Domain `entities`, `data-products`, `flows`, and `diagrams` frontmatter lists nested resources when present
15. Every domain has a `ubiquitous-language.mdx` file with relevant domain terms extracted from services, agents, events, commands, entities, data products, and business processes
16. ADRs have a valid status, date, decision makers when known, and `appliesTo` references for impacted resources
17. Data product contract files referenced in `outputs.contract.path` exist when generated
