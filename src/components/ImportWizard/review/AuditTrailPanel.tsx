"use client";

import type { ReconciledHardwareSet } from "@/lib/types/reconciliation";

interface AuditTrailPanelProps {
  reconciledSet: ReconciledHardwareSet;
  isOpen: boolean;
  onToggle: () => void;
}

export default function AuditTrailPanel({
  reconciledSet,
  isOpen,
  onToggle,
}: AuditTrailPanelProps) {
  const reconciledItems = reconciledSet.items ?? [];
  const fullCount = reconciledItems.filter((i) => i.overall_confidence === 'full').length;
  const conflictCount = reconciledItems.filter((i) => i.overall_confidence === 'conflict').length;
  const singleCount = reconciledItems.filter((i) => i.overall_confidence === 'single_source').length;

  return (
    <div className="mt-2 pt-2 border-t border-border-dim">
      <button
        onClick={onToggle}
        className="flex items-center gap-1.5 text-[10px] text-tertiary hover:text-secondary transition-colors"
      >
        <span className="text-[8px]">{isOpen ? '\u25BE' : '\u25B8'}</span>
        <span className="font-medium">Audit Trail</span>
        <span className="text-[9px]">
          {fullCount} agreed, {conflictCount} conflicts, {singleCount} single-source
        </span>
      </button>
      {isOpen && (
        <div className="mt-1.5 space-y-1 text-[10px]">
          {reconciledItems.map((ri, riIdx) => {
            if (ri.overall_confidence === 'full') return null;
            const fields = (['name', 'qty', 'manufacturer', 'model', 'finish'] as const).filter(
              (f) => ri[f].confidence !== 'full',
            );
            if (fields.length === 0) return null;
            return (
              <div key={riIdx} className="pl-3 py-1 border-l-2 border-border-dim">
                <span className="font-medium text-primary">{String(ri.name.value)}</span>
                {fields.map((f) => (
                  <div key={f} className="text-tertiary ml-2">
                    <span className="text-secondary">{f}:</span>{' '}
                    {ri[f].sources.strategy_a != null && (
                      <span>
                        pdfplumber said{' '}
                        <span className="text-primary">{String(ri[f].sources.strategy_a)}</span>
                      </span>
                    )}
                    {ri[f].sources.strategy_a != null && ri[f].sources.strategy_b != null && ', '}
                    {ri[f].sources.strategy_b != null && (
                      <span>
                        vision said{' '}
                        <span className="text-primary">{String(ri[f].sources.strategy_b)}</span>
                      </span>
                    )}
                    {' \u2014 '}
                    <span className="text-secondary">{ri[f].reason}</span>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
