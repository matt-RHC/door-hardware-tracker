"use client";

import { useState, useRef, useEffect, ChangeEvent, FormEvent } from "react";
import { PDFDocument } from "pdf-lib";
import SubmittalWizard from "./SubmittalWizard";
import ImportReviewTable from "./ImportReviewTable";
import ColumnMapperWizard, { type ColumnMapping, type DetectMappingResponse } from "./ColumnMapperWizard";

/* âââ Holographic Loading Overlay âââ */
function HoloLoader({ progress, status }: { progress: number; status: string }) {
  const [tick, setTick] = useState(0);
  const [glitch, setGlitch] = useState(false);
  const [prevProgress, setPrevProgress] = useState(0);
  const [milestone, setMilestone] = useState<number | null>(null);
  const [particles, setParticles] = useState<Array<{id: number; x: number; y: number; vx: number; vy: number; life: number; size: number; hue: number}>>([]);
  const particleId = useRef(0);

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

  // Ambient floating particles
  useEffect(() => {
    const spawnInterval = setInterval(() => {
      setParticles(prev => {
        const alive = prev.filter(p => p.life > 0).map(p => ({
          ...p,
          x: p.x + p.vx,
          y: p.y + p.vy,
          vy: p.vy - 0.02,
          life: p.life - 1,
        }));
        // Spawn 1-2 ambient particles
        const newP = [];
        if (Math.random() < 0.6) {
          newP.push({
            id: particleId.current++,
            x: Math.random() * 320,
            y: 260 + Math.random() * 20,
            vx: (Math.random() - 0.5) * 0.8,
            vy: -(0.5 + Math.random() * 1.5),
            life: 40 + Math.floor(Math.random() * 30),
            size: 1 + Math.random() * 2,
            hue: 180 + Math.random() * 40,
          });
        }
        return [...alive.slice(-50), ...newP];
      });
    }, 120);
    return () => clearInterval(spawnInterval);
  }, []);

  // Milestone detection + celebration burst
  useEffect(() => {
    const milestones = [25, 50, 75, 100];
    for (const m of milestones) {
      if (prevProgress < m && progress >= m) {
        setMilestone(m);
        // Spawn burst particles — bigger burst for 100%
        const burstCount = m === 100 ? 60 : 20;
        const burstSpeed = m === 100 ? 5 : 3;
        setParticles(prev => {
          const burst = Array.from({ length: burstCount }, (_, i) => {
            const angle = (i / burstCount) * Math.PI * 2 + Math.random() * 0.3;
            const speed = (m === 100 ? 1.5 : 2) + Math.random() * burstSpeed;
            return {
              id: particleId.current++,
              x: 160,
              y: 120,
              vx: Math.cos(angle) * speed,
              vy: Math.sin(angle) * speed,
              life: m === 100 ? 60 + Math.floor(Math.random() * 40) : 30 + Math.floor(Math.random() * 20),
              size: m === 100 ? 2 + Math.random() * 4 : 2 + Math.random() * 3,
              hue: m === 100
                ? [130, 50, 280, 200, 340][Math.floor(Math.random() * 5)] // confetti colors
                : 280 + Math.random() * 60,
            };
          });
          return [...prev, ...burst];
        });
        setTimeout(() => setMilestone(null), 1200);
        break;
      }
    }
    setPrevProgress(progress);
  }, [progress, prevProgress]);

  const dots = ".".repeat((tick % 4));
  const scanY = (tick * 3) % 260;
  const hexChars = "0123456789ABCDEF";
  const randHex = () => Array.from({ length: 4 }, () => hexChars[Math.floor(Math.random() * 16)]).join("");

  // Color evolves with progress: cyan (0%) -> purple (50%) -> green (100%)
  const progressHue = progress < 50
    ? 180 + (progress / 50) * 100 // 180 (cyan) -> 280 (purple)
    : 280 - ((progress - 50) / 50) * 150; // 280 (purple) -> 130 (green)
  const accentColor = `hsl(${progressHue}, 90%, 65%)`;
  const accentGlow = `hsla(${progressHue}, 90%, 65%, 0.5)`;
  const accentDim = `hsla(${progressHue}, 90%, 65%, 0.15)`;

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
        @keyframes glitchShift {
          0% { transform: translate(0, 0) skewX(0deg); }
          20% { transform: translate(-3px, 1px) skewX(-2deg); }
          40% { transform: translate(2px, -1px) skewX(1deg); }
          60% { transform: translate(-1px, 2px) skewX(-1deg); }
          80% { transform: translate(3px, 0px) skewX(2deg); }
          100% { transform: translate(0, 0) skewX(0deg); }
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
        @keyframes textFlash {
          0%, 90%, 100% { opacity: 1; }
          95% { opacity: 0; }
        }
        @keyframes dataScroll {
          0% { transform: translateY(0); }
          100% { transform: translateY(-50%); }
        }
        @keyframes milestonePop {
          0% { transform: scale(1); }
          30% { transform: scale(1.6); }
          60% { transform: scale(0.9); }
          100% { transform: scale(1); }
        }
        @keyframes milestoneRing {
          0% { transform: scale(0.3); opacity: 1; }
          100% { transform: scale(2.5); opacity: 0; }
        }
        @keyframes milestoneFlash {
          0% { opacity: 0.6; }
          100% { opacity: 0; }
        }
        @keyframes shimmer {
          0% { background-position: -200% 0; }
          100% { background-position: 200% 0; }
        }
        @keyframes percentPulse {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.08); }
        }
        .holo-frame {
          position: relative;
          width: 100%;
          height: 100%;
          border: 1.5px solid;
          border-radius: 4px;
          overflow: hidden;
          animation: holoFloat 3s ease-in-out infinite;
        }
        .holo-scanlines {
          position: absolute;
          inset: 0;
          pointer-events: none;
        }
        .holo-scan-beam {
          position: absolute;
          left: 0;
          width: 100%;
          height: 3px;
          filter: blur(1px);
          pointer-events: none;
        }
        .holo-corner {
          position: absolute;
          width: 12px;
          height: 12px;
          animation: cornerBlink 1.5s ease-in-out infinite;
        }
        .holo-corner-tl { top: 4px; left: 4px; border-top: 2px solid; border-left: 2px solid; }
        .holo-corner-tr { top: 4px; right: 4px; border-top: 2px solid; border-right: 2px solid; animation-delay: 0.3s; }
        .holo-corner-bl { bottom: 4px; left: 4px; border-bottom: 2px solid; border-left: 2px solid; animation-delay: 0.6s; }
        .holo-corner-br { bottom: 4px; right: 4px; border-bottom: 2px solid; border-right: 2px solid; animation-delay: 0.9s; }
        .holo-text {
          font-family: 'Courier New', monospace;
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
          line-height: 1.3;
          animation: dataScroll 8s linear infinite;
        }
      `}</style>

      <div className={`holo-frame`}
        style={{
          borderColor: accentDim,
          background: `radial-gradient(ellipse at center, ${accentDim} 0%, rgba(0, 20, 40, 0.85) 70%)`,
          boxShadow: `0 0 20px ${accentDim}, inset 0 0 20px ${accentDim}`,
          ...(glitch ? { animation: "holoFloat 3s ease-in-out infinite, glitchShift 0.1s ease-in-out" } : {}),
        }}
      >
        {/* Particles */}
        <svg className="absolute inset-0 w-full h-full pointer-events-none" style={{ zIndex: 5 }}>
          {particles.map(p => (
            <circle
              key={p.id}
              cx={p.x}
              cy={p.y}
              r={p.size * (p.life / 60)}
              fill={`hsla(${p.hue}, 90%, 70%, ${Math.min(1, p.life / 20)})`}
              style={{ filter: `blur(${p.size > 2.5 ? 1 : 0}px)` }}
            />
          ))}
        </svg>

        {/* Milestone celebration ring */}
        {milestone && (
          <>
            {/* Flash overlay */}
            <div className="absolute inset-0 pointer-events-none" style={{
              zIndex: 20,
              background: milestone === 100
                ? 'radial-gradient(circle at center, rgba(48,209,88,0.5), transparent 70%)'
                : `radial-gradient(circle at center, ${accentGlow}, transparent 70%)`,
              animation: 'milestoneFlash 0.6s ease-out forwards',
            }} />
            {/* Expanding rings */}
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none" style={{ zIndex: 15, marginTop: '-10px' }}>
              <div style={{
                width: 80, height: 80,
                borderRadius: '50%',
                border: `3px solid ${milestone === 100 ? '#30d158' : accentColor}`,
                animation: 'milestoneRing 1s ease-out forwards',
              }} />
              <div style={{
                position: 'absolute',
                width: 60, height: 60,
                borderRadius: '50%',
                border: `2px solid ${milestone === 100 ? '#30d158' : accentColor}`,
                animation: 'milestoneRing 1s ease-out 0.15s forwards',
                opacity: 0.7,
              }} />
              {milestone === 100 && (
                <div style={{
                  position: 'absolute',
                  width: 100, height: 100,
                  borderRadius: '50%',
                  border: `4px solid #30d158`,
                  animation: 'milestoneRing 1.2s ease-out 0.3s forwards',
                  opacity: 0.5,
                }} />
              )}
            </div>
          </>
        )}

        <div className="holo-scanlines" style={{
          background: `repeating-linear-gradient(0deg, transparent, transparent 2px, ${accentDim} 2px, ${accentDim} 4px)`,
        }} />
        <div className="holo-scan-beam" style={{
          top: `${scanY}px`,
          background: `linear-gradient(90deg, transparent, ${accentGlow}, transparent)`,
        }} />

        <div className="holo-corner holo-corner-tl" style={{ borderColor: accentColor }} />
        <div className="holo-corner holo-corner-tr" style={{ borderColor: accentColor }} />
        <div className="holo-corner holo-corner-bl" style={{ borderColor: accentColor }} />
        <div className="holo-corner holo-corner-br" style={{ borderColor: accentColor }} />

        {/* Header */}
        <div className="absolute top-3 left-0 w-full text-center">
          <p className="holo-text text-[10px] uppercase tracking-[0.3em] opacity-60"
            style={{ color: accentColor, textShadow: `0 0 8px ${accentGlow}`, animation: "textFlash 3s ease-in-out infinite" }}>
            // RABBIT HOLE SYSTEMS //
          </p>
        </div>

        {/* Center: Rotating rings + percentage */}
        <div className="absolute inset-0 flex items-center justify-center" style={{ marginTop: "-10px" }}>
          <svg width="140" height="140" viewBox="0 0 140 140" className="absolute"
            style={{ animation: "ringRotate 8s linear infinite", filter: `drop-shadow(0 0 8px ${accentGlow})` }}>
            <circle cx="70" cy="70" r="65" fill="none" stroke={accentDim}
              strokeWidth="1" strokeDasharray="8 4" />
            <circle cx="70" cy="70" r="58" fill="none" stroke={accentColor}
              strokeWidth="2.5" strokeLinecap="round"
              strokeDasharray={`${(progress / 100) * 364} 364`}
              transform="rotate(-90 70 70)"
              style={{ transition: "stroke-dasharray 0.8s ease-out, stroke 1s ease" }} />
            {/* Progress trail glow */}
            <circle cx="70" cy="70" r="58" fill="none" stroke={accentGlow}
              strokeWidth="6" strokeLinecap="round"
              strokeDasharray={`${(progress / 100) * 364} 364`}
              transform="rotate(-90 70 70)"
              style={{ transition: "stroke-dasharray 0.8s ease-out", filter: "blur(3px)" }} />
          </svg>

          <svg width="120" height="120" viewBox="0 0 120 120" className="absolute"
            style={{ animation: "ringRotateReverse 12s linear infinite" }}>
            <circle cx="60" cy="60" r="48" fill="none" stroke={accentDim}
              strokeWidth="0.5" strokeDasharray="2 6" />
            {Array.from({ length: 12 }).map((_, i) => {
              const angle = (i * 30) * Math.PI / 180;
              const x1 = 60 + 42 * Math.cos(angle);
              const y1 = 60 + 42 * Math.sin(angle);
              const x2 = 60 + 46 * Math.cos(angle);
              const y2 = 60 + 46 * Math.sin(angle);
              return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2}
                stroke={accentDim} strokeWidth="1" />;
            })}
          </svg>

          {/* Orbiting energy dots */}
          <svg width="160" height="160" viewBox="0 0 160 160" className="absolute"
            style={{ animation: "ringRotate 4s linear infinite" }}>
            {Array.from({ length: Math.max(1, Math.floor(progress / 12)) }).map((_, i) => {
              const angle = (i * (360 / Math.max(1, Math.floor(progress / 12)))) * Math.PI / 180;
              const r = 68;
              return (
                <circle key={`orb-${i}`}
                  cx={80 + r * Math.cos(angle)}
                  cy={80 + r * Math.sin(angle)}
                  r={2.5}
                  fill={accentColor}
                  style={{ filter: `drop-shadow(0 0 6px ${accentColor})` }}
                />
              );
            })}
          </svg>

          {/* Door icon that opens with progress */}
          <svg width="44" height="52" viewBox="0 0 44 52" fill="none" className="absolute z-10"
            style={{ filter: `drop-shadow(0 0 8px ${accentGlow})`, opacity: progress >= 100 ? 0 : 0.5 }}>
            {/* Frame */}
            <rect x="4" y="2" width="36" height="48" rx="1" stroke={accentColor}
              strokeWidth="1.2" fill="none" opacity={0.4} />
            {/* Door panel - rotates open as progress increases */}
            <g transform={`translate(10, 4)`}>
              <g style={{
                transformOrigin: '0px 22px',
                transform: `perspective(100px) rotateY(${Math.min(60, progress * 0.6)}deg)`,
                transition: 'transform 1s ease-out',
              }}>
                <rect x="0" y="0" width="24" height="44" rx="1" stroke={accentColor}
                  strokeWidth="0.8" fill={`hsla(${progressHue}, 80%, 50%, 0.06)`} />
                {/* Door handle */}
                <circle cx="20" cy="24" r="1.5" fill={accentColor} opacity={0.8} />
              </g>
            </g>
          </svg>

          {/* Big center percentage (overlays door at higher %) */}
          <div className="relative z-20 text-center" style={{
            animation: milestone ? "milestonePop 0.6s ease-out" : "percentPulse 2s ease-in-out infinite",
          }}>
            {progress >= 100 ? (
              <span className="holo-text text-lg font-black uppercase tracking-widest" style={{
                color: '#30d158',
                textShadow: '0 0 20px rgba(48,209,88,0.7), 0 0 40px rgba(48,209,88,0.3)',
                animation: 'milestonePop 0.8s ease-out',
              }}>
                COMPLETE
              </span>
            ) : (
              <>
                <span className="holo-text text-3xl font-black" style={{
                  color: accentColor,
                  textShadow: `0 0 20px ${accentGlow}, 0 0 40px ${accentDim}`,
                }}>
                  {progress.toFixed(0)}
                </span>
                <span className="holo-text text-lg font-bold" style={{
                  color: accentColor,
                  opacity: 0.7,
                }}>%</span>
              </>
            )}
          </div>
        </div>

        {/* Scrolling data column */}
        <div className="holo-data-col">
          <div className="data-stream" style={{ color: `hsla(${progressHue}, 80%, 60%, 0.6)` }}>
            {Array.from({ length: 40 }).map((_, i) => (
              <div key={i}>{randHex()}</div>
            ))}
          </div>
        </div>

        {/* Left data column (mirror) */}
        <div className="holo-data-col" style={{ left: 12, right: 'auto' }}>
          <div className="data-stream" style={{
            color: `hsla(${progressHue}, 80%, 60%, 0.6)`,
            animationDirection: 'reverse',
            animationDuration: '10s',
          }}>
            {Array.from({ length: 40 }).map((_, i) => (
              <div key={i}>{randHex()}</div>
            ))}
          </div>
        </div>

        {/* Status text */}
        <div className="absolute bottom-12 left-0 w-full text-center px-4">
          <p className="holo-text text-xs font-bold tracking-wider" style={{
            color: accentColor,
            textShadow: `0 0 8px ${accentGlow}`,
          }}>
            {status}{dots}
          </p>
        </div>

        {/* Bottom progress bar with shimmer */}
        <div className="absolute bottom-3 left-3 right-3">
          <div className="flex justify-between items-center mb-1">
            <span className="holo-text text-[9px] opacity-50" style={{ color: accentColor }}>PROGRESS</span>
            <span className="holo-text text-[9px]" style={{
              color: accentColor,
              animation: "textFlash 2s ease-in-out infinite",
            }}>
              [{"\u25A0".repeat(Math.floor(progress / 10))}{"\u25A1".repeat(10 - Math.floor(progress / 10))}]
            </span>
          </div>
          <div className="w-full h-[4px] rounded-full overflow-hidden" style={{ background: accentDim }}>
            <div className="h-full rounded-full transition-all duration-700 ease-out relative"
              style={{
                width: `${progress}%`,
                background: `linear-gradient(90deg, ${accentDim}, ${accentColor})`,
                boxShadow: `0 0 12px ${accentGlow}, 0 0 4px ${accentColor}`,
              }}>
              {/* Shimmer overlay */}
              <div className="absolute inset-0 rounded-full" style={{
                background: `linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.3) 50%, transparent 100%)`,
                backgroundSize: '200% 100%',
                animation: 'shimmer 2s linear infinite',
              }} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// --- Types ---

