"use client"

import { useState, useCallback, useRef, useEffect, useMemo } from "react"
import type { UseExtractionJobReturn } from "@/hooks/useExtractionJob"
import WizardNav from "./WizardNav"

// ─── Question definitions ───

interface QuestionDef {
  key: string
  label: string
  helper: string
  type: "number" | "select" | "tags" | "choice"
  options?: string[]
  placeholder?: string
}

const QUESTIONS: QuestionDef[] = [
  {
    key: "opening_count",
    label: "Approximately how many openings are in your scope?",
    helper: "This helps us verify we found all doors in the submittal",
    type: "number",
    placeholder: "e.g. 85",
  },
  {
    key: "fire_rated_pct",
    label: "Roughly what percentage of doors are fire-rated?",
    helper: "Helps catch misread fire ratings",
    type: "select",
    options: [
      "None (0%)",
      "A few (~10-20%)",
      "About half (~50%)",
      "Most (~75%+)",
      "All (100%)",
      "Not sure",
    ],
  },
  {
    key: "manufacturers",
    label: "Who are the primary hardware manufacturers?",
    helper: "Helps identify unexpected manufacturer names in extraction",
    type: "tags",
    options: [
      "Hager",
      "Assa Abloy",
      "Allegion/Schlage",
      "Von Duprin",
      "LCN",
      "Norton",
      "Rixson",
      "Sargent",
      "Corbin Russwin",
      "dormakaba",
    ],
  },
  {
    key: "set_count",
    label: "About how many unique hardware sets are there?",
    helper: "Helps verify set detection completeness",
    type: "number",
    placeholder: "e.g. 12",
  },
  {
    key: "has_pairs",
    label: "Are there any pair (double) doors in this project?",
    helper: "Pair doors need special handling for leaf-specific hardware",
    type: "choice",
    options: ["Yes", "No", "Not sure"],
  },
  {
    key: "source_software",
    label: "What software generated this submittal?",
    helper: "Different software produces different PDF layouts",
    type: "select",
    options: ["Comsense", "OpeningStudio", "Dooracle", "Other", "Not sure"],
  },
]

// ─── Auto-save debounce ───
const DEBOUNCE_MS = 1500

// ─── Component ───

interface StepQuestionsProps {
  job: UseExtractionJobReturn
  onComplete: () => void
  onBack: () => void
  onError: (msg: string) => void
}

export default function StepQuestions({
  job,
  onComplete,
  onBack,
  onError,
}: StepQuestionsProps) {
  const [answers, setAnswers] = useState<Record<string, unknown>>({})
  const [saving, setSaving] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastSavedRef = useRef<string>("")

  // ─── Auto-save answers (debounced) ───
  const saveAnswers = useCallback(
    async (current: Record<string, unknown>) => {
      const serialized = JSON.stringify(current)
      if (serialized === lastSavedRef.current) return

      setSaving(true)
      try {
        await job.submitAnswers(current)
        lastSavedRef.current = serialized
      } catch (err) {
        console.error("Failed to save answers:", err)
      } finally {
        setSaving(false)
      }
    },
    [job],
  )

  const debouncedSave = useCallback(
    (current: Record<string, unknown>) => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(() => saveAnswers(current), DEBOUNCE_MS)
    },
    [saveAnswers],
  )

  // Clean up debounce on unmount + flush pending save
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [])

  const updateAnswer = useCallback(
    (key: string, value: unknown) => {
      setAnswers((prev) => {
        const next = { ...prev, [key]: value }
        debouncedSave(next)
        return next
      })
    },
    [debouncedSave],
  )

  // ─── Manufacturer tags ───
  const toggleTag = useCallback(
    (tag: string) => {
      setAnswers((prev) => {
        const current = (prev.manufacturers as string[]) ?? []
        const next = current.includes(tag)
          ? current.filter((t) => t !== tag)
          : [...current, tag]
        const updated = { ...prev, manufacturers: next }
        debouncedSave(updated)
        return updated
      })
    },
    [debouncedSave],
  )

  // ─── Continue handler ───
  const handleContinue = useCallback(async () => {
    // Flush any pending saves before continuing
    if (debounceRef.current) {
      clearTimeout(debounceRef.current)
      debounceRef.current = null
    }
    await saveAnswers(answers)
    onComplete()
  }, [answers, saveAnswers, onComplete])

  // ─── Retry handler ───
  const handleRetry = useCallback(() => {
    onError("")
    // Parent wizard will trigger a new job creation
    onBack()
  }, [onError, onBack])

  // ─── Progress bar color ───
  const progressColor = useMemo(() => {
    if (job.isFailed) return "bg-danger"
    if (job.isComplete) return "bg-success"
    return "bg-accent"
  }, [job.isFailed, job.isComplete])

  // Detect deep extraction in status message
  const isDeepExtracting = useMemo(() => {
    const msg = (job.statusMessage ?? "").toLowerCase()
    return msg.includes("deep extract") || msg.includes("vision") || msg.includes("cross-validat")
  }, [job.statusMessage])

  return (
    <div className="max-w-2xl mx-auto">
      {/* Header */}
      <h3
        className="text-[11px] font-semibold uppercase text-secondary tracking-wider"
        style={{ fontFamily: "var(--font-display)" }}
      >
        Guided Questions
      </h3>
      <p className="text-sm text-tertiary mt-1 mb-5">
        Answer a few optional questions while we process your submittal. Your
        answers help us validate the extraction results.
      </p>

      {/* ─── Progress section ─── */}
      <div className="glow-card glow-card--blue p-4 mb-6">
        <div className="flex items-center gap-3 mb-2">
          {/* Punchy-style working indicator */}
          <div className="flex-shrink-0 w-8 h-8 rounded-full bg-accent-dim border border-accent/30 flex items-center justify-center">
            {job.isComplete ? (
              <span className="text-success text-sm">&#x2713;</span>
            ) : job.isFailed ? (
              <span className="text-danger text-sm">!</span>
            ) : (
              <span className="text-accent text-xs animate-pulse">&#x2699;</span>
            )}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-2 mb-1">
              <span className="text-sm text-primary font-medium truncate">
                {job.statusMessage ?? "Processing..."}
              </span>
              <div className="flex items-center gap-2 flex-shrink-0">
                {isDeepExtracting && (
                  <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded bg-accent-dim text-accent border border-accent">
                    Deep Extraction
                  </span>
                )}
                <span className="text-xs text-tertiary">
                  {job.progress}%
                </span>
              </div>
            </div>
            <div className="w-full bg-tint rounded-full h-2 overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-700 ease-out ${progressColor}`}
                style={{ width: `${job.progress}%` }}
              />
            </div>
          </div>
        </div>

        {/* Save indicator */}
        {saving && (
          <p className="text-[11px] text-tertiary mt-1 text-right">
            Saving answers...
          </p>
        )}
      </div>

      {/* ─── Error state ─── */}
      {job.isFailed && (
        <div className="p-4 mb-6 bg-danger-dim border border-danger rounded-xl">
          <p className="text-danger text-sm font-medium mb-1">
            Extraction failed
          </p>
          <p className="text-danger/70 text-xs mb-3">
            {job.error ?? "An unexpected error occurred during processing."}
          </p>
          <button
            onClick={handleRetry}
            className="min-h-9 px-4 py-2 bg-danger hover:bg-danger/80 text-white rounded-lg transition-colors text-sm font-medium"
          >
            Retry Upload
          </button>
        </div>
      )}

      {/* ─── Questions ─── */}
      <div className="space-y-4">
        {QUESTIONS.map((q) => (
          <QuestionCard
            key={q.key}
            question={q}
            value={answers[q.key]}
            onUpdate={(val) => updateAnswer(q.key, val)}
            onToggleTag={q.key === "manufacturers" ? toggleTag : undefined}
          />
        ))}
      </div>

      {/* ─── Navigation ─── */}
      <WizardNav
        onBack={onBack}
        onNext={handleContinue}
        nextLabel={
          job.isComplete
            ? "Continue to Review"
            : job.isFailed
            ? "Retry"
            : "Waiting for extraction..."
        }
        nextDisabled={!job.isComplete && !job.isFailed}
        nextVariant={job.isComplete ? "success" : "accent"}
      />
    </div>
  )
}

