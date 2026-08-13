# Autonomous pipeline golden fixture

The golden fixture is a deterministic end-to-end proof of the Seer v2 order of
operations. DataForSEO, Ahrefs and content-fit responses are mocked so the
pipeline can be evaluated independently of live provider changes.

## Required input cases

- a high-click branded GSC query;
- one query represented on desktop and mobile;
- three surface variants sharing one `core_keyword`;
- a discovery keyword with no current rank or URL;
- a positive manual volume paired with a zero provider volume;
- a calibration pair below the click noise floor;
- a keyword below the paid competitive-enrichment threshold;
- repeated competitor domains and URLs for cache assertions;
- informational and transactional SERP features;
- a SERP without a client result for synthetic LPS;
- a transient content-fit failure followed by success;
- monthly history with an explicit seasonal peak and growing trend.

## HAR oracle

For one keyword, competitors are encountered from weakest to strongest with
these beat probabilities:

| Rank | Beat probability |
|---:|---:|
| 10 | 0.80 |
| 5 | 0.55 |
| 1 | 0.35 |

With conservative, realistic and stretch thresholds of `0.60`, `0.50` and
`0.30`, the attainable positions must be 10, 5 and 1 respectively.

A second keyword must fail to beat every competitor and return no attainable
position with an `authority_below_threshold` reason.

## Revenue oracle

For a not-ranking keyword, use:

- annual forward volume: `12,000`
- target CTR: `0.10`
- Revenue visibility multiplier: `0.80`
- CVR: `0.02`
- AOV: `100`
- attainment probability: `0.50`

Expected output:

- current revenue: `0`
- target absolute and incremental revenue: `1,920`
- expected incremental revenue: `960`
- monthly values reconcile to the annual value and peak in the configured month

## Execution proofs

The suite must cover configuration-gate failures with zero provider calls, a
full browser-independent run with overlapping tracks, semantic/provenance
assertions, incremental top-up, economic-only recalculation, dependency-aware
invalidation, retry exhaustion and a 5,001+ keyword scale regression.
