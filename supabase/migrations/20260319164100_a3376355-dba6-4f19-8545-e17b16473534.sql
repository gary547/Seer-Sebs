
-- 1. Role enum
CREATE TYPE public.app_role AS ENUM ('super_admin', 'admin', 'user', 'view_only');

-- 2. User roles table
CREATE TABLE public.user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  role app_role NOT NULL,
  UNIQUE (user_id, role)
);
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

-- 3. Profiles table
CREATE TABLE public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email text,
  full_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- 4. User-client access mapping (for view_only)
CREATE TABLE public.user_client_access (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  client_id uuid REFERENCES public.clients(id) ON DELETE CASCADE NOT NULL,
  UNIQUE (user_id, client_id)
);
ALTER TABLE public.user_client_access ENABLE ROW LEVEL SECURITY;

-- 5. Security definer: has_role
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role app_role)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND role = _role
  )
$$;

-- 6. Security definer: get_user_role (returns highest role)
CREATE OR REPLACE FUNCTION public.get_user_role(_user_id uuid)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT role::text FROM public.user_roles
  WHERE user_id = _user_id
  ORDER BY CASE role
    WHEN 'super_admin' THEN 1
    WHEN 'admin' THEN 2
    WHEN 'user' THEN 3
    WHEN 'view_only' THEN 4
  END
  LIMIT 1
$$;

-- 7. Trigger: auto-create profile + assign role on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name)
  VALUES (NEW.id, NEW.email, COALESCE(NEW.raw_user_meta_data->>'full_name', ''));

  IF NEW.email LIKE '%@nobraineragency.com' THEN
    INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, 'user');
  ELSE
    INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, 'view_only');
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- 8. RLS for user_roles
CREATE POLICY "Users read own roles"
  ON public.user_roles FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'super_admin'));

CREATE POLICY "Super admins manage roles"
  ON public.user_roles FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'super_admin'))
  WITH CHECK (public.has_role(auth.uid(), 'super_admin'));

-- 9. RLS for profiles
CREATE POLICY "Users read own profile"
  ON public.profiles FOR SELECT TO authenticated
  USING (id = auth.uid() OR public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'super_admin'));

CREATE POLICY "Users update own profile"
  ON public.profiles FOR UPDATE TO authenticated
  USING (id = auth.uid());

CREATE POLICY "System inserts profiles"
  ON public.profiles FOR INSERT TO authenticated
  WITH CHECK (id = auth.uid());

-- 10. RLS for user_client_access
CREATE POLICY "Admins manage client access"
  ON public.user_client_access FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'super_admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'super_admin'));

CREATE POLICY "Users read own client access"
  ON public.user_client_access FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- 11. Tighten clients RLS (replace existing "Authenticated full access")
DROP POLICY IF EXISTS "Authenticated full access" ON public.clients;

CREATE POLICY "Internal users full access to clients"
  ON public.clients FOR ALL TO authenticated
  USING (
    public.get_user_role(auth.uid()) IN ('super_admin', 'admin', 'user')
  )
  WITH CHECK (
    public.get_user_role(auth.uid()) IN ('super_admin', 'admin', 'user')
  );

CREATE POLICY "View-only users see assigned clients"
  ON public.clients FOR SELECT TO authenticated
  USING (
    public.get_user_role(auth.uid()) = 'view_only'
    AND id IN (SELECT client_id FROM public.user_client_access WHERE user_id = auth.uid())
  );

-- 12. Tighten navigator_projects RLS
DROP POLICY IF EXISTS "Authenticated full access" ON public.navigator_projects;

CREATE POLICY "Internal users full access to projects"
  ON public.navigator_projects FOR ALL TO authenticated
  USING (
    public.get_user_role(auth.uid()) IN ('super_admin', 'admin', 'user')
  )
  WITH CHECK (
    public.get_user_role(auth.uid()) IN ('super_admin', 'admin', 'user')
  );

CREATE POLICY "View-only users see assigned projects"
  ON public.navigator_projects FOR SELECT TO authenticated
  USING (
    public.get_user_role(auth.uid()) = 'view_only'
    AND client_id IN (SELECT client_id FROM public.user_client_access WHERE user_id = auth.uid())
  );

-- 13. Tighten competitors RLS
DROP POLICY IF EXISTS "Authenticated full access" ON public.competitors;

CREATE POLICY "Internal users full access to competitors"
  ON public.competitors FOR ALL TO authenticated
  USING (public.get_user_role(auth.uid()) IN ('super_admin', 'admin', 'user'))
  WITH CHECK (public.get_user_role(auth.uid()) IN ('super_admin', 'admin', 'user'));

CREATE POLICY "View-only users see assigned competitors"
  ON public.competitors FOR SELECT TO authenticated
  USING (
    public.get_user_role(auth.uid()) = 'view_only'
    AND client_id IN (SELECT client_id FROM public.user_client_access WHERE user_id = auth.uid())
  );

