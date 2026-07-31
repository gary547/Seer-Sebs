
REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM anon, authenticated, public, service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
             WHERE e.extname = 'pg_net' AND n.nspname = 'public') THEN
    EXECUTE 'CREATE SCHEMA IF NOT EXISTS extensions';
    EXECUTE 'GRANT USAGE ON SCHEMA extensions TO anon, authenticated, service_role';
    BEGIN
      EXECUTE 'ALTER EXTENSION pg_net SET SCHEMA extensions';
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'Could not move pg_net: %', SQLERRM;
    END;
  END IF;
END $$;
