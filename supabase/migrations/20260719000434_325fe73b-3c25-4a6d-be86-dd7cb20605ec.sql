ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS brand_terms text[] NULL;
COMMENT ON COLUMN public.clients.brand_terms IS
  'Explicit brand tokens (exact, word-boundary matched, bypass the >=3-char derivation rule). Curated by admins for short-brand clients like AO.';