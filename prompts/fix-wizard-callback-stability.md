# Fix: Wizard Pipeline Callback Stability & Stale Closure Bugs

## Context

A deep audit of the ImportWizard PDF pipeline found 3 critical and 4 high-severity bugs causing infinite loops, stale state, and silent data loss. These are all in `src/components/ImportWizard/` and stem from two root patterns:

1. **Unstable inline callbacks** — `onError={(err) => patch({ error: err })}` creates a new function ref every render. Steps that put these in useCallback/useEffect dependency chains re-trigger infinitely.
2. **Stale closures** — callbacks capture state values (like `hardwareSets`, `state.hasExistingData`) at creation time instead of reading current state at execution time via `setState(prev => ...)`.

## Branch

Create branch `fix/wizard-callback-stability` from `main`. Commit and push when done.

## Git identity

```
git config user.email "matt@rabbitholeconsultants.com"
git config user.name "Matthew Feagin"
```

## Bugs to Fix (in priority order)

### CRITICAL 1: StepCompare Infinite Loop on Mount
**File:** `src/components/ImportWizard/StepCompare.tsx`
**Problem:** `runCompare` useCallback (~line 92) depends on `onError` prop. `onError` is an inline arrow from ImportWizard.tsx, so it's a new ref every render. A useEffect (~line 138) fires `runCompare()` on dependency change → API call → state update → parent re-renders → new onError → loop.
**Fix:** In `ImportWizard.tsx`, replace ALL inline `onError={(err) => patch({ error: err })}` with a single memoized callback:
```typescript
const onError = useCallback((err: string) => patch({ error: err }), [patch]);
```
Then pass `onError={onError}` to StepTriage, StepCompare, StepConfirm, StepUpload, and StepMapColumns. Search for every `onError={(err)` in ImportWizard.tsx and replace.

### CRITICAL 2: PunchyReview Stale hardwareSets in Quantity Propagation  
**File:** `src/components/ImportWizard/PunchyReview.tsx` (~line 179-195)
**Problem:** `handleAnswerQuestion` has `[hardwareSets]` in its dependency array and calls `propagateQuantityDecision(decision, hardwareSets)` using the closure value. If user applies corrections on one card then answers a question on a later card, propagation runs on pre-correction data. Corrections silently lost.
**Fix:** Use `setHardwareSets(prev => ...)` functional form inside `handleAnswerQuestion` instead of reading `hardwareSets` from closure. Remove `hardwareSets` from the dependency array. The propagation logic should operate on `prev` (current state), not the captured closure value.

### CRITICAL 3: onProductsComplete / onReviewComplete Stale state.hasExistingData
**File:** `src/components/ImportWizard/ImportWizard.tsx` (~line 333-353)
**Problem:** `onProductsComplete` and `onReviewComplete` (the old version before Products was added — check if this pattern still exists) capture `state.hasExistingData` in a closure. If state changes between creation and execution, wrong step is selected.
**Fix:** Use `setState` functional form:
```typescript
const onProductsComplete = useCallback(
  (hardwareSets: HardwareSet[]) => {
    setState(prev => ({
      ...prev,
      hardwareSets,
      currentStep: prev.hasExistingData ? WizardStep.Compare : WizardStep.Confirm,
    }));
  },
  [],
);
```
Apply the same pattern to any other callback that reads `state.X` and uses it in `patch()`. The `patch()` helper itself is fine since it uses functional setState internally, but callbacks that branch on `state.hasExistingData` before calling `patch()` have the stale closure problem.

### HIGH 1: StepTriage handleDeepExtract Stale Array
**File:** `src/components/ImportWizard/StepTriage.tsx` (~line 263-429)
**Problem:** `handleDeepExtract` captures `hardwareSets` in closure. If user removes a set while API call is in-flight, response merges into stale array. Items for removed sets silently dropped.
**Fix:** Where the callback updates hardwareSets after the API response, use `setHardwareSets(prev => ...)` functional form and find sets by `set_id` in `prev`, not in the captured array.

### HIGH 2: PunchyReview useEffect Missing cards Dependency
**File:** `src/components/ImportWizard/PunchyReview.tsx` (~line 116-120)
**Problem:** useEffect watches `[cards.length, currentIdx]` but not `cards` itself. If cards array changes structure but same length, currentIdx points to wrong card.
**Fix:** Add `cards` to the dependency array, or better: compute a stable key from cards (e.g., `cards.map(c => c.id).join(',')`) and use that as the dependency.

### HIGH 3: StepTriage runExtraction Re-triggers on Parent Re-render
**File:** `src/components/ImportWizard/StepTriage.tsx` (~line 94-256)
**Problem:** `runExtraction` depends on `columnMappings` (array) and `onError` (inline). Either changing reference triggers the extraction useEffect → duplicate API calls.
**Fix:** The `onError` fix from CRITICAL 1 handles half of this. For `columnMappings`, either memoize it in ImportWizard.tsx before passing, or add a `hasRun` ref guard in StepTriage:
```typescript
const hasRun = useRef(false);
useEffect(() => {
  if (hasRun.current) return;
  hasRun.current = true;
  runExtraction();
}, [runExtraction]);
```

### HIGH 4: StepCompare Decision State Not Reset
**File:** `src/components/ImportWizard/StepCompare.tsx` (~line 85-129)
**Problem:** If `compareResult` changes (back-navigation and re-fetch), `removedActions`/`changedTransfer`/`newExcluded` state is not re-initialized. Missing entries default silently.
**Fix:** Add a useEffect that re-initializes decision state when `compareResult` changes.

## Rules

- Read CLAUDE.md for Turbopack TypeScript rules: always use `?.`, `??`, `?? []` — never rely on `&&` or `if` guards for narrowing.
- Do NOT add features, refactor UI, or change behavior. These are surgical stability fixes only.
- Do NOT touch StepProducts.tsx or product-dedup.ts — those are new and clean.
- Test: `npm run build` must pass TypeScript compilation. The Supabase env var error during static generation is expected in dev — the key check is "Compiled successfully" and "Finished TypeScript".

## Commit

One commit with message:
```
Fix wizard pipeline callback stability and stale closure bugs

- Memoize onError callback in ImportWizard (was inline arrow, caused
  infinite re-render loop in StepCompare and StepTriage)
- Use setState functional form in onProductsComplete to read current
  state.hasExistingData instead of stale closure value
- Fix PunchyReview handleAnswerQuestion to use setHardwareSets(prev =>)
  instead of capturing stale hardwareSets closure
- Fix StepTriage handleDeepExtract stale array after set removal
- Add cards to PunchyReview useEffect dependency array
- Add hasRun guard to StepTriage runExtraction useEffect
- Re-initialize StepCompare decision state when compareResult changes
```
