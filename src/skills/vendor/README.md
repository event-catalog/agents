# Vendored skills

`catalog-documentation-creator/` is a verbatim copy of the skill of the same name from
[event-catalog/skills](https://github.com/event-catalog/skills), licensed MIT (see `LICENSE`).

- Source commit: `3968cc9444cc89a7a8fd1d94dd632292cc1732a0` (2026-10-26, "Sync skills with EventCatalog 5.6")

Do not edit these files here. Agent-specific rules (running unattended, the pull-request review
workflow) live in `../agent-guidance.md`, which `../load-skill.ts` places in front of this skill's
instructions. Improvements to the general EventCatalog guidance belong upstream.

To update:

```sh
pnpm run skills:sync
```

Then review the diff, run the evals, and update the source commit above.
