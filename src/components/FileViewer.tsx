"use client";

import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { Attachment } from "@/lib/types/database";

interface FileViewerProps {
  attachment: Attachment;
  onClose: () => void;
}

interface RenderedPage {
  dataUrl: string;
  naturalWidth: number;
  naturalHeight: number;
}

export default function FileViewer({ attachment, onClose }: FileViewerProps) {
  // ── Core state ──
  const [scale, setScale] = useState(1);
  const [fitScale, setFitScale] = useState(1);
  const [isFitted, setIsFitted] = useState(true);
  const [position, setPosition] = useState({ x: 0, y: 0 });

  // ── Touch tracking ──
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef({ x: 0, y: 0 });
  const lastPinchDistRef = useRef(0);
  const lastTapRef = useRef<{ time: number; x: number; y: number }>({ time: 0, x: 0, y: 0 });
  const swipeStartRef = useRef<{ x: number; y: number; time: number } | null>(null);

  // ── PDF state ──
  const [pdfPageNum, setPdfPageNum] = useState(1);
  const [pdfTotalPages, setPdfTotalPages] = useState(1);
  const [pdfLoading, setPdfLoading] = useState(false);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const [pageCache, setPageCache] = useState<Map<number, RenderedPage>>(new Map());
  const [showPageJump, setShowPageJump] = useState(false);
  const [pageJumpValue, setPageJumpValue] = useState("");
  const [swipeOffset, setSwipeOffset] = useState(0);

  // ── Refs ──
  const containerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pdfDocRef = useRef<any>(null);
  const pageJumpInputRef = useRef<HTMLInputElement>(null);
  const isSwipingRef = useRef(false);

  // ── File type detection ──
  const isPdf = attachment.file_type?.includes("pdf") ||
    attachment.file_name?.toLowerCase().endsWith(".pdf");
  const isImage = attachment.file_type?.startsWith("image/") ||
    /\.(jpg|jpeg|png|gif|webp|bmp|svg)$/i.test(attachment.file_name || "");

  // ── Fit scale computation ──
  const computeFitScale = useCallback((contentW: number, contentH: number) => {
    const containerW = containerRef.current?.clientWidth || window.innerWidth;
    const containerH = containerRef.current?.clientHeight || window.innerHeight;
    return Math.min(containerW / contentW, containerH / contentH);
  }, []);

  // ── PDF page rendering ──
  const renderPage = useCallback(async (pageNum: number): Promise<RenderedPage | null> => {
    try {
      const pdfjsLib = await import("pdfjs-dist");
      pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

      if (!pdfDocRef.current) {
        const resp = await fetch(attachment.file_url);
        const data = await resp.arrayBuffer();
        const loadingTask = pdfjsLib.getDocument({ data });
        pdfDocRef.current = await loadingTask.promise;
        setPdfTotalPages(pdfDocRef.current.numPages);
      }

      const pdf = pdfDocRef.current;
      const page = await pdf.getPage(pageNum);
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const baseViewport = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: dpr });

      const canvas = document.createElement("canvas");
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext("2d")!;
      await page.render({ canvasContext: ctx, canvas, viewport }).promise;

      const dataUrl = canvas.toDataURL("image/png");
      canvas.width = 0;
      canvas.height = 0;

      return {
        dataUrl,
        naturalWidth: baseViewport.width,
        naturalHeight: baseViewport.height,
      };
    } catch (err) {
      console.error(`PDF render error (page ${pageNum}):`, err);
      return null;
    }
  }, [attachment.file_url]);

  // ── Load current page + preload neighbors ──
  const loadPage = useCallback(async (pageNum: number) => {
    // If already cached, just update fit scale
    const cached = pageCache.get(pageNum);
    if (cached) {
      const computed = computeFitScale(cached.naturalWidth, cached.naturalHeight);
      setFitScale(computed);
      setScale(computed);
      setPosition({ x: 0, y: 0 });
      setIsFitted(true);
      setPdfLoading(false);
      return;
    }

    setPdfLoading(true);
    setPdfError(null);

    const timeout = new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), 20000)
    );

    const result = await Promise.race([renderPage(pageNum), timeout]);

    if (result) {
      setPageCache((prev) => {
        const next = new Map(prev);
        next.set(pageNum, result);
        // Keep cache bounded — evict pages far from current
        for (const key of next.keys()) {
          if (Math.abs(key - pageNum) > 3) next.delete(key);
        }
        return next;
      });

      const computed = computeFitScale(result.naturalWidth, result.naturalHeight);
      setFitScale(computed);
      setScale(computed);
      setPosition({ x: 0, y: 0 });
      setIsFitted(true);
    } else {
      setPdfError("PDF took too long to render. Tap Open to view in browser.");
    }

    setPdfLoading(false);

    // Preload adjacent pages
    const total = pdfDocRef.current?.numPages || pdfTotalPages;
    const preloadTargets = [pageNum - 1, pageNum + 1].filter(
      (p) => p >= 1 && p <= total && !pageCache.has(p)
    );
    for (const target of preloadTargets) {
      renderPage(target).then((res) => {
        if (res) {
          setPageCache((prev) => {
            const next = new Map(prev);
            next.set(target, res);
            return next;
          });
        }
      });
    }
  }, [pageCache, computeFitScale, renderPage, pdfTotalPages]);

  // ── Load PDF on mount/page change ──
  useEffect(() => {
    if (isPdf) {
      loadPage(pdfPageNum);
    }
  }, [isPdf, pdfPageNum]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Image load handler ──
  const handleImageLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    const computed = computeFitScale(img.naturalWidth, img.naturalHeight);
    setFitScale(computed);
    setScale(computed);
  }, [computeFitScale]);

  // ── Zoom controls ──
  const fitToScreen = useCallback(() => {
    setScale(fitScale);
    setPosition({ x: 0, y: 0 });
    setIsFitted(true);
  }, [fitScale]);

  const zoomIn = useCallback(() => {
    setScale((s) => Math.min(s * 1.3, 5));
    setIsFitted(false);
  }, []);

  const zoomOut = useCallback(() => {
    setScale((s) => {
      const minScale = Math.max(fitScale * 0.5, 0.1);
      const next = Math.max(s / 1.3, minScale);
      if (next <= fitScale) {
        setPosition({ x: 0, y: 0 });
        setIsFitted(true);
        return fitScale;
      }
      return next;
    });
  }, [fitScale]);

  // ── Double-tap zoom ──
  const handleDoubleTap = useCallback((x: number, y: number) => {
    if (isFitted) {
      // Zoom to 2.5x centered on tap point
      const targetScale = fitScale * 2.5;
      const containerW = containerRef.current?.clientWidth || window.innerWidth;
      const containerH = containerRef.current?.clientHeight || window.innerHeight;
      const centerX = containerW / 2;
      const centerY = containerH / 2;
      setScale(targetScale);
      setPosition({
        x: (centerX - x) * (targetScale / fitScale - 1) * 0.5,
        y: (centerY - y) * (targetScale / fitScale - 1) * 0.5,
      });
      setIsFitted(false);
    } else {
      fitToScreen();
    }
  }, [isFitted, fitScale, fitToScreen]);

  // ── Page navigation ──
  const goToPage = useCallback((page: number) => {
    const clamped = Math.max(1, Math.min(page, pdfTotalPages));
    if (clamped !== pdfPageNum) {
      setPdfPageNum(clamped);
    }
  }, [pdfTotalPages, pdfPageNum]);

  const prevPage = useCallback(() => goToPage(pdfPageNum - 1), [goToPage, pdfPageNum]);
  const nextPage = useCallback(() => goToPage(pdfPageNum + 1), [goToPage, pdfPageNum]);

  // ── Page jump submit ──
  const handlePageJumpSubmit = useCallback(() => {
    const num = parseInt(pageJumpValue, 10);
    if (!isNaN(num)) {
      goToPage(num);
    }
    setShowPageJump(false);
    setPageJumpValue("");
  }, [pageJumpValue, goToPage]);

  // Focus page jump input when shown
  useEffect(() => {
    if (showPageJump) {
      pageJumpInputRef.current?.focus();
      pageJumpInputRef.current?.select();
    }
  }, [showPageJump]);

  // ── Touch handlers ──
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      // Pinch start
      e.preventDefault();
      isSwipingRef.current = false;
      const dist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      lastPinchDistRef.current = dist;
    } else if (e.touches.length === 1) {
      const touch = e.touches[0];
      const now = Date.now();

      // Check for double-tap (within 300ms and 40px)
      const lastTap = lastTapRef.current;
      if (
        now - lastTap.time < 300 &&
        Math.abs(touch.clientX - lastTap.x) < 40 &&
        Math.abs(touch.clientY - lastTap.y) < 40
      ) {
        e.preventDefault();
        handleDoubleTap(touch.clientX, touch.clientY);
        lastTapRef.current = { time: 0, x: 0, y: 0 };
        return;
      }
      lastTapRef.current = { time: now, x: touch.clientX, y: touch.clientY };

      if (scale > fitScale * 1.05) {
        // Zoomed in — pan mode
        setIsDragging(true);
        isSwipingRef.current = false;
        dragStartRef.current = {
          x: touch.clientX - position.x,
          y: touch.clientY - position.y,
        };
      } else if (isPdf && pdfTotalPages > 1) {
        // At fit scale — swipe mode for page navigation
        isSwipingRef.current = true;
        swipeStartRef.current = { x: touch.clientX, y: touch.clientY, time: now };
        setSwipeOffset(0);
      }
    }
  }, [scale, fitScale, position, isPdf, pdfTotalPages, handleDoubleTap]);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      // Pinch zoom
      e.preventDefault();
      const dist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      if (lastPinchDistRef.current > 0) {
        const delta = dist / lastPinchDistRef.current;
        setScale((s) => Math.min(Math.max(s * delta, fitScale * 0.5), 5));
        setIsFitted(false);
      }
      lastPinchDistRef.current = dist;
    } else if (e.touches.length === 1) {
      if (isDragging && scale > fitScale * 1.05) {
        // Pan
        setPosition({
          x: e.touches[0].clientX - dragStartRef.current.x,
          y: e.touches[0].clientY - dragStartRef.current.y,
        });
      } else if (isSwipingRef.current && swipeStartRef.current) {
        // Horizontal swipe tracking
        const dx = e.touches[0].clientX - swipeStartRef.current.x;
        const dy = e.touches[0].clientY - swipeStartRef.current.y;
        // Only track horizontal swipes (prevent vertical scroll hijack)
        if (Math.abs(dx) > Math.abs(dy) * 1.2 || Math.abs(dx) > 20) {
          e.preventDefault();
          setSwipeOffset(dx);
        }
      }
    }
  }, [isDragging, scale, fitScale]);

  const handleTouchEnd = useCallback(() => {
    setIsDragging(false);
    lastPinchDistRef.current = 0;

    // Process swipe
    if (isSwipingRef.current && swipeStartRef.current) {
      const elapsed = Date.now() - swipeStartRef.current.time;
      const velocity = Math.abs(swipeOffset) / Math.max(elapsed, 1);

      // Swipe threshold: 60px displacement OR fast flick (velocity > 0.3px/ms)
      if (Math.abs(swipeOffset) > 60 || velocity > 0.3) {
        if (swipeOffset > 0 && pdfPageNum > 1) {
          prevPage();
        } else if (swipeOffset < 0 && pdfPageNum < pdfTotalPages) {
          nextPage();
        }
      }
    }

    isSwipingRef.current = false;
    swipeStartRef.current = null;
    setSwipeOffset(0);
  }, [swipeOffset, pdfPageNum, pdfTotalPages, prevPage, nextPage]);

  // ── Mouse wheel zoom (desktop) ──
  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    setScale((s) => {
      const minScale = Math.max(fitScale * 0.5, 0.1);
      const next = Math.min(Math.max(s * delta, minScale), 5);
      if (next <= fitScale) {
        setPosition({ x: 0, y: 0 });
        setIsFitted(true);
        return fitScale;
      }
      setIsFitted(false);
      return next;
    });
  }, [fitScale]);

  // ── Keyboard: Escape to close, arrow keys for pages ──
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (showPageJump) return; // Don't capture keys when page jump is open
      if (e.key === "Escape") onClose();
      if (isPdf) {
        if (e.key === "ArrowLeft" || e.key === "ArrowUp") prevPage();
        if (e.key === "ArrowRight" || e.key === "ArrowDown") nextPage();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose, isPdf, prevPage, nextPage, showPageJump]);

  // ── Current page data ──
  const currentPage = useMemo(() => pageCache.get(pdfPageNum), [pageCache, pdfPageNum]);

  // ── Content rendering ──
  const renderContent = () => {
    if (isPdf) {
      if (pdfLoading && !currentPage) {
        return (
          <div className="flex flex-col items-center justify-center gap-3">
            <div className="w-8 h-8 border-2 border-[#0a84ff] border-t-transparent rounded-full animate-spin" />
            <p className="text-[13px] text-[#a1a1a6]">
              Loading page {pdfPageNum}...
            </p>
          </div>
        );
      }
      if (pdfError && !currentPage) {
        return (
          <div className="text-center p-8">
            <p className="text-[15px] text-[#f5f5f7] mb-2">PDF Preview Error</p>
            <p className="text-[13px] text-[#6e6e73] mb-4">{pdfError}</p>
            <a
              href={attachment.file_url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block px-5 py-2.5 bg-[#0a84ff] text-white rounded-lg text-[15px] font-medium"
            >
              Open in Browser
            </a>
          </div>
        );
      }
      if (currentPage) {
        return (
          <img
            src={currentPage.dataUrl}
            alt={`${attachment.file_name || "PDF"} — Page ${pdfPageNum}`}
            className="select-none"
            draggable={false}
            style={{
              width: currentPage.naturalWidth,
              height: currentPage.naturalHeight,
              maxWidth: "none",
              maxHeight: "none",
              opacity: pdfLoading ? 0.5 : 1,
              transition: "opacity 0.15s ease",
            }}
          />
        );
      }
      return null;
    }

    if (isImage) {
      return (
        <img
          src={attachment.file_url}
          alt={attachment.file_name || "Attachment"}
          className="max-w-full max-h-full object-contain select-none"
          draggable={false}
          onLoad={handleImageLoad}
        />
      );
    }

    // Unsupported type fallback
    return (
      <div className="text-center p-8">
        <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-white/[0.04] border border-white/[0.08] flex items-center justify-center">
          <svg className="w-8 h-8 text-[#6e6e73]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
        </div>
        <p className="text-[15px] text-[#f5f5f7] mb-2">Preview unavailable</p>
        <p className="text-[13px] text-[#6e6e73] mb-4">{attachment.file_name}</p>
        <a
          href={attachment.file_url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-block px-5 py-2.5 bg-[#0a84ff] text-white rounded-lg text-[15px] font-medium"
        >
          Open in Browser
        </a>
      </div>
    );
  };

  return (
    <div className="fixed inset-0 z-[100] bg-black/95 backdrop-blur-xl flex flex-col">
      {/* ── Top bar ── */}
      <div className="flex-shrink-0 flex items-center justify-between px-4 py-3 bg-black/80 border-b border-white/[0.08]">
        <button
          onClick={onClose}
          className="text-[#0a84ff] text-[15px] font-medium flex items-center gap-1 min-w-[60px]"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          Back
        </button>

        <h2 className="text-[13px] text-[#a1a1a6] truncate max-w-[50%] text-center">
          {attachment.file_name}
        </h2>

        <a
          href={attachment.file_url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[#0a84ff] text-[13px] font-medium min-w-[60px] text-right"
        >
          Open
        </a>
      </div>

      {/* ── Viewer area ── */}
      <div
        ref={containerRef}
        className="flex-1 overflow-hidden relative"
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onWheel={handleWheel}
        style={{ touchAction: "none" }}
      >
        <div
          className="w-full h-full flex items-center justify-center"
          style={{
            transform: `translate(${position.x + swipeOffset}px, ${position.y}px) scale(${scale})`,
            transformOrigin: "center center",
            transition: isDragging || isSwipingRef.current ? "none" : "transform 0.2s ease-out",
          }}
        >
          {renderContent()}
        </div>

        {/* Swipe edge indicators */}
        {isPdf && pdfTotalPages > 1 && isFitted && (
          <>
            {swipeOffset > 30 && pdfPageNum > 1 && (
              <div className="absolute left-3 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-white/10 flex items-center justify-center pointer-events-none transition-opacity">
                <svg className="w-5 h-5 text-white/60" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
              </div>
            )}
            {swipeOffset < -30 && pdfPageNum < pdfTotalPages && (
              <div className="absolute right-3 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-white/10 flex items-center justify-center pointer-events-none transition-opacity">
                <svg className="w-5 h-5 text-white/60" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </div>
            )}
          </>
        )}
      </div>

      {/* ── Bottom control bar ── */}
      <div className="flex-shrink-0 bg-black/80 border-t border-white/[0.08] px-4 py-3">
        <div className="flex items-center justify-center gap-2 sm:gap-3 max-w-[480px] mx-auto">
          {/* Zoom out */}
          <button
            onClick={zoomOut}
            className="w-11 h-11 rounded-full bg-white/[0.07] border border-white/[0.12] flex items-center justify-center text-[#f5f5f7] active:bg-white/[0.14] transition-colors"
            aria-label="Zoom out"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4" />
            </svg>
          </button>

          {/* PDF page navigation */}
          {isPdf && pdfTotalPages > 1 && (
            <>
              <button
                onClick={prevPage}
                disabled={pdfPageNum <= 1}
                className="w-11 h-11 rounded-full bg-white/[0.07] border border-white/[0.12] flex items-center justify-center text-[#f5f5f7] active:bg-white/[0.14] transition-colors disabled:opacity-30"
                aria-label="Previous page"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
              </button>

              {/* Page indicator — tap to jump */}
              <button
                onClick={() => {
                  setPageJumpValue(String(pdfPageNum));
                  setShowPageJump(true);
                }}
                className="h-11 px-3 rounded-full bg-white/[0.07] border border-white/[0.12] flex items-center justify-center active:bg-white/[0.14] transition-colors min-w-[4.5rem]"
                aria-label="Jump to page"
              >
                <span className="text-[13px] text-[#a1a1a6] tabular-nums">
                  {pdfPageNum} / {pdfTotalPages}
                </span>
              </button>

              <button
                onClick={nextPage}
                disabled={pdfPageNum >= pdfTotalPages}
                className="w-11 h-11 rounded-full bg-white/[0.07] border border-white/[0.12] flex items-center justify-center text-[#f5f5f7] active:bg-white/[0.14] transition-colors disabled:opacity-30"
                aria-label="Next page"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </button>
            </>
          )}

          {/* Fit to screen */}
          <button
            onClick={fitToScreen}
            className={`h-11 px-4 rounded-full flex items-center justify-center gap-1.5 text-[13px] font-medium transition-colors active:bg-white/[0.14] ${
              isFitted
                ? "bg-[rgba(48,209,88,0.15)] border border-[#30d158] text-[#30d158]"
                : "bg-white/[0.07] border border-white/[0.12] text-[#f5f5f7]"
            }`}
            aria-label="Fit to screen"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
            </svg>
            Fit
          </button>

          {/* Zoom in */}
          <button
            onClick={zoomIn}
            className="w-11 h-11 rounded-full bg-white/[0.07] border border-white/[0.12] flex items-center justify-center text-[#f5f5f7] active:bg-white/[0.14] transition-colors"
            aria-label="Zoom in"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
          </button>
        </div>

        {/* Swipe hint — shown once for first PDF view */}
        {isPdf && pdfTotalPages > 1 && isFitted && (
          <p className="text-[11px] text-[#6e6e73] text-center mt-2">
            Swipe left/right or double-tap to zoom
          </p>
        )}
      </div>

      {/* ── Page jump overlay ── */}
      {showPageJump && (
        <div
          className="fixed inset-0 z-[110] bg-black/60 flex items-center justify-center"
          onClick={() => setShowPageJump(false)}
        >
          <div
            className="bg-[#1c1c1e] rounded-2xl p-6 w-[280px] border border-white/[0.12]"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="text-[15px] text-[#f5f5f7] font-medium mb-1 text-center">
              Go to Page
            </p>
            <p className="text-[13px] text-[#6e6e73] mb-4 text-center">
              1 – {pdfTotalPages}
            </p>
            <input
              ref={pageJumpInputRef}
              type="number"
              min={1}
              max={pdfTotalPages}
              value={pageJumpValue}
              onChange={(e) => setPageJumpValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handlePageJumpSubmit();
                if (e.key === "Escape") setShowPageJump(false);
              }}
              className="w-full h-12 bg-white/[0.07] border border-white/[0.12] rounded-xl text-center text-[20px] text-[#f5f5f7] tabular-nums outline-none focus:border-[#0a84ff] transition-colors"
              inputMode="numeric"
              pattern="[0-9]*"
            />
            <div className="flex gap-3 mt-4">
              <button
                onClick={() => setShowPageJump(false)}
                className="flex-1 h-11 rounded-xl bg-white/[0.07] text-[#f5f5f7] text-[15px] font-medium active:bg-white/[0.14] transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handlePageJumpSubmit}
                className="flex-1 h-11 rounded-xl bg-[#0a84ff] text-white text-[15px] font-medium active:bg-[#0a84ff]/80 transition-colors"
              >
                Go
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
