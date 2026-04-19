import { describe, it, expect } from "vitest";
import { computeIssueGroups } from "./issueGrouping";
import type { DoorEntry } from "../types";

function makeDoor(partial: Partial<DoorEntry> = {}): DoorEntry {
  return {
    door_number: partial.door_number ?? "100",
    hw_set: partial.hw_set ?? "DH1-10",
    hw_heading: partial.hw_heading ?? "",
    location: partial.location ?? "Corridor 100",
    door_type: partial.door_type ?? "A",
    frame_type: partial.frame_type ?? "HM",
    fire_rating: partial.fire_rating ?? "90Min",
    hand: partial.hand ?? "LH",
    field_confidence: partial.field_confidence,
    by_others: partial.by_others,
    leaf_count: partial.leaf_count,
  };
}

function entry(door: DoorEntry, originalIndex: number) {
  return { door, originalIndex };
}

describe("computeIssueGroups", () => {
  it("returns no groups when every door is clean", () => {
    const groups = computeIssueGroups([
      entry(makeDoor({ door_number: "100" }), 0),
      entry(makeDoor({ door_number: "101" }), 1),
    ]);
    expect(groups).toEqual([]);
  });

  it("buckets doors with the same issue into a single cluster", () => {
    const groups = computeIssueGroups([
      entry(makeDoor({ door_number: "100", location: "" }), 0),
      entry(makeDoor({ door_number: "101", location: "" }), 1),
      entry(makeDoor({ door_number: "102", location: "" }), 2),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].issueKey).toBe("missing_location");
    expect(groups[0].doors).toHaveLength(3);
    expect(groups[0].severity).toBe("med");
  });

  it("a door with multiple flags lands in every matching cluster", () => {
    const groups = computeIssueGroups([
      entry(makeDoor({ door_number: "100", location: "", hand: "" }), 0),
    ]);
    const keys = groups.map((g) => g.issueKey).sort();
    expect(keys).toEqual(["missing_hand", "missing_location"]);
    // Single door present in both clusters.
    expect(groups[0].doors).toHaveLength(1);
    expect(groups[1].doors).toHaveLength(1);
  });

  it("ranks missing-required as high severity ahead of other issues", () => {
    const groups = computeIssueGroups([
      entry(makeDoor({ door_number: "", hw_set: "DH1" }), 0),
      entry(makeDoor({ door_number: "101", location: "" }), 1),
      entry(
        makeDoor({
          door_number: "102",
          field_confidence: { hand: 0.3 },
        }),
        2,
      ),
    ]);
    // Expected order: high (missing_door_number) → med (missing_location) → soft (low_confidence_hand)
    expect(groups[0].issueKey).toBe("missing_door_number");
    expect(groups[0].severity).toBe("high");
    expect(groups[1].severity).toBe("med");
    expect(groups[2].severity).toBe("soft");
  });

  it("within a severity tier, larger clusters come first", () => {
    const groups = computeIssueGroups([
      entry(makeDoor({ door_number: "100", location: "" }), 0),
      entry(makeDoor({ door_number: "101", location: "" }), 1),
      entry(makeDoor({ door_number: "102", hand: "" }), 2),
    ]);
    const both = groups.filter((g) => g.severity === "med");
    expect(both[0].issueKey).toBe("missing_location");
    expect(both[0].doors.length).toBe(2);
    expect(both[1].issueKey).toBe("missing_hand");
    expect(both[1].doors.length).toBe(1);
  });

  it("collects distinct hardware-set ids per cluster in first-seen order", () => {
    const groups = computeIssueGroups([
      entry(makeDoor({ door_number: "100", hw_set: "DH1", location: "" }), 0),
      entry(makeDoor({ door_number: "101", hw_set: "DH2", location: "" }), 1),
      // same set id as the first door — shouldn't duplicate
      entry(makeDoor({ door_number: "102", hw_set: "DH1", location: "" }), 2),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].setIds).toEqual(["DH1", "DH2"]);
  });

  it("extracts the field name from missing_* and low_confidence_* keys", () => {
    const groups = computeIssueGroups([
      entry(makeDoor({ door_number: "100", location: "" }), 0),
      entry(
        makeDoor({
          door_number: "101",
          field_confidence: { fire_rating: 0.2 },
        }),
        1,
      ),
    ]);
    const byKey = new Map(groups.map((g) => [g.issueKey, g.field]));
    expect(byKey.get("missing_location")).toBe("location");
    expect(byKey.get("low_confidence_fire_rating")).toBe("fire_rating");
  });
});
