"use client";

import { useState, useEffect, useRef, useCallback } from "react";

/** Minimum normalized dimension (0-1) for a valid selection. */
const MIN_NORMALIZED_DIM = 0.01;

interface PDFRegionSelectorProps {
  pdfBuffer: ArrayBuffer;
  pageIndex: number;
  onSelect: (bbox: { x0: number; y0: number; x1: number; y1: number }) => void;
  onCancel: () => void;
  loading?: boolean;
  /** Callback when the user navigates to a different page. */
  onPageChange?: (newPageIndex: number) => void;
  /** Callback for error/warning messages (e.g. selection too small). */
  onError?: (message: string) => void;
}

interface Selection {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
}

/**
 * Renders a PDF page with a draggable selection rectangle overlay.
 * Returns normalized 0-1 percentage coordinates via onSelect.
 * Uses Pointer Events API for combined mouse + touch support.
 */
export default function PDFRegionSelector({
  pdfBuffer,
  pageIndex,
  onSelect,
  onCancel,
  loading = false,
  onPageChange,
  onError,
}: PDFRegionSelectorProps) {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [pageLoading, setPageLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [resizeHandle, setResizeHandle] = useState<"nw" | "ne" | "sw" | "se" | null>(null);
  const [totalPages, setTotalPages] = useState<number>(1);

  const imageRef = useRef<HTMLImageElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Render PDF page to image (same pattern as PDFPagePreview)
  const renderPage = useCallback(async () => {
    setPageLoading(true);
    setError(null);

    try {
      const pdfjsLib = await import("pdfjs-dist");
      pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

      const bufferCopy = pdfBuffer.slice(0);
      const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(bufferCopy) });
      const doc = await loadingTask.promise;
      setTotalPages(doc.numPages);

      if (pageIndex + 1 > doc.numPages) {
        setError(`Page ${pageIndex + 1} not found (PDF has ${doc.numPages} pages)`);
        setPageLoading(false);
        return;
      }

      const page = await doc.getPage(pageIndex + 1);
      const baseViewport = page.getViewport({ scale: 1 });

      // Render at up to 800px width for selection precision
      const maxWidth = 800;
      const containerWidth = containerRef.current?.offsetWidth ?? maxWidth;
      const targetWidth = Math.min(containerWidth, maxWidth);

      const dpr = Math.min(
        typeof window !== "undefined" ? (window.devicePixelRatio ?? 1) : 1,
        2,
      );
      const displayScale = targetWidth / baseViewport.width;
      const renderScale = displayScale * dpr;
      const viewport = page.getViewport({ scale: renderScale });

      const canvas = document.createElement("canvas");
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        setError("Canvas context unavailable");
        setPageLoading(false);
        return;
      }

      await page.render({ canvasContext: ctx, canvas, viewport }).promise;
      const dataUrl = canvas.toDataURL("image/jpeg", 0.92);
      canvas.width = 0;
      canvas.height = 0;

      setImageUrl(dataUrl);
    } catch (err) {
      console.error("PDF region selector render error:", err);
      setError("Failed to render PDF page");
    } finally {
      setPageLoading(false);
    }
  }, [pdfBuffer, pageIndex]);

  useEffect(() => {
    renderPage();
  }, [renderPage]);

  // Get mouse/touch position relative to the image element
  const getRelativePosition = useCallback((e: React.PointerEvent) => {
    const img = imageRef.current;
    if (!img) return { x: 0, y: 0 };
    const rect = img.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(e.clientX - rect.left, rect.width)),
      y: Math.max(0, Math.min(e.clientY - rect.top, rect.height)),
    };
  }, []);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (loading) return;
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const pos = getRelativePosition(e);

    // Check if clicking on a resize handle
    if (selection) {
      const handle = getHandleAtPosition(pos.x, pos.y, selection);
      if (handle) {
        setResizeHandle(handle);
        setIsDragging(true);
        return;
      }
    }

    // Start new selection
    setSelection({ startX: pos.x, startY: pos.y, endX: pos.x, endY: pos.y });
    setIsDragging(true);
    setResizeHandle(null);
  }, [loading, selection, getRelativePosition]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!isDragging) return;
    e.preventDefault();
    const pos = getRelativePosition(e);

    if (resizeHandle && selection) {
      // Resize existing selection from the active corner
      setSelection(prev => {
        if (!prev) return prev;
        const updated = { ...prev };
        if (resizeHandle === "nw") {
          updated.startX = pos.x;
          updated.startY = pos.y;
        } else if (resizeHandle === "ne") {
          updated.endX = pos.x;
          updated.startY = pos.y;
        } else if (resizeHandle === "sw") {
          updated.startX = pos.x;
          updated.endY = pos.y;
        } else if (resizeHandle === "se") {
          updated.endX = pos.x;
          updated.endY = pos.y;
        }
        return updated;
      });
    } else {
      // Drawing new selection
      setSelection(prev => prev ? { ...prev, endX: pos.x, endY: pos.y } : prev);
    }
  }, [isDragging, resizeHandle, selection, getRelativePosition]);

  const handlePointerUp = useCallback(() => {
    setIsDragging(false);
    setResizeHandle(null);
  }, []);

  const handleExtract = useCallback(() => {
    if (!selection || !imageRef.current) return;

    const img = imageRef.current;
    const rect = img.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;

    // Normalize to 0-1 percentages, ensuring x0 < x1 and y0 < y1
    const bbox = {
      x0: Math.min(selection.startX, selection.endX) / w,
      y0: Math.min(selection.startY, selection.endY) / h,
      x1: Math.max(selection.startX, selection.endX) / w,
      y1: Math.max(selection.startY, selection.endY) / h,
    };

    // Reject tiny selections (< 1% of page in either dimension)
    if (bbox.x1 - bbox.x0 < MIN_NORMALIZED_DIM || bbox.y1 - bbox.y0 < MIN_NORMALIZED_DIM) {
      onError?.("Selection too small — draw a larger rectangle");
      return;
    }

    onSelect(bbox);
  }, [selection, onSelect]);

  // Compute selection rect for rendering
  const selectionRect = selection ? {
    left: Math.min(selection.startX, selection.endX),
    top: Math.min(selection.startY, selection.endY),
    width: Math.abs(selection.endX - selection.startX),
    height: Math.abs(selection.endY - selection.startY),
  } : null;

  const hasValidSelection = (() => {
    if (!selectionRect || !imageRef.current) return false;
    if (selectionRect.width <= 10 || selectionRect.height <= 10) return false;
    // Also check normalized dimensions to stay in sync with handleExtract
    const rect = imageRef.current.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const normW = selectionRect.width / rect.width;
    const normH = selectionRect.height / rect.height;
    return normW >= MIN_NORMALIZED_DIM && normH >= MIN_NORMALIZED_DIM;
  })();

  const canGoPrev = pageIndex > 0;
  const canGoNext = pageIndex < totalPages - 1;

  const handlePageNav = useCallback((delta: number) => {
    const next = pageIndex + delta;
    if (next < 0 || next >= totalPages) return;
    setSelection(null);
    onPageChange?.(next);
  }, [pageIndex, totalPages, onPageChange]);

  return (
    <div className="flex flex-col gap-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-bold text-primary">
            Select region to re-scan
          </h3>
          <div className="flex items-center gap-1">
            {onPageChange && (
              <button
                onClick={() => handlePageNav(-1)}
                disabled={!canGoPrev || loading}
                className="w-6 h-6 flex items-center justify-center rounded text-xs font-bold text-secondary hover:bg-tint-strong transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                aria-label="Previous page"
              >
                &lt;
              </button>
            )}
            <span className="text-xs text-secondary tabular-nums">
              Page {pageIndex + 1}{totalPages > 1 ? ` / ${totalPages}` : ''}
            </span>
            {onPageChange && (
              <button
                onClick={() => handlePageNav(1)}
                disabled={!canGoNext || loading}
                className="w-6 h-6 flex items-center justify-center rounded text-xs font-bold text-secondary hover:bg-tint-strong transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                aria-label="Next page"
              >
                &gt;
              </button>
            )}
          </div>
        </div>
        <button
          onClick={onCancel}
          className="text-lg leading-none text-tertiary hover:text-primary transition-colors px-2"
          aria-label="Close"
        >
          &times;
        </button>
      </div>

      <p className="text-xs text-tertiary">
        Draw a rectangle around the table you want to re-extract.
      </p>

      {/* PDF page with selection overlay */}
      <div
        ref={containerRef}
        className="relative rounded-lg overflow-hidden border border-border-dim bg-tint select-none"
        style={{ touchAction: "none" }}
      >
        {pageLoading && (
          <div className="flex items-center justify-center py-16">
            <div className="w-5 h-5 border-2 border-accent border-t-transparent rounded-full animate-spin" />
            <span className="ml-2 text-xs text-tertiary">Rendering page...</span>
          </div>
        )}

        {error && (
          <div className="px-3 py-8 text-xs text-danger text-center">{error}</div>
        )}

        {imageUrl && !pageLoading && (
          <div className="relative">
            <img
              ref={imageRef}
              src={imageUrl}
              alt={`PDF page ${pageIndex + 1}`}
              className="w-full h-auto"
              draggable={false}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              style={{ cursor: isDragging ? "crosshair" : "crosshair" }}
            />

            {/* Selection rectangle overlay */}
            {selectionRect && selectionRect.width > 0 && selectionRect.height > 0 && (
              <>
                <div
                  className="absolute pointer-events-none"
                  style={{
                    left: selectionRect.left,
                    top: selectionRect.top,
                    width: selectionRect.width,
                    height: selectionRect.height,
                    border: "2px solid var(--blue)",
                    backgroundColor: "var(--blue-dim)",
                    boxShadow: "0 0 8px var(--glow-blue)",
                  }}
                />
                {/* Corner handles */}
                {!isDragging && (
                  <>
                    <Handle x={selectionRect.left} y={selectionRect.top} cursor="nw-resize" />
                    <Handle x={selectionRect.left + selectionRect.width} y={selectionRect.top} cursor="ne-resize" />
                    <Handle x={selectionRect.left} y={selectionRect.top + selectionRect.height} cursor="sw-resize" />
                    <Handle x={selectionRect.left + selectionRect.width} y={selectionRect.top + selectionRect.height} cursor="se-resize" />
                  </>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {/* Action buttons */}
      <div className="flex items-center gap-3">
        <button
          onClick={handleExtract}
          disabled={!hasValidSelection || loading}
          className="px-4 py-2 rounded-lg bg-accent text-white text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed hover:bg-accent/90 transition-colors"
        >
          {loading ? (
            <span className="flex items-center gap-2">
              <span className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
              Extracting...
            </span>
          ) : (
            "Extract from selection"
          )}
        </button>
        <button
          onClick={() => setSelection(null)}
          disabled={!selection || loading}
          className="px-3 py-2 rounded-lg border border-border-dim text-secondary text-sm hover:bg-tint-strong transition-colors disabled:opacity-40"
        >
          Clear
        </button>
        <button
          onClick={onCancel}
          disabled={loading}
          className="px-3 py-2 rounded-lg border border-border-dim text-tertiary text-sm hover:bg-tint-strong transition-colors ml-auto"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/** Small square handle rendered at selection corners. */
function Handle({ x, y, cursor }: { x: number; y: number; cursor: string }) {
  return (
    <div
      className="absolute pointer-events-none"
      style={{
        left: x - 5,
        top: y - 5,
        width: 10,
        height: 10,
        backgroundColor: "var(--blue)",
        border: "1px solid rgba(255,255,255,0.8)",
        cursor,
      }}
    />
  );
}

/** Check if a position is near one of the selection's corner handles. */
function getHandleAtPosition(
  x: number,
  y: number,
  sel: Selection,
): "nw" | "ne" | "sw" | "se" | null {
  const threshold = 14;
  const left = Math.min(sel.startX, sel.endX);
  const top = Math.min(sel.startY, sel.endY);
  const right = Math.max(sel.startX, sel.endX);
  const bottom = Math.max(sel.startY, sel.endY);

  if (Math.abs(x - left) < threshold && Math.abs(y - top) < threshold) return "nw";
  if (Math.abs(x - right) < threshold && Math.abs(y - top) < threshold) return "ne";
  if (Math.abs(x - left) < threshold && Math.abs(y - bottom) < threshold) return "sw";
  if (Math.abs(x - right) < threshold && Math.abs(y - bottom) < threshold) return "se";
  return null;
}
