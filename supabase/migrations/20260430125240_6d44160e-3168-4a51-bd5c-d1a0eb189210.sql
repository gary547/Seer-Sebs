-- 1. Add approval columns
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS approval_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS approved_by uuid,
  ADD COLUMN IF NOT EXISTS rejection_reason text;

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_approval_status_check;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_approval_status_check
  CHECK (approval_status IN ('pending','approved','rejected'));

-- 2. Backfill existing profiles to approved (they were already using the app)
UPDATE public.profiles
SET approval_status = 'approved',
    approved_at = COALESCE(approved_at, now())
WHERE approval_status = 'pending';

-- 3. Update handle_new_user trigger to set approval status
CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  default_role public.app_role;
  invited_by_admin boolean;
  initial_status text;
BEGIN
  invited_by_admin := COALESCE((NEW.raw_user_meta_data->>'invited_by_admin')::boolean, false);
  initial_status := CASE WHEN invited_by_admin THEN 'approved' ELSE 'pending' END;

  INSERT INTO public.profiles (id, email, full_name, approval_status, approved_at)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    initial_status,
    CASE WHEN invited_by_admin THEN now() ELSE NULL END
  );

  IF NEW.email LIKE '%@nobraineragency.com' THEN
    default_role := 'user';
  ELSE
    default_role := 'view_only';
  END IF;

  -- Defensive: only ever assign safe defaults here, never admin/super_admin
  IF default_role NOT IN ('user','view_only') THEN
    default_role := 'view_only';
  END IF;

  INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, default_role);
  RETURN NEW;
END;
$function$;

-- 4. RLS policy: admins can update approval fields on any profile
DROP POLICY IF EXISTS "Admins update approval status" ON public.profiles;
CREATE POLICY "Admins update approval status"
  ON public.profiles
  FOR UPDATE
  TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'super_admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'super_admin'::app_role));