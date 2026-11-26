-- ═══════════════════════════════════════════════════════════════════════════
-- 023 · Blocked accounts are refused at the moment of the operation (review finding F2).
--
-- A blocked or revoked account may still hold a valid access token until it expires, so the
-- block is enforced where the work happens, never by token revocation alone:
--   1. private.assert_not_blocked() — one shared check (profiles.is_blocked) called first by
--      every user-callable RPC that moves money, changes a payment method, rates, or changes
--      account / vehicle data, and by save_payment_method for the rider it acts for.
--      Already blocked-aware before 023: create_ride, create_payment_intent, accept_ride,
--      transition_ride (dispatch side), update_driver_location, admin_can / every admin RPC.
--   2. aa_blocked_actor — a trigger on the tables users may write directly through RLS
--      (profiles, riders, drivers, vehicles, driver_documents, driver_locations): a blocked
--      actor (current_user authenticated, auth.uid() blocked) cannot insert, update or delete.
--      The trigger is SECURITY INVOKER so current_user is the caller's role. SECURITY DEFINER functions run as postgres and are unaffected, so service,
--      cron and admin paths keep working.
-- Deliberately still allowed for a blocked account (finishing a trip safely, legal rights):
--   start_ride / transition_ride / decline_ride / issue_ride_verification_code on a trip
--   already accepted, in-trip chat, create_trip_share / revoke_trip_share, report_safety_incident,
--   support tickets, privacy requests / export / consent withdrawal, and going OFFLINE
--   (drivers.is_online true → false). revoke_tester() now also takes the captain offline.
-- Migration 022 is unchanged; function bodies below are the latest definitions with only the
-- marked lines added.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function private.assert_not_blocked(p_user uuid default null)
returns void
language plpgsql stable security definer
set search_path = ''
as $$
declare
  u uuid := coalesce(p_user, (select auth.uid()));
begin
  if u is not null and exists (select 1 from public.profiles where id = u and is_blocked) then
    raise exception 'AURA: account is blocked' using errcode = '42501';
  end if;
end;
$$;
revoke all on function private.assert_not_blocked(uuid) from public, anon, authenticated, service_role;

-- Is the caller (auth.uid()) blocked? Reveals only the caller's own status.
create or replace function private.actor_is_blocked()
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select coalesce((select is_blocked from public.profiles where id = (select auth.uid())), false)
$$;
revoke all on function private.actor_is_blocked() from public, anon;
grant execute on function private.actor_is_blocked() to authenticated;

-- Direct (RLS) writes by a blocked actor. SECURITY INVOKER on purpose: current_user must be the
-- caller's role (authenticated / anon for API clients, the owner inside SECURITY DEFINER functions).
create or replace function private.blocked_actor_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- anon has no identity and no write grant on these tables; only signed-in API clients are checked.
  if current_user <> 'authenticated' or not private.actor_is_blocked() then
    return coalesce(new, old);
  end if;
  -- The one write a blocked captain may still make: going (or staying) offline, nothing else.
  if tg_table_name = 'drivers' and tg_op = 'UPDATE' then
    if (to_jsonb(new) ->> 'is_online')::boolean is false
       and (to_jsonb(new) - array['is_online', 'updated_at']) = (to_jsonb(old) - array['is_online', 'updated_at']) then
      return new;
    end if;
  end if;
  raise exception 'AURA: account is blocked' using errcode = '42501';
end;
$$;
revoke all on function private.blocked_actor_guard() from public, anon, authenticated, service_role;

do $$
declare
  t text;
begin
  foreach t in array array['profiles', 'riders', 'drivers', 'vehicles', 'driver_documents', 'driver_locations'] loop
    execute format('create trigger aa_blocked_actor before insert or update or delete on public.%I for each row execute function private.blocked_actor_guard()', t);
    execute format('alter table public.%I enable always trigger aa_blocked_actor', t);
  end loop;
end $$;

-- ── RPCs: the shared check first ────────────────────────────────────────────

-- add_wallet_tip: latest definition, unchanged apart from the F2 lines after "begin".
CREATE OR REPLACE FUNCTION public.add_wallet_tip(p_ride_id uuid, p_amount_halalas bigint)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  r  public.rides;
  tx uuid := gen_random_uuid();