// ─── Individual question card ───

interface QuestionCardProps {
  question: QuestionDef
  value: unknown
  onUpdate: (value: unknown) => void
  onToggleTag?: (tag: string) => void
}

function QuestionCard({
  question,
  value,
  onUpdate,
  onToggleTag,
}: QuestionCardProps) {
  return (
    <div className="glow-card p-4">
      <label className="block text-sm text-primary font-medium mb-1">
        {question.label}
      </label>
      <p className="text-xs text-tertiary mb-3">{question.helper}</p>

      {question.type === "number" && (
        <input
          type="number"
          min={0}
          placeholder={question.placeholder}
          value={(value as number) ?? ""}
          onChange={(e) => {
            const v = e.target.value
            onUpdate(v === "" ? null : Number(v))
          }}
          className="w-full max-w-[200px] bg-tint border border-border-dim rounded-lg px-3 py-2 text-sm text-primary placeholder:text-tertiary/50 focus:outline-none focus:border-accent/50 transition-colors"
        />
      )}

      {question.type === "select" && (
        <select
          value={(value as string) ?? ""}
          onChange={(e) => onUpdate(e.target.value || null)}
          className="w-full max-w-xs bg-tint border border-border-dim rounded-lg px-3 py-2 text-sm text-primary focus:outline-none focus:border-accent/50 transition-colors appearance-none"
        >
          <option value="">Select...</option>
          {question.options?.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      )}

      {question.type === "tags" && (
        <div className="flex flex-wrap gap-2">
          {question.options?.map((tag) => {
            const selected = Array.isArray(value) && value.includes(tag)
            return (
              <button
                key={tag}
                type="button"
                onClick={() => onToggleTag?.(tag)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border ${
                  selected
                    ? "bg-accent-dim border-accent/50 text-accent"
                    : "bg-tint border-border-dim text-secondary hover:text-primary hover:border-accent/30"
                }`}
              >
                {tag}
              </button>
            )
          })}
        </div>
      )}

      {question.type === "choice" && (
        <div className="flex gap-2">
          {question.options?.map((opt) => {
            const selected = value === opt
            return (
              <button
                key={opt}
                type="button"
                onClick={() => onUpdate(selected ? null : opt)}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors border ${
                  selected
                    ? "bg-accent-dim border-accent/50 text-accent"
                    : "bg-tint border-border-dim text-secondary hover:text-primary hover:border-accent/30"
                }`}
              >
                {opt}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
