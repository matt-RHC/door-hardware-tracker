"use client";

import { useState, useRef, useEffect, ChangeEvent, FormEvent } from "react";
import { PDFDocument } from "pdf-lib";
import SubmittalWizard from "./SubmittalWizard";
import ImportReviewTable from "./ImportReviewTable";

/* âââ Holographic Loading Overlay âââ */
function HoloLoader({ progress, status }: { progress: number; status: string }) {
  const [tick, setTick] = useState(0);
  const [glitch, setGlitch] = useState(false);

  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), 100);
    return () => clearInterval(interval);
  }, []);

  // Random glitch effect
  useEffect(() => {
    const glitchInterval = setInterval(() => {
      if (Math.random() < 0.15) {
        setGlitch(true);
        setTimeout(() => setGlitch(false), 80 + Math.random() * 120);
      }
    }, 400);
    return () => clearInterval(glitchInterval);
  }, []);

  const dots = ".".repeat((tick % 4));
  const scanY = (tick * 3) % 260;
  const hexChars = "0123456789ABCDEF";
  const randHex = () => Array.from({ length: 4 }, () => hexChars[Math.floor(Math.random() * 16)]).join("");

  return (
    <div className="holo-container">
      <style>{`
        .holo-container {
          position: absolute;
          bottom: 100%;
          left: 50%;
          transform: translateX(-50%);
          width: 320px;
          height: 280px;
          margin-bottom: 16px;
          pointer-events: none;
          z-index: 60;
        }
        @keyframes holoFloat {
          0%, 100% { transform: translateY(0px); }
          50% { transform: translateY(-8px); }
        }
        @keyframes holoFlicker {
          0%, 100% { opacity: 0.85; }
          3% { opacity: 0.4; }
          6% { opacity: 0.9; }
          50% { opacity: 0.75; }
          53% { opacity: 0.95; }
        }
        @keyframes glitchShift {
          0% { transform: translate(0, 0) skewX(0deg); }
          20% { transform: translate(-3px, 1px) skewX(-2deg); }
          40% { transform: translate(2px, -1px) skewX(1deg); }
          60% { transform: translate(-1px, 2px) skewX(-1deg); }
          80% { transform: translate(3px, 0px) skewX(2deg); }
          100% { transform: translate(0, 0) skewX(0deg); }
        }
        @keyframes borderPulse {
          0%, 100% { border-color: rgba(0, 230, 255, 0.3); box-shadow: 0 0 15px rgba(0, 230, 255, 0.1), inset 0 0 15px rgba(0, 230, 255, 0.05); }
          50% { border-color: rgba(0, 230, 255, 0.6); box-shadow: 0 0 30px rgba(0, 230, 255, 0.2), inset 0 0 30px rgba(0, 230, 255, 0.1); }
        }
        @keyframes cornerBlink {
          0%, 49% { opacity: 1; }
          50%, 100% { opacity: 0.3; }
        }
        @keyframes ringRotate {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        @keyframes ringRotateReverse {
          from { transform: rotate(360deg); }
          to { transform: rotate(0deg); }
        }
        @keyframes progressGlow {
          0%, 100% { filter: drop-shadow(0 0 4px rgba(0, 230, 255, 0.5)); }
          50% { filter: drop-shadow(0 0 12px rgba(0, 230, 255, 0.9)); }
        }
        @keyframes textFlash {
          0%, 90%, 100% { opacity: 1; }
          95% { opacity: 0; }
        }
        @keyframes dataScroll {
          0% { transform: translateY(0); }
          100% { transform: translateY(-50%); }
        }
        .holo-frame {
          position: relative;
          width: 100%;
          height: 100%;
          border: 1.5px solid rgba(0, 230, 255, 0.4);
          border-radius: 4px;
          background: radial-gradient(ellipse at center, rgba(0, 230, 255, 0.06) 0%, rgba(0, 20, 40, 0.85) 70%);
          overflow: hidden;
          animation: holoFloat 3s ease-in-out infinite, borderPulse 2s ease-in-out infinite;
        }
        .holo-scanlines {
          position: absolute;
          inset: 0;
          background: repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0, 230, 255, 0.03) 2px, rgba(0, 230, 255, 0.03) 4px);
          pointer-events: none;
        }
        .holo-scan-beam {
          position: absolute;
          left: 0;
          width: 100%;
          height: 3px;
          background: linear-gradient(90deg, transparent, rgba(0, 230, 255, 0.4), transparent);
          filter: blur(1px);
          pointer-events: none;
        }
        .holo-corner {
          position: absolute;
          width: 12px;
          height: 12px;
          border-color: rgba(0, 230, 255, 0.7);
          animation: cornerBlink 1.5s ease-in-out infinite;
        }
        .holo-corner-tl { top: 4px; left: 4px; border-top: 2px solid; border-left: 2px solid; }
        .holo-corner-tr { top: 4px; right: 4px; border-top: 2px solid; border-right: 2px solid; animation-delay: 0.3s; }
        .holo-corner-bl { bottom: 4px; left: 4px; border-bottom: 2px solid; border-left: 2px solid; animation-delay: 0.6s; }
        .holo-corner-br { bottom: 4px; right: 4px; border-bottom: 2px solid; border-right: 2px solid; animation-delay: 0.9s; }
        .holo-text {
          font-family: 'Courier New', monospace;
          color: rgba(0, 230, 255, 0.9);
          text-shadow: 0 0 8px rgba(0, 230, 255, 0.5);
          letter-spacing: 0.05em;
        }
        .holo-data-col {
          position: absolute;
          right: 12px;
          top: 30px;
          bottom: 60px;
          width: 55px;
          overflow: hidden;
          opacity: 0.3;
        }
        .holo-data-col .data-stream {
          font-family: 'Courier New', monospace;
          font-size: 8px;
          color: rgba(0, 230, 255, 0.6);
          line-height: 1.3;
          animation: dataScroll 8s linear infinite;
        }
      `}</style>

      <div className={`holo-frame ${glitch ? "glitch-active" : ""}`}
        style={glitch ? { animation: "holoFloat 3s ease-in-out infinite, glitchShift 0.1s ease-in-out" } : undefined}
      >
        <div className="holo-scanlines" />
        <div className="holo-scan-beam" style={{ top: `${scanY}px` }} />

        <div className="holo-corner holo-corner-tl" />
        <div className="holo-corner holo-corner-tr" />
        <div className="holo-corner holo-corner-bl" />
        <div className="holo-corner holo-corner-br" />

        {/* Header */}
        <div className="absolute top-3 left-0 w-full text-center">
          <p className="holo-text text-[10px] uppercase tracking-[0.3em] opacity-60"
            style={{ animation: "textFlash 3s ease-in-out infinite" }}>
            // RABBIT HOLE SYSTEMS //
          </p>
        </div>

        {/* Center: Rotating rings + door icon */}
        <div className="absolute inset-0 flex items-center justify-center" style={{ marginTop: "-10px" }}>
          <svg width="140" height="140" viewBox="0 0 140 140" className="absolute"
            style={{ animation: "ringRotate 8s linear infinite, progressGlow 2s ease-in-out infinite" }}>
            <circle cx="70" cy="70" r="65" fill="none" stroke="rgba(0, 230, 255, 0.2)"
              strokeWidth="1" strokeDasharray="8 4" />
            <circle cx="70" cy="70" r="58" fill="none" stroke="rgba(0, 230, 255, 0.6)"
              strokeWidth="2.5" strokeLinecap="round"
              strokeDasharray={`${(progress / 100) * 364} 364`}
              transform="rotate(-90 70 70)"
              style={{ transition: "stroke-dasharray 0.5s ease-out" }} />
          </svg>

          <svg width="120" height="120" viewBox="0 0 120 120" className="absolute"
            style={{ animation: "ringRotateReverse 12s linear infinite" }}>
            <circle cx="60" cy="60" r="48" fill="none" stroke="rgba(0, 230, 255, 0.15)"
              strokeWidth="0.5" strokeDasharray="2 6" />
            {Array.from({ length: 12 }).map((_, i) => {
              const angle = (i * 30) * Math.PI / 180;
              const x1 = 60 + 42 * Math.cos(angle);
              const y1 = 60 + 42 * Math.sin(angle);
              const x2 = 60 + 46 * Math.cos(angle);
              const y2 = 60 + 46 * Math.sin(angle);
              return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2}
                stroke="rgba(0, 230, 255, 0.3)" strokeWidth="1" />;
            })}
          </svg>

          {/* Door icon */}
          <svg width="44" height="56" viewBox="0 0 44 56" fill="none" className="relative z-10"
            style={{ filter: "drop-shadow(0 0 6px rgba(0, 230, 255, 0.4))" }}>
            <rect x="4" y="2" width="36" height="52" rx="1" stroke="rgba(0, 230, 255, 0.7)"
              strokeWidth="1.5" fill="rgba(0, 230, 255, 0.05)" />
            <rect x="10" y="6" width="24" height="44" rx="1" stroke="rgba(0, 230, 255, 0.5)"
              strokeWidth="1" fill="rgba(0, 230, 255, 0.03)" />
            <circle cx="30" cy="30" r="2" fill="rgba(0, 230, 255, 0.8)" />
            <line x1="11" y1="14" x2="11" y2="18" stroke="rgba(0, 230, 255, 0.4)" strokeWidth="1.5" />
            <line x1="11" y1="36" x2="11" y2="40" stroke="rgba(0, 230, 255, 0.4)" strokeWidth="1.5" />
          </svg>
        </div>

        {/* Scrolling data column */}
        <div className="holo-data-col">
          <div className="data-stream">
            {Array.from({ length: 40 }).map((_, i) => (
              <div key={i}>{randHex()}</div>
            ))}
          </div>
        </div>

        {/* Status text */}
        <div className="absolute bottom-12 left-0 w-full text-center px-4">
          <p className="holo-text text-xs font-bold tracking-wider">
            {status}{dots}
          </p>
        </div>

        {/* Bottom bar */}
        <div className="absolute bottom-3 left-3 right-3">
          <div className="flex justify-between items-center mb-1">
            <span className="holo-text text-[9px] opacity-50">PROGRESS</span>
            <span className="holo-text text-[9px]"
              style={{ animation: "textFlash 2s ease-in-out infinite" }}>
              {progress.toFixed(0)}% [{">".repeat(Math.floor(progress / 10))}{"Â·".repeat(10 - Math.floor(progress / 10))}]
            </span>
          </div>
          <div className="w-full h-[3px] rounded-full overflow-hidden" style={{ background: "rgba(0, 230, 255, 0.1)" }}>
            <div className="h-full rounded-full transition-all duration-500"
              style={{
                width: `${progress}%`,
                background: "linear-gradient(90deg, rgba(0, 230, 255, 0.3), rgba(0, 230, 255, 0.9))",
                boxShadow: "0 0 8px rgba(0, 230, 255, 0.5)",
              }} />
          </div>
        </div>
      </div>
    </div>
  );
}

