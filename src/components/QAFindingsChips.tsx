"use client";

import { useState } from "react";
import { QA_FINDING_LABELS, type QAFindingTag } from "@/lib/types/database";

const ALL_TAGS: QAFindingTag[] = [
  "spec_match",
  "operation",
  "finish",
  "fire_rating",
  "ada",
  "life_safety",
];

interface QAFindingsChipsProps {
  openingId: string;
  itemId: string;
  leafIndex: number;
  currentFindings: string[];
  currentNotes: string | null;
  onUpdate: () => void;
}

export default function QAFindingsChips({
  openingId,
  itemId,
  leafIndex,
  currentFindings,
  currentNotes,
  onUpdate,
}: QAFindingsChipsProps) {
  const [saving, setSaving] = useState(false);
  const [showNotes, setShowNotes] = useState(!!currentNotes);
  const [notesValue, setNotesValue] = useState(currentNotes ?? "");

  const handleToggle = async (tag: QAFindingTag) => {
    const next = currentFindings.includes(tag)
      ? currentFindings.filter((t) => t !== tag)
      : [...currentFindings, tag];

    setSaving(true);
    try {
      const res = await fetch(`/api/openings/${openingId}/qa-findings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          item_id: itemId,
          leaf_index: leafIndex,
          qa_findings: next,
          qa_notes: notesValue || null,
        }),
      });
      if (!res.ok) throw new Error("Failed to update QA findings");
      onUpdate();
    } catch (err) {
      console.error("Error updating QA findings:", err);
    } finally {
      setSaving(false);
    }
  };

  const handleNotesBlur = async () => {
    const trimmed = notesValue.trim() || null;
    if (trimmed === currentNotes) return;

    setSaving(true);
    try {
      const res = await fetch(`/api/openings/${openingId}/qa-findings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          item_id: itemId,
          leaf_index: leafIndex,
          qa_findings: currentFindings,
          qa_notes: trimmed,
        }),
      });
      if (!res.ok) throw new Error("Failed to update QA notes");
      onUpdate();
    } catch (err) {
      console.error("Error updating QA notes:", err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap gap-1">
        {ALL_TAGS.map((tag) => {
          const active = currentFindings.includes(tag);
          return (
            <button
              key={tag}
              onClick={() => handleToggle(tag)}
              disabled={saving}
              className="px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide transition-colors disabled:opacity-50"
              style={{
                background: active ? "var(--red-dim)" : "var(--surface)",
                color: active ? "var(--red)" : "var(--text-tertiary)",
                border: active
                  ? "1px solid var(--red)"
                  : "1px solid var(--border)",
              }}
              title={
                active
                  ? `Remove ${QA_FINDING_LABELS[tag]} finding`
                  : `Flag ${QA_FINDING_LABELS[tag]} issue`
              }
            >
              {QA_FINDING_LABELS[tag]}
            </button>
          );
        })}
        <button
          onClick={() => setShowNotes(!showNotes)}
          className="px-2 py-0.5 rounded-full text-[10px] font-medium transition-colors"
          style={{
            background: showNotes ? "var(--accent-dim)" : "var(--surface)",
            color: showNotes ? "var(--accent)" : "var(--text-tertiary)",
            border: showNotes
              ? "1px solid var(--accent)"
              : "1px solid var(--border)",
          }}
          title="Toggle QA notes"
        >
          Notes
        </button>
      </div>
      {showNotes && (
        <textarea
          value={notesValue}
          onChange={(e) => setNotesValue(e.target.value)}
          onBlur={handleNotesBlur}
          placeholder="QA notes..."
          rows={2}
          className="w-full px-2 py-1.5 text-[12px] bg-surface border border-th-border rounded text-primary placeholder-tertiary focus:border-accent focus:outline-none resize-y"
        />
      )}
    </div>
  );
}
