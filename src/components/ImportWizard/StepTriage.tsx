"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type {
  ClassifyPagesResponse,
  ColumnMapping,
  TriageResult,
  DoorEntry,
  HardwareSet,
} from "./types";
import type { PunchyQuantityCheck } from "@/lib/types";
import { scoreExtraction } from "@/lib/confidence-scoring";
import { type PunchQuestion } from "@/lib/punch-messages";
import {
  arrayBufferToBase64,
  splitPDFByPages,
  splitPDFFixed,
  mergeHardwareSets,
  mergeDoors,
  CHUNK_SIZE_THRESHOLD,
  FALLBACK_PAGES_PER_CHUNK,
} from "@/lib/pdf-utils";
import PunchyReview from "./PunchyReview";

/**
 * Phases: extracting → punchy_review → triaging → done
 * "punchy_review" = Punchy card-by-card review (replaces old results/qty_review/questions)
 */
type TriagePhase = "extracting" | "punchy_review" | "triaging" | "done";

interface StepTriageProps {
  projectId: string;
  file: File;
  pdfStoragePath: string | null;
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
  pdfStoragePath,
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
  const [goldenSample, setGoldenSample] = useState<{
    set_id: string;
    heading: string;
    items: HardwareSet["items"];
    confirmed: boolean;
  } | null>(null);
  const [qtyCheck, setQtyCheck] = useState<PunchyQuantityCheck | null>(null);
  const [pdfBuffer, setPdfBuffer] = useState<ArrayBuffer | null>(null);

  // Keep refs to latest answers and generated questions
  const answersRef = useRef(questionAnswers);
  answersRef.current = questionAnswers;
  const generatedQuestionsRef = useRef<PunchQuestion[]>([]);

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
        setProgress(20);
        setStatus("Running extraction...");

        // If PDF is in storage, send projectId so the server fetches it directly (no payload limit).
        // Otherwise, fall back to sending base64 in the body.
        const parseBody: Record<string, unknown> = { userColumnMapping: mappingPayload };
        if (pdfStoragePath) {
          parseBody.projectId = projectId;
        } else {
          parseBody.pdfBase64 = arrayBufferToBase64(arrayBuffer);
        }

