"use client";

import { useState, useEffect, useRef, useCallback } from "react";

/** Minimum normalized dimension (0-1) for a valid selection. */
const MIN_NORMALIZED_DIM = 0.01;

/** Maximum zoom to avoid pixelation. */
const MAX_ZOOM = 4;

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
 * Pure function: crop the full-page image to the selection rect and return
 * a data-URL + zoom scale. Works without any DOM element being mounted.
 */
function computeZoomCrop(
  img: HTMLImageElement,
  selectionRect: { left: number; top: number; width: number; height: number },
  imageDims: { w: number; h: number },
  displayDims: { w: number; h: number },
  containerWidth: number,
): { dataUrl: string; scale: number } | null {
  if (displayDims.w === 0 || displayDims.h === 0) return null;

  const scaleX = imageDims.w / displayDims.w;
  const scaleY = imageDims.h / displayDims.h;

  const srcX = selectionRect.left * scaleX;
  const srcY = selectionRect.top * scaleY;
  const srcW = selectionRect.width * scaleX;
  const srcH = selectionRect.height * scaleY;

  const scale = Math.min(containerWidth / selectionRect.width, MAX_ZOOM);

  const destW = Math.round(srcW * (scale / scaleX));
  const destH = Math.round(srcH * (scale / scaleY));

  const canvas = document.createElement("canvas");
  canvas.width = destW;
  canvas.height = destH;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  ctx.drawImage(img, srcX, srcY, srcW, srcH, 0, 0, destW, destH);
  const dataUrl = canvas.toDataURL("image/jpeg", 0.95);
  canvas.width = 0;
  canvas.height = 0;

  return { dataUrl, scale };
}

