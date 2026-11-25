-- ============================================================================
-- AURA · 014 · Compliance: TGA/Wasl, captain onboarding rules, document expiry,
--             PDPL completeness, safety (SOS + live trip sharing), retention
-- ----------------------------------------------------------------------------
-- Table: 26 trip_shares
-- Wasl : work queue (driver/vehicle registration, daily eligibility re-check,
--        trip registration at start, trip update at completion) with retry
--        backoff; only Wasl-eligible captains with valid documents go online
--        or receive offers.
-- Rule values marked "placeholder" must be confirmed against TGA regulations.
-- ============================================================================

create or replace function private.compliance_setting(p_key text)
returns integer
language sql immutable
set search_path = ''
as $$
  select case p_key
    when 'vehicle_max_age_years'      then 10    -- placeholder: confirm current TGA rule per vehicle class
    when 'wasl_recheck_hours'         then 24    -- re-check eligibility of active captains daily
    when 'wasl_max_attempts'          then 8     -- then manual follow-up (visible in wasl_sync_log)
    when 'wasl_payload_retention_days' then 365
    when 'share_hours'                then 12    -- live trip link lifetime
    when 'share_after_end_minutes'    then 30    -- link stays readable briefly after the trip
    when 'shares_per_ride'            then 5
  end;
$$;

-- ── Validators (also in supabase/functions/_shared/validators.ts) ────────────
-- Saudi National ID (1…) / Iqama (2…): Luhn variant over 10 digits.
create or replace function private.valid_saudi_id(p text)
returns boolean
language plpgsql immutable
set search_path = ''
as $$
declare
  s integer := 0;
  d integer;
begin
  if p is null or p !~ '^[12][0-9]{9}$' then
    return false;
  end if;
  for i in 1..10 loop
    d := substr(p, i, 1)::integer;
    if i % 2 = 1 then
      d := d * 2;
      if d > 9 then d := d - 9; end if;
    end if;
    s := s + d;
  end loop;
  return s % 10 = 0;
end;
$$;

-- Saudi IBAN: SA + 2 check digits + 22 digits, ISO 13616 mod-97 (S=28, A=10).
create or replace function private.valid_saudi_iban(p text)
returns boolean
language sql immutable
set search_path = ''
as $$
  select coalesce(p ~ '^SA[0-9]{22}$' and mod((substr(p, 5) || '2810' || substr(p, 3, 2))::numeric, 97) = 1, false);
$$;