        const parseResp = await fetch("/api/parse-pdf?parseOnly=true", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(parseBody),
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

        // Capture Punchy quantity check for the qty_review phase
        if (parseResult.punchyQuantityCheck) {
          setQtyCheck(parseResult.punchyQuantityCheck);
        }
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

      // Cache PDF buffer for page previews in PunchyReview
      try {
        const buf = await file.arrayBuffer();
        setPdfBuffer(buf);
      } catch { /* non-critical */ }

      // Transition to Punchy card-by-card review
      setPhase("punchy_review");
      setStatus("Punchy is reviewing your extraction.");
    } catch (err) {
      onError(err instanceof Error ? err.message : "Extraction failed");
    }
  }, [file, pdfStoragePath, projectId, columnMappings, classifyResult, onError]);

  // ─── Deep Extract: LLM-based item extraction for empty sets ───
  const handleDeepExtract = useCallback(async () => {
    // Use PunchyReview's internal hardwareSets if available (passed via the component),
    // but fall back to StepTriage's state. PunchyReview maintains its own copy.
    const setsToCheck = hardwareSets;
    const emptySets = setsToCheck
      .filter((s) => (s.items?.length ?? 0) === 0)
      .map((s) => ({ set_id: s.set_id, heading: s.heading ?? "" }));

    if (emptySets.length === 0) {
      console.warn("[deep-extract] No empty sets found — skipping");
      setStatus("All sets already have items — nothing to extract.");
      return;
    }

    setDeepExtracting(true);
    setStatus(`Extracting items for ${emptySets.length} empty set${emptySets.length !== 1 ? "s" : ""} with AI...`);

    try {
      // Build deep extract request body.
      // Always send projectId for server-side PDF fetch when storage path exists.
      // Also send pdfBase64 as fallback.
      const deepExtractBody: Record<string, unknown> = {
        emptySets,
        goldenSample: goldenSample?.confirmed ? {
          set_id: goldenSample.set_id,
          items: (goldenSample.items ?? []).map((i) => ({
            qty: i.qty, name: i.name, manufacturer: i.manufacturer, model: i.model, finish: i.finish,
          })),
        } : undefined,
      };

      if (pdfStoragePath) {
        deepExtractBody.projectId = projectId;
      }

      // Always include base64 as fallback — ensures the API has PDF data
      // even if storage fetch fails server-side
      if (!pdfStoragePath) {
        const hwPages = classifyResult.summary.hardware_set_pages ?? [];
        let pdfBase64 = "";
        if (hwPages.length > 0) {
          const arrayBuffer = await file.arrayBuffer();
          const chunks = await splitPDFByPages(arrayBuffer, [hwPages], []);
          pdfBase64 = chunks[0] ?? "";
        }
        if (!pdfBase64) {
          const arrayBuffer = await file.arrayBuffer();
          pdfBase64 = arrayBufferToBase64(arrayBuffer);
        }
        if (!pdfBase64) {
          setStatus("Deep extract failed: couldn't read PDF data.");
          setDeepExtracting(false);
          return;
        }
        deepExtractBody.pdfBase64 = pdfBase64;
      }

      console.debug(`[deep-extract] Sending request for ${emptySets.length} empty sets, projectId=${pdfStoragePath ? projectId : 'none'}`);

      const resp = await fetch("/api/parse-pdf/deep-extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(deepExtractBody),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: `HTTP ${resp.status}` }));
        console.error("Deep extract failed:", err.error ?? err);
        setStatus(`Deep extraction failed: ${err.error ?? resp.status}. You can still continue.`);
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
  }, [hardwareSets, file, pdfStoragePath, projectId, classifyResult, goldenSample]);

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
          projectId: pdfStoragePath ? projectId : undefined,
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
  }, [doors, file, pdfStoragePath, projectId, classifyResult, onError]);

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

  // Pass only triage-accepted doors to the next step, not all extracted doors.
  const handleNext = () => {
    if (!triageResult) return;
    onComplete(triageResult, triageResult.accepted, hardwareSets);
  };

  const isLoading = phase === "extracting" || phase === "triaging";

  return (
    <div className="max-w-2xl mx-auto">
      <h3 className="text-primary font-semibold mb-2">Step 3: Extract &amp; Triage</h3>
      <p className="text-secondary text-sm mb-4">
        {phase === "extracting"
          ? "Extracting door schedule data from your PDF..."
          : phase === "punchy_review"
          ? "Punchy is walking you through the extraction results."
          : "Classifying doors as accepted, by-others, or rejected."}
      </p>

      {/* Progress */}
      {isLoading && (
        <div className="mb-4">
          <div className="flex justify-between text-sm mb-1">
            <span className="text-secondary">{status}</span>
            <span className="text-tertiary">{progress}%</span>
          </div>
          <div className="w-full bg-tint rounded-full h-2 overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-500 ease-out bg-accent"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════
          PUNCHY CARD-BY-CARD REVIEW
          Replaces old dashboard + qty_review + questions phases.
         ═══════════════════════════════════════════════════════════════ */}
      {phase === "punchy_review" && (
        <PunchyReview
          doors={doors}
          hardwareSets={hardwareSets}
          qtyCheck={qtyCheck}
          pages={classifyResult.pages}
          pdfBuffer={pdfBuffer}
          projectId={projectId}
          onGoldenSampleConfirmed={(sample) => setGoldenSample(sample)}
          onDeepExtract={handleDeepExtract}
          deepExtracting={deepExtracting}
          onComplete={(updates) => {
            setHardwareSets(updates.hardwareSets);
            // Store triage questions for hints
            generatedQuestionsRef.current = updates.triageQuestions;
            if (updates.triageQuestions.length > 0) {
              onQuestionsGenerated(updates.triageQuestions);
            }
            setPhase("triaging");
          }}
          onBack={onBack}
        />
      )}

      {/* Triage-failed warning: backend signaled triage_error */}
      {triageResult?.triage_error && (
        <div className="mb-4 p-4 bg-danger-dim border border-danger rounded-xl">
          <div className="flex items-start gap-2 mb-3">
            <span className="text-danger text-lg leading-none" aria-label="Warning">&#x26A0;</span>
            <p className="text-danger text-sm font-semibold">
              AI triage failed &mdash; all doors were auto-accepted. Please
              review each entry carefully before proceeding.
            </p>
          </div>
          {triageResult.triage_error_message && (
            <p className="text-secondary text-xs mb-3 ml-6">
              {triageResult.triage_error_message}
            </p>
          )}
          <label className="flex items-center gap-2 ml-6 cursor-pointer">
            <input
              type="checkbox"
              checked={triageErrorAcknowledged}
              onChange={(e) => setTriageErrorAcknowledged(e.target.checked)}
              className="w-4 h-4 rounded border-white/20 bg-tint accent-danger"
            />
            <span className="text-primary text-sm">
              I understand triage failed and will review all entries manually
            </span>
          </label>
        </div>
      )}

      {/* Triage results */}
      {triageResult && (
        <>
          <div className="grid grid-cols-3 gap-3 mb-4">
            <div className="bg-tint border border-border-dim rounded-xl p-3 text-center">
              <div className="text-xl font-bold text-success">
                {triageResult.doors_found}
              </div>
              <div className="text-[9px] text-tertiary uppercase">
                Doors Found
              </div>
            </div>
            <div className="bg-tint border border-border-dim rounded-xl p-3 text-center">
              <div className="text-xl font-bold text-warning">
                {triageResult.by_others}
              </div>
              <div className="text-[9px] text-tertiary uppercase">
                By Others
              </div>
            </div>
            <div className="bg-tint border border-border-dim rounded-xl p-3 text-center">
              <div className="text-xl font-bold text-danger">
                {triageResult.rejected}
              </div>
              <div className="text-[9px] text-tertiary uppercase">
                Rejected
              </div>
            </div>
          </div>

          {/* Flagged items */}
          {triageResult.flagged.length > 0 && (
            <div className="mb-4">
              <h4 className="text-warning text-sm font-semibold mb-2">
                Flagged Items ({triageResult.flagged.length})
              </h4>
              <div className="space-y-1">
                {triageResult.flagged.map((flag) => (
                  <div
                    key={flag.door_number}
                    className="flex items-center justify-between bg-tint border border-border-dim-strong rounded-lg px-3 py-2 text-sm"
                  >
                    <span className="text-primary font-mono">
                      {flag.door_number}
                    </span>
                    <span className="text-secondary text-xs">
                      {flag.reason}
                    </span>
                    <span
                      className={`text-[10px] px-1.5 py-0.5 rounded ${
                        flag.confidence >= 0.8
                          ? "bg-success-dim text-success"
                          : flag.confidence >= 0.5
                          ? "bg-warning-dim text-warning"
                          : "bg-danger-dim text-danger"
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

      {/* Navigation (shown for triaging and done phases — punchy_review has its own buttons) */}
      {phase !== "punchy_review" && phase !== "extracting" && (
        <div className="flex justify-between mt-6">
          <button
            onClick={onBack}
            disabled={isLoading}
            className="px-4 py-2 bg-tint border border-border-dim-strong hover:bg-tint-strong disabled:opacity-50 text-secondary rounded-lg transition-colors"
          >
            Back
          </button>
          <button
            onClick={handleNext}
            disabled={isLoading || !triageResult || (triageResult?.triage_error === true && !triageErrorAcknowledged)}
            className="px-6 py-2 bg-accent hover:bg-accent/80 text-white rounded-lg transition-colors font-semibold disabled:opacity-50"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
