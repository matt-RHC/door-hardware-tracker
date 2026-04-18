# Handoff: Attention-First Review (Rabbit Hole)

## Overview

This is the post-ingest **review screen** for Rabbit Hole's hardware-schedule pipeline. After the OCR/LLM ingest pass runs over a submittal PDF, the user lands here to resolve the parser's unresolved and low-confidence fields before the schedule can be exported.

The design's core idea is **attention-first**: instead of showing a flat table of every opening and asking the reviewer to hunt for problems, the screen groups openings by *why they need attention* (finish conflict, electrified hardware mismatch, LC nomenclature, rod-length violation on rated pairs, etc.) and lets the reviewer resolve a whole group at once with a single value — with a per-door fallback when the group isn't actually homogeneous.

Two complementary views share the same underlying data and modal:

- **Door view (default)** — rows grouped by RFI/issue cluster ("RFI #1 — Finish conflict 626 vs 630").
- **Set view** — same rows regrouped by `hw_set` (hardware set), useful when the reviewer is thinking in terms of hardware sets rather than issues.

The right rail shows the source submittal PDF, kept in sync with whichever opening the user is currently focused on.

---

## About the Design Files

The files in this bundle are **design references created in HTML** — a clickable prototype showing intended look, layout, state transitions, and interaction model. They are **not production code to copy directly**.

Your task is to **recreate this design in Rabbit Hole's existing codebase** (Next.js / React / TypeScript, based on the `src/app/globals.css` reference in the prototype's token block) using its established component library, routing, state management, and data layer. Where this document specifies exact colors, spacing, and typography, match those values against the tokens already in `globals.css` and prefer the codebase's names over the ones in this doc.

Do not re-implement the seeded `DOORS` object — wire the real schedule-review API in its place. The seed data in the prototype is illustrative only.

---

## Fidelity

**High-fidelity.** Final colors, typography, spacing, component shapes, and interaction flows are all locked. The developer should rebuild this pixel-close using the codebase's existing primitives (buttons, modals, tooltips, etc.) and the tokens already defined in `globals.css`. If the prototype and the existing tokens disagree on a specific hex value, trust the codebase's tokens.

Interactions (modal stepper, draw-to-capture banner, rule-save scoping, view toggle, theme toggle, soft-flag disclosure) are all implemented in the prototype and should be recreated faithfully.

---

## Screens / Views

There is **one screen** — the Review page — with two view modes and several overlays.

### Top-level layout

```
┌────────────────────────────────────────────────────────────────────────┐
│  Navbar (sticky, height ~52px)                                         │
│  [logo] [file/submittal label] [view toggle] …… [save-status] [theme] │
├───────────────────────────────────┬────────────────────────────────────┤
│                                   │                                    │
│  Main column (flex: 1 1 auto)     │  Rail (width: 420px, sticky)       │
│                                   │                                    │
│   page-head                       │   rail-head (Source · PDF)         │
│   progress-bar + gate copy        │                                    │
│   group-card (×N)                 │   pdf-rows                         │
│   group-card                      │   (thumbnail + opening + hw_set,   │
│   …                               │    active row highlighted,         │
│   wizard-nav (scrolls w/ page)    │    group hover-highlight bloom)    │
│                                   │                                    │
└───────────────────────────────────┴────────────────────────────────────┘
```

- `page` container: `display: flex; gap: 0; max-width: 1800px; margin: 0 auto;`
- `main`: `flex: 1 1 auto; padding: 28px 28px 0; min-width: 0;`
- `aside.rail`: `flex: 0 0 420px; border-left: 1px solid var(--border); position: sticky; top: 52px; height: calc(100vh - 52px); overflow: hidden;` — rail scrolls independently inside itself.
- Navbar is sticky (`position: sticky; top: 0; z-index: 40`).
- **Wizard nav (bottom bar) scrolls with the page** — it is NOT sticky. Do not make it fixed or sticky; earlier iterations did and it blocked content.

---

### Navbar

