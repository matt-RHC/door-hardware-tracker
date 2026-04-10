"use client";

import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import type {
  DoorEntry,
  HardwareSet,
  PunchyQuantityCheck,
  PageClassification,
} from "@/lib/types";
import type { PunchQuestion } from "@/lib/punch-messages";
import {
  generatePunchCards,
  computeExtractionHealth,
  type PunchCardData,
} from "@/lib/punch-cards";
import {
  buildDecisionFromAnswer,
  propagateQuantityDecision,
  classifyItemCategory,
} from "@/lib/quantity-propagation";
import PunchCard from "./PunchCard";
import PDFPagePreview from "./PDFPagePreview";

// ── Props ──

interface PunchyReviewProps {
  doors: DoorEntry[];
  hardwareSets: HardwareSet[];
  qtyCheck: PunchyQuantityCheck | null;
  pages: PageClassification[];
  pdfBuffer: ArrayBuffer | null;
  projectId: string;
  /** Called when user confirms a golden sample. */
  onGoldenSampleConfirmed: (sample: {
    set_id: string;
    heading: string;
    items: HardwareSet["items"];
    confirmed: boolean;
  }) => void;
  /** Called to trigger deep extract for empty sets. */
  onDeepExtract: () => void;
  deepExtracting: boolean;
  /** Called when user finishes all cards and is ready for triage. */
  onComplete: (updates: {
    hardwareSets: HardwareSet[];
    questionsAnswered: Record<string, string>;
    triageQuestions: PunchQuestion[];
  }) => void;
  /** Go back to results/columns. */
  onBack: () => void;
}

// ── Component ──

