# Link Power inspection

The admin Link Power inspector reads the latest successful project run and never recalculates scores or requests provider data. Administrator and project authorization precede every diagnostic read. Summary counts and distributions cover every saved score; the ten-domain sample and detail pagination only bound display rows.

Score percentiles are exact continuous percentiles over a frequency histogram of the stored two-decimal scores. Cumulative frequencies locate the same lower and upper observations and interpolation fraction as PostgreSQL `percentile_cont`, without sorting the full joined result set. Confidence totals and weighted mean retain every observation, including measured zeros. Keyword coverage uses the run's distinct keyword IDs.

Domain grouping also computes missing-component totals over every scored result. Those totals are aggregated before selecting the ten displayed domains. Unfiltered row counts reuse the complete scored count, avoiding an additional whole-run join.

Migration `039_link_power_inspector_index` supplies the run-scoped score ordering and covered detail keys. The detail query keeps score descending, normalized keyword, rank and result ID as stable ordering keys. Only the selected page needs full display fields. Filtered requests union keyword and domain matches before counting and pagination, so a result matching both appears once. Empty and beyond-last-page searches still return their exact count with an empty display page.

All reads use the shared diagnostic SQL budget. No increased production statement timeout, skipped rows, sampled totals, persistent response cache or provider fallback is required for this contract.

`test:gcp-link-power-scale` checks exact summary and percentile parity against PostgreSQL, global missing-component totals, numeric domain ordering, search deduplication, pagination, zeros, empty results and project/run isolation with 900,000 current scores, 450,000 historical/other-project scores and 1.8 million SERP rows. It runs inside the full Docker gate. Release verification compares the live response to a read-only baseline and opens the complete panel with simultaneous calculations requests before marking the issue complete.
