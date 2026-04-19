"use client";

import { useState } from "react";
import type { DoorGroup } from "./types";
import { computeGroupRationale } from "./darrinRationale";

interface DarrinSaysProps {
  group: Pick<DoorGroup, "setId" | "doors" | "medCount" | "lowCount">;
  /** Start expanded. Defaults to false (collapsed) to match the
   *  handoff's "caret closed" default state. */
  defaultOpen?: boolean;
}

/**
 * Collapsible "Darrin says" rationale block on a set-group header.
 *
 * Renders nothing when there are no flagged openings in the group —
 * clean groups shouldn't gain empty whitespace or a tease. Uses the
 * `.darrin-disclosure` CSS family already in globals.css (PR #317).
 *
 * The body HTML comes from `computeGroupRationale` which only emits
 * `<code>` tags, so dangerouslySetInnerHTML is safe here. If that
 * contract ever widens, sanitize at the helper layer — not here.
 */
export default function DarrinSays({ group, defaultOpen = false }: DarrinSaysProps) {
  const [open, setOpen] = useState(defaultOpen);
  const rationale = computeGroupRationale(group);
  if (!rationale) return null;

  return (
    <div className="darrin-disclosure" data-open={open ? "true" : "false"}>
      <button
        type="button"
        className="darrin-disclosure__button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="darrin-disclosure__caret" aria-hidden="true">
          {"\u25B8"}
        </span>
        <span>Darrin says</span>
        <span className="text-tertiary font-normal" style={{ marginLeft: "6px" }}>
          &middot; {rationale.summary}
        </span>
      </button>
      {open && (
        <div
          className="darrin-disclosure__body"
          dangerouslySetInnerHTML={{ __html: rationale.body }}
        />
      )}
    </div>
  );
}
