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
import WizardNav from "./WizardNav";

// ── Category accent color mapping ──
const CATEGORY_ACCENT: Record<string, string> = {
  hinges: "blue",
  electric_conductor_hinge: "blue",
  lockset: "purple",
  latchset: "purple",
  exit_device: "red",
  closer: "cyan",
  holder: "cyan",
  coordinator: "cyan",
  push_pull: "green",
  electronic_modification: "orange",
  electric_strike: "orange",
  magnetic_lock: "orange",
  threshold: "green",
  seal: "green",
  weatherstripping: "green",
  stop: "blue",
  hardware_by_others: "red",
};

function accentForCategory(categoryId: string): string {
  return CATEGORY_ACCENT[categoryId] ?? "blue";
}

// ── Main component ──

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
  const [flippedCards, setFlippedCards] = useState<Set<string>>(new Set());
  const [resolvedTypos, setResolvedTypos] = useState<Set<string>>(new Set());

  const analysis: ProductAnalysis = useMemo(() => analyzeProducts(sets), [sets]);

  const toggleFlip = useCallback((key: string) => {
    setFlippedCards(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const handleMergeTypo = useCallback(
    (typo: TypoCandidate, keepFamily: ProductFamily) => {
      const otherFamily =
        typo.familyA === keepFamily ? typo.familyB : typo.familyA;
      const variantModels = otherFamily.items.map(v => v.model);
      const sorted = [...keepFamily.items].sort((a, b) => b.occurrences - a.occurrences);
      const canonical = sorted[0]?.model ?? '';
      if (canonical && variantModels.length > 0) {
        setSets(prev => applyCorrection(prev, variantModels, canonical));
      }
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

  const unresolvedTypos = analysis.typoCandidates.filter(t => {
    const key = `${t.familyA.baseSeries}|${t.familyB.baseSeries}`;
    return !resolvedTypos.has(key);
  });

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* ── Header ── */}
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
        <p className="text-xs text-tertiary/60 mt-0.5">
          Tap any card to see variant details
        </p>
      </div>

      {/* ── Category sections ── */}
      {sortedCategories.map(([categoryId, families]) => {
        const categoryLabel = families[0]?.categoryLabel ?? 'Other';
        const accent = accentForCategory(categoryId);

        // Typo alerts for this category
        const categoryTypos = unresolvedTypos.filter(
          t => t.familyA.categoryId === categoryId,
        );

        return (
          <section key={categoryId}>
            {/* Section divider header */}
            <div className="flex items-center gap-3 mb-3">
              <h4
                className="text-[11px] font-semibold uppercase tracking-wider whitespace-nowrap"
                style={{
                  fontFamily: "var(--font-display)",
                  color: `var(--${accent})`,
                }}
              >
                {categoryLabel}
              </h4>
              <div className="flex-1 h-px bg-border-dim" />
              <span className="text-[10px] text-tertiary whitespace-nowrap">
                {families.length} {families.length === 1 ? 'family' : 'families'}
              </span>
            </div>

            {/* Typo alerts for this category */}
            {categoryTypos.length > 0 && (
              <div className="mb-3 space-y-2">
                {categoryTypos.map((typo, idx) => (
                  <TypoAlert
                    key={`${typo.familyA.baseSeries}-${typo.familyB.baseSeries}-${idx}`}
                    typo={typo}
                    onMerge={handleMergeTypo}
                    onDismiss={handleDismissTypo}
                  />
                ))}
              </div>
            )}

            {/* Card grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 stagger-children">
              {families.map(family => {
                const familyKey = `${family.manufacturer}|${family.baseSeries}`;
                const isTypoTarget = categoryTypos.some(
                  t =>
                    t.familyA.baseSeries === family.baseSeries ||
                    t.familyB.baseSeries === family.baseSeries,
                );
                return (
                  <ProductFamilyCard
                    key={familyKey}
                    family={family}
                    accent={accent}
                    isFlipped={flippedCards.has(familyKey)}
                    onFlip={() => toggleFlip(familyKey)}
                    isTypoTarget={isTypoTarget}
                  />
                );
              })}
            </div>
          </section>
        );
      })}

      {/* ── Navigation ── */}
      <WizardNav
        onBack={onBack}
        onNext={() => onComplete(sets)}
      />
    </div>
  );
}


// ── Flip card sub-component ──

function ProductFamilyCard({
  family,
  accent,
  isFlipped,
  onFlip,
  isTypoTarget,
}: {
  family: ProductFamily;
  accent: string;
  isFlipped: boolean;
  onFlip: () => void;
  isTypoTarget: boolean;
}) {
  return (
    <div
      className={`flip-card flip-card--${accent} ${isFlipped ? 'flip-card--flipped' : ''}`}
      style={{ minHeight: '160px' }}
      onClick={onFlip}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onFlip();
        }
      }}
      aria-label={`${family.manufacturer ?? 'Unknown'} ${family.baseSeries}. ${isFlipped ? 'Showing details. Click to flip back.' : 'Click to see details.'}`}
    >
      <div className="flip-card__inner">
        {/* ── FRONT ── */}
        <div className="flip-card__front bg-tint border border-border-dim p-4 flex flex-col justify-between">
          <div>
            <div className="flex items-start justify-between mb-2">
              <span
                className="text-[10px] font-semibold uppercase tracking-wider text-tertiary"
                style={{ fontFamily: "var(--font-display)" }}
              >
                {family.manufacturer || 'Unknown'}
              </span>
              {isTypoTarget && (
                <span className="text-[9px] px-1.5 py-0.5 bg-warning-dim text-warning rounded-lg font-semibold">
                  Typo?
                </span>
              )}
            </div>
            <div
              className="text-lg font-semibold"
              style={{ color: `var(--${accent})` }}
            >
              {family.baseSeries}
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mt-3 text-[10px] text-tertiary">
              <span>
                {family.items.length} variant{family.items.length !== 1 ? 's' : ''}
              </span>
              <span>
                {family.totalOccurrences} use{family.totalOccurrences !== 1 ? 's' : ''}
              </span>
            </div>
            {/* Flip hint */}
            <div className="text-[9px] text-tertiary/40 text-center mt-2">
              tap to flip
            </div>
          </div>
        </div>

        {/* ── BACK ── */}
        <div className="flip-card__back bg-surface border border-border-dim-strong p-4 overflow-y-auto">
          <div className="flex items-center justify-between mb-3">
            <span
              className="text-[10px] font-semibold uppercase tracking-wider"
              style={{
                fontFamily: "var(--font-display)",
                color: `var(--${accent})`,
              }}
            >
              {family.baseSeries}
            </span>
            <span className="text-[9px] text-tertiary/40">tap to flip</span>
          </div>
          <div className="space-y-2">
            {family.items.map(variant => (
              <div
                key={variant.normalizedModel}
                className="flex items-start gap-2 text-xs"
              >
                <span style={{ color: `var(--${accent})` }}>&bull;</span>
                <div className="flex-1 min-w-0">
                  <div className="text-primary font-mono truncate">
                    {variant.model}
                  </div>
                  {variant.finish && (
                    <div className="text-tertiary text-[10px]">{variant.finish}</div>
                  )}
                </div>
                <span className="text-tertiary whitespace-nowrap text-[10px]">
                  {variant.setIds.length <= 3
                    ? variant.setIds.join(', ')
                    : `${variant.setIds.slice(0, 2).join(', ')} +${variant.setIds.length - 2}`}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}


// ── Typo alert sub-component ──

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
    <div
      className="bg-warning-dim/30 border border-warning/20 rounded-xl p-3 text-sm"
      onClick={(e) => e.stopPropagation()}
    >
      <p className="text-secondary mb-2">
        <span className="font-mono text-warning">{typo.familyA.manufacturer} {typo.familyA.baseSeries}</span>
        {' '}and{' '}
        <span className="font-mono text-warning">{typo.familyB.manufacturer} {typo.familyB.baseSeries}</span>
        {' '}look similar. Same product?
      </p>
      <div className="flex gap-2 flex-wrap">
        <button
          onClick={(e) => { e.stopPropagation(); onMerge(typo, typo.familyA); }}
          className="min-h-9 px-3 py-1.5 bg-accent/20 hover:bg-accent/30 text-accent rounded-lg text-xs transition-colors font-medium"
        >
          Keep &ldquo;{typo.familyA.baseSeries}&rdquo;
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); onMerge(typo, typo.familyB); }}
          className="min-h-9 px-3 py-1.5 bg-accent/20 hover:bg-accent/30 text-accent rounded-lg text-xs transition-colors font-medium"
        >
          Keep &ldquo;{typo.familyB.baseSeries}&rdquo;
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); onDismiss(typo); }}
          className="min-h-9 px-3 py-1.5 border border-border-dim hover:border-accent/50 text-tertiary hover:text-primary rounded-lg text-xs transition-colors font-medium"
        >
          Keep Both
        </button>
      </div>
    </div>
  );
}