Left → right, all vertically centered, gap 20px:

1. **Brand** — "RABBIT·HOLE" in `--font-display` (Orbitron, 600, 14px, letter-spacing 0.12em). The `·` dot is `color: var(--orange)`.
2. **File chip** — mono label like `Submittal 4 · Job #306169`, 12px, `color: var(--text-secondary)`, separated from the brand by a 1px vertical divider (`border-left: 1px solid var(--border); padding-left: 20px;`).
3. **View toggle** (segmented control): `[ Door view ][ Set view ]`. Pill-shaped, inline bg `var(--surface-raised)`, 1px border, 2px inner padding; active segment has `background: var(--surface); box-shadow: 0 0 0 1px var(--border);`. 12px text, 500 weight.
4. **Spacer** — `flex: 1`.
5. **Save status** — small right-aligned text: default `"Saved just now"`, flashes `"Saving…"` on apply, then `"Saved just now"` after ~600ms. 11px, `--text-tertiary`, mono.
6. **Theme toggle** — icon-only ghost button, toggles `data-theme` on `<html>` between `light` and `dark`. Persist to `localStorage('rh-theme')`.

### Page head

Inside `main`, above the progress bar:

- `eyebrow` — "Submittal 4 · Job #306169 · MJW / DPR · March 20, 2026" — 11px, mono, `--text-tertiary`, letter-spacing 0.08em, uppercase.
- `h1` — "Review what needs your attention." — `--font-display` Orbitron, 600, 28px, `--text-primary`, line-height 1.15.
- `lede` — "Rabbit Hole imported 312 openings from the submittal. **14 openings** across **6 issues** need a call before we can export. We grouped them so one decision resolves many." — 14px, `--text-secondary`. Numbers wrapped in `<strong>` and colored `--text-primary`. Actual numbers come from `state.groups` — render live.

### Progress + gate

Just above the first group card:

- A 6px-tall progress bar, `background: var(--surface-hover); border-radius: 3px; overflow: hidden`. Filled portion is `background: var(--green)`, width = `(clearedGroups / totalNonSoftGroups) * 100%`.
- Below the bar, left-aligned: `"4 of 6 issues resolved"` (12px, `--text-secondary`).
- Right-aligned on the same row: the **Export gate pill** — when `cleared < total`, show `"Export blocked · 2 issues open"` in `--red` text on `--red-dim` background, pill-shaped, 11px. When all resolved, flip to `"Ready to export"` in `--green` on `--green-dim`.

### Group card (the primary unit)

Each issue cluster is a `<section class="group">`. Severity determines the accent color:

| Severity | Accent token | Dot color | Card left border | Usage |
|---|---|---|---|---|
| `high` | `--red` | red | 3px solid `--red` | Missing data that will fail the export (rod length, LC nomen, etc.) |
| `med` | `--orange` | orange | 3px solid `--orange` | Conflicts the reviewer must resolve but the export can accept a default (finish conflict) |
| `soft` | `--yellow` | yellow | 3px solid `--yellow` | Advisory — hidden by default; reveals under the "Show soft flags" toggle |

Card structure:

```
┌────────────────────────────────────────────────────────────────┐
│ ● High priority · RFI #1                           [ 0 / 3 ]   │  ← header (clickable; expands body)
│ Finish conflict — 626 vs 630                                    │
│ 3 openings · DH1-10, DH1-9, AD4                                 │
├────────────────────────────────────────────────────────────────┤
│ ▸ Darrin says (the "rationale" disclosure, collapsed)           │
│                                                                 │
│ Opening table — one row per door in this group                  │
│   on · hw_set · heading · location · [confidence chiclets] · ⋯  │
│                                                                 │
│ Actions row:                                                    │
│   [ Fix all 3 ]  [ Mark N/A ]  [ Dismiss group ]                │
└────────────────────────────────────────────────────────────────┘
```

