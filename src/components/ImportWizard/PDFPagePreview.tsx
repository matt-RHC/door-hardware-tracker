"use client";

import { useState, useEffect, useRef, useCallback } from "react";

interface PDFPagePreviewProps {
  /** PDF file as ArrayBuffer (from file.arrayBuffer() or fetched from storage). */
  pdfBuffer: ArrayBuffer;
  /** 0-based page index to render. */
  pageIndex: number;
  /** If true, starts collapsed with a "View PDF Page" toggle. */
  collapsible?: boolean;
  /** Max width in pixels. Defaults to container width. */
  maxWidth?: number;
  /** Optional label shown above the preview. */
  label?: string;
}

/**
 * Renders a single PDF page using pdfjs-dist.
 * Mobile-first: scales to fit container width.
 * Reuses the proven rendering pattern from PDFPageBrowser.
 */
export default function PDFPagePreview({
  pdfBuffer,
  pageIndex,
  collapsible = false,
  maxWidth,
  label,
}: PDFPagePreviewProps) {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(!collapsible);
  const containerRef = useRef<HTMLDivElement>(null);

  const renderPage = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const pdfjsLib = await import("pdfjs-dist");
      pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

      const bufferCopy = pdfBuffer.slice(0);
      const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(bufferCopy) });
      const doc = await loadingTask.promise;

      if (pageIndex + 1 > doc.numPages) {
        setError(`Page ${pageIndex + 1} not found (PDF has ${doc.numPages} pages)`);
        setLoading(false);
        return;
      }

      const page = await doc.getPage(pageIndex + 1); // pdfjs is 1-based
      const baseViewport = page.getViewport({ scale: 1 });

      // Scale to fit container or maxWidth
      const containerWidth = containerRef.current?.offsetWidth ?? maxWidth ?? 600;
      const targetWidth = Math.min(containerWidth, maxWidth ?? containerWidth);
      const scale = targetWidth / baseViewport.width;
      const viewport = page.getViewport({ scale });

      const canvas = document.createElement("canvas");
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        setError("Canvas context unavailable");
        setLoading(false);
        return;
      }

      await page.render({ canvasContext: ctx, canvas, viewport }).promise;
      const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
      canvas.width = 0;
      canvas.height = 0;

      setImageUrl(dataUrl);
    } catch (err) {
      console.error("PDF page render error:", err);
      setError("Failed to render PDF page");
    } finally {
      setLoading(false);
    }
  }, [pdfBuffer, pageIndex, maxWidth]);

  useEffect(() => {
    if (expanded) {
      renderPage();
    }
  }, [expanded, renderPage]);

  if (collapsible && !expanded) {
    return (
      <button
        onClick={() => setExpanded(true)}
        className="flex items-center gap-2 text-xs font-medium px-3 py-2 rounded-lg bg-tint border border-border-dim text-accent transition-colors hover:bg-tint-strong"
      >
        <span>&#x1F4C4;</span>
        View PDF Page {pageIndex + 1}
      </button>
    );
  }

  return (
    <div ref={containerRef} className="rounded-lg overflow-hidden border border-border-dim bg-tint">
      {label && (
        <div className="flex items-center justify-between px-3 py-1.5 border-b border-border-dim">
          <span className="text-[10px] text-tertiary uppercase tracking-wide font-semibold">
            {label}
          </span>
          {collapsible && (
            <button
              onClick={() => setExpanded(false)}
              className="text-[10px] text-tertiary hover:text-secondary transition-colors"
            >
              Hide
            </button>
          )}
        </div>
      )}

      {loading && (
        <div className="flex items-center justify-center py-12">
          <div className="w-5 h-5 border-2 border-accent border-t-transparent rounded-full animate-spin" />
          <span className="ml-2 text-xs text-tertiary">Rendering page {pageIndex + 1}...</span>
        </div>
      )}

      {error && (
        <div className="px-3 py-4 text-xs text-danger text-center">{error}</div>
      )}

      {imageUrl && !loading && (
        <img
          src={imageUrl}
          alt={`PDF page ${pageIndex + 1}`}
          className="w-full h-auto"
          style={{ maxWidth: maxWidth ? `${maxWidth}px` : undefined }}
        />
      )}
    </div>
  );
}
