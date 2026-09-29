#!/usr/bin/env bash
set -euo pipefail

# Usage: ./scripts/release.sh <version>   (e.g. 0.2.0)
# Bumps the version, commits, tags v<version>, and pushes, which triggers the
# Release workflow. Typecheck and tests are omitted: CI validates on push.

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <version>" >&2
  echo "Example: $0 0.2.0" >&2
  exit 1
fi

new_version="$1"

# Strip leading "v" if someone passes "v0.2.0" out of habit
new_version="${new_version#v}"

tag="v${new_version}"

# Ensure we're in the repo root
cd "$(git rev-parse --show-toplevel)"

# Check tag doesn't already exist. npm version commits before tagging, so a
# clashing tag would fail only after stranding a release commit.
if git rev-parse "$tag" >/dev/null 2>&1; then
  echo "Error: tag '$tag' already exists." >&2
  exit 1
fi

# Pull latest from origin so we don't conflict with CI-pushed commits
# (e.g., dist/server.js auto-built on main). No dirty-tree check: this and
# npm version both refuse a dirty tree.
git pull --rebase --quiet origin main

# npm version validates semver, bumps package.json, runs the "version"
# script (syncs .claude-plugin/plugin.json), then commits and tags.
LEFTHOOK=0 npm version "$new_version" -m "chore: release v%s"

# --atomic: a rejected main push must not leave a pushed tag behind.
git push --atomic origin main "$tag"
