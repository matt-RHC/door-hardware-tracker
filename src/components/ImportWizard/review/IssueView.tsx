"use client";

import { useMemo, useState } from "react";
import type { DoorEntry, HardwareSet, ClassifyPagesResponse } from "../types";
import type { ReconciledHardwareSet } from "@/lib/types/reconciliation";
import { normalizeDoorNumber } from "@/lib/parse-pdf-helpers";
import DoorRow from "./DoorRow";
import DoorDetailPanel from "./DoorDetailPanel";
import { computeIssueGroups, type IssueGroup, type IssueSeverity } from "./issueGrouping";
import { computeIssueRationale } from "./darrinRationale";

interface IssueViewProps {
  doors: Array<{ door: DoorEntry; originalIndex: number }>;
  hardwareSets: HardwareSet[];
  doorToSetMap: Map<string, HardwareSet>;
  setMap: Map<string, HardwareSet>;
  classifyResult: ClassifyPagesResponse | null;
  pdfBuffer: ArrayBuffer | null;
  reconciledSetMap: Map<string, ReconciledHardwareSet>;
  expandedDoors: Set<string>;
  onToggleDoor: (key: string) => void;
  onRequestRescan: (setId: string, pageIdx: number) => void;
  onRequestFieldRescan: (setId: string, pageIdx: number, doorNumber: string) => void;
  onRevert: (setId: string, itemIdx: number, originalQty: number) => void;
  collapsedLeafSections: Set<string>;
  onToggleLeafSection: (setId: string, section: "shared" | "leaf1" | "leaf2") => void;
  auditTrailOpen: Set<string>;
  onToggleAuditTrail: (setId: string) => void;
  registerRef: (doorNumber: string, el: HTMLElement | null) => void;
}

// Severity → row-accent class. Matches the Set view severity dots in
// group headers + the card left-border convention already in globals.css.
const ACCENT_CLASS: Record<IssueSeverity, string> = {
  high: "row-accent-red",
  med: "row-accent-amber",
  soft: "row-accent-green",
};

// Header dot color. Matches the severity taxonomy used in SetView.
const DOT_CLASS: Record<IssueSeverity, string> = {
  high: "bg-danger",
  med: "bg-warning",
  soft: "bg-caution",
};

/**
 * Issue-view: groups openings by *why* they're flagged instead of by
 * hardware set. A single opening appears in every cluster it's flagged
 * for — duplication is intentional (overlapping root causes). Clean
 * openings aren't rendered anywhere.
 *
 * Grouping strategy, rationale copy, and pluralization live in the
 * helpers alongside the set-view versions so the two views stay tonally
 * consistent. This component only handles layout + expand/collapse.
 */
export default function IssueView({
  doors,
  doorToSetMap,
  setMap,
  classifyResult,
  pdfBuffer,
  reconciledSetMap,
  expandedDoors,
  onToggleDoor,
  onRequestRescan,
  onRequestFieldRescan,
  onRevert,
  collapsedLeafSections,
  onToggleLeafSection,
  auditTrailOpen,
  onToggleAuditTrail,
  registerRef,
}: IssueViewProps) {
  const groups = useMemo(() => computeIssueGroups(doors), [doors]);

  // Per-cluster collapse state is local to the view. It doesn't need
  // to persist across view mode changes — re-entering Issue view from
  // scratch should show the cluster list fresh with everything open.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  if (doors.length === 0) {
    return (
      <p className="text-tertiary text-sm text-center py-8">
        No doors match your filters.
      </p>
    );
  }
  if (groups.length === 0) {
    return (
      <p className="text-tertiary text-sm text-center py-8">
        Everything looks clean — no openings are flagged.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {groups.map((group) => (
        <IssueGroupCard
          key={group.issueKey}
          group={group}
          isCollapsed={collapsed.has(group.issueKey)}
          onToggleCollapsed={() => toggle(group.issueKey)}
          expandedDoors={expandedDoors}
          onToggleDoor={onToggleDoor}
          doorToSetMap={doorToSetMap}
          setMap={setMap}
          classifyResult={classifyResult}
          pdfBuffer={pdfBuffer}
          reconciledSetMap={reconciledSetMap}
          onRequestRescan={onRequestRescan}
          onRequestFieldRescan={onRequestFieldRescan}
          onRevert={onRevert}
          collapsedLeafSections={collapsedLeafSections}
          onToggleLeafSection={onToggleLeafSection}
          auditTrailOpen={auditTrailOpen}
          onToggleAuditTrail={onToggleAuditTrail}
          registerRef={registerRef}
        />
      ))}
    </div>
  );
}

