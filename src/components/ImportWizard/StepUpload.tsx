"use client";

import { useState, useRef, useCallback, type ChangeEvent, type DragEvent } from "react";
import type { ClassifyPagesResponse } from "./types";

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB

interface StepUploadProps {
  projectId: string;
  onComplete: (
    file: File,
    classifyResult: ClassifyPagesResponse,
    hasExistingData: boolean
  ) => void;
  onError: (msg: string) => void;
}

export default function StepUpload({
  projectId,
  onComplete,
  onError,
}: StepUploadProps) {
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");
  const [progress, setProgress] = useState(0);
  const [classifyResult, setClassifyResult] =
    useState<ClassifyPagesResponse | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ─── File validation ───
  const validateAndSetFile = useCallback(
    (f: File) => {
      if (f.type !== "application/pdf") {
        onError("Please select a PDF file.");
        return;
      }
      if (f.size > MAX_FILE_SIZE) {
        onError(`File is too large (${(f.size / 1024 / 1024).toFixed(1)} MB). Maximum is 50 MB.`);
        return;
      }
      setFile(f);
      setClassifyResult(null);
    },
    [onError]
  );

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0];
    if (selected) validateAndSetFile(selected);
  };

  // ─── Drag & drop ───
  const handleDragOver = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  };
  const handleDragLeave = () => setDragOver(false);
  const handleDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const dropped = e.dataTransfer.files[0];
    if (dropped) validateAndSetFile(dropped);
  };

  // ─── Classify pages ───
  const handleClassify = async () => {
    if (!file) return;
    setLoading(true);
    setStatus("Reading PDF...");
    setProgress(10);

    try {
      // Convert file to base64 — the Python endpoint expects JSON, not FormData
      const arrayBuffer = await file.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);
      let binary = "";
      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      const pdfBase64 = btoa(binary);

      setProgress(30);
      setStatus("Classifying pages...");

      const resp = await fetch("/api/classify-pages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pdfBase64 }),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(
          err.error || `Classification failed (${resp.status})`
        );
      }

      // Transform Python response to match ClassifyPagesResponse type.
      // Python returns: { page_classifications: [{index, type, ...}], summary: {door_schedule_pages: count, ...} }
      // TS expects:     { pages: [{page_number, page_type, confidence}], summary: {door_schedule_pages: number[], ...} }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const raw: any = await resp.json();
      const pageClassifications: Array<{ index: number; type: string; confidence?: number }> =
        raw.page_classifications ?? [];

      const result: ClassifyPagesResponse = {
        pages: pageClassifications.map((p) => ({
          page_number: p.index,
          page_type: p.type as ClassifyPagesResponse["pages"][0]["page_type"],
          confidence: p.confidence ?? 1,
        })),
        summary: {
          total_pages: raw.total_pages ?? pageClassifications.length,
          door_schedule_pages: pageClassifications
            .filter((p) => p.type === "door_schedule")
            .map((p) => p.index),
          hardware_set_pages: pageClassifications
            .filter((p) => p.type === "hardware_set")
            .map((p) => p.index),
          submittal_pages: pageClassifications
            .filter((p) => p.type === "reference")
            .map((p) => p.index),
          other_pages: pageClassifications
            .filter((p) => p.type === "other" || p.type === "cover")
            .map((p) => p.index),
        },
      };
      setClassifyResult(result);
      setProgress(70);
      setStatus("Classification complete.");

      // Check for existing project data (revision mode)
      setStatus("Checking for existing project data...");
      setProgress(80);

      let hasExisting = false;
      try {
        const openingsResp = await fetch(
          `/api/projects/${projectId}/openings`
        );
        if (openingsResp.ok) {
          const data = await openingsResp.json();
          hasExisting = Array.isArray(data) && data.length > 0;
        }
      } catch {
        // Treat as no existing data
      }

      setProgress(100);
      setStatus("Ready to proceed.");
      setLoading(false);

      onComplete(file, result, hasExisting);
    } catch (err) {
      setLoading(false);
      setProgress(0);
      setStatus("");
      onError(err instanceof Error ? err.message : "Classification failed");
    }
  };

  // ─── Page type summary helper ───
  const renderSummary = (result: ClassifyPagesResponse) => {
    const { summary } = result;
    return (
      <div className="grid grid-cols-2 gap-2 mt-4">
        <div className="bg-white/[0.04] border border-white/[0.06] rounded-xl p-3 text-center">
          <div className="text-lg font-bold text-[#0a84ff]">
            {summary.total_pages}
          </div>
          <div className="text-[9px] text-[#6e6e73] uppercase">
            Total Pages
          </div>
        </div>
        <div className="bg-white/[0.04] border border-white/[0.06] rounded-xl p-3 text-center">
          <div className="text-lg font-bold text-[#30d158]">
            {summary.door_schedule_pages.length}
          </div>
          <div className="text-[9px] text-[#6e6e73] uppercase">
            Door Schedule
          </div>
        </div>
        <div className="bg-white/[0.04] border border-white/[0.06] rounded-xl p-3 text-center">
          <div className="text-lg font-bold text-[#ff9500]">
            {summary.hardware_set_pages.length}
          </div>
          <div className="text-[9px] text-[#6e6e73] uppercase">
            Hardware Sets
          </div>
        </div>
        <div className="bg-white/[0.04] border border-white/[0.06] rounded-xl p-3 text-center">
          <div className="text-lg font-bold text-[#6e6e73]">
            {summary.other_pages.length}
          </div>
          <div className="text-[9px] text-[#6e6e73] uppercase">Other</div>
        </div>
      </div>
    );
  };

  return (
    <div className="max-w-lg mx-auto">
      <h3 className="text-[#f5f5f7] font-semibold mb-2">
        Step 1: Upload PDF
      </h3>
      <p className="text-[#a1a1a6] text-sm mb-4">
        Select a door hardware submittal PDF. We&apos;ll classify each page to
        find door schedules and hardware sets.
      </p>

      {/* Drag & drop zone */}
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
        className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors ${
          dragOver
            ? "border-[#0a84ff] bg-[rgba(10,132,255,0.05)]"
            : file
            ? "border-[#30d158]/30 bg-[rgba(48,209,88,0.03)]"
            : "border-white/[0.12] hover:border-white/[0.2] bg-white/[0.02]"
        }`}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf"
          onChange={handleFileChange}
          className="hidden"
          disabled={loading}
        />

        {file ? (
          <div>
            <div className="text-[#30d158] text-2xl mb-2">&#x2713;</div>
            <p className="text-[#f5f5f7] font-medium">{file.name}</p>
            <p className="text-[#6e6e73] text-xs mt-1">
              {(file.size / 1024 / 1024).toFixed(1)} MB
            </p>
          </div>
        ) : (
          <div>
            <div className="text-[#6e6e73] text-3xl mb-2">&#x1F4C4;</div>
            <p className="text-[#a1a1a6]">
              Drag &amp; drop a PDF here, or click to browse
            </p>
            <p className="text-[#6e6e73] text-xs mt-1">
              Max 50 MB
            </p>
          </div>
        )}
      </div>

      {/* Classification result summary */}
      {classifyResult && renderSummary(classifyResult)}

      {/* Progress */}
      {loading && (
        <div className="mt-4">
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

      {/* Next button */}
      <div className="flex justify-end mt-6">
        <button
          onClick={handleClassify}
          disabled={!file || loading}
          className="px-6 py-2 bg-[#0a84ff] hover:bg-[#0975de] text-white rounded-lg transition-colors font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading ? "Processing..." : "Next"}
        </button>
      </div>
    </div>
  );
}