-- All required documents approved and not expired (captain + current vehicle).
create or replace function private.driver_documents_valid(p_driver_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select not exists (
      select 1 from unnest(array['national_id', 'driving_license', 'profile_photo']::public.document_type[]) t
       where not exists (select 1 from public.driver_documents x
                          where x.driver_id = p_driver_id and x.doc_type = t and x.status = 'approved'
                            and (x.expires_at is null or x.expires_at >= current_date)))
     and not exists (
      select 1 from unnest(array['vehicle_registration', 'vehicle_insurance']::public.document_type[]) t
       where not exists (select 1 from public.driver_documents x
                           join public.drivers d on d.id = x.driver_id
                          where x.driver_id = p_driver_id and x.vehicle_id = d.current_vehicle_id
                            and x.doc_type = t and x.status = 'approved'
                            and (x.expires_at is null or x.expires_at >= current_date)));
$$;

-- ── Captain application (replaces 008 version) ──────────────────────────────
create or replace function public.submit_driver_application()
returns public.drivers
language plpgsql security definer
set search_path = ''
as $$
declare
  d         public.drivers;
  ve        public.vehicles;
  v_missing text[];
begin
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
$$;

-- Going online also needs Wasl eligibility (captain + vehicle) and valid documents.
create or replace function private.drivers_before_update()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.is_online and not old.is_online then
    if not exists (
      select 1 from public.vehicles v
      where v.id = new.current_vehicle_id and v.driver_id = new.id and v.status = 'approved'
    ) then
      raise exception 'AURA: an approved current vehicle is required to go online' using errcode = '23514';
    end if;
    if new.wasl_status <> 'eligible' or not exists (
         select 1 from public.vehicles v where v.id = new.current_vehicle_id and v.wasl_status = 'eligible') then
      raise exception 'AURA: Wasl eligibility (captain and vehicle) is required to go online' using errcode = '23514';
    end if;
    if not private.driver_documents_valid(new.id) then
      raise exception 'AURA: documents are missing or expired' using errcode = '23514';
    end if;
  end if;
  if new.status <> 'approved' then
    new.is_online := false;
  end if;
  return new;
end;
$$;

-- Dispatch only to compliant captains (defence in depth: status can change while online).
create or replace function public.dispatch_candidates(
  p_ride_id uuid, p_radius_m integer default 5000, p_limit integer default 10)
returns table (driver_id uuid, distance_m double precision)
language sql stable security definer
set search_path = ''
as $$
  select dl.driver_id, extensions.st_distance(dl.location, r.pickup) as distance_m
  from public.rides r
  join public.driver_locations dl
    on dl.is_available
   and dl.driver_id <> r.rider_id
   and dl.updated_at > now() - interval '2 minutes'
   and private.class_serves(dl.vehicle_class, r.vehicle_class)
   and extensions.st_dwithin(dl.location, r.pickup, p_radius_m)
  join public.drivers d  on d.id = dl.driver_id and d.status = 'approved' and d.is_online and d.wasl_status = 'eligible'
  join public.vehicles ve on ve.id = d.current_vehicle_id and ve.status = 'approved' and ve.wasl_status = 'eligible'
  join public.profiles p on p.id = d.id and not p.is_blocked
  where r.id = p_ride_id and r.status = 'searching' and private.driver_documents_valid(d.id)
  order by distance_m
  limit p_limit;
$$;

-- Daily: expire documents and take affected captains offline.
create or replace function public.expire_documents()
returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  n integer;
begin
  perform set_config('aura.reason', 'document expired', true);
  update public.driver_documents set status = 'expired'
   where status = 'approved' and expires_at is not null and expires_at < current_date;
  get diagnostics n = row_count;
  update public.drivers set is_online = false
   where is_online and not private.driver_documents_valid(id);
  return n;
end;
$$;

-- ── Wasl work queue ─────────────────────────────────────────────────────────
-- Next attempt number for (entity, operation), or null while backing off / exhausted.
create or replace function private.wasl_due(p_entity public.wasl_entity, p_id uuid, p_op text)
returns integer
language sql stable
set search_path = ''
as $$
  select case
    when l.id is null then 1
    when l.status = 'success' then 1
    when l.attempt >= private.compliance_setting('wasl_max_attempts') then null
    when l.next_retry_at is not null and l.next_retry_at > now() then null
    when l.status = 'failed' and l.next_retry_at is null then null  -- business rejection (ineligible): no automatic retry
    else l.attempt + 1
  end
  from (select 1) one
  left join lateral (
    select w.id, w.status, w.attempt, w.next_retry_at from public.wasl_sync_log w
     where w.entity_type = p_entity and w.entity_id = p_id and w.operation = p_op
     order by w.created_at desc limit 1) l on true;
$$;

create or replace function public.wasl_work_queue(p_limit integer default 50)
returns table (entity_type public.wasl_entity, entity_id uuid, operation text, attempt integer, payload jsonb)
language sql stable security definer
set search_path = ''
as $$
  select q.* from (
    -- 1. Captain registration (submitted applications)
    select 'driver'::public.wasl_entity, d.id, 'driver_registration'::text,
           private.wasl_due('driver', d.id, 'driver_registration'),
           jsonb_build_object('national_id', d.national_id, 'date_of_birth', d.date_of_birth, 'full_name', p.full_name,
                              'mobile', p.phone, 'email', p.email, 'city', c.code)
      from public.drivers d join public.profiles p on p.id = d.id left join public.cities c on c.id = d.city_id
     where d.status in ('pending_review', 'approved') and d.wasl_status in ('pending', 'error')
    union all
    -- 2. Vehicle registration
    select 'vehicle', v.id, 'vehicle_registration', private.wasl_due('vehicle', v.id, 'vehicle_registration'),
           jsonb_build_object('sequence_number', v.sequence_number, 'plate_letters', v.plate_letters, 'plate_number', v.plate_number,
                              'make', v.make, 'model', v.model, 'year', v.year, 'color', v.color, 'vehicle_class', v.vehicle_class,
                              'driver_national_id', d.national_id)
      from public.vehicles v join public.drivers d on d.current_vehicle_id = v.id
     where v.wasl_status in ('pending', 'error') and d.status in ('pending_review', 'approved')
    union all
    -- 3. Daily eligibility re-check of active captains
    select 'driver', d.id, 'eligibility_check', private.wasl_due('driver', d.id, 'eligibility_check'),
           jsonb_build_object('national_id', d.national_id, 'vehicle_sequence_number', v.sequence_number)
      from public.drivers d left join public.vehicles v on v.id = d.current_vehicle_id
     where d.status = 'approved' and d.wasl_status = 'eligible'
       and (d.wasl_checked_at is null or d.wasl_checked_at < now() - make_interval(hours => private.compliance_setting('wasl_recheck_hours')))
    union all
    -- 4. Trip registration once the trip has started
    select 'ride', r.id, 'trip_registration', private.wasl_due('ride', r.id, 'trip_registration'),
           jsonb_build_object('ride_number', r.ride_number, 'driver_national_id', d.national_id, 'vehicle_sequence_number', v.sequence_number,
                              'vehicle_class', r.vehicle_class, 'started_at', r.started_at,
                              'pickup', jsonb_build_object('lat', extensions.st_y(r.pickup::extensions.geometry), 'lng', extensions.st_x(r.pickup::extensions.geometry)),
                              'estimated_distance_m', r.estimated_distance_m)
      from public.rides r join public.drivers d on d.id = r.driver_id join public.vehicles v on v.id = r.vehicle_id
     where r.status in ('in_progress', 'completed') and r.started_at is not null and r.wasl_trip_reference is null
    union all
    -- 5. Trip completion update
    select 'ride', r.id, 'trip_update', private.wasl_due('ride', r.id, 'trip_update'),
           jsonb_build_object('wasl_trip_reference', r.wasl_trip_reference, 'ride_number', r.ride_number, 'completed_at', r.completed_at,
                              'dropoff', jsonb_build_object('lat', extensions.st_y(r.dropoff::extensions.geometry), 'lng', extensions.st_x(r.dropoff::extensions.geometry)),
                              'distance_m', coalesce(r.actual_distance_m, r.estimated_distance_m),
                              'duration_s', coalesce(r.actual_duration_s, r.estimated_duration_s),
                              'fare_total_halalas', r.fare_total_halalas::text)
      from public.rides r
     where r.status = 'completed' and r.wasl_trip_reference is not null and r.wasl_reported_at is null
  ) q (entity_type, entity_id, operation, attempt, payload)
  where q.attempt is not null
  limit p_limit;
$$;

-- Wasl result (replaces 008): attempts, retry backoff for technical errors,
-- no downgrade of an eligible captain on a transient error, trip hooks.
create or replace function public.record_wasl_result(
  p_entity public.wasl_entity, p_entity_id uuid, p_operation text, p_provider text,
  p_success boolean, p_reference text default null,
  p_request jsonb default null, p_response jsonb default null, p_error text default null)
returns public.wasl_sync_log
language plpgsql security definer
set search_path = ''
as $$
declare
  v_log     public.wasl_sync_log;
  v_attempt integer;
  v_status  public.wasl_status := case when p_success then 'eligible' when p_error is not null then 'error' else 'ineligible' end;
begin
  select case when w.status = 'failed' then w.attempt + 1 else 1 end into v_attempt
    from public.wasl_sync_log w
   where w.entity_type = p_entity and w.entity_id = p_entity_id and w.operation = p_operation
   order by w.created_at desc limit 1;
  v_attempt := least(coalesce(v_attempt, 1), 20);

  insert into public.wasl_sync_log (entity_type, entity_id, operation, provider, status, attempt,
                                    request_payload, response_payload, error_message, next_retry_at, completed_at)
  values (p_entity, p_entity_id, p_operation, p_provider,
          case when p_success then 'success' else 'failed' end::public.sync_status, v_attempt,
          p_request, p_response, left(p_error, 1000),
          case when not p_success and p_error is not null
               then now() + make_interval(mins => least((2 ^ v_attempt)::integer, 1440)) end,
          now())
  returning * into v_log;

  if p_entity = 'driver' then
    perform set_config('aura.reason', 'Wasl ' || p_operation || ': ' || v_status, true);
    update public.drivers
       set wasl_status = case when v_status = 'error' and wasl_status = 'eligible' then wasl_status else v_status end,
           wasl_reference = coalesce(p_reference, wasl_reference),
           wasl_checked_at = case when v_status = 'error' then wasl_checked_at else now() end,
           status = case when v_status = 'ineligible' and status = 'approved' then 'suspended' else status end,
           status_reason = case when v_status = 'ineligible' and status = 'approved' then 'Wasl eligibility failed' else status_reason end
     where id = p_entity_id;
  elsif p_entity = 'vehicle' then
    update public.vehicles
       set wasl_status = case when v_status = 'error' and wasl_status = 'eligible' then wasl_status else v_status end,
           wasl_reference = coalesce(p_reference, wasl_reference),
           wasl_checked_at = case when v_status = 'error' then wasl_checked_at else now() end,
           status = case when v_status = 'ineligible' and status = 'approved' then 'inactive' else status end
     where id = p_entity_id;
    if v_status = 'ineligible' then
      update public.drivers set is_online = false where current_vehicle_id = p_entity_id and is_online;
    end if;
  elsif p_entity = 'ride' and p_success then
    if p_operation = 'trip_registration' then
      update public.rides set wasl_trip_reference = coalesce(p_reference, 'WASL-' || ride_number) where id = p_entity_id;
    elsif p_operation = 'trip_update' then
      update public.rides set wasl_reported_at = now() where id = p_entity_id;
    end if;
  end if;
  return v_log;
end;
$$;

create or replace function private.redact_wasl_payloads(p_days integer default null)
returns integer
language sql security definer
set search_path = ''
as $$
  with u as (
    update public.wasl_sync_log set request_payload = null, response_payload = null
     where (request_payload is not null or response_payload is not null)
       and created_at < now() - make_interval(days => coalesce(p_days, private.compliance_setting('wasl_payload_retention_days')))
    returning 1)
  select count(*)::integer from u;
$$;

-- ── 26 trip_shares (live trip link for family/friends) ──────────────────────
create table public.trip_shares (
  id             uuid primary key default gen_random_uuid(),
  ride_id        uuid not null references public.rides (id) on delete cascade,
  created_by     uuid not null references public.profiles (id) on delete cascade,
  token_hash     text not null unique,
  expires_at     timestamptz not null,
  revoked_at     timestamptz,
  view_count     integer not null default 0 check (view_count >= 0),
  last_viewed_at timestamptz,
  created_at     timestamptz not null default now(),
  constraint trip_shares_expiry check (expires_at > created_at)
);
create index trip_shares_ride_ix on public.trip_shares (ride_id);

create or replace function public.create_trip_share(p_ride_id uuid)
returns table (share_id uuid, token text, expires_at timestamptz)
language plpgsql security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid   uuid := (select auth.uid());
  r       public.rides;
  v_token text := encode(uuid_send(gen_random_uuid()) || uuid_send(gen_random_uuid()), 'hex'); -- 256-bit
  v_share public.trip_shares;
begin
  select * into r from public.rides where id = p_ride_id;
  if not found or v_uid is null or v_uid not in (r.rider_id, coalesce(r.driver_id, '00000000-0000-0000-0000-000000000000'::uuid)) then
    raise exception 'AURA: not your ride' using errcode = '42501';
  end if;
  if r.status not in ('searching', 'driver_assigned', 'driver_arriving', 'driver_arrived', 'in_progress') then
    raise exception 'AURA: only active trips can be shared' using errcode = '55000';
  end if;
  if (select count(*) from public.trip_shares s where s.ride_id = r.id and s.revoked_at is null and s.expires_at > now())
     >= private.compliance_setting('shares_per_ride') then
    raise exception 'AURA: too many active share links for this trip' using errcode = '54000';
  end if;
  insert into public.trip_shares (ride_id, created_by, token_hash, expires_at)
  values (r.id, v_uid, encode(sha256(convert_to(v_token, 'UTF8')), 'hex'),
          now() + make_interval(hours => private.compliance_setting('share_hours')))
  returning * into v_share;
  return query select v_share.id, v_token, v_share.expires_at;
end;
$$;

create or replace function public.revoke_trip_share(p_share_id uuid)
returns void
language sql security definer
set search_path = ''
as $$
  update public.trip_shares set revoked_at = now()
   where id = p_share_id and created_by = (select auth.uid()) and revoked_at is null;
$$;

-- Public (anon) view behind a share link: minimal data, only while relevant.
create or replace function public.trip_share_view(p_token text)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  s       public.trip_shares;
  r       public.rides;
  v_ended timestamptz;
  v_live  boolean;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then
    return null;
  end if;
  select * into s from public.trip_shares where token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
  if not found or s.revoked_at is not null or s.expires_at <= now() then
    return null;
  end if;
  select * into r from public.rides where id = s.ride_id;
  v_ended := coalesce(r.completed_at, r.cancelled_at);
  if v_ended is not null and v_ended < now() - make_interval(mins => private.compliance_setting('share_after_end_minutes')) then
    return null;
  end if;
  update public.trip_shares set view_count = view_count + 1, last_viewed_at = now() where id = s.id;
  v_live := r.status in ('driver_assigned', 'driver_arriving', 'driver_arrived', 'in_progress');
  return jsonb_build_object(
    'ride_number', r.ride_number,
    'status', r.status,
    'ended', v_ended is not null,
    'updated_at', r.updated_at,
    'pickup', jsonb_build_object('address', r.pickup_address, 'lat', extensions.st_y(r.pickup::extensions.geometry), 'lng', extensions.st_x(r.pickup::extensions.geometry)),
    'dropoff', jsonb_build_object('address', r.dropoff_address, 'lat', extensions.st_y(r.dropoff::extensions.geometry), 'lng', extensions.st_x(r.dropoff::extensions.geometry)),
    'captain', (select jsonb_build_object('first_name', split_part(coalesce(p.full_name, ''), ' ', 1), 'rating', d.rating)
                  from public.drivers d join public.profiles p on p.id = d.id where d.id = r.driver_id),
    'vehicle', (select jsonb_build_object('make', v.make, 'model', v.model, 'color', v.color, 'plate', v.plate_letters || ' ' || v.plate_number)
                  from public.vehicles v where v.id = r.vehicle_id),
    'location', case when v_live then (select jsonb_build_object('lat', dl.lat, 'lng', dl.lng, 'heading', dl.heading, 'at', dl.updated_at)
                                          from public.driver_locations dl where dl.driver_id = r.driver_id) end
  );
end;
$$;

-- ── Safety incidents (SOS and reports) → urgent support ticket ──────────────
create or replace function public.report_safety_incident(
  p_ride_id uuid, p_kind text, p_lat double precision default null, p_lng double precision default null, p_note text default null)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid    uuid := (select auth.uid());
  r        public.rides;
  v_ticket uuid;
begin
  if p_kind not in ('sos', 'unsafe_driving', 'harassment', 'accident', 'route_deviation', 'other') then
    raise exception 'AURA: unknown incident type' using errcode = '22023';
  end if;
  select * into r from public.rides where id = p_ride_id;
  if not found or v_uid is null or v_uid not in (r.rider_id, coalesce(r.driver_id, '00000000-0000-0000-0000-000000000000'::uuid)) then
    raise exception 'AURA: not your ride' using errcode = '42501';
  end if;
  insert into public.tickets (opened_by, ride_id, category, subject)
  values (v_uid, r.id, 'safety', left('Safety: ' || p_kind || ' · ride ' || r.ride_number, 200))
  returning id into v_ticket;
  insert into public.ticket_messages (ticket_id, author_id, body)
  values (v_ticket, v_uid, left(concat_ws(E'\n',
            'Incident: ' || p_kind,
            'Ride status: ' || r.status,
            case when p_lat is not null and p_lng is not null then 'Location: ' || round(p_lat::numeric, 6) || ', ' || round(p_lng::numeric, 6) end,
            nullif(trim(p_note), '')), 4000));
  insert into public.audit_log (actor_id, actor_kind, action, entity_type, entity_id, new_data, reason)
  values (v_uid, private.current_actor(), 'safety.incident', 'rides', r.id,
          jsonb_build_object('kind', p_kind, 'ticket_id', v_ticket, 'lat', p_lat, 'lng', p_lng), 'safety');
  return v_ticket;
end;
$$;

-- ── PDPL completeness ───────────────────────────────────────────────────────
alter table public.profiles add column processing_restricted boolean not null default false;
alter table public.privacy_requests add column cleanup_completed_at timestamptz;

-- Marketing only with consent and without a processing restriction.
create or replace function private.can_contact_for_marketing(p_user uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select private.has_consent(p_user, 'marketing_communications')
     and not coalesce((select p.processing_restricted from public.profiles p where p.id = p_user), true);
$$;

-- Requests now take effect (replaces 010): restriction, objection, deletion.
create or replace function public.admin_update_privacy_request(
  p_request_id uuid, p_status public.privacy_request_status, p_note text default null)
returns public.privacy_requests
language plpgsql security definer
set search_path = ''
as $$
declare
  v public.privacy_requests;
begin
  if not private.admin_can('privacy.manage') then
    raise exception 'AURA: permission privacy.manage required' using errcode = '42501';
  end if;
  select * into v from public.privacy_requests where id = p_request_id for update;
  if not found then
    raise exception 'AURA: request not found' using errcode = 'P0002';
  end if;
  if not ((v.status = 'pending' and p_status in ('in_progress', 'completed', 'rejected'))
       or (v.status = 'in_progress' and p_status in ('completed', 'rejected'))) then
    raise exception 'AURA: cannot move a % request to %', v.status, p_status using errcode = '23514';
  end if;
  if p_status = 'rejected' and nullif(trim(p_note), '') is null then
    raise exception 'AURA: a reason is required to reject a request' using errcode = '23502';
  end if;

  if p_status = 'completed' then
    perform set_config('aura.reason', 'PDPL ' || v.request_type || ' request #' || v.request_number, true);
    if v.request_type = 'deletion' then
      perform private.erase_user(v.user_id);
    elsif v.request_type = 'restriction' then
      update public.profiles set processing_restricted = true where id = v.user_id;
    elsif v.request_type = 'objection' then
      insert into public.user_consents (user_id, purpose, granted, policy_version, source, locale)
      select v.user_id, p, false, private.consent_version(p), 'admin_console', 'ar'
        from unnest(array['marketing_communications', 'analytics']::public.consent_purpose[]) p;
    end if;
  end if;

  update public.privacy_requests
     set status = p_status, resolution_note = coalesce(p_note, resolution_note),
         handled_by = (select auth.uid()),
         completed_at = case when p_status in ('completed', 'rejected') then now() end
   where id = p_request_id
  returning * into v;
  return v;
end;
$$;

-- Lift a restriction once the reason is resolved (privacy.manage).
create or replace function public.admin_lift_restriction(p_user_id uuid, p_reason text)
returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  if not private.admin_can('privacy.manage') then
    raise exception 'AURA: permission privacy.manage required' using errcode = '42501';
  end if;
  if nullif(trim(p_reason), '') is null then
    raise exception 'AURA: a reason is required' using errcode = '23502';
  end if;
  perform set_config('aura.reason', p_reason, true);
  update public.profiles set processing_restricted = false where id = p_user_id;
end;
$$;

-- After erasure: the privacy-worker deletes Storage files and bans the login.
create or replace function public.privacy_cleanup_queue(p_limit integer default 50)
returns table (request_id uuid, user_id uuid)
language sql stable security definer
set search_path = ''
as $$
  select q.id, q.user_id from public.privacy_requests q
   where q.request_type = 'deletion' and q.status = 'completed' and q.cleanup_completed_at is null
   order by q.completed_at limit p_limit;
$$;

create or replace function public.complete_privacy_cleanup(p_request_id uuid, p_files_removed integer, p_login_disabled boolean)
returns void
language sql security definer
set search_path = ''
as $$
  update public.privacy_requests
     set cleanup_completed_at = now(),
         resolution_note = left(concat_ws(' · ', resolution_note,
                                'Storage files removed: ' || p_files_removed,
                                case when p_login_disabled then 'login disabled' else 'login NOT disabled' end), 2000)
   where id = p_request_id and request_type = 'deletion' and status = 'completed';
$$;

-- Export (replaces 010): + breadcrumbs of own rides, Wasl status, share links.
create or replace function public.export_my_data()
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v     jsonb;
begin
  if v_uid is null then
    raise exception 'AURA: sign in first' using errcode = '42501';
  end if;
  if (select count(*) from public.privacy_requests
       where user_id = v_uid and request_type = 'access' and created_at > now() - interval '24 hours') >= 5 then
    raise exception 'AURA: export limit reached, try again tomorrow' using errcode = '54000';
  end if;

  select jsonb_build_object(
    'format', 'aura.personal-data.v2',
    'generated_at', now(),
    'profile', (select to_jsonb(p) from public.profiles p where p.id = v_uid),
    'rider', (select to_jsonb(r) from public.riders r where r.id = v_uid),
    'driver', (select to_jsonb(d) from public.drivers d where d.id = v_uid),
    'vehicles', coalesce((select jsonb_agg(to_jsonb(x)) from public.vehicles x where x.driver_id = v_uid), '[]'),
    'documents', coalesce((select jsonb_agg(to_jsonb(x) - 'reviewed_by') from public.driver_documents x
                           where x.driver_id = v_uid), '[]'),
    'rides_as_rider', coalesce((
      select jsonb_agg((to_jsonb(r) - 'pickup' - 'dropoff' - 'route_polyline' - 'rating_by_driver')
               || jsonb_build_object('pickup', extensions.st_asgeojson(r.pickup)::jsonb,
                                     'dropoff', extensions.st_asgeojson(r.dropoff)::jsonb,
                                     'route_points', coalesce((
                                        select jsonb_agg(jsonb_build_object('at', pt.recorded_at,
                                                 'lat', extensions.st_y(pt.location::extensions.geometry),
                                                 'lng', extensions.st_x(pt.location::extensions.geometry)) order by pt.recorded_at)
                                        from public.ride_route_points pt where pt.ride_id = r.id), '[]'::jsonb))
               order by r.requested_at)
      from public.rides r where r.rider_id = v_uid), '[]'),
    'rides_as_captain', coalesce((
      select jsonb_agg(jsonb_build_object(
               'ride_number', r.ride_number, 'status', r.status, 'requested_at', r.requested_at,
               'completed_at', r.completed_at, 'vehicle_class', r.vehicle_class,
               'driver_net_halalas', r.driver_net_halalas, 'tip_halalas', r.tip_halalas,
               'rating_by_driver', r.rating_by_driver) order by r.requested_at)
      from public.rides r where r.driver_id = v_uid), '[]'),
    'payment_methods', coalesce((select jsonb_agg(to_jsonb(x)) from public.payment_methods x where x.rider_id = v_uid), '[]'),
    'payments', coalesce((select jsonb_agg(to_jsonb(x) - 'metadata') from public.payments x where x.rider_id = v_uid), '[]'),
    'wallets', coalesce((select jsonb_agg(to_jsonb(a)) from public.wallet_accounts a where a.owner_id = v_uid), '[]'),
    'wallet_ledger', coalesce((select jsonb_agg(to_jsonb(l) - 'created_by' order by l.created_at)
                               from public.wallet_ledger l join public.wallet_accounts a on a.id = l.account_id
                               where a.owner_id = v_uid), '[]'),
    'payouts', coalesce((select jsonb_agg(to_jsonb(x) - 'approved_by') from public.payouts x where x.driver_id = v_uid), '[]'),
    'wasl', jsonb_build_object(
      'driver_status', (select d.wasl_status from public.drivers d where d.id = v_uid),
      'submissions', coalesce((select jsonb_agg(jsonb_build_object('entity', w.entity_type, 'operation', w.operation,
                                        'status', w.status, 'at', w.created_at) order by w.created_at)
                               from public.wasl_sync_log w
                               where (w.entity_type = 'driver' and w.entity_id = v_uid)
                                  or (w.entity_type = 'vehicle' and w.entity_id in (select id from public.vehicles where driver_id = v_uid))), '[]'::jsonb)),
    'trip_shares', coalesce((select jsonb_agg(to_jsonb(s) - 'token_hash' order by s.created_at)
                             from public.trip_shares s where s.created_by = v_uid), '[]'),
    'tickets', coalesce((select jsonb_agg(to_jsonb(t) - 'assigned_to' || jsonb_build_object('messages', coalesce((
                           select jsonb_agg(jsonb_build_object('from', m.author_kind, 'body', m.body, 'at', m.created_at)
                                            order by m.created_at)
                           from public.ticket_messages m where m.ticket_id = t.id and not m.is_internal), '[]')))
                         from public.tickets t where t.opened_by = v_uid), '[]'),
    'consents', coalesce((select jsonb_agg(to_jsonb(c) - 'user_id' order by c.created_at)
                          from public.user_consents c where c.user_id = v_uid), '[]'),
    'privacy_requests', coalesce((select jsonb_agg(to_jsonb(q) - 'handled_by' order by q.created_at)
                                  from public.privacy_requests q where q.user_id = v_uid), '[]')
  ) into v;

  insert into public.privacy_requests (user_id, request_type, status, details, completed_at)
  values (v_uid, 'access', 'completed', 'Self-service export', now());
  return v;
end;
$$;

-- Daily retention (data minimisation).
create or replace function private.apply_retention()
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_points integer;
  v_wasl   integer;
  v_shares integer;
  v_codes  integer;
begin
  v_points := private.purge_route_points(180);
  v_wasl := private.redact_wasl_payloads(null);
  delete from public.trip_shares where expires_at < now() - interval '30 days';
  get diagnostics v_shares = row_count;
  delete from private.ride_verification v using public.rides r
   where r.id = v.ride_id and r.status in ('completed', 'cancelled');
  get diagnostics v_codes = row_count;
  return jsonb_build_object('route_points', v_points, 'wasl_payloads', v_wasl, 'trip_shares', v_shares, 'pickup_codes', v_codes);
end;
$$;

-- ── RLS + privileges ────────────────────────────────────────────────────────
alter table public.trip_shares enable row level security;
revoke all on public.trip_shares from anon, authenticated;
grant select (id, ride_id, created_by, expires_at, revoked_at, view_count, last_viewed_at, created_at) on public.trip_shares to authenticated;
grant all on public.trip_shares to service_role;
create policy trip_shares_read on public.trip_shares for select to authenticated
  using (created_by = (select auth.uid()) or private.admin_can('trips.view'));

revoke execute on all functions in schema public from public, anon;
revoke execute on function
  public.wasl_work_queue(integer), public.expire_documents(),
  public.privacy_cleanup_queue(integer), public.complete_privacy_cleanup(uuid, integer, boolean),
  public.record_wasl_result(public.wasl_entity, uuid, text, text, boolean, text, jsonb, jsonb, text),
  public.dispatch_candidates(uuid, integer, integer)
from authenticated;
grant execute on all functions in schema public to service_role;
grant execute on function
  public.create_trip_share(uuid), public.revoke_trip_share(uuid),
  public.report_safety_incident(uuid, text, double precision, double precision, text),
  public.admin_lift_restriction(uuid, text),
  public.submit_driver_application(), public.export_my_data(),
  public.admin_update_privacy_request(uuid, public.privacy_request_status, text)
to authenticated;
-- The only function callable without signing in: the share-link view.
grant execute on function public.trip_share_view(text) to anon, authenticated;

revoke execute on all functions in schema private from public, anon, authenticated;
grant  execute on all functions in schema private to service_role;
grant  execute on function
  private.is_admin(), private.admin_can(text), private.is_approved_driver(), private.current_actor(),
  private.is_ride_participant(uuid), private.owns_wallet_account(uuid), private.owns_ticket(uuid),
  private.is_my_active_driver(uuid), private.session_aal()
to authenticated;

-- ── Schedules (pg_cron) ─────────────────────────────────────────────────────
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('aura-expire-documents', '15 0 * * *', 'select public.expire_documents()');
    perform cron.schedule('aura-retention', '45 3 * * *', 'select private.apply_retention()');
  end if;
end $$;
