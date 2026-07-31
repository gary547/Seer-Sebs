# CTR Curves v2 — "Generate" button disabled on TVs Ongoing

**Date:** 2026-07-19
**Author:** Lovable agent (information only — no build changes)
**Scope:** Explain why the "Generate CTR curves (v2)" button on `/admin/calculations` is not clickable for the TVs Ongoing project, and identify the minimal fix path for a future turn.

---

## 1. Root cause: source-string mismatch between the uploader and the CTR trigger

The button's enabled state is driven by `projectHasReadyWorkbook` in `src/pages/admin/CalculationsPage.tsx` (lines 472-481):

```ts
const projectHasReadyWorkbook = useMemo(() => {
  if (!probeProjectId) return false;
  return (gscUploadsRaw ?? []).some(
    (u) =>
      u.project_id === probeProjectId &&
      u.source === "gsc_workbook_v1" &&   // <-- requires this exact source string
      !!u.date_range_start &&
      !!u.date_range_end
  );
}, [gscUploadsRaw, probeProjectId]);
```

The only GSC upload on TVs Ongoing (from the live `/rest/v1/gsc_uploads` snapshot) is:

```
id:      3dbe61d9-09de-422d-bfd9-a693f1d6b466
project: 5fd4df7e-45dd-40c0-b10e-86ea6dad9720 (TVs Ongoing)
source:  "gsc_csv_v2"           <-- NOT "gsc_workbook_v1"
device:  "mixed"
range:   2025-03-06 → 2026-07-16
rows:    25,000
uploaded_at: 2026-07-19T13:44:45Z
```

Because `source` is `gsc_csv_v2`, the `.some(...)` predicate returns `false`, `projectHasReadyWorkbook` is `false`, and the button's `disabled` prop evaluates truthy. The tooltip you would see is the "Upload a GSC workbook first…" branch.

## 2. The edge function has the same filter, so bypassing the UI wouldn't help either

`supabase/functions/ctr-curves-from-gsc/index.ts` selects the upload with:

```ts
sb.from("gsc_uploads")
  .select(...)
  .eq("project_id", projectId)
  .eq("source", "gsc_workbook_v1")       // same string, hard-coded
  .not("date_range_start", "is", null)
  .not("date_range_end", "is", null)
```

If invoked directly (curl / functions.invoke) it would return `404 no_valid_upload` on TVs Ongoing for the identical reason.

## 3. Why the mismatch exists

Two upload paths landed at different times and were never reconciled:

- The **v2 unified panel** (`GscUploadPanel` / `gsc-workbook-import`, Prompts 2.1 and 2.1b) writes `source = "gsc_csv_v2"`. This is what produced the TVs Ongoing row on 2026-07-19 13:44 UTC and the SEO row on 2026-07-18 22:50 UTC.
- The **CTR generator + its gating check** (Prompt 2.3) were built against the older label `"gsc_workbook_v1"` and were not updated when 2.1b renamed the source.

Both current uploads carry `gsc_csv_v2`, so no project in the dataset has an upload the CTR trigger considers "ready". The button is effectively dead across the whole tenant, not just on TVs Ongoing.

## 4. What the fix would look like (for a future build turn — not delivered here)

Two coordinated one-line changes, both accepting the current-production label:

1. `src/pages/admin/CalculationsPage.tsx` line 477 — replace the source check with the value written by the current uploader (`gsc_csv_v2`), or accept both `gsc_csv_v2` and `gsc_workbook_v1` for backwards compatibility.
2. `supabase/functions/ctr-curves-from-gsc/index.ts` — change the `.eq("source", ...)` filter identically, then redeploy.

Also worth confirming during that fix: `ctr-curves-from-gsc` reads per-row `device` and `is_branded` from `gsc_upload_keywords`. Verify the v2 importer populates those columns for `gsc_csv_v2` rows the same way the legacy workbook path did — otherwise the run would succeed but produce a single `device='all'` curve with `unclassified_rows` equal to the whole dataset, defeating Prompt 2.3's device-aware and branded-exclusion contract.

## 5. Summary

The button isn't broken in the UI sense — it is correctly disabled given its current predicate. The predicate is stale: it looks for `source = "gsc_workbook_v1"`, but Prompt 2.1b's uploader writes `source = "gsc_csv_v2"`. The edge function shares the same stale filter. Until both are aligned, no CTR generation is reachable through this trigger for any project.
