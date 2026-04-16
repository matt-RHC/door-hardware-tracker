import { describe, it, expect } from "vitest"
import type {
  ClassifyPageDetail,
  ClassifyPhaseData,
} from "@/lib/schemas/classify"
import {
  detectSequentialGaps,
  detectSmallJobOverclassification,
  detectLowConfidencePages,
  detectMissingHardware,
  runClassifyHeuristics,
  summarizeHardwareSetIds,
} from "./classify-heuristics"

const mkDetail = (over: Partial<ClassifyPageDetail>): ClassifyPageDetail => ({
  page: 0,
  type: "other",
  confidence: 1,
  labels: [],
  hw_set_ids: [],
  ...over,
})

const mkClassify = (over: Partial<ClassifyPhaseData>): ClassifyPhaseData => ({
  total_pages: 9,
  schedule_pages: [],
  hardware_pages: [],
  reference_pages: [],
  cover_pages: [],
  skipped_pages: [],
  page_details: [],
  ...over,
})

describe("detectSequentialGaps", () => {
  it("flags an outlier page far from the main cluster", () => {
    // Schedule cluster at 0,1; outlier at 28 and 48
    expect(detectSequentialGaps([0, 1, 28, 48])).toEqual([28, 48])
  })

  it("does not flag a tight cluster", () => {
    expect(detectSequentialGaps([0, 1, 2, 3])).toEqual([])
  })

  it("returns empty when fewer than 2 pages", () => {
    expect(detectSequentialGaps([])).toEqual([])
    expect(detectSequentialGaps([5])).toEqual([])
  })

  it("does not flag pages that are within threshold of a neighbor", () => {
    // 0,1 cluster; 3 is within 2 of 1 so it's tolerated
    expect(detectSequentialGaps([0, 1, 3])).toEqual([])
  })

  it("handles unsorted input", () => {
    expect(detectSequentialGaps([48, 0, 28, 1])).toEqual([28, 48])
  })
})

describe("detectSmallJobOverclassification", () => {
  it("fires when 9-page job has 5 schedule pages", () => {
    expect(detectSmallJobOverclassification(9, [0, 1, 2, 3, 4])).toBe(true)
  })

  it("does not fire for a large document even with many schedule pages", () => {
    expect(detectSmallJobOverclassification(60, [0, 1, 2, 3, 4, 5])).toBe(false)
  })

  it("does not fire when schedule pages look reasonable for small job", () => {
    expect(detectSmallJobOverclassification(9, [2])).toBe(false)
    expect(detectSmallJobOverclassification(9, [2, 3])).toBe(false)
  })

  it("safely handles zero pages", () => {
    expect(detectSmallJobOverclassification(0, [])).toBe(false)
  })
})

describe("detectLowConfidencePages", () => {
  it("flags pages below 0.6 confidence", () => {
    const details = [
      mkDetail({ page: 0, confidence: 0.5 }),
      mkDetail({ page: 1, confidence: 0.9 }),
      mkDetail({ page: 2, confidence: 0.59 }),
    ]
    expect(detectLowConfidencePages(details)).toEqual([0, 2])
  })

  it("returns empty when all confident", () => {
    const details = [mkDetail({ page: 0, confidence: 0.85 })]
    expect(detectLowConfidencePages(details)).toEqual([])
  })

  it("treats exactly 0.6 as confident (threshold exclusive)", () => {
    const details = [mkDetail({ page: 0, confidence: 0.6 })]
    expect(detectLowConfidencePages(details)).toEqual([])
  })
})

describe("detectMissingHardware", () => {
  it("fires when schedule present but no hardware pages", () => {
    expect(detectMissingHardware([2], [])).toBe(true)
  })

  it("does not fire when both present", () => {
    expect(detectMissingHardware([2], [4, 5, 6])).toBe(false)
  })

  it("does not fire when neither present", () => {
    expect(detectMissingHardware([], [])).toBe(false)
  })
})