Card CSS:
- `background: var(--surface); border: 1px solid var(--border); border-left-width: 3px; border-radius: var(--radius) /* 6px */; margin-bottom: 12px; overflow: hidden;`
- Header `padding: 14px 16px; display: flex; gap: 12px; align-items: baseline; cursor: pointer;`
- Severity dot: `width: 8px; height: 8px; border-radius: 50%; background: var(--red|--orange|--yellow);`
- Count chip right-aligned: `font-family: var(--font-mono); font-size: 11px; padding: 2px 8px; border-radius: 10px; background: var(--surface-hover); color: var(--text-secondary);` — turns green when `cleared === total`.

Opening rows inside the group:
- `display: grid; grid-template-columns: 120px 100px 90px 1fr 200px 40px; gap: 12px; padding: 10px 16px; border-top: 1px solid var(--border-dim); align-items: center;`
- Columns: `on` (mono, 13px, primary), `hw_set` (mono, 12px, secondary), `heading` (mono, 12px, tertiary), `location` (13px, secondary, truncate with ellipsis), **confidence strip**, ellipsis menu.
- Cleared rows get `opacity: 0.55` and a green check glyph (`✓`) replacing the trailing ellipsis.

### Confidence strip

Inline row of small chiclets, one per field that has a confidence value on this door. Each chiclet:
- `display: inline-flex; align-items: center; gap: 4px; padding: 2px 6px; border-radius: 3px; font-family: var(--font-mono); font-size: 10px;`
- Field name abbreviated (`hw_set` → `HW`, `door_type` → `TYP`, `frame_type` → `FRM`, `hand` → `HND`, `finish` → `FIN`, `electrified` → `ELE`, `lc_nomen` → `LC`, `rod_len` → `ROD`, `fire_rating` → `FR`).
- Color by confidence: `>= .85` → `--green` text on `--green-dim` bg; `.6–.85` → `--orange` on `--orange-dim`; `< .6` → `--red` on `--red-dim`.
- Hovering a low-confidence chiclet shows the tooltip: "Parser confidence 38% · click to review." Click opens the same modal stepper as "Fix one" on that row.

### Disclosure ("Darrin says")

Collapsed by default. Heading row is a button:
- `▸` caret (rotates to `▾` when open, 150ms transform)
- Label: **"Darrin says"** — 11px, semibold, `--text-primary`. (Darrin is the project-manager persona giving the rationale.)

Body (when open): italic 13px paragraph in `--text-secondary`, with any referenced identifiers (hw_set codes, opening numbers) wrapped in `<code>` styled as mono, 12px, `--text-primary`, background `--tint`, padding `1px 4px`, radius 3px.

### Group actions

Bottom strip of the card, `padding: 12px 16px; border-top: 1px solid var(--border-dim); background: var(--surface-raised); display: flex; gap: 8px;`

- **Primary** — `Fix all N` — solid button, `background: var(--text-primary); color: var(--surface);` 13px, 500 weight, 8/14 padding. Opens the modal in **bulk mode**.
- **Secondary** — `Mark N/A` — ghost button (transparent bg, 1px `--border`, `--text-secondary` text). Opens a confirm and sets `field = "N/A"` on all doors in the group.
- **Tertiary** — `Dismiss group` — text-only link, `--text-tertiary`, 12px. Used when the reviewer decides the cluster was a false alarm.

A trailing soft-warn span appears when there's a caveat (e.g. "Heads up: 1 door in this group still has a secondary open field") — 12px, `--orange`, with a `⚠` glyph.

### Wizard nav (bottom, scrolls with page)

```
┌───────────────────────────────────────────────────────────────┐
│ [ ← Back to import ]              [ Export schedule → ]       │
└───────────────────────────────────────────────────────────────┘
```

- `margin: 40px -28px 0; padding: 14px 28px; background: var(--surface); border-top: 1px solid var(--border);` — negative horizontal margin so it bleeds full-width within `main`.
- **Not sticky. Not fixed.** Scrolls with the page content.
- Primary button on right is disabled until all non-soft groups are cleared; disabled state: `opacity: .5; cursor: not-allowed;`.
- When disabled, a soft-warn message sits next to the button: `"⚠ 2 issues still need review"` in `--orange`, 12px.

