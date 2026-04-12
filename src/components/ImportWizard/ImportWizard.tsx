"use client";

import { useState, useCallback, useEffect, useMemo } from "react";
import {
  WizardStep,
  WizardState,
  INITIAL_WIZARD_STATE,
  type ClassifyPagesResponse,
  type DetectMappingResponse,
  type ColumnMapping,
  type TriageResult,
  type DoorEntry,
  type HardwareSet,
} from "./types";
import StepUpload from "./StepUpload";
import StepScanResults from "./StepScanResults";
import StepMapColumns from "./StepMapColumns";
import StepTriage from "./StepTriage";
import StepReview from "./StepReview";
import StepProducts from "./StepProducts";
import StepConfirm from "./StepConfirm";
import StepCompare from "./StepCompare";
import PunchAssistant from "./PunchAssistant";
import { PunchHighlightProvider } from "./usePunchHighlight";
import {
  classifyMessages,
  mapColumnsMessages,
  triageMessages,
  reviewMessages,
  confirmMessages,
  type PunchMessage,
  type PunchQuestion,
} from "@/lib/punch-messages";

// ─── Step indicator ───

// All steps with their enum values. Compare is conditionally shown for revisions.
const ALL_STEPS: Array<{ label: string; step: WizardStep }> = [
  { label: "Upload", step: WizardStep.Upload },
  { label: "Scan Results", step: WizardStep.ScanResults },
  { label: "Map Columns", step: WizardStep.MapColumns },
  { label: "Triage", step: WizardStep.Triage },
  { label: "Review", step: WizardStep.Review },
  { label: "Products", step: WizardStep.Products },
  { label: "Compare", step: WizardStep.Compare },
  { label: "Confirm", step: WizardStep.Confirm },
];

function StepIndicator({ currentStep, hasExistingData }: { currentStep: WizardStep; hasExistingData: boolean }) {
  const visibleSteps = hasExistingData ? ALL_STEPS : ALL_STEPS.filter(s => s.step !== WizardStep.Compare);
  // Mobile: show only current step name
  const currentLabel = visibleSteps.find(s => s.step === currentStep)?.label ?? "";
  const currentIdx = visibleSteps.findIndex(s => s.step === currentStep);
  return (
    <>
      {/* Desktop: breadcrumb stepper */}
      <div className="hidden sm:flex items-center gap-1">
        {visibleSteps.map(({ label, step }, i) => (
          <div key={label} className="flex items-center gap-1">
            <span
              className={`text-xs transition-colors ${
                step < currentStep
                  ? "text-tertiary"
                  : step === currentStep
                  ? "text-accent font-semibold"
                  : "text-tertiary/50"
              }`}
            >
              {step < currentStep ? `\u2713 ${label}` : label}
            </span>
            {i < visibleSteps.length - 1 && (
              <span className="text-tertiary/30 text-xs">\u2192</span>
            )}
          </div>
        ))}
      </div>
      {/* Mobile: current step only */}
      <div className="flex sm:hidden items-center gap-2 text-xs">
        <span className="text-tertiary">{currentIdx + 1}/{visibleSteps.length}</span>
        <span className="text-accent font-semibold">{currentLabel}</span>
      </div>
    </>
  );
}

// ─── Props ───

interface ImportWizardProps {
  projectId: string;
  onClose: () => void;
  onSuccess: () => void;
}

// ─── Main orchestrator ───

