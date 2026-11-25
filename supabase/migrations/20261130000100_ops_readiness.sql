-- ============================================================================
-- AURA · 015 · Production readiness: one call that verifies the live database
-- ----------------------------------------------------------------------------
-- public.ops_readiness() → { ok, summary, checks[] }
--   severity "blocker": must pass before cutover (and stay passing)
--   severity "warning": needs attention / a decision, does not block
-- Areas: security, config, payments, wasl, pdpl, safety, operations.
-- Callable by the service role (preflight script, health function) or staff
-- with settings.view. Read-only.
-- ============================================================================

create or replace function private.ops_check(p_id text, p_area text, p_severity text, p_ok boolean, p_detail text)
returns jsonb
language sql immutable
set search_path = ''
as $$
  select jsonb_build_object('id', p_id, 'area', p_area, 'severity', p_severity, 'ok', coalesce(p_ok, false), 'detail', p_detail);
$$;

create or replace function public.ops_readiness()
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  c        jsonb := '[]'::jsonb;
  n        bigint;
  m        bigint;
  t        text;
  v_health jsonb;
  v_list   text;
begin
  if (select auth.uid()) is not null and not private.admin_can('settings.view') then
    raise exception 'AURA: permission settings.view required' using errcode = '42501';
  end if;

  -- ── Security ──────────────────────────────────────────────────────────────
  select count(*), string_agg(tablename, ', ') into n, v_list from pg_tables where schemaname = 'public' and not rowsecurity;
  c := c || private.ops_check('rls_enabled', 'security', 'blocker', n = 0,
         case when n = 0 then 'All public tables have row level security' else 'RLS disabled on: ' || v_list end);

  select count(*), string_agg(cl.relname, ', ') into n, v_list
    from pg_class cl join pg_namespace s on s.oid = cl.relnamespace
   where s.nspname = 'public' and cl.relkind in ('r', 'p', 'v', 'm')
     and has_table_privilege('anon', cl.oid, 'SELECT,INSERT,UPDATE,DELETE');
  c := c || private.ops_check('anon_no_tables', 'security', 'blocker', n = 0,
         case when n = 0 then 'Signed-out users have no table privileges' else 'anon can access: ' || v_list end);

  select count(*), string_agg(p.proname, ', ') into n, v_list
    from pg_proc p join pg_namespace s on s.oid = p.pronamespace
   where s.nspname in ('public', 'private') and p.prokind = 'f'
     and has_function_privilege('anon', p.oid, 'execute') and p.proname <> 'trip_share_view';
  c := c || private.ops_check('anon_functions', 'security', 'blocker', n = 0,
         case when n = 0 then 'Only trip_share_view is callable without signing in' else 'anon can execute: ' || v_list end);

  select count(*), string_agg(p.proname, ', ') into n, v_list
    from pg_proc p join pg_namespace s on s.oid = p.pronamespace
   where s.nspname in ('public', 'private') and p.prosecdef
     and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) cfg where cfg like 'search_path=%');
  c := c || private.ops_check('definer_search_path', 'security', 'blocker', n = 0,
         case when n = 0 then 'Every SECURITY DEFINER function pins search_path' else 'Missing search_path: ' || v_list end);

  select count(*) into n
    from pg_class cl join pg_namespace s on s.oid = cl.relnamespace
   where s.nspname = 'private' and cl.relkind in ('r', 'p')
     and (has_table_privilege('anon', cl.oid, 'SELECT,INSERT,UPDATE,DELETE')
       or has_table_privilege('authenticated', cl.oid, 'SELECT,INSERT,UPDATE,DELETE'));
  c := c || private.ops_check('private_schema_locked', 'security', 'blocker', n = 0,
         case when n = 0 then 'PIN hashes and payment tokens are not reachable by clients' else n || ' client grants on private tables' end);

  select count(*) into n from public.profiles where role = 'admin' and admin_role = 'super_admin' and not is_blocked;
  c := c || private.ops_check('super_admin', 'security', 'blocker', n between 1 and 5,
         n || ' active super admin(s) (expected 1–5)');

  if to_regclass('auth.mfa_factors') is not null then
    execute $q$select count(*) from public.profiles p where p.role = 'admin' and not p.is_blocked
                and not exists (select 1 from auth.mfa_factors f where f.user_id = p.id and f.status = 'verified')$q$ into n;
    c := c || private.ops_check('staff_mfa_enrolled', 'security', 'warning', n = 0,
           case when n = 0 then 'All active staff enrolled TOTP' else n || ' staff without TOTP yet (they must enroll at first sign-in)' end);
  end if;

  -- ── Configuration & reference data ───────────────────────────────────────
  c := c || private.ops_check('postgis', 'config', 'blocker', exists (select 1 from pg_extension where extname = 'postgis'), 'PostGIS extension');

  select count(*) into n from unnest(array['platform_commission', 'platform_vat', 'gateway_clearing', 'promo_expense',
                                           'payout_clearing', 'adjustments', 'wallet_holds', 'cash_deposits']::public.account_type[]) a
   where not exists (select 1 from public.wallet_accounts w where w.account_type = a and w.owner_id is null);
  c := c || private.ops_check('platform_accounts', 'config', 'blocker', n = 0,
         case when n = 0 then 'All 8 platform ledger accounts exist' else n || ' platform ledger account(s) missing' end);

  select count(*), string_agg(ci.code || '/' || vc, ', ') into n, v_list
    from public.cities ci cross join unnest(enum_range(null::public.vehicle_class)) vc
   where ci.status in ('live', 'pilot')
     and not exists (select 1 from public.tariffs tf where tf.city_id = ci.id and tf.vehicle_class = vc and tf.is_active);
  c := c || private.ops_check('tariffs', 'config', 'blocker', n = 0 and exists (select 1 from public.cities where status = 'live'),
         case when n = 0 then 'Every live/pilot city has an active tariff per class' else 'No active tariff: ' || v_list end);

  select count(*), string_agg(code, ', ') into n, v_list from public.cities where status = 'live' and service_area is null;
  c := c || private.ops_check('service_areas', 'config', 'warning', n = 0,
         case when n = 0 then 'Every live city has a service area polygon' else 'No service area (pickups accepted anywhere): ' || v_list end);

  if to_regclass('storage.buckets') is not null then
    execute $q$select count(*) from unnest(array['driver-documents', 'avatars']) b
                where not exists (select 1 from storage.buckets x where x.id = b and not x.public)$q$ into n;
    c := c || private.ops_check('storage_buckets', 'config', 'blocker', n = 0,
           case when n = 0 then 'Private buckets driver-documents and avatars exist' else n || ' bucket(s) missing or public' end);
  else
    c := c || private.ops_check('storage_buckets', 'config', 'warning', false, 'Storage schema not found (not a Supabase database?)');
  end if;

  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    select count(*) into n from unnest(array['rides', 'ride_events', 'driver_locations']) x
     where not exists (select 1 from pg_publication_tables p where p.pubname = 'supabase_realtime' and p.schemaname = 'public' and p.tablename = x);
    c := c || private.ops_check('realtime', 'config', 'blocker', n = 0,
           case when n = 0 then 'Realtime streams rides, ride_events and driver_locations' else n || ' table(s) missing from supabase_realtime' end);
  else
    c := c || private.ops_check('realtime', 'config', 'warning', false, 'supabase_realtime publication not found');
  end if;

  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    execute $q$select count(*), string_agg(j, ', ') from unnest(array['aura-dispatch-tick', 'aura-expire-documents',
                'aura-retention', 'aura-payout-batch', 'aura-purge-route-points']) j
                where not exists (select 1 from cron.job c where c.jobname = j and c.active)$q$ into n, v_list;
    c := c || private.ops_check('schedules', 'operations', 'blocker', n = 0,
           case when n = 0 then 'All database schedules are active' else 'Missing/inactive pg_cron jobs: ' || v_list end);
  else
    c := c || private.ops_check('schedules', 'operations', 'warning', false,
           'pg_cron not enabled: call dispatch-tick every 5 s and schedule expire_documents / apply_retention / create_payout_batch externally');
  end if;

  select count(*) into n from unnest(enum_range(null::public.consent_purpose)) p where private.consent_version(p) is null;
  c := c || private.ops_check('consent_versions', 'pdpl', 'blocker', n = 0,
         case when n = 0 then 'Every consent purpose has a current policy version' else n || ' purpose(s) without a version' end);

  -- ── Payments ──────────────────────────────────────────────────────────────
  v_health := public.ledger_health();
  c := c || private.ops_check('ledger_balanced', 'payments', 'blocker', (v_health ->> 'ok')::boolean,
         format('ledger sum %s, unbalanced tx %s, account mismatches %s', v_health ->> 'ledger_sum_halalas',
                v_health ->> 'unbalanced_transactions', v_health ->> 'account_balance_mismatches'));
  c := c || private.ops_check('amount_mismatch', 'payments', 'warning', (v_health ->> 'amount_mismatch_payments')::integer = 0,
         (v_health ->> 'amount_mismatch_payments') || ' payment(s) rejected for amount mismatch (review with the gateway)');

  select count(*) into n from public.payments where provider = 'mock' and created_at > now() - interval '7 days';
  c := c || private.ops_check('no_mock_payments', 'payments', 'warning', n = 0,
         case when n = 0 then 'No test-provider payments in the last 7 days' else n || ' mock payment(s) in the last 7 days (PAYMENT_PROVIDER=mock?)' end);

  select count(*) into n from public.payments
   where (status = 'initiated' and created_at < now() - interval '1 hour')
      or (status = 'authorized' and created_at < now() - interval '24 hours');
  c := c || private.ops_check('stuck_payments', 'payments', 'warning', n = 0,
         case when n = 0 then 'No stuck payments' else n || ' payment(s) stuck (is payments-worker scheduled?)' end);

  select count(*) into n from public.rides where status = 'completed' and settled_at is null and completed_at < now() - interval '2 hours';
  c := c || private.ops_check('unsettled_rides', 'payments', 'warning', n = 0,
         case when n = 0 then 'Every completed ride is settled' else n || ' completed ride(s) unsettled for over 2 h' end);

  select count(*) into n from public.payouts where status = 'processing' and updated_at < now() - interval '3 days';
  c := c || private.ops_check('stuck_payouts', 'payments', 'warning', n = 0,
         case when n = 0 then 'No payouts stuck in processing' else n || ' payout(s) processing for over 3 days' end);

  -- ── Wasl ──────────────────────────────────────────────────────────────────
  select count(*) into n from public.drivers d
   where d.is_online and (d.wasl_status <> 'eligible' or not private.driver_documents_valid(d.id)
     or not exists (select 1 from public.vehicles v where v.id = d.current_vehicle_id and v.wasl_status = 'eligible' and v.status = 'approved'));
  c := c || private.ops_check('online_captains_compliant', 'wasl', 'blocker', n = 0,
         case when n = 0 then 'Every online captain is Wasl-eligible with valid documents' else n || ' non-compliant captain(s) online' end);

  select count(*) into n from (
    select distinct on (entity_type, entity_id, operation) status, attempt
      from public.wasl_sync_log order by entity_type, entity_id, operation, created_at desc) l
   where l.status = 'failed' and l.attempt >= private.compliance_setting('wasl_max_attempts');
  c := c || private.ops_check('wasl_exhausted', 'wasl', 'warning', n = 0,
         case when n = 0 then 'No Wasl submissions out of retries' else n || ' Wasl submission(s) need manual follow-up' end);

  select count(*) into n from public.rides where status = 'completed' and wasl_reported_at is null and completed_at < now() - interval '24 hours';
  c := c || private.ops_check('wasl_trips_reported', 'wasl', 'warning', n = 0,
         case when n = 0 then 'All trips older than 24 h are reported to Wasl' else n || ' completed trip(s) not reported to Wasl after 24 h' end);

  select count(*) into n from public.wasl_sync_log where provider = 'mock' and created_at > now() - interval '7 days';
  c := c || private.ops_check('no_mock_wasl', 'wasl', 'warning', n = 0,
         case when n = 0 then 'No mock Wasl submissions in the last 7 days' else n || ' mock Wasl submission(s) in the last 7 days (WASL_MODE=mock?)' end);

  -- ── PDPL ──────────────────────────────────────────────────────────────────
  select count(*) into n from public.privacy_requests where status in ('pending', 'in_progress') and due_at < now();
  c := c || private.ops_check('privacy_requests_on_time', 'pdpl', 'blocker', n = 0,
         case when n = 0 then 'No data-subject request past its 30-day deadline' else n || ' privacy request(s) OVERDUE' end);

  select count(*) into n from public.privacy_requests
   where request_type = 'deletion' and status = 'completed' and cleanup_completed_at is null and completed_at < now() - interval '24 hours';
  c := c || private.ops_check('erasure_cleanup', 'pdpl', 'warning', n = 0,
         case when n = 0 then 'Every erasure finished Storage/login cleanup' else n || ' erasure(s) awaiting privacy-worker cleanup' end);

  select count(*) into n from public.ride_route_points where recorded_at < now() - interval '181 days';
  select count(*) into m from public.wasl_sync_log
   where (request_payload is not null or response_payload is not null)
     and created_at < now() - make_interval(days => private.compliance_setting('wasl_payload_retention_days') + 1);
  c := c || private.ops_check('retention', 'pdpl', 'warning', n = 0 and m = 0,
         case when n = 0 and m = 0 then 'Retention jobs are up to date' else n || ' old GPS points, ' || m || ' unredacted Wasl payloads (is apply_retention scheduled?)' end);

  -- ── Safety ────────────────────────────────────────────────────────────────
  select count(*) into n from public.tickets where category = 'safety' and status <> 'resolved' and assigned_to is null and created_at < now() - interval '15 minutes';
  c := c || private.ops_check('safety_tickets_triaged', 'safety', 'blocker', n = 0,
         case when n = 0 then 'Every safety report is assigned within 15 minutes' else n || ' safety report(s) unassigned for over 15 minutes' end);

  -- ── Result ────────────────────────────────────────────────────────────────
  return jsonb_build_object(
    'ok', not exists (select 1 from jsonb_array_elements(c) x where x ->> 'severity' = 'blocker' and not (x ->> 'ok')::boolean),
    'generated_at', now(),
    'summary', jsonb_build_object(
      'blockers_failed', (select count(*) from jsonb_array_elements(c) x where x ->> 'severity' = 'blocker' and not (x ->> 'ok')::boolean),
      'warnings', (select count(*) from jsonb_array_elements(c) x where x ->> 'severity' = 'warning' and not (x ->> 'ok')::boolean),
      'passed', (select count(*) from jsonb_array_elements(c) x where (x ->> 'ok')::boolean),
      'total', jsonb_array_length(c)),
    'checks', c);
end;
$$;

revoke execute on all functions in schema public from public, anon;
grant execute on function public.ops_readiness() to authenticated, service_role;
revoke execute on all functions in schema private from public, anon, authenticated;
grant  execute on all functions in schema private to service_role;
grant  execute on function
  private.is_admin(), private.admin_can(text), private.is_approved_driver(), private.current_actor(),
  private.is_ride_participant(uuid), private.owns_wallet_account(uuid), private.owns_ticket(uuid),
  private.is_my_active_driver(uuid), private.session_aal()
to authenticated;
-- trip_share_view stays the only anonymous function (asserted by ops_readiness).
grant execute on function public.trip_share_view(text) to anon;
