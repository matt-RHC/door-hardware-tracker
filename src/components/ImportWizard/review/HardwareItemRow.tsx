"use client";

import ConfidenceBadge from "../ConfidenceBadge";
import { getLeafDisplayQty } from "@/lib/classify-leaf-items";
import type { ItemConfidence } from "@/lib/types/confidence";

export interface HardwareItemRowItem {
  id: string;
  name: string;
  qty: number;
  manufacturer: string | null;
  model: string | null;
  finish: string | null;
  qty_source: string | null;
  qty_before_correction: number | null;
  confidence: ItemConfidence | null;
  _setId: string;
  _itemIdx: number;
}

interface HardwareItemRowProps {
  item: HardwareItemRowItem;
  leafIdx: number;
  onRevert: (setId: string, itemIdx: number, originalQty: number) => void;
}

export default function HardwareItemRow({ item, leafIdx, onRevert }: HardwareItemRowProps) {
  const dq = getLeafDisplayQty(item);
  const isCorrected =
    item.qty_source === 'auto_corrected' && item.qty_before_correction != null;
  const conf = item.confidence;

  return (
    <div
      key={`${item.id}-l${leafIdx}`}
      className={`flex items-center gap-3 py-1 text-[12px] ${
        isCorrected ? 'bg-accent-dim rounded px-1 -mx-1' : ''
      }`}
    >
      <span className="text-primary font-medium truncate inline-flex items-center">
        {item.name}
        {conf && <ConfidenceBadge level={conf.name.level} tooltip={conf.name.reason} />}
      </span>
      <span
        className={`text-[11px] shrink-0 inline-flex items-center tabular-nums ${
          isCorrected ? 'text-info font-bold' : 'text-accent'
        }`}
      >
        qty {dq}
        {conf && <ConfidenceBadge level={conf.qty.level} tooltip={conf.qty.reason} />}
        {isCorrected && (
          <span className="text-tertiary font-normal ml-1">
            (was {item.qty_before_correction})
          </span>
        )}
      </span>
      {isCorrected && (
        <button
          onClick={() => onRevert(item._setId, item._itemIdx, item.qty_before_correction!)}
          className="text-[10px] text-warning hover:text-danger shrink-0 underline"
        >
          revert
        </button>
      )}
      {item.model && (
        <span className="text-tertiary truncate inline-flex items-center">
          {item.model}
          {conf && <ConfidenceBadge level={conf.model.level} tooltip={conf.model.reason} />}
        </span>
      )}
      {item.finish && (
        <span className="text-tertiary truncate inline-flex items-center">
          {item.finish}
          {conf && <ConfidenceBadge level={conf.finish.level} tooltip={conf.finish.reason} />}
        </span>
      )}
    </div>
  );
}
