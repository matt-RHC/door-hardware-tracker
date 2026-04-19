# 01 — Design Context

## What the product does

A door-hardware tracking tool for commercial construction. A door-hardware consultant uploads the supplier's submittal PDF; the app uses AI to extract every opening (door location), its hardware set, and the individual line items (hinges, locks, closers, exit devices). Each opening gets a QR code that field techs scan on the jobsite to see what was specified and check hardware off at each stage (received → pre-install → installed → QA/QC). Issues that come up — wrong SKU, damaged parts, missing items, keying mismatch — are tracked with SLAs tied to severity.

## Who opens it daily, and why

- **Door-hardware consultant (office).** Primary daily user. Uploads submittal PDFs, reviews AI-extracted openings and sets, resolves extraction issues, answers field questions, exports CSVs for procurement. Works on a desktop.
- **Field tech / installer (jobsite).** Scans a QR on the opening, sees the hardware list, taps items through the stages (received → pre-install → installed → QA/QC), takes photos, files issues. On a phone, often wearing gloves, often in direct sun. PWA-installable.
- **Project manager (office + occasional site).** Watches progress, SLA timers, and punch lists across projects. Desktop, occasionally tablet.
- **Admin (office, rare).** Manages companies, SSO domains, members, tracking items. Desktop only.

## What 2.0 is solving that 1.0 didn't

The current UI is a cyberpunk / "Rabbit Hole Systems" aesthetic — dark-first, Orbitron display font, glows, cel-shading, corner brackets. Functionally the app works; the look reads as a gamer tool rather than an enterprise construction platform, and that blocks buyer-side conversations. This redesign is about credibility and enterprise fit. Feature parity is assumed.

**Inspiration posture:** Notion, Apple's first-party apps (Settings, Notes, Calendar, Health), and Apple's product-purchase flow — specifically how apple.com handles dense configuration (storage tier, trade-in, AppleCare, color) without overwhelming the buyer.

**Two interaction patterns to get right:**

1. **The opening card.** Each opening carries many fields and statuses — door number, HW set, fire rating, hand, stages (received / pre-install / installed / QA/QC), issues, QA findings. Today it feels overwhelming. The redesign must compress information without hiding it: icons, hierarchy, progressive disclosure — not walls of text.
2. **Darrin.** The AI assistant owns the domain reasoning. The interaction should feel like a familiar LLM chat — streaming text, option chips that populate as the model proposes them, clear back-and-forth — not a static form with AI underneath.

## Screens in scope (every one gets redesigned)

No current-app screenshots are supplied. Full creative reset — we don't want to anchor Claude Design to how things look today. The list below is the complete set of surfaces that need redesign:

| # | Screen | Route |
|---|---|---|
| 1 | Sign-in (**SSO-only** — email → `/api/auth/resolve` picks OAuth provider; no password UI in the live deployment) | `/` |
| 2 | Portfolio / dashboard | `/dashboard` |
| 3 | Project detail (openings grid + filters) | `/project/[id]` |
| 4 | Door detail / hardware checklist | `/project/[id]/door/[doorId]` |
| 5 | Project dashboard (charts, metrics) | `/project/[id]/dashboard` |
| 6 | Activity log | `/project/[id]/activity` |
| 7 | Issues list (kanban or table) | `/project/[id]/issues` |
| 8 | New issue form | `/project/[id]/issues/new` |
| 9 | Issue detail (thread, comments) | `/project/[id]/issues/[issueId]` |
| 10 | Punch list (QA findings) | `/project/[id]/punch-list` |
| 11 | Punch notes | `/project/[id]/punch-notes` |
| 12 | QR codes print sheet | `/project/[id]/qr-codes` |
| 13 | Admin: companies | `/admin/companies` |
| 14 | Admin: tracking | `/admin/tracking` |
| 15 | No-company dead end (post-OAuth) | `/auth/no-company` |

## Modals / overlay flows in scope

**Import Wizard.** Two flavors exist, gated by the `NEXT_PUBLIC_USE_JOB_WIZARD` env var:

- **Job Wizard (default in current dev env; 6 steps):** Upload → Questions → Review → Products → Compare → Confirm
- **Classic Wizard (flag off; 8 steps):** Upload → Scan Results → Map Columns → Triage → Review → Products → Compare → Confirm

Claude Design should redesign both variants — the user experience differs meaningfully (Questions step is Darrin-chat-driven; Map Columns / Triage / Scan Results are extraction-QA-driven).

Additional modals: BulkFixModal, PropagationSuggestionModal, PromoteConfirmModal, IssueReportModal, ParseEmailModal, InlineRescan.

## Out of scope for this redesign

- Extraction pipeline behavior (what Claude extracts, how Darrin reviews it)
- Data model / Supabase schema
- API surface (43 routes, unchanged)
- Domain logic (hardware sets, SLAs, stages)

This is a visual + compositional redesign. Functionality stays.
