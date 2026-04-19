/**
 * PDF document layout for the punch-notes export.
 *
 * Built with @react-pdf/renderer — server-rendered to a PDF buffer in
 * the export route, no Chromium dependency. The component tree mirrors
 * the on-screen <PunchNotesView /> roughly: cover header, project AI
 * summary, per-opening sections each with door label, opening AI summary,
 * and raw notes grouped opening → leaf → item.
 *
 * Font choice: Helvetica is the default PDF font built into the spec —
 * no font file shipping, no runtime fetch, and it renders professional
 * output identical across viewers. If/when the project adopts a brand
 * font (Inter, etc.), register it via Font.register() with a bundled
 * .ttf and update the StyleSheet entries below. Don't pull from a CDN
 * at request time — that adds latency and fails in restricted networks.
 *
 * Markdown rendering: the AI summaries are markdown but @react-pdf does
 * not have a markdown renderer. The same minimal grammar that the
 * on-screen Markdown component handles (## / ### headings, - bullets,
 * **bold**, paragraph breaks) is parsed inline here in `renderMarkdown`.
 * Anything outside that grammar renders as plain text — readable,
 * unstyled.
 */

import {
  Document,
  Page,
  Text,
  View,
  StyleSheet,
  Font,
} from '@react-pdf/renderer'
import type { Note } from '@/lib/types/notes'

// ── Types ──────────────────────────────────────────────────────────────

export interface PunchNotesPdfOpening {
  id: string
  door_number: string
  /** Markdown summary, may be empty if the user hasn't generated one yet. */
  summary: string | null
  notes: Note[]
}

export interface PunchNotesPdfData {
  project: {
    name: string
    address: string | null
    general_contractor: string | null
    job_number: string | null
    architect: string | null
    /** ISO timestamp of when the project AI summary was last generated.
     *  Null if it's never been generated. */
    summary_generated_at: string | null
    /** Markdown project rollup, may be empty. */
    summary: string | null
  }
  openings: PunchNotesPdfOpening[]
  projectScopeNotes: Note[]
  /** itemNames keyed by hardware_item_id, used to label item-scope notes. */
  itemNames: Record<string, string | null>
  /** ISO timestamp passed in by the route — used in the cover footer
   *  and the page footers. Caller controls this so tests can pass a
   *  deterministic value. */
  generatedAt: string
  /** Optional display name of the user generating the PDF. */
  preparedBy: string | null
}

// ── Styles ─────────────────────────────────────────────────────────────

const COLORS = {
  text: '#0f172a',
  textMuted: '#475569',
  textSubtle: '#64748b',
  border: '#cbd5e1',
  borderSubtle: '#e2e8f0',
  bg: '#ffffff',
  bgPanel: '#f8fafc',
  accent: '#1e3a8a',
}

