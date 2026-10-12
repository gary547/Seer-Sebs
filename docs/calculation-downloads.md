# Calculation downloads

Complete-results exports read saved successful pipeline results. They retain the selected scenario and run ID on every keyset page, reject dirty or active projects, and never start provider or calculation work.

The first page returns the kept-keyword count as `totalKeywords`. The browser uses it for row progress and verifies the final row count before downloading any files. A selected scenario has one row per kept keyword; the combined export has three. Excluded keywords retain their existing unavailable markers and provenance.

Each page has a 60-second timeout and at most five attempts. Transient transport failures and HTTP 408, 429, 500, 502, 503 and 504 retry the same page after bounded exponential waits. Authorization errors, changed inputs, incomplete results, changed columns and changed runs remain terminal. The button shows row progress and reconnecting state, then becomes available again on completion or failure.

CSV pages are encoded into Blob fragments as they arrive, so the browser does not retain the whole export as JavaScript strings. No fragment is downloaded before pagination and completeness checks finish. Parts retain the agreed columns and order, repeat the header and UTF-8 BOM, and preserve numeric zeros and spreadsheet formula protection. Each part is bounded by 50,000 rows and 45 MiB of actual UTF-8 bytes, including its header. Splits occur on page boundaries so all scenarios for a keyword remain together. Single-part exports keep their existing filename.

Pipeline readiness returns accurate financial totals and at most twenty compact records per rollup view. SQL projects only the fields used by the panel and omits full member lists before transferring data to the API. Saved rollups remain unchanged. Readiness, calculation summaries and inspectors share the diagnostic query budget; volume coverage and its bounded sample resolve history once in a single statement. Latest-upload GSC queries are aggregated once for the readiness preview.

Large queued responses can exhaust a shared HTTP/2 session's default memory budget and cause new streams, including preflight, to be rejected. Keeping readiness responses compact addresses that failure mode while bounded export retries cover temporary transport interruptions. See the [Node.js HTTP/2 session memory contract](https://nodejs.org/download/release/v24.16.0/docs/api/http2.html#http2createserveroptions-onrequesthandler).

Regression coverage includes unread readiness responses with parallel preflight on the same h2c session, large nested rollup samples, pinned-page recovery, terminal errors, no partial downloads, exact CSV contracts and PostgreSQL volume-history resolution at scale. Release verification must download all three scenarios completely and reconcile them to saved results without changing the completed run.
