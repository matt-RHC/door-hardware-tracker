# Template — Dispatch Prompt Header

Use this as the first block of any dispatch prompt that a fresh Claude Code session will run. The scoping clause prevents the pattern where dispatched sessions aggressively clean up files outside their task — something we've hit twice in the redesign workflow.

---

## Paste this header verbatim at the top of every dispatch prompt

```
Working directory: ~/Code/TrackDoorHardware/door-hardware-tracker/

SCOPE CONSTRAINT — READ FIRST.
You may only read, write, create, or delete files inside this subdirectory:
  <FILL IN the exact path, e.g., design/data-samples/>

Do NOT modify, archive, delete, or run `git clean` / `rm -rf` on any file outside
that subdirectory — including other files in design/, docs at the repo root, source
code, or anything in node_modules or .next. If you notice stale-looking files
outside your scope, flag them in your final report instead of touching them.
Assume other sessions or the user are actively working on everything else.

Before ending the session: run `ls -la design/` and confirm only your subdirectory
was modified. If other entries disappeared, STOP and report — do not attempt to
"fix" it; call it out.
```

## Then describe the task below this header

After the header, write the task-specific instructions (what to do, what to produce, where to save, how to report).

## Why this exists

Without the scope constraint, dispatched sessions inherit [AGENTS.md](../../AGENTS.md)'s Session Discipline directives ("clean up stale files, remove loose artifacts") and interpret files they didn't create as cleanup candidates. The `design/` folder has lost 10+ files twice to this pattern. The constraint above over-rides the inheritance for each dispatch.

The durable fix is in AGENTS.md itself (cleanup clause now scoped to "files you created" with an explicit `design/` exception), but keep this header in every dispatch prompt for belt-and-suspenders.
