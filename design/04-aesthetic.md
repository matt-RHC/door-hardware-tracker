# 04 — Aesthetic Direction

Brand posture: **full creative reset.** The guardrails below are the only things that can't move.

## Tone

Utilitarian tool that respects the user's time. Not polished SaaS marketing. Not gamer / cyberpunk. Not military-rugged.

Reference the clarity of Linear, the readability of Notion, the density of Attio, applied to a construction domain. The consultant should feel the app is a professional instrument, not a product with personality.

## References

Competitors — **avoid these postures:**

- **Procore** — orange brand + cluttered dashboard
- **Fieldwire** — the specific light-blue + iconography language
- **Bluebeam** — technical/document-first is a good posture, shell aesthetic is dated

Positive references — **aim for this posture:**

- **Notion** — clarity, density without clutter, UI that steps out of the way
- **Apple first-party apps** — Settings, Notes, Calendar, Health
- **Apple's product-purchase flow** — how apple.com handles dense configuration (storage tier, trade-in, AppleCare, color) without overwhelming. That's the pattern the opening card needs.

No reference screenshots included. Claude Design should work from visual memory of these apps.

## Constraints that cannot move

1. **Light mode is the product default.** Field techs use it in direct sunlight. Dark mode optional.
2. **OSHA color semantics are fixed.** Hues can change; meanings cannot:
   - **Red** = stop / danger / critical
   - **Orange** = warning / delay
   - **Yellow / amber** = caution / advisory
   - **Green** = safe / go / complete
3. **`field` and `bench` install-type tokens must stay distinct from OSHA colors.** Pre-existing bug fix. See `src/app/globals.css:76–82`.
4. **`prefers-reduced-motion` and `data-perf=low|mid` tiers must survive.**
5. **PWA + printable QR-codes sheet.** `@media print` block in `globals.css` is load-bearing.

## What Claude Design is free to change

Palette, typography, spacing, component shapes, elevation (probably drop the glow aesthetic), iconography (keep `currentColor` behavior), illustration style, brand name/logo, dark-mode look.