begin
  -- F2 (migration 023): a blocked account cannot start this operation, whatever its JWT says.
  perform private.assert_not_blocked();
  r := private.assert_tip_allowed(p_ride_id, (select auth.uid()), p_amount_halalas);
  perform private.post_entry(tx, private.owner_account('rider_wallet', r.rider_id), 'tip', -p_amount_halalas, r.id, null, null, 'Tip');
  perform private.post_entry(tx, private.owner_account('driver_wallet', r.driver_id), 'tip', p_amount_halalas, r.id, null, null, 'Tip from rider');
  update public.rides set tip_halalas = p_amount_halalas where id = r.id;
  return p_amount_halalas::text;
end;
$function$;

-- request_payout: latest definition, unchanged apart from the F2 lines after "begin".
CREATE OR REPLACE FUNCTION public.request_payout(p_amount_halalas integer)
 RETURNS payouts
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  d         public.drivers;
  v_balance bigint;
  v         public.payouts;
begin
  -- F2 (migration 023): a blocked account cannot start this operation, whatever its JWT says.
  perform private.assert_not_blocked();
  -- P2 (migration 021): environment check before any write or external effect.
  perform ops_guard.assert_environment('request_payout');
  select * into d from public.drivers where id = (select auth.uid());
  if not found or d.status <> 'approved' then
    raise exception 'AURA: only approved captains can request payouts' using errcode = '42501';
  end if;
  if d.iban is null then
    raise exception 'AURA: add an IBAN first' using errcode = '23502';
  end if;
  if p_amount_halalas is null or p_amount_halalas <= 0 then
    raise exception 'AURA: amount must be positive' using errcode = '22023';
  end if;
  if exists (select 1 from public.payouts where driver_id = d.id and status in ('pending', 'approved', 'processing')) then
    raise exception 'AURA: a payout is already in progress' using errcode = '55000';
  end if;
  select balance_halalas into v_balance from public.wallet_accounts
   where account_type = 'driver_wallet' and owner_id = d.id for update;
  if coalesce(v_balance, 0) < p_amount_halalas then
    raise exception 'AURA: amount exceeds available balance' using errcode = '23514';
  end if;
  insert into public.payouts (driver_id, amount_halalas, iban, idempotency_key)
  values (d.id, p_amount_halalas, d.iban, 'payout_' || gen_random_uuid()::text)
  returning * into v;
  return v;
end;
$function$;

