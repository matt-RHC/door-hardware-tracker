import { describe, it, expect } from "vitest";
import { bulkApplyField, isBulkFixField, BULK_FIX_FIELDS } from "./bulk-apply";
import type { DoorEntry } from "../types";

function makeDoor(partial: Partial<DoorEntry> = {}): DoorEntry {
  return {
    door_number: partial.door_number ?? "100",
    hw_set: partial.hw_set ?? "DH1-10",
    hw_heading: partial.hw_heading ?? "",
    location: partial.location ?? "",
    door_type: partial.door_type ?? "A",
    frame_type: partial.frame_type ?? "HM",
    fire_rating: partial.fire_rating ?? "90Min",
    hand: partial.hand ?? "LH",
    field_confidence: partial.field_confidence,
    by_others: partial.by_others,
    leaf_count: partial.leaf_count,
  };
}

describe("isBulkFixField", () => {
  it("accepts every field in BULK_FIX_FIELDS", () => {
    for (const f of BULK_FIX_FIELDS) {
      expect(isBulkFixField(f)).toBe(true);
    }
  });

  it("rejects non-bulk-writable fields", () => {
    expect(isBulkFixField("door_number")).toBe(false);
    expect(isBulkFixField("hw_set")).toBe(false);
    expect(isBulkFixField("hw_heading")).toBe(false);
    expect(isBulkFixField("")).toBe(false);
    expect(isBulkFixField("not_a_field")).toBe(false);
  });
});

describe("bulkApplyField", () => {
  it("writes value to every matching door", () => {
    const doors = [
      makeDoor({ door_number: "100" }),
      makeDoor({ door_number: "101" }),
      makeDoor({ door_number: "102" }),
    ];
    const next = bulkApplyField(doors, "location", "Corridor 100", ["100", "102"]);
    expect(next[0].location).toBe("Corridor 100");
    expect(next[1].location).toBe(""); // not in target list
    expect(next[2].location).toBe("Corridor 100");
  });

  it("bumps field_confidence to 1.0 for the written field", () => {
    const doors = [
      makeDoor({
        door_number: "100",
        field_confidence: { location: 0.3, hand: 0.5 },
      }),
    ];
    const next = bulkApplyField(doors, "location", "Corridor 5", ["100"]);
    expect(next[0].field_confidence).toEqual({ location: 1.0, hand: 0.5 });
  });

  it("initializes field_confidence when absent", () => {
    const doors = [makeDoor({ door_number: "100" })];
    const next = bulkApplyField(doors, "hand", "LHR", ["100"]);
    expect(next[0].field_confidence).toEqual({ hand: 1.0 });
  });

  it("returns the same array reference when nothing changes", () => {
    const doors = [
      makeDoor({
        door_number: "100",
        location: "Corridor 5",
        field_confidence: { location: 1.0 },
      }),
    ];
    const next = bulkApplyField(doors, "location", "Corridor 5", ["100"]);
    // Same value + already at manual-apply confidence → no-op short-circuit.
    expect(next).toBe(doors);
  });

  it("re-writes when the value matches but confidence is stale", () => {
    const doors = [
      makeDoor({
        door_number: "100",
        location: "Corridor 5",
        field_confidence: { location: 0.4 },
      }),
    ];
    const next = bulkApplyField(doors, "location", "Corridor 5", ["100"]);
    // Same value, but the low-confidence flag needs to clear. New
    // array returned; confidence bumped.
    expect(next).not.toBe(doors);
    expect(next[0].field_confidence?.location).toBe(1.0);
  });

  it("no-ops when the target list is empty", () => {
    const doors = [makeDoor({ door_number: "100" })];
    expect(bulkApplyField(doors, "location", "x", [])).toBe(doors);
  });

  it("ignores target door_numbers that aren't in the doors array", () => {
    const doors = [makeDoor({ door_number: "100" })];
    const next = bulkApplyField(doors, "location", "Corridor 5", ["999"]);
    expect(next).toBe(doors);
  });

  it("handles door_type and frame_type (beyond the rescan-apply set)", () => {
    const doors = [
      makeDoor({ door_number: "100", door_type: "", frame_type: "" }),
    ];
    const afterType = bulkApplyField(doors, "door_type", "A", ["100"]);
    expect(afterType[0].door_type).toBe("A");
    const afterFrame = bulkApplyField(afterType, "frame_type", "HM", ["100"]);
    expect(afterFrame[0].frame_type).toBe("HM");
  });
});
