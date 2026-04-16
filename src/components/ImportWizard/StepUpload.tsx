"use client";

import { useState, useRef, useCallback, type ChangeEvent, type DragEvent } from "react";
import type { ClassifyPagesResponse } from "./types";
import { transformClassifyResponse } from "./transforms";
import { arrayBufferToBase64 } from "@/lib/pdf-utils";
import WizardNav from "./WizardNav";

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB

interface StepUploadProps {
  projectId: string;
  onComplete: (
    file: File,
    classifyResult: ClassifyPagesResponse,
    hasExistingData: boolean,
    pdfStoragePath: string | null,
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
      const pdfBase64 = arrayBufferToBase64(arrayBuffer);

      setProgress(30);
      setStatus("Classifying pages...");

      // Proxy route: enforces Supabase auth before forwarding to the
      // public Python endpoint with the internal shared secret.
      const resp = await fetch("/api/parse-pdf/classify-pages", {
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

      const raw = (await resp.json()) as Record<string, unknown>;
      const result = transformClassifyResponse(raw);
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

      // Upload PDF to Supabase Storage for server-side access
      setProgress(90);
      setStatus("Saving PDF...");
      let storagePath: string | null = null;
      try {
        const uploadForm = new FormData();
        uploadForm.append("file", file);
        uploadForm.append("pageCount", String(result.summary.total_pages));
        const uploadResp = await fetch(`/api/projects/${projectId}/pdf`, {
          method: "POST",
          body: uploadForm,
        });
        if (uploadResp.ok) {
          const uploadData = await uploadResp.json();
          storagePath = uploadData.storagePath ?? null;
        } else {
          console.warn("PDF storage upload failed:", uploadResp.status);
          setStatus("PDF saved locally (cloud backup unavailable).");
        }
      } catch (uploadErr) {
        console.warn("PDF storage upload failed:", uploadErr);
        setStatus("PDF saved locally (cloud backup unavailable).");
      }

      setProgress(100);
      setStatus("Ready to proceed.");
      setLoading(false);

      onComplete(file, result, hasExisting, storagePath);
    } catch (err) {
      // Reset state so user can retry the upload from a clean slate
      setLoading(false);
      setProgress(0);
      setStatus("");
      setClassifyResult(null);
      onError(err instanceof Error ? err.message : "Classification failed. Please try again.");
    }
  };

  return (
    <div className="max-w-2xl mx-auto">
      <h3
        className="text-[11px] font-semibold uppercase text-secondary tracking-wider"
        style={{ fontFamily: "var(--font-display)" }}
      >
        Upload PDF
      </h3>
      <p className="text-sm text-tertiary mt-1 mb-4">
        Select a door hardware submittal PDF. We&apos;ll classify each page to
        find door schedules and hardware sets.
      </p>

      {/* Drag & drop zone */}
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
        className={`border-2 border-dashed rounded-md p-8 text-center cursor-pointer transition-colors ${
          dragOver
            ? "border-accent bg-accent-dim"
            : file
            ? "border-success/30 bg-success-dim"
            : "border-border-dim hover:border-th-border-hover bg-tint"
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
            <div className="text-success text-2xl mb-2">&#x2713;</div>
            <p className="text-primary font-medium">{file.name}</p>
            <p className="text-tertiary text-xs mt-1">
              {(file.size / 1024 / 1024).toFixed(1)} MB
            </p>
          </div>
        ) : (
          <div>
            <div className="text-tertiary text-3xl mb-2">&#x1F4C4;</div>
            <p className="text-secondary">
              Drag &amp; drop a PDF here, or click to browse
            </p>
            <p className="text-tertiary text-xs mt-1">
              Max 50 MB
            </p>
          </div>
        )}
      </div>

      {/* Classification summary moved to StepScanResults — no flash screen here */}

      {/* Progress */}
      {loading && (
        <div className="mt-4">
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

      {/* Navigation */}
      <WizardNav
        onNext={handleClassify}
        nextLabel={loading ? "Processing..." : "Next"}
        nextDisabled={!file || loading}
      />
    </div>
  );
}