const styles = StyleSheet.create({
  page: {
    backgroundColor: COLORS.bg,
    color: COLORS.text,
    fontFamily: 'Helvetica',
    fontSize: 10,
    lineHeight: 1.4,
    paddingTop: 56,
    paddingBottom: 56,
    paddingHorizontal: 56,
  },
  // Cover
  coverHeader: {
    borderBottomWidth: 2,
    borderBottomColor: COLORS.accent,
    borderBottomStyle: 'solid',
    paddingBottom: 16,
    marginBottom: 24,
  },
  coverTitle: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 22,
    color: COLORS.text,
    marginBottom: 4,
  },
  coverSubtitle: {
    fontSize: 12,
    color: COLORS.textMuted,
    marginBottom: 12,
  },
  coverMetaRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 24,
    marginTop: 8,
  },
  coverMetaLabel: {
    fontSize: 8,
    color: COLORS.textSubtle,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 2,
  },
  coverMetaValue: {
    fontSize: 10,
    color: COLORS.text,
  },
  // Sections
  sectionHeader: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 14,
    color: COLORS.text,
    marginTop: 18,
    marginBottom: 8,
    paddingBottom: 4,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
    borderBottomStyle: 'solid',
  },
  // Opening card
  openingCard: {
    marginTop: 16,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: COLORS.borderSubtle,
    borderTopStyle: 'solid',
  },
  openingHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    marginBottom: 8,
  },
  openingTitle: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 12,
    color: COLORS.text,
  },
  openingMeta: {
    fontSize: 8,
    color: COLORS.textSubtle,
  },
  // Notes grouping
  noteGroupLabel: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 9,
    color: COLORS.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    marginTop: 8,
    marginBottom: 4,
  },
  noteItem: {
    flexDirection: 'row',
    marginBottom: 3,
    paddingLeft: 8,
  },
  noteBullet: {
    width: 8,
    color: COLORS.textMuted,
  },
  noteText: {
    flex: 1,
    fontSize: 10,
    color: COLORS.text,
  },
  // Markdown blocks
  mdH2: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 11,
    color: COLORS.text,
    marginTop: 8,
    marginBottom: 4,
  },
  mdH3: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 10,
    color: COLORS.textMuted,
    marginTop: 6,
    marginBottom: 3,
  },
  mdParagraph: {
    fontSize: 10,
    color: COLORS.text,
    marginBottom: 4,
  },
  mdBulletItem: {
    flexDirection: 'row',
    marginBottom: 2,
    paddingLeft: 4,
  },
  // Misc
  emptyText: {
    fontSize: 10,
    color: COLORS.textSubtle,
    fontStyle: 'italic',
  },
  // Page footer
  footer: {
    position: 'absolute',
    bottom: 24,
    left: 56,
    right: 56,
    fontSize: 8,
    color: COLORS.textSubtle,
    flexDirection: 'row',
    justifyContent: 'space-between',
    borderTopWidth: 0.5,
    borderTopColor: COLORS.borderSubtle,
    borderTopStyle: 'solid',
    paddingTop: 6,
  },
})

// ── Document ───────────────────────────────────────────────────────────

export function PunchNotesDocument({ data }: { data: PunchNotesPdfData }) {
  const generatedDateStr = formatDate(data.generatedAt)
  const totalNotes =
    data.openings.reduce((sum, o) => sum + o.notes.length, 0) +
    data.projectScopeNotes.length

  return (
    <Document
      title={`${data.project.name} — Punch notes ${generatedDateStr}`}
      author={data.preparedBy ?? 'Door Hardware Tracker'}
      subject="Punch notes export"
    >
      <Page size="LETTER" style={styles.page}>
        {/* Cover header */}
        <View style={styles.coverHeader}>
          <Text style={styles.coverTitle}>{data.project.name}</Text>
          <Text style={styles.coverSubtitle}>Punch notes</Text>
          <View style={styles.coverMetaRow}>
            {data.project.address && (
              <CoverMeta label="Address" value={data.project.address} />
            )}
            {data.project.general_contractor && (
              <CoverMeta label="GC" value={data.project.general_contractor} />
            )}
            {data.project.job_number && (
              <CoverMeta label="Job number" value={data.project.job_number} />
            )}
            {data.project.architect && (
              <CoverMeta label="Architect" value={data.project.architect} />
            )}
            <CoverMeta label="Generated" value={generatedDateStr} />
            {data.preparedBy && (
              <CoverMeta label="Prepared by" value={data.preparedBy} />
            )}
            <CoverMeta
              label="Notes"
              value={`${totalNotes} across ${data.openings.length} opening${data.openings.length === 1 ? '' : 's'}`}
            />
          </View>
        </View>

        {/* Project summary */}
        <Text style={styles.sectionHeader}>Project summary</Text>
        {data.project.summary ? (
          renderMarkdown(data.project.summary)
        ) : (
          <Text style={styles.emptyText}>
            No project summary has been generated for this project yet.
          </Text>
        )}

        {/* Project-scope notes */}
        {data.projectScopeNotes.length > 0 && (
          <>
            <Text style={styles.noteGroupLabel}>Project-scope notes</Text>
            {data.projectScopeNotes.map(n => (
              <View key={n.id} style={styles.noteItem}>
                <Text style={styles.noteBullet}>•</Text>
                <Text style={styles.noteText}>{n.original_text.trim()}</Text>
              </View>
            ))}
          </>
        )}

        {/* Per-opening sections */}
        {data.openings.length > 0 && (
          <Text style={styles.sectionHeader}>Openings</Text>
        )}
        {data.openings.map(opening => (
          <OpeningSection
            key={opening.id}
            opening={opening}
            itemNames={data.itemNames}
          />
        ))}

        {/* Footer (rendered on every page) */}
        <PageFooter
          projectName={data.project.name}
          generatedDateStr={generatedDateStr}
        />
      </Page>
    </Document>
  )
}