### Rail — source PDF preview

- Header (`rail-head`): `"Source · Submittal PDF"` eyebrow (11px, mono, tracked, secondary) and a small `"Open in viewer ↗"` link on the right.
- Body: vertically scrolling column of `pdf-row`s, one per opening in the whole schedule (312 in the demo).
- Each `pdf-row`: `display: grid; grid-template-columns: 64px 1fr; gap: 10px; padding: 8px 14px; border-bottom: 1px solid var(--border-dim); cursor: pointer;`
  - Thumbnail: 64×48 box, `background: var(--surface-raised); border: 1px solid var(--border); border-radius: 3px;` — in the prototype this is a blank placeholder with the page number in 11px mono, centered. In production, show an actual rendered PDF page crop.
  - Metadata column: opening number (mono, 13px, primary), hw_set (mono, 11px, secondary), page number (10px, tertiary).
- **Active row** (currently selected opening): `background: var(--blue-dim); border-left: 2px solid var(--blue); padding-left: 12px;` plus the metadata text turns `--text-primary`.
- **Group hover bloom**: when the user hovers a group-card header in the main column, every row in the rail whose opening is in that group gets `background: var(--tint);` — a soft wash that reveals the group's footprint in the PDF.

---

## Overlays

### Fix modal (the core resolution surface)

Opens on: "Fix all N" from group actions, "Fix one" from row ellipsis, or clicking a low-confidence chiclet.

Structure:

```
┌─────────────────────────────────────────────────────────────┐
│  eyebrow  (step indicator or bulk label)                     │
│  h2 title (Set <field> for <targets>)                        │
│  description (the group's rationale)                         │
├─────────────────────────────────────────────────────────────┤
│  Affected openings                                           │
│    ☑ 1308   DH1-10   Corridor 1202 from POE 1308             │
│    ☑ 1307   DH1-9    Corridor 1206 from Electric Room 1307   │
│    ☑ 1316   AD4      Corridor 1202 from IDF Room 1316        │
├─────────────────────────────────────────────────────────────┤
│  Value (<field name>)                                        │
│  [  text input  ]                    [ Draw from PDF ⤡ ]     │
│                                                              │
│  Suggested: 626 · 630 · US26D  (quick-fill chips)            │
├─────────────────────────────────────────────────────────────┤
│  ✦ Save as a rule for future imports?                        │
│    When hw_set = DH1-10, set finish to the value above.      │
│    ( ) Don't save   ( ) This project   ( ) All projects      │
├─────────────────────────────────────────────────────────────┤
│  [ Cancel ]  [ Mark N/A ]           [ Skip ]  [ Apply → ]    │
└─────────────────────────────────────────────────────────────┘
```

**Modal chrome:**
- Backdrop: `position: fixed; inset: 0; background: rgba(10,12,18,0.55); backdrop-filter: blur(4px); z-index: 80;` — fades in (opacity 0→1, 200ms).
- Dialog: max-width 560px, `background: var(--surface); border-radius: 10px; box-shadow: 0 24px 48px -8px rgba(0,0,0,0.28); padding: 0; overflow: hidden;`
- Sections separated by `border-top: 1px solid var(--border);` and padded `20px 24px`.

**Eyebrow copy:**
- Bulk mode: `"Fix for all 3 openings"` (opening count).
- Single-step: `"Fix one · 1308"` (opening number, not an array index).
- Multi-step (one door, multiple missing fields): `"Step 2 of 4 · 1308"`.

**Title copy:**
- Bulk: `"Set finish for 3 openings"`.
- Single: `"Set finish for 1308"`.

