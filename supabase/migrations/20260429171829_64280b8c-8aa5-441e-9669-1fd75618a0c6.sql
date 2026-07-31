UPDATE public.navigator_projects
SET har_status = 'idle'
WHERE id = 'c9e35733-de93-4ea5-a129-a025e0fcad17'
  AND har_status IN ('error', 'running', 'failed');