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
#   2. Runs typecheck and tests
#   3. Bumps the version in package.json and .claude-plugin/plugin.json
#   4. Commits the version bump
#   5. Tags the commit as v<version>
#   6. Pushes the commit and tag (triggers the Release workflow on CI)
# =============================================================================

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <version>" >&2
  echo "Example: $0 0.2.0" >&2
  exit 1
fi

new_version="$1"

# Strip leading "v" if someone passes "v0.2.0" out of habit
new_version="${new_version#v}"

# Validate semver format (major.minor.patch, optional pre-release)
if ! [[ "$new_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?$ ]]; then
  echo "Error: '$new_version' is not valid semver (expected X.Y.Z)" >&2
  exit 1
fi

tag="v${new_version}"

# Ensure we're in the repo root
cd "$(git rev-parse --show-toplevel)"

# Check for clean working tree
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Error: working tree is dirty. Commit or stash changes first." >&2
  exit 1
fi

# Check tag doesn't already exist
if git rev-parse "$tag" >/dev/null 2>&1; then
  echo "Error: tag '$tag' already exists." >&2
  exit 1
fi

current_version=$(jq -r .version package.json)
echo "Releasing: ${current_version} -> ${new_version}"

# Run checks before touching anything
echo ""
echo "==> Running typecheck..."
bun run typecheck

echo ""
echo "==> Running tests..."
bun test

# Bump version in both files
echo ""
echo "==> Bumping version in package.json and .claude-plugin/plugin.json..."

tmp=$(mktemp)
jq --arg v "$new_version" '.version = $v' package.json > "$tmp" && mv "$tmp" package.json
tmp=$(mktemp)
jq --arg v "$new_version" '.version = $v' .claude-plugin/plugin.json > "$tmp" && mv "$tmp" .claude-plugin/plugin.json

# Commit and tag
git add package.json .claude-plugin/plugin.json
LEFTHOOK=0 git commit -m "chore: release v${new_version}"
git tag "$tag"

# Push
echo ""
echo "==> Pushing commit and tag..."
git push
git push origin "$tag"

echo ""
echo "Done. Tag '$tag' pushed — the Release workflow will create the GitHub release."
