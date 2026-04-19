"use client";

import type { ClassifyPagesResponse, HardwareSet } from "../types";
import { findPageForSet } from "@/lib/punch-cards";
import PDFPagePreview from "../PDFPagePreview";

interface SourceRailProps {
  /** The hardware-set the rail is currently focused on. Comes from the
   *  parent's view-state (last-expanded door's set in door view, or the
   *  first non-collapsed group in set view). Null = empty state. */
  activeSetId: string | null;
  /** Optional heading line for the active set (e.g. "DH1.01"). */
  activeSetHeading?: string | null;
  /** Active set's door count — surfaces "3 openings" in the rail header. */
  activeSetDoorCount?: number | null;
  pdfBuffer: ArrayBuffer | null;
  classifyResult: ClassifyPagesResponse | null;
  hardwareSets: HardwareSet[];
}

/**
 * Persistent right-side PDF rail for the post-ingest review screen.
 * Shows the source submittal page for whichever hardware set the user
 * is currently focused on, keeping the reference material one glance
 * away rather than forcing an in-row expansion.
 *
 * Page lookup mirrors SetView's existing strategy: first try the exact
 * `set_id`, then fall through to `generic_set_id`. This keeps sub-set
 * variants (e.g. DH4A.0 / DH4A.1) on the right page without the
 * component needing to know about the heading normalization logic.
 *
 * Renders inside a sticky-positioned container set by the parent —
 * the rail itself is a plain column so the parent controls visibility
 * (hidden below `xl` via Tailwind's responsive utilities).
 */
export default function SourceRail({
  activeSetId,
  activeSetHeading,
  activeSetDoorCount,
  pdfBuffer,
  classifyResult,
  hardwareSets,
}: SourceRailProps) {
  const pageIdx =
    activeSetId && classifyResult?.pages && pdfBuffer
      ? findPageForSet(activeSetId, classifyResult.pages) ??
        (() => {
          const set = hardwareSets.find(
            (s) => s.set_id === activeSetId || s.generic_set_id === activeSetId,
          );
          const altId = set?.generic_set_id ?? set?.set_id;
          return altId && altId !== activeSetId
            ? findPageForSet(altId, classifyResult.pages)
            : null;
        })()
      : null;

  return (
    <div className="flex flex-col h-full">
      {/* Rail header — eyebrow + active-set summary.
          Mono identifier ties the rail visually to the chiclet strip
          and group header treatments. */}
      <div className="px-4 py-3 border-b border-th-border bg-surface-raised flex items-center justify-between gap-2 shrink-0">
        <div className="flex flex-col min-w-0">
          <span className="eyebrow">Source · Submittal PDF</span>
          {activeSetId ? (
            <span className="text-[13px] font-mono text-primary truncate mt-0.5">
              {activeSetId}
              {activeSetHeading && (
                <span className="text-tertiary ml-2 font-sans text-[11px]">
                  {activeSetHeading}
                </span>
              )}
            </span>
          ) : (
            <span className="text-[12px] text-tertiary mt-0.5">
              Pick a set to see its page
            </span>
          )}
        </div>
        {activeSetDoorCount != null && activeSetDoorCount > 0 && (
          <span className="text-[11px] font-mono text-tertiary shrink-0">
            {activeSetDoorCount} opening{activeSetDoorCount === 1 ? "" : "s"}
          </span>
        )}
      </div>

      {/* Body: PDF render, or a quiet empty state. The preview manages
          its own lazy render + cache, so re-keying on pageIdx is enough
          to swap the page when the active set changes. */}
      <div className="flex-1 overflow-y-auto p-3">
        {pdfBuffer && pageIdx != null ? (
          <div className="rounded-md border border-border-dim overflow-hidden bg-surface">
            <PDFPagePreview
              key={`rail-${activeSetId}-${pageIdx}`}
              pdfBuffer={pdfBuffer}
              pageIndex={pageIdx}
              label={`Page ${pageIdx + 1}`}
            />
          </div>
        ) : (
          <div className="h-full flex items-center justify-center text-center px-4">
            <p className="text-[12px] text-tertiary max-w-[240px]">
              {!pdfBuffer
                ? "No submittal PDF in this session."
                : !activeSetId
                ? "Expand a door or a set to follow along here."
                : "No source page located for this set."}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
