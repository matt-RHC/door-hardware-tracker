"use client";

import type { DoorEntry, HardwareSet, ClassifyPagesResponse } from "../types";
import type { ReconciledHardwareSet } from "@/lib/types/reconciliation";
import type { DoorGroup, DoorStringField, EditingCell, SortDir } from "./types";
import { FIELD_KEYS, FIELD_LABELS } from "./types";
import { findPageForSet } from "@/lib/punch-cards";
import PDFPagePreview from "../PDFPagePreview";
import SetPanel from "./SetPanel";
import DarrinSays from "./DarrinSays";
import { confBorder, getConfidence } from "./utils";

interface SetViewProps {
  groups: DoorGroup[];
  hardwareSets: HardwareSet[];
  classifyResult: ClassifyPagesResponse | null;
  pdfBuffer: ArrayBuffer | null;
  collapsedGroups: Set<string>;
  onToggleGroup: (setId: string) => void;
  previewOpen: Set<string>;
  onTogglePreview: (setId: string) => void;
  onRequestRescan: (setId: string, pageIdx: number) => void;
  /**
   * Tier-1 batch "Fix missing field" — asks the server to re-parse the
   * heading page. The parent handles tier-2 fallback (opening the region
   * selector) when the server's re-parse comes up empty.
   */
  onBatchFixMissing: (setId: string, pageIdx: number) => void;
  reconciledSetMap: Map<string, ReconciledHardwareSet>;
  auditTrailOpen: Set<string>;
  onToggleAuditTrail: (setId: string) => void;
  collapsedLeafSections: Set<string>;
  onToggleLeafSection: (setId: string, section: 'shared' | 'leaf1' | 'leaf2') => void;
  onRevert: (setId: string, itemIdx: number, originalQty: number) => void;
  sortField: DoorStringField;
  sortDir: SortDir;
  onSort: (field: DoorStringField) => void;
  editingCell: EditingCell | null;
  editValue: string;
  /** Set for ~1.5s after a commit to drive the just-edited flash. */
  recentlyEdited: EditingCell | null;
  onStartEdit: (originalIndex: number, field: DoorStringField) => void;
  onEditValueChange: (value: string) => void;
  onCommitEdit: () => void;
  onCancelEdit: () => void;
  registerRef: (doorNumber: string, el: HTMLElement | null) => void;
}