**Affected openings list:**
- In bulk mode: one checkbox per door in the group; all checked by default; reviewer can uncheck any to exclude.
- In single mode: one disabled-checked row for the target door.
- Row layout: `display: grid; grid-template-columns: 20px 80px 100px 1fr; gap: 10px; align-items: center; padding: 8px 0;`
- Columns: checkbox, opening (`.d`, mono 13px primary), hw_set (`.h`, mono 12px secondary), location (`.l`, 12px secondary, truncate).

**Value input:**
- Full-width text input, `border: 1px solid var(--border); border-radius: 6px; padding: 10px 12px; font-family: var(--font-mono); font-size: 14px;`
- Placeholder is field-specific — see the table at the end of this doc.
- Border flashes `--red` with focus if user hits Apply empty; flashes `--green` (for 800ms) when OCR capture prefills.

**Draw from PDF button:**
- Right-aligned, inline with the input on desktop (`display: flex; gap: 8px;`), stacks below on narrow.
- Label `"Draw from PDF ⤡"`, ghost style, 12px.
- Click → dismisses the modal and enters **Draw mode** (see below).

**Quick-fill chips** (optional, per-field):
- Small row of pill buttons below the input. Click inserts the value into the input and focuses.
- Chips: `display: inline-block; padding: 3px 10px; border-radius: 14px; border: 1px solid var(--border); background: var(--surface-raised); font-family: var(--font-mono); font-size: 11px; cursor: pointer;` — hover darkens bg one step.

**Rule-save block** (bulk mode only):
- Heading `✦ Save as a rule for future imports?` — 12px, `--text-primary`, semibold. The `✦` is `--purple`.
- Description with inline `<code>` chips describing the rule.
- Three radio-like buttons: `"Don't save"` (default active), `"This project"`, `"All future projects"`. Buttons are pill-shaped segmented controls — active has `background: var(--purple); color: var(--surface);`.

**Footer buttons:**
- Left group: `Cancel` (ghost), `Mark N/A` (ghost, outlined `--text-tertiary`).
- Right group: `Skip` (ghost, **visible only in multi-step mode**), `Apply` (primary).
- Primary button label morphs by mode:
  - Single, last step: `Apply`
  - Bulk: `Apply to selected`
  - Multi-step non-last: `Apply · Next`
  - Multi-step last: `Apply · Finish`

### Draw-mode banner and canvas

Triggered from the modal's "Draw from PDF" button. The modal closes, a banner appears across the top of the rail, and a canvas overlay is enabled on the rail's PDF area.

Banner copy: `"Draw a rectangle around the <field name> for <opening>"`, with a `Step X of Y` prefix when multi-step. 13px, `--text-primary`, on `--blue-dim` background, padded 10px 14px, with a `Cancel` link on the right.

Canvas: `position: absolute; inset: 0; cursor: crosshair;` — mouse down/move/up draws a `--blue` rectangle with `--blue-dim` fill.

On mouse-up:
1. Simulate OCR — pick a plausible value for the field (see placeholder table; prototype uses a static lookup).
2. Fade the rectangle out (800ms).
3. Re-open the modal with the captured value prefilled in the input; input border briefly glows `--green`.
4. Flash save-status: `Captured "626" from PDF`.

In production the draw-to-OCR call is a real backend request; prototype simulates it.

### Tooltip

Generic floating tooltip for hover affordances (confidence chiclets, icon buttons). `position: fixed; z-index: 100; background: var(--text-primary); color: var(--surface); padding: 6px 9px; border-radius: 4px; font-family: var(--font-mono); font-size: 11px; line-height: 1.35;` Fades in 150ms.

---

## Interactions & Behavior

### View toggle
- Clicking "Set view" re-renders the main column: group-cards are regrouped by `hw_set` instead of by RFI/issue, but the rail and all resolution affordances remain identical.
- Persist `state.view` to `localStorage('rh-view')`.

### Expand/collapse group
- Clicking the group header toggles `open` class on the section; body slides down (CSS grid row transition, 180ms ease-out). First group open by default.

### "Darrin says" disclosure
- Independent per-group. Caret rotates 150ms; body fades in 150ms.

