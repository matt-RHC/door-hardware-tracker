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

**Mixed format** (product data / hybrid):
- mixed-UCO.pdf (26pg)

### Reference files (not submittals, in test-pdfs/reference/)
- arch-DoorSchedule-717010A.pdf (1pg) — architectural door schedule
- spec-MarshallCourts.pdf (24pg) — 087100 spec document
- spec-HarrisHealth.pdf (19pg) — facility spec template
