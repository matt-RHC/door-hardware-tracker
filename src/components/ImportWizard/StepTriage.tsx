"use client";

import { useState, useEffect, useCallback, useRef } from "react";
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

type TriagePhase = "extracting" | "questions" | "triaging" | "done";

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
  const [doors, setDoors] = useState<DoorEntry[]>([]);
  const [hardwareSets, setHardwareSets] = useState<HardwareSet[]>([]);

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

      // Generate validation questions
      const questions = generateTriageQuestions(extractedDoors);
      generatedQuestionsRef.current = questions;
      if (questions.length > 0) {
        onQuestionsGenerated(questions);
        setPhase("questions");
        setStatus("Review flagged items in the sidebar, then continue.");
      } else {
        // No questions — go straight to triage
        setPhase("triaging");
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : "Extraction failed");
    }
  }, [file, columnMappings, classifyResult, onError, onQuestionsGenerated]);

  // ─── Phase 2: Run triage classification ───
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
        // Flag by_others doors and low-confidence non-door classifications.
        // Don't flag class="door" items — if triage failed, all doors come back
        // as class="door" + confidence="low" and flagging them all is useless.
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
        };
        setTriageResult(result);
      }

      setProgress(100);
      setStatus("Triage complete.");
      setPhase("done");
    } catch (err) {
      onError(err instanceof Error ? err.message : "Triage failed");
    }
  }, [doors, onError]);

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
      <h3 className="text-[#f5f5f7] font-semibold mb-2">Step 3: Triage</h3>
      <p className="text-[#a1a1a6] text-sm mb-4">
        Extracting door schedule data and running triage to identify accepted,
        by-others, and rejected doors.
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

      {/* Triage-failed warning: all classifications came back as triage_failed */}
      {triageResult &&
        triageResult.flagged.length > 0 &&
        triageResult.flagged.every((f) => f.reason === "triage_failed") && (
          <div className="mb-4 p-3 bg-[rgba(255,149,0,0.1)] border border-[rgba(255,149,0,0.25)] rounded-xl flex items-start gap-2">
            <span className="text-[#ff9500] text-lg leading-none">&#x26A0;</span>
            <p className="text-[#ff9500] text-sm">
              AI triage was skipped due to a timeout. All doors were
              auto-accepted &mdash; review carefully.
            </p>
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

      {/* Navigation */}
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
          disabled={isLoading || !triageResult}
          className="px-6 py-2 bg-[#0a84ff] hover:bg-[#0975de] text-white rounded-lg transition-colors font-semibold disabled:opacity-50"
        >
          Next
        </button>
      </div>
    </div>
  );
}