// --- Types ---

interface HardwareItem {
  qty: number;
  name: string;
  model: string;
  finish: string;
  manufacturer: string;
}

interface HardwareSet {
  set_id: string;
  heading: string;
  items: HardwareItem[];
}

interface DoorEntry {
  door_number: string;
  hw_set: string;
  location: string;
  door_type: string;
  frame_type: string;
  fire_rating: string;
  hand: string;
}

interface ChunkResult {
  chunkIndex: number;
  hardwareSets: HardwareSet[];
  doors: DoorEntry[];
}

// --- Constants ---

/** Max pages per chunk. ~30-40 pages keeps each Claude call well under 200K tokens. */
const PAGES_PER_CHUNK = 35;

/**
 * Page threshold for FRESH uploads only. PDFs at or below this count use the
 * original single-request streaming flow (/api/parse-pdf). Re-uploads always
 * use chunked processing regardless of page count (see handleSubmit).
 */
const CHUNK_THRESHOLD = 45;

// --- Helpers ---

/** Split a PDF ArrayBuffer into chunks of N pages, returning base64 strings */
async function splitPDF(buffer: ArrayBuffer, pagesPerChunk: number): Promise<string[]> {
  const srcDoc = await PDFDocument.load(buffer);
  const totalPages = srcDoc.getPageCount();
  const chunks: string[] = [];

  for (let start = 0; start < totalPages; start += pagesPerChunk) {
    const end = Math.min(start + pagesPerChunk, totalPages);
    const chunkDoc = await PDFDocument.create();
    const pages = await chunkDoc.copyPages(srcDoc, Array.from({ length: end - start }, (_, i) => start + i));
    for (const page of pages) {
      chunkDoc.addPage(page);
    }
    const chunkBytes = await chunkDoc.save();
    const chunkBase64 = btoa(
      new Uint8Array(chunkBytes).reduce((data, byte) => data + String.fromCharCode(byte), "")
    );
    chunks.push(chunkBase64);
  }

  return chunks;
}

