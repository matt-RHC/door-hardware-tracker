<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Agent Rules for Door Hardware Tracker

## Before You Write Code

1. **Read CLAUDE.md first.** It contains the Turbopack TS rules, git workflow, and architecture context that will save you from known pitfalls.
2. **Check the last plan's status.** If there's an unmerged plan or open bug fix, work on THAT — do not start new work.
3. **One thing at a time.** Fix one bug, test it, merge it, then move on. Do not batch multiple fixes into one session.

## Code Quality

- **TypeScript:** Always use `?.`, `??`, and `?? []` for nullable access. Turbopack will reject `&&` guards and `if` narrowing patterns that tsc accepts. See CLAUDE.md for the full list.
- **No placeholder code.** Every feature must work end-to-end before moving on. No TODOs in production code.
- **Test against golden PDFs.** Any change to the extraction pipeline must be tested against the 15 benchmark PDFs in `test-pdfs/training/` (grid, schedule, kinship, mixed formats).

## Punchy AI Review Architecture

The extraction pipeline uses a multi-pass AI review system called **Punchy** — a senior DFH consultant persona that reviews extraction results at 3 checkpoints. See CLAUDE.md "Punchy AI Review Layer" section for full details.

When modifying extraction pipeline code:
- **Punchy prompts** live in `src/lib/punchy-prompts.ts` — update these when adding new domain knowledge or changing extraction behavior
- **Checkpoint functions** are in `chunk/route.ts` and `route.ts` — `callPunchyPostExtraction()`, `callPunchyColumnReview()`, `callPunchyQuantityCheck()`
- **Types** in `src/lib/types/index.ts` — `PunchyObservation`, `PunchyCorrections`, `PunchyColumnReview`, `PunchyQuantityCheck`
- **Confidence scoring** — every Punchy observation must include high/medium/low confidence
- **API responses** now include `punchyObservations` and `punchyQuantityCheck` fields

## User Interaction

- **Ask, don't guess.** If you're uncertain about a field mapping, consultant convention, or user intent — ask. Interactive confirmation is always better than silent wrong answers.
- **Keep UI status clean.** Progress/loader messages should be short and ambient (under ~40 chars). Never dump raw extraction data (set IDs, door number lists, page ranges) into visual components. Debug info goes in console logs.
- **Propagate-edit pattern.** When a user corrects one item, check for matching items across openings and offer to propagate the fix.

## Git Operations

Git operations run directly in the working directory. See CLAUDE.md for git identity config and branch conventions.

## Session Discipline

- Each session should produce either (a) merged code with a test, or (b) a single focused prompt that will produce merged code.
- If a session only produced documents and no code, flag that as a problem in the audit log.
- Clean up at end of session: archive stale files, remove loose artifacts from repo root.

## Tracking Items (cross-session state)

All plan items, session logs, and metric runs live in the `tracking_items` Supabase table. Read at session start, update at session end. The three legacy Smartsheet sheets (4722023373688708, 1895373728599940, 2206493777547140) are **retired** — do not read from or write to them.

**CLI** (requires `.env.local` with `NEXT_PUBLIC_SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`):

```
npm run tracking -- list                              # all items
npm run tracking -- list --type plan_item --status Open  # open plan items only
npm run tracking -- add-item --title "..." --priority "P2 - Medium" --area "API" --description "..."
npm run tracking -- update-item <uuid> --status Done --resolved-pr 110
npm run tracking -- add-session --session-id S-087 --topics "..." --status complete
npm run tracking -- add-metric --session-id S-087 --pdf small.pdf --doors-exp 104 --doors-ext 104
```

**Fallback** (cloud sandbox without `.env.local`): ask user for `/admin/tracking` paste, or compose SQL for Supabase Studio.

See CLAUDE.md "Session Protocol" for the full read/write rules.

## Output Transparency (MANDATORY)

End every response with a clear status block:

```
DONE: [what was actually changed and verified]
PLANNED (not done): [what was discussed but not yet implemented]
NOTICED BUT DID NOT TOUCH: [issues seen but out of scope — or "None"]
SHADOW CHANGES: [any unrequested changes made — or "None"]
```

- Use past tense ONLY for completed work. Use future tense for plans.
- Never silently fix issues you weren't asked about. Report them, then ask.
- If zero files changed, say "No files were modified."
- Commit messages describe ONLY what the commit contains — not future plans.
