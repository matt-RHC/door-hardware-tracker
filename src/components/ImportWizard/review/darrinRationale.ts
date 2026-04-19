import type { DoorEntry } from "../types";
import type { DoorGroup } from "./types";
import { getDoorIssues } from "./utils";

// Short-form Darrin copy for the "Darrin says" disclosure on each set
// group in Set view. Returns a single paragraph string keyed off the
// dominant issue(s) in the group. The persona matches DarrinMessage:
// chatty, practical, project-manager voice — same as ReviewSummary's
// recap line. Returns null when there's nothing worth saying so the
// disclosure collapses to nothing and the set header reads clean.
//
// Alternative considered: generate the rationale from darrin-prompts
// at ingest time and store it alongside the opening. Rejected — this
// screen has the counts and field names already, a pure function is
// enough, and we want Phase 3 to swap in server-generated copy later
// without touching the component layer. Keep the contract narrow:
// DoorGroup -> string | null.

interface RationaleContext {
  /** How many openings in this group carry this specific issue. */
  count: number;
  /** Total openings in the group (for phrasing "3 of 8"). */
  total: number;
  /** Hardware set id, used inline so the paragraph is set-aware. */
  setId: string;
}

type RationaleTemplate = (ctx: RationaleContext) => string;

const s = (n: number, singular: string, plural: string = `${singular}s`) =>
  n === 1 ? singular : plural;

// Keyed by the issue strings `getDoorIssues` emits. Keep templates short
// and actionable — one or two sentences, no more. Use `<code>` markup
// for identifiers so the .darrin-disclosure__body code styling picks
// them up.
const TEMPLATES: Record<string, RationaleTemplate> = {
  missing_location: ({ count, setId }) =>
    `${count} ${s(count, "opening")} in <code>${setId}</code> ${s(count, "doesn't", "don't")} have a location assigned yet. Check the submittal's door schedule page and drop each one into its room or corridor before export.`,

  missing_hand: ({ count, setId }) =>
    `${count} ${s(count, "opening")} in <code>${setId}</code> ${s(count, "is", "are")} missing a hand (LH / RH / LHR / RHR). Cross-check the plan view or the hardware schedule's hand column before export.`,

  missing_door_type: ({ count, setId }) =>
    `${count} ${s(count, "opening")} in <code>${setId}</code> ${s(count, "doesn't", "don't")} have a door type. The type column is usually on the schedule header page.`,

  missing_frame_type: ({ count, setId }) =>
    `${count} ${s(count, "opening")} in <code>${setId}</code> ${s(count, "is", "are")} missing a frame type. It's typically listed next to the door type on the schedule.`,

  missing_fire_rating: ({ count, setId }) =>
    `${count} ${s(count, "opening")} in <code>${setId}</code> ${s(count, "is", "are")} missing a fire rating. These are worth confirming — a missed rating is the kind of thing that blocks a final inspection.`,

  missing_hw_set: ({ count }) =>
    `${count} ${s(count, "opening")} ${s(count, "doesn't", "don't")} have a hardware set assigned. Usually means the parser couldn't find a heading code on the opening's row.`,

  missing_door_number: ({ count }) =>
    `${count} ${s(count, "row", "rows")} ${s(count, "is", "are")} missing an opening number entirely. That's a required field — the row can't export until it gets one.`,

  low_confidence_location: ({ count, setId }) =>
    `The parser wasn't fully sure about the location on ${count} ${s(count, "opening")} in <code>${setId}</code>. Worth a quick look before export in case the room number got pulled from the wrong column.`,

  low_confidence_hand: ({ count, setId }) =>
    `Hand looks uncertain on ${count} ${s(count, "opening")} in <code>${setId}</code>. These are easy to eyeball against the plan view — confirm and the row clears.`,

  low_confidence_fire_rating: ({ count, setId }) =>
    `Fire rating is uncertain on ${count} ${s(count, "opening")} in <code>${setId}</code>. Ratings drive the final inspection — confirm against the schedule before export.`,

  low_confidence_door_type: ({ count, setId }) =>
    `Door type confidence is low on ${count} ${s(count, "opening")} in <code>${setId}</code>. Usually a quick fix — the type code lives on the schedule header page.`,

  low_confidence_frame_type: ({ count, setId }) =>
    `Frame type confidence is low on ${count} ${s(count, "opening")} in <code>${setId}</code>. Worth confirming so we don't ship a HM-labelled frame as AL.`,

  low_confidence_hw_set: ({ count }) =>
    `The hardware set assignment looks shaky on ${count} ${s(count, "opening")}. Confirm the heading code matches before export.`,

  low_confidence_manufacturer: ({ count }) =>
    `Manufacturer is uncertain on ${count} ${s(count, "item")}. Common when a product abbreviation could belong to two brands — pick the right one before export.`,
};

