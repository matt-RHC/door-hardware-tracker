# Bug Diagnosis: Back/Next Buttons Greyed Out at Wizard End

**Date:** 2026-04-12
**Status:** Investigation — no code fix applied
**Reporter:** User ("by the end, i was unable to finish the wizard the back and next button were greyed out - maybe i timed out?")

---

## Hypotheses

### Hypothesis 1 (HIGH confidence): `allAttempted` disables batch button without feedback

**Likely already fixed by PR #108 (commit a481eca).**

**Before PR #108:**
- The empty_sets card's "Extract with AI" button had `disabled: busy` only
  (`src/components/ImportWizard/PunchyReview.tsx`, previously ~line 616)
- When deep extraction returned empty arrays (phantom sets with no items),
  `deepExtracting` was reset to `false` and the button became re-enabled
- But clicking it again was a **silent no-op** — Punchy already tried and
  found nothing, so the same empty result returned
- The user sees buttons that look clickable but do nothing. The "Extract
  with AI" button appears to stop working. Back button still works but if
  the user can't progress forward, they perceive the whole wizard as stuck

**After PR #108:**
- Added `emptySetsAttempted: Set<string>` state tracking
  (`src/components/ImportWizard/StepTriage.tsx:73-77`)
- Empty_sets card now has `disabled: busy || allAttempted`
  (`src/components/ImportWizard/PunchyReview.tsx:660`)
- When all empty sets have been tried, the button is explicitly disabled
  and relabeled to "Punchy couldn't find items — use options below"
- A warning banner appears directing users to per-set resolution options
  (Add manually / Remove / Try with hint)

**Why this matches the user's report:**
- User said "by the end" — consistent with reaching the empty_sets card
  after initial extraction
- User said "back and next button were greyed out" — the primary action
  button (which says "Extract with AI" / "Continue") is the most visible
  button. If it stops responding, it feels like the wizard is stuck
- User said "maybe i timed out?" — the silent no-op behavior looks like
  a timeout because nothing happens when they click

**Confidence:** HIGH that this was the root cause. The fix in PR #108
provides explicit feedback and alternative actions.

---

### Hypothesis 2 (MEDIUM confidence): Cards regeneration race condition

**File:** `src/components/ImportWizard/PunchyReview.tsx`

The `cards` array is a `useMemo` that depends on `[doors, hardwareSets, qtyCheck, pages]` (line 100). When `hardwareSets` changes (e.g., after deep extraction fills an empty set), the memo recomputes.

**Potential issue:**
1. `generatePunchCards()` runs with updated `hardwareSets`
2. If the empty_sets card disappears (all sets now have items), `cards.length` decreases
3. The `currentIdx` clamp effect fires (lines 106-110):
   ```tsx
   useEffect(() => {
     if (currentIdx > cards.length - 1) {
       setCurrentIdx(Math.max(0, cards.length - 1));
     }
   }, [cards.length, currentIdx]);
   ```
4. During a React render cycle, `cards[currentIdx]` could be `undefined`
5. `currentCard = cards[currentIdx] ?? null` returns `null` (line 117)
6. When `currentCard` is null, `renderCard()` returns `null` — the entire
   card area disappears, including all buttons

**How to confirm:**
- In DevTools Console, add a breakpoint on `PunchyReview.tsx` line 117
- Watch for `currentCard` becoming `null` during the transition
- Or add `console.log('cards:', cards.length, 'idx:', currentIdx)` before
  the return statement

**Proposed defensive fix (if confirmed):**
```tsx
if (!currentCard && cards.length > 0) {
  // Stale index — render the last card instead of nothing
  const fallbackCard = cards[cards.length - 1];
  return renderCard(fallbackCard, ctx);
}
```

---

### Hypothesis 3 (LOW confidence): CSS-level disabled state

**File:** `src/components/ImportWizard/PunchCard.tsx`

PunchCard buttons use `disabled:opacity-50` Tailwind class (line ~155). If a
parent component or global CSS applies `pointer-events: none` or `opacity: 0.5`
to the card container, buttons would LOOK greyed without having the `disabled`
HTML attribute.

**How to confirm:**
- In DevTools Elements panel, inspect the greyed button
- Check if `disabled` attribute is present on the `<button>` element
- Check computed styles for `pointer-events` and `opacity` on parent elements
- Look for any overlay/modal that might be blocking interaction

---

## What DevTools Data Is Needed

To confirm which hypothesis applies, the user should capture:

1. **Console errors** at the moment buttons grey out — any React errors,
   uncaught exceptions, or network failures
2. **React DevTools state** for `PunchyReview` component:
   - `currentIdx` value
   - `cards` array length
   - `deepExtracting` boolean
   - `emptySetsAttempted` set contents
3. **Network tab** — any failed API calls (especially `/api/parse-pdf/deep-extract`)
   that might leave `deepExtracting` stuck
4. **Elements panel** — inspect the greyed button and check for `disabled`
   attribute vs CSS-only greying

## Minimal Reproduction Steps

1. Upload a PDF with at least one hardware set that pdfplumber can't parse
   (a set that will show up as "empty" in the wizard)
2. Let the wizard reach the PunchyReview card flow
3. On the empty_sets card, click "Extract with AI"
4. If Punchy returns no items for that set:
   - **Before PR #108:** The button re-enables but clicking does nothing
   - **After PR #108:** The button disables with explanation text
5. Observe whether Back/Next become unresponsive at this point

## Recommendation

No code fix applied in this investigation. Hypothesis 1 appears to have been
addressed by PR #108 (merged 2026-04-11). If the user reports the issue again
on the current build, Hypothesis 2 (cards regeneration race) should be
investigated next with the defensive fix described above.
