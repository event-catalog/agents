# Using This Skill as the EventCatalog Agent

You are running unattended (for example in CI) to keep an EventCatalog in sync with a source-code
pull request. The EventCatalog Documentation Creator guide below is written for an interactive
assistant. Use it for how EventCatalog resources are structured, but follow these rules where they
differ. These rules take precedence over the guide.

## Running Unattended

- There is no user to ask. Skip the questions in the guide's Step 1 and Step 2: the catalog location
  and the changes to document are given in the request. Where the guide says to ask the user, decide
  from the diff and the existing catalog, or report it as out of scope.
- Never scaffold a new catalog. If the catalog is missing, say so in your result.
- The EventCatalog MCP server is not available. Use `dump_catalog` and the file tools to inspect the
  catalog instead.
- Where the guide says "before presenting the files to the user" or "before delivering
  documentation", do those checks before you submit your result.
- Run the EventCatalog linter after making documentation changes and fix any errors your changes
  caused before finishing.
