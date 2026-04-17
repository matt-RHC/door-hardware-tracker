"use client"

import { useMemo, useState, useCallback } from "react"
import type {
  ClassifyPageDetail,
  ClassifyOverride,
  ClassifyPageType,
} from "@/lib/schemas/classify"

const PAGE_TYPE_OPTIONS: Array<{ value: ClassifyPageType; label: string }> = [
  { value: "door_schedule", label: "Door schedule" },
  { value: "hardware_set", label: "Hardware heading" },
  { value: "reference", label: "Reference / cut sheet" },
  { value: "cover", label: "Cover / TOC" },
  { value: "other", label: "Other / skip" },
]

const TYPE_PILL_STYLE: Record<ClassifyPageType, string> = {
  door_schedule: "bg-accent-dim border-accent text-accent",
  hardware_set: "bg-accent-dim border-accent text-accent",
  hardware_sets: "bg-accent-dim border-accent text-accent",
  reference: "bg-tint border-border-dim text-secondary",
  cover: "bg-tint border-border-dim text-tertiary",
  other: "bg-tint border-border-dim text-tertiary",
}

const TYPE_LABEL: Record<ClassifyPageType, string> = {
  door_schedule: "Schedule",
  hardware_set: "Hardware",
  hardware_sets: "Hardware",
  reference: "Reference",
  cover: "Cover",
  other: "Other",
}

const TYPE_ORDER: ClassifyPageType[] = [
  "door_schedule",
  "hardware_set",
  "reference",
  "cover",
  "other",
]

function confidenceColor(c: number): string {
  if (c >= 0.8) return "bg-success"
  if (c >= 0.6) return "bg-warning"
  return "bg-danger"
}

interface ClassifyCorrectionPanelProps {
  pages: ClassifyPageDetail[]
  /** Initial state derived from persisted phase_data.classify.user_overrides. */
  initialOverrides?: ClassifyOverride[]
  /** Fired when the user clicks Save. The caller persists via the
   *  classify-overrides endpoint. */
  onSave: (overrides: ClassifyOverride[]) => Promise<void> | void
  onCancel: () => void
  /** `true` while onSave is in-flight — disables buttons and shows a spinner. */
  saving?: boolean
}

/**
 * An expandable page-by-page correction panel for the Questions step.
 *
 * Design choices:
 * - Grouped by type so the user scans "these are all hardware pages
 *   together" rather than hunting through a flat list.
 * - Each row has a type pill that reveals a dropdown on click (keeps
 *   the dense view readable) plus an "Exclude from extraction"
 *   checkbox for the "this page is noise, drop it" path.
 * - Pure design-system tokens (bg-surface, bg-tint, border-border-dim,
 *   text-primary/secondary/tertiary). No hard-coded slate.
 * - Touch targets ≥44px (min-h-11) for iPad.
 */