-- set_default_payment_method: latest definition, unchanged apart from the F2 lines after "begin".
CREATE OR REPLACE FUNCTION public.set_default_payment_method(p_payment_method_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid uuid := (select auth.uid());
begin
  -- F2 (migration 023): a blocked account cannot start this operation, whatever its JWT says.
  perform private.assert_not_blocked();
  -- P2 (migration 021): environment check before any write or external effect.
  perform ops_guard.assert_environment('set_default_payment_method');
  if not exists (select 1 from public.payment_methods
                  where id = p_payment_method_id and rider_id = v_uid and deleted_at is null) then
    raise exception 'AURA: payment method not found' using errcode = 'P0002';
  end if;
  update public.payment_methods set is_default = false where rider_id = v_uid and is_default;
  update public.payment_methods set is_default = true where id = p_payment_method_id;
  update public.riders set default_payment_method_id = p_payment_method_id where id = v_uid;
end;
$function$;

-- remove_payment_method: latest definition, unchanged apart from the F2 lines after "begin".
CREATE OR REPLACE FUNCTION public.remove_payment_method(p_payment_method_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid uuid := (select auth.uid());
begin
  -- F2 (migration 023): a blocked account cannot start this operation, whatever its JWT says.
  perform private.assert_not_blocked();
  -- P2 (migration 021): environment check before any write or external effect.
  perform ops_guard.assert_environment('remove_payment_method');
  update public.payment_methods set deleted_at = now(), is_default = false
   where id = p_payment_method_id and rider_id = v_uid and deleted_at is null;
  if not found then
    raise exception 'AURA: payment method not found' using errcode = 'P0002';
  end if;
  update public.riders set default_payment_method_id = null
   where id = v_uid and default_payment_method_id = p_payment_method_id;
  delete from private.payment_tokens where payment_method_id = p_payment_method_id;
end;
$function$;

-- rate_ride: latest definition, unchanged apart from the F2 lines after "begin".
CREATE OR REPLACE FUNCTION public.rate_ride(p_ride_id uuid, p_stars integer, p_feedback text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid uuid := (select auth.uid());
  v     public.rides;
begin
  -- F2 (migration 023): a blocked account cannot start this operation, whatever its JWT says.
  perform private.assert_not_blocked();
  if p_stars not between 1 and 5 then
    raise exception 'AURA: rating must be 1–5' using errcode = '22023';
  end if;
  select * into v from public.rides where id = p_ride_id for update;
  if not found or v.status <> 'completed' then
    raise exception 'AURA: only completed rides can be rated' using errcode = '55000';
  end if;
  if v.completed_at < now() - interval '7 days' then
    raise exception 'AURA: rating window has closed' using errcode = '55000';
  end if;

  if v_uid = v.rider_id then
    if v.rating_by_rider is not null then
      raise exception 'AURA: already rated' using errcode = '23505';
    end if;
    update public.rides set rating_by_rider = p_stars, feedback_by_rider = left(p_feedback, 1000) where id = p_ride_id;
    update public.drivers d
       set rating = s.avg_rating, ratings_count = s.n
      from (select round(avg(rating_by_rider)::numeric, 2) as avg_rating, count(*)::integer as n
              from public.rides where driver_id = v.driver_id and rating_by_rider is not null) s
     where d.id = v.driver_id;
  elsif v_uid = v.driver_id then
    if v.rating_by_driver is not null then
      raise exception 'AURA: already rated' using errcode = '23505';
    end if;
    update public.rides set rating_by_driver = p_stars where id = p_ride_id;
    update public.riders r
       set rating = s.avg_rating, ratings_count = s.n
      from (select round(avg(rating_by_driver)::numeric, 2) as avg_rating, count(*)::integer as n
              from public.rides where rider_id = v.rider_id and rating_by_driver is not null) s
     where r.id = v.rider_id;
  else
    raise exception 'AURA: not a participant of this ride' using errcode = '42501';
  end if;
end;
$function$;

-- driver_save_vehicle: latest definition, unchanged apart from the F2 lines after "begin".
CREATE OR REPLACE FUNCTION public.driver_save_vehicle(p_vehicle_id uuid, p_vehicle_class vehicle_class, p_make text, p_model text, p_year integer, p_color text, p_plate_letters text, p_plate_number text, p_sequence_number text, p_seats integer)
 RETURNS vehicles
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  d public.drivers;
  v public.vehicles;
begin
  -- F2 (migration 023): a blocked account cannot start this operation, whatever its JWT says.
  perform private.assert_not_blocked();
  select * into d from public.drivers where id = (select auth.uid()) for update;
  if not found then
    raise exception 'AURA: start a captain application first' using errcode = 'P0002';
  end if;
  if d.status not in ('incomplete', 'pending_review', 'rejected') then
    raise exception 'AURA: approved captains change their vehicle through support' using errcode = '55000';
  end if;
  perform set_config('aura.reason', 'captain resubmitted vehicle', true);

  begin
    if p_vehicle_id is not null then
      select * into v from public.vehicles where id = p_vehicle_id and driver_id = d.id for update;
      if not found then
        raise exception 'AURA: vehicle not found' using errcode = 'P0002';
      end if;
      if v.status not in ('rejected', 'pending_review') then
        raise exception 'AURA: this vehicle can no longer be edited' using errcode = '55000';
      end if;
      update public.vehicles
         set vehicle_class = p_vehicle_class, make = btrim(p_make), model = btrim(p_model), year = p_year,
             color = btrim(p_color), plate_letters = upper(p_plate_letters), plate_number = p_plate_number,
             sequence_number = p_sequence_number, seats = p_seats,
             status = 'pending_review', status_reason = null,
             wasl_status = 'not_submitted', wasl_reference = null, wasl_checked_at = null
       where id = v.id
      returning * into v;
    else
      insert into public.vehicles (driver_id, vehicle_class, make, model, year, color,
                                   plate_letters, plate_number, sequence_number, seats)
      values (d.id, p_vehicle_class, btrim(p_make), btrim(p_model), p_year, btrim(p_color),
              upper(p_plate_letters), p_plate_number, p_sequence_number, p_seats)
      returning * into v;
    end if;
  exception when unique_violation then
    raise exception 'AURA: plate or sequence number is already registered' using errcode = '23505';
  end;

  -- An application already under review: queue the (new) vehicle for the Wasl check too.
  if d.status = 'pending_review' then
    update public.vehicles set wasl_status = 'pending' where id = v.id returning * into v;
  end if;
  update public.drivers set current_vehicle_id = v.id where id = d.id;
  return v;
end;
$function$;

-- submit_driver_application: latest definition, unchanged apart from the F2 lines after "begin".
CREATE OR REPLACE FUNCTION public.submit_driver_application()
 RETURNS drivers
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  d         public.drivers;
  ve        public.vehicles;
  v_missing text[];
begin
  -- F2 (migration 023): a blocked account cannot start this operation, whatever its JWT says.
  perform private.assert_not_blocked();
  select * into d from public.drivers where id = (select auth.uid()) for update;
  if not found then
    raise exception 'AURA: start a captain application first' using errcode = 'P0002';
  end if;
  if d.status not in ('incomplete', 'rejected') then
    raise exception 'AURA: application already submitted (%)', d.status using errcode = '55000';
  end if;
  if d.national_id is null or d.date_of_birth is null or d.iban is null or d.city_id is null then
    raise exception 'AURA: national id, date of birth, IBAN and city are required' using errcode = '23502';
  end if;
  if not private.valid_saudi_id(d.national_id) then
    raise exception 'AURA: national ID / Iqama number is not valid' using errcode = '23514';
  end if;
  if not private.valid_saudi_iban(d.iban) then
    raise exception 'AURA: IBAN is not a valid Saudi IBAN' using errcode = '23514';
  end if;
  if d.date_of_birth > (current_date - interval '18 years') then
    raise exception 'AURA: captains must be at least 18' using errcode = '23514';
  end if;
  if cardinality(private.missing_consents_for(d.id, 'driver')) > 0 then
    raise exception 'AURA: accept the captain terms, privacy, location and regulatory notices first' using errcode = '42501';
  end if;
  select * into ve from public.vehicles where id = d.current_vehicle_id;
  if not found then
    raise exception 'AURA: add a vehicle and set it as current' using errcode = '23502';
  end if;
  if ve.year < extract(year from now())::integer - private.compliance_setting('vehicle_max_age_years') then
    raise exception 'AURA: vehicle is older than % years', private.compliance_setting('vehicle_max_age_years') using errcode = '23514';
  end if;

  select array_agg(t::text) into v_missing
    from unnest(array['national_id', 'driving_license', 'profile_photo']::public.document_type[]) t
   where not exists (select 1 from public.driver_documents x
                      where x.driver_id = d.id and x.doc_type = t and x.status in ('uploaded', 'approved'));
  select coalesce(v_missing, '{}') || coalesce(array_agg(t::text), '{}') into v_missing
    from unnest(array['vehicle_registration', 'vehicle_insurance']::public.document_type[]) t
   where not exists (select 1 from public.driver_documents x
                      where x.driver_id = d.id and x.vehicle_id = d.current_vehicle_id
                        and x.doc_type = t and x.status in ('uploaded', 'approved'));
  if cardinality(v_missing) > 0 then
    raise exception 'AURA: missing documents: %', array_to_string(v_missing, ', ') using errcode = '23502';
  end if;
  -- Expiry dates are required (Wasl/TGA) and must be in the future.
  select array_agg(x.doc_type::text) into v_missing
    from public.driver_documents x
   where x.driver_id = d.id and x.status in ('uploaded', 'approved')
     and x.doc_type in ('national_id', 'driving_license', 'vehicle_registration', 'vehicle_insurance')
     and (x.vehicle_id is null or x.vehicle_id = d.current_vehicle_id)
     and (x.expires_at is null or x.expires_at < current_date);
  if cardinality(v_missing) > 0 then
    raise exception 'AURA: missing or past expiry date: %', array_to_string(v_missing, ', ') using errcode = '23514';
  end if;

  update public.drivers
     set status = 'pending_review', submitted_at = now(), status_reason = null,
         wasl_status = case when wasl_status = 'eligible' then wasl_status else 'pending' end
   where id = d.id returning * into d;
  update public.vehicles set wasl_status = 'pending' where id = ve.id and wasl_status <> 'eligible';
  return d;
end;
$function$;

-- save_payment_method (service role, on behalf of p_rider_id): same check for the rider.
CREATE OR REPLACE FUNCTION public.save_payment_method(p_rider_id uuid, p_provider payment_provider, p_method_type payment_method_type, p_token text, p_brand text, p_last4 text, p_exp_month integer, p_exp_year integer, p_holder text DEFAULT NULL::text)
 RETURNS payment_methods
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v public.payment_methods;
  v_first boolean := not exists (select 1 from public.payment_methods where rider_id = p_rider_id and deleted_at is null);
begin
  -- F2 (migration 023): a blocked account cannot start this operation, whatever its JWT says.
  perform private.assert_not_blocked(p_rider_id);
  -- P2 (migration 021): environment check before any write or external effect.
  perform ops_guard.assert_environment('save_payment_method');
  if p_provider <> 'mock' then perform ops_guard.assert_live_allowed('payments.save_payment_method'); end if;
  insert into public.payment_methods (rider_id, provider, method_type, brand, last4, exp_month, exp_year, holder_name, is_default)
  values (p_rider_id, p_provider, p_method_type, left(p_brand, 20), p_last4, p_exp_month, p_exp_year, left(p_holder, 120), v_first)
  returning * into v;
  insert into private.payment_tokens (payment_method_id, provider_token) values (v.id, p_token);
  if v_first then
    update public.riders set default_payment_method_id = v.id where id = p_rider_id;
  end if;
  return v;
end;
$function$;

-- ── revoke_tester: also take a revoked captain offline ───────────────────────
CREATE OR REPLACE FUNCTION ops_guard.revoke_tester(p_identity text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  i         text := ops_guard.normalize_identity(case when p_identity like '%@%' then null else p_identity end,
                                                 case when p_identity like '%@%' then p_identity end);
  ids       uuid[];
  removed   boolean;
  blocked   integer := 0;
  sess      text := 'absent';
  tokens    text := 'absent';
  n         integer;
begin
  if i is null then
    raise exception 'AURA_GUARD: identity required' using errcode = '22023';
  end if;
  -- 1. Allowlist removal (always): sign-up and token issuance stop for this identity.
  perform set_config('ops_guard.allowlist_write', 'on', true);
  delete from ops_guard.allowlist where identity = i;
  removed := found;
  insert into ops_guard.allowlist_log (identity, action) values (i, 'revoke');
  perform set_config('ops_guard.allowlist_write', 'off', true);
  -- 2. Block (always): every sensitive RPC checks is_blocked, so it takes effect immediately.
  select array_agg(id) into ids from auth.users
   where ops_guard.normalize_identity(phone, null) = i or lower(email) = i;
  if ids is not null then
    update public.profiles set is_blocked = true, blocked_reason = coalesce(blocked_reason, 'beta_access_revoked')
     where id = any (ids) and not is_blocked;
    get diagnostics blocked = row_count;
    -- A revoked captain stops receiving offers at once (migration 023).
    update public.drivers set is_online = false where id = any (ids) and is_online;
    -- 3. Sessions and refresh tokens: best effort, each on its own (may lack privileges on Supabase).
    if to_regclass('auth.sessions') is not null then
      begin
        execute 'delete from auth.sessions where user_id = any ($1)' using ids;
        get diagnostics n = row_count;
        sess := 'deleted:' || n;
      exception when others then
        sess := 'failed:' || sqlstate;
      end;
    end if;
    if to_regclass('auth.refresh_tokens') is not null then
      begin
        execute 'delete from auth.refresh_tokens where user_id in (select unnest($1)::text)' using ids;
        get diagnostics n = row_count;
        tokens := 'deleted:' || n;
      exception when others then
        tokens := 'failed:' || sqlstate;
      end;
    end if;
  end if;
  insert into ops_guard.revocation_log (identity, users, allowlist_removed, blocked, sessions, refresh_tokens)
  values (i, coalesce(array_length(ids, 1), 0), removed, blocked, sess, tokens);
  return jsonb_build_object('identity', i, 'users', coalesce(array_length(ids, 1), 0), 'allowlist_removed', removed,
                            'blocked', blocked, 'sessions', sess, 'refresh_tokens', tokens,
                            'note', 'Access tokens already issued stay valid until they expire; ban the user with the Auth Admin API too.');
end;
$function$;

-- ── integrity_check: also verify the F2 controls ─────────────────────────────
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
