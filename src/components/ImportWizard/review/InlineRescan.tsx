"use client";

import { useCallback, useState } from "react";
import PDFRegionSelector from "../PDFRegionSelector";
import FieldAssignmentPanel from "./FieldAssignmentPanel";
import type { DoorEntry, HardwareSet, ExtractedHardwareItem } from "../types";
import type { RegionExtractField } from "@/lib/schemas/parse-pdf";
import { useToast } from "@/components/ToastProvider";
import { tokenMatchScore } from "./utils";

/**
 * Mode governs what a user's region selection is interpreted as.
 *
 * - `items` (default): legacy — the cropped region is fed through the
 *   hardware-item extractor and the results are merged into the set's item
 *   list. Used when users rescan because item extraction missed rows.
 * - `field`: the cropped region is treated as raw text for a door metadata
 *   field (location / hand / fire_rating). The user then picks the target
 *   field and which doors in the set the value applies to, and Darrin offers
 *   to scan sibling doors for similar values.
 */
export type InlineRescanMode = "items" | "field";

interface InlineRescanProps {
  projectId: string;
  pdfBuffer: ArrayBuffer;
  setId: string;
  pageIndex: number;
  /** Default mode when the modal opens. */
  initialMode?: InlineRescanMode;
  /** The door number that triggered the rescan, if any. Used to preselect
   *  the default target in field mode. */
  triggerDoorNumber?: string;
  /** All doors in the current hardware set, so field mode can offer sibling
   *  checkboxes. */
  doorsInSet: DoorEntry[];
  onClose: () => void;
  onPageChange: (pageIdx: number) => void;
  /**
   * Called with a mutator that takes the current hardware sets and returns
   * updated hardware sets merged with the region-extracted items. The parent
   * updates state.
   */
  onItemsMerged: (updater: (prev: HardwareSet[]) => HardwareSet[]) => void;
  /**
   * Called in field mode when the user confirms the assignment. The parent
   * updates DoorEntry state for the listed doors.
   */
  onFieldApply: (
    field: RegionExtractField,
    value: string,
    doorNumbers: string[],
  ) => void;
}

interface FieldResult {
  rawText: string;
  detectedField: RegionExtractField | "unknown";
  detectedValue: string;
  detectionConfidence: number;
}

