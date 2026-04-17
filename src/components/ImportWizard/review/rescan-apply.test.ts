import { describe, it, expect } from "vitest";
import type { DoorEntry } from "../types";
import type { PropagationSuggestion } from "@/lib/types";
import { applyFieldToDoors, applyPropagationSuggestions } from "./rescan-apply";

const makeDoor = (over: Partial<DoorEntry> = {}): DoorEntry => ({
  door_number: "110.1",
  hw_set: "H01",
  location: "",
  door_type: "",
  frame_type: "",
  fire_rating: "",
  hand: "",
  ...over,
});

describe("applyFieldToDoors", () => {
  it("applies a location value to the targeted doors only", () => {
    const doors: DoorEntry[] = [
      makeDoor({ door_number: "110.1" }),
      makeDoor({ door_number: "113" }),
      makeDoor({ door_number: "114" }),
    ];
    const out = applyFieldToDoors(doors, "location", "ROOM 101 TO CORRIDOR", ["110.1", "113"]);
    expect(out[0].location).toBe("ROOM 101 TO CORRIDOR");
    expect(out[1].location).toBe("ROOM 101 TO CORRIDOR");
    expect(out[2].location).toBe("");
  });

  it("applies hand", () => {
    const doors: DoorEntry[] = [makeDoor({ door_number: "110.1" })];
    const out = applyFieldToDoors(doors, "hand", "RH", ["110.1"]);
    expect(out[0].hand).toBe("RH");
  });

  it("ignores door_number field (not editable via rescan)", () => {
    const doors: DoorEntry[] = [makeDoor({ door_number: "110.1" })];
    const out = applyFieldToDoors(doors, "door_number", "999", ["110.1"]);
    expect(out).toBe(doors); // returns the input reference unchanged
    expect(out[0].door_number).toBe("110.1");
  });

  it("returns the input reference when no doors match", () => {
    const doors: DoorEntry[] = [makeDoor({ door_number: "110.1" })];
    const out = applyFieldToDoors(doors, "location", "X", ["999"]);
    expect(out).toBe(doors);
  });

  it("returns input reference when value matches existing value (no-op)", () => {
    const doors: DoorEntry[] = [makeDoor({ door_number: "110.1", location: "X" })];
    const out = applyFieldToDoors(doors, "location", "X", ["110.1"]);
    expect(out).toBe(doors);
  });
});

describe("applyPropagationSuggestions", () => {
  it("applies suggestions to matching doors", () => {
    const doors: DoorEntry[] = [
      makeDoor({ door_number: "113" }),
      makeDoor({ door_number: "114" }),
      makeDoor({ door_number: "115.3" }),
    ];
    const suggestions: PropagationSuggestion[] = [
      { doorNumber: "113", field: "location", value: "KITCHEN", confidence: 0.6, sourceLine: "113 KITCHEN" },
      { doorNumber: "114", field: "location", value: "STAIR", confidence: 0.6, sourceLine: "114 STAIR" },
    ];
    const out = applyPropagationSuggestions(doors, suggestions);
    expect(out[0].location).toBe("KITCHEN");
    expect(out[1].location).toBe("STAIR");
    expect(out[2].location).toBe("");
  });

  it("ignores door_number suggestions", () => {
    const doors: DoorEntry[] = [makeDoor({ door_number: "113" })];
    const suggestions: PropagationSuggestion[] = [
      { doorNumber: "113", field: "door_number", value: "999", confidence: 0.6, sourceLine: "113" },
    ];
    const out = applyPropagationSuggestions(doors, suggestions);
    expect(out).toBe(doors);
  });

  it("applies multiple fields for the same door in one pass", () => {
    // The tier-1 batch "Fix missing field" path can return
    // location + hand + fire_rating for the same door. An earlier
    // revision collapsed this to one-per-door and silently dropped
    // the rest — this test pins the multi-field behavior.
    const doors: DoorEntry[] = [makeDoor({ door_number: "113" })];
    const suggestions: PropagationSuggestion[] = [
      { doorNumber: "113", field: "location", value: "KITCHEN", confidence: 0.85, sourceLine: "" },
      { doorNumber: "113", field: "hand", value: "RH", confidence: 0.85, sourceLine: "" },
      { doorNumber: "113", field: "fire_rating", value: "90Min", confidence: 0.85, sourceLine: "" },
    ];
    const out = applyPropagationSuggestions(doors, suggestions);
    expect(out[0].location).toBe("KITCHEN");
    expect(out[0].hand).toBe("RH");
    expect(out[0].fire_rating).toBe("90Min");
  });

  it("first suggestion wins when the same (door, field) appears twice", () => {
    const doors: DoorEntry[] = [makeDoor({ door_number: "113" })];
    const suggestions: PropagationSuggestion[] = [
      { doorNumber: "113", field: "location", value: "KITCHEN", confidence: 0.85, sourceLine: "" },
      { doorNumber: "113", field: "location", value: "LOBBY", confidence: 0.85, sourceLine: "" },
    ];
    const out = applyPropagationSuggestions(doors, suggestions);
    expect(out[0].location).toBe("KITCHEN");
  });

  it("integration — full rescan → apply → propagate flow", () => {
    // Simulates: user rescans for door 110.1, gets "ROOM 101 TO CORRIDOR" as location,
    // applies to 110.1, then Darrin propagates to siblings 113 and 114.
    let doors: DoorEntry[] = [
      makeDoor({ door_number: "110.1" }),
      makeDoor({ door_number: "113" }),
      makeDoor({ door_number: "114" }),
      makeDoor({ door_number: "115.3", location: "OFFICE 301" }),
    ];

    // Step 1: user confirms location for 110.1
    doors = applyFieldToDoors(doors, "location", "ROOM 101 TO CORRIDOR", ["110.1"]);
    expect(doors[0].location).toBe("ROOM 101 TO CORRIDOR");

    // Step 2: Darrin finds sibling locations
    const suggestions: PropagationSuggestion[] = [
      { doorNumber: "113", field: "location", value: "KITCHEN TO DINING", confidence: 0.6, sourceLine: "113 KITCHEN TO DINING LH 90 MIN" },
      { doorNumber: "114", field: "location", value: "STAIR A ENTRY", confidence: 0.6, sourceLine: "114 STAIR A ENTRY RH" },
    ];

    // Step 3: user accepts propagation
    doors = applyPropagationSuggestions(doors, suggestions);
    expect(doors[0].location).toBe("ROOM 101 TO CORRIDOR"); // preserved
    expect(doors[1].location).toBe("KITCHEN TO DINING");
    expect(doors[2].location).toBe("STAIR A ENTRY");
    expect(doors[3].location).toBe("OFFICE 301"); // untouched — already had a value
  });
});
