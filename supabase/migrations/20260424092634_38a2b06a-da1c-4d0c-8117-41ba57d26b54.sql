DROP POLICY IF EXISTS "Client logos are publicly viewable" ON storage.objects;

CREATE POLICY "Internal users can view client logo objects"
ON storage.objects
FOR SELECT
TO authenticated
USING (
  bucket_id = 'client-logos'
  AND public.get_user_role(auth.uid()) = ANY (ARRAY['super_admin', 'admin', 'user'])
);