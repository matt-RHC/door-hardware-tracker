"use client";

import type { DoorEntry, HardwareSet, ClassifyPagesResponse } from "../types";
import type { ReconciledHardwareSet } from "@/lib/types/reconciliation";
import { normalizeDoorNumber } from "@/lib/parse-pdf-helpers";
import DoorRow from "./DoorRow";
import DoorDetailPanel from "./DoorDetailPanel";

interface DoorViewProps {
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
  onToggleLeafSection: (setId: string, section: 'shared' | 'leaf1' | 'leaf2') => void;
  auditTrailOpen: Set<string>;
  onToggleAuditTrail: (setId: string) => void;
  registerRef: (doorNumber: string, el: HTMLElement | null) => void;
}

export default function DoorView({
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
}: DoorViewProps) {
  if (doors.length === 0) {
    return (
      <p className="text-tertiary text-sm text-center py-8">
        No doors match your filters.
      </p>
    );
  }

  return (
    <div className="border border-border-dim rounded-lg overflow-hidden">
      {doors.map(({ door, originalIndex }) => {
        const key = `${door.door_number}-${originalIndex}`;
        const isExpanded = expandedDoors.has(key);
        const doorKey = normalizeDoorNumber(door.door_number);
        const hwSet = doorToSetMap.get(doorKey) ?? setMap.get(door.hw_set ?? '');
        const reconciledSet = hwSet ? reconciledSetMap.get(hwSet.set_id) : undefined;

        return (
          <div key={key}>
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
  );
}
