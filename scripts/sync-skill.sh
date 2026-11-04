#!/usr/bin/env bash
# Replaces src/skills/vendor/catalog-documentation-creator with the latest copy from
# github.com/event-catalog/skills. Review the diff, re-run the evals, then update the commit
# recorded in src/skills/vendor/README.md.
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
vendor_dir="$repo_root/src/skills/vendor"
ref="${1:-main}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

git clone --quiet --depth 1 --branch "$ref" https://github.com/event-catalog/skills.git "$tmp/skills"

rm -rf "$vendor_dir/catalog-documentation-creator"
cp -R "$tmp/skills/skills/catalog-documentation-creator" "$vendor_dir/"
cp "$tmp/skills/LICENSE" "$vendor_dir/LICENSE"

echo "Synced catalog-documentation-creator from event-catalog/skills@$(git -C "$tmp/skills" rev-parse HEAD)"
