# EventCatalog Agents

AI agents that keep your [EventCatalog](https://www.eventcatalog.dev) in sync with your code, and
review your pull requests against it. They run in your own CI, in **GitHub Actions**, **Azure
Pipelines** or **Bitbucket Pipelines**, with the model provider and key you choose.

![ADR Compliance commenting on a pull request](docs/images/github-adr-compliance.png)

## Agents

### Code-to-Docs

Updates your catalog when a pull request changes your architecture, and opens a pull request in your
catalog for your team to review.

[Introduction](https://www.eventcatalog.dev/docs/development/agents/set-up-code-to-docs) ·
[Set up with GitHub](https://www.eventcatalog.dev/docs/development/agents/set-up-code-to-docs/github) ·
[Set up with Azure DevOps](https://www.eventcatalog.dev/docs/development/agents/set-up-code-to-docs/azure-devops) ·
[Set up with Bitbucket](https://www.eventcatalog.dev/docs/development/agents/set-up-code-to-docs/bitbucket)

### Breaking Changes

Warns on a pull request when a schema change would break a consumer documented in your catalog, and
lists the consumers and their owners.

[Introduction](https://www.eventcatalog.dev/docs/development/agents/set-up-breaking-changes) ·
[Set up with GitHub](https://www.eventcatalog.dev/docs/development/agents/set-up-breaking-changes/github) ·
[Set up with Azure DevOps](https://www.eventcatalog.dev/docs/development/agents/set-up-breaking-changes/azure-devops) ·
[Set up with Bitbucket](https://www.eventcatalog.dev/docs/development/agents/set-up-breaking-changes/bitbucket)

### ADR Compliance

Checks the code in a pull request against the architecture decisions (ADRs) in your catalog, and
comments when it conflicts with one.

[Introduction](https://www.eventcatalog.dev/docs/development/agents/set-up-adr-compliance) ·
[Set up with GitHub](https://www.eventcatalog.dev/docs/development/agents/set-up-adr-compliance/github) ·
[Set up with Azure DevOps](https://www.eventcatalog.dev/docs/development/agents/set-up-adr-compliance/azure-devops) ·
[Set up with Bitbucket](https://www.eventcatalog.dev/docs/development/agents/set-up-adr-compliance/bitbucket)

## Development

This project uses [pnpm](https://pnpm.io) and Node.js 22.19 or later. Run `pnpm install`, then
`pnpm test` to build, typecheck and run the evals. See [`AGENTS.md`](AGENTS.md) for the project layout
and [`evals/README.md`](evals/README.md) for how the agents are evaluated.

## License

This project is source-available under the [Business Source License 1.1](LICENSE). You can read,
modify and contribute to the code, and use it for evaluation, development and testing. **Production
use requires a commercial EventCatalog license**: contact hello@eventcatalog.dev. Each release converts
to the Apache License 2.0 four years after it is published.
