/**
 * Shared PDF utilities for the ImportWizard extraction pipeline.
 */
import { PDFDocument } from 'pdf-lib'
import type { DoorEntry, ExtractedHardwareItem, HardwareSet } from '@/lib/types'

export type { DoorEntry, ExtractedHardwareItem, HardwareSet }

// ── Constants ──────────────────────────────────────────────────────

/** Raw file size threshold for chunked extraction (3MB).
 *  Base64 encoding adds ~33%, so 3MB raw → ~4MB payload, near Vercel's 4.5MB limit. */
export const CHUNK_SIZE_THRESHOLD = 3 * 1024 * 1024

/** Fallback max pages per chunk if classifier fails */
export const FALLBACK_PAGES_PER_CHUNK = 35

// ── Base64 encoding ────────────────────────────────────────────────

/**
 * Convert an ArrayBuffer or Uint8Array to a base64 string.
 * Uses 8KB chunks to avoid call stack overflow on large buffers.
 */
export function arrayBufferToBase64(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
  }
  return btoa(binary)
}

// ── PDF splitting ──────────────────────────────────────────────────

/**
 * Split a PDF into chunks by specific page index sets.
 * Optionally prepends reference pages to each chunk for extraction context.
 */
export async function splitPDFByPages(
  buffer: ArrayBuffer,
  chunkPageSets: number[][],
  referencePageIndices: number[] = [],
): Promise<string[]> {
  const srcDoc = await PDFDocument.load(buffer)
  const chunks: string[] = []

  for (const pageIndices of chunkPageSets) {
    const chunkDoc = await PDFDocument.create()

    if (referencePageIndices.length > 0) {
      const refPages = await chunkDoc.copyPages(srcDoc, referencePageIndices)
      for (const page of refPages) {
        chunkDoc.addPage(page)
      }
    }

    const contentPages = await chunkDoc.copyPages(srcDoc, pageIndices)
    for (const page of contentPages) {
      chunkDoc.addPage(page)
    }

    const chunkBytes = await chunkDoc.save()
    chunks.push(arrayBufferToBase64(chunkBytes))
  }

  return chunks
}

/**
 * Fallback: split a PDF into fixed-size chunks when classifier is unavailable.
 */
export async function splitPDFFixed(
  buffer: ArrayBuffer,
  pagesPerChunk: number = FALLBACK_PAGES_PER_CHUNK,
): Promise<string[]> {
  const srcDoc = await PDFDocument.load(buffer)
  const totalPages = srcDoc.getPageCount()
  const chunks: string[] = []

  for (let start = 0; start < totalPages; start += pagesPerChunk) {
    const end = Math.min(start + pagesPerChunk, totalPages)
    const chunkDoc = await PDFDocument.create()
    const pages = await chunkDoc.copyPages(
      srcDoc,
      Array.from({ length: end - start }, (_, i) => start + i),
    )
    for (const page of pages) {
      chunkDoc.addPage(page)
    }
    const chunkBytes = await chunkDoc.save()
    chunks.push(arrayBufferToBase64(chunkBytes))
  }

  return chunks
}

// ── Result merging ─────────────────────────────────────────────────

const NAME_ABBREVIATIONS: Record<string, string> = {
  'cont.': 'continuous', 'cont': 'continuous',
  'flr': 'floor', 'flr.': 'floor',
  'w/': 'with ', 'w/o': 'without',
  'mtd': 'mounted', 'mtd.': 'mounted',
  'hd': 'heavy duty', 'hd.': 'heavy duty',
  'adj': 'adjustable', 'adj.': 'adjustable',
  'auto': 'automatic', 'auto.': 'automatic',
  'elec': 'electric', 'elec.': 'electric',
  'mag': 'magnetic', 'mag.': 'magnetic',
  'mech': 'mechanical', 'mech.': 'mechanical',
  'ss': 'stainless steel',
  'alum': 'aluminum', 'alum.': 'aluminum',
  'brz': 'bronze', 'brz.': 'bronze',
  'sfc': 'surface', 'sfc.': 'surface',
  'conc': 'concealed', 'conc.': 'concealed',
  'ovhd': 'overhead', 'ovhd.': 'overhead',
  'thresh': 'threshold', 'thresh.': 'threshold',
}

export function normalizeItemName(name: string): string {
  let n = (name ?? '').toLowerCase().trim()
  // Sort abbreviations longest-first so "w/o" matches before "w/"
  const sorted = Object.entries(NAME_ABBREVIATIONS).sort(
    (a, b) => b[0].length - a[0].length,
  )
  for (const [abbr, full] of sorted) {
    // Use whitespace/start/end boundaries instead of \b which treats '.' as a boundary
    const escaped = abbr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    n = n.replace(new RegExp(`(?<=\\s|^)${escaped}(?=\\s|$)`, 'g'), full)
  }
  return n.replace(/[()]/g, '').replace(/\s+/g, ' ').replace(/[,;.]+$/, '').trim()
}

function hardwareItemDedupKey(item: ExtractedHardwareItem): string {
  const model = (item.model || '').trim().toLowerCase()
  if (model) return `model:${model}`
  return `name:${normalizeItemName(item.name)}`
}

/** Deduplicate hardware items, keeping the version with more complete data */
export function deduplicateHardwareItems(items: ExtractedHardwareItem[]): ExtractedHardwareItem[] {
  const seen = new Map<string, ExtractedHardwareItem>()
  for (const item of items) {
    const key = hardwareItemDedupKey(item)
    const existing = seen.get(key)
    if (!existing) {
      seen.set(key, item)
    } else {
      const existingScore = [existing.name, existing.model, existing.manufacturer, existing.finish].filter(Boolean).length
      const newScore = [item.name, item.model, item.manufacturer, item.finish].filter(Boolean).length
      if (newScore > existingScore) seen.set(key, item)
    }
  }
  return Array.from(seen.values())
}

/** Deduplicate hardware sets by set_id, merge items across chunks, then dedup items */
export function mergeHardwareSets(allSets: HardwareSet[]): HardwareSet[] {
  const map = new Map<string, HardwareSet>()
  for (const set of allSets) {
    const existing = map.get(set.set_id)
    if (!existing) {
      map.set(set.set_id, { ...set, items: [...(set.items ?? [])] })
    } else {
      existing.items.push(...(set.items ?? []))
      if (set.heading && (!existing.heading || set.heading.length > existing.heading.length)) {
        existing.heading = set.heading
      }
    }
  }
  for (const set of map.values()) {
    set.items = deduplicateHardwareItems(set.items ?? [])
  }
  return Array.from(map.values())
}

/** Deduplicate doors by door_number (first occurrence wins) */
export function mergeDoors(allDoors: DoorEntry[]): DoorEntry[] {
  const seen = new Set<string>()
  const unique: DoorEntry[] = []
  for (const door of allDoors) {
    if (!seen.has(door.door_number)) {
      seen.add(door.door_number)
      unique.push(door)
    }
  }
  return unique
}
