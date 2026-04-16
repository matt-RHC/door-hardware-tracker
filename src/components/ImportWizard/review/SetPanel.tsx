"use client";

import type { HardwareSet } from "../types";
import type { ItemConfidence } from "@/lib/types/confidence";
import type { ReconciledHardwareSet } from "@/lib/types/reconciliation";
import { detectIsPair } from "@/lib/parse-pdf-helpers";
import { groupItemsByLeaf } from "@/lib/classify-leaf-items";
import HardwareItemRow, { type HardwareItemRowItem } from "./HardwareItemRow";
import AuditTrailPanel from "./AuditTrailPanel";

interface SetPanelProps {
  hwSet: HardwareSet;
  /** The first door in the group — used for pair detection heuristics. */
  firstDoorInfo?: { door_type?: string; location?: string };
  collapsedLeafSections: Set<string>;
  onToggleLeafSection: (setId: string, section: 'shared' | 'leaf1' | 'leaf2') => void;
  onRevert: (setId: string, itemIdx: number, originalQty: number) => void;
  reconciledSet?: ReconciledHardwareSet;
  auditTrailOpen: boolean;
  onToggleAuditTrail: () => void;
}

export default function SetPanel({
  hwSet,
  firstDoorInfo,
  collapsedLeafSections,
  onToggleLeafSection,
  onRevert,
  reconciledSet,
  auditTrailOpen,
  onToggleAuditTrail,
}: SetPanelProps) {
  if (!hwSet || (hwSet.items?.length ?? 0) === 0) return null;

  const isPairSet = detectIsPair(hwSet, firstDoorInfo);
  const lc = isPairSet ? 2 : 1;

  const items: HardwareItemRowItem[] = (hwSet.items ?? []).map((item, idx) => ({
    id: `${hwSet.set_id}-${idx}`,
    name: item.name,
    qty: item.qty ?? 1,
    manufacturer: item.manufacturer ?? null,
    model: item.model ?? null,
    finish: item.finish ?? null,
    qty_source: item.qty_source ?? null,
    qty_before_correction: item.qty_before_correction ?? null,
    confidence: (item.confidence as ItemConfidence | undefined) ?? null,
    _setId: hwSet.set_id,
    _itemIdx: idx,
  }));

  const grouped = groupItemsByLeaf(items, lc);
  const hasAnyLowConfidence = items.some((i) => i.confidence?.overall === 'low');
  const correctedCount = items.filter(
    (i) => i.qty_source === 'auto_corrected' && i.qty_before_correction != null,
  ).length;

  const renderItems = (arr: HardwareItemRowItem[], leafIdx: number) =>
    arr.map((item) => (
      <HardwareItemRow key={`${item.id}-l${leafIdx}`} item={item} leafIdx={leafIdx} onRevert={onRevert} />
    ));

  return (
    <div className="bg-tint border border-border-dim rounded-lg p-3 mb-2">
      <div className="flex items-center gap-2 mb-2">
        <span
          className="text-[11px] font-semibold uppercase text-secondary"
          style={{ fontFamily: "var(--font-display)", letterSpacing: "0.06em" }}
        >
          Hardware Items
        </span>
        <span className="text-[10px] text-tertiary">
          ({grouped.shared.length + grouped.leaf1.length + grouped.leaf2.length} items)
        </span>
        {correctedCount > 0 && (
          <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded bg-accent-dim text-info border border-info">
            {correctedCount} corrected
          </span>
        )}
        {isPairSet && (
          <span className="text-[9px] font-semibold uppercase px-1.5 py-0.5 rounded bg-accent-dim text-accent border border-accent ml-auto">
            PAIR
          </span>
        )}
        {hasAnyLowConfidence && (
          <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded bg-danger-dim text-danger border border-danger">
            low confidence
          </span>
        )}
      </div>
      {isPairSet ? (
        <div className="space-y-2">
          {grouped.shared.length > 0 && (
            <div>
              <button
                onClick={() => onToggleLeafSection(hwSet.set_id, 'shared')}
                className="flex items-center gap-1 text-[10px] font-semibold uppercase text-tertiary tracking-wider mb-0.5 hover:text-secondary transition-colors"
                style={{ fontFamily: "var(--font-display)" }}
              >
                <span className="text-[8px]">
                  {collapsedLeafSections.has(`${hwSet.set_id}:shared`) ? '\u25B8' : '\u25BE'}
                </span>
                Shared ({grouped.shared.length})
              </button>
              {!collapsedLeafSections.has(`${hwSet.set_id}:shared`) && renderItems(grouped.shared, 1)}
            </div>
          )}
          {grouped.leaf1.length > 0 && (
            <div>
              <button
                onClick={() => onToggleLeafSection(hwSet.set_id, 'leaf1')}
                className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider mb-0.5 hover:text-secondary transition-colors"
                style={{ fontFamily: "var(--font-display)", color: "var(--blue)" }}
              >
                <span className="text-[8px]">
                  {collapsedLeafSections.has(`${hwSet.set_id}:leaf1`) ? '\u25B8' : '\u25BE'}
                </span>
                Leaf 1 - Active ({grouped.leaf1.length})
              </button>
              {!collapsedLeafSections.has(`${hwSet.set_id}:leaf1`) && renderItems(grouped.leaf1, 1)}
            </div>
          )}
          {grouped.leaf2.length > 0 && (
            <div>
              <button
                onClick={() => onToggleLeafSection(hwSet.set_id, 'leaf2')}
                className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider mb-0.5 hover:text-secondary transition-colors"
                style={{ fontFamily: "var(--font-display)", color: "var(--purple)" }}
              >
                <span className="text-[8px]">
                  {collapsedLeafSections.has(`${hwSet.set_id}:leaf2`) ? '\u25B8' : '\u25BE'}
                </span>
                Leaf 2 - Inactive ({grouped.leaf2.length})
              </button>
              {!collapsedLeafSections.has(`${hwSet.set_id}:leaf2`) && renderItems(grouped.leaf2, 2)}
            </div>
          )}
        </div>
      ) : (
        <div>{renderItems(items, 1)}</div>
      )}

      {reconciledSet && (
        <AuditTrailPanel
          reconciledSet={reconciledSet}
          isOpen={auditTrailOpen}
          onToggle={onToggleAuditTrail}
        />
      )}
    </div>
  );
}
