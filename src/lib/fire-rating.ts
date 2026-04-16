/**
 * Fire Rating Extraction
 *
 * Extracts fire ratings (e.g. "20Min", "90Min", "1Hr") that are sometimes
 * embedded in hw_heading or location fields instead of the fire_rating column.
 * Used by both the main parse-pdf route and the chunk handler.
 */

import type { DoorEntry } from '@/lib/types'

export type { DoorEntry }

const FIRE_RATING_PATTERN = /\b(\d{1,3}\s*[Mm]in(?:ute)?s?|[123]\s*[Hh](?:ou)?rs?)\b/

/**
 * Scans doors for fire ratings embedded in hw_heading or location fields.
 * Extracts the rating into fire_rating and removes it from the source field.
 * Mutates the array in place.
 */
export function extractFireRatings(doors: DoorEntry[]): void {
  for (const door of doors) {
    if (door.fire_rating) continue

    // Check hw_heading first
    const match = FIRE_RATING_PATTERN.exec(door.hw_heading || '')
    if (match) {
      door.fire_rating = match[1]
      door.hw_heading = (door.hw_heading || '').replace(match[0], '').trim()
    }

    // Fall back to location (MCA/Comsense PDFs put fire ratings here)
    if (!door.fire_rating) {
      const locMatch = FIRE_RATING_PATTERN.exec(door.location || '')
      if (locMatch) {
        door.fire_rating = locMatch[1]
        door.location = (door.location || '').replace(locMatch[0], '').trim()
      }
    }
  }
}
