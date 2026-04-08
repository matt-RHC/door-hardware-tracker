"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import type {
  ClassifyPagesResponse,
  ColumnMapping,
  TriageResult,
  DoorEntry,
  HardwareSet,
} from "./types";
import { scoreExtraction } from "@/lib/confidence-scoring";
import { generateTriageQuestions, type PunchQuestion } from "@/lib/punch-messages";
import {
  arrayBufferToBase64,
  splitPDFByPages,
  splitPDFFixed,
  mergeHardwareSets,
  mergeDoors,
  CHUNK_SIZE_THRESHOLD,
  FALLBACK_PAGES_PER_CHUNK,
} from "@/lib/pdf-utils";

/**
 * Phases: extracting → results → questions → triaging → done
 * "results" is the NEW Extraction Health Dashboard phase.
 */
type TriagePhase = "extracting" | "results" | "questions" | "triaging" | "done";

interface StepTriageProps {
  projectId: string;
  file: File;
  columnMappings: ColumnMapping[];
  classifyResult: ClassifyPagesResponse;
  /** Current question answers (managed by parent). */
  questionAnswers: Record<string, string>;
  onComplete: (
    triageResult: TriageResult,
    doors: DoorEntry[],
    hardwareSets: HardwareSet[]
  ) => void;
  /** Surfaces validation questions for the PunchAssistant sidebar. */
  onQuestionsGenerated: (questions: PunchQuestion[]) => void;
  onBack: () => void;
  onError: (msg: string) => void;
}

