# NOB-16 validation evidence

Validation date: 2026-08-13

## Browser proof

The Playwright scenario `e2e/autonomous-pipeline-live.spec.ts` was executed against the isolated local GCP stack and passed.

The test:

1. Signed in through the real local authentication screen.
2. Opened the Calculation Runs page for the 5,101-keyword scale project.
3. Confirmed that every project-configuration gate passed.
4. Uploaded the supplied Pilltime SAFS CSV through the browser with its export window and preserved the device dimension.
5. Confirmed 23,787 unique query-device rows were imported from the 24,999 source rows. Exact duplicate records and overlong or malformed rows were reported by the importer.
6. Started a full autonomous pipeline from the UI.
7. Reloaded the page while the run was executing.
8. Waited for that same run to succeed and verified all four tracks, the critical-path label, every visible stage, recorded substitutions, and the cluster/category/quarter/trend rollups.
9. Verified that no unexpected first-party HTTP failures or JavaScript console errors occurred.

Result: `1 passed (3.4m)`

Pipeline run: `547e3e01-a5bf-4f57-be22-18b070da6b35`

- Status: `succeeded`
- Successful stages: `24 / 24`
- Keywords: `5,101`
- Link Power Scores: `5,101`
- HAR v2 rows: `15,303`
- Revenue v2 rows: `15,303`

## Scale proof

The isolated scale validator completed the full 24-stage pipeline with 5,101 keywords and one SERP/LPS record per keyword. It produced 15,303 HAR rows and 15,303 Revenue rows without the previous 5,000-row truncation.

## Control fixture

File: `../pilltime/Pilltime SAFS Export - 21.03.2025 - 01.08.2026 - SAS_2026-08-03_17-49-45.csv`

SHA-256: `c62460949ad1e4ed35058b548a73e4e2289611615b00533bfaf6ff11510eac11`

## Screenshots

- `01-safs-upload-and-readiness.png` — project gates, operator policy, four tracks, rollups, and completed Pilltime browser upload.
- `02-pipeline-succeeded-and-rollups.png` — the exact browser-started run after reload, with all stages succeeded and final rollups visible.
