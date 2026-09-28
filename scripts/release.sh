#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# Release script for trueline-mcp
#
# Usage: ./scripts/release.sh <version>
#
# Example: ./scripts/release.sh 0.2.0
#
# What it does:
#   1. Validates the version argument and checks for a clean working tree
#   2. Bumps the version in package.json and .claude-plugin/plugin.json
#   3. Commits the version bump
#   4. Tags the commit as v<version>
#   5. Pushes the commit and tag (triggers the Release workflow on CI)
#
# Typecheck and tests are intentionally omitted — CI validates on push.
# =============================================================================

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

# Check for clean working tree
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Error: working tree is dirty. Commit or stash changes first." >&2
  exit 1
fi

# Check tag doesn't already exist. npm version commits before tagging, so a
# clashing tag would fail only after stranding a release commit.
if git rev-parse "$tag" >/dev/null 2>&1; then
  echo "Error: tag '$tag' already exists." >&2
  exit 1
fi

current_version=$(jq -r .version package.json)
echo "Releasing: ${current_version} -> ${new_version}"

# Pull latest from origin so we don't conflict with CI-pushed commits
# (e.g., dist/server.js auto-built on main).
echo ""
echo "==> Syncing with origin/main..."
git pull --rebase --quiet origin main

# npm version validates semver, bumps package.json, runs the "version"
# script (syncs .claude-plugin/plugin.json), then commits and tags.
echo ""
echo "==> Bumping version in package.json and .claude-plugin/plugin.json..."
LEFTHOOK=0 npm version "$new_version" -m "chore: release v%s"

# Push commit and tag
echo ""
echo "==> Pushing commit and tag..."
git push origin main
git push origin "$tag"

echo ""
echo "Done. Tag '$tag' pushed — the Release workflow will create the GitHub release."
