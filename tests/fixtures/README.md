## Test Fixtures

Golden test PDFs are NOT committed to git (see .gitignore).
Symlink them from `test-pdfs/training/` into this directory.

### Current Golden PDFs (5 baselined)

| Fixture Name | Source | Format | Pages |
|---|---|---|---|
| SMALL_081113.pdf | grid-MCN.pdf | Grid | 12 |
| MEDIUM_306169.pdf | grid-RR.pdf | Grid | 44 |
| LARGE_MCA.pdf | grid-MCA.pdf | Grid | 79 |
| RPL10_NW_Data_Center.pdf | grid-RPL10.pdf | Grid | 52 |
| CAA_Nashville_Yards.pdf | grid-CAA.pdf | Grid | 107 |

### Full Golden PDF Catalog (15 submittals)

**Grid format** (tabular opening list + separate hw set pages):
- grid-MCN.pdf (12pg) — MCN Consulting, Bluebeam
- grid-RR.pdf (44pg) — RR HW Submittal, Word
- grid-MCA.pdf (79pg) — MCA Hardware, Bluebeam
- grid-RPL10.pdf (52pg) — NW Data Center, Bluebeam
- grid-CAA.pdf (107pg) — CAA Nashville Yards, Ecrion

**Schedule format** (heading-block schedules with inline door assignments):
- sched-Kdot.pdf (9pg), sched-Barnstable.pdf (8pg), sched-Claymont.pdf (34pg)
- sched-Cornell.pdf (30pg), sched-DT.pdf (116pg), sched-Etica.pdf (32pg)
- sched-Lutheran.pdf (30pg), sched-AKN.pdf (46pg)

**Kinship format** (spreadsheet-derived):
- kinship-GTN3.pdf (328pg) + kinship-GTN3-truth.csv (ground truth)

**Mixed format** (combined schedule — doors inline under set headings):
- mixed-UCO.pdf (26pg) — UCO1-2 Data Center, Adobe Acrobat Pro
  - Ground truth: 7 sets, 46 openings (26 PRA/PRI pairs + 20 SGL), 72 leaves
  - S02a: 3 by-others (keying only), not counted in 46/72
  - Format: "Heading #: S01b" + "Door:1.01.A.01C" inline, PRA/PRI=pair, SGL=single
  - Pipeline status: UNSUPPORTED (0/0 extraction, S-066C). Needs regex + format work.

### Reference files (not submittals, in test-pdfs/reference/)

Used as negative test cases — pipeline should extract 0 real doors from these.
Tests: `tests/test_reference_docs.py` (9 tests, S-066C).

- arch-DoorSchedule-717010A.pdf (1pg) — Bluebeam architectural door schedule
  - Has 145 doors with set assignments (Layer 1 only, no hardware items)
  - Useful for future cross-validation against hardware submittals
- spec-MarshallCourts.pdf (24pg) — 087100 spec document
  - 0 doors, 1 false-positive set from spec template language
- spec-HarrisHealth.pdf (19pg) — Word facility spec template
  - 10 false-positive "doors" (section numbers), 0 real sets