### Fix modal — bulk
- Apply writes the value to every door where the checkbox is ticked.
- On apply, all affected doors move to `state.cleared`; the group count chip flips green; the progress bar advances.

### Fix modal — single / multi-step
- Invoked from "Fix one" in a row's ellipsis menu. The modal steps through every open field for that door in order: door_type → frame_type → hand → fire_rating → finish → electrified → lc_nomen → rod_len → hw_set → function_type → double_egress (skip fields that don't apply).
- `Skip` advances without writing.
- `Apply · Finish` on the last step closes the modal and adds the door to `cleared` if no open fields remain.

### Rule save
- Only visible in bulk mode.
- Selecting "This project" or "All projects" shows a transient save-status message: `"Rule saved (this project)"` for 2.4s, then reverts to `"Saved just now"`.
- Rules applied scope-wide would auto-clear matching doors on future ingests; out of scope for this screen.

### Mark N/A (per-door or bulk)
- Sets the field to the literal string `"N/A"` and tracks it in `state.naFields[did]` so the UI can visually differentiate N/A from a real value (dim the confidence chiclet and append a `·N/A` suffix in the row).

### Soft-flag disclosure
- A toggle above the group list: `Show soft flags (2)`. Switch-style. Off by default.
- When off, groups with `severity: "soft"` are excluded from render and from the progress denominator.

### Keyboard
- `Esc` — close modal / exit draw mode.
- `Enter` — apply current modal step (unless focus is outside the input).
- `↑ / ↓` inside an affected-list row — move focus between checkboxes.

### Persistence
- `localStorage('rh-theme')` — `light | dark`.
- `localStorage('rh-view')` — `door | set`.
- `localStorage('rh-soft-flags')` — `true | false`.
- Nothing else persists; resolution state comes from the server.

---

## State Management

The prototype keeps everything in one global `state` object. In production wire this to your existing store (React Query for server data, a reducer/zustand slice for UI).

```ts
type State = {
  view: 'door' | 'set';
  theme: 'light' | 'dark';
  showSoftFlag: boolean;

  // Server-authoritative
  doors: Record<OpeningId, Door>;   // keyed by opening number, NOT a numeric door_number
  groups: AttentionGroup[];         // computed server-side, or client-side from doors

  // Client-local
  cleared: Set<OpeningId>;          // doors the reviewer has fully resolved
  naFields: Record<OpeningId, Set<FieldName>>;

  // Transient
  activeDoor: OpeningId | null;     // drives rail scroll + highlight
  modal: {
    groupId: string;
    singleDoor?: OpeningId;         // present in single-door mode
    steps: { gid: string; did: OpeningId; field: FieldName; bulk?: boolean }[];
    stepIdx: number;
  } | null;
  drawMode: boolean;
  ruleScope: 'none' | 'project' | 'all';
};
```

### Key state transitions

| Event | State change |
|---|---|
| Click group header | toggle `open` class (DOM-local, not in state) |
| Click `Fix all N` | set `state.modal` with bulk=true, all fields in group |
| Click row "Fix one" | set `state.modal` with steps = missing fields for that door |
| Click low-conf chiclet | same as "Fix one" but with `steps` filtered to that field |
| Click `Apply` (bulk) | write values to all checked doors; add them to `cleared`; close modal; if `ruleScope !== 'none'`, POST rule |
| Click `Apply · Next` | write value, increment `stepIdx`, re-render modal |
| Click `Apply · Finish` | write value, close modal, add door to `cleared` if no fields remain |
| Click `Mark N/A` | set field = `"N/A"`, track in `naFields`, advance |
| Click `Draw from PDF` | close modal, `state.drawMode = true`, show banner + canvas |
| Mouse-up on canvas | simulate/fetch OCR, prefill input, reopen modal |
| Toggle view | re-render main column (grouping strategy changes, data identical) |
| All groups cleared | enable export primary button, flip gate pill to green |

### Derived values (compute, don't store)

