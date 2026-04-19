# 06 — Nice-to-haves & Guardrails

## North star

The real target user is the **busy field superintendent or foreman**. Anyone can build a spreadsheet — the hard part is turning a submittal PDF into something trackable without the super having to think about it. Darrin (the AI assistant) knows doors like a subject-matter expert; he does the translation. The product promise the design has to deliver on is:

> **Import it, track it, forget it.**

Everything in the redesign should make that promise feel true — from how the opening card compresses information, to how Darrin populates options like a chat, to how the nav gets out of the way on a phone in bright sun.

## Current-app screenshots

**Not included in the handoff bundle.** Full creative reset — we deliberately don't want to anchor Claude Design to the existing cyberpunk aesthetic. Descriptions and the data samples are the substitute. (16 screenshots exist locally in `design/screenshots/` from a capture run; they're kept for internal reference only.)

## Data samples

Ten JSON files live in `design/data-samples/` — derived from a real McCarthy Jones & Woodard submittal PDF (third-party entity names redacted; technical content preserved verbatim). These represent the shapes Claude Design should use when filling mockups instead of lorem ipsum:

- Base shapes: `sample-project.json`, `sample-opening.json`, `sample-hardware-item.json`, `sample-issue.json`, `sample-qa-finding.json`, `sample-extraction-job.json`
- Lists (for populated-view mockups): `sample-openings-list.json` (22 openings), `sample-hardware-items-list.json` (26 items), `sample-hardware-sets-list.json` (all 34 sets)
- Workflow precursor: `sample-rfi-list.json` (10 real RFIs from the submittal — the domain-authentic pattern the app's "issues" feature mirrors)

## Competitor / reference screenshots

Optional. Claude Design is expected to reference Notion, Apple apps, Procore, Fieldwire, Bluebeam from its own visual memory. If a specific design decision hinges on a specific screen, Matthew will paste that screenshot into the conversation on demand rather than pre-loading a folder.

## Do-not-touch list

Things Claude Design should preserve through the reset:

1. **OSHA color semantics** — red/orange/yellow/green with fixed meanings. Hues can change; meanings cannot. See `04-aesthetic.md`.
2. **`field` vs `bench` install-type tokens** — must stay distinct from OSHA alarm colors. This was a deliberate fix. See `src/app/globals.css:76–82`.
3. **`prefers-reduced-motion`** — the OS-level preference always disables animation. Any new animation system honors it.
4. **`data-perf=low|mid` tiers** — low-end devices disable glows + animations; mid-tier keeps static decorations but kills animation. The new design doesn't have to carry the concept forward, but it must not _silently_ enable expensive effects that weren't there before.
5. **Print-CSS for QR-codes page** — the `@media print` block in `globals.css` is used to print physical QR labels. Preserve it.
6. **`currentColor` icon pattern** — icons inherit from their text parent's color class. Any new icon system must keep this behavior so existing text-color utilities work with zero icon rework.
7. **Extraction pipeline UI semantics** — the Import Wizard has bespoke concepts (Darrin's AI-reviewer disclosures, confidence tiers `high|med|low`, punch cards, source rails showing PDF regions). Claude Design may restyle them, but the conceptual structure is load-bearing for the product.
