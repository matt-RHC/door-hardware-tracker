# 03 — Users & Domain

## Primary target user for this redesign

The **busy field superintendent or foreman** is the person the redesign has to work for. They're the hardest user to serve — on-site, time-compressed, carrying a phone, not interested in software. The product promise — *"import it, track it, forget it"* — is for them. The consultant sets up the job; Darrin (the AI assistant) handles the domain reasoning; the super scans a QR, sees what's specified, checks it off, and moves on. If the redesign works for the super, it works for everyone else by construction.

## User personas

**Door-hardware consultant (office) — primary desktop user.** Large monitor. Tolerates dense tables. Uploads PDFs, reviews extractions, answers field questions, exports CSVs. Multiple projects open simultaneously. Never on mobile.

**Field tech / installer (jobsite) — primary mobile user.** Phone. Gloves. Direct sunlight — light mode non-negotiable. Spotty connectivity. PWA installable, offline capable. Scans QR → reads list → taps stages → photos → files issues.

**Project manager — desktop + tablet.** Watches completion, SLA timers, punch lists.

**Admin — desktop only, rare.** Companies, domains, members, tracking.

## Domain glossary — 15 terms Claude Design must use correctly

| Term | Meaning |
|---|---|
| Opening | A single door location in a building. In the UI, "doors" usually means openings. |
| Leaf | A physical door panel. An opening can have one or two leaves. |
| Hardware set (HW set) | A named bundle of items applied to one or more openings. E.g., "DH1-10" = data-hall corridor pairs (10' tall). |
| Hardware item | A single line item — e.g., "1 EA Schlage L9080B 06A." |
| Submittal | A PDF from the supplier listing products for approval. What the app ingests. |
| Door schedule | The drawing sheet listing every opening and its spec. |
| Frame elevation | The drawing showing frame geometry. |
| Hand / handing | Which way the door swings — LH, RH, LHR, RHR, LHRA/RHRA (active leaf on pairs), DELHR (double-egress). |
| Fire rating | Certification in minutes (20, 45, 60, 90) or NR. |
| Keying | Master/grand-master key relationships. This reference project uses Best SFIC with temp cores during construction. |
| Field install | Hardware installed on-site. |
| Bench install | Hardware pre-installed in a shop before delivery. |
| QA / QC | Post-install quality check. Findings can become punch items. |
| Punch list | Outstanding QA findings needing remediation before closeout. |
| SLA | Issue deadline driven by severity — Critical / High / Medium / Low. |

## Scale — drives table density

Based on a real submittal (Radius DC, Nashville):

- **50–500 openings per project** (reference: 82; typical 100–200)
- **3–25 hardware items per opening**
- **10–35 hardware sets per project** (reference: 34)
- **0–50 issues / RFIs per project lifetime** (reference submittal: 10 RFIs)
- **0–50 QA findings**
- **1–10 active projects per company**

## Primary user flows

1. **Sign-in → portfolio.** Email → `/api/auth/resolve` picks OAuth provider → dashboard.
2. **Scan QR → check off hardware.** Field tech scans → door detail → stages → photos → filed.
3. **Upload PDF → extract → review → promote.** Consultant uploads in Import Wizard → AI extracts → Darrin reviews → consultant resolves issues → promote.
4. **Create issue → track to resolution.** Severity sets SLA; kanban/list tracks to closure.
5. **QA punch list.** Findings created inline → tracked to closeout.
6. **Reporting / export.** Dashboard → CSV.
