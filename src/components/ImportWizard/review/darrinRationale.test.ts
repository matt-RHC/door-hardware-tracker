import { describe, it, expect } from "vitest";
import { computeGroupRationale } from "./darrinRationale";
import type { DoorEntry } from "../types";
import type { DoorGroup } from "./types";

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

/**
 * Build a DoorGroup for a test. `counts` lets each case declare the
 * high/med/low split explicitly — the real grouper's classifier has its
 * own thresholds and reproducing it here would mean testing it twice.
 * The rationale helper only reads `medCount + lowCount` as a
 * short-circuit anyway; the per-door `getDoorIssues` call drives the
 * body text, so making counts explicit keeps fixtures small.
 */
function makeGroup(
  doors: DoorEntry[],
  counts: { high?: number; med?: number; low?: number } = {},
  setId = "DH1-10",
): DoorGroup {
  const med = counts.med ?? doors.length;
  return {
    setId,
    heading: "",
    doors: doors.map((door, originalIndex) => ({ door, originalIndex })),
    highCount: counts.high ?? 0,
    medCount: med,
    lowCount: counts.low ?? 0,
  };
}

describe("computeGroupRationale", () => {
  it("returns null when the group has no flagged openings", () => {
    const group = makeGroup(
      [makeDoor({ door_number: "100" }), makeDoor({ door_number: "101" })],
      { high: 2, med: 0, low: 0 },
    );
    expect(computeGroupRationale(group)).toBeNull();
  });

  it("surfaces the dominant missing-field issue in the body", () => {
    const group = makeGroup(
      [
        makeDoor({ door_number: "100", location: "" }),
        makeDoor({ door_number: "101", location: "" }),
        makeDoor({ door_number: "102", location: "" }),
      ],
      { high: 0, med: 3, low: 0 },
      "DH1-10",
    );
    const r = computeGroupRationale(group);
    expect(r).not.toBeNull();
    expect(r!.body).toContain("3");
    expect(r!.body).toContain("location");
    expect(r!.body).toContain("<code>DH1-10</code>");
    expect(r!.summary).toContain("3");
    expect(r!.summary).toContain("location");
  });

  it("uses singular phrasing when only one opening is flagged", () => {
    const group = makeGroup(
      [
        makeDoor({ door_number: "100", hand: "" }),
        makeDoor({ door_number: "101" }),
      ],
      { high: 1, med: 1, low: 0 },
    );
    const r = computeGroupRationale(group);
    expect(r).not.toBeNull();
    expect(r!.body).toMatch(/1 opening/);
    // Pluralization matters: "1 opening is missing", not "1 opening are"
    expect(r!.body).toMatch(/\bis\b/);
    expect(r!.body).not.toMatch(/\bare\b/);
  });

  it("mentions low-confidence issues with softer copy", () => {
    const group = makeGroup(
      [
        makeDoor({
          door_number: "100",
          field_confidence: { hand: 0.3 },
        }),
        makeDoor({
          door_number: "101",
          field_confidence: { hand: 0.4 },
        }),
      ],
      { high: 0, med: 2, low: 0 },
    );
    const r = computeGroupRationale(group);
    expect(r).not.toBeNull();
    expect(r!.body.toLowerCase()).toContain("uncertain");
    expect(r!.body.toLowerCase()).toContain("hand");
  });

  it("combines two top issues when they're close in frequency", () => {
    const group = makeGroup(
      [
        makeDoor({ door_number: "100", location: "", hand: "" }),
        makeDoor({ door_number: "101", location: "" }),
      ],
      { high: 0, med: 2, low: 0 },
    );
    const r = computeGroupRationale(group);
    expect(r).not.toBeNull();
    // missing_location (2) + missing_hand (1) — both surface
    expect(r!.body).toContain("location");
    expect(r!.body).toContain("hand");
  });

  it("falls back to a generic line when issue keys aren't in the template map", () => {
    // medCount > 0 but every door has no emitted issue keys — mimicked
    // by giving doors an unknown-key field_confidence entry below 0.6.
    const group: DoorGroup = {
      setId: "DH2-00",
      heading: "",
      doors: [
        { door: makeDoor({ door_number: "100" }), originalIndex: 0 },
        { door: makeDoor({ door_number: "101" }), originalIndex: 1 },
      ],
      highCount: 0,
      medCount: 2,
      lowCount: 0,
    };
    const r = computeGroupRationale(group);
    expect(r).not.toBeNull();
    expect(r!.body).toContain("2");
    expect(r!.body).toContain("DH2-00");
  });
});