export default function SetView(props: SetViewProps) {
  const {
    groups,
    hardwareSets,
    classifyResult,
    pdfBuffer,
    collapsedGroups,
    onToggleGroup,
    previewOpen,
    onTogglePreview,
    onRequestRescan,
    onBatchFixMissing,
    reconciledSetMap,
    auditTrailOpen,
    onToggleAuditTrail,
    collapsedLeafSections,
    onToggleLeafSection,
    onRevert,
    sortField,
    sortDir,
    onSort,
    editingCell,
    editValue,
    recentlyEdited,
    onStartEdit,
    onEditValueChange,
    onCommitEdit,
    onCancelEdit,
    registerRef,
  } = props;

  if (groups.length === 0) {
    return (
      <p className="text-tertiary text-sm text-center py-8">
        No doors match your filters.
      </p>
    );
  }

  return (
    <>
      {groups.map((group) => {
        const isCollapsed = collapsedGroups.has(group.setId);
        const isPreviewOpen = previewOpen.has(group.setId);
        const pdfPageIdx =
          classifyResult?.pages && pdfBuffer
            ? (findPageForSet(group.setId, classifyResult.pages) ??
               (() => {
                 const set = hardwareSets.find(
                   (s) => s.set_id === group.setId || s.generic_set_id === group.setId,
                 );
                 const altId = set?.generic_set_id ?? set?.set_id;
                 return altId ? findPageForSet(altId, classifyResult.pages) : null;
               })())
            : null;

        const hwSet = hardwareSets.find(
          (s) => s.set_id === group.setId || s.generic_set_id === group.setId,
        );
        const firstDoor = group.doors[0]?.door;
        const firstDoorInfo = firstDoor
          ? { door_type: firstDoor.door_type, location: firstDoor.location }
          : undefined;
        const reconciledSet = hwSet ? reconciledSetMap.get(hwSet.set_id) : undefined;

        return (
          <div key={group.setId} className="mb-3">
            {/* Group header */}
            <button
              onClick={() => onToggleGroup(group.setId)}
              className="group-header w-full mb-0.5"
            >
              <span
                className="text-tertiary text-xs transition-transform inline-block"
                style={{ transform: isCollapsed ? "rotate(-90deg)" : "rotate(0deg)" }}
              >
                ▾
              </span>
              <span className="text-accent font-mono text-sm font-medium">
                {group.setId}
              </span>
              {group.heading && (
                <span className="text-tertiary text-xs truncate">
                  {group.heading}
                </span>
              )}
              <span className="ml-auto text-tertiary text-xs">
                {group.doors.length} doors
              </span>
              <span className="flex items-center gap-1 ml-2">
                {group.highCount > 0 && (
                  <span
                    className="w-2 h-2 rounded-full bg-success"
                    title={`${group.highCount} ready`}
                  />
                )}
                {group.medCount > 0 && (
                  <span
                    className="w-2 h-2 rounded-full bg-warning"
                    title={`${group.medCount} need attention`}
                  />
                )}
                {group.lowCount > 0 && (
                  <span
                    className="w-2 h-2 rounded-full bg-danger"
                    title={`${group.lowCount} missing data`}
                  />
                )}
              </span>
            </button>

            {/* Per-group rationale — quietly collapses to nothing when
                the group has no flagged openings, so clean sets stay clean. */}
            <DarrinSays group={group} />

            {/* PDF preview toggle + region re-scan — only when we have PDF data and a valid page */}
            {pdfBuffer && pdfPageIdx != null && (
              <div className="mb-1 flex items-center gap-2 flex-wrap">
                <button
                  onClick={() => onTogglePreview(group.setId)}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-accent-dim border border-accent text-accent text-[11px] font-medium hover:bg-tint-strong transition-colors min-h-9 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  aria-label={isPreviewOpen ? "Hide PDF page" : "View PDF page"}
                >
                  <span aria-hidden="true">{isPreviewOpen ? "\u25BE" : "\u25B8"}</span>
                  <span>{isPreviewOpen ? "Hide" : "View"} PDF page {pdfPageIdx + 1}</span>
                </button>
                <button
                  onClick={() => onRequestRescan(group.setId, pdfPageIdx)}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-tint border border-border-dim text-secondary text-[11px] font-medium hover:bg-tint-strong transition-colors min-h-9"
                >
                  Re-scan region
                </button>
                {(() => {
                  // "Fix missing field" — exception-handling entry point.
                  // This button's presence is itself the signal that
                  // residual post-Prompt-2 gaps exist; if every door has
                  // location+hand+fire_rating, it disappears entirely
                  // (the Prompt 2 extraction-time join handled them).
                  //
                  // Click routes to tier-1 (server re-parse) in the
                  // parent; tier-1 falls back to the region selector
                  // when it comes up empty. See handleBatchFixMissing
                  // in StepReview.tsx for the full decision tree.
                  const firstMissing = group.doors.find(({ door: d }) =>
                    !d.location?.trim() || !d.hand?.trim() || !d.fire_rating?.trim()
                  );
                  if (!firstMissing) return null;
                  return (
                    <button
                      onClick={() => onBatchFixMissing(group.setId, pdfPageIdx)}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-warning/10 border border-warning/40 text-warning text-[11px] font-medium hover:bg-warning/20 transition-colors min-h-9"
                    >
                      Fix missing field
                    </button>
                  );
                })()}
              </div>
            )}

            {/* PDF page preview (lazy-mounted to save memory) */}
            {isPreviewOpen && pdfBuffer && pdfPageIdx != null && (
              <div className="mb-2 max-w-full md:max-w-2xl">
                <PDFPagePreview
                  pdfBuffer={pdfBuffer}
                  pageIndex={pdfPageIdx}
                  label={`${group.setId} — Hardware set definition`}
                />
              </div>
            )}

            {/* Per-set hardware summary */}
            {!isCollapsed && hwSet && (
              <SetPanel
                hwSet={hwSet}
                firstDoorInfo={firstDoorInfo}
                collapsedLeafSections={collapsedLeafSections}
                onToggleLeafSection={onToggleLeafSection}
                onRevert={onRevert}
                reconciledSet={reconciledSet}
                auditTrailOpen={auditTrailOpen.has(hwSet.set_id)}
                onToggleAuditTrail={() => onToggleAuditTrail(hwSet.set_id)}
              />
            )}

            {/* Group table */}
            {!isCollapsed && (
              <div className="overflow-x-auto border border-border-dim rounded-lg">
                <table className="w-full">
                  <thead>
                    <tr className="bg-tint sticky top-0 z-10 shadow-[0_1px_0_var(--border-dim)]">
                      {FIELD_KEYS.map((field) => (
                        <th
                          key={field}
                          onClick={() => onSort(field)}
                          className="px-3 py-2 text-left text-[11px] text-tertiary uppercase font-semibold cursor-pointer hover:text-secondary select-none"
                        >
                          {FIELD_LABELS[field]}
                          {sortField === field && (
                            <span className="ml-1 text-accent">
                              {sortDir === "asc" ? "▲" : "▼"}
                            </span>
                          )}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {group.doors.map(({ door, originalIndex }, i) => (
                      <DoorTableRow
                        key={`${door.door_number}-${originalIndex}`}
                        door={door}
                        originalIndex={originalIndex}
                        rowIndex={i}
                        editingCell={editingCell}
                        editValue={editValue}
                        recentlyEdited={recentlyEdited}
                        onStartEdit={onStartEdit}
                        onEditValueChange={onEditValueChange}
                        onCommitEdit={onCommitEdit}
                        onCancelEdit={onCancelEdit}
                        registerRef={registerRef}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

interface DoorTableRowProps {
  door: DoorEntry;
  originalIndex: number;
  rowIndex: number;
  editingCell: EditingCell | null;
  editValue: string;
  recentlyEdited: EditingCell | null;
  onStartEdit: (originalIndex: number, field: DoorStringField) => void;
  onEditValueChange: (value: string) => void;
  onCommitEdit: () => void;
  onCancelEdit: () => void;
  registerRef: (doorNumber: string, el: HTMLElement | null) => void;
}

function DoorTableRow({
  door,
  originalIndex,
  rowIndex,
  editingCell,
  editValue,
  recentlyEdited,
  onStartEdit,
  onEditValueChange,
  onCommitEdit,
  onCancelEdit,
  registerRef,
}: DoorTableRowProps) {
  // Auto-approved rows (≥0.85) recede visually so the eye lands on rows
  // that still need human attention. The row-accent border communicates
  // WHY the row is quiet (it passed); opacity communicates HOW much to
  // care right now. We keep cells editable on purpose — users can still
  // correct auto-approved rows; they just shouldn't draw attention.
  const isAutoApproved = getConfidence(door) === "high";

  return (
    <tr
      ref={(el) => {
        if (door.door_number) registerRef(door.door_number, el);
      }}
      className={`${confBorder(door)} border-t border-border-dim hover:bg-tint transition-colors duration-150 ${
        rowIndex % 2 === 1 ? "bg-tint" : ""
      } ${isAutoApproved ? "opacity-70" : ""}`}
      style={{ minHeight: "40px" }}
    >
      {FIELD_KEYS.map((field) => {
        const isEditing =
          editingCell?.row === originalIndex && editingCell?.field === field;
        const isJustEdited =
          recentlyEdited?.row === originalIndex &&
          recentlyEdited?.field === field;
        // Door number is the primary wayfinding column — full weight and
        // tabular-nums so e.g. "101A / 102 / 10" align on decimal glyphs.
        const isPrimary = field === "door_number";
        return (
          <td
            key={field}
            // Just-edited flash: commitEdit sets recentlyEdited for 1.5s
            // so the user sees a soft success tint confirming the keystroke
            // landed. No API save happens here — the flash is the only
            // feedback in this client-state-only edit path. Wrapped in
            // motion-safe so reduced-motion users still see the flash
            // but without the 500ms cross-fade.
            className={`px-4 py-3 motion-safe:transition-colors motion-safe:duration-500 ${
              isJustEdited ? "bg-success-dim" : ""
            }`}
          >
            {isEditing ? (
              /* In-edit state: input inherits the focus-visible ring the
                 shared input-field styling would provide; we spell it out
                 here because the existing class sets focus:outline-none. */
              <input
                autoFocus
                type="text"
                value={editValue}
                onChange={(e) => onEditValueChange(e.target.value)}
                onBlur={onCommitEdit}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onCommitEdit();
                  if (e.key === "Escape") onCancelEdit();
                }}
                className="w-full bg-tint-strong border border-accent rounded px-2 py-1 text-primary text-[13px] focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface"
              />
            ) : (
              /* Idle state carrying four overlapping affordances:
                 - default: quiet, no border
                 - hover: bg-surface-raised/30 cues interactivity
                 - focus-visible: 2px accent ring (keyboard users)
                 - auto-approved: title attribute explains reduced salience
                 spans are keyboard-inert by default, so tabIndex + keydown
                 wires Enter/Space to the same startEdit the click uses. */
              <span
                role="button"
                tabIndex={0}
                onClick={() => onStartEdit(originalIndex, field)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onStartEdit(originalIndex, field);
                  }
                }}
                title={
                  isAutoApproved
                    ? "Auto-approved — edits still land but are low-priority"
                    : undefined
                }
                className={`inline-block rounded-sm px-1 -mx-1 cursor-pointer text-[13px] font-mono tabular-nums transition-colors duration-150 hover:bg-surface-raised/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent focus:outline-none ${
                  isPrimary ? "font-semibold" : ""
                } ${
                  door[field]
                    ? "text-primary"
                    : "text-tertiary border-b border-dashed border-tertiary/30"
                }`}
              >
                {door[field] || "\u00A0"}
              </span>
            )}
          </td>
        );
      })}
    </tr>
  );
}
