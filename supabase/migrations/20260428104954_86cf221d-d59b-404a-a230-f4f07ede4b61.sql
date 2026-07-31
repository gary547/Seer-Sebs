UPDATE auth.users
SET encrypted_password = crypt('TempSeer2026!ChangeMe', gen_salt('bf')),
    updated_at = now()
WHERE email = 'laura@nobraineragency.com';