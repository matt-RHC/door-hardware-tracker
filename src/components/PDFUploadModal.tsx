"use client";

import { useState, useRef, useEffect, ChangeEvent, FormEvent } from "react";

interface PDFUploadModalProps {
  projectId: string;
  onClose: () => void;
  onSuccess: () => void;
}

/* ─── Holographic Loading Overlay ─── */
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
        @keyframes scanLine {
          0% { top: -2px; }
          100% { top: 100%; }
        }
        @keyframes dataScroll {
          0% { transform: translateY(0); }
          100% { transform: translateY(-50%); }
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

        .holo-frame {
          position: relative;
          width: 100%;
          height: 100%;
          animation: holoFloat 3s ease-in-out infinite, holoFlicker 4s ease-in-out infinite;
          border: 1.5px solid rgba(0, 230, 255, 0.4);
          border-radius: 4px;
          background: radial-gradient(ellipse at center, rgba(0, 230, 255, 0.06) 0%, rgba(0, 20, 40, 0.85) 70%);
          overflow: hidden;
          animation: holoFloat 3s ease-in-out infinite, borderPulse 2s ease-in-out infinite;
        }

        .holo-scanlines {
          position: absolute;
          inset: 0;
          background: repeating-linear-gradient(
            0deg,
            transparent,
            transparent 2px,
            rgba(0, 230, 255, 0.03) 2px,
            rgba(0, 230, 255, 0.03) 4px
          );
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
        {/* Scan lines overlay */}
        <div className="holo-scanlines" />

        {/* Moving scan beam */}
        <div className="holo-scan-beam" style={{ top: `${scanY}px` }} />

        {/* Corner brackets */}
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
            {/* Outer ring - dashed */}
            <circle cx="70" cy="70" r="65" fill="none" stroke="rgba(0, 230, 255, 0.2)"
              strokeWidth="1" strokeDasharray="8 4" />
            {/* Progress ring */}
            <circle cx="70" cy="70" r="58" fill="none" stroke="rgba(0, 230, 255, 0.6)"
              strokeWidth="2.5" strokeLinecap="round"
              strokeDasharray={`${(progress / 100) * 364} 364`}
              transform="rotate(-90 70 70)"
              style={{ transition: "stroke-dasharray 0.5s ease-out" }} />
          </svg>

          <svg width="120" height="120" viewBox="0 0 120 120" className="absolute"
            style={{ animation: "ringRotateReverse 12s linear infinite" }}>
            {/* Inner ring - dotted */}
            <circle cx="60" cy="60" r="48" fill="none" stroke="rgba(0, 230, 255, 0.15)"
              strokeWidth="0.5" strokeDasharray="2 6" />
            {/* Tick marks */}
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

          {/* Door icon in center */}
          <svg width="44" height="56" viewBox="0 0 44 56" fill="none" className="relative z-10"
            style={{ filter: "drop-shadow(0 0 6px rgba(0, 230, 255, 0.4))" }}>
            {/* Door frame */}
            <rect x="4" y="2" width="36" height="52" rx="1" stroke="rgba(0, 230, 255, 0.7)"
              strokeWidth="1.5" fill="rgba(0, 230, 255, 0.05)" />
            {/* Door panel */}
            <rect x="10" y="6" width="24" height="44" rx="1" stroke="rgba(0, 230, 255, 0.5)"
              strokeWidth="1" fill="rgba(0, 230, 255, 0.03)" />
            {/* Handle */}
            <circle cx="30" cy="30" r="2" fill="rgba(0, 230, 255, 0.8)" />
            {/* Hinge marks */}
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

        {/* Bottom bar: progress readout */}
        <div className="absolute bottom-3 left-3 right-3">
          <div className="flex justify-between items-center mb-1">
            <span className="holo-text text-[9px] opacity-50">PROGRESS</span>
            <span className="holo-text text-[9px]"
              style={{ animation: "textFlash 2s ease-in-out infinite" }}>
              {progress.toFixed(0)}% [{">".repeat(Math.floor(progress / 10))}{"·".repeat(10 - Math.floor(progress / 10))}]
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

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!file) {
      setError("Please select a file");
      return;
    }

    setLoading(true);
    setError(null);
    setProgress(0);
    setStatus("Starting upload...");

    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("projectId", projectId);

      const response = await fetch("/api/parse-pdf", {
        method: "POST",
        body: formData,
      });

      if (!response.ok && !response.body) {
        throw new Error(`Upload failed (${response.status})`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("No response stream");
      }

      const decoder = new TextDecoder();
      let buffer = "";
      let lastEvent: { progress: number; status: string; error?: string; result?: Record<string, unknown> } | null = null;

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
            if (event.error) {
              setError(event.error);
            }
          } catch {
            // skip malformed lines
          }
        }
      }

      // Process any remaining buffer
      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer);
          lastEvent = event;
          setProgress(event.progress);
          setStatus(event.status);
          if (event.error) {
            setError(event.error);
          }
        } catch {
          // skip
        }
      }

      if (lastEvent?.error) {
        throw new Error(lastEvent.error);
      }

      if (lastEvent?.result?.success) {
        // Brief pause so user sees 100% before closing
        await new Promise((resolve) => setTimeout(resolve, 1500));
        onSuccess();
        onClose();
      } else {
        throw new Error("Upload completed but no success response received");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
      setProgress(0);
      setStatus("");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="relative">
        {/* Holographic loader floats above the modal */}
        {loading && <HoloLoader progress={progress} status={status} />}

        <div className="bg-slate-900 rounded-lg border border-slate-800 p-6 max-w-md w-full"
          style={loading ? {
            borderColor: "rgba(0, 230, 255, 0.2)",
            boxShadow: "0 0 40px rgba(0, 230, 255, 0.08)",
          } : undefined}>
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
                    backgroundColor: progress === 100 ? '#22c55e' : '#3b82f6',
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
    </div>
  );
}