/** Deduplicate hardware sets by set_id (later chunks win for items, but we merge) */
function mergeHardwareSets(allSets: HardwareSet[]): HardwareSet[] {
  const map = new Map<string, HardwareSet>();
  for (const set of allSets) {
    const existing = map.get(set.set_id);
    if (!existing || set.items.length > existing.items.length) {
      // Keep the version with more items (more complete extraction)
      map.set(set.set_id, set);
    }
  }
  return Array.from(map.values());
}

/** Deduplicate doors by door_number (first occurrence wins) */
function mergeDoors(allDoors: DoorEntry[]): DoorEntry[] {
  const seen = new Set<string>();
  const unique: DoorEntry[] = [];
  for (const door of allDoors) {
    if (!seen.has(door.door_number)) {
      seen.add(door.door_number);
      unique.push(door);
    }
  }
  return unique;
}

// --- Component ---

interface PDFUploadModalProps {
  projectId: string;
  onClose: () => void;
  onSuccess: () => void;
}

export default function PDFUploadModal({
  projectId,
  onClose,
  onSuccess,
}: PDFUploadModalProps) {
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Wizard mode: when project has existing openings, parse-only then show wizard
  const [wizardData, setWizardData] = useState<{
    doors: DoorEntry[];
    sets: HardwareSet[];
  } | null>(null);

  // Review mode: fresh uploads show editable table before saving
  const [reviewData, setReviewData] = useState<{
    doors: DoorEntry[];
    sets: HardwareSet[];
  } | null>(null);

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (selectedFile) {
      if (selectedFile.type !== "application/pdf") {
        setError("Please select a PDF file");
        return;
      }
      setFile(selectedFile);
      setError(null);
    }
  };

  // ==========================================
  // SMALL PDF: Original single-request flow
  // ==========================================
  const processSmallPDF = async (formData: FormData) => {
    setStatus("Uploading to server...");
    setProgress(5);

    const response = await fetch("/api/parse-pdf", {
      method: "POST",
      body: formData,
    });

    if (!response.ok) {
      const errBody = await response.json().catch(() => null);
      throw new Error(errBody?.error || `Upload failed (${response.status})`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error("No response stream");

    const decoder = new TextDecoder();
    let buffer = "";
    let lastEvent: {
      progress: number;
      status: string;
      error?: string;
      result?: Record<string, unknown>;
    } | null = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          lastEvent = event;
          setProgress(event.progress);
          setStatus(event.status);
          if (event.error) setError(event.error);
        } catch {
          // skip malformed
        }
      }
    }

    if (buffer.trim()) {
      try {
        const event = JSON.parse(buffer);
        lastEvent = event;
        setProgress(event.progress);
        setStatus(event.status);
        if (event.error) setError(event.error);
      } catch {
        // skip
      }
    }

    if (lastEvent?.error) throw new Error(lastEvent.error);
    if (!lastEvent?.result?.success) {
      throw new Error("Upload completed but no success response received");
    }
  };

  // ==========================================
  // LARGE PDF: Chunked multi-request flow
  // Returns parsed data if parseOnly=true, otherwise saves to DB
  // ==========================================
  const processLargePDF = async (
    buffer: ArrayBuffer,
    pageCount: number,
    parseOnly = false
  ): Promise<{ doors: DoorEntry[]; sets: HardwareSet[] } | void> => {
    setStatus(`Splitting ${pageCount}-page PDF into chunks...`);
    setProgress(3);

    const chunks = await splitPDF(buffer, PAGES_PER_CHUNK);
    const totalChunks = chunks.length;

    setStatus(`Split into ${totalChunks} chunks. Starting analysis...`);
    setProgress(5);

    const allHardwareSets: HardwareSet[] = [];
    const allDoors: DoorEntry[] = [];
    const knownSetIds: string[] = [];

    for (let i = 0; i < totalChunks; i++) {
      const chunkStartPct = Math.round(5 + (i / totalChunks) * 75);
      const chunkEndPct = Math.round(5 + ((i + 1) / totalChunks) * 75);

      setStatus(`Processing chunk ${i + 1} of ${totalChunks}...`);
      setProgress(chunkStartPct);

      // Simulate smooth progress while waiting for the API call.
      // Ticks up gradually toward the chunk's end %, but never quite reaches it
      // so the snap to real progress on completion feels natural.
      const progressCeiling = chunkEndPct - 2; // leave room for snap
      let simPct = chunkStartPct;
      const simTimer = setInterval(() => {
        const remaining = progressCeiling - simPct;
        // Move ~8% of remaining distance each tick (decelerating curve)
        if (remaining > 1) {
          simPct = Math.round(simPct + Math.max(0.5, remaining * 0.08));
          setProgress(simPct);
        }
      }, 1500);

      // Phase labels to keep the status text informative during long waits
      const phaseTimer = setTimeout(() => {
        setStatus(`Chunk ${i + 1}/${totalChunks}: Extracting hardware sets...`);
      }, 15000);
      const phaseTimer2 = setTimeout(() => {
        setStatus(`Chunk ${i + 1}/${totalChunks}: Reading door schedule...`);
      }, 45000);
      const phaseTimer3 = setTimeout(() => {
        setStatus(`Chunk ${i + 1}/${totalChunks}: Validating extraction...`);
      }, 90000);

      try {
        const resp = await fetch("/api/parse-pdf/chunk", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chunkBase64: chunks[i], chunkIndex: i, totalChunks, knownSetIds }),
        });

        if (!resp.ok) {
          const errBody = await resp.json().catch(() => ({}));
          throw new Error(errBody.error || `Chunk ${i + 1} failed (${resp.status})`);
        }

        const result: ChunkResult = await resp.json();
        allHardwareSets.push(...result.hardwareSets);
        allDoors.push(...result.doors);

        for (const set of result.hardwareSets) {
          if (!knownSetIds.includes(set.set_id)) knownSetIds.push(set.set_id);
        }
      } finally {
        clearInterval(simTimer);
        clearTimeout(phaseTimer);
        clearTimeout(phaseTimer2);
        clearTimeout(phaseTimer3);
      }

      // Snap to real completion % for this chunk
      setProgress(chunkEndPct);
      const setsSoFar = new Set(allHardwareSets.map((s) => s.set_id)).size;
      setStatus(`Chunk ${i + 1}/${totalChunks} done. ${setsSoFar} sets, ${allDoors.length} doors so far.`);
    }

    setStatus("Merging results across chunks...");
    setProgress(82);

    const mergedSets = mergeHardwareSets(allHardwareSets);
    const mergedDoors = mergeDoors(allDoors);

    if (mergedDoors.length === 0) {
      throw new Error("No doors found across all chunks. The PDF may not contain a door schedule.");
    }

    // Parse-only mode: return data for wizard
    if (parseOnly) {
      setProgress(100);
      setStatus(`Parsed ${mergedSets.length} hardware sets, ${mergedDoors.length} doors. Ready for review.`);
      return { doors: mergedDoors, sets: mergedSets };
    }

    // Save mode: write to DB
    setStatus(`Merged: ${mergedSets.length} hardware sets, ${mergedDoors.length} unique doors. Saving...`);
    setProgress(85);

    const saveResp = await fetch("/api/parse-pdf/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, hardwareSets: mergedSets, doors: mergedDoors }),
    });

    if (!saveResp.ok) {
      const errBody = await saveResp.json().catch(() => ({}));
      throw new Error(errBody.error || `Save failed (${saveResp.status})`);
    }

    const saveResult = await saveResp.json();
    if (!saveResult.success) throw new Error("Save completed but no success response received");

    const warnings: string[] = [];
    if (saveResult.unmatchedSets?.length) {
      warnings.push(`${saveResult.unmatchedSets.length} set(s) not found: ${saveResult.unmatchedSets.join(", ")}`);
    }

    setStatus(
      warnings.length > 0
        ? `Done! ${saveResult.openingsCount} doors, ${saveResult.itemsCount} items. â  ${warnings.join("; ")}`
        : `Done! ${saveResult.openingsCount} doors, ${saveResult.itemsCount} hardware items loaded.`
    );
    setProgress(100);
  };

  // ==========================================
  // Check if project already has openings (for wizard mode)
  // ==========================================
  const checkExistingOpenings = async (): Promise<boolean> => {
    try {
      const resp = await fetch(`/api/projects/${projectId}/openings`);
      if (!resp.ok) return false;
      const data = await resp.json();
      return Array.isArray(data) && data.length > 0;
    } catch {
      return false;
    }
  };

  // ==========================================
  // Submit handler: routes to appropriate flow
  // ==========================================
  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!file) {
      setError("Please select a file");
      return;
    }

    setLoading(true);
    setError(null);
    setProgress(1);
    setStatus("Reading PDF...");

    try {
      const buffer = await file.arrayBuffer();
      setProgress(2);

      // Check page count
      let pageCount = 0;
      try {
        const pdfDoc = await PDFDocument.load(buffer);
        pageCount = pdfDoc.getPageCount();
      } catch {
        pageCount = 0;
      }
      setProgress(3);

      // Check if project has existing openings
      setStatus("Checking existing data...");
      const hasExisting = await checkExistingOpenings();
      setProgress(4);

      if (hasExisting) {
        // âââ WIZARD MODE: parse only (chunked), then show wizard âââ
        // Always use chunked processing for re-uploads â even "small" PDFs
        // can be 40+ pages which is too large for a single Claude API call.
        setStatus(`Parsing ${pageCount > 0 ? `${pageCount}-page ` : ""}PDF for comparison...`);
        setProgress(2);
        const result = await processLargePDF(buffer, pageCount || 50, true);
        if (result) {
          if (result.doors.length === 0) {
            throw new Error("No doors found in the document.");
          }
          setWizardData({ doors: result.doors, sets: result.sets });
        }
        // Don't close â wizard will render
        setLoading(false);
        return;
      }

      // --- FRESH UPLOAD: parse only, then show review table ---
      setStatus(`Parsing ${pageCount > 0 ? `${pageCount}-page ` : ""}PDF...`);
      setProgress(2);
      const freshResult = await processLargePDF(buffer, pageCount || 50, true);
      if (freshResult) {
        if (freshResult.doors.length === 0) {
          throw new Error("No doors found in the document.");
        }
        setReviewData({ doors: freshResult.doors, sets: freshResult.sets });
      }
      // Don't close - review table will render
      setLoading(false);
      return;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
      setProgress(0);
      setStatus("");
    } finally {
      setLoading(false);
    }
  };

  // If review data is ready (fresh upload), show the editable review table
  if (reviewData) {
    return (
      <ImportReviewTable
        projectId={projectId}
        doors={reviewData.doors}
        sets={reviewData.sets}
        onClose={onClose}
        onComplete={onSuccess}
      />
    );
  }

    // If wizard data is ready, show the wizard instead of the upload modal
  if (wizardData) {
    return (
      <SubmittalWizard
        projectId={projectId}
        parsedDoors={wizardData.doors}
        parsedSets={wizardData.sets}
        onClose={onClose}
        onComplete={onSuccess}
      />
    );
  }

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-lg flex items-center justify-center z-50 p-4">
      <div className="bg-[#1c1c1e] rounded-2xl border border-white/[0.08] p-6 max-w-md w-full relative">
        {/* Holographic loading overlay */}
        {loading && <HoloLoader progress={progress} status={status} />}

        <h2 className="text-xl font-semibold text-[#f5f5f7] mb-4">Upload PDF</h2>

        {error && (
          <div className="mb-4 p-3 bg-[rgba(255,69,58,0.1)] border border-[rgba(255,69,58,0.2)] rounded-xl text-[#ff6961] text-sm">
            {error}
          </div>
        )}

        {loading && (
          <div className="mb-4">
            <div className="flex justify-between text-sm mb-1">
              <span className="text-[#a1a1a6]">{status}</span>
              <span className="text-[#6e6e73]">{progress}%</span>
            </div>
            <div className="w-full bg-white/[0.06] rounded-full h-3 overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-500 ease-out"
                style={{
                  width: `${progress}%`,
                  backgroundColor: progress === 100 ? "#30d158" : "#0a84ff",
                }}
              />
            </div>
          </div>
        )}

        <form onSubmit={handleSubmit}>
          <div className="mb-4">
            <label className="block text-sm font-medium text-[#a1a1a6] mb-2">
              PDF File
            </label>
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf"
              onChange={handleFileChange}
              disabled={loading}
              className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl text-[#a1a1a6] cursor-pointer file:bg-[#0a84ff] file:text-white file:border-0 file:rounded-lg file:px-4 file:py-2 file:font-semibold disabled:opacity-50"
            />
            {file && !loading && (
              <p className="mt-2 text-sm text-[#6e6e73]">{file.name}</p>
            )}
          </div>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={loading}
              className="flex-1 px-4 py-2 bg-white/[0.04] border border-white/[0.08] text-[#a1a1a6] rounded-lg hover:bg-white/[0.07] disabled:opacity-50 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || !file}
              className="flex-1 px-4 py-2 bg-[#0a84ff] text-white rounded-lg hover:opacity-90 disabled:bg-white/[0.06] disabled:text-[#6e6e73] transition-colors"
            >
              {loading ? "Processing..." : "Upload"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
