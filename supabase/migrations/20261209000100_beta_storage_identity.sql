-- ═══════════════════════════════════════════════════════════════════════════
-- 024 · BETA readiness: Storage closed to blocked accounts; backend identity for the BETA app.
--
-- Storage review (migration 009 policies on storage.objects):
--   driver-documents  insert own folder · read own folder or staff with drivers.view · no update/delete
--   avatars           insert own folder · update own folder · read: any signed-in user · no delete
-- Before 024 a blocked account could still upload documents, replace its avatar and browse every
-- avatar. 024 adds RESTRICTIVE policies (they AND with every permissive policy, present or future):
--   aura_blocked_no_upload / _no_update / _no_delete : a blocked account writes nothing
--   aura_blocked_own_files_only                      : a blocked account reads only its own folder
--                                                      (its own documents stay downloadable — PDPL access)
-- Staff access is unchanged (admin_can already refuses blocked staff).
-- Guarded like 009: on a database without the Storage schema nothing is created.
--
-- public.my_environment(): the signed-in client asks which environment it is talking to, so a BETA
-- build signs out and stops when it is pointed at any database whose marker is not 'beta'
-- (production has no beta marker). Authenticated only; returns 'beta' | 'production' | null.
-- ═══════════════════════════════════════════════════════════════════════════

do $$
begin
  if to_regclass('storage.objects') is not null then
    execute $p$
      create policy "aura_blocked_no_upload" on storage.objects as restrictive for insert to authenticated
      with check (not private.actor_is_blocked())
    $p$;
    execute $p$
      create policy "aura_blocked_no_update" on storage.objects as restrictive for update to authenticated
      using (not private.actor_is_blocked()) with check (not private.actor_is_blocked())
    $p$;
    execute $p$
      create policy "aura_blocked_no_delete" on storage.objects as restrictive for delete to authenticated
      using (not private.actor_is_blocked())
    $p$;
    execute $p$
      create policy "aura_blocked_own_files_only" on storage.objects as restrictive for select to authenticated
      using (not private.actor_is_blocked() or (storage.foldername(name))[1] = (select auth.uid())::text)
    $p$;
  end if;
end $$;

create or replace function public.my_environment()
returns text
language sql stable security definer
set search_path = ''
as $$ select ops_guard.current_mode() $$;
revoke all on function public.my_environment() from public, anon, service_role;
grant execute on function public.my_environment() to authenticated;

-- ── integrity_check: also verify the Storage policies (latest definition + the marked block) ──
CREATE OR REPLACE FUNCTION ops_guard.integrity_check()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  f      jsonb := '[]'::jsonb;
  t      text;
  r      text;
  fn     text;
  priv   text;
  prev   boolean;
  prev_f jsonb;
  since  timestamptz;
  v_ok   boolean;
  v_mode text := ops_guard.current_mode();
