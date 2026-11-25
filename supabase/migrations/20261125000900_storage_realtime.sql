-- ============================================================================
-- AURA · 009 · Supabase Storage buckets + Realtime publication
-- Guarded so the migrations also run on plain PostgreSQL/PostGIS (tests).
-- ============================================================================

do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage')
     and exists (select 1 from pg_tables where schemaname = 'storage' and tablename = 'buckets') then

    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
      ('driver-documents', 'driver-documents', false, 10485760, array['image/jpeg', 'image/png', 'application/pdf']),
      ('avatars',          'avatars',          false,  2097152, array['image/jpeg', 'image/png', 'image/webp'])
    on conflict (id) do nothing;

    -- Files live under <auth.uid()>/… ; drivers can add but never overwrite or delete documents.
    execute $p$
      create policy "aura_driver_docs_insert_own" on storage.objects for insert to authenticated
      with check (bucket_id = 'driver-documents' and (storage.foldername(name))[1] = (select auth.uid())::text)
    $p$;
    execute $p$
      create policy "aura_driver_docs_read" on storage.objects for select to authenticated
      using (bucket_id = 'driver-documents'
             and ((storage.foldername(name))[1] = (select auth.uid())::text or private.admin_can('drivers.view')))
    $p$;
    execute $p$
      create policy "aura_avatars_write_own" on storage.objects for insert to authenticated
      with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text)
    $p$;
    execute $p$
      create policy "aura_avatars_update_own" on storage.objects for update to authenticated
      using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text)
    $p$;
    execute $p$
      create policy "aura_avatars_read" on storage.objects for select to authenticated
      using (bucket_id = 'avatars')
    $p$;
  end if;
end $$;

-- Realtime: clients subscribe to rides / events / live driver location /
-- support messages. RLS still applies to every change delivered.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table
      public.rides, public.ride_events, public.driver_locations, public.ticket_messages;
  end if;
end $$;
