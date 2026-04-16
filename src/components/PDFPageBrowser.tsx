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
        // Clone the buffer — pdfjs-dist transfers it to its Web Worker,
        // which detaches the original and breaks extraction later
        const bufferCopy = pdfBuffer.slice(0);
        const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(bufferCopy) });
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
    return () => {
      cancelled = true;
      if (pdfDocRef.current) {
        pdfDocRef.current.destroy();
        pdfDocRef.current = null;
      }
    };
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
        <h2 className="font-display text-2xl font-bold text-primary mb-2">
          SELECT YOUR DOOR SCHEDULE
        </h2>
        <p className="text-sm text-secondary leading-relaxed">
          Find the page(s) with your opening list — the master table that lists every
          door in the project. We&apos;ll use it to extract:
        </p>
        <div className="flex flex-wrap gap-2 mt-3">
          {[
            { label: "Door Number", color: "var(--blue)", required: true },
            { label: "Hardware Heading", color: "var(--green)" },
            { label: "Hardware Subheading", color: "var(--purple)" },
            { label: "Location", color: "var(--orange)" },
            { label: "Door Type", color: "var(--blue)" },
            { label: "Frame Type", color: "var(--red)" },
            { label: "Fire Rating", color: "var(--red)" },
            { label: "Hand / Swing", color: "var(--yellow)" },
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
              {required && <span className="text-danger">*</span>}
            </span>
          ))}
        </div>
        <p className="text-[11px] text-tertiary mt-2">
          <span className="text-danger">*</span> Required — others are optional but improve tracking
        </p>
        <div className="flex items-center gap-3 mt-3">
          <p className="text-xs text-tertiary">
            {pageCount} pages total
          </p>
          {selectedPages.size > 0 && (
            <p className="text-xs text-info font-medium">
              {selectedPages.size} page{selectedPages.size > 1 ? "s" : ""} selected
            </p>
          )}
        </div>
        {selectedPages.size > 1 && (
          <div className="mt-2 p-2.5 rounded-lg bg-accent-dim border border-accent-dim">
            <p className="text-xs text-info">
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
                  ? "2px solid var(--blue)"
                  : "2px solid var(--tint-strong)",
                boxShadow: isSelected ? "0 0 16px var(--blue-dim)" : "none",
                opacity: loading ? 0.6 : 1,
                aspectRatio: "8.5/11",
                backgroundColor: "var(--background)",
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
                  <div className="w-5 h-5 border-2 border-info border-t-transparent rounded-full animate-spin" />
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
                <div className="absolute top-2 right-2 w-6 h-6 rounded-full bg-info flex items-center justify-center">
                  <span className="text-black text-xs font-bold">&#10003;</span>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Loading indicator for re-detection */}
      {loading && (
        <div className="p-3 rounded-lg bg-accent-dim border border-accent-dim">
          <p className="text-sm text-info flex items-center gap-2">
            <span className="w-4 h-4 border-2 border-info border-t-transparent rounded-full animate-spin" />
            Scanning selected pages for a door schedule...
          </p>
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center justify-between pt-4 border-t border-border-dim">
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
