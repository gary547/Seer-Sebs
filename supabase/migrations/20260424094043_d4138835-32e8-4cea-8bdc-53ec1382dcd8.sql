UPDATE storage.buckets
SET public = false
WHERE id = 'client-logos';

DROP POLICY IF EXISTS "Client logos are publicly viewable" ON storage.objects;
DROP POLICY IF EXISTS "Internal users can view client logo objects" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can view permitted client logos" ON storage.objects;

CREATE POLICY "Authenticated users can view permitted client logos"
ON storage.objects
FOR SELECT
TO authenticated
USING (
  bucket_id = 'client-logos'
  AND (
    public.get_user_role(auth.uid()) = ANY (ARRAY['super_admin', 'admin', 'user'])
    OR (
      public.get_user_role(auth.uid()) = 'view_only'
      AND (storage.foldername(name))[1]::uuid IN (
        SELECT uca.client_id
        FROM public.user_client_access uca
        WHERE uca.user_id = auth.uid()
      )
    )
  )
);

DROP POLICY IF EXISTS "Internal users can upload client logos" ON storage.objects;
DROP POLICY IF EXISTS "Internal users can update client logos" ON storage.objects;
DROP POLICY IF EXISTS "Internal users can delete client logos" ON storage.objects;

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