- `visibleGroups = groups.filter(g => g.severity !== 'soft' || showSoftFlag)`
- `openCount = visibleGroups.filter(g => !groupFullyCleared(g)).length`
- `canExport = openCount === 0`

---

## Data Model

```ts
type Door = {
  on: string;                  // opening number — "1308", "110-01A", etc. USE THIS AS THE USER-FACING ID.
  hw_set: string;              // "DH1-10", "AD4", etc.
  heading: string;             // "DH1.01"
  label: string;               // fire rating label from the submittal, "45Min" | "90Min" | ""
  door_type: string;           // "A" | "B" | etc.
  frame_type: string;          // "F1" | "F2" | etc.
  hand: 'LH'|'LHR'|'RH'|'RHR'|'RHRA'|'DELHR';
  location: string;            // "Corridor 1202 from POE 1308"
  page: number;                // PDF page number in source submittal

  // Optional fields populated after review:
  finish?: string;             // "626" | "630" | "US26D" | ...
  electrified?: string;        // "QC3" | "none" | ...
  lc_nomen?: string;           // "QC3 + CON-6P"
  rod_len?: string;            // "FB31P (auto)" | "FB32 (constant)"
  fire_rating?: string;        // normalized from `label`
  function_type?: string;      // "passage (L9010)" | "classroom" | ...
  double_egress?: string;      // "CVR panic, no CR"

  // Parser confidence per field, 0-1. Low values surface the door in an attention group.
  confidence: Partial<Record<FieldName, number>>;
};

type FieldName =
  | 'on' | 'hw_set' | 'heading' | 'label'
  | 'door_type' | 'frame_type' | 'hand' | 'fire_rating'
  | 'finish' | 'electrified' | 'lc_nomen' | 'rod_len'
  | 'function_type' | 'double_egress';

type AttentionGroup = {
  id: string;                  // "grp-rfi-1"
  severity: 'high' | 'med' | 'soft';
  rfi: number;                 // 1..6 in the demo
  title: string;               // "Finish conflict — 626 vs 630"
  field: FieldName;            // the field this group is about
  doors: OpeningId[];          // door IDs in this group
  darrin: string;              // project-manager rationale paragraph
};
```

**Do not reintroduce `door_number`.** The prototype previously used it; the real system keys on the opening number (`on`). Any UI string that would have read "D3" now reads the opening number directly ("1308", "110-01A").

---

## Design Tokens

All tokens below are defined in the prototype's `<style>` block and should already exist in `src/app/globals.css`. If you find a mismatch, **trust the codebase**, not this doc.

### Colors — light

| Token | Hex | Usage |
|---|---|---|
| `--background` | `#F7F8FA` | Page bg |
| `--surface` | `#FFFFFF` | Cards, modals, navbar |
| `--surface-hover` | `#F0F2F5` | Hover fill, empty progress track |
| `--surface-raised` | `#F5F6F8` | Action strip inside cards, segmented-control bg |
| `--border` | `#D8DCE2` | Default 1px borders |
| `--border-hover` | `#B8BEC8` | Hover borders |
| `--border-dim` | `rgba(0,0,0,0.06)` | Faint intra-card dividers |
| `--tint` | `rgba(0,0,0,0.03)` | Group-hover wash on rail rows |
| `--text-primary` | `#1A1D23` | Headings, emphasized values |
| `--text-secondary` | `#5C6370` | Body copy |
| `--text-tertiary` | `#8B919E` | Metadata, tertiary links |
| `--blue` | `#1B6EB5` | Active rail row, draw rect, info |
| `--green` | `#1A8754` | Resolved, capture success, ready-to-export |
| `--orange` | `#AD5B00` | Medium-severity, caveats |
| `--red` | `#CC2D37` | High-severity, invalid input, export-blocked |
| `--yellow` | `#926C00` | Soft flags |
| `--purple` | `#7C4DBC` | Rule-save accent (`✦`) |

Each of the 6 accents has a `--{color}-dim` sibling (`color-mix(in srgb, var(--color) 8%, transparent)`) for backgrounds.

