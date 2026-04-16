"use client"

import { useState, useCallback, useRef, useEffect, useMemo } from "react"
import type { UseExtractionJobReturn } from "@/hooks/useExtractionJob"
import WizardNav from "./WizardNav"
import DarrinMessage, { DarrinAction } from "./DarrinMessage"

// ─── Auto-save debounce ───
const DEBOUNCE_MS = 1500

// ─── Helpers ───

function formatPageList(pages: number[]): string {
  if (pages.length === 0) return "none"
  if (pages.length <= 6) return pages.join(", ")
  return `${pages.slice(0, 5).join(", ")}, +${pages.length - 5} more`
}

function joinWithAnd(items: string[]): string {
  if (items.length === 0) return ""
  if (items.length === 1) return items[0]
  if (items.length === 2) return `${items[0]} and ${items[1]}`
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`
}

function compactSetIds(setIds: string[]): string {
  if (setIds.length === 0) return ""
  const unique = Array.from(new Set(setIds))
  if (unique.length <= 6) return unique.join(", ")
  return `${unique.slice(0, 5).join(", ")}, +${unique.length - 5} more`
}

// Map each Darrin question to the constraint question_key the backend triage
// route expects (see run/route.ts userHints assembly).
const QUESTION_KEYS = {
  classifyCheck: "classify_check",
  doorCount: "opening_count",
  fireRatedPct: "fire_rated_pct",
  manufacturers: "manufacturers",
  hasPairs: "has_pairs",
  orphans: "orphan_handling",
} as const

// ─── Component ───

interface StepQuestionsProps {
  job: UseExtractionJobReturn
  file: File | null
  onComplete: () => void
  onBack: () => void
  onError: (msg: string) => void
}

export default function StepQuestions({
  job,
  file,
  onComplete,
  onBack,
  onError,
}: StepQuestionsProps) {
  const [answers, setAnswers] = useState<Record<string, unknown>>({})
  const [saving, setSaving] = useState(false)
  const [pdfOpen, setPdfOpen] = useState(false)
  const [doorCountInput, setDoorCountInput] = useState("")
  const [manufacturerInput, setManufacturerInput] = useState("")
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastSavedRef = useRef<string>("")

  const phaseData = job.phaseData
  const { classify, extraction, triage } = phaseData

  // Create a stable blob URL for the PDF file
  const pdfUrl = useMemo(() => {
    if (!file) return null
    return URL.createObjectURL(file)
  }, [file])

  useEffect(() => {
    return () => {
      if (pdfUrl) URL.revokeObjectURL(pdfUrl)
    }
  }, [pdfUrl])

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

  // ─── Continue ───
  const handleContinue = useCallback(async () => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current)
      debounceRef.current = null
    }
    await saveAnswers(answers)
    onComplete()
  }, [answers, saveAnswers, onComplete])

  const handleRetry = useCallback(() => {
    onError("")
    onBack()
  }, [onError, onBack])

  // ─── Progress bar color ───
  const progressColor = useMemo(() => {
    if (job.isFailed) return "bg-danger"
    if (job.isComplete) return "bg-success"
    return "bg-accent"
  }, [job.isFailed, job.isComplete])

  // Darrin picks a worried face when fire ratings look lopsided.
  const triageAvatar = useMemo(() => {
    if (!triage) return "scanning" as const
    if (triage.fire_rated_pct < 20 || triage.fire_rated_pct > 80) return "concerned" as const
    return "scanning" as const
  }, [triage])

  const pairDoorExample = useMemo(() => {
    const first = triage?.pair_doors_detected?.[0]
    if (!first) return ""
    return first.door_b ? `${first.door_a} + ${first.door_b}` : first.door_a
  }, [triage?.pair_doors_detected])

  const orphanNumbers = useMemo(() => {
    const list = triage?.orphan_doors ?? []
    if (list.length === 0) return ""
    const nums = list.map((d) => d.door_number)
    if (nums.length <= 5) return nums.join(", ")
    return `${nums.slice(0, 5).join(", ")}, +${nums.length - 5} more`
  }, [triage?.orphan_doors])

  return (
    <div className="max-w-2xl mx-auto">
      <h3
        className="text-[11px] font-semibold uppercase text-secondary tracking-wider"
        style={{ fontFamily: "var(--font-display)" }}
      >
        Guided Questions
      </h3>
      <p className="text-sm text-tertiary mt-1 mb-5">
        Darrin walks through findings as he picks them up. Answer inline —
        your input feeds the final triage pass.
      </p>

      {/* ─── Progress section ─── */}
      <div className="glow-card glow-card--blue p-4 mb-6">
        <div className="flex items-center gap-3 mb-2">
          {/* Darrin-style working indicator */}
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
              <span className="text-xs text-tertiary flex-shrink-0">
                {job.progress}%
              </span>
            </div>
            <div className="w-full bg-tint rounded-full h-2 overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-700 ease-out ${progressColor}`}
                style={{ width: `${job.progress}%` }}
              />
            </div>
          </div>
        </div>

        {saving && (
          <p className="text-[11px] text-tertiary mt-1 text-right">
            Saving answers...
          </p>
        )}
      </div>

      {/* ─── PDF Preview toggle ─── */}
      {pdfUrl && (
        <div className="mb-6">
          <button
            type="button"
            onClick={() => setPdfOpen((v) => !v)}
            className="flex items-center gap-2 text-sm text-accent hover:text-accent/80 font-medium transition-colors"
          >
            <span className="text-xs">{pdfOpen ? "\u25BC" : "\u25B6"}</span>
            {pdfOpen ? "Hide PDF" : "View Uploaded PDF"}
          </button>
          {pdfOpen && (
            <div className="mt-2 border border-border-dim rounded-lg overflow-hidden">
              <iframe
                src={pdfUrl}
                title="Uploaded PDF preview"
                className="w-full bg-white"
                style={{ height: "500px" }}
              />
            </div>
          )}
        </div>
      )}

      {/* ─── Error state ─── */}
      {job.isFailed && (
        <div className="p-4 mb-6 bg-danger-dim border border-danger rounded-md">
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

      {/* ─── Conversation with Darrin ─── */}
      <div className="space-y-4">
        {/* Message 1 — opener */}
        <DarrinMessage
          avatar="scanning"
          message="Hey, I'm Darrin. I just picked up your PDF — give me a sec to look through it."
        />

        {/* Message 2 — classify */}
        {classify && (
          <DarrinMessage
            avatar="scanning"
            message={
              <>
                Alright, {classify.total_pages} pages total. I&apos;m seeing door
                schedule data on pages{" "}
                <span className="text-accent">{formatPageList(classify.schedule_pages)}</span>{" "}
                and hardware sets on pages{" "}
                <span className="text-accent">{formatPageList(classify.hardware_pages)}</span>.
                Sound right?
              </>
            }
          >
            <DarrinAction
              selected={answers[QUESTION_KEYS.classifyCheck] === "ok"}
              onClick={() => updateAnswer(QUESTION_KEYS.classifyCheck, "ok")}
            >
              Looks right &#10003;
            </DarrinAction>
            <DarrinAction
              selected={answers[QUESTION_KEYS.classifyCheck] === "off"}
              onClick={() => updateAnswer(QUESTION_KEYS.classifyCheck, "off")}
            >
              Something&apos;s off &mdash; let me check
            </DarrinAction>
          </DarrinMessage>
        )}

        {/* Message 3 — extraction */}
        {extraction && (
          <DarrinMessage
            avatar="excited"
            message={
              <>
                First pass done &mdash; I found{" "}
                <span className="text-accent font-semibold">{extraction.door_count}</span>{" "}
                openings across{" "}
                <span className="text-accent font-semibold">{extraction.hw_set_count}</span>{" "}
                hardware sets ({compactSetIds(extraction.hw_sets)}). Still
                refining, but does that ballpark match your scope?
              </>
            }
          >
            <DarrinAction
              selected={answers[QUESTION_KEYS.doorCount] === "about_right"}
              onClick={() => updateAnswer(QUESTION_KEYS.doorCount, "about_right")}
            >
              That&apos;s about right &#10003;
            </DarrinAction>
            <div className="flex items-center gap-2">
              <span className="text-xs text-tertiary">Should be closer to</span>
              <input
                type="number"
                min={0}
                value={doorCountInput}
                onChange={(e) => {
                  const v = e.target.value
                  setDoorCountInput(v)
                  updateAnswer(
                    QUESTION_KEYS.doorCount,
                    v === "" ? null : Number(v),
                  )
                }}
                placeholder="e.g. 85"
                className="w-24 bg-tint border border-border-dim rounded-lg px-2 py-1.5 text-xs text-primary placeholder:text-tertiary/50 focus:outline-none focus:border-accent/50 transition-colors"
              />
            </div>
          </DarrinMessage>
        )}

        {/* Message 4 — fire ratings */}
        {triage && (
          <DarrinMessage
            avatar={triageAvatar}
            message={
              <>
                I&apos;m picking up fire ratings on{" "}
                <span className="text-accent font-semibold">{triage.fire_rated_pct}%</span>{" "}
                of doors
                {triage.fire_ratings_found.length > 0 ? (
                  <>
                    {" "}&mdash; mostly {joinWithAnd(triage.fire_ratings_found)}
                  </>
                ) : null}
                . Does that sound right for this project?
              </>
            }
          >
            <DarrinAction
              selected={answers[QUESTION_KEYS.fireRatedPct] === "yes"}
              onClick={() => updateAnswer(QUESTION_KEYS.fireRatedPct, "yes")}
            >
              Yes &#10003;
            </DarrinAction>
            <DarrinAction
              selected={answers[QUESTION_KEYS.fireRatedPct] === "most_rated"}
              onClick={() => updateAnswer(QUESTION_KEYS.fireRatedPct, "most_rated")}
            >
              Most doors are rated
            </DarrinAction>
            <DarrinAction
              selected={answers[QUESTION_KEYS.fireRatedPct] === "few_rated"}
              onClick={() => updateAnswer(QUESTION_KEYS.fireRatedPct, "few_rated")}
            >
              Very few are rated
            </DarrinAction>
          </DarrinMessage>
        )}

        {/* Message 5 — manufacturers */}
        {triage && triage.manufacturers_found.length > 0 && (
          <DarrinMessage
            avatar="excited"
            message={
              <>
                Manufacturers I&apos;m seeing:{" "}
                <span className="text-accent">
                  {joinWithAnd(triage.manufacturers_found)}
                </span>
                . Anyone I&apos;m missing?
              </>
            }
          >
            <DarrinAction
              selected={answers[QUESTION_KEYS.manufacturers] === "complete"}
              onClick={() => updateAnswer(QUESTION_KEYS.manufacturers, "complete")}
            >
              Looks complete &#10003;
            </DarrinAction>
            <div className="flex items-center gap-2">
              <span className="text-xs text-tertiary">Also check for</span>
              <input
                type="text"
                value={manufacturerInput}
                onChange={(e) => {
                  const v = e.target.value
                  setManufacturerInput(v)
                  updateAnswer(
                    QUESTION_KEYS.manufacturers,
                    v.trim() === "" ? null : `also:${v.trim()}`,
                  )
                }}
                placeholder="e.g. Sargent"
                className="w-40 bg-tint border border-border-dim rounded-lg px-2 py-1.5 text-xs text-primary placeholder:text-tertiary/50 focus:outline-none focus:border-accent/50 transition-colors"
              />
            </div>
          </DarrinMessage>
        )}

        {/* Message 6 — pair doors */}
        {triage && triage.pair_doors_detected.length > 0 && (
          <DarrinMessage
            avatar="scanning"
            message={
              <>
                I noticed{" "}
                <span className="text-accent font-semibold">
                  {triage.pair_doors_detected.length}
                </span>{" "}
                pair doors (e.g., {pairDoorExample}). Want me to handle
                leaf-specific hardware?
              </>
            }
          >
            <DarrinAction
              selected={answers[QUESTION_KEYS.hasPairs] === "yes"}
              onClick={() => updateAnswer(QUESTION_KEYS.hasPairs, "yes")}
            >
              Yes
            </DarrinAction>
            <DarrinAction
              selected={answers[QUESTION_KEYS.hasPairs] === "no"}
              onClick={() => updateAnswer(QUESTION_KEYS.hasPairs, "no")}
            >
              No
            </DarrinAction>
            <DarrinAction
              selected={answers[QUESTION_KEYS.hasPairs] === "not_sure"}
              onClick={() => updateAnswer(QUESTION_KEYS.hasPairs, "not_sure")}
            >
              Not sure
            </DarrinAction>
          </DarrinMessage>
        )}

        {/* Message 7 — orphan doors */}
        {triage && triage.orphan_doors.length > 0 && (
          <DarrinMessage
            avatar="concerned"
            message={
              <>
                Heads up &mdash; I found{" "}
                <span className="text-warning font-semibold">
                  {triage.orphan_doors.length}
                </span>{" "}
                door entries with no hardware items ({orphanNumbers}). These
                look like inactive leaves. I&apos;ll exclude them automatically.
              </>
            }
          >
            <DarrinAction
              selected={answers[QUESTION_KEYS.orphans] === "exclude"}
              onClick={() => updateAnswer(QUESTION_KEYS.orphans, "exclude")}
            >
              Sounds good &#10003;
            </DarrinAction>
            <DarrinAction
              selected={answers[QUESTION_KEYS.orphans] === "keep"}
              onClick={() => updateAnswer(QUESTION_KEYS.orphans, "keep")}
            >
              Keep them &mdash; I&apos;ll fix manually
            </DarrinAction>
          </DarrinMessage>
        )}

        {/* Final message — done */}
        {job.isComplete && extraction && (
          <DarrinMessage
            avatar="success"
            message={
              <>
                All done! Found{" "}
                <span className="text-success font-semibold">
                  {extraction.door_count}
                </span>{" "}
                doors ready for review. Let&apos;s take a look.
              </>
            }
          />
        )}
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