export default function ClassifyCorrectionPanel({
  pages,
  initialOverrides = [],
  onSave,
  onCancel,
  saving = false,
}: ClassifyCorrectionPanelProps) {
  // Build a mutable override map keyed by page. Initialized from the
  // server's persisted overrides so re-opening the panel shows the
  // user's prior corrections.
  const [overrides, setOverrides] = useState<Map<number, ClassifyOverride>>(
    () => {
      const m = new Map<number, ClassifyOverride>()
      for (const o of initialOverrides) m.set(o.page, o)
      return m
    },
  )

  // ── Effective rows — apply pending overrides to the displayed type ──
  const effective = useMemo(() => {
    return pages.map((p) => {
      const ov = overrides.get(p.page)
      return {
        ...p,
        displayedType: ov?.type_override ?? p.type,
        excluded: ov?.excluded ?? false,
        hasOverride: Boolean(ov?.type_override || ov?.excluded),
      }
    })
  }, [pages, overrides])

  // Group for rendering — "unknown" buckets at the end of the order.
  const grouped = useMemo(() => {
    const byType = new Map<ClassifyPageType, typeof effective>()
    for (const row of effective) {
      // `hardware_sets` (plural) groups with `hardware_set`
      const key = (row.displayedType === "hardware_sets" ? "hardware_set" : row.displayedType) as ClassifyPageType
      const bucket = byType.get(key) ?? []
      bucket.push(row)
      byType.set(key, bucket)
    }
    return TYPE_ORDER.map((type) => ({
      type,
      rows: byType.get(type) ?? [],
    })).filter((g) => g.rows.length > 0)
  }, [effective])

  const setTypeOverride = useCallback(
    (page: number, original: ClassifyPageType, newType: ClassifyPageType) => {
      setOverrides((prev) => {
        const next = new Map(prev)
        const existing = next.get(page)
        if (newType === original && !existing?.excluded) {
          // Clearing to the original type with no exclusion — remove the override.
          next.delete(page)
        } else {
          next.set(page, {
            page,
            type_override: newType === original ? undefined : newType,
            excluded: existing?.excluded,
          })
        }
        return next
      })
    },
    [],
  )

  const toggleExcluded = useCallback(
    (page: number) => {
      setOverrides((prev) => {
        const next = new Map(prev)
        const existing = next.get(page)
        const nowExcluded = !(existing?.excluded ?? false)
        // When neither flag is set, drop the row so we don't emit a
        // no-op override. The schema treats absent fields as "no change".
        if (!nowExcluded && !existing?.type_override) {
          next.delete(page)
          return next
        }
        next.set(page, {
          page,
          type_override: existing?.type_override,
          excluded: nowExcluded ? true : undefined,
        })
        return next
      })
    },
    [],
  )

  const overrideCount = useMemo(
    () => Array.from(overrides.values()).filter((o) => o.type_override || o.excluded).length,
    [overrides],
  )

  const handleSave = useCallback(() => {
    // Materialize only real corrections — empty entries can exist transiently.
    const payload: ClassifyOverride[] = []
    for (const o of overrides.values()) {
      if (o.type_override || o.excluded) payload.push(o)
    }
    void onSave(payload)
  }, [overrides, onSave])

  return (
    <div className="bg-surface border border-border-dim rounded-md p-4 space-y-4 max-h-[60vh] overflow-y-auto">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <h4 className="text-sm font-semibold text-primary">Correct classifications</h4>
          <p className="text-[11px] text-tertiary mt-0.5">
            Reclassify a page or exclude it from extraction. Changes apply when you save.
          </p>
        </div>
        <span className="text-[11px] text-tertiary flex-shrink-0">
          {overrideCount > 0 ? `${overrideCount} change${overrideCount === 1 ? "" : "s"}` : "No changes"}
        </span>
      </div>

      {grouped.map((group) => (
        <section key={group.type} className="space-y-2">
          <h5 className="text-[10px] uppercase tracking-wider text-tertiary font-semibold">
            {TYPE_LABEL[group.type]}{" "}
            <span className="text-tertiary/70 font-normal">({group.rows.length})</span>
          </h5>
          <ul className="divide-y divide-border-dim border border-border-dim rounded bg-tint">
            {group.rows.map((row) => (
              <PageRow
                key={row.page}
                row={row}
                onChangeType={(newType) => setTypeOverride(row.page, row.type, newType)}
                onToggleExcluded={() => toggleExcluded(row.page)}
                disabled={saving}
              />
            ))}
          </ul>
        </section>
      ))}

      <div className="flex items-center justify-end gap-2 pt-2 border-t border-border-dim">
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className="px-3 py-1.5 rounded-md bg-tint border border-border-dim text-secondary text-xs font-medium hover:bg-tint-strong min-h-11 disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={saving || overrideCount === 0}
          className="px-3 py-1.5 rounded-md bg-accent text-white text-xs font-medium hover:bg-accent/80 min-h-11 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {saving ? "Saving…" : `Save ${overrideCount || ""} change${overrideCount === 1 ? "" : "s"}`.trim()}
        </button>
      </div>
    </div>
  )
}

