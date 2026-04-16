"use client";

import { useCallback, useState } from "react";
import PDFRegionSelector from "../PDFRegionSelector";
import type { HardwareSet, ExtractedHardwareItem } from "../types";
import { useToast } from "@/components/ToastProvider";
import { tokenMatchScore } from "./utils";

interface InlineRescanProps {
  projectId: string;
  pdfBuffer: ArrayBuffer;
  setId: string;
  pageIndex: number;
  onClose: () => void;
  onPageChange: (pageIdx: number) => void;
  /**
   * Called with a mutator that takes the current hardware sets and returns
   * updated hardware sets merged with the region-extracted items. The parent
   * updates state.
   */
  onItemsMerged: (updater: (prev: HardwareSet[]) => HardwareSet[]) => void;
}

export default function InlineRescan({
  projectId,
  pdfBuffer,
  setId,
  pageIndex,
  onClose,
  onPageChange,
  onItemsMerged,
}: InlineRescanProps) {
  const { showToast } = useToast();
  const [loading, setLoading] = useState(false);

  const handleRegionExtract = useCallback(
    async (bbox: { x0: number; y0: number; x1: number; y1: number }) => {
      setLoading(true);
      try {
        const resp = await fetch("/api/parse-pdf/region-extract", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectId, page: pageIndex, bbox, setId }),
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

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-surface border border-th-border rounded-md p-5 w-full max-w-3xl max-h-[90vh] overflow-y-auto shadow-2xl">
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
    </div>
  );
}
