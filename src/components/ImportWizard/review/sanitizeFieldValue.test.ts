import { describe, it, expect } from "vitest";
import { sanitizeFieldValue } from "./sanitizeFieldValue";

// These tests are named against the exact noise strings captured in the
// demo screen recording (2026-04-17), so the fixture names double as a
// regression trail. See sanitizeFieldValue.ts module docstring for source.

describe("sanitizeFieldValue", () => {
  // ── fire_rating ────────────────────────────────────────────────────────
  describe("fire_rating", () => {
    it("strips leading 'x ' column marker: 'x 90Min' -> '90Min'", () => {
      expect(sanitizeFieldValue("fire_rating", "x 90Min")).toBe("90Min");
    });

    it("strips leading 'x\\n' column marker: 'x\\n90Min' -> '90Min'", () => {
      expect(sanitizeFieldValue("fire_rating", "x\n90Min")).toBe("90Min");
    });

    it("passes clean values through unchanged: '90Min' -> '90Min'", () => {
      expect(sanitizeFieldValue("fire_rating", "90Min")).toBe("90Min");
    });

    it("passes multi-digit ratings through: '180 min' -> '180 min'", () => {
      expect(sanitizeFieldValue("fire_rating", "180 min")).toBe("180 min");
    });

    it("is idempotent: sanitize(sanitize(x)) === sanitize(x)", () => {
      const raw = "x 90Min";
      const once = sanitizeFieldValue("fire_rating", raw);
      const twice = sanitizeFieldValue("fire_rating", once);
      expect(twice).toBe(once);
      expect(twice).toBe("90Min");
    });

    it("does NOT strip capital 'X' (could be real label)", () => {
      // If a user targets fire_rating with "X-RATED 60Min" (contrived but
      // possible), we do NOT strip — capital X is ambiguous.
      expect(sanitizeFieldValue("fire_rating", "X-RATED 60Min")).toBe(
        "X-RATED 60Min",
      );
    });

    it("returns empty when value is pure noise: 'x ' -> ''", () => {
      expect(sanitizeFieldValue("fire_rating", "x ")).toBe("");
    });
  });

  // ── location ───────────────────────────────────────────────────────────
  describe("location", () => {
    it("strips leading 'R)\\n' leaf marker: 'R)\\nDH1 UPS-C 110-07' -> 'DH1 UPS-C 110-07'", () => {
      expect(
        sanitizeFieldValue("location", "R)\nDH1 UPS-C 110-07 to/from DH1 UPS-D 110-08"),
      ).toBe("DH1 UPS-C 110-07 to/from DH1 UPS-D 110-08");
    });

    it("strips leading 'L)\\n' leaf marker", () => {
      expect(sanitizeFieldValue("location", "L)\nROOM 101")).toBe("ROOM 101");
    });

    it("strips stacked leaf markers greedily", () => {
      expect(sanitizeFieldValue("location", "R)\nL)\nROOM 101")).toBe("ROOM 101");
    });

    it("strips trailing leaf marker: 'ROOM 101 R)' -> 'ROOM 101'", () => {
      expect(sanitizeFieldValue("location", "ROOM 101 R)")).toBe("ROOM 101");
    });

    it("does NOT strip markers mid-string: 'ROOM R) 105' -> 'ROOM R) 105'", () => {
      // Conservative: only strip at start or end, never inside — a real
      // location could legitimately contain 'R)' (e.g. a room label).
      expect(sanitizeFieldValue("location", "ROOM R) 105")).toBe("ROOM R) 105");
    });

    it("passes clean locations through", () => {
      expect(sanitizeFieldValue("location", "ROOM 101 TO CORRIDOR")).toBe(
        "ROOM 101 TO CORRIDOR",
      );
    });

    it("is idempotent on heavy noise", () => {
      const raw = "R)\nL)\nDH1 UPS-C 110-07";
      const once = sanitizeFieldValue("location", raw);
      const twice = sanitizeFieldValue("location", once);
      expect(twice).toBe(once);
    });
  });

  // ── hand ───────────────────────────────────────────────────────────────
  describe("hand", () => {
    it("strips leaf markers from hand values", () => {
      expect(sanitizeFieldValue("hand", "R)\nLHR")).toBe("LHR");
    });

    it("passes clean hand codes through", () => {
      expect(sanitizeFieldValue("hand", "RHR")).toBe("RHR");
      expect(sanitizeFieldValue("hand", "LH")).toBe("LH");
      expect(sanitizeFieldValue("hand", "LHR")).toBe("LHR");
    });

    it("does NOT invent missing characters (truncation case)", () => {
      // 'DE' is a known OCR truncation of 'DELHR' captured in the demo video.
      // sanitizeFieldValue is NOT responsible for fixing this — see module
      // docstring. The field_confidence guard (PR-E) surfaces the ambiguity
      // at review time instead.
      expect(sanitizeFieldValue("hand", "DE")).toBe("DE");
    });
  });

  // ── door_number ────────────────────────────────────────────────────────
  describe("door_number", () => {
    it("does NOT strip anything from door_number (safety)", () => {
      // door_number is the primary key across the wizard maps. If this
      // passes through a marker, the keys would diverge and the apply
      // silently no-ops. Easier to trim-only and let the user notice.
      expect(sanitizeFieldValue("door_number", "R)\n110-07B")).toBe(
        "R)\n110-07B",
      );
    });
  });

  // ── edge cases ─────────────────────────────────────────────────────────
  describe("edge cases", () => {
    it("returns '' for null", () => {
      expect(sanitizeFieldValue("fire_rating", null)).toBe("");
    });

    it("returns '' for undefined", () => {
      expect(sanitizeFieldValue("fire_rating", undefined)).toBe("");
    });

    it("returns '' for whitespace-only input", () => {
      expect(sanitizeFieldValue("fire_rating", "   ")).toBe("");
      expect(sanitizeFieldValue("location", "\n\n")).toBe("");
    });

    it("trims trailing whitespace on all fields", () => {
      expect(sanitizeFieldValue("fire_rating", "  90Min  ")).toBe("90Min");
      expect(sanitizeFieldValue("location", "  ROOM 101  ")).toBe("ROOM 101");
    });
  });
});