// ── Cover meta cell ────────────────────────────────────────────────────

function CoverMeta({ label, value }: { label: string; value: string }) {
  return (
    <View>
      <Text style={styles.coverMetaLabel}>{label}</Text>
      <Text style={styles.coverMetaValue}>{value}</Text>
    </View>
  )
}

// ── Opening section ────────────────────────────────────────────────────

function OpeningSection({
  opening,
  itemNames,
}: {
  opening: PunchNotesPdfOpening
  itemNames: Record<string, string | null>
}) {
  const grouped = groupNotes(opening.notes, itemNames)

  return (
    <View style={styles.openingCard} wrap={true}>
      <View style={styles.openingHeader}>
        <Text style={styles.openingTitle}>Door {opening.door_number}</Text>
        <Text style={styles.openingMeta}>
          {opening.notes.length} note{opening.notes.length === 1 ? '' : 's'}
        </Text>
      </View>

      {opening.summary ? (
        renderMarkdown(opening.summary)
      ) : (
        <Text style={styles.emptyText}>No summary generated for this opening.</Text>
      )}

      {grouped.openingScope.length > 0 && (
        <NoteGroup label="Opening notes" notes={grouped.openingScope} />
      )}
      {(['active', 'inactive', 'shared'] as const).map(side => {
        const list = grouped.byLeafSide[side]
        if (list.length === 0) return null
        return <NoteGroup key={side} label={`${capitalize(side)} leaf`} notes={list} />
      })}
      {grouped.byItem.map(({ itemId, itemName, notes }) => (
        <NoteGroup key={itemId} label={itemName ?? '(unknown item)'} notes={notes} />
      ))}
    </View>
  )
}

// ── Note group ─────────────────────────────────────────────────────────

function NoteGroup({ label, notes }: { label: string; notes: Note[] }) {
  return (
    <View>
      <Text style={styles.noteGroupLabel}>{label}</Text>
      {notes.map(n => (
        <View key={n.id} style={styles.noteItem}>
          <Text style={styles.noteBullet}>•</Text>
          <Text style={styles.noteText}>{n.original_text.trim()}</Text>
        </View>
      ))}
    </View>
  )
}

// ── Page footer ────────────────────────────────────────────────────────