### Colors — dark

Identical tokens, re-defined under `[data-theme="dark"]`. Accents are lighter (`--blue: #4BA3E3`, etc.) and dims bump to 12% opacity. See the prototype CSS for exact values.

### Radii

- `--radius: 6px` — cards, inputs, buttons
- `--radius-sm: 4px` — confidence chiclets, small chips
- `--radius-pill: 20px` — segmented controls, gate pill
- `10px` — modal dialog (local, not tokenized)

### Spacing

No numeric scale token in the prototype; values use literals. Common values:
- `4 · 6 · 8 · 10 · 12 · 14 · 16 · 20 · 24 · 28 · 40`
- Card internal padding: `14px 16px` (header), `10px 16px` (rows), `12px 16px` (action strip).
- Main column padding: `28px 28px 0`.

### Typography

- `--font-inter: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', sans-serif`
- `--font-display: 'Orbitron', 'Inter', monospace` — used for brand mark, page h1, and section eyebrows (uppercase + tracked).
- `--font-mono: 'JetBrains Mono', ui-monospace, monospace` — all opening numbers, hw_set codes, heading codes, confidence chiclets, quick-fill chips, save-status, and the rule description inline codes.
- Base body: 14px / 1.5.
- Scale: 10 (chiclets), 11 (eyebrows, metadata), 12 (secondary body, chips), 13 (primary body), 14 (inputs), 28 (page h1).
- Page h1 uses Orbitron 600 at 28px with line-height 1.15 and letter-spacing -0.01em.

### Shadows

- Card: none (relies on border).
- Modal dialog: `box-shadow: 0 24px 48px -8px rgba(0,0,0,0.28);`
- Tooltip: none (solid inverted bg is enough).

---

## Field Placeholder Reference

When a modal step opens for a given field, use these placeholders (prototype values, refined to match real submittals):

| Field | Placeholder | Example OCR capture |
|---|---|---|
| `door_type` | `e.g. A, B, HM-80` | `A` |
| `hand` | `LH · LHR · RH · RHR · RHRA · DELHR` | `RHRA` |
| `fire_rating` | `e.g. 45Min, 90Min, N/A` | `90Min` |
| `finish` | `626 · 630 · US26D · US32D` | `626` |
| `hw_set` | `e.g. DH1-10, AD4, N/A` | `N/A` |
| `rod_len` | `FB31P (auto) or FB32 (constant)` | `FB31P (auto)` |
| `function_type` | `passage · privacy · classroom · storeroom` | `passage (L9010)` |
| `electrified` | `QC3 · none · advise` | `QC3` |
| `lc_nomen` | `QC3 + CON-6P` | `QC3 + CON-6P` |
| `double_egress` | `CVR panic, no CR` | `CVR panic, no CR` |
| `frame_type` | `HM · AL · WD` | `HM` |

---

## Assets

No image assets. All iconography is:
- **Unicode glyphs** — `·`, `✓`, `⚠`, `✦`, `⤡`, `▸`, `▾`, `↗`, `→`, `←`. Kept to a minimum; prefer the codebase's existing icon set (lucide-react or similar) for anything non-trivial, but match glyph choice where the prototype has settled on one.
- **Fonts** — Google Fonts: Orbitron, Inter, JetBrains Mono. Preconnect + import in the prototype head. Use the codebase's existing font loading (next/font) instead of `<link rel="stylesheet">`.

---

## Files

- `review-attention-first.html` — the full hi-fi prototype (single-file React-free vanilla JS). Reference implementation for everything above.

---

## Out of Scope for This Handoff

These are adjacent surfaces the prototype alludes to but does not design:
- Import / upload screen (prototype's "← Back to import" link).
- PDF viewer with actual page rendering (prototype's rail uses placeholder thumbnails).
- Rule-management page (where saved rules are reviewed and edited).
- Export flow (what happens after "Export schedule →").
- Submittal list / project dashboard.

Ask before inventing any of these.
