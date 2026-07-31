UPDATE public.keywords
SET keyword = lower(trim(keyword))
WHERE keyword <> lower(trim(keyword));

DROP INDEX IF EXISTS public.keywords_project_keyword_unique;

ALTER TABLE public.keywords
ADD CONSTRAINT keywords_project_keyword_unique
UNIQUE (project_id, keyword);