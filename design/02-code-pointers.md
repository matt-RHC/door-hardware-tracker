# 02 — Code & System Pointers

Paths and exact file names beat descriptions.

## Framework + styling

- **Next.js 16.2** App Router, **React 19**, Turbopack
- **Tailwind CSS v4** — no `tailwind.config.{js,ts}` file; theme declared via `@theme inline { … }` inside `globals.css`
- Design tokens live as CSS custom properties; components consume them directly (`var(--blue)`) or through generated Tailwind utilities (`bg-accent`, `text-primary`, `border-th-border`)
- **No** shadcn/ui, Radix, clsx, tailwind-merge, class-variance-authority, or any component library
- Icons are **custom inline SVGs** using `currentColor` so they inherit from the parent text class

## Feature flags (matter for design)

- **`NEXT_PUBLIC_USE_JOB_WIZARD`** — when `"true"`, 6-step Job Wizard (Upload → Questions → Review → Products → Compare → Confirm). When `"false"` or unset, 8-step Classic Wizard (Upload → Scan Results → Map Columns → Triage → Review → Products → Compare → Confirm). Both must be redesigned.

## Auth model (matters for sign-in design)

- **SSO-only in the deployed UI.** `/` calls `/api/auth/resolve` with the user's email, which returns an OAuth provider mapped to the email's company domain. UI does **not** show a password field in production.
- Server-side `supabase.auth.signInWithPassword` still works for seeding / automation but isn't user-facing.
- Post-OAuth: if the domain isn't registered, the user lands on `/auth/no-company`.

## Design tokens — exact paths

All tokens live in `src/app/globals.css`:

| Line range | Contents |
|---|---|
| 7–108 | Dark-theme root tokens — neutrals, brand (steel blue), OSHA semantic colors, install-type (field/bench), glow geometry, radii |
| 119–158 | Light-theme overrides (`[data-theme="light"]`) — product default |
| 160–208 | `@theme inline` block mapping CSS vars → Tailwind utility names |
| 232–492 | Component classes — `.glow-card`, `.glow-btn*`, `.status-badge*`, `.input-field`, `.panel`, `.divider`, `.text-glow-*` |
| 493–568 | Cel-shading / comic-book system — likely dropped in the reset |
| 570–663 | Animations + performance tiers + reduced-motion override |
| 665–762 | Utility classes — `.group-header`, `.row-accent-*`, `.confidence-bar*`, `.drawer*` |
| 765–1001 | "Attention-first review" typography + chrome |

## Key component paths — primitives & feedback

- `src/components/Navbar.tsx`
- `src/components/ThemeToggle.tsx`, `src/components/SoundToggle.tsx`
- `src/components/ToastProvider.tsx`
- `src/components/BlockedBadge.tsx`, `src/components/issues/StatusBadge.tsx`, `src/components/issues/SeverityBadge.tsx`, `src/components/ImportWizard/ConfidenceBadge.tsx`
- `src/components/ProgressBar.tsx`
- `src/components/icons/ConfidenceIcons.tsx`
- `src/components/OfflineIndicator.tsx`, `src/components/SyncStatusDot.tsx`

## Key component paths — composites / domain

- `src/components/ImportWizard/ImportWizard.tsx` (orchestrator) + 17 sub-components
- `src/components/issues/KanbanBoard.tsx`, `src/components/issues/OpeningIssuesFeed.tsx`
- `src/components/notes/NoteEditor.tsx`, `src/components/notes/NoteList.tsx`
- `src/components/punch-notes/PunchNotesView.tsx`, `src/components/punch-notes/Markdown.tsx`
- `src/components/PDFPageBrowser.tsx`, `src/components/FileViewer.tsx`

## Representative data shapes

Live in `design/data-samples/` — derived from a real submittal PDF, third-party entities redacted. See `06-extras.md` for the full file list.

## Current design tokens (reference only)

See `design-tokens.current.json`. Brand is being fully reset.
