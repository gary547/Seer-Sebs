-- Data correction: null out deterministic zero relevancy_score markers on
-- site_architecture rows for non-ranking keywords. These zeros were written
-- by site-architecture's Phase 0a/0b/ruleClassify no-URL branches to mean
-- "not evaluated", but HAR v2 was reading them as an evaluated-irrelevant
-- verdict and applying a -0.8 content-fit penalty. NULL correctly means
-- "not evaluated" and HAR v2 treats it as neutral (0.5) with a confidence
-- penalty.
--
-- Guardrail: only touch rows where the keyword has NO base_rank (i.e.
-- non-ranking). Any zero on a ranking keyword must have come from a
-- genuine evaluation path and is preserved.
WITH updated AS (
  UPDATE public.site_architecture sa
     SET relevancy_score = NULL
    FROM public.keywords k
   WHERE k.id = sa.keyword_id
     AND sa.relevancy_score = 0
     AND k.base_rank IS NULL
  RETURNING sa.keyword_id, k.project_id
)
SELECT project_id, COUNT(*) AS rows_updated
  FROM updated
 GROUP BY project_id
 ORDER BY rows_updated DESC;