"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { Attachment } from "@/lib/types/database";

interface FileViewerProps {
  attachment: Attachment;
  onClose: () => void;
}

export default function FileViewer({ attachment, onClose }: FileViewerProps) {
  const [scale, setScale] = useState(1);
  const [fitScale, setFitScale] = useState(1);
  const [isFitted, setIsFitted] = useState(true);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [lastPinchDist, setLastPinchDist] = useState(0);
  const [pdfKey, setPdfKey] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  const isPdf = attachment.file_type?.includes("pdf") ||
    attachment.file_name?.toLowerCase().endsWith(".pdf");
  const isImage = attachment.file_type?.startsWith("image/") ||
    /\.(jpg|jpeg|png|gif|webp|bmp|svg)$/i.test(attachment.file_name || "");

  // When an image loads, calculate the scale that fills viewport width
  const handleImageLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    const containerW = containerRef.current?.clientWidth || window.innerWidth;
    const containerH = containerRef.current?.clientHeight || window.innerHeight;
    // Calculate scale to fill width, but don't exceed height
    const scaleW = containerW / img.naturalWidth;
    const scaleH = containerH / img.naturalHeight;
    const computed = Math.min(scaleW, scaleH);
    setFitScale(computed);
    setScale(computed);
  }, []);

  // Reset view to fit screen
  const fitToScreen = useCallback(() => {
    if (isPdf) {
      // Reload iframe with FitH to reset the browser's native PDF zoom
      setPdfKey((k) => k + 1);
    } else {
      setScale(fitScale);
    }
    setPosition({ x: 0, y: 0 });
    setIsFitted(true);
  }, [isPdf, fitScale]);

  // Zoom controls (only for non-PDF content)
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

  // Touch handlers for pinch-to-zoom and pan
  const handleTouchStart = useCallback(
    (e: React.TouchEvent) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        const dist = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY
        );
        setLastPinchDist(dist);
      } else if (e.touches.length === 1 && scale > 1) {
        setIsDragging(true);
        setDragStart({
          x: e.touches[0].clientX - position.x,
          y: e.touches[0].clientY - position.y,
        });
      }
    },
    [scale, position]
  );

  const handleTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        const dist = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY
        );
        if (lastPinchDist > 0) {
          const delta = dist / lastPinchDist;
          setScale((s) => Math.min(Math.max(s * delta, fitScale * 0.5), 5));
          setIsFitted(false);
        }
        setLastPinchDist(dist);
      } else if (e.touches.length === 1 && isDragging && scale > 1) {
        setPosition({
          x: e.touches[0].clientX - dragStart.x,
          y: e.touches[0].clientY - dragStart.y,
        });
      }
    },
    [lastPinchDist, isDragging, dragStart, scale]
  );

  const handleTouchEnd = useCallback(() => {
    setIsDragging(false);
    setLastPinchDist(0);
  }, []);

  // Mouse wheel zoom for desktop (disabled for PDFs — use native scroll)
  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (isPdf) return; // Let PDF iframe handle its own scroll/zoom
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    setScale((s) => {
      const minScale = Math.max(fitScale * 0.5, 0.1);
      const next = Math.min(Math.max(s * delta, minScale), 5);
      if (next <= fitScale) {
        setPosition({ x: 0, y: 0 });
        setIsFitted(true);
        return fitScale;
      } else {
        setIsFitted(false);
      }
      return next;
    });
  }, [isPdf, fitScale]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[100] bg-black/95 backdrop-blur-xl flex flex-col">
      {/* Top bar */}
      <div className="flex-shrink-0 flex items-center justify-between px-4 py-3 bg-black/80 border-b border-white/[0.08]">
        <button
          onClick={onClose}
          className="text-[#0a84ff] text-[15px] font-medium flex items-center gap-1"
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
          className="text-[#0a84ff] text-[13px] font-medium"
        >
          Open
        </a>
      </div>

      {/* Viewer area */}
      <div
        ref={containerRef}
        className="flex-1 overflow-hidden relative"
        {...(!isPdf ? {
          onTouchStart: handleTouchStart,
          onTouchMove: handleTouchMove,
          onTouchEnd: handleTouchEnd,
          onWheel: handleWheel,
          style: { touchAction: "none" },
        } : {})}
      >
        {isPdf ? (
          /* PDF: no CSS transform — let the browser's native PDF viewer handle zoom/scroll */
          <iframe
            key={pdfKey}
            src={`${attachment.file_url}#toolbar=0&navpanes=0&view=FitH`}
            className="w-full h-full border-0"
            title={attachment.file_name || "PDF Document"}
            style={{ background: "#1c1c1e" }}
          />
        ) : (
        <div
          ref={contentRef}
          className="w-full h-full flex items-center justify-center"
          style={{
            transform: `translate(${position.x}px, ${position.y}px) scale(${scale})`,
            transformOrigin: "center center",
            transition: isDragging ? "none" : "transform 0.2s ease-out",
          }}
        >
          {isImage ? (
            <img
              src={attachment.file_url}
              alt={attachment.file_name || "Attachment"}
              className="max-w-full max-h-full object-contain select-none"
              draggable={false}
              onLoad={handleImageLoad}
            />
          ) : (
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
          )}
        </div>
        )}
      </div>

      {/* Bottom control bar */}
      <div className="flex-shrink-0 bg-black/80 border-t border-white/[0.08] px-4 py-3">
        <div className="flex items-center justify-center gap-3 max-w-[430px] mx-auto">
          {!isPdf && (
            <button
              onClick={zoomOut}
              className="w-11 h-11 rounded-full bg-white/[0.07] border border-white/[0.12] flex items-center justify-center text-[#f5f5f7] active:bg-white/[0.14] transition-colors"
              aria-label="Zoom out"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4" />
              </svg>
            </button>
          )}

          <button
            onClick={fitToScreen}
            className={`h-11 px-5 rounded-full flex items-center justify-center gap-2 text-[13px] font-medium transition-colors active:bg-white/[0.14] ${
              isFitted
                ? "bg-[rgba(48,209,88,0.15)] border border-[#30d158] text-[#30d158]"
                : "bg-white/[0.07] border border-white/[0.12] text-[#f5f5f7]"
            }`}
            aria-label="Fit to screen"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
            </svg>
            {isPdf ? "Reset View" : "Fit"}
          </button>

          {!isPdf && (
            <>
              <button
                onClick={zoomIn}
                className="w-11 h-11 rounded-full bg-white/[0.07] border border-white/[0.12] flex items-center justify-center text-[#f5f5f7] active:bg-white/[0.14] transition-colors"
                aria-label="Zoom in"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
              </button>

              <span className="text-[12px] text-[#6e6e73] min-w-[3rem] text-center tabular-nums">
                {Math.round(scale * 100)}%
              </span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