function PageFooter({
  projectName,
  generatedDateStr,
}: {
  projectName: string
  generatedDateStr: string
}) {
  return (
    <View style={styles.footer} fixed={true}>
      <Text>{projectName} · Punch notes · {generatedDateStr}</Text>
      <Text
        render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`}
      />
    </View>
  )
}

// ── Markdown rendering (matches Markdown.tsx grammar) ──────────────────

interface MdBlock {
  type: 'h2' | 'h3' | 'p' | 'ul'
  text?: string
  items?: string[]
}

function parseMarkdown(source: string): MdBlock[] {
  const lines = source.split('\n')
  const blocks: MdBlock[] = []
  let currentList: string[] | null = null
  let currentParagraph: string[] | null = null

  const flushList = () => {
    if (currentList && currentList.length > 0) {
      blocks.push({ type: 'ul', items: currentList })
    }
    currentList = null
  }
  const flushPara = () => {
    if (currentParagraph && currentParagraph.length > 0) {
      blocks.push({ type: 'p', text: currentParagraph.join(' ') })
    }
    currentParagraph = null
  }

  for (const raw of lines) {
    const line = raw.trimEnd()
    if (line === '') {
      flushList()
      flushPara()
      continue
    }
    if (line.startsWith('## ')) {
      flushList()
      flushPara()
      blocks.push({ type: 'h2', text: line.slice(3).trim() })
      continue
    }
    if (line.startsWith('### ')) {
      flushList()
      flushPara()
      blocks.push({ type: 'h3', text: line.slice(4).trim() })
      continue
    }
    const bulletMatch = line.match(/^\s*[-*]\s+(.*)$/)
    if (bulletMatch) {
      flushPara()
      if (!currentList) currentList = []
      currentList.push(bulletMatch[1])
      continue
    }
    flushList()
    if (!currentParagraph) currentParagraph = []
    currentParagraph.push(line.trim())
  }
  flushList()
  flushPara()
  return blocks
}

function renderMarkdown(source: string) {
  return parseMarkdown(source).map((block, i) => {
    switch (block.type) {
      case 'h2':
        return <Text key={i} style={styles.mdH2}>{stripBold(block.text ?? '')}</Text>
      case 'h3':
        return <Text key={i} style={styles.mdH3}>{stripBold(block.text ?? '')}</Text>
      case 'p':
        return <Text key={i} style={styles.mdParagraph}>{stripBold(block.text ?? '')}</Text>
      case 'ul':
        return (
          <View key={i}>
            {(block.items ?? []).map((item, j) => (
              <View key={j} style={styles.mdBulletItem}>
                <Text style={styles.noteBullet}>•</Text>
                <Text style={styles.noteText}>{stripBold(item)}</Text>
              </View>
            ))}
          </View>
        )
    }
  })
}

/** @react-pdf doesn't support inline styling within a Text node without
 *  splitting into multiple <Text>s, which complicates layout. For v1 we
 *  strip the **bold** markers and render the inner text as regular weight.
 *  When a brand font with a bold variant is registered, this can be
 *  upgraded to render <Text> spans in the bold weight. */
function stripBold(text: string): string {
  return text.replace(/\*\*([^*]+)\*\*/g, '$1')
}

// ── Note grouping (parallel to PunchNotesView.groupNotesForDisplay) ────

interface GroupedNotes {
  openingScope: Note[]
  byLeafSide: Record<'active' | 'inactive' | 'shared', Note[]>
  byItem: Array<{ itemId: string; itemName: string | null; notes: Note[] }>
}

function groupNotes(
  notes: Note[],
  itemNames: Record<string, string | null>,
): GroupedNotes {
  const openingScope: Note[] = []
  const byLeafSide: Record<'active' | 'inactive' | 'shared', Note[]> = {
    active: [],
    inactive: [],
    shared: [],
  }
  const byItemMap = new Map<string, Note[]>()
  for (const n of notes) {
    if (n.scope === 'opening') {
      openingScope.push(n)
    } else if (n.scope === 'leaf' && n.leaf_side) {
      byLeafSide[n.leaf_side].push(n)
    } else if (n.scope === 'item' && n.hardware_item_id) {
      const arr = byItemMap.get(n.hardware_item_id) ?? []
      arr.push(n)
      byItemMap.set(n.hardware_item_id, arr)
    } else {
      // Defensive: shouldn't happen given the DB CHECK constraint.
      // Surface at the opening level rather than silently drop.
      openingScope.push(n)
    }
  }
  const byItem = Array.from(byItemMap.entries()).map(([itemId, list]) => ({
    itemId,
    itemName: itemNames[itemId] ?? null,
    notes: list,
  }))
  return { openingScope, byLeafSide, byItem }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
}

// Suppress unused-import warning if Font is not registered yet.
// When swapping to Inter / a brand font, replace this with the real
// Font.register({ family: 'Inter', src: '...' }) call.
void Font