interface IssueGroupCardProps {
  group: IssueGroup;
  isCollapsed: boolean;
  onToggleCollapsed: () => void;
  expandedDoors: Set<string>;
  onToggleDoor: (key: string) => void;
  doorToSetMap: Map<string, HardwareSet>;
  setMap: Map<string, HardwareSet>;
  classifyResult: ClassifyPagesResponse | null;
  pdfBuffer: ArrayBuffer | null;
  reconciledSetMap: Map<string, ReconciledHardwareSet>;
  onRequestRescan: (setId: string, pageIdx: number) => void;
  onRequestFieldRescan: (setId: string, pageIdx: number, doorNumber: string) => void;
  onRevert: (setId: string, itemIdx: number, originalQty: number) => void;
  collapsedLeafSections: Set<string>;
  onToggleLeafSection: (setId: string, section: "shared" | "leaf1" | "leaf2") => void;
  auditTrailOpen: Set<string>;
  onToggleAuditTrail: (setId: string) => void;
  registerRef: (doorNumber: string, el: HTMLElement | null) => void;
}

function IssueGroupCard({
  group,
  isCollapsed,
  onToggleCollapsed,
  expandedDoors,
  onToggleDoor,
  doorToSetMap,
  setMap,
  classifyResult,
  pdfBuffer,
  reconciledSetMap,
  onRequestRescan,
  onRequestFieldRescan,
  onRevert,
  collapsedLeafSections,
  onToggleLeafSection,
  auditTrailOpen,
  onToggleAuditTrail,
  registerRef,
}: IssueGroupCardProps) {
  const [darrinOpen, setDarrinOpen] = useState(false);
  const rationale = useMemo(
    () =>
      computeIssueRationale({
        issueKey: group.issueKey,
        doors: group.doors.map((d) => d.door),
        setIds: group.setIds,
      }),
    [group],
  );

  const setSummary =
    group.setIds.length === 0
      ? "No hardware set"
      : group.setIds.length === 1
      ? group.setIds[0]
      : `${group.setIds.length} sets`;

  return (
    <section
      className={`bg-surface border border-border-dim rounded-md ${ACCENT_CLASS[group.severity]} overflow-hidden`}
    >
      {/* Header */}
      <button
        onClick={onToggleCollapsed}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-surface-hover transition-colors"
        aria-expanded={!isCollapsed}
      >
        <span
          className="text-tertiary text-xs transition-transform inline-block"
          style={{ transform: isCollapsed ? "rotate(-90deg)" : "rotate(0deg)" }}
          aria-hidden="true"
        >
          ▾
        </span>
        <span className={`w-2 h-2 rounded-full ${DOT_CLASS[group.severity]}`} aria-hidden="true" />
        <span className="review-section-title">{group.label}</span>
        <span className="text-tertiary text-[12px] font-mono">
          {group.doors.length} opening{group.doors.length === 1 ? "" : "s"} &middot; {setSummary}
        </span>
      </button>

      {/* Darrin-says disclosure — only shown when there's a rationale. */}
      {!isCollapsed && rationale && (
        <div className="darrin-disclosure" data-open={darrinOpen ? "true" : "false"}>
          <button
            type="button"
            className="darrin-disclosure__button"
            onClick={() => setDarrinOpen((v) => !v)}
            aria-expanded={darrinOpen}
          >
            <span className="darrin-disclosure__caret" aria-hidden="true">
              {"\u25B8"}
            </span>
            <span>Darrin says</span>
            <span className="text-tertiary font-normal" style={{ marginLeft: "6px" }}>
              &middot; {rationale.summary}
            </span>
          </button>
          {darrinOpen && (
            <div
              className="darrin-disclosure__body"
              dangerouslySetInnerHTML={{ __html: rationale.body }}
            />
          )}
        </div>
      )}

      {/* Door rows — same DoorRow the other views use, so typography,
          chiclets, and row-accent borders stay consistent. */}
      {!isCollapsed && (
        <div className="border-t border-border-dim">
          {group.doors.map(({ door, originalIndex }) => {
            const key = `${door.door_number}-${originalIndex}`;
            const isExpanded = expandedDoors.has(key);
            const doorKey = normalizeDoorNumber(door.door_number);
            const hwSet = doorToSetMap.get(doorKey) ?? setMap.get(door.hw_set ?? "");
            const reconciledSet = hwSet ? reconciledSetMap.get(hwSet.set_id) : undefined;
            return (
              <div key={`${group.issueKey}-${key}`}>
                <DoorRow
                  door={door}
                  isExpanded={isExpanded}
                  onToggle={() => onToggleDoor(key)}
                  registerRef={registerRef}
                />
                {isExpanded && (
                  <DoorDetailPanel
                    door={door}
                    hwSet={hwSet}
                    reconciledSet={reconciledSet}
                    classifyResult={classifyResult}
                    pdfBuffer={pdfBuffer}
                    onRequestRescan={onRequestRescan}
                    onRequestFieldRescan={onRequestFieldRescan}
                    onRevert={onRevert}
                    collapsedLeafSections={collapsedLeafSections}
                    onToggleLeafSection={onToggleLeafSection}
                    auditTrailOpen={hwSet ? auditTrailOpen.has(hwSet.set_id) : false}
                    onToggleAuditTrail={() => hwSet && onToggleAuditTrail(hwSet.set_id)}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