export default function InlineRescan({
  projectId,
  pdfBuffer,
  setId,
  pageIndex,
  initialMode = "items",
  triggerDoorNumber,
  doorsInSet,
  onClose,
  onPageChange,
  onItemsMerged,
  onFieldApply,
}: InlineRescanProps) {
  const { showToast } = useToast();
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<InlineRescanMode>(initialMode);
  const [fieldResult, setFieldResult] = useState<FieldResult | null>(null);

  const handleItemsExtract = useCallback(
    async (bbox: { x0: number; y0: number; x1: number; y1: number }) => {
      setLoading(true);
      try {
        const resp = await fetch("/api/parse-pdf/region-extract", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectId, page: pageIndex, bbox, setId, mode: "items" }),
        });
        if (!resp.ok) {
          const errBody = await resp.text().catch(() => "");
          console.error("[region-extract] API error:", resp.status, errBody.slice(0, 300));
          showToast("error", "Region scan failed \u2014 try selecting a larger area");
          return;
        }
        const result = await resp.json();
        const extractedItems: ExtractedHardwareItem[] = result.items ?? [];
        if (extractedItems.length === 0) {
          showToast("error", "No items found in selected region \u2014 try a different area");
          onClose();
          return;
        }

        onItemsMerged((prev) =>
          prev.map((s) => {
            if (s.set_id !== setId) return s;
            const existing = [...s.items];
            const matched = new Set<number>();
            let updatedCount = 0;
            let addedCount = 0;

            for (const ext of extractedItems) {
              const extName = ext?.name || '';
              let bestIdx = -1;
              let bestScore = 0;
              for (let i = 0; i < existing.length; i++) {
                if (matched.has(i)) continue;
                const score = tokenMatchScore(extName, existing[i]?.name || '');
                if (
                  score > bestScore ||
                  (score === bestScore &&
                    bestIdx >= 0 &&
                    (existing[i]?.name || '').length < (existing[bestIdx]?.name || '').length)
                ) {
                  bestScore = score;
                  bestIdx = i;
                }
              }

              if (bestIdx >= 0 && bestScore > 0) {
                matched.add(bestIdx);
                const merged: ExtractedHardwareItem = { ...existing[bestIdx] };
                const mergeFields = ['qty', 'manufacturer', 'model', 'finish'] as const;
                for (const f of mergeFields) {
                  const val = (ext as unknown as Record<string, unknown>)[f];
                  if (val != null && val !== '') {
                    (merged as unknown as Record<string, unknown>)[f] = val;
                  }
                }
                existing[bestIdx] = merged;
                updatedCount++;
              } else {
                existing.push(ext);
                addedCount++;
              }
            }

            const parts: string[] = [];
            if (updatedCount > 0)
              parts.push(`Updated ${updatedCount} item${updatedCount !== 1 ? 's' : ''}`);
            if (addedCount > 0)
              parts.push(`added ${addedCount} new item${addedCount !== 1 ? 's' : ''}`);
            if (parts.length > 0) showToast("success", parts.join(', '));

            return { ...s, items: existing };
          }),
        );

        onClose();
      } catch (err) {
        console.error("[region-extract] Failed:", err);
        showToast("error", "Region scan failed \u2014 try selecting a larger area");
      } finally {
        setLoading(false);
      }
    },
    [projectId, pageIndex, setId, showToast, onClose, onItemsMerged],
  );

  const handleFieldExtract = useCallback(
    async (bbox: { x0: number; y0: number; x1: number; y1: number }) => {
      setLoading(true);
      try {
        const resp = await fetch("/api/parse-pdf/region-extract", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            projectId,
            page: pageIndex,
            bbox,
            setId,
            mode: "field",
            targetDoorNumbers: triggerDoorNumber ? [triggerDoorNumber] : [],
          }),
        });
        if (!resp.ok) {
          const errBody = await resp.text().catch(() => "");
          console.error("[region-extract field] API error:", resp.status, errBody.slice(0, 300));
          showToast("error", "Region scan failed \u2014 try selecting a larger area");
          return;
        }
        const result = await resp.json() as {
          rawText: string;
          detectedField: RegionExtractField | "unknown";
          detectedValue: string;
          detectionConfidence: number;
        };
        if (!result.rawText?.trim()) {
          showToast("error", "No text found in selected region \u2014 try a different area");
          return;
        }
        setFieldResult({
          rawText: result.rawText,
          detectedField: result.detectedField,
          detectedValue: result.detectedValue || result.rawText.trim(),
          detectionConfidence: result.detectionConfidence,
        });
      } catch (err) {
        console.error("[region-extract field] Failed:", err);
        showToast("error", "Region scan failed \u2014 try selecting a larger area");
      } finally {
        setLoading(false);
      }
    },
    [projectId, pageIndex, setId, triggerDoorNumber, showToast],
  );

  const handleRegionExtract = useCallback(
    (bbox: { x0: number; y0: number; x1: number; y1: number }) => {
      if (mode === "field") {
        return handleFieldExtract(bbox);
      }
      return handleItemsExtract(bbox);
    },
    [mode, handleFieldExtract, handleItemsExtract],
  );

  const handleFieldConfirm = useCallback(
    (field: RegionExtractField, value: string, doorNumbers: string[]) => {
      onFieldApply(field, value, doorNumbers);
      showToast(
        "success",
        `Fixed ${field.replace('_', ' ')} for ${doorNumbers.length} door${doorNumbers.length !== 1 ? 's' : ''}`,
      );
      onClose();
    },
    [onFieldApply, showToast, onClose],
  );

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-surface border border-th-border rounded-md p-5 w-full max-w-3xl max-h-[90vh] overflow-y-auto shadow-2xl">
        {fieldResult ? (
          <FieldAssignmentPanel
            rawText={fieldResult.rawText}
            detectedField={fieldResult.detectedField}
            detectedValue={fieldResult.detectedValue}
            detectionConfidence={fieldResult.detectionConfidence}
            doorsInSet={doorsInSet}
            triggerDoorNumber={triggerDoorNumber}
            onConfirm={handleFieldConfirm}
            onCancel={() => setFieldResult(null)}
          />
        ) : (
          <div className="space-y-3">
            <ModeToggle mode={mode} onChange={setMode} />
            <PDFRegionSelector
              pdfBuffer={pdfBuffer}
              pageIndex={pageIndex}
              loading={loading}
              onSelect={handleRegionExtract}
              onCancel={onClose}
              onPageChange={onPageChange}
              onError={(msg) => showToast("error", msg)}
            />
          </div>
        )}
      </div>
    </div>
  );
}

interface ModeToggleProps {
  mode: InlineRescanMode;
  onChange: (mode: InlineRescanMode) => void;
}

function ModeToggle({ mode, onChange }: ModeToggleProps) {
  const baseBtn =
    "px-3 py-1.5 rounded-md text-xs font-medium border transition-colors min-h-11";
  const active = "bg-accent-dim border-accent text-accent";
  const inactive =
    "bg-tint border-border-dim text-secondary hover:border-accent/30";

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="text-[11px] text-tertiary uppercase tracking-wider">
        Scan mode:
      </span>
      <button
        type="button"
        onClick={() => onChange("items")}
        className={`${baseBtn} ${mode === "items" ? active : inactive}`}
      >
        Hardware items
      </button>
      <button
        type="button"
        onClick={() => onChange("field")}
        className={`${baseBtn} ${mode === "field" ? active : inactive}`}
      >
        Door field (location / hand / rating)
      </button>
    </div>
  );
}
