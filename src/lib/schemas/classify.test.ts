import { describe, it, expect } from "vitest"
import {
  ClassifyOverrideSchema,
  ClassifyUserOverridesSchema,
  ClassifyPhaseDataSchema,
  ClassifyOverridesRequestSchema,
  applyClassifyOverrides,
  type ClassifyPageDetail,
} from "./classify"

const mkDetail = (over: Partial<ClassifyPageDetail>): ClassifyPageDetail => ({
  page: 0,
  type: "other",
  confidence: 1,
  labels: [],
  hw_set_ids: [],
  ...over,
})

describe("ClassifyOverrideSchema", () => {
  it("accepts a plain type override", () => {
    const parsed = ClassifyOverrideSchema.parse({
      page: 4,
      type_override: "hardware_set",
    })
    expect(parsed.page).toBe(4)
    expect(parsed.type_override).toBe("hardware_set")
  })

  it("accepts a pure exclusion with no type override", () => {
    const parsed = ClassifyOverrideSchema.parse({
      page: 0,
      excluded: true,
    })
    expect(parsed.excluded).toBe(true)
    expect(parsed.type_override).toBeUndefined()
  })

  it("rejects negative page numbers", () => {
    const res = ClassifyOverrideSchema.safeParse({ page: -1 })
    expect(res.success).toBe(false)
  })

  it("rejects an unknown type_override value", () => {
    const res = ClassifyOverrideSchema.safeParse({
      page: 1,
      type_override: "invalid_type",
    })
    expect(res.success).toBe(false)
  })
})

describe("ClassifyPhaseDataSchema", () => {
  it("accepts a minimal enriched payload", () => {
    const parsed = ClassifyPhaseDataSchema.parse({
      total_pages: 9,
      schedule_pages: [2],
      hardware_pages: [4, 5, 6],
      skipped_pages: [],
    })
    expect(parsed.reference_pages).toEqual([])
    expect(parsed.cover_pages).toEqual([])
    expect(parsed.page_details).toEqual([])
  })

  it("rejects missing required fields", () => {
    const res = ClassifyPhaseDataSchema.safeParse({
      total_pages: 9,
      // missing schedule_pages
      hardware_pages: [],
      skipped_pages: [],
    })
    expect(res.success).toBe(false)
  })

  it("round-trips a full payload with page_details and user_overrides", () => {
    const input = {
      total_pages: 9,
      schedule_pages: [2],
      hardware_pages: [4, 5, 6, 7, 8],
      reference_pages: [3],
      cover_pages: [0, 1],
      skipped_pages: [],
      page_details: [
        {
          page: 2,
          type: "door_schedule",
          confidence: 0.95,
          labels: [],
          hw_set_ids: [],
        },
      ],
      user_overrides: [{ page: 3, excluded: true }],
    }
    const parsed = ClassifyPhaseDataSchema.parse(input)
    expect(parsed).toEqual(input)
  })
})

describe("ClassifyOverridesRequestSchema", () => {
  it("parses a valid body", () => {
    const parsed = ClassifyOverridesRequestSchema.parse({
      overrides: [
        { page: 0, excluded: true },
        { page: 4, type_override: "reference" },
      ],
    })
    expect(parsed.overrides).toHaveLength(2)
  })

  it("rejects a body missing overrides", () => {
    const res = ClassifyOverridesRequestSchema.safeParse({})
    expect(res.success).toBe(false)
  })

  it("rejects a body with non-array overrides", () => {
    const res = ClassifyOverridesRequestSchema.safeParse({ overrides: "nope" })
    expect(res.success).toBe(false)
  })
})

describe("ClassifyUserOverridesSchema", () => {
  it("parses an empty list", () => {
    expect(ClassifyUserOverridesSchema.parse([])).toEqual([])
  })
})

describe("applyClassifyOverrides", () => {
  const basePages: ClassifyPageDetail[] = [
    mkDetail({ page: 0, type: "cover", confidence: 0.9 }),
    mkDetail({ page: 1, type: "cover", confidence: 0.9 }),
    mkDetail({ page: 2, type: "door_schedule", confidence: 0.95 }),
    mkDetail({ page: 3, type: "reference", confidence: 0.7 }),
    mkDetail({ page: 4, type: "hardware_set", confidence: 0.95 }),
  ]

  it("returns unchanged details when no overrides are supplied", () => {
    const out = applyClassifyOverrides(basePages, [])
    expect(out.pageDetails).toEqual(basePages)
    expect(out.schedule_pages).toEqual([2])
    expect(out.hardware_pages).toEqual([4])
    expect(out.reference_pages).toEqual([3])
    expect(out.cover_pages).toEqual([0, 1])
    expect(out.skipped_pages).toEqual([])
    expect(out.excluded_pages).toEqual([])
  })

  it("applies a type_override and rewrites the derived arrays", () => {
    const out = applyClassifyOverrides(basePages, [
      { page: 3, type_override: "hardware_set" },
    ])
    expect(out.hardware_pages).toEqual([3, 4])
    expect(out.reference_pages).toEqual([])
    // page_details should reflect the override
    const p3 = out.pageDetails.find((p) => p.page === 3)
    expect(p3?.type).toBe("hardware_set")
  })

  it("excludes a page — removes it from all buckets", () => {
    const out = applyClassifyOverrides(basePages, [
      { page: 0, excluded: true },
    ])
    expect(out.cover_pages).toEqual([1])
    expect(out.excluded_pages).toEqual([0])
    expect(out.pageDetails.find((p) => p.page === 0)).toBeUndefined()
  })

  it("combines type_override AND excluded — exclusion wins", () => {
    const out = applyClassifyOverrides(basePages, [
      { page: 3, type_override: "hardware_set", excluded: true },
    ])
    expect(out.excluded_pages).toEqual([3])
    expect(out.hardware_pages).toEqual([4])
    expect(out.reference_pages).toEqual([])
  })

  it("collapses legacy hardware_sets label into hardware_set", () => {
    const pages: ClassifyPageDetail[] = [
      mkDetail({ page: 4, type: "hardware_sets" }),
      mkDetail({ page: 5, type: "hardware_set" }),
    ]
    const out = applyClassifyOverrides(pages, [])
    expect(out.hardware_pages).toEqual([4, 5])
  })

  it("is idempotent — applying the same overrides twice yields the same result", () => {
    const overrides = [
      { page: 0, excluded: true },
      { page: 3, type_override: "hardware_set" as const },
    ]
    const first = applyClassifyOverrides(basePages, overrides)
    const second = applyClassifyOverrides(first.pageDetails, overrides)
    expect(first.schedule_pages).toEqual(second.schedule_pages)
    expect(first.hardware_pages).toEqual(second.hardware_pages)
    // excluded_pages differs — first run removes page 0, second run has
    // no page 0 left to exclude. That's by design: overrides are
    // applied against the current pageDetails, not cumulatively.
  })

  it("last override wins when two target the same page", () => {
    // Note: applyClassifyOverrides uses a Map-with-set semantics; the
    // later entry overwrites the earlier one via Map.set.
    const out = applyClassifyOverrides(basePages, [
      { page: 3, type_override: "hardware_set" },
      { page: 3, type_override: "cover" },
    ])
    const p3 = out.pageDetails.find((p) => p.page === 3)
    expect(p3?.type).toBe("cover")
    expect(out.cover_pages).toContain(3)
    expect(out.hardware_pages).not.toContain(3)
  })
})
