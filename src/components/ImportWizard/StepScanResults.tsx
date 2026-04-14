"use client";

import type { ClassifyPagesResponse } from "./types";
import WizardNav from "./WizardNav";

interface StepScanResultsProps {
  classifyResult: ClassifyPagesResponse;
  onNext: () => void;
  onBack: () => void;
}

/** Friendly labels and colors for each page type. */
const PAGE_TYPE_CONFIG: Record<string, { label: string; color: string; bg: string }> = {
  door_schedule: { label: "Door Schedule", color: "var(--green)", bg: "var(--green-dim)" },
  hardware_set: { label: "Hardware Set", color: "var(--orange)", bg: "var(--orange-dim)" },
  reference:    { label: "Reference / Cut Sheet", color: "var(--purple)", bg: "var(--purple-dim)" },
  cover:        { label: "Cover / TOC", color: "var(--text-tertiary)", bg: "var(--tint)" },
  other:        { label: "Other", color: "var(--text-tertiary)", bg: "var(--tint)" },
};

/** Collapse consecutive page numbers into "3-7" style range strings. */
function collapseRanges(pages: number[]): string {
  if (pages.length === 0) return "—";
  const sorted = [...pages].sort((a, b) => a - b);
  const ranges: string[] = [];
  let start = sorted[0];
  let end = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === end + 1) {
      end = sorted[i];
    } else {
      ranges.push(start === end ? `${start + 1}` : `${start + 1}–${end + 1}`);
      start = sorted[i];
      end = sorted[i];
    }
  }
  ranges.push(start === end ? `${start + 1}` : `${start + 1}–${end + 1}`);
  return ranges.join(", ");
}

