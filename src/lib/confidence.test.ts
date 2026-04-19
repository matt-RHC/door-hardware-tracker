import { describe, it, expect } from "vitest";
import { scoreToLevel } from "./confidence";

describe("scoreToLevel", () => {
  it("returns 'high' for scores at or above 0.85", () => {
    expect(scoreToLevel(0.85)).toBe("high");
    expect(scoreToLevel(0.92)).toBe("high");
    expect(scoreToLevel(1.0)).toBe("high");
  });

  it("returns 'medium' for scores in [0.6, 0.85)", () => {
    expect(scoreToLevel(0.6)).toBe("medium");
    expect(scoreToLevel(0.75)).toBe("medium");
    expect(scoreToLevel(0.849)).toBe("medium");
  });

  it("returns 'low' for scores below 0.6 — matches getDoorIssues threshold", () => {
    expect(scoreToLevel(0.59)).toBe("low");
    expect(scoreToLevel(0.3)).toBe("low");
    expect(scoreToLevel(0)).toBe("low");
  });

  it("returns 'unverified' for null, undefined, or NaN", () => {
    expect(scoreToLevel(null)).toBe("unverified");
    expect(scoreToLevel(undefined)).toBe("unverified");
    expect(scoreToLevel(Number.NaN)).toBe("unverified");
  });
});
