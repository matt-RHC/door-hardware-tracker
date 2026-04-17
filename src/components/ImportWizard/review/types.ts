import type { DoorEntry } from "../types";

export type DoorStringField =
  | "door_number"
  | "hw_set"
  | "location"
  | "door_type"
  | "frame_type"
  | "fire_rating"
  | "hand";

export type SortDir = "asc" | "desc";

export type FilterLevel = "all" | "high" | "medium" | "low";

export const FIELD_KEYS: DoorStringField[] = [
  "door_number",
  "hw_set",
  "location",
  "door_type",
  "frame_type",
  "fire_rating",
  "hand",
];

export const FIELD_LABELS: Record<DoorStringField, string> = {
  door_number: "Door #",
  hw_set: "HW Set",
  location: "Location",
  door_type: "Door Type",
  frame_type: "Frame Type",
  fire_rating: "Fire Rating",
  hand: "Hand",
};

/** Map issue keys to human-readable issue group labels. */
export const ISSUE_LABELS: Record<string, string> = {
  missing_location: 'Missing location',
  missing_fire_rating: 'Uncertain fire rating',
  missing_hand: 'Missing hand',
  missing_door_type: 'Missing door type',
  missing_frame_type: 'Missing frame type',
  missing_hw_set: 'Missing hardware set',
  missing_door_number: 'Missing door number',
  low_confidence_location: 'Uncertain location',
  low_confidence_fire_rating: 'Uncertain fire rating',
  low_confidence_hand: 'Uncertain hand',
  low_confidence_door_type: 'Uncertain door type',
  low_confidence_frame_type: 'Uncertain frame type',
  low_confidence_hw_set: 'Uncertain hardware set',
  low_confidence_manufacturer: 'Unknown manufacturer',
};

export interface DoorGroup {
  setId: string;
  heading: string;
  doors: Array<{ door: DoorEntry; originalIndex: number }>;
  highCount: number;
  medCount: number;
  lowCount: number;
}

/** Editing state for a single door cell. */
export interface EditingCell {
  row: number;
  field: DoorStringField;
}
