ALTER TABLE public.clients
ADD COLUMN IF NOT EXISTS logo_url TEXT;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'client-logos',
  'client-logos',
  true,
  5242880,
  ARRAY['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']
)
ON CONFLICT (id) DO UPDATE
SET public = EXCLUDED.public,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

CREATE POLICY "Client logos are publicly viewable"
ON storage.objects
FOR SELECT
USING (bucket_id = 'client-logos');

CREATE POLICY "Internal users can upload client logos"
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'client-logos'
  AND public.get_user_role(auth.uid()) = ANY (ARRAY['super_admin', 'admin', 'user'])
);

CREATE POLICY "Internal users can update client logos"
ON storage.objects
FOR UPDATE
TO authenticated
USING (
  bucket_id = 'client-logos'
  AND public.get_user_role(auth.uid()) = ANY (ARRAY['super_admin', 'admin', 'user'])
)
WITH CHECK (
  bucket_id = 'client-logos'
  AND public.get_user_role(auth.uid()) = ANY (ARRAY['super_admin', 'admin', 'user'])
);

CREATE POLICY "Internal users can delete client logos"
ON storage.objects
FOR DELETE
TO authenticated
USING (
  bucket_id = 'client-logos'
  AND public.get_user_role(auth.uid()) = ANY (ARRAY['super_admin', 'admin', 'user'])
);