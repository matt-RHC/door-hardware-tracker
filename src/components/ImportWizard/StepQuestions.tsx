"use client"

import { useState, useCallback, useRef, useEffect, useMemo } from "react"
import type { UseExtractionJobReturn } from "@/hooks/useExtractionJob"
import WizardNav from "./WizardNav"
import DarrinMessage, { DarrinAction } from "./DarrinMessage"
import ClassifyCorrectionPanel from "./questions/ClassifyCorrectionPanel"
import {
  runClassifyHeuristics,
  summarizeHardwareSetIds,
} from "./questions/classify-heuristics"
import type {
  ClassifyOverride,
  ClassifyPageDetail,
  ClassifyPhaseData,
} from "@/lib/schemas/classify"

// ─── Auto-save debounce ───
const DEBOUNCE_MS = 1500

// ─── Helpers ───

/**
 * Render a list of PDF page numbers as clickable chips. Clicking a page
 * scrolls the embedded PDF preview to that page. Long lists collapse to
 * the first 6 with an "+N more" expander.
 *
 * Page numbers from the classifier may be 0- or 1-indexed depending on
 * upstream; we display them as-is but send `page+1` to the PDF anchor
 * when the value looks 0-indexed (i.e. zero is present).
 */
function PageList({
  pages,
  onJump,
}: {
  pages: number[]
  onJump: (page: number) => void
}) {
  const [expanded, setExpanded] = useState(false)
  if (pages.length === 0) return <span className="text-tertiary">none</span>
  const collapseAt = 6
  const shown = expanded || pages.length <= collapseAt ? pages : pages.slice(0, collapseAt - 1)
  const hidden = pages.length - shown.length
  return (
    <span className="inline-flex flex-wrap items-center gap-1 align-middle">
      {shown.map((p, i) => (
        <span key={`${p}-${i}`} className="inline-flex items-center">
          <button
            type="button"
            onClick={() => onJump(p)}
            className="px-1.5 py-0.5 rounded bg-accent-dim border border-accent/40 text-accent hover:bg-accent/20 hover:border-accent transition-colors text-xs font-medium min-h-6"
            title={`Jump PDF to page ${p}`}
          >
            {p}
          </button>
          {i < shown.length - 1 && <span className="text-tertiary">,</span>}
        </span>
      ))}
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="px-1.5 py-0.5 rounded border border-border-dim text-secondary hover:text-primary hover:border-accent/40 transition-colors text-xs font-medium min-h-6"
        >
          +{hidden} more
        </button>
      )}
    </span>
  )
}

/**
 * Render a list of text chips (hardware set ids, manufacturer names) with
 * the same collapse/expand affordance so the user can see everything
 * without truncation.
 */
