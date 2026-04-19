"use client";

import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { usePunchHighlight } from "./usePunchHighlight";
import type { DoorEntry, HardwareSet, ClassifyPagesResponse } from "./types";
import type { ReconciliationResult, ReconciledHardwareSet } from "@/lib/types/reconciliation";
import { buildDoorToSetMap, normalizeDoorNumber } from "@/lib/parse-pdf-helpers";
import type { RegionExtractField } from "@/lib/schemas/parse-pdf";
import WizardNav from "./WizardNav";
import ReviewSummary from "./review/ReviewSummary";
import ReviewFilters from "./review/ReviewFilters";
import SetView from "./review/SetView";
import DoorView from "./review/DoorView";
import IssueView from "./review/IssueView";
import InlineRescan, { type InlineRescanMode } from "./review/InlineRescan";
import PropagationSuggestionModal from "./review/PropagationSuggestionModal";
import { isOrphanDoor, getDoorIssues, getConfidence } from "./review/utils";
import type { PropagationSuggestion } from "@/lib/types";
import { applyFieldToDoors, applyPropagationSuggestions } from "./review/rescan-apply";
import type {
  DoorGroup,
  DoorStringField,
  EditingCell,
  FilterLevel,
  SortDir,
} from "./review/types";

type ViewMode = 'door' | 'set' | 'issue';

const VIEW_MODE_STORAGE_KEY = 'review.viewMode';

function loadInitialViewMode(): ViewMode {
  if (typeof window === 'undefined') return 'door';
  try {
    const stored = window.localStorage.getItem(VIEW_MODE_STORAGE_KEY);
    if (stored === 'door' || stored === 'set' || stored === 'issue') return stored;
  } catch {
    // localStorage may be unavailable (private browsing, etc.) — fall through
  }
  return 'door';
}

interface StepReviewProps {
  projectId: string;
  doors: DoorEntry[];
  hardwareSets: HardwareSet[];
  hasExistingData: boolean;
  /** For PDF preview per set. */
  classifyResult: ClassifyPagesResponse | null;
  /** PDF file buffer for rendering page previews. */
  pdfBuffer: ArrayBuffer | null;
  /** Reconciliation result from deep extraction (Phase C). */
  reconciliationResult?: ReconciliationResult | null;
  onComplete: (doors: DoorEntry[], hardwareSets: HardwareSet[]) => void;
  onBack: () => void;
  onRemapColumns?: () => void;
}

// Max simultaneous PDF previews — protects mobile memory. On very large
// projects (35+ sets), rendering all canvases at once can crash the tab.
const MAX_OPEN_PREVIEWS = 3;

