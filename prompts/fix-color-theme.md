# Color & Theme Deep-Dive Audit Prompt

> Copy this entire prompt and give it to Claude in a new session to audit and fix all color/styling issues.

---

You are auditing a Next.js app for color and styling conflicts. The app has a Borderlands industrial theme (cel-shaded, glow-cards, corner-brackets, Orbitron font, cyan accent #5ac8fa). It was built for dark mode but needs to work in both dark AND light mode.

## Your Task

Do a comprehensive audit of EVERY component file for:
1. **Hardcoded colors** that won't adapt to light/dark mode
2. **Color clashes** — text colors that are invisible or hard to read against their background
3. **Missing theme variable usage** — places using hex codes, `text-white`, `bg-black`, or named Tailwind colors instead of the CSS variable system
4. **Inconsistent styling** — some components use the theme system correctly, others don't
5. **Contrast issues** — text that fails WCAG AA contrast in either mode

## How the Theme System Works

CSS variables are defined in `src/app/globals.css` with two modes:
- Default (dark): `--background: #0F1117`, `--foreground: #E4E6EB`, etc.
- Light: `[data-theme="light"]` selector overrides all variables

### Available CSS Variable Classes (use THESE, not hardcoded colors):

**Text:**
- `text-primary` → main text (auto-adapts)
- `text-secondary` → secondary text
- `text-tertiary` → muted text
- `text-accent` → cyan accent

**Backgrounds:**
- `bg-background` → page background
- `bg-surface` → card/panel
- `bg-surface-hover` → hover state
- `bg-surface-raised` → elevated surface

**Borders:**
- `border-border` → standard border
- `border-border-hover` → hover
- `border-dim` → subtle

**Semantic colors (use `var(--color)` syntax):**
- `var(--blue)`, `var(--green)`, `var(--orange)`, `var(--red)`, `var(--cyan)`, `var(--yellow)`
- Dim variants: `var(--blue-dim)`, `var(--green-dim)`, etc.

## What to Find and Replace

### Immediate Breaks (invisible text, wrong backgrounds)
- `text-white` → `text-primary` (white text is invisible on light backgrounds)
- `bg-black` → `bg-background` (wrong in light mode, except for overlays)
- `text-[#e8e8ed]`, `text-[#f5f5f7]` → `text-primary`
- `text-[#8e8e93]`, `text-[#a1a1a6]` → `text-secondary`
- `text-[#636366]`, `text-[#6e6e73]` → `text-tertiary`
- `text-[#5ac8fa]` → `text-accent`

### Hardcoded Hex Colors
- `text-[#30d158]` → `text-[var(--green)]`
- `text-[#ff453a]` → `text-[var(--red)]`
- `text-[#0a84ff]` → `text-[var(--blue)]`
- `bg-[rgba(90,200,250,...)]` → `bg-[var(--cyan-dim)]`
- `bg-[rgba(48,209,88,...)]` → `bg-[var(--green-dim)]`
- `bg-[rgba(255,69,58,...)]` → `bg-[var(--red-dim)]`

### Tailwind Named Colors (don't adapt to theme)
- `slate-800`, `slate-900` → `bg-surface`
- `slate-700` → `bg-surface-hover`
- `text-slate-300/400` → `text-secondary` or `text-tertiary`
- `yellow-300`, `blue-300`, `green-300`, `orange-300`, `red-300` → `text-[var(--yellow)]`, etc.
- `border-slate-700/800` → `border-border`
- Status color objects (like `bg-yellow-900/30 text-yellow-300`) → use dim variants

### Keep As-Is
- `bg-black/60`, `bg-black/80` for modal overlays — overlays should always be dark
- QR code print styles — need white background for printing
- SVG fill colors that are intentionally fixed

## Files to Audit (START WITH THESE)

Read EVERY file listed below. Check each one for hardcoded colors and fix them.

### Critical (layout, pages)
1. `src/app/layout.tsx`
2. `src/app/page.tsx` (login page — 50+ hardcoded hex colors)
3. `src/app/signup/page.tsx`
4. `src/app/project/[projectId]/qr-codes/page.tsx`
5. `src/app/project/[projectId]/door/[doorId]/page.tsx`
6. `src/app/project/[projectId]/dashboard/page.tsx`
7. `src/app/project/[projectId]/page.tsx`
8. `src/app/dashboard/page.tsx`

### High (shared components)
9. `src/components/IssueReportModal.tsx`
10. `src/components/DeliveryTrackerPanel.tsx`
11. `src/components/ColumnMapperWizard.tsx`
12. `src/components/PDFPageBrowser.tsx`
13. `src/components/SmartsheetSyncButton.tsx`
14. `src/components/Navbar.tsx`
15. `src/components/FileViewer.tsx`
16. `src/components/SoundToggle.tsx`

### Medium (ImportWizard — the extraction flow)
17. `src/components/ImportWizard/ImportWizard.tsx`
18. `src/components/ImportWizard/StepUpload.tsx`
19. `src/components/ImportWizard/StepConfirm.tsx`
20. `src/components/ImportWizard/StepTriage.tsx`
21. `src/components/ImportWizard/StepScanResults.tsx`
22. `src/components/ImportWizard/StepMapColumns.tsx`
23. `src/components/ImportWizard/StepReview.tsx`
24. `src/components/ImportWizard/StepCompare.tsx`
25. `src/components/ImportWizard/PunchCard.tsx`
26. `src/components/ImportWizard/DarrinReview.tsx`

### Also Check
27. `src/app/globals.css` — verify all CSS variables exist and are mapped
28. `tailwind.config.ts` — verify theme extensions include all CSS variables
29. Any other component files you find with `text-white`, `bg-black`, or hardcoded hex

## Process

1. Read `src/app/globals.css` first to understand the full variable system
2. Read `tailwind.config.ts` to see what's mapped to Tailwind utilities
3. Go through each file above, reading it completely
4. For each file, make the replacements
5. After fixing each file, verify with `npx next build` (Turbopack is strict)
6. Test by toggling `data-theme` between "dark" and "light" in browser dev tools

## Rules
- The dark theme IS the brand. Don't change the dark mode look.
- Only change colors that use hardcoded values. If a component already uses theme variables, leave it alone.
- Don't change overlay/backdrop colors — `bg-black/60` is correct for overlays in both modes.
- Don't change print styles (QR page needs white background).
- One file at a time. Commit each fix separately.
- Check tailwind.config.ts — if a CSS variable isn't mapped to a Tailwind utility class, add the mapping.