-- 14. Tighten keyword_rules RLS
DROP POLICY IF EXISTS "Authenticated full access" ON public.keyword_rules;

CREATE POLICY "Internal users full access to keyword_rules"
  ON public.keyword_rules FOR ALL TO authenticated
  USING (public.get_user_role(auth.uid()) IN ('super_admin', 'admin', 'user'))
  WITH CHECK (public.get_user_role(auth.uid()) IN ('super_admin', 'admin', 'user'));

CREATE POLICY "View-only users see assigned keyword_rules"
  ON public.keyword_rules FOR SELECT TO authenticated
  USING (
    public.get_user_role(auth.uid()) = 'view_only'
    AND client_id IN (SELECT client_id FROM public.user_client_access WHERE user_id = auth.uid())
  );

-- 15. Tighten keywords RLS (via project_id -> navigator_projects -> client_id)
DROP POLICY IF EXISTS "Authenticated full access" ON public.keywords;

CREATE POLICY "Internal users full access to keywords"
  ON public.keywords FOR ALL TO authenticated
  USING (public.get_user_role(auth.uid()) IN ('super_admin', 'admin', 'user'))
  WITH CHECK (public.get_user_role(auth.uid()) IN ('super_admin', 'admin', 'user'));

CREATE POLICY "View-only users see assigned keywords"
  ON public.keywords FOR SELECT TO authenticated
  USING (
    public.get_user_role(auth.uid()) = 'view_only'
    AND project_id IN (
      SELECT np.id FROM public.navigator_projects np
      JOIN public.user_client_access uca ON uca.client_id = np.client_id
      WHERE uca.user_id = auth.uid()
    )
  );

-- 16. Tighten remaining tables that chain through keyword_id
-- keyword_forecasts
DROP POLICY IF EXISTS "Authenticated full access" ON public.keyword_forecasts;
CREATE POLICY "Internal users full access to keyword_forecasts"
  ON public.keyword_forecasts FOR ALL TO authenticated
  USING (public.get_user_role(auth.uid()) IN ('super_admin', 'admin', 'user'))
  WITH CHECK (public.get_user_role(auth.uid()) IN ('super_admin', 'admin', 'user'));
CREATE POLICY "View-only see assigned keyword_forecasts"
  ON public.keyword_forecasts FOR SELECT TO authenticated
  USING (
    public.get_user_role(auth.uid()) = 'view_only'
    AND keyword_id IN (
      SELECT k.id FROM public.keywords k
      JOIN public.navigator_projects np ON np.id = k.project_id
      JOIN public.user_client_access uca ON uca.client_id = np.client_id
      WHERE uca.user_id = auth.uid()
    )
  );

-- keyword_monthly_volumes
DROP POLICY IF EXISTS "Authenticated full access" ON public.keyword_monthly_volumes;
CREATE POLICY "Internal users full access to keyword_monthly_volumes"
  ON public.keyword_monthly_volumes FOR ALL TO authenticated
  USING (public.get_user_role(auth.uid()) IN ('super_admin', 'admin', 'user'))
  WITH CHECK (public.get_user_role(auth.uid()) IN ('super_admin', 'admin', 'user'));
CREATE POLICY "View-only see assigned keyword_monthly_volumes"
  ON public.keyword_monthly_volumes FOR SELECT TO authenticated
  USING (
    public.get_user_role(auth.uid()) = 'view_only'
    AND keyword_id IN (
      SELECT k.id FROM public.keywords k
      JOIN public.navigator_projects np ON np.id = k.project_id
      JOIN public.user_client_access uca ON uca.client_id = np.client_id
      WHERE uca.user_id = auth.uid()
    )
  );

-- serp_features
DROP POLICY IF EXISTS "Authenticated full access" ON public.serp_features;
CREATE POLICY "Internal users full access to serp_features"
  ON public.serp_features FOR ALL TO authenticated
  USING (public.get_user_role(auth.uid()) IN ('super_admin', 'admin', 'user'))
  WITH CHECK (public.get_user_role(auth.uid()) IN ('super_admin', 'admin', 'user'));
CREATE POLICY "View-only see assigned serp_features"
  ON public.serp_features FOR SELECT TO authenticated
  USING (
    public.get_user_role(auth.uid()) = 'view_only'
    AND keyword_id IN (
      SELECT k.id FROM public.keywords k
      JOIN public.navigator_projects np ON np.id = k.project_id
      JOIN public.user_client_access uca ON uca.client_id = np.client_id
      WHERE uca.user_id = auth.uid()
    )
  );

-- serp_landscape
DROP POLICY IF EXISTS "Authenticated full access" ON public.serp_landscape;
CREATE POLICY "Internal users full access to serp_landscape"
  ON public.serp_landscape FOR ALL TO authenticated
  USING (public.get_user_role(auth.uid()) IN ('super_admin', 'admin', 'user'))
  WITH CHECK (public.get_user_role(auth.uid()) IN ('super_admin', 'admin', 'user'));