export default function PunchyReview({
  doors,
  hardwareSets: initialSets,
  qtyCheck,
  pages,
  pdfBuffer,
  projectId,
  onGoldenSampleConfirmed,
  onDeepExtract,
  deepExtracting,
  onComplete,
  onBack,
}: PunchyReviewProps) {
  const [currentIdx, setCurrentIdx] = useState(0);
  const [hardwareSets, setHardwareSets] = useState(initialSets);
  const [correctionsApplied, setCorrectionsApplied] = useState(false);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [sampleConfirmed, setSampleConfirmed] = useState(false);
  // Auto-expand set list for small projects (≤ 10 sets)
  const [setsExpanded, setSetsExpanded] = useState(initialSets.length <= 10);

  // Keep hardwareSets in sync if parent updates (e.g., deep extract fills empty sets)
  useEffect(() => {
    setHardwareSets(initialSets);
  }, [initialSets]);

  // Generate cards from current data
  const cards = useMemo(
    () => generatePunchCards({ doors, hardwareSets, qtyCheck, pages }),
    [doors, hardwareSets, qtyCheck, pages],
  );

  const health = useMemo(
    () => computeExtractionHealth(doors, hardwareSets),
    [doors, hardwareSets],
  );

  const currentCard = cards[currentIdx] ?? null;
  const isLast = currentIdx >= cards.length - 1;

  // ── Navigation ──

  const goNext = useCallback(() => {
    if (isLast) return;
    setCurrentIdx(i => Math.min(i + 1, cards.length - 1));
  }, [isLast, cards.length]);

  const goBack = useCallback(() => {
    setCurrentIdx(i => Math.max(i - 1, 0));
  }, []);

  const skipToEnd = useCallback(() => {
    // Jump to the "ready" card (last one)
    setCurrentIdx(cards.length - 1);
  }, [cards.length]);

  // Count remaining required cards the user hasn't addressed yet
  const remainingRequired = useMemo(() => {
    return cards.filter((c, i) => i > currentIdx && c.required && c.kind !== 'ready').length;
  }, [cards, currentIdx]);

  // ── Handlers ──

  const handleApplyCorrections = useCallback(() => {
    const corrections = qtyCheck?.auto_corrections ?? [];
    if (corrections.length === 0) return;

    setHardwareSets(prev =>
      prev.map(set => {
        const setCorrs = corrections.filter(c => c.set_id === set.set_id);
        if (setCorrs.length === 0) return set;
        const updatedItems = (set.items ?? []).map(item => {
          const corr = setCorrs.find(
            c => c.item_name.toLowerCase() === item.name.toLowerCase(),
          );
          if (corr) return { ...item, qty: corr.to_qty, qty_source: "auto_corrected" as const };
          return item;
        });
        return { ...set, items: updatedItems };
      }),
    );
    setCorrectionsApplied(true);
  }, [qtyCheck]);

  const handleAnswerQuestion = useCallback(
    (questionId: string, answer: string, setId?: string, itemName?: string) => {
      setAnswers(prev => ({ ...prev, [questionId]: answer }));

      // Propagate quantity decisions
      if (setId && itemName) {
        const decision = buildDecisionFromAnswer(setId, itemName, answer);
        if (decision) {
          const result = propagateQuantityDecision(decision, hardwareSets);
          if (result.appliedCount > 0) {
            setHardwareSets(result.updatedSets);
          }
        }
      }
    },
    [hardwareSets],
  );

  const handleConfirmSample = useCallback(() => {
    if (!health.bestSample) return;
    setSampleConfirmed(true);
    onGoldenSampleConfirmed({
      set_id: health.bestSample.set_id,
      heading: health.bestSample.heading,
      items: health.bestSample.items,
      confirmed: true,
    });
  }, [health.bestSample, onGoldenSampleConfirmed]);

  // ─── Load prior decisions on mount (for re-imports) ───
  const priorDecisionsLoaded = useRef(false);
  useEffect(() => {
    if (priorDecisionsLoaded.current) return;
    priorDecisionsLoaded.current = true;

    async function loadPrior() {
      try {
        const resp = await fetch(`/api/projects/${projectId}/decisions`);
        if (!resp.ok) return;
        const data = await resp.json();
        const decisions = data.decisions as Array<{
          decision_type: string;
          item_category: string | null;
          set_id: string | null;
          answer: string;
          resolved_value: Record<string, unknown> | null;
        }>;
        if (decisions.length === 0) return;

        // Auto-apply prior answers to matching cards by item category.
        // This is the key for re-imports: "hinges = 3 per leaf" from PDF #1
        // auto-applies to hinge questions in PDF #2.
        const priorAnswers: Record<string, string> = {};
        for (const d of decisions) {
          if (d.decision_type === 'qty_answer' && d.item_category) {
            for (const card of cards) {
              // Match individual question cards by item category
              if (card.kind === 'question') {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const q = card.payload.question as any;
                const cardCategory = classifyItemCategory(q?.item_name ?? '');
                if (cardCategory === d.item_category) {
                  priorAnswers[card.id] = d.answer;
                }
              }
              // Match batch cards by representative item category
              if (card.kind === 'question_batch') {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const rep = card.payload.representative as any;
                const cardCategory = classifyItemCategory(rep?.item_name ?? '');
                if (cardCategory === d.item_category) {
                  priorAnswers[card.id] = d.answer;
                }
              }
            }
          }
          // Also apply prior auto-corrections knowledge
          if (d.decision_type === 'qty_correction' && d.item_category) {
            // If we previously auto-corrected hinges, and there's a new
            // auto_correction card, pre-flag it as known
            for (const card of cards) {
              if (card.kind === 'auto_correction') {
                // Auto-corrections are already batched — just log awareness
                console.debug(`[decisions] Prior correction for ${d.item_category} found`);
              }
            }
          }
        }
        if (Object.keys(priorAnswers).length > 0) {
          setAnswers(prev => ({ ...priorAnswers, ...prev }));
          console.debug(`[decisions] Loaded ${Object.keys(priorAnswers).length} prior decisions`);
        }
      } catch {
        // Non-critical — just skip loading prior decisions
      }
    }
    loadPrior();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // ─── Save decisions to API ───
  const saveDecisions = useCallback(async () => {
    const decisionsToSave: Array<Record<string, unknown>> = [];

    // Save auto-corrections
    if (correctionsApplied) {
      for (const c of qtyCheck?.auto_corrections ?? []) {
        decisionsToSave.push({
          decision_type: 'qty_correction',
          item_category: classifyItemCategory(c.item_name),
          set_id: c.set_id,
          item_name: c.item_name,
          answer: 'auto_applied',
          resolved_value: { from_qty: c.from_qty, to_qty: c.to_qty, reason: c.reason },
          applied_count: 1,
        });
      }
    }

    // Save user answers to quantity questions
    for (const card of cards) {
      if (card.kind === 'question' && answers[card.id]) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const q = card.payload.question as any;
        decisionsToSave.push({
          decision_type: 'qty_answer',
          item_category: classifyItemCategory(q.item_name ?? ''),
          set_id: q.set_id,
          item_name: q.item_name,
          question_text: q.text,
          answer: answers[card.id],
          resolved_value: { current_qty: q.current_qty },
          applied_count: 1,
        });
      }
      if (card.kind === 'question_batch' && answers[card.id]) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rep = card.payload.representative as any;
        const setIds = (card.payload.setIds ?? []) as string[];
        decisionsToSave.push({
          decision_type: 'qty_answer',
          item_category: classifyItemCategory(rep.item_name ?? ''),
          item_name: rep.item_name,
          question_text: rep.text,
          answer: answers[card.id],
          applied_count: setIds.length,
        });
      }
    }

    // Save golden sample verification
    if (sampleConfirmed && health.bestSample) {
      decisionsToSave.push({
        decision_type: 'sample_verification',
        set_id: health.bestSample.set_id,
        answer: 'confirmed',
        resolved_value: {
          items: (health.bestSample.items ?? []).map(i => ({
            name: i.name, qty: i.qty,
          })),
        },
        applied_count: 1,
      });
    }

    if (decisionsToSave.length === 0) return;

    try {
      await fetch(`/api/projects/${projectId}/decisions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decisions: decisionsToSave }),
      });
      console.debug(`[decisions] Saved ${decisionsToSave.length} decisions`);
    } catch (err) {
      console.error('Failed to save decisions:', err);
    }
  }, [cards, answers, correctionsApplied, sampleConfirmed, qtyCheck, health, projectId]);

  const handleFinish = useCallback(() => {
    // Save decisions asynchronously (non-blocking)
    saveDecisions();

    // Collect triage questions from cards (now batched)
    const triageQs: PunchQuestion[] = cards
      .filter(c => c.kind === "triage_question")
      .flatMap(c => {
        const questions = (c.payload.questions ?? []) as PunchQuestion[];
        return questions.map(q => ({ ...q, answer: answers[q.id] }));
      });

    onComplete({
      hardwareSets,
      questionsAnswered: answers,
      triageQuestions: triageQs,
    });
  }, [cards, answers, hardwareSets, onComplete, saveDecisions]);

  // ── Card renderers ──

  if (!currentCard) return null;

  const pdfPreview =
    currentCard.pdfPageIndex != null && pdfBuffer ? (
      <PDFPagePreview
        pdfBuffer={pdfBuffer}
        pageIndex={currentCard.pdfPageIndex}
        collapsible
        label={`PDF Page ${currentCard.pdfPageIndex + 1}`}
      />
    ) : null;

  return (
    <div>
      {renderCard(currentCard, {
    cards,
    currentIdx,
    pdfPreview,
    health,
    hardwareSets,
    correctionsApplied,
    answers,
    sampleConfirmed,
    setsExpanded,
    deepExtracting,
    goNext,
    goBack,
    onBack,
    skipToEnd,
    remainingRequired,
    setSetsExpanded,
    handleApplyCorrections,
    handleAnswerQuestion,
    handleConfirmSample,
    handleFinish,
    onDeepExtract,
  })}
      {/* Skip to Triage shortcut — shown when no required cards remain */}
      {currentCard.kind !== 'summary' && currentCard.kind !== 'ready' && remainingRequired === 0 && (
        <div className="text-center mt-3">
          <button
            onClick={handleFinish}
            className="text-xs text-accent hover:text-accent/80 underline transition-colors"
          >
            Skip remaining and go to Triage
          </button>
        </div>
      )}
    </div>
  );
}

// ── Card renderer (separate function to keep component clean) ──

interface RenderContext {
  cards: PunchCardData[];
  currentIdx: number;
  pdfPreview: React.ReactNode;
  health: ReturnType<typeof computeExtractionHealth>;
  hardwareSets: HardwareSet[];
  correctionsApplied: boolean;
  answers: Record<string, string>;
  sampleConfirmed: boolean;
  setsExpanded: boolean;
  deepExtracting: boolean;
  goNext: () => void;
  goBack: () => void;
  onBack: () => void;
  skipToEnd: () => void;
  remainingRequired: number;
  setSetsExpanded: (v: boolean) => void;
  handleApplyCorrections: () => void;
  handleAnswerQuestion: (id: string, answer: string, setId?: string, itemName?: string) => void;
  handleConfirmSample: () => void;
  handleFinish: () => void;
  onDeepExtract: () => void;
}

function renderCard(card: PunchCardData, ctx: RenderContext) {
  const total = ctx.cards.length;
  const current = ctx.currentIdx + 1;
  const isFirst = ctx.currentIdx === 0;
  const isLast = ctx.currentIdx >= ctx.cards.length - 1;

  switch (card.kind) {
    // ── Summary Card ──
    case "summary": {
      const p = card.payload as {
        doorCount: number; setCount: number; itemCount: number;
        assignedDoors: number; unassignedDoors: number; emptySetCount: number;
        missingSetIds: string[]; grade: string;
        sets: Array<{ set_id: string; heading: string; itemCount: number }>;
      };
      return (
        <PunchCard
          type="summary"
          title={card.title}
          current={current}
          total={total}
          primaryAction={{ label: "Continue", onClick: ctx.goNext }}
          secondaryAction={isFirst ? { label: "Back to Columns", onClick: ctx.onBack, variant: "ghost" } : { label: "Back", onClick: ctx.goBack, variant: "ghost" }}
        >
          <div className="space-y-4">
            {/* Big numbers */}
            <div className="grid grid-cols-3 gap-2">
              <div className="bg-tint border border-border-dim rounded-xl p-3 text-center">
                <div className="text-xl font-bold text-success">{p.doorCount}</div>
                <div className="text-[9px] text-tertiary uppercase tracking-wide">Doors</div>
              </div>
              <div className="bg-tint border border-border-dim rounded-xl p-3 text-center">
                <div className="text-xl font-bold text-accent">{p.setCount}</div>
                <div className="text-[9px] text-tertiary uppercase tracking-wide">HW Sets</div>
              </div>
              <div className={`bg-tint border rounded-xl p-3 text-center ${p.grade === "critical" ? "border-danger" : p.grade === "warning" ? "border-warning" : "border-border-dim"}`}>
                <div className={`text-xl font-bold ${p.grade === "critical" ? "text-danger" : p.grade === "warning" ? "text-warning" : "text-success"}`}>
                  {p.itemCount}
                </div>
                <div className="text-[9px] text-tertiary uppercase tracking-wide">HW Items</div>
              </div>
            </div>

            {/* Coverage */}
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs px-1">
              <span className="text-secondary">Doors with HW set</span>
              <span className="text-primary">
                {p.assignedDoors} / {p.doorCount}
                {p.unassignedDoors > 0 && <span className="text-warning ml-1">({p.unassignedDoors} unassigned)</span>}
              </span>
              <span className="text-secondary">Sets with items</span>
              <span className="text-primary">
                {p.setCount - p.emptySetCount} / {p.setCount}
                {p.emptySetCount > 0 && <span className="text-danger ml-1">({p.emptySetCount} empty)</span>}
              </span>
            </div>

            {/* Missing sets */}
            {p.missingSetIds.length > 0 && (
              <div className="bg-warning-dim border border-warning rounded-lg p-2.5">
                <span className="text-warning text-xs font-semibold">Missing Sets: </span>
                <span className="text-xs text-secondary">{p.missingSetIds.join(", ")}</span>
              </div>
            )}

            {/* Expandable set list */}
            <button
              onClick={() => ctx.setSetsExpanded(!ctx.setsExpanded)}
              className="text-xs text-accent font-medium"
            >
              {ctx.setsExpanded ? "Hide set details \u25BE" : `View all ${p.setCount} sets \u25B4`}
            </button>
            {ctx.setsExpanded && (
              <div className="space-y-1 max-h-48 overflow-y-auto">
                {p.sets.map(s => (
                  <div key={s.set_id} className={`flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs ${s.itemCount === 0 ? "bg-danger-dim border border-danger" : "bg-tint border border-border-dim"}`}>
                    <div className="flex items-center gap-2 min-w-0">
                      <span className={`font-mono font-medium ${s.itemCount === 0 ? "text-danger" : "text-accent"}`}>{s.set_id}</span>
                      {s.heading && <span className="text-tertiary truncate max-w-[180px]">{s.heading}</span>}
                    </div>
                    <span className={`font-semibold whitespace-nowrap ${s.itemCount === 0 ? "text-danger" : "text-secondary"}`}>
                      {s.itemCount === 0 ? "0 items" : `${s.itemCount} item${s.itemCount !== 1 ? "s" : ""}`}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </PunchCard>
      );
    }

    // ── Empty Sets Card ──
    case "empty_sets": {
      const p = card.payload as { emptySets: Array<{ set_id: string; heading: string }>; totalSets: number };
      return (
        <PunchCard
          type="empty_sets"
          title={card.title}
          current={current}
          total={total}
          primaryAction={{
            label: ctx.deepExtracting ? "Extracting..." : `Extract with AI (${p.emptySets.length} set${p.emptySets.length !== 1 ? "s" : ""})`,
            onClick: ctx.onDeepExtract,
            disabled: ctx.deepExtracting,
          }}
          onSkip={ctx.goNext}
        >
          <div className="space-y-3">
            <p className="text-secondary text-sm">
              These sets were found in the PDF but the table reader couldn&apos;t parse their items. AI extraction can usually recover them.
            </p>
            <div className="flex flex-wrap gap-1.5">
              {p.emptySets.map(s => (
                <span key={s.set_id} className="font-mono text-xs px-2 py-0.5 rounded bg-danger-dim text-danger border border-danger">
                  {s.set_id}
                </span>
              ))}
            </div>
            {ctx.deepExtracting && (
              <div className="flex items-center gap-2 py-2">
                <div className="w-4 h-4 border-2 border-accent border-t-transparent rounded-full animate-spin" />
                <span className="text-accent text-xs">Punchy is reading the PDF and extracting items...</span>
              </div>
            )}
          </div>
        </PunchCard>
      );
    }

    // ── Calibration Card ──
    case "calibration": {
      const sample = (card.payload as { sample: NonNullable<ReturnType<typeof computeExtractionHealth>["bestSample"]> }).sample;
      return (
        <PunchCard
          type="calibration"
          title={card.title}
          current={current}
          total={total}
          pdfPreview={ctx.pdfPreview}
          primaryAction={
            ctx.sampleConfirmed
              ? { label: "Continue", onClick: ctx.goNext, variant: "primary" }
              : { label: "Looks Good", onClick: () => { ctx.handleConfirmSample(); ctx.goNext(); }, variant: "success" }
          }
          onSkip={ctx.goNext}
        >
          <div className="space-y-3">
            <p className="text-secondary text-sm">
              We extracted items for set <span className="text-accent font-mono font-medium">{sample.set_id}</span>.
              Confirm it looks correct — we&apos;ll use it as a reference for AI extraction.
            </p>
            {sample.door && (
              <div className="flex gap-3 text-xs">
                <span className="text-secondary">Door:</span>
                <span className="text-primary font-mono">{sample.door.door_number}</span>
                {sample.door.location && (
                  <>
                    <span className="text-secondary">Location:</span>
                    <span className="text-primary">{sample.door.location}</span>
                  </>
                )}
              </div>
            )}
            <div className="space-y-0.5 max-h-40 overflow-y-auto">
              {(sample.items ?? []).map((item, i) => (
                <div key={`${item.name}-${i}`} className="flex items-center gap-2 px-2 py-1 rounded bg-tint text-xs">
                  <span className="text-tertiary w-6 text-right">{item.qty}x</span>
                  <span className="text-primary flex-1">{item.name}</span>
                  <span className="text-tertiary">{item.manufacturer}</span>
                </div>
              ))}
            </div>
            {ctx.sampleConfirmed && (
              <div className="flex items-center gap-2 text-success text-xs font-semibold">
                <span aria-label="Checkmark">✓</span> Sample verified
              </div>
            )}
          </div>
        </PunchCard>
      );
    }

    // ── Auto-Correction Card ──
    case "auto_correction": {
      const corrections = (card.payload as { corrections: NonNullable<PunchyQuantityCheck["auto_corrections"]> }).corrections;
      return (
        <PunchCard
          type="auto_correction"
          title={card.title}
          current={current}
          total={total}
          primaryAction={
            ctx.correctionsApplied
              ? { label: "Continue", onClick: ctx.goNext }
              : { label: "Apply All Corrections", onClick: () => { ctx.handleApplyCorrections(); }, variant: "success" }
          }
          secondaryAction={ctx.currentIdx > 0 ? { label: "Back", onClick: ctx.goBack, variant: "ghost" } : undefined}
        >
          <div className="space-y-2">
            <p className="text-secondary text-sm">
              Punchy is confident about these fixes:
            </p>
            {corrections.map((c, i) => (
              <div key={`ac-${i}`} className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-success-dim text-xs">
                <span className="text-success">&#10003;</span>
                <span className="text-accent font-mono font-medium">{c.set_id}</span>
                <span className="text-primary">{c.item_name}:</span>
                <span className="text-danger line-through">{c.from_qty}</span>
                <span className="text-secondary">&rarr;</span>
                <span className="text-success font-semibold">{c.to_qty}</span>
              </div>
            ))}
            {ctx.correctionsApplied && (
              <div className="flex items-center gap-2 text-success text-xs font-semibold mt-2">
                <span aria-label="Checkmark">✓</span> {corrections.length} correction{corrections.length !== 1 ? "s" : ""} applied
              </div>
            )}
          </div>
        </PunchCard>
      );
    }

    // ── Quantity Question Card ──
    case "question": {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const q = card.payload.question as any;
      const answered = ctx.answers[q.id];
      return (
        <PunchCard
          type="question"
          title={card.title}
          current={current}
          total={total}
          pdfPreview={ctx.pdfPreview}
          primaryAction={answered ? { label: "Continue", onClick: ctx.goNext } : undefined}
          secondaryAction={ctx.currentIdx > 0 ? { label: "Back", onClick: ctx.goBack, variant: "ghost" } : undefined}
          required
        >
          <div className="space-y-3">
            <p className="text-primary text-sm leading-relaxed">{q.text}</p>
            {q.context && <p className="text-tertiary text-xs">{q.context}</p>}
            <div className="text-xs text-secondary mb-2">
              Currently: <span className="font-mono text-primary">{q.current_qty}</span>
            </div>
            <div className="flex flex-wrap gap-2">
              {(q.options as string[]).map((opt: string) => (
                <button
                  key={opt}
                  onClick={() => ctx.handleAnswerQuestion(q.id, opt, q.set_id, q.item_name)}
                  className={`px-3 py-2 rounded-lg border text-sm font-medium transition-colors ${
                    answered === opt
                      ? "bg-accent text-white border-accent"
                      : "bg-tint border-border-dim text-primary hover:bg-tint-strong"
                  }`}
                >
                  {opt}
                </button>
              ))}
            </div>
            {answered && (
              <div className="flex items-center gap-2 text-success text-xs font-semibold">
                <span aria-label="Checkmark">✓</span> Answered: {answered}
              </div>
            )}
          </div>
        </PunchCard>
      );
    }

    // ── Batched Quantity Question Card ──
    case "question_batch": {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const representative = card.payload.representative as any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const questions = card.payload.questions as any[];
      const setIds = (card.payload.setIds ?? []) as string[];
      const answered = ctx.answers[card.id];
      return (
        <PunchCard
          type="question"
          title={card.title}
          current={current}
          total={total}
          pdfPreview={ctx.pdfPreview}
          primaryAction={answered ? { label: "Continue", onClick: ctx.goNext } : undefined}
          secondaryAction={ctx.currentIdx > 0 ? { label: "Back", onClick: ctx.goBack, variant: "ghost" } : undefined}
          required
        >
          <div className="space-y-3">
            <p className="text-primary text-sm leading-relaxed">{representative.text}</p>
            {representative.context && <p className="text-tertiary text-xs">{representative.context}</p>}
            <div className="bg-tint border border-border-dim rounded-lg p-2.5">
              <div className="text-[10px] text-tertiary uppercase tracking-wide mb-1.5 font-semibold">
                Affects {setIds.length} sets
              </div>
              <div className="flex flex-wrap gap-1">
                {setIds.map((id: string) => (
                  <span key={id} className="font-mono text-xs px-1.5 py-0.5 rounded bg-accent-dim text-accent">
                    {id}
                  </span>
                ))}
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {(representative.options as string[]).map((opt: string) => (
                <button
                  key={opt}
                  onClick={() => {
                    // Answer the batch — apply to ALL questions in the group
                    for (const q of questions) {
                      ctx.handleAnswerQuestion(q.id, opt, q.set_id, q.item_name);
                    }
                    // Also store under the batch card ID for UI state
                    ctx.handleAnswerQuestion(card.id, opt);
                  }}
                  className={`px-3 py-2 rounded-lg border text-sm font-medium transition-colors ${
                    answered === opt
                      ? "bg-accent text-white border-accent"
                      : "bg-tint border-border-dim text-primary hover:bg-tint-strong"
                  }`}
                >
                  {opt}
                </button>
              ))}
            </div>
            {answered && (
              <div className="flex items-center gap-2 text-success text-xs font-semibold">
                <span aria-label="Checkmark">✓</span> Applied to {setIds.length} sets: {answered}
              </div>
            )}
          </div>
        </PunchCard>
      );
    }

    // ── Triage Questions Card (batched — all on one card) ──
    case "triage_question": {
      const questions = (card.payload.questions ?? []) as PunchQuestion[];
      const allAnswered = questions.every(q => ctx.answers[q.id]);
      return (
        <PunchCard
          type="question"
          title={card.title}
          current={current}
          total={total}
          primaryAction={{ label: "Continue", onClick: ctx.goNext }}
          secondaryAction={ctx.currentIdx > 0 ? { label: "Back", onClick: ctx.goBack, variant: "ghost" } : undefined}
          onSkip={ctx.goNext}
        >
          <div className="space-y-3">
            {questions.map(q => {
              const qAnswered = ctx.answers[q.id];
              return (
                <div key={q.id} className={`p-2.5 rounded-lg border ${qAnswered ? "bg-success-dim border-success" : "bg-tint border-border-dim"}`}>
                  <p className="text-primary text-sm mb-2">{q.text}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {q.options.map(opt => (
                      <button
                        key={opt}
                        onClick={() => ctx.handleAnswerQuestion(q.id, opt)}
                        className={`px-2.5 py-1.5 rounded-lg border text-xs font-medium transition-colors ${
                          qAnswered === opt
                            ? "bg-accent text-white border-accent"
                            : "bg-tint border-border-dim text-primary hover:bg-tint-strong"
                        }`}
                      >
                        {opt}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
            {allAnswered && (
              <div className="flex items-center gap-2 text-success text-xs font-semibold">
                <span aria-label="Checkmark">✓</span> All {questions.length} questions answered
              </div>
            )}
          </div>
        </PunchCard>
      );
    }

    // ── Compliance Card (batched) ──
    case "compliance": {
      const issues = (card.payload.issues ?? [card.payload.issue].filter(Boolean)) as NonNullable<PunchyQuantityCheck["compliance_issues"]>;
      return (
        <PunchCard
          type="compliance"
          title={card.title}
          current={current}
          total={total}
          pdfPreview={ctx.pdfPreview}
          primaryAction={{ label: "Acknowledged", onClick: ctx.goNext }}
          secondaryAction={ctx.currentIdx > 0 ? { label: "Back", onClick: ctx.goBack, variant: "ghost" } : undefined}
        >
          <div className="space-y-2">
            {issues.map((ci, i) => (
              <div key={`ci-${i}`} className="bg-danger-dim border border-danger rounded-lg p-3">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-danger font-mono text-xs font-medium">{ci.set_id}</span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-semibold ${ci.severity === 'error' ? 'bg-danger-dim text-danger' : ci.severity === 'warning' ? 'bg-warning-dim text-warning' : 'bg-accent-dim text-accent'}`}>
                    {ci.severity}
                  </span>
                </div>
                <p className="text-primary text-sm">{ci.issue}</p>
                {ci.regulation && (
                  <p className="text-tertiary text-xs mt-1">{ci.regulation}</p>
                )}
              </div>
            ))}
          </div>
        </PunchCard>
      );
    }

    // ── Flags Card ──
    case "flag": {
      const flags = (card.payload.flags ?? []) as NonNullable<PunchyQuantityCheck["flags"]>;
      return (
        <PunchCard
          type="flag"
          title={card.title}
          current={current}
          total={total}
          primaryAction={{ label: "Continue", onClick: ctx.goNext }}
          secondaryAction={ctx.currentIdx > 0 ? { label: "Back", onClick: ctx.goBack, variant: "ghost" } : undefined}
          onSkip={ctx.goNext}
        >
          <div className="space-y-1.5">
            <p className="text-secondary text-sm mb-2">
              These may be fine — just worth knowing about:
            </p>
            {flags.map((f, i) => (
              <div key={`fl-${i}`} className="text-xs text-secondary px-2.5 py-1.5 bg-warning-dim border border-warning rounded-lg">
                <span className="text-warning font-mono mr-1">{f.set_id}</span>
                {f.message ?? f.reason ?? ""}
              </div>
            ))}
          </div>
        </PunchCard>
      );
    }

    // ── Ready Card ──
    case "ready": {
      const p = card.payload as { doorCount: number; setCount: number };
      return (
        <PunchCard
          type="ready"
          title={card.title}
          current={current}
          total={total}
          primaryAction={{ label: "Continue to Triage", onClick: ctx.handleFinish, variant: "success" }}
          secondaryAction={ctx.currentIdx > 0 ? { label: "Back", onClick: ctx.goBack, variant: "ghost" } : undefined}
        >
          <div className="text-center py-4">
            <div className="text-4xl mb-3">&#10003;</div>
            <p className="text-primary text-sm font-medium mb-1">
              Review complete
            </p>
            <p className="text-tertiary text-xs">
              {p.doorCount} doors and {p.setCount} hardware sets ready for triage classification.
            </p>
          </div>
        </PunchCard>
      );
    }

    default:
      return null;
  }
}
