-- Add missing columns to serp_features
ALTER TABLE public.serp_features
ADD COLUMN IF NOT EXISTS result_type text,
ADD COLUMN IF NOT EXISTS serp_intent text,
ADD COLUMN IF NOT EXISTS snippet_opportunity boolean DEFAULT false;

-- Add missing column to serp_landscape
ALTER TABLE public.serp_landscape
ADD COLUMN IF NOT EXISTS device text;