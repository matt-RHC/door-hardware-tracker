#!/usr/bin/env bash
#
# vercel-ignore-build.sh
#
# Vercel "Ignored Build Step" for door-hardware-tracker.
#
# Vercel invokes this script for every commit. Exit code:
#   0  → skip the build (no deployment created)
#   1  → proceed with the build (deployment runs)
#
# Rules, in priority order:
#   1. Always build production (main).
#   2. Skip preview builds for draft PRs (WIP branches push many times; we
#      only care about them when the author marks "Ready for review").
#   3. Skip the build if every file in the diff matches a path in the
#      BUILD_IRRELEVANT allowlist (docs, tests, prompts, markdown, etc.).
#   4. Otherwise, build.
#
# Why this exists: Vercel bills per build minute. Docs-only and test-only
# commits previously triggered full Next.js builds that produced an
# identical deployed artifact. See team cost-control notes in
# docs/ANTHROPIC_COST_CONTROLS.md (Vercel-side analog).
#
# Usage in Vercel: Project → Settings → Git → "Ignored Build Step" →
#   bash scripts/vercel-ignore-build.sh
#
# Local test:
#   VERCEL_GIT_COMMIT_REF=chore/docs-only bash scripts/vercel-ignore-build.sh

set -euo pipefail

# -----------------------------------------------------------------------------
# Environment (provided by Vercel at build time)
# -----------------------------------------------------------------------------
# VERCEL_GIT_COMMIT_REF          — branch name
# VERCEL_GIT_PREVIOUS_SHA        — last deployed commit on this branch/project
# VERCEL_GIT_PULL_REQUEST_ID     — set if commit is associated with a PR
# VERCEL_ENV                     — "production" | "preview" | "development"
# See: https://vercel.com/docs/deployments/configure-a-build#ignored-build-step
# -----------------------------------------------------------------------------

BRANCH="${VERCEL_GIT_COMMIT_REF:-}"
PREV_SHA="${VERCEL_GIT_PREVIOUS_SHA:-}"
VERCEL_ENV_VAL="${VERCEL_ENV:-preview}"

log() { echo "[ignore-build] $*"; }

# -----------------------------------------------------------------------------
# Rule 1 — always build production
# -----------------------------------------------------------------------------
if [[ "$VERCEL_ENV_VAL" == "production" ]]; then
  log "Production build — proceed."
  exit 1
fi

# -----------------------------------------------------------------------------
# Rule 2 — skip draft PRs
# -----------------------------------------------------------------------------
# Vercel does not expose draft status directly. We use the GitHub API if a
# token is available; otherwise we fall through (don't skip).
if [[ -n "${VERCEL_GIT_PULL_REQUEST_ID:-}" && -n "${GITHUB_TOKEN:-}" ]]; then
  REPO_SLUG="${VERCEL_GIT_REPO_OWNER:-}/${VERCEL_GIT_REPO_SLUG:-}"
  if [[ "$REPO_SLUG" != "/" ]]; then
    DRAFT=$(curl -s -H "Authorization: Bearer ${GITHUB_TOKEN}" \
      "https://api.github.com/repos/${REPO_SLUG}/pulls/${VERCEL_GIT_PULL_REQUEST_ID}" \
      | grep -o '"draft":[[:space:]]*true' || true)
    if [[ -n "$DRAFT" ]]; then
      log "PR #${VERCEL_GIT_PULL_REQUEST_ID} is a draft — skip."
      exit 0
    fi
  fi
fi

# -----------------------------------------------------------------------------
# Rule 3 — skip if every changed file is build-irrelevant
# -----------------------------------------------------------------------------
# Files/paths that DO NOT affect the deployed artifact. Keep this list
# conservative — when in doubt, build. A missed skip costs minutes; a
# wrong skip ships stale code.
BUILD_IRRELEVANT_REGEX='^(docs/|prompts/|test-pdfs/|tests/|scripts/|\.github/|\.vscode/|\.claude/|[^/]+\.md$|LICENSE$|\.gitignore$|\.env\.example$|AGENTS\.md$|CLAUDE\.md$|README\.md$)'

# Determine the diff range. If we have no previous SHA (first deploy on a
# new branch), build to be safe.
if [[ -z "$PREV_SHA" ]]; then
  log "No previous deploy SHA — proceed (safe default)."
  exit 1
fi

# Fetch the previous SHA so the diff resolves. Vercel uses a shallow clone.
if ! git cat-file -e "$PREV_SHA" 2>/dev/null; then
  git fetch --depth=50 origin "$PREV_SHA" 2>/dev/null || {
    log "Could not fetch previous SHA $PREV_SHA — proceed."
    exit 1
  }
fi

CHANGED_FILES=$(git diff --name-only "$PREV_SHA" HEAD || true)

if [[ -z "$CHANGED_FILES" ]]; then
  log "No file changes detected — skip."
  exit 0
fi

# If any file does NOT match the irrelevant regex, build.
RELEVANT=$(echo "$CHANGED_FILES" | grep -Ev "$BUILD_IRRELEVANT_REGEX" || true)

if [[ -z "$RELEVANT" ]]; then
  log "All ${CHANGED_FILES//$'\n'/ } changed files are build-irrelevant — skip."
  exit 0
fi

log "Build-relevant changes detected:"
echo "$RELEVANT" | sed 's/^/  /'
log "Proceed with build."
exit 1
