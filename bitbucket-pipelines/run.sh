#!/usr/bin/env bash
# EventCatalog Agents for Bitbucket Pipelines: runs one agent on a Bitbucket Cloud pull request. The
# Bitbucket counterpart of the GitHub Action (action.yml) and the Azure Pipelines template. Setup guides:
# https://www.eventcatalog.dev/docs/development/agents/set-up-code-to-docs/bitbucket (and the matching
# pages for set-up-breaking-changes and set-up-adr-compliance).
#
#   - step:
#       name: EventCatalog Breaking Changes
#       image: node:24
#       clone:
#         depth: full
#       script:
#         - git clone --quiet --depth 1 --branch v2 https://github.com/event-catalog/agents.git /tmp/eventcatalog-agents
#         - /tmp/eventcatalog-agents/bitbucket-pipelines/run.sh breaking-changes --catalog-repo acme/eventcatalog
#
# usage:start
# Options (all but the agent are optional, except --catalog-repo, and --adrs for adr-compliance):
#   <agent>                    code-to-docs, breaking-changes or adr-compliance
#   --catalog-repo <repo>      the EventCatalog repository: `workspace/repo` (or `repo` in this workspace),
#                              or its URL. For a catalog on GitHub, `owner/repo` with --catalog-provider github.
#   --catalog-ref <branch>     the catalog branch to read and open documentation pull requests against (main)
#   --catalog-provider <host>  where the catalog is hosted: bitbucket, github or azure-devops (bitbucket)
#   --catalog-url <url>        your hosted EventCatalog, for links in comments
#   --model <model>            the model, such as anthropic/claude-sonnet-4-6. See https://pi.dev/models
#   --adrs <globs>             adr-compliance: comma-separated globs, from the catalog root, selecting the ADRs
#   --ignore-paths <paths>     comma-separated paths or globs to leave out of the review
#   --schema-extensions <exts> comma-separated extensions breaking-changes treats as message schemas
#   --source-dir <path>        the source checkout to diff ($BITBUCKET_CLONE_DIR)
#
# Tokens and keys come from secured repository (or workspace) variables, never from options:
#   EVENTCATALOG_BITBUCKET_TOKEN  an access token for this repository, with Pull requests: Write
#   EVENTCATALOG_CATALOG_TOKEN    a token for the catalog repository, if EVENTCATALOG_BITBUCKET_TOKEN can't reach it
#   ANTHROPIC_API_KEY (or OPENAI_API_KEY, OPENROUTER_API_KEY, …) for your model provider
# usage:end
#
# A branch pipeline reviews the pull request that merged as its commit. A scheduled pipeline is skipped
# when the token can read what started it (Pipelines: Read); otherwise it reviews that pull request again.

set -euo pipefail

AGENTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  sed -n '/^# usage:start$/,/^# usage:end$/p' "${BASH_SOURCE[0]}" | sed '1d;$d' | sed 's/^# \{0,1\}//' >&2
  exit 2
}

agent="${1:-}"
case "$agent" in
  code-to-docs | breaking-changes | adr-compliance) shift ;;
  *)
    echo "[eventcatalog] The first argument must be the agent to run: code-to-docs, breaking-changes or adr-compliance." >&2
    usage
    ;;
esac

export EVENTCATALOG_WORKSPACE="${BITBUCKET_CLONE_DIR:-$PWD}"
export EVENTCATALOG_CATALOG_PATH=eventcatalog

while [ $# -gt 0 ]; do
  option="$1"
  value=""
  case "$option" in
    --*=*)
      value="${option#*=}"
      option="${option%%=*}"
      ;;
    --*)
      if [ $# -lt 2 ]; then
        echo "[eventcatalog] $option needs a value." >&2
        usage
      fi
      value="$2"
      shift
      ;;
    *)
      echo "[eventcatalog] Unexpected argument: $option" >&2
      usage
      ;;
  esac
  shift

  case "$option" in
    --catalog-repo) export EVENTCATALOG_CATALOG_REPO="$value" ;;
    --catalog-ref) export EVENTCATALOG_CATALOG_REF="$value" ;;
    --catalog-provider) export EVENTCATALOG_CATALOG_PROVIDER="$value" ;;
    --catalog-url) export EVENTCATALOG_CATALOG_URL="$value" ;;
    --model) export EVENTCATALOG_MODEL="$value" ;;
    --adrs) export EVENTCATALOG_ADRS="$value" ;;
    --ignore-paths) export EVENTCATALOG_IGNORE_PATHS="$value" ;;
    --schema-extensions) export EVENTCATALOG_SCHEMA_EXTENSIONS="$value" ;;
    # Relative to where the step runs, not the agents checkout this script changes into.
    --source-dir)
      EVENTCATALOG_WORKSPACE="$(cd "$value" 2> /dev/null && pwd)" || {
        echo "[eventcatalog] --source-dir: no such directory: $value" >&2
        exit 2
      }
      ;;
    *)
      echo "[eventcatalog] Unknown option: $option" >&2
      usage
      ;;
  esac
done

if [ -z "${EVENTCATALOG_CATALOG_REPO:-}" ]; then
  echo "[eventcatalog] --catalog-repo is required: your EventCatalog repository, such as acme/eventcatalog." >&2
  exit 2
fi

if ! command -v node > /dev/null || [ "$(node -p 'const [major, minor] = process.versions.node.split(".").map(Number); major > 22 || (major === 22 && minor >= 19)')" != true ]; then
  echo "[eventcatalog] EventCatalog Agents need Node.js 22.19 or later. Run the step in the node:24 image." >&2
  exit 1
fi

cd "$AGENTS_DIR"
echo "[eventcatalog] Installing EventCatalog Agents ($(git -C "$AGENTS_DIR" describe --tags --always 2> /dev/null || echo unknown))" >&2
command -v pnpm > /dev/null || npm install --global --silent pnpm@11
pnpm install --prod=false --frozen-lockfile --reporter=silent

pnpm exec tsx src/checkout-catalog.ts
# The agent reads its settings from the EVENTCATALOG_* variables and the Bitbucket Pipelines default
# variables (see src/config.ts), so it needs no payload.
pnpm exec tsx src/run.ts "$agent"