export default function StepReview({
  projectId,
  doors: initialDoors,
  hardwareSets: initialHardwareSets,
  hasExistingData,
  classifyResult,
  pdfBuffer,
  reconciliationResult,
  onComplete,
  onBack,
  onRemapColumns,
}: StepReviewProps) {
  // Local copy of hardware sets to support Darrin revert without modifying parent state
  const [hardwareSets, setHardwareSets] = useState(initialHardwareSets);
  const { registerRef } = usePunchHighlight();
  const [doors, setDoors] = useState<DoorEntry[]>(initialDoors);

  // Which set groups have their PDF preview open (lazy-mounted when expanded)
  const [previewOpen, setPreviewOpen] = useState<Set<string>>(new Set());

  // Region extract modal state
  const [regionExtractSetId, setRegionExtractSetId] = useState<string | null>(null);
  const [regionExtractPageIdx, setRegionExtractPageIdx] = useState<number | null>(null);
  const [regionExtractMode, setRegionExtractMode] = useState<InlineRescanMode>("items");
  const [regionExtractTriggerDoor, setRegionExtractTriggerDoor] = useState<string | null>(null);

  // Darrin propagation suggestion modal state. Set after a field is applied
  // and we find sibling doors in the same set that are missing the same
  // field. Cleared when the user dismisses or accepts.
  // Each PropagationSuggestion carries its own field, so no dominant
  // field is needed at the modal level — the tier-1 batch path mixes
  // location / hand / fire_rating suggestions in a single list.
  const [propagationSuggestions, setPropagationSuggestions] = useState<{
    suggestions: PropagationSuggestion[];
  } | null>(null);

  const [editingCell, setEditingCell] = useState<EditingCell | null>(null);
  const [editValue, setEditValue] = useState("");
  // `recentlyEdited` drives the 1.5s success-dim flash that confirms a
  // client-side commit landed in state. These edits don't round-trip to an
  // API (see StepConfirm for the actual async save), so the flash is the
  // only feedback the user gets that their keystroke "took". Paired with a
  // ref-held timeout so a rapid second edit cancels the prior fade.
  const [recentlyEdited, setRecentlyEdited] = useState<EditingCell | null>(
    null,
  );
  const editFlashTimeoutRef = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      if (editFlashTimeoutRef.current != null) {
        window.clearTimeout(editFlashTimeoutRef.current);
      }
    };
  }, []);

  // ─── View mode (door-centric vs set-centric) ───
  const [viewMode, setViewMode] = useState<ViewMode>(loadInitialViewMode);
  useEffect(() => {
    try {
      window.localStorage.setItem(VIEW_MODE_STORAGE_KEY, viewMode);
    } catch {
      // localStorage may be unavailable — view mode still works per session
    }
  }, [viewMode]);

  // ─── Door expansion (door view only) ───
  const [expandedDoors, setExpandedDoors] = useState<Set<string>>(new Set());
  const toggleDoor = useCallback((key: string) => {
    setExpandedDoors((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // ─── Search & filter ───
  const [search, setSearch] = useState("");
  const [filterLevel, setFilterLevel] = useState<FilterLevel>("all");
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  // Per-set collapsed leaf sections: key = "setId:shared|leaf1|leaf2"
  const [collapsedLeafSections, setCollapsedLeafSections] = useState<Set<string>>(new Set());
  const toggleLeafSection = useCallback(
    (setId: string, section: 'shared' | 'leaf1' | 'leaf2') => {
      const key = `${setId}:${section}`;
      setCollapsedLeafSections((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
    },
    [],
  );
  const [sortField, setSortField] = useState<DoorStringField>("door_number");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  // Audit trail expander state (per set_id)
  const [auditTrailOpen, setAuditTrailOpen] = useState<Set<string>>(new Set());
  const toggleAuditTrail = useCallback((setId: string) => {
    setAuditTrailOpen((prev) => {
      const next = new Set(prev);
      if (next.has(setId)) next.delete(setId);
      else next.add(setId);
      return next;
    });
  }, []);

  // Build reconciled set lookup for audit trail display
  const reconciledSetMap = useMemo(() => {
    const m = new Map<string, ReconciledHardwareSet>();
    if (!reconciliationResult) return m;
    for (const rs of reconciliationResult.hardware_sets) {
      m.set(rs.set_id, rs);
    }
    return m;
  }, [reconciliationResult]);

  // Lookup maps for resolving door → hardware set. Registered under BOTH
  // set_id and generic_set_id — doors may be assigned to either depending on
  // heading format (e.g., "DH1.01" vs "DH1-10").
  const setMap = useMemo(() => {
    const m = new Map<string, HardwareSet>();
    for (const set of hardwareSets) {
      m.set(set.set_id, set);
      if (set.generic_set_id && set.generic_set_id !== set.set_id) {
        m.set(set.generic_set_id, set);
      }
    }
    return m;
  }, [hardwareSets]);
  // Door-number → specific sub-set lookup. Handles multi-heading cases like
  // DH4A.0 vs DH4A.1 that share a generic_set_id but have different items.
  const doorToSetMap = useMemo(() => buildDoorToSetMap(hardwareSets), [hardwareSets]);

  // ─── Inline editing ───
  const startEdit = useCallback(
    (originalIndex: number, field: DoorStringField) => {
      setEditingCell({ row: originalIndex, field });
      setEditValue(doors[originalIndex]?.[field] ?? "");
    },
    [doors],
  );

  const commitEdit = useCallback(() => {
    if (!editingCell) return;
    const cell = editingCell;
    setDoors((prev) => {
      const next = [...prev];
      next[cell.row] = {
        ...next[cell.row],
        [cell.field]: editValue,
      };
      return next;
    });
    setEditingCell(null);
    setEditValue("");
    // Trigger the "just edited" flash and schedule its decay.
    setRecentlyEdited(cell);
    if (editFlashTimeoutRef.current != null) {
      window.clearTimeout(editFlashTimeoutRef.current);
    }
    editFlashTimeoutRef.current = window.setTimeout(() => {
      setRecentlyEdited((cur) => {
        if (cur && cur.row === cell.row && cur.field === cell.field) {
          return null;
        }
        return cur;
      });
    }, 1500);
  }, [editingCell, editValue]);

  const cancelEdit = useCallback(() => {
    setEditingCell(null);
    setEditValue("");
  }, []);

  // ─── Orphan detection (auto-removed) ───
  const orphanDoors = useMemo(() => doors.filter(isOrphanDoor), [doors]);
  const [orphanNoticeDismissed, setOrphanNoticeDismissed] = useState(false);
  const activeDoors = useMemo(() => doors.filter((d) => !isOrphanDoor(d)), [doors]);

  // ─── Stats ───
  const highCount = activeDoors.filter((d) => getConfidence(d) === "high").length;
  const medCount = activeDoors.filter((d) => getConfidence(d) === "medium").length;
  const lowCount = activeDoors.filter((d) => getConfidence(d) === "low").length;
  const totalDoors = activeDoors.length;

  // ─── Issue groups (for "needs attention" summary) ───
  const issueGroups = useMemo(() => {
    const groups = new Map<string, string[]>();
    for (const door of activeDoors) {
      const issues = getDoorIssues(door);
      for (const issue of issues) {
        if (!groups.has(issue)) groups.set(issue, []);
        groups.get(issue)!.push(door.door_number);
      }
    }
    return groups;
  }, [activeDoors]);

  // ─── Filter + search ───
  const filteredDoors = useMemo(() => {
    const lowerSearch = (search ?? '').toLowerCase().trim();
    return doors
      .map((door, idx) => ({ door, originalIndex: idx }))
      .filter(({ door }) => {
        if (isOrphanDoor(door)) return false;
        if (filterLevel !== "all" && getConfidence(door) !== filterLevel) return false;
        if (lowerSearch) {
          const searchable = [
            door.door_number,
            door.hw_set,
            door.location,
            door.door_type,
            door.fire_rating,
          ]
            .filter(Boolean)
            .join(" ")
            .toLowerCase();
          if (!searchable.includes(lowerSearch)) return false;
        }
        return true;
      });
  }, [doors, search, filterLevel]);

  // ─── Sort ───
  const sortedDoors = useMemo(() => {
    const sorted = [...filteredDoors];
    sorted.sort((a, b) => {
      const aVal = (a.door[sortField] ?? "").toLowerCase();
      const bVal = (b.door[sortField] ?? "").toLowerCase();
      const cmp = aVal.localeCompare(bVal, undefined, { numeric: true });
      return sortDir === "asc" ? cmp : -cmp;
    });
    return sorted;
  }, [filteredDoors, sortField, sortDir]);

  // ─── Group by hardware set ───
  const groups: DoorGroup[] = useMemo(() => {
    const groupMap = new Map<string, DoorGroup>();
    for (const item of sortedDoors) {
      const doorKey = normalizeDoorNumber(item.door.door_number);
      const specificSet = doorToSetMap.get(doorKey);
      const setId = specificSet?.set_id ?? item.door.hw_set ?? "(unassigned)";
      if (!groupMap.has(setId)) {
        const set = specificSet ?? setMap.get(setId);
        groupMap.set(setId, {
          setId,
          heading: set?.heading ?? "",
          doors: [],
          highCount: 0,
          medCount: 0,
          lowCount: 0,
        });
      }
      const group = groupMap.get(setId)!;
      group.doors.push(item);
      const conf = getConfidence(item.door);
      if (conf === "high") group.highCount++;
      else if (conf === "medium") group.medCount++;
      else group.lowCount++;
    }
    return Array.from(groupMap.values());
  }, [sortedDoors, setMap, doorToSetMap]);

  // Auto-collapse all-green groups on first render. Runs as an effect so the
  // setState happens after commit, not inside the memo's body — which React
  // Strict Mode / React Compiler may drop if the memo is bailed out.
  useEffect(() => {
    if (collapsedGroups.size > 0) return;
    const autoCollapsed = new Set<string>();
    for (const group of groups) {
      if (group.doors.length > 0 && group.medCount === 0 && group.lowCount === 0) {
        autoCollapsed.add(group.setId);
      }
    }
    if (autoCollapsed.size > 0) {
      setCollapsedGroups(autoCollapsed);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups.length]);

  const toggleGroup = useCallback((setId: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(setId)) next.delete(setId);
      else next.add(setId);
      return next;
    });
  }, []);

  const togglePreview = useCallback((setId: string) => {
    setPreviewOpen((prev) => {
      const next = new Set(prev);
      if (next.has(setId)) {
        next.delete(setId);
      } else {
        if (next.size >= MAX_OPEN_PREVIEWS) {
          const oldest = next.values().next().value;
          if (oldest !== undefined) next.delete(oldest);
        }
        next.add(setId);
      }
      return next;
    });
  }, []);

  const handleSort = useCallback(
    (field: DoorStringField) => {
      if (sortField === field) {
        setSortDir((d) => (d === "asc" ? "desc" : "asc"));
      } else {
        setSortField(field);
        setSortDir("asc");
      }
    },
    [sortField],
  );

  const handleRevert = useCallback(
    (setId: string, itemIdx: number, originalQty: number) => {
      setHardwareSets((prev) =>
        prev.map((s) => {
          if (s.set_id !== setId) return s;
          const updatedItems = (s.items ?? []).map((it, i) => {
            if (i !== itemIdx) return it;
            return {
              ...it,
              qty: originalQty,
              qty_source: 'reverted',
              qty_before_correction: undefined,
            };
          });
          return { ...s, items: updatedItems };
        }),
      );
    },
    [],
  );

  const handleRequestRescan = useCallback((setId: string, pageIdx: number) => {
    setRegionExtractSetId(setId);
    setRegionExtractPageIdx(pageIdx);
    setRegionExtractMode("items");
    setRegionExtractTriggerDoor(null);
  }, []);

  const handleRequestFieldRescan = useCallback(
    (setId: string, pageIdx: number, doorNumber: string) => {
      setRegionExtractSetId(setId);
      setRegionExtractPageIdx(pageIdx);
      setRegionExtractMode("field");
      setRegionExtractTriggerDoor(doorNumber);
    },
    [],
  );

  // Tier-1 "Fix missing field" batch action, triggered from the set header
  // when residual gaps exist after the Prompt 2 extraction-time join.
  // Calls the server with propagate=true + every door in the set missing
  // any metadata field. If the heading-page re-parse surfaces anything,
  // open the propagation modal immediately (zero-click fix). If not,
  // fall back to the manual region selector so the user can draw a box.
  //
  // Alternative considered: skip tier-1 and always open the region
  // selector. Rejected — tier-1 catches the "parser just needed a
  // retry with wider x_tolerance" case without making the user draw.
  const handleBatchFixMissing = useCallback(
    async (setId: string, pageIdx: number) => {
      const setInfo = setMap.get(setId);
      const setKey = setInfo?.set_id ?? setId;

      const missingDoors = doors.filter((d) => {
        const doorSetId =
          doorToSetMap.get(normalizeDoorNumber(d.door_number))?.set_id ?? d.hw_set;
        if (doorSetId !== setKey) return false;
        return (
          !(d.location ?? '').trim() ||
          !(d.hand ?? '').trim() ||
          !(d.fire_rating ?? '').trim()
        );
      });
      if (missingDoors.length === 0) return;

      const targetDoorNumbers = missingDoors.map((d) => d.door_number);
      try {
        const resp = await fetch('/api/parse-pdf/region-extract', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            projectId,
            page: pageIdx,
            bbox: { x0: 0, y0: 0, x1: 1, y1: 1 },
            setId: setKey,
            mode: 'field',
            targetDoorNumbers,
            propagate: true,
          }),
        });
        if (!resp.ok) throw new Error(`region-extract status ${resp.status}`);
        const json = (await resp.json()) as {
          siblingFills?: Record<string, { location: string; hand: string; fire_rating: string }>;
        };
        const fills = json.siblingFills ?? {};

        // Aggregate across all three fields — only suggest a value where
        // the door is currently missing it AND the server resolved one.
        const suggestions: PropagationSuggestion[] = [];
        for (const d of missingDoors) {
          const row = fills[d.door_number];
          if (!row) continue;
          // Narrow to the three writable fields — RegionExtractField
          // also includes 'door_number' which isn't writable here.
          const fieldsToCheck = ['location', 'hand', 'fire_rating'] as const;
          for (const f of fieldsToCheck) {
            if ((d[f] ?? '').trim()) continue;
            const value = (row[f] ?? '').trim();
            if (!value) continue;
            suggestions.push({
              doorNumber: d.door_number,
              field: f,
              value,
              confidence: 0.85,
              sourceLine: `${d.door_number} → ${f.replace('_', ' ')}: ${value}`,
            });
          }
        }

        if (suggestions.length > 0) {
          // Tier-1 worked — skip the region selector entirely.
          setPropagationSuggestions({ suggestions });
          return;
        }
      } catch (err) {
        console.error('[fix-missing-field] tier-1 failed:', err);
        // Fall through to tier-2 below.
      }

      // Tier-2 fallback: open the manual region selector, seeded to the
      // first still-missing door.
      handleRequestFieldRescan(setId, pageIdx, missingDoors[0].door_number);
    },
    [projectId, setMap, doors, doorToSetMap, handleRequestFieldRescan],
  );

  const handleRescanClose = useCallback(() => {
    setRegionExtractSetId(null);
    setRegionExtractPageIdx(null);
    setRegionExtractTriggerDoor(null);
  }, []);

  // Apply a field value to a list of doors. After applying, kick off a
  // Darrin propagation scan: look at the set-page raw text for sibling doors
  // in the same set that are still missing the same field, and surface any
  // hits to the user as a suggestion modal.
  //
  // Alternative considered: auto-apply high-confidence propagation results.
  // Rejected — users consistently ask for a preview step before bulk writes
  // to data they'll sign off on (see AGENTS.md "Ask, don't guess").
  const handleFieldApply = useCallback(
    (field: RegionExtractField, value: string, doorNumbers: string[]) => {
      setDoors((prev) => applyFieldToDoors(prev, field, value, doorNumbers));
    },
    [],
  );

  const handleFieldApplyWithPropagation = useCallback(
    (field: RegionExtractField, value: string, doorNumbers: string[]) => {
      handleFieldApply(field, value, doorNumbers);

      // Only propagate when the field is propagatable (door_number isn't).
      if (field === 'door_number') return;
      if (regionExtractSetId == null || regionExtractPageIdx == null) return;

      const setInfo = setMap.get(regionExtractSetId);
      const setKey = setInfo?.set_id ?? regionExtractSetId;

      // Derive the POST-apply door state explicitly. setDoors above is
      // async — reading `doors` here would show the pre-apply snapshot
      // and could double-count doors the user just fixed if the
      // applied-set guard ever slipped. applyFieldToDoors is pure, so
      // we just run the same transform locally.
      const postApplyDoors = applyFieldToDoors(doors, field, value, doorNumbers);
      const siblingCandidates = postApplyDoors
        .filter((d) => {
          const doorSetId =
            doorToSetMap.get(normalizeDoorNumber(d.door_number))?.set_id ?? d.hw_set;
          if (doorSetId !== setKey) return false;
          return (d[field] ?? '').trim().length === 0;
        })
        .map((d) => d.door_number);

      if (siblingCandidates.length === 0) return;

      // Fire-and-forget server call with propagate=true. Python re-runs
      // the shared _extract_heading_doors_on_page parser against just
      // this page and returns siblingFills for any door it resolved.
      // One parser powers extract-time and rescan-time so regex updates
      // don't have to be duplicated on the TS side.
      (async () => {
        try {
          const resp = await fetch('/api/parse-pdf/region-extract', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              projectId,
              page: regionExtractPageIdx,
              bbox: { x0: 0, y0: 0, x1: 1, y1: 1 },
              setId: setKey,
              mode: 'field',
              targetField: field,
              targetDoorNumbers: siblingCandidates,
              propagate: true,
            }),
          });
          if (!resp.ok) return;
          const json = (await resp.json()) as {
            siblingFills?: Record<string, { location: string; hand: string; fire_rating: string }>;
          };
          const fills = json.siblingFills ?? {};
          const suggestions: PropagationSuggestion[] = [];
          for (const dn of siblingCandidates) {
            const row = fills[dn];
            if (!row) continue;
            // field is narrowed to the propagatable set above by the
            // door_number early return; the `as` cast is safe.
            const value = (row[field as 'location' | 'hand' | 'fire_rating'] ?? '').trim();
            if (!value) continue;
            suggestions.push({
              doorNumber: dn,
              field,
              value,
              confidence: 0.85,
              sourceLine: `${dn} → ${value}`,
            });
          }
          if (suggestions.length > 0) {
            setPropagationSuggestions({ suggestions });
          }
        } catch (err) {
          console.error('[darrin-propagation] server call failed:', err);
        }
      })();
    },
    [handleFieldApply, regionExtractSetId, regionExtractPageIdx, setMap, doors, doorToSetMap, projectId],
  );

  const handleAcceptPropagation = useCallback(
    (accepted: PropagationSuggestion[]) => {
      if (accepted.length === 0) {
        setPropagationSuggestions(null);
        return;
      }
      setDoors((prev) => applyPropagationSuggestions(prev, accepted));
      setPropagationSuggestions(null);
    },
    [],
  );

  return (
    <div className="flex flex-col h-full max-w-5xl mx-auto">
      <ReviewSummary
        totalDoors={totalDoors}
        highCount={highCount}
        medCount={medCount}
        lowCount={lowCount}
        hasExistingData={hasExistingData}
        issueGroups={issueGroups}
        orphanDoors={orphanDoors}
        orphanNoticeDismissed={orphanNoticeDismissed}
        onDismissOrphanNotice={() => setOrphanNoticeDismissed(true)}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
      >
        <ReviewFilters
          filterLevel={filterLevel}
          onFilterLevelChange={setFilterLevel}
          search={search}
          onSearchChange={setSearch}
        />
      </ReviewSummary>

      <div className="flex-1 overflow-y-auto min-h-0">
        {viewMode === 'door' ? (
          <DoorView
            doors={sortedDoors}
            hardwareSets={hardwareSets}
            doorToSetMap={doorToSetMap}
            setMap={setMap}
            classifyResult={classifyResult}
            pdfBuffer={pdfBuffer}
            reconciledSetMap={reconciledSetMap}
            expandedDoors={expandedDoors}
            onToggleDoor={toggleDoor}
            onRequestRescan={handleRequestRescan}
            onRequestFieldRescan={handleRequestFieldRescan}
            onRevert={handleRevert}
            collapsedLeafSections={collapsedLeafSections}
            onToggleLeafSection={toggleLeafSection}
            auditTrailOpen={auditTrailOpen}
            onToggleAuditTrail={toggleAuditTrail}
            registerRef={registerRef}
          />
        ) : viewMode === 'issue' ? (
          <IssueView
            doors={sortedDoors}
            hardwareSets={hardwareSets}
            doorToSetMap={doorToSetMap}
            setMap={setMap}
            classifyResult={classifyResult}
            pdfBuffer={pdfBuffer}
            reconciledSetMap={reconciledSetMap}
            expandedDoors={expandedDoors}
            onToggleDoor={toggleDoor}
            onRequestRescan={handleRequestRescan}
            onRequestFieldRescan={handleRequestFieldRescan}
            onRevert={handleRevert}
            collapsedLeafSections={collapsedLeafSections}
            onToggleLeafSection={toggleLeafSection}
            auditTrailOpen={auditTrailOpen}
            onToggleAuditTrail={toggleAuditTrail}
            registerRef={registerRef}
          />
        ) : (
          <SetView
            groups={groups}
            hardwareSets={hardwareSets}
            classifyResult={classifyResult}
            pdfBuffer={pdfBuffer}
            collapsedGroups={collapsedGroups}
            onToggleGroup={toggleGroup}
            previewOpen={previewOpen}
            onTogglePreview={togglePreview}
            onRequestRescan={handleRequestRescan}
            onBatchFixMissing={handleBatchFixMissing}
            reconciledSetMap={reconciledSetMap}
            auditTrailOpen={auditTrailOpen}
            onToggleAuditTrail={toggleAuditTrail}
            collapsedLeafSections={collapsedLeafSections}
            onToggleLeafSection={toggleLeafSection}
            onRevert={handleRevert}
            sortField={sortField}
            sortDir={sortDir}
            onSort={handleSort}
            editingCell={editingCell}
            editValue={editValue}
            recentlyEdited={recentlyEdited}
            onStartEdit={startEdit}
            onEditValueChange={setEditValue}
            onCommitEdit={commitEdit}
            onCancelEdit={cancelEdit}
            registerRef={registerRef}
          />
        )}
      </div>

      <WizardNav
        onBack={onBack}
        onNext={() => onComplete(doors.filter((d) => !isOrphanDoor(d)), hardwareSets)}
        nextLabel="Next"
        secondaryAction={
          onRemapColumns
            ? { label: "Remap Columns", onClick: onRemapColumns, variant: "warning" }
            : undefined
        }
      />

      {regionExtractSetId != null && regionExtractPageIdx != null && pdfBuffer && (() => {
        const activeSet = setMap.get(regionExtractSetId);
        const activeSetId = activeSet?.set_id ?? regionExtractSetId;
        const doorsInSet = doors.filter((d) => {
          const matched = doorToSetMap.get(normalizeDoorNumber(d.door_number));
          if (matched?.set_id === activeSetId) return true;
          return (d.hw_set ?? '') === activeSetId;
        });
        return (
          <InlineRescan
            projectId={projectId}
            pdfBuffer={pdfBuffer}
            setId={regionExtractSetId}
            pageIndex={regionExtractPageIdx}
            initialMode={regionExtractMode}
            triggerDoorNumber={regionExtractTriggerDoor ?? undefined}
            doorsInSet={doorsInSet}
            onClose={handleRescanClose}
            onPageChange={setRegionExtractPageIdx}
            onItemsMerged={setHardwareSets}
            onFieldApply={handleFieldApplyWithPropagation}
          />
        );
      })()}

      {propagationSuggestions && (
        <PropagationSuggestionModal
          suggestions={propagationSuggestions.suggestions}
          onAccept={handleAcceptPropagation}
          onCancel={() => setPropagationSuggestions(null)}
        />
      )}
    </div>
  );
}