begin
  if ops_guard.marker_state() <> 'ok' then
    f := f || jsonb_build_array('marker_' || ops_guard.marker_state());
  end if;
  -- P3 + marker immutability triggers: present and ENABLE ALWAYS ('A').
  foreach t in array array['public.payments', 'public.payment_methods', 'public.payouts', 'public.wasl_sync_log'] loop
    foreach r in array array['aa_ops_guard_write', 'aa_ops_guard_truncate'] loop
      if not exists (select 1 from pg_trigger where tgrelid = t::regclass and tgname = r and tgenabled = 'A') then
        f := f || jsonb_build_array('trigger_not_always:' || t || '.' || r);
      end if;
    end loop;
    -- P1: no direct write privilege for API roles.
    foreach r in array array['anon', 'authenticated', 'service_role'] loop
      foreach priv in array array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] loop
        if has_table_privilege(r, t, priv) then
          f := f || jsonb_build_array('direct_write:' || r || ':' || priv || ':' || t);
        end if;
      end loop;
    end loop;
  end loop;
  foreach r in array array['environment_no_update', 'environment_no_truncate'] loop
    if not exists (select 1 from pg_trigger where tgrelid = 'ops_guard.environment'::regclass and tgname = r and tgenabled = 'A') then
      f := f || jsonb_build_array('trigger_not_always:ops_guard.environment.' || r);
    end if;
  end loop;
  -- Audit trails: append-only triggers present and ENABLE ALWAYS.
  foreach t in array array['ops_guard.allowlist_log', 'ops_guard.integrity_events', 'ops_guard.guard_exemptions', 'ops_guard.revocation_log'] loop
    if (select count(*) from pg_trigger where tgrelid = t::regclass and tgenabled = 'A'
          and tgname in ('allowlist_log_append_only', 'allowlist_log_no_truncate', 'integrity_events_retention_only', 'integrity_events_no_truncate',
                         'guard_exemptions_append_only', 'guard_exemptions_no_truncate', 'revocation_log_append_only', 'revocation_log_no_truncate')) <> 2 then
      f := f || jsonb_build_array('audit_trigger_not_always:' || t);
    end if;
  end loop;
  foreach r in array array['allowlist_guarded', 'allowlist_no_truncate'] loop
    if not exists (select 1 from pg_trigger where tgrelid = 'ops_guard.allowlist'::regclass and tgname = r and tgenabled = 'A') then
      f := f || jsonb_build_array('trigger_not_always:ops_guard.allowlist.' || r);
    end if;
  end loop;
  if not exists (select 1 from pg_trigger where tgrelid = 'auth.users'::regclass and tgname = 'aa_ops_guard_signup' and tgenabled in ('O', 'A')) then
    f := f || jsonb_build_array('trigger_disabled:auth.users.aa_ops_guard_signup');
  end if;
  -- Guard tables: no API role may touch them.
  foreach t in array array['ops_guard.environment', 'ops_guard.allowlist', 'ops_guard.allowlist_log', 'ops_guard.integrity_status', 'ops_guard.integrity_events',
                             'ops_guard.guard_exemptions', 'ops_guard.revocation_log'] loop
    foreach r in array array['anon', 'authenticated', 'service_role'] loop
      if has_table_privilege(r, t, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') then
        f := f || jsonb_build_array('guard_table_privilege:' || r || ':' || t);
      end if;
    end loop;
  end loop;
  -- P2: every sensitive writer is still a postgres-owned SECURITY DEFINER calling the guard.
  foreach fn in array array['create_payment_intent', 'record_provider_payment', 'save_payment_method', 'admin_refund_payment',
                            'remove_payment_method', 'set_default_payment_method', 'request_payout', 'create_payout_batch',
                            'admin_set_payout_status', 'complete_payout', 'record_wasl_result'] loop
    if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname = 'public' and p.proname = fn and p.prosecdef
                      and p.prosrc like '%ops_guard.assert_environment%'
                      and p.proowner = (select nspowner from pg_namespace where nspname = 'ops_guard')) then
      f := f || jsonb_build_array('p2_missing:' || fn);
    end if;
  end loop;
  -- F2 (migration 023): blocked accounts are refused by the RPCs and by direct (RLS) writes.
  foreach fn in array array['add_wallet_tip', 'request_payout', 'set_default_payment_method', 'remove_payment_method', 'rate_ride',
                            'driver_save_vehicle', 'submit_driver_application', 'save_payment_method'] loop
    if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname = 'public' and p.proname = fn and p.prosrc like '%private.assert_not_blocked%') then
      f := f || jsonb_build_array('blocked_check_missing:' || fn);
    end if;
  end loop;
  foreach t in array array['public.profiles', 'public.riders', 'public.drivers', 'public.vehicles', 'public.driver_documents', 'public.driver_locations'] loop
    if not exists (select 1 from pg_trigger where tgrelid = t::regclass and tgname = 'aa_blocked_actor' and tgenabled = 'A') then
      f := f || jsonb_build_array('trigger_not_always:' || t || '.aa_blocked_actor');
    end if;
  end loop;
  -- Storage (migration 024): blocked accounts cannot upload, replace, delete or browse other users' files.
  if to_regclass('storage.objects') is not null then
    foreach r in array array['aura_blocked_no_upload', 'aura_blocked_no_update', 'aura_blocked_no_delete', 'aura_blocked_own_files_only'] loop
      if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = r and permissive = 'RESTRICTIVE') then
        f := f || jsonb_build_array('storage_policy_missing:' || r);
      end if;
    end loop;
  end if;
  -- The production binding cannot be widened by anything but a reviewed migration.
  if v_mode = 'beta' and ops_guard.prod_project_ref() is not null
     and ops_guard.prod_project_ref() = (select project_ref from ops_guard.environment) then
    f := f || jsonb_build_array('beta_marker_on_production_ref');
  end if;
  -- BETA data: nothing live may exist, and every account must be allowlisted or blocked.
  if v_mode = 'beta' then
    if exists (select 1 from public.payments where provider::text in ('moyasar', 'hyperpay')) then
      f := f || jsonb_build_array('beta_live_payments');
    end if;
    if exists (select 1 from public.payment_methods where provider::text in ('moyasar', 'hyperpay')) then
      f := f || jsonb_build_array('beta_live_payment_methods');
    end if;
    if exists (select 1 from public.payouts where provider <> 'mock') then
      f := f || jsonb_build_array('beta_live_payouts');
    end if;
    if exists (select 1 from public.wasl_sync_log where provider <> 'mock') then
      f := f || jsonb_build_array('beta_live_wasl');
    end if;
    if exists (select 1 from auth.users u
                where not ops_guard.signup_allowed(u.phone, u.email)
                  and not exists (select 1 from public.profiles p where p.id = u.id and p.is_blocked)) then
      f := f || jsonb_build_array('beta_unlisted_accounts');
    end if;
  end if;

  v_ok := jsonb_array_length(f) = 0;
  select ok, failures, failing_since into prev, prev_f, since from ops_guard.integrity_status;
  -- failing_since: when the current failure started (kept while it lasts, cleared on recovery).
  since := case when v_ok then null when prev is distinct from false then now() else coalesce(since, now()) end;
  insert into ops_guard.integrity_status (id, ok, failures, checked_at, failing_since) values (true, v_ok, f, now(), since)
  on conflict (id) do update set ok = excluded.ok, failures = excluded.failures, checked_at = excluded.checked_at,
                                 failing_since = excluded.failing_since;
  -- F5: one history row per change of state or of the set of failures, not one per minute.
  if prev is distinct from v_ok or (not v_ok and prev_f is distinct from f) then
    insert into ops_guard.integrity_events (ok, failures) values (v_ok, f);
  end if;
  if not v_ok then
    raise warning 'AURA_GUARD integrity failed: %', f;
  end if;
  return jsonb_build_object('ok', v_ok, 'failures', f, 'failing_since', since);
end;
$function$;

revoke all on all functions in schema ops_guard from public, anon, authenticated, service_role;
grant execute on function ops_guard.integrity_check() to service_role;
grant execute on function ops_guard.hook_before_user_created(jsonb), ops_guard.hook_custom_access_token(jsonb) to supabase_auth_admin;
