# 05 — Deliverable Shape

## Fidelity

Hi-fi mockups. No wireframe pass. No clickable HTML prototype.

## Variations per screen

1 per screen by default. 2 on the high-traffic screens (axis: layout density — tight vs. comfortable):

- Dashboard (`/dashboard`)
- Project detail (`/project/[id]`)
- Door detail (`/project/[id]/door/[doorId]`)
- Issues list (`/project/[id]/issues`)
- New issue form (`/project/[id]/issues/new`)
- Every Import Wizard step — both Job Wizard (6 steps) and Classic Wizard (8 steps) variants

## Device targets

**Desktop-first** — sign-in, dashboard, project detail, project dashboard, activity, issues list, issue detail, punch list, punch notes, admin companies, admin tracking, Import Wizard.

**Mobile-first** — door detail (also QR-landing), new issue form.

Tablet not a primary target.

## Output format

Claude Design's choice. Whatever form is delivered, please ensure:

1. Screens grouped in the order in `01-design-context.md` (1 → 15, then wizard variants).
2. Tokens come back as a portable JSON file with the **same structure** as `design-tokens.current.json` — name stability means zero component changes for the token swap.
3. Component patterns (button, input, card, badge, dialog, table row, form field) shown in isolation in addition to in screens.
4. Any proposal that bumps against a constraint in `04-aesthetic.md` is called out explicitly.
