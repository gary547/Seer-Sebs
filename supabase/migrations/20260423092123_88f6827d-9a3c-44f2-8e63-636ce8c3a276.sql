insert into storage.buckets (id, name, public)
values ('slide-exports', 'slide-exports', true)
on conflict (id) do nothing;

create policy "Internal users upload slide-exports"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'slide-exports'
  and public.get_user_role(auth.uid()) = any (array['super_admin','admin','user'])
);

create policy "Public read slide-exports"
on storage.objects
for select
to public
using (bucket_id = 'slide-exports');

create policy "Internal users delete slide-exports"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'slide-exports'
  and public.get_user_role(auth.uid()) = any (array['super_admin','admin','user'])
);