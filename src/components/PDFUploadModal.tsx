"use client";

import { useState, useRef, ChangeEvent, FormEvent } from "react";
import { PDFDocument } from "pdf-lib";

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

/** Page threshold: PDFs with this many pages or fewer use the original single-request flow. */
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

    if (!response.ok && !response.body) {
      throw new Error(`Upload failed (${response.status})`);
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
  // ==========================================
  const processLargePDF = async (buffer: ArrayBuffer, pageCount: number) => {
    setStatus(`Splitting ${pageCount}-page PDF into chunks...`);
    setProgress(3);

    const chunks = await splitPDF(buffer, PAGES_PER_CHUNK);
    const totalChunks = chunks.length;

    setStatus(`Split into ${totalChunks} chunks. Starting analysis...`);
    setProgress(5);

    // Process each chunk sequentially, collecting results
    const allHardwareSets: HardwareSet[] = [];
    const allDoors: DoorEntry[] = [];
    const knownSetIds: string[] = [];

    for (let i = 0; i < totalChunks; i++) {
      const chunkPct = Math.round(5 + (i / totalChunks) * 75); // 5% to 80%
      setStatus(`Processing chunk ${i + 1} of ${totalChunks}...`);
      setProgress(chunkPct);

      const resp = await fetch("/api/parse-pdf/chunk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chunkBase64: chunks[i],
          chunkIndex: i,
          totalChunks,
          knownSetIds,
        }),
      });

      if (!resp.ok) {
        const errBody = await resp.json().catch(() => ({}));
        throw new Error(errBody.error || `Chunk ${i + 1} failed (${resp.status})`);
      }

      const result: ChunkResult = await resp.json();

      // Accumulate results
      allHardwareSets.push(...result.hardwareSets);
      allDoors.push(...result.doors);

      // Track discovered set IDs for subsequent chunks
      for (const set of result.hardwareSets) {
        if (!knownSetIds.includes(set.set_id)) {
          knownSetIds.push(set.set_id);
        }
      }

      const setsSoFar = new Set(allHardwareSets.map((s) => s.set_id)).size;
      setStatus(
        `Chunk ${i + 1}/${totalChunks} done. ${setsSoFar} sets, ${allDoors.length} doors so far.`
      );
    }

    // Merge & deduplicate
    setStatus("Merging results across chunks...");
    setProgress(82);

    const mergedSets = mergeHardwareSets(allHardwareSets);
    const mergedDoors = mergeDoors(allDoors);

    setStatus(`Merged: ${mergedSets.length} hardware sets, ${mergedDoors.length} unique doors. Saving...`);
    setProgress(85);

    if (mergedDoors.length === 0) {
      throw new Error("No doors found across all chunks. The PDF may not contain a door schedule.");
    }

    // Save to database
    const saveResp = await fetch("/api/parse-pdf/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId,
        hardwareSets: mergedSets,
        doors: mergedDoors,
      }),
    });

    if (!saveResp.ok) {
      const errBody = await saveResp.json().catch(() => ({}));
      throw new Error(errBody.error || `Save failed (${saveResp.status})`);
    }

    const saveResult = await saveResp.json();
    if (!saveResult.success) {
      throw new Error("Save completed but no success response received");
    }

    const warnings: string[] = [];
    if (saveResult.unmatchedSets?.length) {
      warnings.push(`${saveResult.unmatchedSets.length} set(s) not found: ${saveResult.unmatchedSets.join(", ")}`);
    }

    const summary = warnings.length > 0
      ? `Done! ${saveResult.openingsCount} doors, ${saveResult.itemsCount} items. ⚠ ${warnings.join("; ")}`
      : `Done! ${saveResult.openingsCount} doors, ${saveResult.itemsCount} hardware items loaded.`;

    setStatus(summary);
    setProgress(100);
  };

  // ==========================================
  // Submit handler: routes to small or large flow
  // ==========================================
  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!file) {
      setError("Please select a file");
      return;
    }

    setLoading(true);
    setError(null);
    setProgress(0);
    setStatus("Reading PDF...");

    try {
      const buffer = await file.arrayBuffer();

      // Check page count to decide flow
      let pageCount = 0;
      try {
        const pdfDoc = await PDFDocument.load(buffer);
        pageCount = pdfDoc.getPageCount();
      } catch {
        // If we can't count pages, fall back to small flow
        pageCount = 0;
      }

      if (pageCount > CHUNK_THRESHOLD) {
        // Large PDF: client-side chunking
        setStatus(`${pageCount}-page PDF detected. Using chunked processing...`);
        setProgress(2);
        await processLargePDF(buffer, pageCount);
      } else {
        // Small PDF: original single-request flow
        const formData = new FormData();
        formData.append("file", file);
        formData.append("projectId", projectId);
        await processSmallPDF(formData);
      }

      // Brief pause so user sees 100% before closing
      await new Promise((resolve) => setTimeout(resolve, 1500));
      onSuccess();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
      setProgress(0);
      setStatus("");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-slate-900 rounded-lg border border-slate-800 p-6 max-w-md w-full">
        <h2 className="text-xl font-bold text-white mb-4">Upload PDF</h2>

        {error && (
          <div className="mb-4 p-3 bg-red-900/20 border border-red-900 rounded text-red-200 text-sm">
            {error}
          </div>
        )}

        {loading && (
          <div className="mb-4">
            <div className="flex justify-between text-sm mb-1">
              <span className="text-slate-300">{status}</span>
              <span className="text-slate-400">{progress}%</span>
            </div>
            <div className="w-full bg-slate-800 rounded-full h-3 overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-500 ease-out"
                style={{
                  width: `${progress}%`,
                  backgroundColor: progress === 100 ? "#22c55e" : "#3b82f6",
                }}
              />
            </div>
          </div>
        )}

        <form onSubmit={handleSubmit}>
          <div className="mb-4">
            <label className="block text-sm font-medium text-slate-200 mb-2">
              PDF File
            </label>
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf"
              onChange={handleFileChange}
              disabled={loading}
              className="w-full px-4 py-2 bg-slate-800 border border-slate-700 rounded text-white cursor-pointer file:mr-4 file:py-2 file:px-4 file:rounded file:border-0 file:text-sm file:font-semibold file:bg-blue-600 file:text-white hover:file:bg-blue-700 disabled:opacity-50"
            />
            {file && !loading && (
              <p className="mt-2 text-sm text-slate-400">{file.name}</p>
            )}
          </div>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={loading}
              className="flex-1 px-4 py-2 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-white rounded transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || !file}
              className="flex-1 px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-700 text-white rounded transition-colors"
            >
              {loading ? "Processing..." : "Upload"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
