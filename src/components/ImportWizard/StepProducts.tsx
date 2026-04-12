"use client";

import { useState, useMemo, useCallback } from "react";
import type { HardwareSet } from "./types";
import {
  analyzeProducts,
  applyCorrection,
  type ProductFamily,
  type ProductAnalysis,
  type TypoCandidate,
} from "@/lib/product-dedup";

interface StepProductsProps {
  hardwareSets: HardwareSet[];
  onComplete: (hardwareSets: HardwareSet[]) => void;
  onBack: () => void;
}

export default function StepProducts({
  hardwareSets: initialSets,
  onComplete,
  onBack,
}: StepProductsProps) {
  const [sets, setSets] = useState<HardwareSet[]>(initialSets);
  const [expandedFamilies, setExpandedFamilies] = useState<Set<string>>(new Set());
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set());
  const [resolvedTypos, setResolvedTypos] = useState<Set<string>>(new Set());

  const analysis: ProductAnalysis = useMemo(() => analyzeProducts(sets), [sets]);

  const toggleFamily = useCallback((key: string) => {
    setExpandedFamilies(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const toggleCategory = useCallback((catId: string) => {
    setExpandedCategories(prev => {
      const next = new Set(prev);
      if (next.has(catId)) next.delete(catId);
      else next.add(catId);
      return next;
    });
  }, []);

  const handleMergeTypo = useCallback(
    (typo: TypoCandidate, keepFamily: ProductFamily) => {
      const otherFamily =
        typo.familyA === keepFamily ? typo.familyB : typo.familyA;
      const variantModels = otherFamily.items.map(v => v.model);
      // Use the most common model from the kept family as canonical
      const sorted = [...keepFamily.items].sort((a, b) => b.occurrences - a.occurrences);
      const canonical = sorted[0]?.model ?? '';
      if (canonical && variantModels.length > 0) {
        setSets(prev => applyCorrection(prev, variantModels, canonical));
      }
      // Mark this typo as resolved
      const typoKey = `${typo.familyA.baseSeries}|${typo.familyB.baseSeries}`;
      setResolvedTypos(prev => new Set(prev).add(typoKey));
    },
    [],
  );

  const handleDismissTypo = useCallback((typo: TypoCandidate) => {
    const typoKey = `${typo.familyA.baseSeries}|${typo.familyB.baseSeries}`;
    setResolvedTypos(prev => new Set(prev).add(typoKey));
  }, []);

  // Sort categories: ones with typos first, then alphabetical, "unknown" last
  const sortedCategories = useMemo(() => {
    const entries = Array.from(analysis.byCategory.entries());
    const typoCategories = new Set(
      analysis.typoCandidates.map(t => t.familyA.categoryId)
    );
    return entries.sort(([idA], [idB]) => {
      if (idA === 'unknown') return 1;
      if (idB === 'unknown') return -1;
      const aHasTypo = typoCategories.has(idA) ? 0 : 1;
      const bHasTypo = typoCategories.has(idB) ? 0 : 1;
      if (aHasTypo !== bHasTypo) return aHasTypo - bHasTypo;
      return idA.localeCompare(idB);
    });
  }, [analysis]);

  // Auto-expand all categories on first render
  const allExpanded = expandedCategories.size === 0;

  const unresolvedTypos = analysis.typoCandidates.filter(t => {
    const key = `${t.familyA.baseSeries}|${t.familyB.baseSeries}`;
    return !resolvedTypos.has(key);
  });

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3
            className="text-[11px] font-semibold uppercase text-secondary tracking-wider"
            style={{ fontFamily: "var(--font-display)" }}
          >
            Product Families
          </h3>
          <p className="text-sm text-tertiary mt-1">
            {analysis.families.length} families, {analysis.totalUnique} unique items
            {unresolvedTypos.length > 0 && (
              <span className="text-warning ml-2">
                &bull; {unresolvedTypos.length} potential typo{unresolvedTypos.length !== 1 ? 's' : ''}
              </span>
            )}
          </p>
        </div>
      </div>

      {/* Typo alerts (if any) */}
      {unresolvedTypos.length > 0 && (
        <div className="bg-warning-dim border border-warning/30 rounded-xl p-4 space-y-3">
          <div
            className="text-[11px] font-semibold uppercase text-warning tracking-wider"
            style={{ fontFamily: "var(--font-display)" }}
          >
            Potential Typos Detected
          </div>
          {unresolvedTypos.map((typo, idx) => (
            <TypoAlert
              key={`${typo.familyA.baseSeries}-${typo.familyB.baseSeries}-${idx}`}
              typo={typo}
              onMerge={handleMergeTypo}
              onDismiss={handleDismissTypo}
            />
          ))}
        </div>
      )}

      {/* Category groups */}
      <div className="space-y-4">
        {sortedCategories.map(([categoryId, families]) => {
          const categoryLabel = families[0]?.categoryLabel ?? 'Other';
          const isExpanded = allExpanded || expandedCategories.has(categoryId);
          return (
            <div
              key={categoryId}
              className="bg-tint border border-border-dim rounded-xl overflow-hidden"
            >
              {/* Category header */}
              <button
                className="w-full flex items-center justify-between px-4 py-3 hover:bg-surface-dim/50 transition-colors"
                onClick={() => toggleCategory(categoryId)}
              >
                <span
                  className="text-[11px] font-semibold uppercase text-secondary tracking-wider"
                  style={{ fontFamily: "var(--font-display)" }}
                >
                  {categoryLabel} ({families.length} {families.length === 1 ? 'family' : 'families'})
                </span>
                <span className="text-tertiary text-xs">
                  {isExpanded ? '\u25BC' : '\u25B6'}
                </span>
              </button>

              {/* Families within category */}
              {isExpanded && (
                <div className="border-t border-border-dim divide-y divide-border-dim/50">
                  {families.map(family => {
                    const familyKey = `${family.manufacturer}|${family.baseSeries}`;
                    const isOpen = expandedFamilies.has(familyKey);
                    return (
                      <FamilyRow
                        key={familyKey}
                        family={family}
                        isOpen={isOpen}
                        onToggle={() => toggleFamily(familyKey)}
                      />
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Navigation */}
      <div className="flex justify-between pt-4">
        <button
          onClick={onBack}
          className="px-6 py-2.5 border border-border-dim text-secondary hover:text-primary hover:border-accent/50 rounded-lg transition-colors text-sm"
        >
          &larr; Back
        </button>
        <button
          onClick={() => onComplete(sets)}
          className="px-8 py-2.5 bg-accent hover:bg-accent/80 text-white rounded-lg transition-colors font-semibold text-sm"
        >
          Continue &rarr;
        </button>
      </div>
    </div>
  );
}


// ── Sub-components ─────────────────────────────────────────────────

function FamilyRow({
  family,
  isOpen,
  onToggle,
}: {
  family: ProductFamily;
  isOpen: boolean;
  onToggle: () => void;
}) {
  return (
    <div>
      <button
        className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-surface-dim/30 transition-colors text-left"
        onClick={onToggle}
      >
        <span className="text-tertiary text-xs">{isOpen ? '\u25BC' : '\u25B6'}</span>
        <div className="flex-1 min-w-0">
          <span className="text-sm text-primary font-medium">
            {family.manufacturer || 'Unknown'}{' '}
            <span className="text-accent">{family.baseSeries}</span>
          </span>
          <span className="text-xs text-tertiary ml-2">
            {family.items.length} variation{family.items.length !== 1 ? 's' : ''}, {family.totalOccurrences} occurrence{family.totalOccurrences !== 1 ? 's' : ''}
          </span>
        </div>
      </button>

      {isOpen && (
        <div className="px-4 pb-3 space-y-1.5">
          {family.items.map(variant => (
            <div
              key={variant.normalizedModel}
              className="flex items-center gap-2 pl-6 py-1 text-xs"
            >
              <span className="text-accent">&bull;</span>
              <span className="text-primary font-mono flex-1 min-w-0 truncate">
                {variant.model}
              </span>
              {variant.finish && (
                <span className="text-tertiary">
                  {variant.finish}
                </span>
              )}
              <span className="text-tertiary whitespace-nowrap">
                {variant.setIds.length <= 3
                  ? variant.setIds.join(', ')
                  : `${variant.setIds.slice(0, 2).join(', ')} +${variant.setIds.length - 2}`}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}


function TypoAlert({
  typo,
  onMerge,
  onDismiss,
}: {
  typo: TypoCandidate;
  onMerge: (typo: TypoCandidate, keepFamily: ProductFamily) => void;
  onDismiss: (typo: TypoCandidate) => void;
}) {
  return (
    <div className="bg-surface-dim/50 rounded-lg p-3 text-sm">
      <p className="text-secondary mb-2">
        <span className="font-mono text-warning">{typo.familyA.manufacturer} {typo.familyA.baseSeries}</span>
        {' '}and{' '}
        <span className="font-mono text-warning">{typo.familyB.manufacturer} {typo.familyB.baseSeries}</span>
        {' '}look similar. Same product?
      </p>
      <div className="flex gap-2">
        <button
          onClick={() => onMerge(typo, typo.familyA)}
          className="px-3 py-1 bg-accent/20 hover:bg-accent/30 text-accent rounded text-xs transition-colors"
        >
          Keep &ldquo;{typo.familyA.baseSeries}&rdquo;
        </button>
        <button
          onClick={() => onMerge(typo, typo.familyB)}
          className="px-3 py-1 bg-accent/20 hover:bg-accent/30 text-accent rounded text-xs transition-colors"
        >
          Keep &ldquo;{typo.familyB.baseSeries}&rdquo;
        </button>
        <button
          onClick={() => onDismiss(typo)}
          className="px-3 py-1 border border-border-dim hover:border-accent/50 text-tertiary rounded text-xs transition-colors"
        >
          Keep Both
        </button>
      </div>
    </div>
  );
}