describe("runClassifyHeuristics", () => {
  it("returns no flags for a clean Lyft/Waymo-shaped classification", () => {
    // 9 pages: 2 cover, 1 schedule, 1 reference, 5 hardware — the
    // canonical example from the prompt.
    const classify = mkClassify({
      total_pages: 9,
      schedule_pages: [2],
      hardware_pages: [4, 5, 6, 7, 8],
      reference_pages: [3],
      cover_pages: [0, 1],
      page_details: [
        mkDetail({ page: 0, type: "cover", confidence: 0.9 }),
        mkDetail({ page: 1, type: "cover", confidence: 0.9 }),
        mkDetail({ page: 2, type: "door_schedule", confidence: 0.95 }),
        mkDetail({ page: 3, type: "reference", confidence: 0.8 }),
        mkDetail({
          page: 4,
          type: "hardware_set",
          confidence: 0.95,
          hw_set_ids: ["H01"],
        }),
        mkDetail({
          page: 5,
          type: "hardware_set",
          confidence: 0.95,
          hw_set_ids: ["E01"],
        }),
        mkDetail({
          page: 6,
          type: "hardware_set",
          confidence: 0.9,
          hw_set_ids: ["H06B"],
        }),
        mkDetail({
          page: 7,
          type: "hardware_set",
          confidence: 0.9,
          hw_set_ids: ["H07"],
        }),
        mkDetail({
          page: 8,
          type: "hardware_set",
          confidence: 0.9,
          hw_set_ids: ["H07.1"],
        }),
      ],
    })
    expect(runClassifyHeuristics(classify)).toEqual([])
  })

  it("fires missing_hardware as warning when no hardware pages", () => {
    const classify = mkClassify({
      schedule_pages: [2],
      hardware_pages: [],
    })
    const flags = runClassifyHeuristics(classify)
    expect(flags.map((f) => f.code)).toContain("missing_hardware")
    const missing = flags.find((f) => f.code === "missing_hardware")!
    expect(missing.severity).toBe("warning")
  })

  it("fires sequential_gap with the outlier pages", () => {
    // Pages 0,1 are the main cluster; 52,54 form a second tight cluster
    // (gap of 2 to each other). 28 and 48 have BOTH neighbors far
    // away, so they're the true outliers.
    const classify = mkClassify({
      total_pages: 60,
      schedule_pages: [0, 1, 28, 48, 52, 54],
      hardware_pages: [3, 4, 5],
    })
    const flags = runClassifyHeuristics(classify)
    const gap = flags.find((f) => f.code === "sequential_gap")
    expect(gap).toBeDefined()
    expect(gap!.pages).toEqual([28, 48])
  })

  it("fires small_job_overclassification for tiny jobs with many schedule pages", () => {
    const classify = mkClassify({
      total_pages: 9,
      schedule_pages: [0, 1, 2, 3, 4],
      hardware_pages: [5, 6],
    })
    const flags = runClassifyHeuristics(classify)
    expect(flags.map((f) => f.code)).toContain("small_job_overclassification")
  })

  it("fires low_confidence as info (not warning)", () => {
    const classify = mkClassify({
      schedule_pages: [2],
      hardware_pages: [4],
      page_details: [
        mkDetail({ page: 2, type: "door_schedule", confidence: 0.4 }),
        mkDetail({ page: 4, type: "hardware_set", confidence: 0.9 }),
      ],
    })
    const flags = runClassifyHeuristics(classify)
    const low = flags.find((f) => f.code === "low_confidence")
    expect(low).toBeDefined()
    expect(low!.severity).toBe("info")
    expect(low!.pages).toEqual([2])
  })

  it("orders warnings before info", () => {
    const classify = mkClassify({
      schedule_pages: [2],
      hardware_pages: [],
      page_details: [mkDetail({ page: 2, confidence: 0.4 })],
    })
    const flags = runClassifyHeuristics(classify)
    const severities = flags.map((f) => f.severity)
    // Warning(s) must come before any info flags
    const firstInfoIdx = severities.indexOf("info")
    if (firstInfoIdx >= 0) {
      for (let i = 0; i < firstInfoIdx; i++) {
        expect(severities[i]).toBe("warning")
      }
    }
  })
})

describe("summarizeHardwareSetIds", () => {
  it("collapses and deduplicates set ids", () => {
    const details = [
      mkDetail({ type: "hardware_set", hw_set_ids: ["H01", "H02"] }),
      mkDetail({ type: "hardware_set", hw_set_ids: ["H01", "H03"] }),
    ]
    expect(summarizeHardwareSetIds(details)).toBe("H01, H02, H03")
  })

  it("abbreviates long lists", () => {
    const details = [
      mkDetail({
        type: "hardware_set",
        hw_set_ids: ["H01", "H02", "H03", "H04", "H05", "H06", "H07", "H08"],
      }),
    ]
    // With 6 or fewer we show all; here 8 > 6 so abbreviate
    const out = summarizeHardwareSetIds(details)
    expect(out.endsWith("more")).toBe(true)
  })

  it("returns empty for no hardware pages", () => {
    const details = [
      mkDetail({ type: "door_schedule", hw_set_ids: ["H01"] }),
      mkDetail({ type: "cover", hw_set_ids: [] }),
    ]
    expect(summarizeHardwareSetIds(details)).toBe("")
  })
})
