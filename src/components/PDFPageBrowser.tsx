"use client";

import { useState, useEffect, useRef, useCallback } from "react";

interface PDFPageBrowserProps {
  pdfBuffer: ArrayBuffer;
  pageCount: number;
  onSelectPages: (pageIndices: number[]) => void;
  onCancel: () => void;
  loading?: boolean;
}

export default function PDFPageBrowser({
  pdfBuffer,
  pageCount,
  onSelectPages,
  onCancel,
  loading = false,
}: PDFPageBrowserProps) {
  const [thumbnails, setThumbnails] = useState<Map<number, string>>(new Map());
  const [selectedPages, setSelectedPages] = useState<Set<number>>(new Set());
  const [renderingPages, setRenderingPages] = useState<Set<number>>(new Set());
  const pdfDocRef = useRef<ReturnType<Awaited<typeof import("pdfjs-dist")>["getDocument"]> extends { promise: Promise<infer T> } ? T : never>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const thumbRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  // Load the PDF document once
  useEffect(() => {
    let cancelled = false;

    async function loadPdf() {
      try {
        const pdfjsLib = await import("pdfjs-dist");
        pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
        const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(pdfBuffer) });
        const doc = await loadingTask.promise;
        if (!cancelled) {
          pdfDocRef.current = doc;
          // Trigger initial render of visible pages via observer
          setupObserver();
        }
      } catch (err) {
        console.error("Failed to load PDF for thumbnails:", err);
      }
    }

    loadPdf();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdfBuffer]);

  // Render a single page thumbnail
  const renderThumbnail = useCallback(async (pageIndex: number) => {
    const pdf = pdfDocRef.current;
    if (!pdf) return;
    if (thumbnails.has(pageIndex) || renderingPages.has(pageIndex)) return;

    setRenderingPages((prev) => new Set(prev).add(pageIndex));

    try {
      const page = await pdf.getPage(pageIndex + 1); // pdfjs uses 1-based
      const baseViewport = page.getViewport({ scale: 1 });
      // Render at ~200px wide
      const thumbScale = 200 / baseViewport.width;
      const viewport = page.getViewport({ scale: thumbScale });

      const canvas = document.createElement("canvas");
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      await page.render({ canvasContext: ctx, canvas, viewport }).promise;
      const dataUrl = canvas.toDataURL("image/jpeg", 0.7);
      canvas.width = 0;
      canvas.height = 0;

      setThumbnails((prev) => new Map(prev).set(pageIndex, dataUrl));
    } catch (err) {
      console.error(`Thumbnail render error (page ${pageIndex + 1}):`, err);
    } finally {
      setRenderingPages((prev) => {
        const next = new Set(prev);
        next.delete(pageIndex);
        return next;
      });
    }
  }, [thumbnails, renderingPages]);

  // Setup IntersectionObserver for lazy loading
  const setupObserver = useCallback(() => {
    if (observerRef.current) observerRef.current.disconnect();

    observerRef.current = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const pageIdx = Number((entry.target as HTMLElement).dataset.pageIndex);
            if (!isNaN(pageIdx)) {
              renderThumbnail(pageIdx);
            }
          }
        }
      },
      { rootMargin: "200px", threshold: 0.01 }
    );

    // Observe all thumbnail placeholders
    for (const [, el] of thumbRefs.current) {
      observerRef.current.observe(el);
    }
  }, [renderThumbnail]);

  // Re-setup observer when refs change
  useEffect(() => {
    if (pdfDocRef.current) {
      setupObserver();
    }
    return () => { observerRef.current?.disconnect(); };
  }, [setupObserver, pageCount]);

  // Register a thumbnail ref
  const setThumbRef = useCallback((pageIndex: number, el: HTMLDivElement | null) => {
    if (el) {
      thumbRefs.current.set(pageIndex, el);
      observerRef.current?.observe(el);
    } else {
      thumbRefs.current.delete(pageIndex);
    }
  }, []);

  return (
    <div className="space-y-6 animate-fade-in-up">
      <div>
        <h2 className="font-display text-2xl font-bold text-white mb-2">
          SELECT YOUR DOOR SCHEDULE
        </h2>
        <p className="text-sm text-[#a1a1a6] leading-relaxed">
          Find the page(s) with your opening list — the master table that lists every
          door in the project. We&apos;ll use it to extract:
        </p>
        <div className="flex flex-wrap gap-2 mt-3">
          {[
            { label: "Door Number", color: "#0a84ff", required: true },
            { label: "Hardware Set", color: "#30d158" },
            { label: "Hardware Heading", color: "#bf5af2" },
            { label: "Location", color: "#ff9f0a" },
            { label: "Door Type", color: "#64d2ff" },
            { label: "Frame Type", color: "#ff6482" },
            { label: "Fire Rating", color: "#ff453a" },
            { label: "Hand / Swing", color: "#ffd60a" },
          ].map(({ label, color, required }) => (
            <span
              key={label}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium"
              style={{
                backgroundColor: `${color}15`,
                color,
                border: `1px solid ${color}30`,
              }}
            >
              {label}
              {required && <span className="text-[#ff453a]">*</span>}
            </span>
          ))}
        </div>
        <p className="text-[11px] text-[#636366] mt-2">
          <span className="text-[#ff453a]">*</span> Required — others are optional but improve tracking
        </p>
        <div className="flex items-center gap-3 mt-3">
          <p className="text-xs text-[#636366]">
            {pageCount} pages total
          </p>
          {selectedPages.size > 0 && (
            <p className="text-xs text-[#5ac8fa] font-medium">
              {selectedPages.size} page{selectedPages.size > 1 ? "s" : ""} selected
            </p>
          )}
        </div>
        {selectedPages.size > 1 && (
          <div className="mt-2 p-2.5 rounded-lg bg-[rgba(90,200,250,0.06)] border border-[rgba(90,200,250,0.15)]">
            <p className="text-xs text-[#5ac8fa]">
              We&apos;ll detect columns from your first selected page and read
              door data from all selected pages.
            </p>
          </div>
        )}
      </div>

      {/* Thumbnail grid */}
      <div
        className="grid gap-3 overflow-y-auto"
        style={{
          gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
          maxHeight: "480px",
        }}
      >
        {Array.from({ length: pageCount }).map((_, pageIdx) => {
          const thumb = thumbnails.get(pageIdx);
          const isSelected = selectedPages.has(pageIdx);

          return (
            <div
              key={pageIdx}
              ref={(el) => setThumbRef(pageIdx, el)}
              data-page-index={pageIdx}
              onClick={() => {
                if (loading) return;
                setSelectedPages((prev) => {
                  const next = new Set(prev);
                  if (next.has(pageIdx)) {
                    next.delete(pageIdx);
                  } else {
                    next.add(pageIdx);
                  }
                  return next;
                });
              }}
              className="relative cursor-pointer rounded-lg overflow-hidden transition-all"
              style={{
                border: isSelected
                  ? "2px solid #5ac8fa"
                  : "2px solid rgba(255,255,255,0.08)",
                boxShadow: isSelected ? "0 0 16px rgba(90,200,250,0.3)" : "none",
                opacity: loading ? 0.6 : 1,
                aspectRatio: "8.5/11",
                backgroundColor: "rgba(20,20,24,0.9)",
              }}
            >
              {thumb ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={thumb}
                  alt={`Page ${pageIdx + 1}`}
                  className="w-full h-full object-contain"
                  draggable={false}
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center">
                  <div className="w-5 h-5 border-2 border-[#5ac8fa] border-t-transparent rounded-full animate-spin" />
                </div>
              )}
              {/* Page number overlay */}
              <div
                className="absolute bottom-0 left-0 right-0 px-2 py-1 text-center"
                style={{
                  background: "linear-gradient(transparent, rgba(0,0,0,0.8))",
                }}
              >
                <span className="text-xs font-semibold text-white">
                  Page {pageIdx + 1}
                </span>
              </div>
              {/* Selected checkmark */}
              {isSelected && (
                <div className="absolute top-2 right-2 w-6 h-6 rounded-full bg-[#5ac8fa] flex items-center justify-center">
                  <span className="text-black text-xs font-bold">&#10003;</span>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Loading indicator for re-detection */}
      {loading && (
        <div className="p-3 rounded-lg bg-[rgba(90,200,250,0.08)] border border-[rgba(90,200,250,0.2)]">
          <p className="text-sm text-[#5ac8fa] flex items-center gap-2">
            <span className="w-4 h-4 border-2 border-[#5ac8fa] border-t-transparent rounded-full animate-spin" />
            Scanning selected pages for a door schedule...
          </p>
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center justify-between pt-4 border-t border-[rgba(255,255,255,0.06)]">
        <button onClick={onCancel} className="glow-btn glow-btn--ghost">
          Skip Column Mapping
        </button>
        <button
          onClick={() => selectedPages.size > 0 && onSelectPages(Array.from(selectedPages).sort((a, b) => a - b))}
          disabled={selectedPages.size === 0 || loading}
          className="glow-btn glow-btn--primary disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {selectedPages.size > 1
            ? `Use These ${selectedPages.size} Pages`
            : "Use This Page"}
        </button>
      </div>
    </div>
  );
}
