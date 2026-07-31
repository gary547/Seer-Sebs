ALTER TABLE public.gsc_upload_keywords ADD COLUMN IF NOT EXISTS device text;
ALTER TABLE public.gsc_upload_pages    ADD COLUMN IF NOT EXISTS device text;