// ── Row ──────────────────────────────────────────────────────────────

interface PageRowProps {
  row: {
    page: number
    type: ClassifyPageType
    displayedType: ClassifyPageType
    confidence: number
    labels: string[]
    hw_set_ids: string[]
    excluded: boolean
    hasOverride: boolean
  }
  onChangeType: (t: ClassifyPageType) => void
  onToggleExcluded: () => void
  disabled: boolean
}

function PageRow({ row, onChangeType, onToggleExcluded, disabled }: PageRowProps) {
  const [typePickerOpen, setTypePickerOpen] = useState(false)

  // Labels summary — favor hw_set_ids for hardware, generic labels otherwise.
  const labelLine = useMemo(() => {
    if (row.hw_set_ids.length > 0) {
      return row.hw_set_ids.length <= 4
        ? `Set ${row.hw_set_ids.join(", ")}`
        : `Set ${row.hw_set_ids.slice(0, 3).join(", ")} +${row.hw_set_ids.length - 3} more`
    }
    if (row.labels.length > 0) return row.labels.slice(0, 3).join(", ")
    return ""
  }, [row.hw_set_ids, row.labels])

  return (
    <li className={`p-2 ${row.excluded ? "opacity-60" : ""}`}>
      <div className="flex items-start gap-3 min-h-11">
        <span className="font-mono text-xs text-primary w-10 flex-shrink-0 mt-1.5" aria-label="Page number">
          p{row.page}
        </span>

        <div className="flex-1 min-w-0 space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={() => !disabled && setTypePickerOpen((v) => !v)}
              disabled={disabled}
              aria-label={`Change classification for page ${row.page}`}
              className={`px-2 py-1 rounded border text-[11px] font-medium min-h-11 min-w-[80px] transition-colors ${TYPE_PILL_STYLE[row.displayedType]} ${row.hasOverride ? "ring-1 ring-accent/60" : ""} disabled:opacity-50`}
            >
              {TYPE_LABEL[row.displayedType]}
              {row.hasOverride && !row.excluded ? " ✓" : ""}
            </button>

            <span
              className={`inline-block w-2 h-2 rounded-full ${confidenceColor(row.confidence)}`}
              title={`Confidence ${(row.confidence * 100).toFixed(0)}%`}
              aria-label={`Confidence ${(row.confidence * 100).toFixed(0)}%`}
            />

            {labelLine && (
              <span className="text-[11px] text-tertiary truncate">
                {labelLine}
              </span>
            )}
          </div>

          {typePickerOpen && !disabled && (
            <div className="flex flex-wrap gap-1 pt-1" role="listbox">
              {PAGE_TYPE_OPTIONS.map((opt) => {
                const active = opt.value === row.displayedType
                return (
                  <button
                    key={opt.value}
                    type="button"
                    role="option"
                    aria-selected={active}
                    onClick={() => {
                      onChangeType(opt.value)
                      setTypePickerOpen(false)
                    }}
                    className={`px-2 py-1 rounded border text-[11px] min-h-11 ${
                      active
                        ? "bg-accent-dim border-accent text-accent"
                        : "bg-tint border-border-dim text-secondary hover:border-accent/30"
                    }`}
                  >
                    {opt.label}
                  </button>
                )
              })}
            </div>
          )}
        </div>

        <label className="flex items-center gap-1 text-[11px] text-tertiary cursor-pointer min-h-11 flex-shrink-0">
          <input
            type="checkbox"
            checked={row.excluded}
            onChange={onToggleExcluded}
            disabled={disabled}
            className="w-4 h-4 accent-[var(--accent)] flex-shrink-0"
            aria-label={`Exclude page ${row.page} from extraction`}
          />
          Skip
        </label>
      </div>
    </li>
  )
}
