"use client";

import type { DoorEntry, HardwareSet, ClassifyPagesResponse } from "../types";
import type { ReconciledHardwareSet } from "@/lib/types/reconciliation";
import { findPageForSet } from "@/lib/punch-cards";
import PDFPagePreview from "../PDFPagePreview";
import SetPanel from "./SetPanel";

interface DoorDetailPanelProps {
  door: DoorEntry;
  hwSet: HardwareSet | undefined;
  reconciledSet?: ReconciledHardwareSet;
  classifyResult: ClassifyPagesResponse | null;
  pdfBuffer: ArrayBuffer | null;
  onRequestRescan: (setId: string, pageIdx: number) => void;
  /**
   * Request a rescan in field-assignment mode (for filling missing
   * location/hand/fire_rating on this door and optionally its siblings).
   */
  onRequestFieldRescan: (setId: string, pageIdx: number, doorNumber: string) => void;
  onRevert: (setId: string, itemIdx: number, originalQty: number) => void;
  collapsedLeafSections: Set<string>;
  onToggleLeafSection: (setId: string, section: 'shared' | 'leaf1' | 'leaf2') => void;
  auditTrailOpen: boolean;
  onToggleAuditTrail: () => void;
}

export default function DoorDetailPanel({
  door,
  hwSet,
  reconciledSet,
  classifyResult,
  pdfBuffer,
  onRequestRescan,
  onRequestFieldRescan,
  onRevert,
  collapsedLeafSections,
  onToggleLeafSection,
  auditTrailOpen,
  onToggleAuditTrail,
}: DoorDetailPanelProps) {
  if (!hwSet) {
    return (
      <div className="px-3 py-3 bg-tint border-t border-border-dim text-[12px] text-tertiary">
        No hardware set assigned to this door.
      </div>
    );
  }

  const pdfPageIdx =
    classifyResult?.pages && pdfBuffer
      ? (findPageForSet(hwSet.set_id, classifyResult.pages) ??
         (hwSet.generic_set_id
            ? findPageForSet(hwSet.generic_set_id, classifyResult.pages)
            : null))
      : null;

  const firstDoorInfo = { door_type: door.door_type, location: door.location };

  return (
    <div className="px-3 py-3 bg-surface border-t border-border-dim space-y-3">
      {/* Quick field summary */}
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-[11px] text-tertiary">
        {door.door_type && (
          <span>
            <span className="text-secondary">Door type:</span> {door.door_type}
          </span>
        )}
        {door.frame_type && (
          <span>
            <span className="text-secondary">Frame:</span> {door.frame_type}
          </span>
        )}
        {door.hand && (
          <span>
            <span className="text-secondary">Hand:</span> {door.hand}
          </span>
        )}
        {door.fire_rating && (
          <span>
            <span className="text-secondary">Fire rating:</span> {door.fire_rating}
          </span>
        )}
      </div>

      {/* Rescan triggers */}
      {pdfPageIdx != null && pdfBuffer && (
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => onRequestRescan(hwSet.set_id, pdfPageIdx)}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-tint border border-border-dim text-secondary text-[11px] font-medium hover:bg-tint-strong transition-colors min-h-9"
          >
            Re-scan hardware items
          </button>
          <button
            onClick={() => onRequestFieldRescan(hwSet.set_id, pdfPageIdx, door.door_number)}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-accent-dim border border-accent text-accent text-[11px] font-medium hover:bg-tint-strong transition-colors min-h-9"
          >
            Fix missing field (location / hand / rating)
          </button>
          <span className="text-[10px] text-tertiary">from PDF page {pdfPageIdx + 1}</span>
        </div>
      )}

      {/* Hardware items */}
      <SetPanel
        hwSet={hwSet}
        firstDoorInfo={firstDoorInfo}
        collapsedLeafSections={collapsedLeafSections}
        onToggleLeafSection={onToggleLeafSection}
        onRevert={onRevert}
        reconciledSet={reconciledSet}
        auditTrailOpen={auditTrailOpen}
        onToggleAuditTrail={onToggleAuditTrail}
      />

      {/* PDF page thumbnail for context */}
      {pdfPageIdx != null && pdfBuffer && (
        <div className="max-w-full md:max-w-2xl">
          <PDFPagePreview
            pdfBuffer={pdfBuffer}
            pageIndex={pdfPageIdx}
            label={`${hwSet.set_id} — Hardware set definition`}
          />
        </div>
      )}
    </div>
  );
}
