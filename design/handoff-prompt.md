# Handoff Prompt — Paste into Claude Design

_Paste everything below the horizontal rule._

---

I'm redesigning a B2B construction-tech app — a door-hardware tracker used by commercial-construction teams. Brand posture is **full creative reset**: propose a new visual system from scratch. The real target user is the busy field superintendent, not the office consultant.

I'm attaching six briefing documents that answer the questions from your return prompt, plus redacted data samples and the current design-token JSON. **I deliberately did not include current-app screenshots** — the existing UI is a cyberpunk aesthetic we're reseting from, and I don't want to anchor you to it. Please work from the descriptions.

Read the briefing in this order:

1. `01-design-context.md` — who uses it daily, what 2.0 is trying to fix, every screen in scope, and two specific interaction patterns to get right (the opening card, the Darrin chat). Note: the Import Wizard has two variants behind a feature flag — Job Wizard (6 steps) and Classic Wizard (8 steps). Both need redesign.
2. `02-code-pointers.md` — exact file paths for tokens, components, the SSO-only sign-in flow, data shapes
3. `03-users-and-domain.md` — primary target user, personas, 15-term domain glossary, scale figures from a real 82-opening project
4. `04-aesthetic.md` — tone, reference posture (Notion, Apple apps, the Apple purchase flow), immovable constraints, everything you're free to change
5. `05-deliverable-shape.md` — fidelity, variations, device targets, output format
6. `06-extras.md` — north star, do-not-touch list

Supporting material in `data-samples/`:

- Base shapes (1 row each): project, opening, hardware item, issue, QA finding, extraction job with Darrin observations
- List shapes (populated views): 22 openings, 26 hardware items, 34 hardware sets
- **`sample-rfi-list.json`** — 10 real RFI exchanges from the source submittal. This is the domain-authentic precursor to the "issues" feature; treat it as the canonical example of what a collaborative issue thread looks like to these users.
- `design-tokens.current.json` — current tokens, **reference only** (brand is being reset)