export default function StepScanResults({
  classifyResult,
  onNext,
  onBack,
}: StepScanResultsProps) {
  const { summary, pages, profile, extraction_strategy } = classifyResult;

  // Group pages by type for the detailed breakdown
  const groups: Record<string, typeof pages> = {};
  for (const p of pages) {
    const t = p.page_type;
    if (!groups[t]) groups[t] = [];
    groups[t].push(p);
  }

  // Collect unique hardware set IDs across all pages
  const allSetIds: string[] = [];
  for (const p of pages ?? []) {
    for (const sid of p.hw_set_ids ?? []) {
      if (!allSetIds.includes(sid)) allSetIds.push(sid);
    }
  }

  // Display order
  const typeOrder = ["door_schedule", "hardware_set", "reference", "cover", "other"];

  return (
    <div className="max-w-2xl mx-auto">
      <h3
        className="text-[11px] font-semibold uppercase text-secondary tracking-wider"
        style={{ fontFamily: "var(--font-display)" }}
      >
        Scan Results
      </h3>
      <p className="text-sm text-tertiary mt-1 mb-4">
        Review what we found in your PDF before continuing.
      </p>

      {/* ── Summary cards ── */}
      <div className="grid grid-cols-3 gap-2 mb-4">
        <div className="bg-tint border border-border-dim rounded-md p-3 text-center">
          <div className="text-lg font-bold text-accent">
            {summary.total_pages}
          </div>
          <div className="text-[9px] text-tertiary uppercase tracking-wide">
            Total Pages
          </div>
        </div>
        <div className="bg-tint border border-border-dim rounded-md p-3 text-center">
          <div className="text-lg font-bold text-success">
            {(summary.door_schedule_pages ?? []).length}
          </div>
          <div className="text-[9px] text-tertiary uppercase tracking-wide">
            Door Schedule
          </div>
        </div>
        <div className="bg-tint border border-border-dim rounded-md p-3 text-center">
          <div className="text-lg font-bold text-warning">
            {allSetIds.length > 0 ? allSetIds.length : (summary.hardware_set_pages ?? []).length}
          </div>
          <div className="text-[9px] text-tertiary uppercase tracking-wide">
            {allSetIds.length > 0 ? "Hardware Sets" : "HW Set Pages"}
          </div>
        </div>
      </div>

      {/* ── Document profile (if detected) ── */}
      {profile && (
        <div className="bg-tint border border-border-dim rounded-md p-3 mb-4">
          <div className="text-[10px] text-tertiary uppercase tracking-wide mb-2 font-semibold">
            Document Profile
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
            {profile.source && profile.source !== "unknown" && (
              <>
                <span className="text-secondary">Source</span>
                <span className="text-primary capitalize">{profile.source}</span>
              </>
            )}
            {profile.heading_format && profile.heading_format !== "unknown" && (
              <>
                <span className="text-secondary">Format</span>
                <span className="text-primary capitalize">{profile.heading_format.replace(/_/g, " ")}</span>
              </>
            )}
            {profile.table_strategy && profile.table_strategy !== "unknown" && (
              <>
                <span className="text-secondary">Table Type</span>
                <span className="text-primary capitalize">{profile.table_strategy === "lines" ? "Ruled lines" : "Text-aligned"}</span>
              </>
            )}
            {extraction_strategy && (
              <>
                <span className="text-secondary">Extraction</span>
                <span className="text-primary capitalize">{extraction_strategy.replace(/_/g, " ")}</span>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── Scanned page warning ── */}
      {(summary.scanned_pages ?? 0) > 0 && (
        <div className="bg-danger-dim border border-danger rounded-md p-3 mb-4 text-xs text-danger">
          {summary.scanned_pages} scanned page{(summary.scanned_pages ?? 0) > 1 ? "s" : ""} detected — text extraction may be limited on these pages.
        </div>
      )}

      {/* ── Page classification breakdown ── */}
      <div className="bg-tint border border-border-dim rounded-md p-3 mb-4">
        <div className="text-[10px] text-tertiary uppercase tracking-wide mb-3 font-semibold">
          Page Classification
        </div>
        <div className="space-y-2">
          {typeOrder.map((type) => {
            const cfg = PAGE_TYPE_CONFIG[type] ?? PAGE_TYPE_CONFIG.other;
            const pagesInGroup = groups[type] ?? [];
            if (pagesInGroup.length === 0) return null;

            const pageNumbers = pagesInGroup.map((p) => p.page_number);
            const rangeStr = collapseRanges(pageNumbers);

            // Collect set IDs for hardware_set pages
            const setIds: string[] = [];
            if (type === "hardware_set") {
              for (const p of pagesInGroup) {
                for (const sid of p.hw_set_ids ?? []) {
                  if (!setIds.includes(sid)) setIds.push(sid);
                }
              }
            }

            // Collect section labels for reference pages
            const labels: string[] = [];
            if (type === "reference") {
              for (const p of pagesInGroup) {
                for (const lbl of p.section_labels ?? []) {
                  if (!labels.includes(lbl)) labels.push(lbl);
                }
              }
            }

            return (
              <div
                key={type}
                className="rounded-lg p-2.5"
                style={{ backgroundColor: cfg.bg }}
              >
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-2">
                    <div
                      className="w-2 h-2 rounded-full"
                      style={{ backgroundColor: cfg.color }}
                    />
                    <span className="text-xs font-medium" style={{ color: cfg.color }}>
                      {cfg.label}
                    </span>
                  </div>
                  <span className="text-xs text-tertiary">
                    {pagesInGroup.length} page{pagesInGroup.length !== 1 ? "s" : ""}
                  </span>
                </div>
                <div className="text-[11px] text-secondary ml-4">
                  Pages {rangeStr}
                </div>
                {setIds.length > 0 && (
                  <div className="text-[10px] text-secondary/70 ml-4 mt-0.5">
                    Sets: {setIds.join(", ")}
                  </div>
                )}
                {labels.length > 0 && (
                  <div className="text-[10px] text-secondary/70 ml-4 mt-0.5">
                    {labels.join(", ")}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Navigation ── */}
      <WizardNav onBack={onBack} onNext={onNext} nextLabel="Next" />
    </div>
  );
}