export default function StepTriage({
  projectId,
  file,
  columnMappings,
  classifyResult,
  questionAnswers,
  onComplete,
  onQuestionsGenerated,
  onBack,
  onError,
}: StepTriageProps) {
  const [phase, setPhase] = useState<TriagePhase>("extracting");
  const [status, setStatus] = useState("");
  const [progress, setProgress] = useState(0);
  const [triageResult, setTriageResult] = useState<TriageResult | null>(null);
  const [triageErrorAcknowledged, setTriageErrorAcknowledged] = useState(false);
  const [doors, setDoors] = useState<DoorEntry[]>([]);
  const [hardwareSets, setHardwareSets] = useState<HardwareSet[]>([]);
  const [deepExtracting, setDeepExtracting] = useState(false);

  // Keep refs to latest answers and generated questions
  const answersRef = useRef(questionAnswers);
  answersRef.current = questionAnswers;
  const generatedQuestionsRef = useRef<PunchQuestion[]>([]);

  // ─── Extraction Health Stats (computed) ───
  const extractionHealth = useMemo(() => {
    const totalItems = hardwareSets.reduce(
      (sum, s) => sum + (s.items?.length ?? 0),
      0
    );
    const emptySets = hardwareSets.filter(
      (s) => (s.items?.length ?? 0) === 0
    );
    const populatedSets = hardwareSets.filter(
      (s) => (s.items?.length ?? 0) > 0
    );

    // Door-to-set assignment coverage
    const assignedDoors = doors.filter(
      (d) => d.hw_set && d.hw_set.trim() !== ""
    ).length;

    // Check for sets referenced by doors but not in extraction
    const doorSetIds = new Set(
      doors.map((d) => (d.hw_set ?? "").toUpperCase()).filter(Boolean)
    );
    const extractedSetIds = new Set(
      hardwareSets.map((s) => s.set_id.toUpperCase())
    );
    const missingSetIds = [...doorSetIds].filter(
      (id) => !extractedSetIds.has(id)
    );

    // Overall health grade
    let grade: "good" | "warning" | "critical" = "good";
    if (emptySets.length > 0 || missingSetIds.length > 0) grade = "warning";
    if (totalItems === 0 || emptySets.length === hardwareSets.length)
      grade = "critical";

    return {
      totalItems,
      emptySets,
      populatedSets,
      assignedDoors,
      unassignedDoors: doors.length - assignedDoors,
      missingSetIds,
      grade,
    };
  }, [doors, hardwareSets]);

  // ─── Phase 1: Run extraction on mount ───
  const runExtraction = useCallback(async () => {
    setPhase("extracting");
    setStatus("Extracting data with column mapping...");
    setProgress(10);

    try {
      const arrayBuffer = await file.arrayBuffer();

      // Build userColumnMapping from ColumnMapping[] → Record<string, number>
      const userColumnMapping: Record<string, number> = {};
      for (let i = 0; i < columnMappings.length; i++) {
        if (columnMappings[i].mapped_field) {
          userColumnMapping[columnMappings[i].mapped_field as string] = i;
        }
      }
      const mappingPayload =
        Object.keys(userColumnMapping).length > 0 ? userColumnMapping : null;

      let extractedDoors: DoorEntry[];
      let extractedSets: HardwareSet[];

      if (file.size > CHUNK_SIZE_THRESHOLD) {
        setProgress(15);
        setStatus("Splitting large PDF into chunks...");

        let chunks: string[];
        const schedulePages = classifyResult.summary.door_schedule_pages;
        const hwPages = classifyResult.summary.hardware_set_pages;
        const allContentPages = [...schedulePages, ...hwPages].sort(
          (a, b) => a - b
        );

        if (allContentPages.length > 0) {
          const chunkSets: number[][] = [];
          for (
            let i = 0;
            i < allContentPages.length;
            i += FALLBACK_PAGES_PER_CHUNK
          ) {
            chunkSets.push(
              allContentPages.slice(i, i + FALLBACK_PAGES_PER_CHUNK)
            );
          }
          const refPages = classifyResult.summary.submittal_pages;
          chunks = await splitPDFByPages(arrayBuffer, chunkSets, refPages);
        } else {
          chunks = await splitPDFFixed(arrayBuffer, FALLBACK_PAGES_PER_CHUNK);
        }

        setProgress(20);
        setStatus(`Extracting from ${chunks.length} chunk(s)...`);

        const allDoors: DoorEntry[] = [];
        const allSets: HardwareSet[] = [];

        for (let i = 0; i < chunks.length; i++) {
          setStatus(`Extracting chunk ${i + 1} of ${chunks.length}...`);
          setProgress(20 + Math.round((i / chunks.length) * 40));

          const chunkResp = await fetch("/api/parse-pdf?parseOnly=true", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              pdfBase64: chunks[i],
              userColumnMapping: mappingPayload,
            }),
          });

          if (!chunkResp.ok) {
            const err = await chunkResp.json().catch(() => ({}));
            console.warn(`Chunk ${i + 1} failed:`, err.error);
            continue;
          }

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const chunkResult: any = await chunkResp.json();
          allDoors.push(...(chunkResult.doors ?? []));
          allSets.push(...(chunkResult.sets ?? []));
        }

        extractedDoors = mergeDoors(allDoors);
        extractedSets = mergeHardwareSets(allSets);
      } else {
        const pdfBase64 = arrayBufferToBase64(arrayBuffer);

        setProgress(20);
        setStatus("Running extraction...");

        const parseResp = await fetch("/api/parse-pdf?parseOnly=true", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            pdfBase64,
            userColumnMapping: mappingPayload,
          }),
        });

        if (!parseResp.ok) {
          const err = await parseResp.json().catch(() => ({}));
          throw new Error(
            err.error || `Extraction failed (${parseResp.status})`
          );
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const parseResult: any = await parseResp.json();
        extractedDoors = parseResult.doors ?? [];
        extractedSets = parseResult.sets ?? [];
      }

      if (extractedDoors.length === 0) {
        throw new Error("No doors found during extraction.");
      }

      // Attach per-field confidence scores
      const { perDoor } = scoreExtraction(extractedDoors);
      for (const door of extractedDoors) {
        const scores = perDoor.get(door.door_number);
        if (scores) door.field_confidence = scores;
      }

      setDoors(extractedDoors);
      setHardwareSets(extractedSets);
      setProgress(60);

      // Show extraction results dashboard BEFORE questions or triage
      setPhase("results");
      setStatus("Extraction complete. Review results below.");
    } catch (err) {
      onError(err instanceof Error ? err.message : "Extraction failed");
    }
  }, [file, columnMappings, classifyResult, onError]);

  // ─── Phase 2: User reviews extraction results, then continues ───
  const handleAcceptResults = useCallback(() => {
    // Generate validation questions
    const questions = generateTriageQuestions(doors);
    generatedQuestionsRef.current = questions;
    if (questions.length > 0) {
      onQuestionsGenerated(questions);
      setPhase("questions");
      setStatus("Review flagged items in the sidebar, then continue.");
    } else {
      // No questions — go straight to triage
      setPhase("triaging");
    }
  }, [doors, onQuestionsGenerated]);

  // ─── Deep Extract: LLM-based item extraction for empty sets ───
  const handleDeepExtract = useCallback(async () => {
    const emptySets = hardwareSets
      .filter((s) => (s.items?.length ?? 0) === 0)
      .map((s) => ({ set_id: s.set_id, heading: s.heading ?? "" }));

    if (emptySets.length === 0) return;

    setDeepExtracting(true);
    setStatus(`Extracting items for ${emptySets.length} empty set${emptySets.length !== 1 ? "s" : ""} with AI...`);

    try {
      // Build filtered PDF with ONLY hardware set pages
      const hwPages = classifyResult.summary.hardware_set_pages ?? [];
      let pdfBase64 = "";
      if (hwPages.length > 0) {
        const arrayBuffer = await file.arrayBuffer();
        const chunks = await splitPDFByPages(arrayBuffer, [hwPages], []);
        pdfBase64 = chunks[0] ?? "";
      }
      if (!pdfBase64) {
        // Fallback: send full PDF
        const arrayBuffer = await file.arrayBuffer();
        pdfBase64 = arrayBufferToBase64(arrayBuffer);
      }

      const resp = await fetch("/api/parse-pdf/deep-extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pdfBase64, emptySets }),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        console.error("Deep extract failed:", err.error);
        setStatus("Deep extraction failed. You can still continue.");
        setDeepExtracting(false);
        return;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result: any = await resp.json();
      const extractedSets: Array<{
        set_id: string;
        items: Array<{
          qty: number;
          name: string;
          manufacturer: string;
          model: string;
          finish: string;
          qty_source?: string;
        }>;
      }> = result.sets ?? [];

      // Merge extracted items into existing hardware sets
      if (extractedSets.length > 0) {
        setHardwareSets((prev) => {
          const updated = [...prev];
          for (const extracted of extractedSets) {
            const idx = updated.findIndex(
              (s) => s.set_id === extracted.set_id
            );
            if (idx >= 0 && (updated[idx].items?.length ?? 0) === 0) {
              updated[idx] = {
                ...updated[idx],
                items: extracted.items ?? [],
              };
            }
          }
          return updated;
        });

        const totalNewItems = extractedSets.reduce(
          (sum, s) => sum + (s.items?.length ?? 0),
          0,
        );
        setStatus(
          `Deep extract found ${totalNewItems} item${totalNewItems !== 1 ? "s" : ""} across ${extractedSets.length} set${extractedSets.length !== 1 ? "s" : ""}.`
        );
      } else {
        setStatus("Deep extract returned no items. You can still continue.");
      }
    } catch (err) {
      console.error("Deep extract error:", err);
      setStatus("Deep extraction failed. You can still continue.");
    } finally {
      setDeepExtracting(false);
    }
  }, [hardwareSets, file, classifyResult]);

  // ─── Phase 3: Run triage classification ───
  const runTriageClassification = useCallback(async () => {
    setPhase("triaging");
    setStatus("Running triage...");
    setProgress(70);

    try {
      // Build user hints from answered questions
      const userHints: Array<{ question_id: string; question_text: string; answer: string }> = [];
      for (const [qId, answer] of Object.entries(answersRef.current)) {
        const q = generatedQuestionsRef.current.find((gq) => gq.id === qId);
        userHints.push({
          question_id: qId,
          question_text: q?.text ?? qId,
          answer,
        });
      }

      // Build filtered PDF (door schedule + hardware set pages only) so the
      // triage LLM can see the actual PDF content, not just text metadata.
      let filteredPdfBase64: string | undefined;
      const schedulePages = classifyResult.summary.door_schedule_pages ?? [];
      const hwPages = classifyResult.summary.hardware_set_pages ?? [];
      const relevantPages = [...schedulePages, ...hwPages];
      if (relevantPages.length > 0) {
        try {
          const arrayBuffer = await file.arrayBuffer();
          const chunks = await splitPDFByPages(arrayBuffer, [relevantPages], []);
          filteredPdfBase64 = chunks[0];
        } catch (err) {
          console.warn("Failed to build filtered PDF for triage:", err);
        }
      }

      const triageResp = await fetch("/api/parse-pdf/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          candidates: doors.map((d) => ({
            door_number: d.door_number,
            hw_set: d.hw_set || null,
            door_type: d.door_type || null,
            frame_type: d.frame_type || null,
            fire_rating: d.fire_rating || null,
            hand: d.hand || null,
            location: d.location || null,
            page_number: null,
          })),
          filteredPdfBase64,
          userHints: userHints.length > 0 ? userHints : undefined,
        }),
      });

      if (!triageResp.ok) {
        const result: TriageResult = {
          doors_found: doors.length,
          by_others: 0,
          rejected: 0,
          accepted: doors,
          flagged: [],
        };
        setTriageResult(result);
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const raw: any = await triageResp.json();
        const triageError: boolean = raw.triage_error === true;
        const triageErrorMessage: string = raw.triage_error_message ?? '';
        const classifications: Array<{
          door_number: string;
          class: string;
          confidence: string;
          reason: string;
        }> = raw.classifications ?? [];

        const acceptedDoors = doors.filter((d) => {
          const c = classifications.find(
            (cl) => cl.door_number === d.door_number
          );
          return !c || c.class === "door";
        });
        const flagged = classifications
          .filter((c) => c.class === "by_others" || (c.confidence === "low" && c.class !== "door"))
          .map((c) => ({
            door_number: c.door_number,
            reason: c.reason,
            confidence:
              c.confidence === "high"
                ? 0.9
                : c.confidence === "medium"
                ? 0.6
                : 0.3,
          }));

        const result: TriageResult = {
          doors_found: raw.stats?.total ?? doors.length,
          by_others: raw.stats?.by_others ?? 0,
          rejected: raw.stats?.rejected ?? 0,
          accepted: acceptedDoors,
          flagged,
          triage_error: triageError,
          triage_error_message: triageErrorMessage || undefined,
        };
        setTriageResult(result);
      }

      setProgress(100);
      setStatus("Triage complete.");
      setPhase("done");
    } catch (err) {
      onError(err instanceof Error ? err.message : "Triage failed");
    }
  }, [doors, file, classifyResult, onError]);

  // Start extraction on mount
  useEffect(() => {
    runExtraction();
  }, [runExtraction]);

  // Auto-start triage when phase transitions to "triaging"
  useEffect(() => {
    if (phase === "triaging" && doors.length > 0 && !triageResult) {
      runTriageClassification();
    }
  }, [phase, doors.length, triageResult, runTriageClassification]);

  // ─── Advance ───
  const handleContinueToTriage = () => {
    setPhase("triaging");
  };

  // Pass only triage-accepted doors to the next step, not all extracted doors.
  const handleNext = () => {
    if (!triageResult) return;
    onComplete(triageResult, triageResult.accepted, hardwareSets);
  };

  const isLoading = phase === "extracting" || phase === "triaging";

  return (
    <div className="max-w-2xl mx-auto">
      <h3 className="text-[#f5f5f7] font-semibold mb-2">Step 3: Extract &amp; Triage</h3>
      <p className="text-[#a1a1a6] text-sm mb-4">
        {phase === "extracting"
          ? "Extracting door schedule data from your PDF..."
          : phase === "results"
          ? "Review what was extracted before continuing to triage."
          : "Classifying doors as accepted, by-others, or rejected."}
      </p>

      {/* Progress */}
      {isLoading && (
        <div className="mb-4">
          <div className="flex justify-between text-sm mb-1">
            <span className="text-[#a1a1a6]">{status}</span>
            <span className="text-[#6e6e73]">{progress}%</span>
          </div>
          <div className="w-full bg-white/[0.06] rounded-full h-2 overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-500 ease-out bg-[#0a84ff]"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════
          EXTRACTION HEALTH DASHBOARD — shown after extraction, before triage.
          This is the key new UI that gives users visibility into what was extracted.
         ═══════════════════════════════════════════════════════════════ */}
      {phase === "results" && (
        <div className="space-y-4 mb-4">
          {/* ── Top-level summary cards ── */}
          <div className="grid grid-cols-3 gap-2">
            <div className="bg-white/[0.04] border border-white/[0.06] rounded-xl p-3 text-center">
              <div className="text-xl font-bold text-[#30d158]">
                {doors.length}
              </div>
              <div className="text-[9px] text-[#6e6e73] uppercase tracking-wide">
                Doors
              </div>
            </div>
            <div className="bg-white/[0.04] border border-white/[0.06] rounded-xl p-3 text-center">
              <div className="text-xl font-bold text-[#0a84ff]">
                {hardwareSets.length}
              </div>
              <div className="text-[9px] text-[#6e6e73] uppercase tracking-wide">
                HW Sets
              </div>
            </div>
            <div
              className={`bg-white/[0.04] border rounded-xl p-3 text-center ${
                extractionHealth.grade === "critical"
                  ? "border-[rgba(255,69,58,0.4)]"
                  : extractionHealth.grade === "warning"
                  ? "border-[rgba(255,149,0,0.3)]"
                  : "border-white/[0.06]"
              }`}
            >
              <div
                className={`text-xl font-bold ${
                  extractionHealth.grade === "critical"
                    ? "text-[#ff453a]"
                    : extractionHealth.grade === "warning"
                    ? "text-[#ff9500]"
                    : "text-[#30d158]"
                }`}
              >
                {extractionHealth.totalItems}
              </div>
              <div className="text-[9px] text-[#6e6e73] uppercase tracking-wide">
                HW Items
              </div>
            </div>
          </div>

          {/* ── Assignment coverage ── */}
          <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-3">
            <div className="text-[10px] text-[#6e6e73] uppercase tracking-wide mb-2 font-semibold">
              Coverage
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
              <span className="text-[#a1a1a6]">Doors with HW set</span>
              <span className="text-[#f5f5f7]">
                {extractionHealth.assignedDoors} / {doors.length}
                {extractionHealth.unassignedDoors > 0 && (
                  <span className="text-[#ff9500] ml-1">
                    ({extractionHealth.unassignedDoors} unassigned)
                  </span>
                )}
              </span>
              <span className="text-[#a1a1a6]">Sets with items</span>
              <span className="text-[#f5f5f7]">
                {extractionHealth.populatedSets.length} / {hardwareSets.length}
                {extractionHealth.emptySets.length > 0 && (
                  <span className="text-[#ff453a] ml-1">
                    ({extractionHealth.emptySets.length} empty)
                  </span>
                )}
              </span>
              <span className="text-[#a1a1a6]">Avg items per set</span>
              <span className="text-[#f5f5f7]">
                {hardwareSets.length > 0
                  ? (extractionHealth.totalItems / hardwareSets.length).toFixed(1)
                  : "0"}
              </span>
            </div>
          </div>

          {/* ── Per-set item breakdown ── */}
          <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-3">
            <div className="text-[10px] text-[#6e6e73] uppercase tracking-wide mb-2 font-semibold">
              Hardware Sets
            </div>
            <div className="space-y-1 max-h-48 overflow-y-auto">
              {hardwareSets.map((set) => {
                const itemCount = set.items?.length ?? 0;
                const isEmpty = itemCount === 0;
                return (
                  <div
                    key={set.set_id}
                    className={`flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs ${
                      isEmpty
                        ? "bg-[rgba(255,69,58,0.08)] border border-[rgba(255,69,58,0.2)]"
                        : "bg-white/[0.02] border border-white/[0.04]"
                    }`}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span
                        className={`font-mono font-medium ${
                          isEmpty ? "text-[#ff453a]" : "text-[#0a84ff]"
                        }`}
                      >
                        {set.set_id}
                      </span>
                      {set.heading && (
                        <span className="text-[#6e6e73] truncate max-w-[180px]">
                          {set.heading}
                        </span>
                      )}
                    </div>
                    <span
                      className={`font-semibold whitespace-nowrap ${
                        isEmpty ? "text-[#ff453a]" : "text-[#a1a1a6]"
                      }`}
                    >
                      {isEmpty ? "0 items" : `${itemCount} item${itemCount !== 1 ? "s" : ""}`}
                    </span>
                  </div>
                );
              })}
              {hardwareSets.length === 0 && (
                <p className="text-[#ff453a] text-xs py-2">
                  No hardware sets were extracted from the PDF.
                </p>
              )}
            </div>
          </div>

          {/* ── Missing sets warning ── */}
          {extractionHealth.missingSetIds.length > 0 && (
            <div className="p-3 bg-[rgba(255,149,0,0.08)] border border-[rgba(255,149,0,0.2)] rounded-xl">
              <div className="text-[#ff9500] text-xs font-semibold mb-1">
                Missing Hardware Sets
              </div>
              <p className="text-[#a1a1a6] text-xs mb-1.5">
                These sets are referenced by doors but were not found in the hardware schedule pages:
              </p>
              <div className="flex flex-wrap gap-1.5">
                {extractionHealth.missingSetIds.map((id) => (
                  <span
                    key={id}
                    className="font-mono text-[11px] px-2 py-0.5 rounded bg-[rgba(255,149,0,0.12)] text-[#ff9500] border border-[rgba(255,149,0,0.2)]"
                  >
                    {id}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* ── Empty sets: Deep Extract offer ── */}
          {extractionHealth.emptySets.length > 0 && (
            <div className={`p-3 rounded-xl ${
              extractionHealth.grade === "critical"
                ? "bg-[rgba(255,69,58,0.1)] border border-[rgba(255,69,58,0.3)]"
                : "bg-[rgba(255,149,0,0.08)] border border-[rgba(255,149,0,0.2)]"
            }`}>
              <div className="flex items-start gap-2 mb-2">
                <span className={`text-lg leading-none ${
                  extractionHealth.grade === "critical" ? "text-[#ff453a]" : "text-[#ff9500]"
                }`}>&#x26A0;</span>
                <div>
                  <p className={`text-sm font-semibold mb-1 ${
                    extractionHealth.grade === "critical" ? "text-[#ff453a]" : "text-[#ff9500]"
                  }`}>
                    {extractionHealth.emptySets.length === hardwareSets.length
                      ? "No hardware items extracted"
                      : `${extractionHealth.emptySets.length} set${extractionHealth.emptySets.length !== 1 ? "s" : ""} missing items`}
                  </p>
                  <p className="text-[#a1a1a6] text-xs">
                    Our table reader couldn&apos;t parse the items for
                    {extractionHealth.emptySets.length === 1
                      ? ` set ${extractionHealth.emptySets[0]?.set_id ?? "unknown"}`
                      : ` ${extractionHealth.emptySets.length} sets`}.
                    You can try AI-powered extraction, go back to remap columns,
                    or continue without items and add them manually later.
                  </p>
                </div>
              </div>
              <button
                onClick={handleDeepExtract}
                disabled={deepExtracting}
                className="ml-6 px-4 py-2 bg-[rgba(10,132,255,0.15)] border border-[rgba(10,132,255,0.3)] hover:bg-[rgba(10,132,255,0.25)] text-[#4BA3E3] rounded-lg transition-colors font-semibold text-sm disabled:opacity-50"
              >
                {deepExtracting
                  ? "Extracting..."
                  : `Extract Items with AI (${extractionHealth.emptySets.length} set${extractionHealth.emptySets.length !== 1 ? "s" : ""})`}
              </button>
            </div>
          )}

          {/* ── Status message (shown after deep extract) ── */}
          {phase === "results" && status && !deepExtracting && status !== "Extraction complete. Review results below." && (
            <p className="text-[#a1a1a6] text-xs italic">{status}</p>
          )}

          {/* ── Action buttons ── */}
          <div className="flex items-center justify-between pt-2">
            <button
              onClick={onBack}
              disabled={deepExtracting}
              className="px-4 py-2 bg-white/[0.04] border border-white/[0.08] hover:bg-white/[0.08] disabled:opacity-50 text-[#a1a1a6] rounded-lg transition-colors text-sm"
            >
              Back to Columns
            </button>
            <button
              onClick={handleAcceptResults}
              disabled={deepExtracting}
              className="px-6 py-2 bg-[#0a84ff] hover:bg-[#0975de] text-white rounded-lg transition-colors font-semibold text-sm"
            >
              {extractionHealth.grade === "critical"
                ? "Continue Anyway"
                : "Continue to Triage"}
            </button>
          </div>
        </div>
      )}

      {/* Questions phase: prompt user to review sidebar */}
      {phase === "questions" && (
        <div className="mb-4 p-4 bg-[rgba(10,132,255,0.08)] border border-[rgba(10,132,255,0.2)] rounded-xl">
          <p className="text-[#4BA3E3] text-sm mb-3">
            Extracted {doors.length} doors. Check the sidebar for validation
            questions, then continue to triage.
          </p>
          <button
            onClick={handleContinueToTriage}
            className="px-5 py-2 bg-[#0a84ff] hover:bg-[#0975de] text-white rounded-lg transition-colors font-semibold text-sm"
          >
            Continue to Triage
          </button>
        </div>
      )}

      {/* Triage-failed warning: backend signaled triage_error */}
      {triageResult?.triage_error && (
        <div className="mb-4 p-4 bg-[rgba(255,69,58,0.1)] border border-[rgba(255,69,58,0.3)] rounded-xl">
          <div className="flex items-start gap-2 mb-3">
            <span className="text-[#ff453a] text-lg leading-none">&#x26A0;</span>
            <p className="text-[#ff453a] text-sm font-semibold">
              AI triage failed &mdash; all doors were auto-accepted. Please
              review each entry carefully before proceeding.
            </p>
          </div>
          {triageResult.triage_error_message && (
            <p className="text-[#a1a1a6] text-xs mb-3 ml-6">
              {triageResult.triage_error_message}
            </p>
          )}
          <label className="flex items-center gap-2 ml-6 cursor-pointer">
            <input
              type="checkbox"
              checked={triageErrorAcknowledged}
              onChange={(e) => setTriageErrorAcknowledged(e.target.checked)}
              className="w-4 h-4 rounded border-white/20 bg-white/[0.06] accent-[#ff453a]"
            />
            <span className="text-[#f5f5f7] text-sm">
              I understand triage failed and will review all entries manually
            </span>
          </label>
        </div>
      )}

      {/* Triage results */}
      {triageResult && (
        <>
          <div className="grid grid-cols-3 gap-3 mb-4">
            <div className="bg-white/[0.04] border border-white/[0.06] rounded-xl p-3 text-center">
              <div className="text-xl font-bold text-[#30d158]">
                {triageResult.doors_found}
              </div>
              <div className="text-[9px] text-[#6e6e73] uppercase">
                Doors Found
              </div>
            </div>
            <div className="bg-white/[0.04] border border-white/[0.06] rounded-xl p-3 text-center">
              <div className="text-xl font-bold text-[#ff9500]">
                {triageResult.by_others}
              </div>
              <div className="text-[9px] text-[#6e6e73] uppercase">
                By Others
              </div>
            </div>
            <div className="bg-white/[0.04] border border-white/[0.06] rounded-xl p-3 text-center">
              <div className="text-xl font-bold text-[#ff453a]">
                {triageResult.rejected}
              </div>
              <div className="text-[9px] text-[#6e6e73] uppercase">
                Rejected
              </div>
            </div>
          </div>

          {/* Flagged items */}
          {triageResult.flagged.length > 0 && (
            <div className="mb-4">
              <h4 className="text-[#ff9500] text-sm font-semibold mb-2">
                Flagged Items ({triageResult.flagged.length})
              </h4>
              <div className="space-y-1">
                {triageResult.flagged.map((flag) => (
                  <div
                    key={flag.door_number}
                    className="flex items-center justify-between bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm"
                  >
                    <span className="text-[#f5f5f7] font-mono">
                      {flag.door_number}
                    </span>
                    <span className="text-[#a1a1a6] text-xs">
                      {flag.reason}
                    </span>
                    <span
                      className={`text-[10px] px-1.5 py-0.5 rounded ${
                        flag.confidence >= 0.8
                          ? "bg-[rgba(48,209,88,0.15)] text-[#30d158]"
                          : flag.confidence >= 0.5
                          ? "bg-[rgba(255,149,0,0.15)] text-[#ff9500]"
                          : "bg-[rgba(255,69,58,0.15)] text-[#ff453a]"
                      }`}
                    >
                      {Math.round(flag.confidence * 100)}%
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {/* Navigation (shown for questions, triaging, and done phases — results has its own buttons) */}
      {phase !== "results" && (
        <div className="flex justify-between mt-6">
          <button
            onClick={onBack}
            disabled={isLoading}
            className="px-4 py-2 bg-white/[0.04] border border-white/[0.08] hover:bg-white/[0.08] disabled:opacity-50 text-[#a1a1a6] rounded-lg transition-colors"
          >
            Back
          </button>
          <button
            onClick={handleNext}
            disabled={isLoading || !triageResult || (triageResult?.triage_error === true && !triageErrorAcknowledged)}
            className="px-6 py-2 bg-[#0a84ff] hover:bg-[#0975de] text-white rounded-lg transition-colors font-semibold disabled:opacity-50"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