interface HardwareItem {
  qty: number;
  qty_total?: number;
  qty_door_count?: number;
  qty_source?: string;
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

interface FlaggedDoor {
  door: DoorEntry;
  reason: string;
  pattern: string;
  dominant_pattern: string;
}

interface ChunkResult {
  chunkIndex: number;
  hardwareSets: HardwareSet[];
  doors: DoorEntry[];
  flaggedDoors?: FlaggedDoor[];
}

// --- Constants ---

/**
 * Page threshold for FRESH uploads only. PDFs at or below this count use the
 * original single-request streaming flow (/api/parse-pdf). Re-uploads always
 * use chunked processing regardless of page count (see handleSubmit).
 */
const CHUNK_THRESHOLD = 45;

/** Fallback max pages per chunk if classifier fails */
const FALLBACK_PAGES_PER_CHUNK = 35;

// --- Types ---

interface PageClassification {
  index: number;
  type: string;
  confidence: number;
  section_labels: string[];
  hw_set_ids: string[];
  has_door_numbers: boolean;
  word_count: number;
}

interface SmartChunk {
  pages: number[];
  start_page: number;
  end_page: number;
  page_count: number;
  types: string[];
  labels: string[];
  hw_set_ids: string[];
}

interface ClassifyPagesResponse {
  success: boolean;
  total_pages: number;
  page_classifications: PageClassification[];
  chunks: SmartChunk[];
  reference_pages: number[];
  summary: {
    door_schedule_pages: number;
    hardware_set_pages: number;
    reference_pages: number;
    cover_pages: number;
    other_pages: number;
    chunk_count: number;
  };
  error?: string;
}

// --- Helpers ---

/**
 * Call the page classifier to get smart chunk boundaries.
 * Returns null if classification fails (caller should fall back to fixed splitting).
 */
async function classifyPages(pdfBase64: string): Promise<ClassifyPagesResponse | null> {
  try {
    const resp = await fetch("/api/classify-pages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pdfBase64 }),
    });
    if (!resp.ok) return null;
    const data: ClassifyPagesResponse = await resp.json();
    if (!data.success || !data.chunks?.length) return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * Split a PDF into chunks by specific page indices.
 * Each chunk is a base64-encoded PDF containing only the specified pages.
 * Optionally prepends reference pages to each chunk for context.
 */
async function splitPDFByPages(
  buffer: ArrayBuffer,
  chunkPageSets: number[][],
  referencePageIndices: number[] = []
): Promise<string[]> {
  const srcDoc = await PDFDocument.load(buffer);
  const chunks: string[] = [];

  for (const pageIndices of chunkPageSets) {
    const chunkDoc = await PDFDocument.create();

    // Prepend reference pages for context (if any)
    if (referencePageIndices.length > 0) {
      const refPages = await chunkDoc.copyPages(srcDoc, referencePageIndices);
      for (const page of refPages) {
        chunkDoc.addPage(page);
      }
    }

    // Add the actual content pages
    const contentPages = await chunkDoc.copyPages(srcDoc, pageIndices);
    for (const page of contentPages) {
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

/** Fallback: Split a PDF ArrayBuffer into fixed-size chunks (legacy behavior) */
async function splitPDFFixed(buffer: ArrayBuffer, pagesPerChunk: number): Promise<string[]> {
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

// --- Hardware item dedup helpers (Level 2: cross-chunk, Level 3: pre-save) ---

const NAME_ABBREVIATIONS: Record<string, string> = {
  'cont.': 'continuous', 'cont': 'continuous',
  'flr': 'floor', 'flr.': 'floor',
  'w/': 'with ', 'w/o': 'without',
  'mtd': 'mounted', 'mtd.': 'mounted',
  'hd': 'heavy duty', 'hd.': 'heavy duty',
  'adj': 'adjustable', 'adj.': 'adjustable',
  'auto': 'automatic', 'auto.': 'automatic',
  'elec': 'electric', 'elec.': 'electric',
  'mag': 'magnetic', 'mag.': 'magnetic',
  'mech': 'mechanical', 'mech.': 'mechanical',
  'ss': 'stainless steel',
  'alum': 'aluminum', 'alum.': 'aluminum',
  'brz': 'bronze', 'brz.': 'bronze',
  'sfc': 'surface', 'sfc.': 'surface',
  'conc': 'concealed', 'conc.': 'concealed',
  'ovhd': 'overhead', 'ovhd.': 'overhead',
  'thresh': 'threshold', 'thresh.': 'threshold',
};

function normalizeItemName(name: string): string {
  let n = name.toLowerCase().trim();
  for (const [abbr, full] of Object.entries(NAME_ABBREVIATIONS)) {
    const escaped = abbr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    n = n.replace(new RegExp(`\\b${escaped}\\b`, 'g'), full);
    if (abbr === 'w/') n = n.replace(/\bw\//g, 'with ');
  }
  return n.replace(/[()]/g, '').replace(/\s+/g, ' ').replace(/[,;.]+$/, '').trim();
}

function hardwareItemDedupKey(item: HardwareItem): string {
  const model = (item.model || '').trim().toLowerCase();
  if (model) return `model:${model}`;
  return `name:${normalizeItemName(item.name)}`;
}

/** Deduplicate hardware items, keeping the version with more complete data */
function deduplicateHardwareItems(items: HardwareItem[]): HardwareItem[] {
  const seen = new Map<string, HardwareItem>();
  for (const item of items) {
    const key = hardwareItemDedupKey(item);
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, item);
    } else {
      // Keep the version with more populated fields
      const existingScore = [existing.name, existing.model, existing.manufacturer, existing.finish].filter(Boolean).length;
      const newScore = [item.name, item.model, item.manufacturer, item.finish].filter(Boolean).length;
      if (newScore > existingScore) seen.set(key, item);
    }
  }
  return Array.from(seen.values());
}

/** Deduplicate hardware sets by set_id, merge items across chunks, then dedup items */
function mergeHardwareSets(allSets: HardwareSet[]): HardwareSet[] {
  const map = new Map<string, HardwareSet>();
  for (const set of allSets) {
    const existing = map.get(set.set_id);
    if (!existing) {
      map.set(set.set_id, { ...set, items: [...set.items] });
    } else {
      // Merge items from both versions, then dedup below
      existing.items.push(...set.items);
      // Keep the longer heading if available
      if (set.heading && (!existing.heading || set.heading.length > existing.heading.length)) {
        existing.heading = set.heading;
      }
    }
  }
  // Dedup items within each merged set
  for (const set of map.values()) {
    set.items = deduplicateHardwareItems(set.items);
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
    flaggedDoors?: FlaggedDoor[];
  } | null>(null);

  // Column mapper: shown between classification and extraction
  const [mapperData, setMapperData] = useState<DetectMappingResponse | null>(null);
  const [confirmedMapping, setConfirmedMapping] = useState<ColumnMapping | null>(null);
  const mapperDoneRef = useRef(false); // true after user confirms or skips
  // Store buffer/pageCount/parseOnly so we can resume after mapping confirmation
  const pendingUploadRef = useRef<{
    buffer: ArrayBuffer;
    pageCount: number;
    parseOnly: boolean;
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
  // LARGE PDF: Smart chunked multi-request flow
  // Uses page classifier for semantic boundaries (falls back to fixed splitting)
  // Returns parsed data if parseOnly=true, otherwise saves to DB
  // ==========================================
  const processLargePDF = async (
    buffer: ArrayBuffer,
    pageCount: number,
    parseOnly = false
  ): Promise<{ doors: DoorEntry[]; sets: HardwareSet[]; flaggedDoors?: FlaggedDoor[] } | void> => {
    // Convert buffer to base64 (needed by both paths)
    const fullBase64 = btoa(
      new Uint8Array(buffer).reduce((data, byte) => data + String.fromCharCode(byte), "")
    );

    // ── Primary path: full pdfplumber + LLM review pipeline ──
    // Sends entire PDF to the server-side Python pipeline (pdfplumber extracts
    // tables deterministically across all pages, then Claude reviews).
    // This avoids chunking boundary issues where tables span chunk edges.
    // Falls back to chunked path only if this fails (e.g., timeout on huge PDFs).
    {
      setStatus(`Analyzing ${pageCount > 0 ? `${pageCount}-page ` : ""}PDF with full pipeline...`);
      setProgress(5);

      // Show column mapper first if needed
      if (!mapperDoneRef.current) {
        setStatus("Detecting column layout...");
        try {
          const detectResp = await fetch("/api/detect-mapping", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ pdf_base64: fullBase64, page_index: 0 }),
          });
          if (detectResp.ok) {
            const detectResult: DetectMappingResponse = await detectResp.json();
            if (detectResult.success && detectResult.headers.length > 0) {
              pendingUploadRef.current = { buffer, pageCount, parseOnly };
              setMapperData(detectResult);
              setLoading(false);
              return;
            }
          }
        } catch (err) {
          console.warn("Column detection failed, proceeding with auto-detect:", err);
        }
      }

      setStatus("Extracting tables and running AI review...");
      setProgress(15);

      try {
        const resp = await fetch("/api/parse-pdf?parseOnly=true", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            pdfBase64: fullBase64,
            userColumnMapping: confirmedMapping || null,
          }),
        });

        if (resp.ok) {
          const result = await resp.json();
          if (result.doors?.length > 0 || result.sets?.length > 0) {
            setProgress(95);
            setStatus("Deduplicating hardware items...");
            // Apply the same dedup that the chunked path uses
            const dedupedSets = mergeHardwareSets(result.sets || []);
            setProgress(100);
            setStatus(
              `Parsed ${dedupedSets.length} hardware sets, ${result.doors?.length || 0} doors. Ready for review.`
            );
            return {
              doors: result.doors || [],
              sets: dedupedSets,
              flaggedDoors: result.flaggedDoors || [],
            };
          }
          // If pdfplumber returned zero results, report clearly instead of
          // silently falling back to a chunk path that loses data
          console.warn("Full pipeline returned zero results");
          setError("PDF extraction found no doors or hardware sets. The PDF format may not be supported. Try re-uploading or contact support.");
          return;
        } else {
          const errBody = await resp.json().catch(() => ({}));
          console.error("Full pipeline failed:", errBody.error);
          setError(`PDF extraction failed: ${errBody.error || resp.statusText}. Try re-uploading.`);
          return;
        }
      } catch (err) {
        console.error("Full pipeline error:", err);
        setError(`PDF extraction error: ${err instanceof Error ? err.message : "Unknown error"}. Try re-uploading.`);
        return;
      }
    }

    // ── Fallback: Smart chunked multi-request flow ──
    // DEPRECATED: Kept only as emergency fallback. Should not be reached
    // since the full pipeline above handles all PDFs regardless of size.
    // If we get here, something unexpected happened.
    console.warn("Reached chunked fallback — this should not happen with the full pipeline");
    // Phase 1: Classify pages and find smart boundaries
    setStatus(`Analyzing ${pageCount}-page PDF structure...`);
    setProgress(2);

    const classification = await classifyPages(fullBase64);

    let chunks: string[];
    let chunkLabels: string[] = []; // human-readable labels for each chunk

    if (classification && classification.chunks.length > 0) {
      // Smart chunking: use semantic boundaries
      const { chunks: smartChunks, reference_pages: refPages, summary } = classification;

      setStatus(
        `Found ${summary.door_schedule_pages} schedule pages, ` +
        `${summary.hardware_set_pages} hardware pages, ` +
        `${summary.reference_pages} reference pages. ` +
        `Splitting into ${summary.chunk_count} smart chunks...`
      );
      setProgress(3);

      const chunkPageSets = smartChunks.map((c) => c.pages);
      chunks = await splitPDFByPages(buffer, chunkPageSets, refPages);

      // Build labels for progress display
      chunkLabels = smartChunks.map((c) => {
        const types = c.types.join("+");
        const sets = c.hw_set_ids.length > 0 ? ` (${c.hw_set_ids.join(", ")})` : "";
        return `${types}${sets} [pp ${c.start_page + 1}-${c.end_page + 1}]`;
      });

      // ── Column Mapper Step ──
      // If user hasn't seen the mapper yet, detect columns from first door_schedule
      // chunk and pause for user confirmation
      if (!mapperDoneRef.current) {
        const doorChunkIdx = smartChunks.findIndex((c) =>
          c.types.includes("door_schedule")
        );
        const sampleChunkBase64 = chunks[doorChunkIdx >= 0 ? doorChunkIdx : 0];

        if (sampleChunkBase64) {
          setStatus("Detecting column layout...");
          try {
            const detectResp = await fetch("/api/detect-mapping", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ pdf_base64: sampleChunkBase64, page_index: 0 }),
            });
            if (detectResp.ok) {
              const detectResult: DetectMappingResponse = await detectResp.json();
              if (detectResult.success && detectResult.headers.length > 0) {
                // Pause: show the column mapper wizard
                pendingUploadRef.current = { buffer, pageCount, parseOnly };
                setMapperData(detectResult);
                setLoading(false);
                return; // Will resume when user confirms mapping
              }
            }
          } catch (err) {
            console.warn("Column detection failed, proceeding with auto-detect:", err);
          }
        }
      }
    } else {
      // Fallback: fixed splitting (legacy behavior)
      setStatus(`Splitting ${pageCount}-page PDF into chunks...`);
      setProgress(3);
      chunks = await splitPDFFixed(buffer, FALLBACK_PAGES_PER_CHUNK);
      chunkLabels = chunks.map((_, i) => `pages ${i * FALLBACK_PAGES_PER_CHUNK + 1}-${Math.min((i + 1) * FALLBACK_PAGES_PER_CHUNK, pageCount)}`);
    }

    // ── Use confirmed mapping for extraction ──
    const userMapping = confirmedMapping || null;

    const totalChunks = chunks.length;

    setStatus(`Split into ${totalChunks} chunks. Starting analysis...`);
    setProgress(5);

    const allHardwareSets: HardwareSet[] = [];
    const allDoors: DoorEntry[] = [];
    const allFlaggedDoors: FlaggedDoor[] = [];
    const knownSetIds: string[] = [];

    for (let i = 0; i < totalChunks; i++) {
      const chunkStartPct = Math.round(5 + (i / totalChunks) * 75);
      const chunkEndPct = Math.round(5 + ((i + 1) / totalChunks) * 75);

      const label = chunkLabels[i] || `chunk ${i + 1}`;
      setStatus(`Processing chunk ${i + 1}/${totalChunks}: ${label}...`);
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
          body: JSON.stringify({
            chunkBase64: chunks[i],
            chunkIndex: i,
            totalChunks,
            knownSetIds,
            userColumnMapping: userMapping,
          }),
        });

        if (!resp.ok) {
          const errBody = await resp.json().catch(() => ({}));
          throw new Error(errBody.error || `Chunk ${i + 1} failed (${resp.status})`);
        }

        const result: ChunkResult = await resp.json();
        allHardwareSets.push(...result.hardwareSets);
        allDoors.push(...result.doors);
        if (result.flaggedDoors) allFlaggedDoors.push(...result.flaggedDoors);

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

    if (mergedDoors.length === 0 && allFlaggedDoors.length === 0) {
      throw new Error("No doors found across all chunks. The PDF may not contain a door schedule.");
    }

    if (mergedDoors.length === 0 && allFlaggedDoors.length > 0) {
      // All doors were flagged as pattern outliers — still surface them for review
      // rather than failing with "no doors found"
      setStatus(`All ${allFlaggedDoors.length} doors flagged for pattern review.`);
    }

    // Parse-only mode: return data for wizard
    if (parseOnly) {
      setProgress(100);
      const flagNote = allFlaggedDoors.length > 0
        ? ` (${allFlaggedDoors.length} flagged for review)`
        : "";
      setStatus(`Parsed ${mergedSets.length} hardware sets, ${mergedDoors.length} doors${flagNote}. Ready for review.`);
      return { doors: mergedDoors, sets: mergedSets, flaggedDoors: allFlaggedDoors };
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
        // âââ WIZARD MODE: parse only, then show comparison wizard âââ
        // Small PDFs use full pdfplumber+LLM pipeline (inside processLargePDF).
        // Large PDFs use smart chunking with per-chunk Claude extraction.
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
        setReviewData({
          doors: freshResult.doors,
          sets: freshResult.sets,
          flaggedDoors: freshResult.flaggedDoors,
        });
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

  // ─── Column Mapper: shown after classification, before extraction ───
  if (mapperData) {
    return (
      <div className="fixed inset-0 bg-black/80 backdrop-blur-lg flex items-center justify-center z-50 p-4">
        <div className="bg-[#1c1c1e] rounded-2xl border border-white/[0.08] p-6 max-w-4xl w-full max-h-[90vh] overflow-y-auto relative">
          <ColumnMapperWizard
            data={mapperData}
            onConfirm={(mapping) => {
              setConfirmedMapping(mapping);
              setMapperData(null);
              mapperDoneRef.current = true;
              // Resume the upload with confirmed mapping
              const pending = pendingUploadRef.current;
              if (pending) {
                pendingUploadRef.current = null;
                setLoading(true);
                setError(null);
                processLargePDF(pending.buffer, pending.pageCount, pending.parseOnly)
                  .catch((err) => setError(err instanceof Error ? err.message : "Upload failed"))
                  .finally(() => setLoading(false));
              }
            }}
            onSkip={() => {
              setConfirmedMapping(null);
              setMapperData(null);
              mapperDoneRef.current = true;
              // Resume without confirmed mapping (auto-detect per chunk)
              const pending = pendingUploadRef.current;
              if (pending) {
                pendingUploadRef.current = null;
                setLoading(true);
                setError(null);
                processLargePDF(pending.buffer, pending.pageCount, pending.parseOnly)
                  .catch((err) => setError(err instanceof Error ? err.message : "Upload failed"))
                  .finally(() => setLoading(false));
              }
            }}
          />
        </div>
      </div>
    );
  }

  // If review data is ready (fresh upload), show the editable review table
  if (reviewData) {
    return (
      <ImportReviewTable
        projectId={projectId}
        doors={reviewData.doors}
        sets={reviewData.sets}
        flaggedDoors={reviewData.flaggedDoors}
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
