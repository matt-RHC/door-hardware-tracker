#!/usr/bin/env bash
# Vercel "Ignored Build Step" script.
#
# Exit convention (Vercel): exit 0 = SKIP build, exit 1 = PROCEED with build.
# This is not a bug — it's how Vercel's Ignored Build Step is wired.
#
# Rules (first match wins):
#   1. VERCEL_ENV=production               -> always PROCEED
#   2. Missing prev SHA or diff fails      -> PROCEED (fail safe: build)
#   3. Draft PR (requires GITHUB_TOKEN)    -> SKIP
#   4. Every changed file is build-irrelevant -> SKIP
#   5. Otherwise                           -> PROCEED
#
# Build-irrelevant paths (BUILD_IRRELEVANT_REGEX): docs/, prompts/, test-pdfs/,
# tests/, scripts/, .github/, .vscode/, .claude/, top-level *.md, LICENSE,
# .gitignore, .env.example. This list is intentionally conservative — do not
# expand without discussion.

set -uo pipefail

log() { echo "[vercel-ignore-build] $*" >&2; }

PROCEED=1
SKIP=0

# Rule 1: Production deploys always build.
if [[ "${VERCEL_ENV:-}" == "production" ]]; then
  log "VERCEL_ENV=production -> PROCEED"
  exit $PROCEED
fi

CURRENT_SHA="${VERCEL_GIT_COMMIT_SHA:-$(git rev-parse HEAD 2>/dev/null || true)}"
PREV_SHA="${VERCEL_GIT_PREVIOUS_SHA:-}"

if [[ -z "$CURRENT_SHA" ]]; then
  log "No current SHA -> PROCEED (fail safe)"
  exit $PROCEED
fi

if [[ -z "$PREV_SHA" ]]; then
  log "No VERCEL_GIT_PREVIOUS_SHA -> PROCEED (fail safe)"
  exit $PROCEED
fi

# Make sure both commits are available locally (Vercel usually does a shallow clone).
git cat-file -e "$PREV_SHA^{commit}" 2>/dev/null || git fetch --depth=50 origin "$PREV_SHA" 2>/dev/null || true
git cat-file -e "$CURRENT_SHA^{commit}" 2>/dev/null || true

CHANGED_FILES="$(git diff --name-only "$PREV_SHA" "$CURRENT_SHA" 2>/dev/null || true)"

if [[ -z "$CHANGED_FILES" ]]; then
  log "Empty diff between $PREV_SHA..$CURRENT_SHA -> PROCEED (fail safe)"
  exit $PROCEED
fi

log "Changed files:"
echo "$CHANGED_FILES" | sed 's/^/  /' >&2

# Rule 3: Draft PR detection (best-effort; requires GITHUB_TOKEN).
PR_REF="${VERCEL_GIT_PULL_REQUEST_ID:-}"
REPO_OWNER="${VERCEL_GIT_REPO_OWNER:-}"
REPO_SLUG="${VERCEL_GIT_REPO_SLUG:-}"
if [[ -n "${GITHUB_TOKEN:-}" && -n "$PR_REF" && -n "$REPO_OWNER" && -n "$REPO_SLUG" ]]; then
  PR_API="https://api.github.com/repos/${REPO_OWNER}/${REPO_SLUG}/pulls/${PR_REF}"
  PR_JSON="$(curl -fsSL -H "Authorization: Bearer ${GITHUB_TOKEN}" \
    -H "Accept: application/vnd.github+json" "$PR_API" 2>/dev/null || true)"
  if [[ -n "$PR_JSON" ]]; then
    IS_DRAFT="$(echo "$PR_JSON" | grep -o '"draft"[[:space:]]*:[[:space:]]*true' || true)"
    if [[ -n "$IS_DRAFT" ]]; then
      log "PR #${PR_REF} is a draft -> SKIP"
      exit $SKIP
    fi
    log "PR #${PR_REF} is not a draft"
  else
    log "Could not fetch PR metadata -> continuing with path check"
  fi
fi

# Rule 4: Build-irrelevant-path check.
BUILD_IRRELEVANT_REGEX='^(docs/|prompts/|test-pdfs/|tests/|scripts/|\.github/|\.vscode/|\.claude/|[^/]+\.md$|LICENSE$|\.gitignore$|\.env\.example$)'

RELEVANT=""
while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  if ! [[ "$f" =~ $BUILD_IRRELEVANT_REGEX ]]; then
    RELEVANT+="$f"$'\n'
  fi
done <<< "$CHANGED_FILES"

if [[ -z "$RELEVANT" ]]; then
  log "All changed files are build-irrelevant -> SKIP"
  exit $SKIP
fi

log "Build-relevant files changed:"
echo "$RELEVANT" | sed 's/^/  /' >&2
log "-> PROCEED"
exit $PROCEED