CREATE POLICY "View-only see assigned serp_landscape"
  ON public.serp_landscape FOR SELECT TO authenticated
  USING (
    public.get_user_role(auth.uid()) = 'view_only'
    AND keyword_id IN (
      SELECT k.id FROM public.keywords k
      JOIN public.navigator_projects np ON np.id = k.project_id
      JOIN public.user_client_access uca ON uca.client_id = np.client_id
      WHERE uca.user_id = auth.uid()
    )
  );

-- serp_rankings
DROP POLICY IF EXISTS "Authenticated full access" ON public.serp_rankings;
CREATE POLICY "Internal users full access to serp_rankings"
  ON public.serp_rankings FOR ALL TO authenticated
  USING (public.get_user_role(auth.uid()) IN ('super_admin', 'admin', 'user'))
  WITH CHECK (public.get_user_role(auth.uid()) IN ('super_admin', 'admin', 'user'));
CREATE POLICY "View-only see assigned serp_rankings"
  ON public.serp_rankings FOR SELECT TO authenticated
  USING (
    public.get_user_role(auth.uid()) = 'view_only'
    AND keyword_id IN (
      SELECT k.id FROM public.keywords k
      JOIN public.navigator_projects np ON np.id = k.project_id
      JOIN public.user_client_access uca ON uca.client_id = np.client_id
      WHERE uca.user_id = auth.uid()
    )
  );

-- backlink_metrics (chains through serp_ranking_id)
DROP POLICY IF EXISTS "Authenticated full access" ON public.backlink_metrics;
CREATE POLICY "Internal users full access to backlink_metrics"
  ON public.backlink_metrics FOR ALL TO authenticated
  USING (public.get_user_role(auth.uid()) IN ('super_admin', 'admin', 'user'))
  WITH CHECK (public.get_user_role(auth.uid()) IN ('super_admin', 'admin', 'user'));
CREATE POLICY "View-only see assigned backlink_metrics"
  ON public.backlink_metrics FOR SELECT TO authenticated
  USING (
    public.get_user_role(auth.uid()) = 'view_only'
    AND serp_ranking_id IN (
      SELECT sr.id FROM public.serp_rankings sr
      JOIN public.keywords k ON k.id = sr.keyword_id
      JOIN public.navigator_projects np ON np.id = k.project_id
      JOIN public.user_client_access uca ON uca.client_id = np.client_id
      WHERE uca.user_id = auth.uid()
    )
  );

-- site_architecture
DROP POLICY IF EXISTS "Authenticated full access" ON public.site_architecture;
CREATE POLICY "Internal users full access to site_architecture"
  ON public.site_architecture FOR ALL TO authenticated
  USING (public.get_user_role(auth.uid()) IN ('super_admin', 'admin', 'user'))
  WITH CHECK (public.get_user_role(auth.uid()) IN ('super_admin', 'admin', 'user'));
CREATE POLICY "View-only see assigned site_architecture"
  ON public.site_architecture FOR SELECT TO authenticated
  USING (
    public.get_user_role(auth.uid()) = 'view_only'
    AND keyword_id IN (
      SELECT k.id FROM public.keywords k
      JOIN public.navigator_projects np ON np.id = k.project_id
      JOIN public.user_client_access uca ON uca.client_id = np.client_id
      WHERE uca.user_id = auth.uid()
    )
  );

-- ctr_curves (via project_id)
DROP POLICY IF EXISTS "Authenticated full access" ON public.ctr_curves;
CREATE POLICY "Internal users full access to ctr_curves"
  ON public.ctr_curves FOR ALL TO authenticated
  USING (public.get_user_role(auth.uid()) IN ('super_admin', 'admin', 'user'))
  WITH CHECK (public.get_user_role(auth.uid()) IN ('super_admin', 'admin', 'user'));
CREATE POLICY "View-only see assigned ctr_curves"
  ON public.ctr_curves FOR SELECT TO authenticated
  USING (
    public.get_user_role(auth.uid()) = 'view_only'
    AND project_id IN (
      SELECT np.id FROM public.navigator_projects np
      JOIN public.user_client_access uca ON uca.client_id = np.client_id
      WHERE uca.user_id = auth.uid()
    )
  );

-- serp_feature_index is a reference/lookup table, keep it readable by all authenticated
DROP POLICY IF EXISTS "Authenticated full access" ON public.serp_feature_index;
CREATE POLICY "All authenticated read serp_feature_index"
  ON public.serp_feature_index FOR SELECT TO authenticated
  USING (true);
CREATE POLICY "Internal users manage serp_feature_index"
  ON public.serp_feature_index FOR ALL TO authenticated
  USING (public.get_user_role(auth.uid()) IN ('super_admin', 'admin', 'user'))
  WITH CHECK (public.get_user_role(auth.uid()) IN ('super_admin', 'admin', 'user'));
