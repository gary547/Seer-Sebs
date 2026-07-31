-- Add restrictive INSERT policy
CREATE POLICY "Only super_admins can insert roles"
ON public.user_roles FOR INSERT
TO authenticated
WITH CHECK (has_role(auth.uid(), 'super_admin'::app_role));

-- Add restrictive UPDATE policy
CREATE POLICY "Only super_admins can update roles"
ON public.user_roles FOR UPDATE
TO authenticated
USING (has_role(auth.uid(), 'super_admin'::app_role))
WITH CHECK (has_role(auth.uid(), 'super_admin'::app_role));

-- Add restrictive DELETE policy
CREATE POLICY "Only super_admins can delete roles"
ON public.user_roles FOR DELETE
TO authenticated
USING (has_role(auth.uid(), 'super_admin'::app_role));