function aggregateIssues(doors: DoorEntry[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const door of doors) {
    const issues = getDoorIssues(door);
    for (const key of issues) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

export interface DarrinRationale {
  /** HTML string (safe — only `<code>` tags are ever emitted from the
   *  templates above). Rendered via dangerouslySetInnerHTML inside the
   *  `.darrin-disclosure__body` styled container. */
  body: string;
  /** Short summary of what the group needs — drives the disclosure
   *  button's secondary label. */
  summary: string;
}

/**
 * Compute the "Darrin says" rationale for a hardware-set group.
 * Returns null when the group has no flagged openings — the
 * disclosure shouldn't render.
 */
export function computeGroupRationale(
  group: Pick<DoorGroup, "setId" | "doors" | "medCount" | "lowCount">,
): DarrinRationale | null {
  const attention = group.medCount + group.lowCount;
  if (attention === 0) return null;

  const rawDoors = group.doors.map((d) => d.door);
  const issueCounts = aggregateIssues(rawDoors);

  if (issueCounts.size === 0) {
    // Doors are medium/low per overall confidence but emit no specific
    // issue keys. Fall back to a generic line rather than stay silent —
    // the reviewer still deserves a cue.
    return {
      body: `${attention} ${s(attention, "opening")} in <code>${group.setId}</code> ${s(attention, "needs", "need")} a quick look. Expand the set to see each row's field-level flags.`,
      summary: `${attention} need${attention === 1 ? "s" : ""} a look`,
    };
  }

  // Sort by count desc; tie-break by issue key for stable output (tests
  // pin the order). Take up to two top issues — more than that and the
  // paragraph gets noisy; the reviewer can open the set to see the rest.
  const ranked = [...issueCounts.entries()].sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return a[0].localeCompare(b[0]);
  });

  const top = ranked.slice(0, 2);
  const sentences = top
    .map(([key, count]) => {
      const template = TEMPLATES[key];
      if (!template) return null;
      return template({ count, total: rawDoors.length, setId: group.setId });
    })
    .filter((line): line is string => Boolean(line));

  if (sentences.length === 0) {
    return {
      body: `${attention} ${s(attention, "opening")} in <code>${group.setId}</code> ${s(attention, "needs", "need")} a quick look.`,
      summary: `${attention} need${attention === 1 ? "s" : ""} a look`,
    };
  }

  const [topIssueKey, topCount] = ranked[0];
  return {
    body: sentences.join(" "),
    summary: `${topCount} ${s(topCount, "opening")} · ${topIssueKey.replace(/^(missing|low_confidence)_/, "").replace(/_/g, " ")}`,
  };
}

// ─── Issue-cluster variant ──────────────────────────────────────────
// In Issue view the grouping is flipped: one cluster = one issue key
// across many sets. The set-centric templates above mostly still fit,
// but the leading sentence needs to be about the *cluster*, not a
// single set. We build the body by (a) leading with a cluster-wide
// sentence that mentions set spread, then (b) tacking on the existing
// per-set template with the dominant set substituted in, so the copy
// stays concrete without the template library growing twice.

export interface IssueClusterContext {
  /** Raw issue key — same value used in `computeIssueGroups` output. */
  issueKey: string;
  /** Doors flagged with this issue (across however many sets). */
  doors: DoorEntry[];
  /** Distinct hardware-set ids represented in the cluster, in
   *  first-seen order. */
  setIds: string[];
}

/**
 * Rationale for an issue-type cluster (Issue view). Returns null when
 * the cluster is empty so the disclosure can skip render.
 */
export function computeIssueRationale(
  cluster: IssueClusterContext,
): DarrinRationale | null {
  const count = cluster.doors.length;
  if (count === 0) return null;

  const setCount = cluster.setIds.length;
  const leadSet = cluster.setIds[0] ?? "";
  const human = cluster.issueKey
    .replace(/^(missing|low_confidence)_/, "")
    .replace(/_/g, " ");

  // Multi-set cluster: lead with the spread, then re-use the set
  // template for the biggest slice so the copy gets specific.
  const bodyLead =
    setCount > 1
      ? `${count} ${s(count, "opening")} across ${setCount} sets ${s(count, "is", "are")} flagged for ${human}.`
      : leadSet
      ? `${count} ${s(count, "opening")} in <code>${leadSet}</code> ${s(count, "is", "are")} flagged for ${human}.`
      : `${count} ${s(count, "opening")} ${s(count, "is", "are")} flagged for ${human}.`;

  const template = TEMPLATES[cluster.issueKey];
  const bodyDetail = template
    ? template({ count, total: count, setId: leadSet || "this set" })
    : "";

  const body = bodyDetail ? `${bodyLead} ${bodyDetail}` : bodyLead;
  const summary = `${count} ${s(count, "opening")}${setCount > 1 ? ` · ${setCount} sets` : leadSet ? ` · ${leadSet}` : ""}`;

  return { body, summary };
}

