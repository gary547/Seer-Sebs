-- Promote Laura to super_admin (idempotent)
INSERT INTO public.user_roles (user_id, role)
SELECT u.id, 'super_admin'::app_role
FROM auth.users u
WHERE lower(u.email) = 'laura@nobraineragency.com'
ON CONFLICT DO NOTHING;

-- Remove any non-super_admin roles for Laura to avoid ambiguity
DELETE FROM public.user_roles ur
USING auth.users u
WHERE ur.user_id = u.id
  AND lower(u.email) = 'laura@nobraineragency.com'
  AND ur.role <> 'super_admin'::app_role;

-- Prevent duplicate client access grants
CREATE UNIQUE INDEX IF NOT EXISTS user_client_access_user_client_uniq
  ON public.user_client_access (user_id, client_id);