function ChipList({ items }: { items: string[] }) {
  const [expanded, setExpanded] = useState(false)
  if (items.length === 0) return null
  const unique = Array.from(new Set(items))
  const collapseAt = 6
  const shown = expanded || unique.length <= collapseAt ? unique : unique.slice(0, collapseAt - 1)
  const hidden = unique.length - shown.length
  return (
    <span className="inline-flex flex-wrap items-center gap-1 align-middle">
      {shown.map((item, i) => (
        <span
          key={`${item}-${i}`}
          className="px-1.5 py-0.5 rounded bg-tint border border-border-dim text-secondary text-xs font-medium"
        >
          {item}
        </span>
      ))}
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="px-1.5 py-0.5 rounded border border-border-dim text-secondary hover:text-primary hover:border-accent/40 transition-colors text-xs font-medium min-h-6"
        >
          +{hidden} more
        </button>
      )}
    </span>
  )
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
  const [pdfOpen, setPdfOpen] = useState(true)
  const [pdfPage, setPdfPage] = useState<number | null>(null)
  const [doorCountInput, setDoorCountInput] = useState("")
  const [manufacturerInput, setManufacturerInput] = useState("")
  const [correctionOpen, setCorrectionOpen] = useState(false)
  const [correctionSaving, setCorrectionSaving] = useState(false)
  const [correctionError, setCorrectionError] = useState<string | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastSavedRef = useRef<string>("")
  const pdfFrameRef = useRef<HTMLIFrameElement | null>(null)

  const phaseData = job.phaseData
  const { classify, extraction, triage } = phaseData

  // Derive the enriched classify shape for helpers that expect it.
  // The orchestrator writes every field, but a stale job written
  // before Prompt 4 may lack the new arrays — default defensively.
  const classifyFull = useMemo<ClassifyPhaseData | null>(() => {
    if (!classify) return null
    const c = classify as Partial<ClassifyPhaseData> & {
      total_pages: number
      schedule_pages: number[]
      hardware_pages: number[]
      skipped_pages: number[]
    }
    return {
      total_pages: c.total_pages,
      schedule_pages: c.schedule_pages,
      hardware_pages: c.hardware_pages,
      reference_pages: c.reference_pages ?? [],
      cover_pages: c.cover_pages ?? [],
      skipped_pages: c.skipped_pages,
      page_details: c.page_details ?? [],
      user_overrides: c.user_overrides,
    }
  }, [classify])

  const heuristicFlags = useMemo(() => {
    if (!classifyFull) return []
    return runClassifyHeuristics(classifyFull)
  }, [classifyFull])

  const hardwareSetIdsSummary = useMemo(() => {
    if (!classifyFull) return ""
    return summarizeHardwareSetIds(classifyFull.page_details ?? [])
  }, [classifyFull])

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

  // Classifier page numbers may be 0- or 1-indexed. Detect by looking for
  // a zero anywhere — PDFs shown by the browser's viewer are 1-indexed
  // via the `#page=N` fragment.
  const classifierIsZeroIndexed = useMemo(() => {
    if (!classifyFull) return false
    const all = [
      ...classifyFull.schedule_pages,
      ...classifyFull.hardware_pages,
      ...classifyFull.reference_pages,
      ...classifyFull.cover_pages,
      ...classifyFull.skipped_pages,
    ]
    return all.some((p) => p === 0)
  }, [classifyFull])

  const handleJumpToPage = useCallback(
    (page: number) => {
      if (!pdfUrl) return
      const pdfPageNum = classifierIsZeroIndexed ? page + 1 : page
      setPdfPage(pdfPageNum)
      setPdfOpen(true)
      // Scroll the preview into view so the user sees the jump happen.
      requestAnimationFrame(() => {
        pdfFrameRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
      })
    },
    [pdfUrl, classifierIsZeroIndexed],
  )

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

  // ─── Classify overrides ───
  const handleSaveOverrides = useCallback(
    async (overrides: ClassifyOverride[]) => {
      if (!job.jobId) return
      setCorrectionSaving(true)
      setCorrectionError(null)
      try {
        const resp = await fetch(
          `/api/jobs/${job.jobId}/classify-overrides`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ overrides }),
          },
        )
        if (!resp.ok) {
          const body = await resp.json().catch(() => ({}))
          throw new Error(
            body.error ?? `Failed to save corrections (${resp.status})`,
          )
        }
        // Stamp a "classify_check=corrected" answer so the constraint
        // table records the user intervened — pairs with the other
        // classifyCheck values ("ok"/"off").
        updateAnswer(QUESTION_KEYS.classifyCheck, "corrected")
        setCorrectionOpen(false)
      } catch (err) {
        setCorrectionError(
          err instanceof Error ? err.message : "Failed to save corrections",
        )
      } finally {
        setCorrectionSaving(false)
      }
    },
    [job.jobId, updateAnswer],
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
      <p className="text-sm text-secondary mt-1 mb-5">
        Darrin walks through what he found. <span className="text-primary">
        Click any page number</span> to pull it up in the PDF below, then use
        the chips to confirm each finding or flag it as off.
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

      {/* ─── PDF Preview (open by default so users can verify findings) ─── */}
      {pdfUrl && (
        <div className="mb-6">
          <div className="flex items-center justify-between gap-2 mb-2">
            <button
              type="button"
              onClick={() => setPdfOpen((v) => !v)}
              className="flex items-center gap-2 text-sm text-accent hover:text-accent/80 font-medium transition-colors"
            >
              <span className="text-xs">{pdfOpen ? "\u25BC" : "\u25B6"}</span>
              {pdfOpen ? "Hide PDF" : "View Uploaded PDF"}
              {pdfPage != null && pdfOpen && (
                <span className="text-tertiary text-xs font-normal">
                  &mdash; showing page {pdfPage}
                </span>
              )}
            </button>
            <span className="text-[11px] text-tertiary">
              Tip: click any <span className="text-accent">page number</span> below to jump here.
            </span>
          </div>
          {pdfOpen && (
            <div className="border border-border-dim rounded-lg overflow-hidden">
              <iframe
                ref={pdfFrameRef}
                src={pdfPage != null ? `${pdfUrl}#page=${pdfPage}` : pdfUrl}
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
        {classify && classifyFull && (
          <>
            <DarrinMessage
              avatar={
                heuristicFlags.some((f) => f.severity === "warning")
                  ? "concerned"
                  : "scanning"
              }
              message={
                <div className="space-y-2">
                  <div>
                    I went through all{" "}
                    <span className="text-primary font-semibold">
                      {classify.total_pages}
                    </span>{" "}
                    pages. Here&apos;s what I found &mdash; click any page number
                    to check it against the PDF above.
                  </div>
                  <ul className="space-y-1.5 text-sm">
                    <li>
                      <span className="text-accent font-medium">
                        Door schedule
                      </span>
                      <span className="text-tertiary">
                        {" "}&middot; {classifyFull.schedule_pages.length} page
                        {classifyFull.schedule_pages.length === 1 ? "" : "s"}:{" "}
                      </span>
                      <PageList
                        pages={classifyFull.schedule_pages}
                        onJump={handleJumpToPage}
                      />
                    </li>
                    <li>
                      <span className="text-accent font-medium">
                        Hardware headings
                      </span>
                      <span className="text-tertiary">
                        {" "}&middot; {classifyFull.hardware_pages.length} page
                        {classifyFull.hardware_pages.length === 1 ? "" : "s"}:{" "}
                      </span>
                      <PageList
                        pages={classifyFull.hardware_pages}
                        onJump={handleJumpToPage}
                      />
                      {hardwareSetIdsSummary && (
                        <div className="text-tertiary text-xs mt-0.5 ml-4">
                          sets detected: {hardwareSetIdsSummary}
                        </div>
                      )}
                    </li>
                    {classifyFull.reference_pages.length > 0 && (
                      <li>
                        <span className="text-secondary font-medium">
                          Reference tables
                        </span>
                        <span className="text-tertiary">
                          {" "}&middot;{" "}
                        </span>
                        <PageList
                          pages={classifyFull.reference_pages}
                          onJump={handleJumpToPage}
                        />
                      </li>
                    )}
                    {classifyFull.cover_pages.length > 0 && (
                      <li>
                        <span className="text-tertiary font-medium">
                          Cover / skip
                        </span>
                        <span className="text-tertiary">
                          {" "}&middot;{" "}
                        </span>
                        <PageList
                          pages={classifyFull.cover_pages}
                          onJump={handleJumpToPage}
                        />
                      </li>
                    )}
                  </ul>
                  <div>
                    {heuristicFlags.length === 0
                      ? "Does the breakdown above look right?"
                      : "A couple things caught my eye:"}
                  </div>
                </div>
              }
            >
              <DarrinAction
                selected={answers[QUESTION_KEYS.classifyCheck] === "ok"}
                onClick={() => updateAnswer(QUESTION_KEYS.classifyCheck, "ok")}
              >
                Looks right
              </DarrinAction>
              <DarrinAction
                selected={
                  answers[QUESTION_KEYS.classifyCheck] === "off" ||
                  correctionOpen
                }
                onClick={() => {
                  updateAnswer(QUESTION_KEYS.classifyCheck, "off")
                  setCorrectionOpen(true)
                }}
              >
                Something&apos;s off &mdash; let me fix it
              </DarrinAction>
            </DarrinMessage>

            {/* Heuristic flags — rendered as a bullet list under Darrin's message. */}
            {heuristicFlags.length > 0 && (
              <ul className="ml-[60px] space-y-1 text-xs text-secondary list-disc list-inside">
                {heuristicFlags.map((flag) => (
                  <li
                    key={flag.code}
                    className={
                      flag.severity === "warning" ? "text-warning" : "text-tertiary"
                    }
                  >
                    {flag.message}
                  </li>
                ))}
              </ul>
            )}

            {/* Correction panel — expanded when user clicks "Something's off" */}
            {correctionOpen && (classifyFull.page_details?.length ?? 0) > 0 && (
              <div className="ml-[60px]">
                <ClassifyCorrectionPanel
                  pages={classifyFull.page_details as ClassifyPageDetail[]}
                  initialOverrides={classifyFull.user_overrides ?? []}
                  onSave={handleSaveOverrides}
                  onCancel={() => setCorrectionOpen(false)}
                  saving={correctionSaving}
                />
                {correctionError && (
                  <p className="text-[11px] text-danger mt-2">
                    {correctionError}
                  </p>
                )}
              </div>
            )}
          </>
        )}

        {/* Message 3 — extraction */}
        {extraction && (
          <DarrinMessage
            avatar="excited"
            message={
              <div className="space-y-2">
                <div>
                  First pass done &mdash; I pulled{" "}
                  <span className="text-accent font-semibold">
                    {extraction.door_count}
                  </span>{" "}
                  openings across{" "}
                  <span className="text-accent font-semibold">
                    {extraction.hw_set_count}
                  </span>{" "}
                  hardware sets.
                </div>
                {extraction.hw_sets.length > 0 && (
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                    <span className="text-tertiary">sets:</span>
                    <ChipList items={extraction.hw_sets} />
                  </div>
                )}
                <div>
                  Does that ballpark match the scope you uploaded? If you know the
                  opening count, type it in.
                </div>
              </div>
            }
          >
            <DarrinAction
              selected={answers[QUESTION_KEYS.doorCount] === "about_right"}
              onClick={() => updateAnswer(QUESTION_KEYS.doorCount, "about_right")}
            >
              That&apos;s about right
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
        {triage && (() => {
          // Values like "NR" / "Non-Rated" mean the door isn't rated. Split
          // the list so the prompt doesn't say "fire ratings on 100%" when
          // most doors are actually non-rated.
          const ratingValues = triage.fire_ratings_found ?? []
          const isNonRated = (v: string) =>
            /^\s*(nr|non[-\s]?rated|n\/?a|none|--)\s*$/i.test(v)
          const ratedValues = ratingValues.filter((v) => !isNonRated(v))
          const hasNonRated = ratingValues.some(isNonRated)
          const actualRatedPct =
            hasNonRated && ratingValues.length > 0
              ? Math.round(
                  (ratedValues.length / ratingValues.length) *
                    triage.fire_rated_pct,
                )
              : triage.fire_rated_pct
          return (
            <DarrinMessage
              avatar={triageAvatar}
              message={
                <div className="space-y-2">
                  <div>
                    Fire-rating field is filled in on{" "}
                    <span className="text-accent font-semibold">
                      {triage.fire_rated_pct}%
                    </span>{" "}
                    of doors.
                  </div>
                  {ratedValues.length > 0 && (
                    <div className="text-xs flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="text-tertiary">ratings seen:</span>
                      <ChipList items={ratedValues} />
                    </div>
                  )}
                  <div>
                    {hasNonRated ? (
                      <>
                        About{" "}
                        <span className="text-primary font-semibold">
                          {actualRatedPct}%
                        </span>{" "}
                        carry an actual rating &mdash; the rest read{" "}
                        <span className="text-tertiary">NR (non-rated)</span>.
                      </>
                    ) : (
                      <>Every door I checked has a real rating.</>
                    )}{" "}
                    Does that split look right?
                  </div>
                </div>
              }
            >
              <DarrinAction
                selected={answers[QUESTION_KEYS.fireRatedPct] === "yes"}
                onClick={() => updateAnswer(QUESTION_KEYS.fireRatedPct, "yes")}
              >
                Looks right
              </DarrinAction>
              <DarrinAction
                selected={answers[QUESTION_KEYS.fireRatedPct] === "most_rated"}
                onClick={() => updateAnswer(QUESTION_KEYS.fireRatedPct, "most_rated")}
              >
                Actually, most should be rated
              </DarrinAction>
              <DarrinAction
                selected={answers[QUESTION_KEYS.fireRatedPct] === "few_rated"}
                onClick={() => updateAnswer(QUESTION_KEYS.fireRatedPct, "few_rated")}
              >
                Actually, most should be non-rated
              </DarrinAction>
            </DarrinMessage>
          )
        })()}

        {/* Message 5 — manufacturers */}
        {triage && triage.manufacturers_found.length > 0 && (() => {
          // If a lot of "manufacturer" entries look like part codes (digits,
          // dashes, measurements) instead of brand names, warn the user —
          // the extractor may have grabbed the wrong column.
          const looksLikePartCode = (v: string) => {
            const s = v.trim()
            if (s.length === 0) return true
            if (s.length <= 3 && /^[A-Z]+$/i.test(s)) return true
            if (/^[\d.\-/]/.test(s)) return true
            if (/["']|\b\d+\s*(mm|in|")/i.test(s)) return true
            return false
          }
          const suspicious = triage.manufacturers_found.filter(looksLikePartCode)
          const noisy =
            triage.manufacturers_found.length >= 5 &&
            suspicious.length / triage.manufacturers_found.length >= 0.4
          return (
            <DarrinMessage
              avatar={noisy ? "concerned" : "excited"}
              message={
                <div className="space-y-2">
                  <div>
                    I pulled{" "}
                    <span className="text-accent font-semibold">
                      {triage.manufacturers_found.length}
                    </span>{" "}
                    unique values from the manufacturer column:
                  </div>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                    <ChipList items={triage.manufacturers_found} />
                  </div>
                  {noisy ? (
                    <div className="text-warning text-xs">
                      Heads up &mdash; a lot of these look like part codes or
                      measurements, not brand names. The column mapping may
                      need a tweak.
                    </div>
                  ) : null}
                  <div>
                    {noisy
                      ? "Does this look like a list of manufacturers to you?"
                      : "Is anyone missing from this list?"}
                  </div>
                </div>
              }
            >
              <DarrinAction
                selected={answers[QUESTION_KEYS.manufacturers] === "complete"}
                onClick={() => updateAnswer(QUESTION_KEYS.manufacturers, "complete")}
              >
                Looks right
              </DarrinAction>
              <DarrinAction
                selected={answers[QUESTION_KEYS.manufacturers] === "wrong_column"}
                onClick={() =>
                  updateAnswer(QUESTION_KEYS.manufacturers, "wrong_column")
                }
              >
                These aren&apos;t manufacturers
              </DarrinAction>
              <div className="flex items-center gap-2">
                <span className="text-xs text-tertiary">Also add</span>
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
          )
        })()}

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
                pair doors
                {pairDoorExample ? (
                  <> (e.g., <span className="text-primary">{pairDoorExample}</span>)</>
                ) : null}
                . Some hardware is specific to the active leaf. Want me to split
                it out automatically?
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
              Sounds good
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
