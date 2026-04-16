"use client";

import { useState, useCallback, useEffect, useMemo } from "react";
import { usePunchHighlight } from "./usePunchHighlight";
import type { DoorEntry, HardwareSet, ClassifyPagesResponse } from "./types";
import type { ReconciliationResult, ReconciledHardwareSet } from "@/lib/types/reconciliation";
import { buildDoorToSetMap, normalizeDoorNumber } from "@/lib/parse-pdf-helpers";
import WizardNav from "./WizardNav";
import ReviewSummary from "./review/ReviewSummary";
import ReviewFilters from "./review/ReviewFilters";
import SetView from "./review/SetView";
import InlineRescan from "./review/InlineRescan";
import { isOrphanDoor, getDoorIssues, getConfidence } from "./review/utils";
import type {
  DoorGroup,
  DoorStringField,
  EditingCell,
  FilterLevel,
  SortDir,
} from "./review/types";

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

  const [editingCell, setEditingCell] = useState<EditingCell | null>(null);
  const [editValue, setEditValue] = useState("");

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
    setDoors((prev) => {
      const next = [...prev];
      next[editingCell.row] = {
        ...next[editingCell.row],
        [editingCell.field]: editValue,
      };
      return next;
    });
    setEditingCell(null);
    setEditValue("");
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
  }, []);

  const handleRescanClose = useCallback(() => {
    setRegionExtractSetId(null);
    setRegionExtractPageIdx(null);
  }, []);

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
      >
        <ReviewFilters
          filterLevel={filterLevel}
          onFilterLevelChange={setFilterLevel}
          search={search}
          onSearchChange={setSearch}
        />
      </ReviewSummary>

      <div className="flex-1 overflow-y-auto min-h-0">
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
          onStartEdit={startEdit}
          onEditValueChange={setEditValue}
          onCommitEdit={commitEdit}
          onCancelEdit={cancelEdit}
          registerRef={registerRef}
        />
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

      {regionExtractSetId != null && regionExtractPageIdx != null && pdfBuffer && (
        <InlineRescan
          projectId={projectId}
          pdfBuffer={pdfBuffer}
          setId={regionExtractSetId}
          pageIndex={regionExtractPageIdx}
          onClose={handleRescanClose}
          onPageChange={setRegionExtractPageIdx}
          onItemsMerged={setHardwareSets}
        />
      )}
    </div>
  );
}
