"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type {
  ClassifyPagesResponse,
  ColumnMapping,
  TriageResult,
  DoorEntry,
  HardwareSet,
} from "./types";
import { transformTriageResponse } from "./transforms";
import type { DarrinQuantityCheck } from "@/lib/types";
import type { ExtractionConfidence } from "@/lib/types/confidence";
import type { ReconciliationResult } from "@/lib/types/reconciliation";
import { scoreExtraction } from "@/lib/confidence-scoring";
import { findPageForSet } from "@/lib/punch-cards";
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
import DarrinReview from "./DarrinReview";

/**
 * Phases: extracting → darrin_review → triaging → done
 * "darrin_review" = Darrin card-by-card review (replaces old results/qty_review/questions)
 */
type TriagePhase = "extracting" | "darrin_review" | "triaging" | "done";

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
  // Set IDs that Darrin tried to deep-extract but returned zero items
  // for. Tracked so the DarrinReview empty_sets card can disable the
  // batch "Extract with AI" button and tell the user to use the per-set
  // resolution options (Add manually / Remove / Try with hint) instead
  // of clicking the useless batch button repeatedly.
  const [emptySetsAttempted, setEmptySetsAttempted] = useState<Set<string>>(
    () => new Set()
  );
  const [goldenSample, setGoldenSample] = useState<{
    set_id: string;
    heading: string;
    items: HardwareSet["items"];
    confirmed: boolean;
  } | null>(null);
  const [qtyCheck, setQtyCheck] = useState<DarrinQuantityCheck | null>(null);
  const [extractionConfidence, setExtractionConfidence] = useState<ExtractionConfidence | null>(null);
  const [reconciliationResult, setReconciliationResult] = useState<ReconciliationResult | null>(null);
  // Deep extract for full submittal (not just empty sets)
  const [deepExtractProgress, setDeepExtractProgress] = useState<string | null>(null);
  const [deepExtractComplete, setDeepExtractComplete] = useState(false);
  const [pdfBuffer, setPdfBuffer] = useState<ArrayBuffer | null>(null);
  const [failedChunks, setFailedChunks] = useState<Array<{ index: number; error: string }>>([]);
  const [totalChunks, setTotalChunks] = useState(0);
  const [retryingChunks, setRetryingChunks] = useState(false);
  // Store chunk data for retry
  const chunksRef = useRef<string[]>([]);
  const mappingPayloadRef = useRef<Record<string, number> | null>(null);

  // Keep refs to latest answers and generated questions
  const answersRef = useRef(questionAnswers);
  answersRef.current = questionAnswers;
  const generatedQuestionsRef = useRef<PunchQuestion[]>([]);

  // Ref for current hardwareSets — used by handleDeepExtract to read current
  // state without capturing a stale closure value in the useCallback deps.
  const hardwareSetsRef = useRef(hardwareSets);
  hardwareSetsRef.current = hardwareSets;

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
        const schedulePages = classifyResult.summary.door_schedule_pages ?? [];
        const hwPages = classifyResult.summary.hardware_set_pages ?? [];
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
          const refPages = classifyResult.summary.submittal_pages ?? [];
          chunks = await splitPDFByPages(arrayBuffer, chunkSets, refPages);
        } else {
          chunks = await splitPDFFixed(arrayBuffer, FALLBACK_PAGES_PER_CHUNK);
        }

        setProgress(20);
        setStatus(`Extracting from ${chunks.length} chunk(s)...`);

        const allDoors: DoorEntry[] = [];
        const allSets: HardwareSet[] = [];
        // Collect darrinQuantityCheck flags across all chunks so the qty
        // review phase has data even for large PDFs. Flags are merged by
        // appending — the qty check UI deduplicates by set_id on render.
        const allQtyFlags: DarrinQuantityCheck["flags"] = [];
        const allQtyComplianceIssues: DarrinQuantityCheck["compliance_issues"] = [];
        const chunkFailures: Array<{ index: number; error: string }> = [];

        setTotalChunks(chunks.length);
        chunksRef.current = chunks;
        mappingPayloadRef.current = mappingPayload;

        for (let i = 0; i < chunks.length; i++) {
          setStatus(`Extracting chunk ${i + 1} of ${chunks.length}...`);
          setProgress(20 + Math.round((i / chunks.length) * 40));

          // Route to the dedicated chunk endpoint which accepts chunkIndex /
          // totalChunks / knownSetIds and returns the correct response shape
          // including darrinQuantityCheck. The main /api/parse-pdf route does
          // not consume these fields and silently ignores ?parseOnly=true.
          const knownSetIds = allSets.map((s) => s.set_id);
          const chunkResp = await fetch("/api/parse-pdf/chunk", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chunkBase64: chunks[i],
              chunkIndex: i,
              totalChunks: chunks.length,
              knownSetIds,
              userColumnMapping: mappingPayload,
            }),
          });

          if (!chunkResp.ok) {
            const err = await chunkResp.json().catch(() => ({}));
            const errorMsg = err.error || `HTTP ${chunkResp.status}`;
            console.warn(`Chunk ${i + 1} failed:`, errorMsg);
            chunkFailures.push({ index: i, error: errorMsg });
            continue;
          }

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const chunkResult: any = await chunkResp.json();
          allDoors.push(...(chunkResult.doors ?? []));
          allSets.push(...(chunkResult.hardwareSets ?? []));

          // Accumulate quantity check data from each chunk
          if (chunkResult.darrinQuantityCheck) {
            allQtyFlags.push(...(chunkResult.darrinQuantityCheck.flags ?? []));
            allQtyComplianceIssues.push(
              ...(chunkResult.darrinQuantityCheck.compliance_issues ?? [])
            );
          }
        }

        if (chunkFailures.length > 0) {
          setFailedChunks(chunkFailures);
        }

        // Set merged qty check state if any chunk produced data
        if (allQtyFlags.length > 0 || allQtyComplianceIssues.length > 0) {
          setQtyCheck({
            flags: allQtyFlags,
            compliance_issues: allQtyComplianceIssues,
            notes: `Quantity check across ${chunks.length} chunk(s): ${allQtyFlags.length} flag(s), ${allQtyComplianceIssues.length} compliance issue(s).`,
          });
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

        const parseResp = await fetch("/api/parse-pdf", {
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

        // Capture Darrin quantity check for the qty_review phase
        if (parseResult.darrinQuantityCheck) {
          setQtyCheck(parseResult.darrinQuantityCheck);
        }

        // Capture extraction confidence for deep extract banner
        if (parseResult.confidence) {
          setExtractionConfidence(parseResult.confidence);
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

      // Populate pdf_page on each hardware set from classify-pages metadata.
      // This is persisted to openings.pdf_page on save (issue #8) so that the
      // door detail page and dashboard cards can link back to the PDF page
      // where the set's definition lives. Uses generic_set_id first to match
      // the lookup strategy in StepReview.tsx:391-397.
      const classifyPages = classifyResult?.pages ?? [];
      for (const set of extractedSets) {
        const primaryKey = set.generic_set_id ?? set.set_id;
        const page =
          findPageForSet(primaryKey, classifyPages) ??
          (set.generic_set_id && set.set_id !== set.generic_set_id
            ? findPageForSet(set.set_id, classifyPages)
            : null);
        set.pdf_page = page;
      }

      setDoors(extractedDoors);
      setHardwareSets(extractedSets);
      setProgress(60);

      // Cache PDF buffer for page previews in DarrinReview
      try {
        const buf = await file.arrayBuffer();
        setPdfBuffer(buf);
      } catch { /* non-critical */ }

      // Transition to Darrin card-by-card review
      setPhase("darrin_review");
      setStatus("Darrin is reviewing your extraction.");
    } catch (err) {
      setPhase("done");
      onError(err instanceof Error ? err.message : "Extraction failed");
    }
  }, [file, pdfStoragePath, projectId, columnMappings, classifyResult, onError]);

  // ─── Retry failed chunks ───
  const retryFailedChunks = useCallback(async () => {
    if (failedChunks.length === 0 || chunksRef.current.length === 0) return;
    setRetryingChunks(true);
    setStatus(`Retrying ${failedChunks.length} failed chunk(s)...`);

    const chunks = chunksRef.current;
    const mappingPayload = mappingPayloadRef.current;
    const stillFailed: Array<{ index: number; error: string }> = [];
    const allSets = hardwareSetsRef.current;

    for (const fc of failedChunks) {
      const i = fc.index;
      if (i >= chunks.length) continue;
      setStatus(`Retrying chunk ${i + 1} of ${chunks.length}...`);

      const knownSetIds = allSets.map((s) => s.set_id);
      const chunkResp = await fetch("/api/parse-pdf/chunk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chunkBase64: chunks[i],
          chunkIndex: i,
          totalChunks: chunks.length,
          knownSetIds,
          userColumnMapping: mappingPayload,
        }),
      });

      if (!chunkResp.ok) {
        const err = await chunkResp.json().catch(() => ({}));
        stillFailed.push({ index: i, error: err.error || `HTTP ${chunkResp.status}` });
        continue;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chunkResult: any = await chunkResp.json();
      const newDoors: DoorEntry[] = chunkResult.doors ?? [];
      const newSets: HardwareSet[] = chunkResult.hardwareSets ?? [];

      if (newDoors.length > 0) {
        setDoors((prev) => mergeDoors([...prev, ...newDoors]));
      }
      if (newSets.length > 0) {
        setHardwareSets((prev) => mergeHardwareSets([...prev, ...newSets]));
      }
    }

    setFailedChunks(stillFailed);
    if (stillFailed.length === 0) {
      setStatus("All chunks recovered successfully.");
    } else {
      setStatus(`${stillFailed.length} chunk(s) still failing. You can continue with partial data.`);
    }
    setRetryingChunks(false);
  }, [failedChunks]);

  // ─── Deep Extract: LLM-based item extraction for empty sets ───
  // Accepts optional opts:
  //   - userHint: free-text hint forwarded to Darrin ("this set is on page 18")
  //   - targetSetIds: restrict the extraction to a specific set of empty IDs
  //     (used by per-row "Try with hint" retries from DarrinReview)
  const handleDeepExtract = useCallback(async (
    opts?: { userHint?: string; targetSetIds?: string[] }
  ) => {
    // Read current hardwareSets from ref to avoid stale closure
    const setsToCheck = hardwareSetsRef.current;
    const targetIds = opts?.targetSetIds ?? [];
    const emptySets = setsToCheck
      .filter((s) => (s.items?.length ?? 0) === 0)
      .filter((s) => targetIds.length === 0 || targetIds.includes(s.set_id))
      .map((s) => ({ set_id: s.set_id, heading: s.heading ?? "" }));

    if (emptySets.length === 0) {
      console.warn("[deep-extract] No empty sets found — skipping");
      setStatus("All sets already have items — nothing to extract.");
      return;
    }

    const trimmedHint = (opts?.userHint ?? "").trim();
    const hasHint = trimmedHint.length > 0;

    setDeepExtracting(true);
    setStatus(
      hasHint
        ? `Retrying ${emptySets.length} set${emptySets.length !== 1 ? "s" : ""} with your hint...`
        : `Extracting items for ${emptySets.length} empty set${emptySets.length !== 1 ? "s" : ""} with AI...`
    );

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

      if (hasHint) {
        deepExtractBody.userHint = trimmedHint;
      }

      if (pdfStoragePath) {
        deepExtractBody.projectId = projectId;
      }

      // Always include base64 as fallback — ensures the API has PDF data
      // even if storage fetch fails server-side
      if (!pdfStoragePath) {
        const deepHwPages = classifyResult?.summary?.hardware_set_pages ?? [];
        let pdfBase64 = "";
        if (deepHwPages.length > 0) {
          const arrayBuffer = await file.arrayBuffer();
          const chunks = await splitPDFByPages(arrayBuffer, [deepHwPages], []);
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

      // Merge extracted items into existing hardware sets.
      //
      // Darrin may return entries with `items: []` for sets it couldn't
      // find anything for (the DH-4 phantom-set case from 2026-04-11).
      // Track those in `emptySetsAttempted` so the DarrinReview empty_sets
      // card can disable the batch "Extract with AI" button and push the
      // user toward the per-set resolution options.
      const setsWithItems = extractedSets.filter(
        (s) => (s.items?.length ?? 0) > 0
      );
      const setsReturnedEmpty = extractedSets.filter(
        (s) => (s.items?.length ?? 0) === 0
      );

      if (setsWithItems.length > 0) {
        setHardwareSets((prev) => {
          const updated = [...prev];
          for (const extracted of setsWithItems) {
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
      }

      if (setsReturnedEmpty.length > 0) {
        setEmptySetsAttempted((prev) => {
          const next = new Set(prev);
          for (const s of setsReturnedEmpty) next.add(s.set_id);
          return next;
        });
      }

      const totalNewItems = setsWithItems.reduce(
        (sum, s) => sum + (s.items?.length ?? 0),
        0
      );
      if (setsWithItems.length > 0 && setsReturnedEmpty.length === 0) {
        setStatus(
          `Deep extract found ${totalNewItems} item${totalNewItems !== 1 ? "s" : ""} across ${setsWithItems.length} set${setsWithItems.length !== 1 ? "s" : ""}.`
        );
      } else if (setsWithItems.length > 0 && setsReturnedEmpty.length > 0) {
        setStatus(
          `Deep extract found ${totalNewItems} item${totalNewItems !== 1 ? "s" : ""} for ${setsWithItems.length} set${setsWithItems.length !== 1 ? "s" : ""}. ${setsReturnedEmpty.length} set${setsReturnedEmpty.length !== 1 ? "s" : ""} returned no items — use the per-set options to resolve.`
        );
      } else {
        setStatus(
          `Darrin couldn't find items for ${setsReturnedEmpty.length || emptySets.length} set${(setsReturnedEmpty.length || emptySets.length) !== 1 ? "s" : ""}. Use the per-set options (Add manually / Remove / Try with hint) to resolve.`
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("Deep extract error:", err);
      setStatus(`Deep extraction failed: ${message}. You can still continue.`);
    } finally {
      setDeepExtracting(false);
    }
  }, [file, pdfStoragePath, projectId, classifyResult, goldenSample]);

  // ─── Full-submittal deep extract (vision cross-validation) ───
  // Unlike handleDeepExtract (which targets empty sets), this sends the
  // entire submittal for vision-model extraction + reconciliation.
  const handleFullDeepExtract = useCallback(async () => {
    if (typeof window !== "undefined" &&
      !window.confirm(
        "Deep extraction sends each page to an AI vision model for cross-validation. This takes 2\u20135 minutes. Continue?"
      )
    ) {
      return;
    }

    setDeepExtracting(true);
    setDeepExtractProgress("Starting deep extraction...");
    setDeepExtractComplete(false);

    try {
      const body: Record<string, unknown> = {};
      if (pdfStoragePath) {
        body.projectId = projectId;
      } else {
        const arrayBuffer = await file.arrayBuffer();
        body.pdfBase64 = arrayBufferToBase64(arrayBuffer);
      }

      // Include all current sets so the API can reconcile
      body.hardwareSets = hardwareSetsRef.current.map(s => ({
        set_id: s.set_id,
        heading: s.heading,
        items: (s.items ?? []).map(i => ({
          qty: i.qty, name: i.name, manufacturer: i.manufacturer, model: i.model, finish: i.finish,
        })),
      }));

      setDeepExtractProgress("Sending pages to vision model...");

      const resp = await fetch("/api/parse-pdf/deep-extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: `HTTP ${resp.status}` }));
        setStatus(`Deep extraction failed: ${err.error ?? resp.status}. You can still continue.`);
        setDeepExtractProgress(null);
        setDeepExtracting(false);
        return;
      }

      setDeepExtractProgress("Reconciling results...");

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result: any = await resp.json();
      const extractedSets = result.sets ?? [];

      // Merge results into current hardware sets
      if (extractedSets.length > 0) {
        setHardwareSets((prev) => {
          const updated = [...prev];
          for (const extracted of extractedSets) {
            const idx = updated.findIndex((s) => s.set_id === extracted.set_id);
            if (idx >= 0 && extracted.items?.length > 0) {
              updated[idx] = { ...updated[idx], items: extracted.items };
            }
          }
          return updated;
        });
      }

      // Store reconciliation result if available
      if (result.reconciliation) {
        setReconciliationResult(result.reconciliation);
      }

      const totalItems = extractedSets.reduce(
        (sum: number, s: { items?: unknown[] }) => sum + (s.items?.length ?? 0), 0
      );
      setDeepExtractComplete(true);
      setDeepExtractProgress(null);
      setStatus(`Deep extraction complete \u2014 ${totalItems} items verified across ${extractedSets.length} sets.`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setStatus(`Deep extraction failed: ${message}. You can still continue.`);
      setDeepExtractProgress(null);
    } finally {
      setDeepExtracting(false);
    }
  }, [file, pdfStoragePath, projectId]);

  // ─── Empty-set resolution: phantom-set removal ───
  // Removes a hardware set entirely and clears `hw_set` on every door that
  // referenced it. Used by the "Remove" button on the empty_sets card when the
  // user determines a set was a parsing artifact and shouldn't exist.
  // hw_set is non-nullable string in DoorEntry — clear with "" not null.
  const handleRemoveSet = useCallback((setId: string) => {
    const refCount = doors.filter((d) => d.hw_set === setId).length;
    const message =
      refCount > 0
        ? `Remove set ${setId}? ${refCount} door${refCount !== 1 ? "s" : ""} reference${refCount === 1 ? "s" : ""} this set and will become unassigned.`
        : `Remove set ${setId}?`;
    if (typeof window !== "undefined" && !window.confirm(message)) {
      return;
    }
    setHardwareSets((prev) => prev.filter((s) => s.set_id !== setId));
    setDoors((prev) =>
      prev.map((d) => (d.hw_set === setId ? { ...d, hw_set: "" } : d))
    );
    setEmptySetsAttempted((prev) => {
      if (!prev.has(setId)) return prev;
      const next = new Set(prev);
      next.delete(setId);
      return next;
    });
    setStatus(`Removed set ${setId}.`);
  }, [doors]);

  // ─── Empty-set resolution: manual entry sentinel ───
  // Inserts a single placeholder item into an otherwise-empty set so that
  // generatePunchCards no longer flags it as an empty set. The user fills in
  // the real items in StepReview afterward. qty_source is `?: string` in
  // ExtractedHardwareItem (see types/index.ts) — "manual_placeholder" is a
  // type-safe sentinel value the downstream UI can recognize.
  const handleAddManualPlaceholder = useCallback((setId: string) => {
    setHardwareSets((prev) =>
      prev.map((s) =>
        s.set_id === setId && (s.items?.length ?? 0) === 0
          ? {
              ...s,
              items: [
                {
                  qty: 1,
                  name: "",
                  manufacturer: "",
                  model: "",
                  finish: "",
                  qty_source: "manual_placeholder",
                },
              ],
            }
          : s
      )
    );
    setEmptySetsAttempted((prev) => {
      if (!prev.has(setId)) return prev;
      const next = new Set(prev);
      next.delete(setId);
      return next;
    });
    setStatus(`Marked ${setId} for manual entry.`);
  }, []);

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
      const schedulePages2 = classifyResult?.summary?.door_schedule_pages ?? [];
      const hwPages3 = classifyResult?.summary?.hardware_set_pages ?? [];
      const relevantPages = [...schedulePages2, ...hwPages3];
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
        const raw = (await triageResp.json()) as Record<string, unknown>;
        setTriageResult(transformTriageResponse(raw, doors));
      }

      setProgress(100);
      setStatus("Triage complete.");
      setPhase("done");
    } catch (err) {
      onError(err instanceof Error ? err.message : "Triage failed");
    }
  }, [doors, file, pdfStoragePath, projectId, classifyResult, onError]);

  // Start extraction on mount — hasRun guard prevents duplicate API calls
  // if runExtraction identity changes (e.g. from React StrictMode or dep shifts)
  const extractionStarted = useRef(false);
  useEffect(() => {
    if (extractionStarted.current) return;
    extractionStarted.current = true;
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
          : phase === "darrin_review"
          ? "Darrin is walking you through the extraction results."
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

      {/* Chunk failure warning banner */}
      {failedChunks.length > 0 && !isLoading && (
        <div className="mb-4 p-4 bg-warning-dim border border-warning rounded-md">
          <div className="flex items-start gap-2 mb-2">
            <span className="text-warning text-lg leading-none" aria-label="Warning">&#x26A0;</span>
            <p className="text-warning text-sm font-semibold">
              {failedChunks.length} of {totalChunks} extraction chunk{totalChunks !== 1 ? "s" : ""} failed. Some doors may be missing from the results.
            </p>
          </div>
          <div className="ml-6 space-y-1 mb-3">
            {failedChunks.map((fc) => (
              <p key={fc.index} className="text-secondary text-xs">
                Chunk {fc.index + 1}: {fc.error}
              </p>
            ))}
          </div>
          <div className="ml-6">
            <button
              onClick={retryFailedChunks}
              disabled={retryingChunks}
              className="text-xs px-3 py-1.5 rounded-lg bg-warning text-white hover:bg-warning/80 transition-colors disabled:opacity-50"
            >
              {retryingChunks ? "Retrying..." : `Retry ${failedChunks.length} Failed Chunk${failedChunks.length !== 1 ? "s" : ""}`}
            </button>
          </div>
        </div>
      )}

      {/* ─── Deep Extract Banner ─── */}
      {phase === "darrin_review" && !deepExtracting && !deepExtractComplete && extractionConfidence?.suggest_deep_extraction && (
        <div className="mb-4 p-4 bg-warning-dim border border-warning rounded-md">
          <div className="flex items-start gap-2 mb-2">
            <span className="text-warning text-lg leading-none" aria-hidden="true">&#x26A0;&#xFE0F;</span>
            <div>
              <p className="text-warning text-sm font-semibold mb-1">
                Some fields have low confidence. Deep extraction can improve accuracy.
              </p>
              {(extractionConfidence.deep_extraction_reasons ?? []).length > 0 && (
                <ul className="text-secondary text-xs space-y-0.5 mb-2">
                  {(extractionConfidence.deep_extraction_reasons ?? []).map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              )}
            </div>
          </div>
          <div className="ml-6">
            <button
              onClick={handleFullDeepExtract}
              className="px-4 py-2 rounded-lg bg-accent hover:bg-accent/80 text-white text-sm font-semibold transition-colors"
            >
              Run Deep Extract
            </button>
          </div>
        </div>
      )}

      {/* Deep extract running indicator */}
      {deepExtracting && deepExtractProgress && (
        <div className="mb-4 p-4 bg-accent-dim border border-accent rounded-md">
          <div className="flex items-center gap-3">
            <span className="text-accent animate-pulse text-lg" aria-hidden="true">&#x1F50D;</span>
            <div className="flex-1">
              <p className="text-primary text-sm font-medium mb-1">
                Deep extraction is running — this may take a few minutes.
              </p>
              <p className="text-secondary text-xs">{deepExtractProgress}</p>
              <div className="mt-2 w-full bg-tint rounded-full h-1.5 overflow-hidden">
                <div className="h-full rounded-full bg-accent animate-pulse" style={{ width: "60%" }} />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Deep extract complete banner */}
      {deepExtractComplete && reconciliationResult && (
        <div className="mb-4 p-4 bg-success-dim border border-success rounded-md">
          <div className="flex items-center gap-2">
            <span className="text-success text-lg" aria-hidden="true">&#x2713;</span>
            <p className="text-success text-sm font-semibold">
              Deep extraction complete — {reconciliationResult.summary.full_agreement_pct}% of fields verified by multiple strategies.
            </p>
          </div>
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════
          DARRIN CARD-BY-CARD REVIEW
          Replaces old dashboard + qty_review + questions phases.
         ═══════════════════════════════════════════════════════════════ */}
      {phase === "darrin_review" && (
        <DarrinReview
          doors={doors}
          hardwareSets={hardwareSets}
          qtyCheck={qtyCheck}
          pages={classifyResult.pages}
          pdfBuffer={pdfBuffer}
          projectId={projectId}
          onGoldenSampleConfirmed={(sample) => setGoldenSample(sample)}
          onDeepExtract={handleDeepExtract}
          onRemoveSet={handleRemoveSet}
          onAddManualPlaceholder={handleAddManualPlaceholder}
          deepExtracting={deepExtracting}
          emptySetsAttempted={emptySetsAttempted}
          onComplete={(updates) => {
            setHardwareSets(updates.hardwareSets);
            // Store triage questions for hints
            const tqs = updates.triageQuestions ?? [];
            generatedQuestionsRef.current = tqs;
            if (tqs.length > 0) {
              onQuestionsGenerated(tqs);
            }
            setPhase("triaging");
          }}
          onBack={onBack}
        />
      )}

      {/* Triage-failed warning: backend signaled triage_error */}
      {triageResult?.triage_error && (
        <div className="mb-4 p-4 bg-danger-dim border border-danger rounded-md">
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
          <div className="flex items-center gap-3 ml-6">
            {triageResult.retryable && (
              <button
                type="button"
                onClick={() => {
                  setTriageResult(null);
                  setTriageErrorAcknowledged(false);
                  setPhase("triaging");
                }}
                disabled={phase === "triaging"}
                className="px-3 py-1.5 text-xs font-medium text-white bg-accent hover:bg-accent/80 disabled:opacity-50 rounded-lg transition-colors"
              >
                Retry Classification
              </button>
            )}
            <label className="flex items-center gap-2 cursor-pointer">
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
        </div>
      )}

      {/* Triage results */}
      {triageResult && (
        <>
          <div className="grid grid-cols-3 gap-3 mb-4">
            <div className="bg-tint border border-border-dim rounded-md p-3 text-center">
              <div className="text-xl font-bold text-success">
                {triageResult.doors_found}
              </div>
              <div className="text-[9px] text-tertiary uppercase">
                Doors Found
              </div>
            </div>
            <div className="bg-tint border border-border-dim rounded-md p-3 text-center">
              <div className="text-xl font-bold text-warning">
                {triageResult.by_others}
              </div>
              <div className="text-[9px] text-tertiary uppercase">
                By Others
              </div>
            </div>
            <div className="bg-tint border border-border-dim rounded-md p-3 text-center">
              <div className="text-xl font-bold text-danger">
                {triageResult.rejected}
              </div>
              <div className="text-[9px] text-tertiary uppercase">
                Rejected
              </div>
            </div>
          </div>

          {/* Flagged items */}
          {(triageResult.flagged ?? []).length > 0 && (
            <div className="mb-4">
              <h4 className="text-warning text-sm font-semibold mb-2">
                Flagged Items ({(triageResult.flagged ?? []).length})
              </h4>
              <div className="space-y-1">
                {(triageResult.flagged ?? []).map((flag) => (
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

      {/* Navigation (shown for triaging and done phases — darrin_review has its own buttons) */}
      {phase !== "darrin_review" && phase !== "extracting" && (
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