export default function ImportWizard({
  projectId,
  onClose,
  onSuccess,
}: ImportWizardProps) {
  const [state, setState] = useState<WizardState>(INITIAL_WIZARD_STATE);
  const [saveResult, setSaveResult] = useState<{
    openingsCount?: number;
    itemsCount?: number;
  } | null>(null);

  // ─── Triage validation questions ───
  const [triageQuestions, setTriageQuestions] = useState<PunchQuestion[]>([]);
  const [dismissStreak, setDismissStreak] = useState(0);
  const [questionsSuppressed, setQuestionsSuppressed] = useState(false);

  // Derived: answers keyed by question id
  const questionAnswers: Record<string, string> = useMemo(() => {
    const out: Record<string, string> = {};
    for (const q of triageQuestions) {
      if (q.answer) out[q.id] = q.answer;
    }
    return out;
  }, [triageQuestions]);

  const handleQuestionsGenerated = useCallback(
    (questions: PunchQuestion[]) => {
      if (questionsSuppressed) return;
      setTriageQuestions(questions);
      setDismissStreak(0);
    },
    [questionsSuppressed]
  );

  const handleQuestionAnswer = useCallback(
    (questionId: string, answer: string) => {
      setTriageQuestions((prev) =>
        prev.map((q) => (q.id === questionId ? { ...q, answer } : q))
      );
      // Answering resets the dismiss streak
      setDismissStreak(0);
    },
    []
  );

  const handleQuestionDismiss = useCallback(
    (questionId: string) => {
      setTriageQuestions((prev) =>
        prev.map((q) =>
          q.id === questionId ? { ...q, dismissed: true } : q
        )
      );
      const newStreak = dismissStreak + 1;
      setDismissStreak(newStreak);
      if (newStreak >= 3) {
        // Suppress all remaining unanswered questions
        setQuestionsSuppressed(true);
        setTriageQuestions((prev) =>
          prev.map((q) =>
            !q.answer && !q.dismissed ? { ...q, dismissed: true } : q
          )
        );
      }
    },
    [dismissStreak]
  );

  // Clear questions when leaving the triage step
  useEffect(() => {
    if (state.currentStep !== WizardStep.Triage) {
      setTriageQuestions([]);
      setDismissStreak(0);
      setQuestionsSuppressed(false);
    }
  }, [state.currentStep]);

  // Cache PDF buffer once (for PDFPagePreview in StepReview + elsewhere)
  useEffect(() => {
    if (state.file && !state.pdfBuffer) {
      state.file.arrayBuffer().then((buf) => {
        setState((prev) => ({ ...prev, pdfBuffer: buf }));
      }).catch((err) => {
        console.warn("Failed to cache PDF buffer:", err);
      });
    }
  }, [state.file, state.pdfBuffer]);

  // ─── Punch messages derived from wizard state ───

  const punchMessages: PunchMessage[] = useMemo(() => {
    switch (state.currentStep) {
      case WizardStep.Upload: {
        return [];
      }
      case WizardStep.ScanResults: {
        if (!state.classifyResult) return [];
        const summary = state.classifyResult.summary;
        return classifyMessages({
          totalPages: summary.total_pages,
          doorSchedulePages: summary.door_schedule_pages.length,
          hardwareSetPages: summary.hardware_set_pages.length,
          scannedPages: summary.scanned_pages ?? 0,
        });
      }
      case WizardStep.MapColumns: {
        if (!state.detectResult) return [];
        const scores: Record<string, number> = {};
        for (const col of state.detectResult.columns) {
          if (col.mapped_field) scores[col.mapped_field] = col.confidence;
        }
        return mapColumnsMessages({ confidenceScores: scores });
      }
      case WizardStep.Triage: {
        if (!state.triageResult) return [];
        return triageMessages({
          extractedDoors: state.triageResult.doors_found,
          extractedSets: state.hardwareSets.length,
          byOthersCount: state.triageResult.by_others,
          rejectedCount: state.triageResult.rejected,
        });
      }
      case WizardStep.Review: {
        return reviewMessages(
          state.doors.map((d) => ({
            doorNumber: d.door_number,
            fieldConfidence: d.field_confidence,
          }))
        );
      }
      case WizardStep.Products: {
        return [{
          severity: 'info' as const,
          text: 'Review product families grouped by manufacturer and series. Resolve any flagged typos.',
        }];
      }
      case WizardStep.Compare: {
        return [{
          severity: 'info' as const,
          text: 'Comparing your revised submittal against the existing project data. Review each category of changes before applying.',
        }];
      }
      case WizardStep.Confirm: {
        if (saveResult) {
          return confirmMessages({
            mode: "post-save",
            savedCount: saveResult.openingsCount,
          });
        }
        return confirmMessages({
          mode: state.hasExistingData ? "revision" : "fresh",
          doorCount: state.doors.length,
          hardwareItemCount: state.hardwareSets.reduce(
            (sum, s) => sum + (s.items ?? []).length,
            0
          ),
        });
      }
      default:
        return [];
    }
  }, [state, saveResult]);

  // Keys for DOM highlight (inline messages with field/rowId)
  const activeKeys = useMemo(
    () =>
      punchMessages
        .filter((m) => m.inline)
        .map((m) => m.field ?? m.rowId)
        .filter((k): k is string => !!k),
    [punchMessages]
  );

  // ─── State helpers ───

  const patch = useCallback(
    (partial: Partial<WizardState>) =>
      setState((prev) => ({ ...prev, ...partial })),
    []
  );

  const goToStep = useCallback(
    (step: WizardStep) => patch({ currentStep: step, error: null }),
    [patch]
  );

  // ─── Step 1 complete: file classified → show scan results ───
  const onUploadComplete = useCallback(
    (
      file: File,
      classifyResult: ClassifyPagesResponse,
      hasExistingData: boolean,
      pdfStoragePath: string | null,
    ) => {
      patch({
        file,
        pdfStoragePath,
        classifyResult,
        hasExistingData,
        currentStep: WizardStep.ScanResults,
      });
    },
    [patch]
  );

  // ─── Step 2 complete: columns mapped ───
  const onMapColumnsComplete = useCallback(
    (
      detectResult: DetectMappingResponse,
      columnMappings: ColumnMapping[]
    ) => {
      patch({
        detectResult,
        columnMappings,
        currentStep: WizardStep.Triage,
      });
    },
    [patch]
  );

  // ─── Step 3 complete: triage done ───
  const onTriageComplete = useCallback(
    (
      triageResult: TriageResult,
      doors: DoorEntry[],
      hardwareSets: HardwareSet[]
    ) => {
      patch({
        triageResult,
        doors,
        hardwareSets,
        currentStep: WizardStep.Review,
      });
    },
    [patch]
  );

  // ─── Step 4 complete: review done → Products ───
  const onReviewComplete = useCallback(
    (doors: DoorEntry[], hardwareSets: HardwareSet[]) => {
      patch({
        doors,
        hardwareSets,
        currentStep: WizardStep.Products,
      });
    },
    [patch]
  );

  // ─── Step 5 complete: products reviewed → Compare (revision) or Confirm (fresh) ───
  const onProductsComplete = useCallback(
    (hardwareSets: HardwareSet[]) => {
      patch({
        hardwareSets,
        currentStep: state.hasExistingData ? WizardStep.Compare : WizardStep.Confirm,
      });
    },
    [patch, state.hasExistingData]
  );

  // ─── Step 5 complete: saved ───
  const onConfirmComplete = useCallback(() => {
    onSuccess();
    onClose();
  }, [onSuccess, onClose]);

  // ─── Render ───

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-lg flex flex-col z-50">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-border-dim-strong">
        <h2 className="text-lg font-semibold text-primary">
          Import Wizard
        </h2>
        <div className="flex items-center gap-4">
          <StepIndicator currentStep={state.currentStep} hasExistingData={state.hasExistingData} />
          <button
            onClick={onClose}
            className="text-tertiary hover:text-primary text-xl leading-none transition-colors ml-4"
          >
            &times;
          </button>
        </div>
      </div>

      {/* Error banner */}
      {state.error && (
        <div className="mx-6 mt-4 p-3 bg-danger-dim border border-danger rounded-xl text-danger text-sm">
          {state.error}
        </div>
      )}

      {/* Step content — drawer is now INSIDE the scroller, anchored to top */}
      <PunchHighlightProvider activeKeys={activeKeys}>
        <div className="flex-1 overflow-y-auto min-h-0 flex flex-col">
          {/* Punchy drawer sticks to top of content area during non-Triage steps */}
          {state.currentStep !== WizardStep.Triage && (
            <PunchAssistant
              messages={punchMessages}
              questions={triageQuestions}
              onAnswer={handleQuestionAnswer}
              onDismiss={handleQuestionDismiss}
            />
          )}
          <div className="px-6 py-4 pb-6">
            {state.currentStep === WizardStep.Upload && (
              <StepUpload
                projectId={projectId}
                onComplete={onUploadComplete}
                onError={(err) => patch({ error: err })}
              />
            )}

            {state.currentStep === WizardStep.ScanResults && state.classifyResult && (
              <StepScanResults
                classifyResult={state.classifyResult}
                onNext={() => goToStep(WizardStep.MapColumns)}
                onBack={() => goToStep(WizardStep.Upload)}
              />
            )}

            {state.currentStep === WizardStep.MapColumns && (
              <StepMapColumns
                file={state.file!}
                classifyResult={state.classifyResult!}
                onComplete={onMapColumnsComplete}
                onBack={() => goToStep(WizardStep.ScanResults)}
                onError={(err) => patch({ error: err })}
              />
            )}

            {state.currentStep === WizardStep.Triage && (
              <StepTriage
                projectId={projectId}
                file={state.file!}
                pdfStoragePath={state.pdfStoragePath}
                columnMappings={state.columnMappings}
                classifyResult={state.classifyResult!}
                questionAnswers={questionAnswers}
                onComplete={onTriageComplete}
                onQuestionsGenerated={handleQuestionsGenerated}
                onBack={() => goToStep(WizardStep.MapColumns)}
                onError={(err) => patch({ error: err })}
              />
            )}

            {state.currentStep === WizardStep.Review && (
              <StepReview
                projectId={projectId}
                doors={state.doors}
                hardwareSets={state.hardwareSets}
                hasExistingData={state.hasExistingData}
                classifyResult={state.classifyResult}
                pdfBuffer={state.pdfBuffer}
                onComplete={onReviewComplete}
                onBack={() => goToStep(WizardStep.Triage)}
                onRemapColumns={() => goToStep(WizardStep.MapColumns)}
              />
            )}

            {state.currentStep === WizardStep.Products && (
              <StepProducts
                hardwareSets={state.hardwareSets}
                onComplete={onProductsComplete}
                onBack={() => goToStep(WizardStep.Review)}
              />
            )}

            {state.currentStep === WizardStep.Compare && (
              <StepCompare
                projectId={projectId}
                doors={state.doors}
                hardwareSets={state.hardwareSets}
                onComplete={onConfirmComplete}
                onBack={() => goToStep(WizardStep.Products)}
                onError={(err) => patch({ error: err })}
              />
            )}

            {state.currentStep === WizardStep.Confirm && (
              <StepConfirm
                projectId={projectId}
                doors={state.doors}
                hardwareSets={state.hardwareSets}
                triageResult={state.triageResult}
                onComplete={onConfirmComplete}
                onBack={() => goToStep(state.hasExistingData ? WizardStep.Compare : WizardStep.Products)}
                onError={(err) => patch({ error: err })}
              />
            )}
          </div>
        </div>
      </PunchHighlightProvider>
    </div>
  );
}
