# Pilltime SAFS control export

This directory contains the original Search Analytics for Sheets export
provided for the Pilltime upload regression.

## Source file

`Pilltime SAFS Export - 21.03.2025 - 01.08.2026 - SAS_2026-08-03_17-49-45.csv`

- Export range: 2025-03-21 through 2026-08-01
- Format: CSV
- Header: `Query,Device,Clicks,Impressions,CTR,Position`
- Data rows: 25,000
- Size: 1,229,634 bytes
- SHA-256: `c62460949ad1e4ed35058b548a73e4e2289611615b00533bfaf6ff11510eac11`

## Validation role

Use this file to prove that the production upload path:

- accepts the client SAFS format;
- preserves query/device rows;
- records the supplied export date range;
- previews and applies the promotion threshold;
- feeds brand classification, CTR curves and calibration;
- completes the browser-level flow from upload to final rollup.

This export is not the numerical oracle for HAR or Revenue because external
provider data changes over time. Exact calculation assertions belong to the
synthetic golden fixture.