/**
 * Renders a PDF page with a draggable selection rectangle overlay.
 * Two-phase flow: 'select' (draw rectangle) → 'zoom' (fine-tune + extract).
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
  const [phase, setPhase] = useState<"select" | "zoom">("select");

  /** Full image natural dimensions (pixel size of the rendered data URL). */
  const [imageDims, setImageDims] = useState<{ w: number; h: number } | null>(null);

  /** Canvas-cropped zoom image data URL. */
  const [zoomImageUrl, setZoomImageUrl] = useState<string | null>(null);
  /** Zoom scale factor used for the current crop. */
  const [zoomScale, setZoomScale] = useState<number>(1);

  const imageRef = useRef<HTMLImageElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const zoomContainerRef = useRef<HTMLDivElement>(null);

  /** Off-screen Image that persists across phase changes (not tied to DOM mount). */
  const fullPageImageRef = useRef<HTMLImageElement | null>(null);
  /** Display dimensions captured when the on-screen img loads. */
  const displayDimsRef = useRef<{ w: number; h: number } | null>(null);

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

  // Keep an off-screen Image in sync with imageUrl so crop logic works even
  // after the DOM <img> is unmounted during the zoom phase.
  useEffect(() => {
    if (!imageUrl) {
      fullPageImageRef.current = null;
      return;
    }
    const img = new Image();
    img.src = imageUrl;
    img.onload = () => {
      fullPageImageRef.current = img;
    };
  }, [imageUrl]);

  /** Track image natural dimensions + display dimensions once loaded. */
  const handleImageLoad = useCallback(() => {
    const img = imageRef.current;
    if (img) {
      setImageDims({ w: img.naturalWidth, h: img.naturalHeight });
      const rect = img.getBoundingClientRect();
      displayDimsRef.current = { w: rect.width, h: rect.height };
    }
  }, []);

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
    if (!isDragging) return;
    setIsDragging(false);
    setResizeHandle(null);

    // Auto-transition to zoom phase if selection is valid
    if (phase === "select" && selection) {
      const img = imageRef.current;
      if (img) {
        const rect = img.getBoundingClientRect();
        const selW = Math.abs(selection.endX - selection.startX);
        const selH = Math.abs(selection.endY - selection.startY);
        if (rect.width > 0 && rect.height > 0) {
          const normW = selW / rect.width;
          const normH = selH / rect.height;
          if (normW >= MIN_NORMALIZED_DIM && normH >= MIN_NORMALIZED_DIM && selW > 10 && selH > 10) {
            // Compute zoom crop BEFORE changing phase so imageRef is still in
            // the DOM and display dimensions are fresh.
            const sr = {
              left: Math.min(selection.startX, selection.endX),
              top: Math.min(selection.startY, selection.endY),
              width: selW,
              height: selH,
            };
            // Snapshot display dims while the DOM img is still mounted
            displayDimsRef.current = { w: rect.width, h: rect.height };
            const cropImg = fullPageImageRef.current ?? img;
            if (imageDims) {
              const crop = computeZoomCrop(
                cropImg,
                sr,
                imageDims,
                displayDimsRef.current,
                containerRef.current?.offsetWidth ?? 600,
              );
              if (crop) {
                setZoomImageUrl(crop.dataUrl);
                setZoomScale(crop.scale);
              }
            }
            setPhase("zoom");
          }
        }
      }
    }
  }, [isDragging, phase, selection, imageDims]);

  const handleExtract = useCallback(() => {
    const dd = displayDimsRef.current;
    if (!selection || !dd) return;

    const w = dd.w;
    const h = dd.h;

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
  }, [selection, onSelect, onError]);

  // Compute selection rect for rendering
  const selectionRect = selection ? {
    left: Math.min(selection.startX, selection.endX),
    top: Math.min(selection.startY, selection.endY),
    width: Math.abs(selection.endX - selection.startX),
    height: Math.abs(selection.endY - selection.startY),
  } : null;

  const hasValidSelection = (() => {
    const dd = displayDimsRef.current;
    if (!selectionRect || !dd) return false;
    if (selectionRect.width <= 10 || selectionRect.height <= 10) return false;
    // Also check normalized dimensions to stay in sync with handleExtract
    if (dd.w === 0 || dd.h === 0) return false;
    const normW = selectionRect.width / dd.w;
    const normH = selectionRect.height / dd.h;
    return normW >= MIN_NORMALIZED_DIM && normH >= MIN_NORMALIZED_DIM;
  })();

  const canGoPrev = pageIndex > 0;
  const canGoNext = pageIndex < totalPages - 1;

  const handlePageNav = useCallback((delta: number) => {
    const next = pageIndex + delta;
    if (next < 0 || next >= totalPages) return;
    setSelection(null);
    setPhase("select");
    onPageChange?.(next);
  }, [pageIndex, totalPages, onPageChange]);

  const handleBackToSelect = useCallback(() => {
    setPhase("select");
    setZoomImageUrl(null);
  }, []);

  // --- Canvas re-crop: generate zoomed image (used for handle-drag re-renders in zoom phase) ---
  const renderZoomCrop = useCallback(() => {
    const img = fullPageImageRef.current;
    const dd = displayDimsRef.current;
    if (!img || !selectionRect || !imageDims || !dd) return;

    const crop = computeZoomCrop(
      img,
      selectionRect,
      imageDims,
      dd,
      containerRef.current?.offsetWidth ?? 600,
    );
    if (crop) {
      setZoomImageUrl(crop.dataUrl);
      setZoomScale(crop.scale);
    }
  }, [selectionRect, imageDims]);

  // Trigger canvas crop when entering zoom phase or when selection changes (handle drag release)
  useEffect(() => {
    if (phase === "zoom" && selectionRect) {
      renderZoomCrop();
    }
  }, [phase, renderZoomCrop]);
  // Note: renderZoomCrop depends on selectionRect which changes on handle release

  // --- Zoom view: pointer handlers for dragging handles in zoom view ---
  const handleZoomPointerDown = useCallback((e: React.PointerEvent) => {
    if (loading || !selection || !zoomImageUrl) return;
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);

    const zoomContainer = zoomContainerRef.current;
    if (!zoomContainer) return;

    const containerRect = zoomContainer.getBoundingClientRect();
    const px = e.clientX - containerRect.left;
    const py = e.clientY - containerRect.top;

    // Use zoom-space hit test (handles are at corners of the zoomed image)
    const zoomedW = containerRect.width;
    const zoomedH = containerRect.height;
    const handle = getHandleAtPositionZoomed(px, py, zoomedW, zoomedH, 20);
    if (handle) {
      setResizeHandle(handle);
      setIsDragging(true);
    }
  }, [loading, selection, zoomImageUrl]);

  const handleZoomPointerMove = useCallback((e: React.PointerEvent) => {
    if (!isDragging || !resizeHandle || !selectionRect) return;
    e.preventDefault();

    const zoomContainer = zoomContainerRef.current;
    if (!zoomContainer) return;

    const containerRect = zoomContainer.getBoundingClientRect();
    const px = e.clientX - containerRect.left;
    const py = e.clientY - containerRect.top;

    // Convert zoom-view deltas back to full-image display coordinates
    const dd = displayDimsRef.current;
    const imgDisplayW = dd?.w ?? imageDims?.w ?? 800;
    const imgDisplayH = dd?.h ?? imageDims?.h ?? 600;

    const fullX = Math.max(0, Math.min(selectionRect.left + px / zoomScale, imgDisplayW));
    const fullY = Math.max(0, Math.min(selectionRect.top + py / zoomScale, imgDisplayH));

    setSelection(prev => {
      if (!prev) return prev;
      const updated = { ...prev };
      if (resizeHandle === "nw") {
        updated.startX = fullX;
        updated.startY = fullY;
      } else if (resizeHandle === "ne") {
        updated.endX = fullX;
        updated.startY = fullY;
      } else if (resizeHandle === "sw") {
        updated.startX = fullX;
        updated.endY = fullY;
      } else if (resizeHandle === "se") {
        updated.endX = fullX;
        updated.endY = fullY;
      }
      return updated;
    });
  }, [isDragging, resizeHandle, selectionRect, zoomScale, imageDims]);

  const handleZoomPointerUp = useCallback(() => {
    if (!isDragging) return;
    setIsDragging(false);
    setResizeHandle(null);
    // Re-render the canvas crop with updated coordinates
    renderZoomCrop();
  }, [isDragging, renderZoomCrop]);

  // Reset phase, selection, and imageDims when page changes
  useEffect(() => {
    setPhase("select");
    setSelection(null);
    setImageDims(null);
    setZoomImageUrl(null);
    displayDimsRef.current = null;
  }, [pageIndex]);

  return (
    <div className="flex flex-col gap-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-bold text-primary">
            {phase === "zoom" ? "Fine-tune selection" : "Select region to re-scan"}
          </h3>
          {phase === "select" && (
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
          )}
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
        {phase === "zoom"
          ? "Drag the corner handles to fine-tune your selection, then extract."
          : "Draw a rectangle around the table you want to re-extract."}
      </p>

      {/* Phase: SELECT — full page PDF with drawing overlay */}
      {phase === "select" && (
        <>
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
                  onLoad={handleImageLoad}
                  onPointerDown={handlePointerDown}
                  onPointerMove={handlePointerMove}
                  onPointerUp={handlePointerUp}
                  style={{ cursor: "crosshair" }}
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

          {/* Select-phase action buttons — only Clear & Cancel (no Extract here) */}
          <div className="flex items-center gap-3">
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
        </>
      )}

      {/* Phase: ZOOM — canvas-cropped view with fine-tune handles */}
      {phase === "zoom" && selectionRect && (
        <>
          <ZoomView
            zoomImageUrl={zoomImageUrl}
            zoomContainerRef={zoomContainerRef}
            isDragging={isDragging}
            onPointerDown={handleZoomPointerDown}
            onPointerMove={handleZoomPointerMove}
            onPointerUp={handleZoomPointerUp}
          />

          {/* Zoom-phase action buttons */}
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
              onClick={handleBackToSelect}
              disabled={loading}
              className="px-3 py-2 rounded-lg border border-border-dim text-secondary text-sm hover:bg-tint-strong transition-colors"
            >
              Back
            </button>
            <button
              onClick={onCancel}
              disabled={loading}
              className="px-3 py-2 rounded-lg border border-border-dim text-tertiary text-sm hover:bg-tint-strong transition-colors ml-auto"
            >
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** Zoomed-in view using a canvas-cropped image with fine-tune handles. */
function ZoomView({
  zoomImageUrl,
  zoomContainerRef,
  isDragging,
  onPointerDown,
  onPointerMove,
  onPointerUp,
}: {
  zoomImageUrl: string | null;
  zoomContainerRef: React.RefObject<HTMLDivElement | null>;
  isDragging: boolean;
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: (e: React.PointerEvent) => void;
}) {
  return (
    <div
      ref={zoomContainerRef}
      className="relative rounded-lg overflow-hidden border border-border-dim bg-tint select-none"
      style={{
        touchAction: "none",
        width: "100%",
        maxHeight: "60vh",
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      {zoomImageUrl ? (
        <>
          <img
            src={zoomImageUrl}
            alt="Zoomed selection"
            draggable={false}
            className="w-full h-auto"
            style={{ pointerEvents: "none" }}
          />

          {/* Selection border overlay */}
          <div
            className="absolute inset-0 pointer-events-none"
            style={{
              border: "2px solid var(--blue)",
              boxShadow: "0 0 8px var(--glow-blue)",
            }}
          />

          {/* Corner handles for fine-tuning */}
          {!isDragging && (
            <>
              <Handle x={0} y={0} cursor="nw-resize" />
              <Handle x="100%" y={0} cursor="ne-resize" isRight />
              <Handle x={0} y="100%" cursor="sw-resize" isBottom />
              <Handle x="100%" y="100%" cursor="se-resize" isRight isBottom />
            </>
          )}
        </>
      ) : (
        <div className="flex items-center justify-center py-16">
          <div className="w-5 h-5 border-2 border-accent border-t-transparent rounded-full animate-spin" />
          <span className="ml-2 text-xs text-tertiary">Rendering zoom...</span>
        </div>
      )}
    </div>
  );
}

/** Small square handle rendered at selection corners. */
function Handle({
  x,
  y,
  cursor,
  isRight,
  isBottom,
}: {
  x: number | string;
  y: number | string;
  cursor: string;
  isRight?: boolean;
  isBottom?: boolean;
}) {
  // For percentage-based positioning (zoom view), anchor from right/bottom edges
  const style: React.CSSProperties = {
    width: 10,
    height: 10,
    backgroundColor: "var(--blue)",
    border: "1px solid rgba(255,255,255,0.8)",
    cursor,
  };

  if (typeof x === "string" && isRight) {
    style.right = -5;
  } else {
    style.left = typeof x === "number" ? x - 5 : undefined;
  }
  if (typeof y === "string" && isBottom) {
    style.bottom = -5;
  } else {
    style.top = typeof y === "number" ? y - 5 : undefined;
  }

  return (
    <div
      className="absolute pointer-events-none"
      style={style}
    />
  );
}

/** Check if a position is near one of the selection's corner handles (select phase). */
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

/**
 * Check if a position is near a corner handle in the zoom view.
 * Handles are at the four corners of the zoomed image (0,0), (w,0), (0,h), (w,h).
 * This avoids the overlap problem with getHandleAtPosition on small selections.
 */
function getHandleAtPositionZoomed(
  px: number,
  py: number,
  zoomedW: number,
  zoomedH: number,
  threshold: number,
): "nw" | "ne" | "sw" | "se" | null {
  if (Math.abs(px) < threshold && Math.abs(py) < threshold) return "nw";
  if (Math.abs(px - zoomedW) < threshold && Math.abs(py) < threshold) return "ne";
  if (Math.abs(px) < threshold && Math.abs(py - zoomedH) < threshold) return "sw";
  if (Math.abs(px - zoomedW) < threshold && Math.abs(py - zoomedH) < threshold) return "se";
  return null;
}
