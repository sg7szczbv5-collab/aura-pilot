-- ============================================================================
-- AURA · 008 · RPC functions (the only write path for sensitive operations)
-- ----------------------------------------------------------------------------
--  authenticated : quote_fare, nearby_vehicle_markers, ride_counterpart,
--                  accept_ride, transition_ride, issue_ride_verification_code,
--                  start_ride, rate_ride, submit_driver_application,
--                  request_payout, set_default_payment_method, remove_payment_method,
--                  admin_* (each checks its own permission)
--  service_role  : create_ride, dispatch_candidates, offer_ride, settle_ride,
--                  complete_payout, record_wasl_result, private.grant_admin
-- All functions are SECURITY DEFINER with an empty search_path.
-- ============================================================================

-- ── Internal helpers ─────────────────────────────────────────────────────────
create or replace function private.hash_code(p_ride_id uuid, p_code text)
returns text
language sql immutable
set search_path = ''
as $$
  select encode(sha256(convert_to(p_ride_id::text || ':' || p_code, 'UTF8')), 'hex');
$$;

create or replace function private.platform_account(p_type public.account_type)
returns uuid
language sql stable
set search_path = ''
as $$
  select id from public.wallet_accounts where account_type = p_type and owner_id is null;
$$;

create or replace function private.owner_account(p_type public.account_type, p_owner uuid)
returns uuid
language sql stable
set search_path = ''
as $$
  select id from public.wallet_accounts where account_type = p_type and owner_id = p_owner;
$$;

create or replace function private.post_entry(
  p_tx uuid, p_account uuid, p_type public.ledger_entry_type, p_amount bigint,
  p_ride uuid default null, p_payment uuid default null, p_payout uuid default null, p_desc text default null)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if p_amount = 0 then return; end if;
  if p_account is null then
    raise exception 'AURA: ledger account missing for %', p_type using errcode = '23503';
  end if;
  insert into public.wallet_ledger (transaction_id, account_id, entry_type, amount_halalas, ride_id, payment_id, payout_id, description)
  values (p_tx, p_account, p_type, p_amount, p_ride, p_payment, p_payout, p_desc);
end;
$$;

create or replace function private.eligible_promo(
  p_rider_id uuid, p_code text, p_city_id uuid, p_class public.vehicle_class, p_subtotal integer)
returns public.promos
language plpgsql stable
set search_path = ''
as $$
declare
  p public.promos;
begin
  select * into p from public.promos x
   where x.code = upper(trim(p_code)) and x.is_active
     and x.starts_at <= now() and (x.ends_at is null or x.ends_at > now())
     and (x.city_id is null or x.city_id = p_city_id)
     and (x.vehicle_class is null or x.vehicle_class = p_class);
  if not found then
    raise exception 'AURA: promo code is not valid' using errcode = '22023';
  end if;
  if p.max_redemptions is not null and p.redemptions_count >= p.max_redemptions then
    raise exception 'AURA: promo code is fully redeemed' using errcode = '22023';
  end if;
  if p_subtotal < p.min_subtotal_halalas then
    raise exception 'AURA: fare is below the promo minimum' using errcode = '22023';
  end if;
  if p_rider_id is not null and (
       select count(*) from public.rides r
        where r.rider_id = p_rider_id and r.promo_id = p.id and r.status <> 'cancelled') >= p.per_rider_limit then
    raise exception 'AURA: promo code already used' using errcode = '22023';
  end if;
  return p;
end;
$$;

-- Fare engine — identical arithmetic to quoteFare() in src/core/pricing.ts.
create or replace function private.compute_quote(
  p_rider_id uuid, p_city_code text, p_vehicle_class public.vehicle_class,
  p_distance_m integer, p_duration_s integer,
  p_surge_multiplier numeric default 1.00, p_promo_code text default null)
returns table (
  city_id uuid, tariff_id uuid, promo_id uuid, surge_multiplier numeric,
  fare_base_halalas integer, fare_distance_halalas integer, fare_time_halalas integer,
  fare_surge_halalas integer, fare_min_topup_halalas integer, fare_subtotal_halalas integer,
  fare_discount_halalas integer, fare_vat_halalas integer, fare_total_halalas integer,
  commission_halalas integer, driver_net_halalas integer, commission_bps integer, vat_bps integer)
language plpgsql stable
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_city     uuid;
  t          public.tariffs;
  p          public.promos;
  v_distance integer;
  v_time     integer;
  v_surge    integer;
  v_raw      integer;
  v_subtotal integer;
  v_discount integer := 0;
  v_vat      integer;
  v_comm     integer;
begin
  if p_distance_m is null or p_distance_m < 0 or p_duration_s is null or p_duration_s < 0 then
    raise exception 'AURA: distance and duration must be non-negative' using errcode = '22023';
  end if;
  if p_surge_multiplier < 1 or p_surge_multiplier > 5 then
    raise exception 'AURA: surge multiplier out of range' using errcode = '22023';
  end if;
  select c.id into v_city from public.cities c where c.code = p_city_code and c.status in ('live', 'pilot');
  if v_city is null then
    raise exception 'AURA: city % is not in service', p_city_code using errcode = '22023';
  end if;
  select * into t from public.tariffs x
   where x.city_id = v_city and x.vehicle_class = p_vehicle_class and x.is_active;
  if not found then
    raise exception 'AURA: no active tariff for % / %', p_city_code, p_vehicle_class using errcode = '22023';
  end if;

  v_distance := round(p_distance_m / 1000.0 * t.per_km_halalas);
  v_time     := round(p_duration_s / 60.0 * t.per_min_halalas);
  v_surge    := round((v_distance + v_time) * (p_surge_multiplier - 1));
  v_raw      := t.base_fare_halalas + v_distance + v_time + v_surge;
  v_subtotal := ceil(greatest(v_raw, t.min_fare_halalas) / 100.0) * 100; -- whole riyals

  if nullif(trim(p_promo_code), '') is not null then
    p := private.eligible_promo(p_rider_id, p_promo_code, v_city, p_vehicle_class, v_subtotal);
    v_discount := case p.promo_type
                    when 'percent' then round(v_subtotal * p.percent_bps / 10000.0)
                    else p.amount_halalas end;
    if p.max_discount_halalas is not null then v_discount := least(v_discount, p.max_discount_halalas); end if;
    v_discount := least(v_discount, v_subtotal);
  end if;

  v_vat  := round((v_subtotal - v_discount) * t.vat_bps / 10000.0);
  v_comm := round(v_subtotal * t.commission_bps / 10000.0); -- discounts are platform-funded

  return query select
    v_city, t.id, p.id, p_surge_multiplier::numeric,
    t.base_fare_halalas, v_distance, v_time, v_surge,
    v_subtotal - (t.base_fare_halalas + v_distance + v_time + v_surge),
    v_subtotal, v_discount, v_vat, v_subtotal - v_discount + v_vat,
    v_comm, v_subtotal - v_comm, t.commission_bps, t.vat_bps;
end;
$$;

-- Keep driver availability in sync when a driver goes on/offline or changes status.
create or replace function private.drivers_after_update()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.is_online is distinct from old.is_online or new.status is distinct from old.status then
    update public.driver_locations dl
       set is_available = new.is_online and new.status = 'approved'
           and not exists (select 1 from public.rides r where r.driver_id = new.id
                            and r.status in ('driver_assigned', 'driver_arriving', 'driver_arrived', 'in_progress'))
     where dl.driver_id = new.id;
  end if;
  return new;
end;
$$;
create trigger drivers_after_update after update on public.drivers
  for each row execute function private.drivers_after_update();

-- ── Rider / map ──────────────────────────────────────────────────────────────
create or replace function public.quote_fare(
  p_city_code text, p_vehicle_class public.vehicle_class,
  p_distance_m integer, p_duration_s integer,
  p_surge_multiplier numeric default 1.00, p_promo_code text default null)
returns table (
  city_id uuid, tariff_id uuid, promo_id uuid, surge_multiplier numeric,
  fare_base_halalas integer, fare_distance_halalas integer, fare_time_halalas integer,
  fare_surge_halalas integer, fare_min_topup_halalas integer, fare_subtotal_halalas integer,
  fare_discount_halalas integer, fare_vat_halalas integer, fare_total_halalas integer,
  commission_halalas integer, driver_net_halalas integer, commission_bps integer, vat_bps integer)
language sql stable security definer
set search_path = ''
as $$
  select * from private.compute_quote((select auth.uid()), p_city_code, p_vehicle_class,
                                      p_distance_m, p_duration_s, p_surge_multiplier, p_promo_code);
$$;

-- Anonymised car markers for the rider map (no driver ids, ~200 m grid).
create or replace function public.nearby_vehicle_markers(
  p_lat double precision, p_lng double precision, p_radius_m integer default 3000)
returns table (lat double precision, lng double precision, heading integer, vehicle_class public.vehicle_class)
language sql stable security definer
set search_path = ''
as $$
  select extensions.st_y(s.g), extensions.st_x(s.g), (round(coalesce(s.heading, 0) / 15) * 15)::integer, s.vehicle_class
  from (
    select extensions.st_snaptogrid(dl.location::extensions.geometry, 0.002) as g, dl.heading, dl.vehicle_class
    from public.driver_locations dl
    where dl.is_available
      and dl.updated_at > now() - interval '2 minutes'
      and extensions.st_dwithin(
            dl.location,
            extensions.st_setsrid(extensions.st_makepoint(p_lng, p_lat), 4326)::extensions.geography,
            least(greatest(p_radius_m, 100), 10000))
    limit 30
  ) s;
$$;

-- Counterpart card for an active/finished ride (no phone numbers: masked calling comes later).
create or replace function public.ride_counterpart(p_ride_id uuid)
returns table (
  counterpart text, display_name text, avatar_path text, rating numeric,
  vehicle_class public.vehicle_class, vehicle_make text, vehicle_model text, vehicle_color text, plate text)
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v     public.rides;
begin
  select * into v from public.rides where id = p_ride_id;
  if not found then
    raise exception 'AURA: ride not found' using errcode = 'P0002';
  end if;
  if v_uid = v.rider_id and v.driver_id is not null then
    return query
      select 'driver'::text, p.full_name, p.avatar_path, d.rating,
             ve.vehicle_class, ve.make, ve.model, ve.color, ve.plate_letters || ' ' || ve.plate_number
      from public.drivers d
      join public.profiles p on p.id = d.id
      left join public.vehicles ve on ve.id = v.vehicle_id
      where d.id = v.driver_id;
  elsif v_uid = v.driver_id or (v_uid = v.offered_driver_id and v.status = 'searching') then
    return query
      select 'rider'::text, split_part(coalesce(p.full_name, ''), ' ', 1), p.avatar_path, r.rating,
             null::public.vehicle_class, null::text, null::text, null::text, null::text
      from public.riders r join public.profiles p on p.id = r.id
      where r.id = v.rider_id;
  elsif v_uid = v.rider_id then
    return; -- no driver yet
  else
    raise exception 'AURA: not a participant of this ride' using errcode = '42501';
  end if;
end;
$$;

-- ── Ride lifecycle ───────────────────────────────────────────────────────────
-- Called by the request-ride Edge Function (service_role) after it computed the
-- route with the maps provider. Fare, surge and promo are computed here.
create or replace function public.create_ride(
  p_rider_id uuid, p_city_code text, p_vehicle_class public.vehicle_class,
  p_pickup_lat double precision, p_pickup_lng double precision, p_pickup_address text,
  p_dropoff_lat double precision, p_dropoff_lng double precision, p_dropoff_address text,
  p_distance_m integer, p_duration_s integer,
  p_payment_method public.payment_method_type,
  p_payment_method_id uuid default null,
  p_promo_code text default null,
  p_route_polyline text default null)
returns public.rides
language plpgsql security definer
set search_path = ''
as $$
declare
  v_city    public.cities;
  v_pickup  extensions.geography;
  v_dropoff extensions.geography;
  v_surge   numeric := 1.00;
  q         record;
  v_balance bigint;
  v_ride    public.rides;
begin
  if exists (select 1 from public.profiles where id = p_rider_id and is_blocked) then
    raise exception 'AURA: account is blocked' using errcode = '42501';
  end if;
  select * into v_city from public.cities where code = p_city_code;
  if not found then
    raise exception 'AURA: unknown city %', p_city_code using errcode = '22023';
  end if;

  v_pickup  := extensions.st_setsrid(extensions.st_makepoint(p_pickup_lng, p_pickup_lat), 4326)::extensions.geography;
  v_dropoff := extensions.st_setsrid(extensions.st_makepoint(p_dropoff_lng, p_dropoff_lat), 4326)::extensions.geography;

  if v_city.service_area is not null and not extensions.st_covers(v_city.service_area, v_pickup) then
    raise exception 'AURA: pickup is outside the service area' using errcode = '22023';
  end if;
  if exists (
    select 1 from public.zones z
     where z.city_id = v_city.id and z.kind = 'restricted' and z.is_active
       and (z.starts_at is null or z.starts_at <= now()) and (z.ends_at is null or z.ends_at > now())
       and (extensions.st_covers(z.area, v_pickup) or extensions.st_covers(z.area, v_dropoff))) then
    raise exception 'AURA: pickup or drop-off is in a restricted zone' using errcode = '22023';
  end if;

  select coalesce(max(z.surge_multiplier), 1.00) into v_surge
    from public.zones z
   where z.city_id = v_city.id and z.kind = 'high_demand' and z.is_active
     and (z.starts_at is null or z.starts_at <= now()) and (z.ends_at is null or z.ends_at > now())
     and extensions.st_covers(z.area, v_pickup);

  select * into q from private.compute_quote(
    p_rider_id, p_city_code, p_vehicle_class, p_distance_m, p_duration_s, v_surge, p_promo_code);

  if p_payment_method = 'wallet' then
    select balance_halalas into v_balance from public.wallet_accounts
     where account_type = 'rider_wallet' and owner_id = p_rider_id;
    if coalesce(v_balance, 0) < q.fare_total_halalas then
      raise exception 'AURA: insufficient wallet balance' using errcode = '23514';
    end if;
  end if;

  perform set_config('aura.actor', 'rider', true);
  insert into public.rides (
    rider_id, city_id, tariff_id, promo_id, vehicle_class,
    pickup, pickup_address, dropoff, dropoff_address, route_polyline,
    estimated_distance_m, estimated_duration_s, surge_multiplier,
    fare_base_halalas, fare_distance_halalas, fare_time_halalas, fare_surge_halalas, fare_min_topup_halalas,
    fare_subtotal_halalas, fare_discount_halalas, fare_vat_halalas, fare_total_halalas,
    commission_halalas, driver_net_halalas, commission_bps, vat_bps,
    payment_method, payment_method_id)
  values (
    p_rider_id, q.city_id, q.tariff_id, q.promo_id, p_vehicle_class,
    v_pickup, p_pickup_address, v_dropoff, p_dropoff_address, p_route_polyline,
    p_distance_m, p_duration_s, q.surge_multiplier,
    q.fare_base_halalas, q.fare_distance_halalas, q.fare_time_halalas, q.fare_surge_halalas, q.fare_min_topup_halalas,
    q.fare_subtotal_halalas, q.fare_discount_halalas, q.fare_vat_halalas, q.fare_total_halalas,
    q.commission_halalas, q.driver_net_halalas, q.commission_bps, q.vat_bps,
    p_payment_method, p_payment_method_id)
  returning * into v_ride;
  perform set_config('aura.actor', '', true);
  return v_ride;
end;
$$;

-- Nearest available drivers that can serve the ride (PostGIS KNN by distance).
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
  join public.drivers d  on d.id = dl.driver_id and d.status = 'approved' and d.is_online
  join public.profiles p on p.id = d.id and not p.is_blocked
  where r.id = p_ride_id and r.status = 'searching'
  order by distance_m
  limit p_limit;
$$;

create or replace function public.offer_ride(p_ride_id uuid, p_driver_id uuid, p_ttl_seconds integer default 20)
returns public.rides
language plpgsql security definer
set search_path = ''
as $$
declare
  v public.rides;
begin
  if p_ttl_seconds not between 5 and 120 then
    raise exception 'AURA: offer TTL must be 5–120 s' using errcode = '22023';
  end if;
  if not exists (select 1 from public.dispatch_candidates(p_ride_id, 50000, 1000) c where c.driver_id = p_driver_id) then
    raise exception 'AURA: driver is not eligible for this ride' using errcode = '55000';
  end if;
  update public.rides
     set offered_driver_id = p_driver_id,
         offer_expires_at = now() + make_interval(secs => p_ttl_seconds)
   where id = p_ride_id and status = 'searching'
  returning * into v;
  if not found then
    raise exception 'AURA: ride is not searching' using errcode = '55000';
  end if;
  return v;
end;
$$;

create or replace function public.accept_ride(p_ride_id uuid)
returns public.rides
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid     uuid := (select auth.uid());
  v_vehicle public.vehicles;
  v         public.rides;
begin
  select ve.* into v_vehicle
    from public.drivers d
    join public.vehicles ve on ve.id = d.current_vehicle_id and ve.status = 'approved'
    join public.profiles p on p.id = d.id and not p.is_blocked
   where d.id = v_uid and d.status = 'approved' and d.is_online;
  if not found then
    raise exception 'AURA: driver must be approved, online and have an approved vehicle' using errcode = '42501';
  end if;

  select * into v from public.rides where id = p_ride_id for update;
  if not found or v.status <> 'searching' or v.offered_driver_id is distinct from v_uid
     or v.offer_expires_at <= now() then
    raise exception 'AURA: this offer is no longer available' using errcode = '55000';
  end if;
  if not private.class_serves(v_vehicle.vehicle_class, v.vehicle_class) then
    raise exception 'AURA: vehicle class cannot serve this ride' using errcode = '55000';
  end if;

  perform set_config('aura.actor', 'driver', true);
  update public.rides set status = 'driver_assigned', driver_id = v_uid, vehicle_id = v_vehicle.id
   where id = p_ride_id
  returning * into v;
  perform set_config('aura.actor', '', true);
  return v;
end;
$$;

-- Generic transition (arriving, arrived, completed, cancelled). The trigger
-- enforces the matrix; this function only resolves who the caller is.
create or replace function public.transition_ride(
  p_ride_id uuid, p_to public.ride_status, p_reason text default null,
  p_actual_distance_m integer default null, p_actual_duration_s integer default null)
returns public.rides
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid   uuid := (select auth.uid());
  v       public.rides;
  v_actor public.actor_kind;
begin
  if p_to in ('searching', 'driver_assigned', 'in_progress') then
    raise exception 'AURA: use accept_ride / start_ride for %', p_to using errcode = '22023';
  end if;
  select * into v from public.rides where id = p_ride_id for update;
  if not found then
    raise exception 'AURA: ride not found' using errcode = 'P0002';
  end if;

  if v_uid is null then
    v_actor := 'system';
  elsif v.driver_id = v_uid then
    v_actor := 'driver';
  elsif v.rider_id = v_uid then
    v_actor := 'rider';
  elsif p_to = 'cancelled' and private.admin_can('trips.cancel') then
    v_actor := 'admin';
  else
    raise exception 'AURA: not allowed to change this ride' using errcode = '42501';
  end if;

  perform set_config('aura.actor', v_actor::text, true);
  update public.rides
     set status = p_to,
         cancellation_reason = case when p_to = 'cancelled' then left(p_reason, 500) else cancellation_reason end,
         actual_distance_m = case when p_to = 'completed' then coalesce(p_actual_distance_m, actual_distance_m) else actual_distance_m end,
         actual_duration_s = case when p_to = 'completed' then coalesce(p_actual_duration_s, actual_duration_s) else actual_duration_s end
   where id = p_ride_id
  returning * into v;
  perform set_config('aura.actor', '', true);
  return v;
end;
$$;

-- Rider shows this 4-digit code to the driver. Re-issuing invalidates the old one.
create or replace function public.issue_ride_verification_code(p_ride_id uuid)
returns text
language plpgsql security definer
set search_path = ''
as $$
declare
  v      public.rides;
  b      bytea := uuid_send(gen_random_uuid());
  v_code text;
begin
  select * into v from public.rides where id = p_ride_id;
  if not found or v.rider_id is distinct from (select auth.uid()) then
    raise exception 'AURA: not your ride' using errcode = '42501';
  end if;
  if v.status not in ('driver_assigned', 'driver_arriving', 'driver_arrived') then
    raise exception 'AURA: code is only available while the driver is on the way' using errcode = '55000';
  end if;
  v_code := lpad(((get_byte(b, 0) * 65536 + get_byte(b, 1) * 256 + get_byte(b, 2)) % 10000)::text, 4, '0');
  insert into private.ride_verification (ride_id, code_hash, attempts, issued_at)
  values (p_ride_id, private.hash_code(p_ride_id, v_code), 0, now())
  on conflict (ride_id) do update set code_hash = excluded.code_hash, attempts = 0, issued_at = now();
  return v_code;
end;
$$;

-- Driver enters the rider's code. Returns true when the trip started, false on a
-- wrong code (the failed attempt is recorded; 5 failures lock the code).
create or replace function public.start_ride(p_ride_id uuid, p_code text)
returns boolean
language plpgsql security definer
set search_path = ''
as $$
declare
  v  public.rides;
  rv private.ride_verification;
begin
  select * into v from public.rides where id = p_ride_id for update;
  if not found or v.driver_id is distinct from (select auth.uid()) then
    raise exception 'AURA: not your ride' using errcode = '42501';
  end if;
  if v.status <> 'driver_arrived' then
    raise exception 'AURA: mark yourself as arrived first' using errcode = '55000';
  end if;
  select * into rv from private.ride_verification where ride_id = p_ride_id for update;
  if not found then
    raise exception 'AURA: the rider has not opened their code yet' using errcode = '55000';
  end if;
  if rv.attempts >= 5 then
    raise exception 'AURA: too many wrong codes; ask the rider to refresh the code' using errcode = '55000';
  end if;
  if rv.code_hash <> private.hash_code(p_ride_id, coalesce(p_code, '')) then
    update private.ride_verification set attempts = attempts + 1 where ride_id = p_ride_id;
    return false;
  end if;

  perform set_config('aura.actor', 'driver', true);
  update public.rides set status = 'in_progress' where id = p_ride_id;
  perform set_config('aura.actor', '', true);
  delete from private.ride_verification where ride_id = p_ride_id;
  return true;
end;
$$;

create or replace function public.rate_ride(p_ride_id uuid, p_stars integer, p_feedback text default null)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v     public.rides;
begin
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
$$;

-- ── Driver onboarding ────────────────────────────────────────────────────────
create or replace function public.submit_driver_application()
returns public.drivers
language plpgsql security definer
set search_path = ''
as $$
declare
  d         public.drivers;
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
  if d.date_of_birth > (current_date - interval '18 years') then
    raise exception 'AURA: captains must be at least 18' using errcode = '23514';
  end if;
  if d.current_vehicle_id is null then
    raise exception 'AURA: add a vehicle and set it as current' using errcode = '23502';
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

  update public.drivers set status = 'pending_review', submitted_at = now(), status_reason = null
   where id = d.id returning * into d;
  return d;
end;
$$;

-- ── Payment methods ──────────────────────────────────────────────────────────
create or replace function public.set_default_payment_method(p_payment_method_id uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if not exists (select 1 from public.payment_methods
                  where id = p_payment_method_id and rider_id = v_uid and deleted_at is null) then
    raise exception 'AURA: payment method not found' using errcode = 'P0002';
  end if;
  update public.payment_methods set is_default = false where rider_id = v_uid and is_default;
  update public.payment_methods set is_default = true where id = p_payment_method_id;
  update public.riders set default_payment_method_id = p_payment_method_id where id = v_uid;
end;
$$;

create or replace function public.remove_payment_method(p_payment_method_id uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  update public.payment_methods set deleted_at = now(), is_default = false
   where id = p_payment_method_id and rider_id = v_uid and deleted_at is null;
  if not found then
    raise exception 'AURA: payment method not found' using errcode = 'P0002';
  end if;
  update public.riders set default_payment_method_id = null
   where id = v_uid and default_payment_method_id = p_payment_method_id;
  delete from private.payment_tokens where payment_method_id = p_payment_method_id;
end;
$$;

-- ── Payouts ──────────────────────────────────────────────────────────────────
create or replace function public.request_payout(p_amount_halalas integer)
returns public.payouts
language plpgsql security definer
set search_path = ''
as $$
declare
  d         public.drivers;
  v_balance bigint;
  v         public.payouts;
begin
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
$$;

-- Payout provider callback (Edge Function, service_role).
create or replace function public.complete_payout(
  p_payout_id uuid, p_success boolean, p_provider_payout_id text default null, p_failure_reason text default null)
returns public.payouts
language plpgsql security definer
set search_path = ''
as $$
declare
  v  public.payouts;
  tx uuid := gen_random_uuid();
begin
  select * into v from public.payouts where id = p_payout_id for update;
  if not found or v.status <> 'processing' then
    raise exception 'AURA: payout is not processing' using errcode = '55000';
  end if;
  if p_success then
    perform private.post_entry(tx, private.owner_account('driver_wallet', v.driver_id), 'payout',
                               -v.amount_halalas, null, null, v.id, 'Payout to bank');
    perform private.post_entry(tx, private.platform_account('payout_clearing'), 'payout',
                               v.amount_halalas, null, null, v.id, 'Payout to bank');
    update public.payouts set status = 'paid', paid_at = now(),
           provider_payout_id = coalesce(p_provider_payout_id, provider_payout_id)
     where id = v.id returning * into v;
  else
    update public.payouts set status = 'failed', failure_reason = left(p_failure_reason, 500),
           provider_payout_id = coalesce(p_provider_payout_id, provider_payout_id)
     where id = v.id returning * into v;
  end if;
  return v;
end;
$$;

-- ── Settlement (double entry) ────────────────────────────────────────────────
-- card/mada/Apple Pay/STC Pay : gateway_clearing −total
-- wallet                      : rider_wallet     −total
-- cash                        : driver_wallet    −total (cash collected by the captain)
-- then: promo_expense −discount · driver_wallet +driver_net · commission +commission · VAT +vat
create or replace function public.settle_ride(p_ride_id uuid)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v      public.rides;
  v_pay  public.payments;
  tx     uuid := gen_random_uuid();
begin
  select * into v from public.rides where id = p_ride_id for update;
  if not found or v.status <> 'completed' then
    raise exception 'AURA: only completed rides can be settled' using errcode = '55000';
  end if;
  if v.settled_at is not null then
    raise exception 'AURA: ride already settled' using errcode = '23505';
  end if;

  if v.payment_method in ('mada', 'card', 'apple_pay', 'stc_pay') then
    select * into v_pay from public.payments
     where ride_id = v.id and kind = 'charge' and status = 'paid'
     order by paid_at desc limit 1;
    if not found then
      raise exception 'AURA: no paid charge for this ride' using errcode = '55000';
    end if;
    if v_pay.amount_halalas <> v.fare_total_halalas then
      raise exception 'AURA: charge % does not match fare %', v_pay.amount_halalas, v.fare_total_halalas
        using errcode = '23514';
    end if;
    perform private.post_entry(tx, private.platform_account('gateway_clearing'), 'ride_fare',
                               -v.fare_total_halalas, v.id, v_pay.id, null, 'Card payment');
  elsif v.payment_method = 'wallet' then
    perform private.post_entry(tx, private.owner_account('rider_wallet', v.rider_id), 'wallet_payment',
                               -v.fare_total_halalas, v.id, null, null, 'Wallet payment');
  else
    perform private.post_entry(tx, private.owner_account('driver_wallet', v.driver_id), 'cash_collected',
                               -v.fare_total_halalas, v.id, null, null, 'Cash collected by captain');
  end if;

  perform private.post_entry(tx, private.platform_account('promo_expense'), 'promo_discount',
                             -v.fare_discount_halalas, v.id, null, null, 'Promo funded by platform');
  perform private.post_entry(tx, private.owner_account('driver_wallet', v.driver_id), 'driver_earning',
                             v.driver_net_halalas, v.id, null, null, 'Ride earning');
  perform private.post_entry(tx, private.platform_account('platform_commission'), 'commission',
                             v.commission_halalas, v.id, null, null, 'Commission');
  perform private.post_entry(tx, private.platform_account('platform_vat'), 'vat',
                             v.fare_vat_halalas, v.id, null, null, 'VAT 15%');

  update public.rides set settled_at = now() where id = v.id;
  return tx;
end;
$$;

-- ── Wasl (called by the Wasl adapter Edge Function, mock or live) ──────────────
create or replace function public.record_wasl_result(
  p_entity public.wasl_entity, p_entity_id uuid, p_operation text, p_provider text,
  p_success boolean, p_reference text default null,
  p_request jsonb default null, p_response jsonb default null, p_error text default null)
returns public.wasl_sync_log
language plpgsql security definer
set search_path = ''
as $$
declare
  v_log    public.wasl_sync_log;
  v_status public.wasl_status := case
    when p_success then 'eligible'
    when p_error is not null then 'error'
    else 'ineligible' end;
begin
  insert into public.wasl_sync_log (entity_type, entity_id, operation, provider, status,
                                    request_payload, response_payload, error_message, completed_at)
  values (p_entity, p_entity_id, p_operation, p_provider,
          case when p_success then 'success' else 'failed' end::public.sync_status,
          p_request, p_response, p_error, now())
  returning * into v_log;

  if p_entity = 'driver' then
    perform set_config('aura.reason', 'Wasl ' || p_operation || ': ' || v_status, true);
    update public.drivers
       set wasl_status = v_status, wasl_reference = coalesce(p_reference, wasl_reference), wasl_checked_at = now(),
           -- An approved captain found ineligible is suspended immediately.
           status = case when v_status = 'ineligible' and status = 'approved' then 'suspended' else status end,
           status_reason = case when v_status = 'ineligible' and status = 'approved'
                                then 'Wasl eligibility failed' else status_reason end
     where id = p_entity_id;
  elsif p_entity = 'vehicle' then
    update public.vehicles
       set wasl_status = v_status, wasl_reference = coalesce(p_reference, wasl_reference), wasl_checked_at = now()
     where id = p_entity_id;
  elsif p_entity = 'ride' and p_success then
    update public.rides set wasl_trip_reference = coalesce(p_reference, wasl_trip_reference), wasl_reported_at = now()
     where id = p_entity_id;
  end if;
  return v_log;
end;
$$;

-- ── Admin actions (each checks its own permission; all audited) ──────────────
create or replace function public.admin_set_driver_status(
  p_driver_id uuid, p_status public.driver_status, p_reason text default null)
returns public.drivers
language plpgsql security definer
set search_path = ''
as $$
declare
  d         public.drivers;
  v_missing text[];
begin
  if p_status in ('approved', 'rejected', 'pending_review') and not private.admin_can('drivers.approve') then
    raise exception 'AURA: permission drivers.approve required' using errcode = '42501';
  elsif p_status = 'suspended' and not private.admin_can('drivers.suspend') then
    raise exception 'AURA: permission drivers.suspend required' using errcode = '42501';
  elsif p_status = 'incomplete' then
    raise exception 'AURA: cannot move a captain back to incomplete' using errcode = '22023';
  end if;
  if p_status in ('rejected', 'suspended') and nullif(trim(p_reason), '') is null then
    raise exception 'AURA: a reason is required' using errcode = '23502';
  end if;

  select * into d from public.drivers where id = p_driver_id for update;
  if not found then
    raise exception 'AURA: captain not found' using errcode = 'P0002';
  end if;

  if p_status = 'approved' then
    select array_agg(t::text) into v_missing
      from unnest(array['national_id', 'driving_license', 'profile_photo']::public.document_type[]) t
     where not exists (select 1 from public.driver_documents x
                        where x.driver_id = d.id and x.doc_type = t and x.status = 'approved'
                          and (x.expires_at is null or x.expires_at >= current_date));
    select coalesce(v_missing, '{}') || coalesce(array_agg(t::text), '{}') into v_missing
      from unnest(array['vehicle_registration', 'vehicle_insurance']::public.document_type[]) t
     where not exists (select 1 from public.driver_documents x
                        where x.driver_id = d.id and x.vehicle_id = d.current_vehicle_id
                          and x.doc_type = t and x.status = 'approved'
                          and (x.expires_at is null or x.expires_at >= current_date));
    if cardinality(v_missing) > 0 then
      raise exception 'AURA: documents not approved: %', array_to_string(v_missing, ', ') using errcode = '23514';
    end if;
    if not exists (select 1 from public.vehicles ve where ve.id = d.current_vehicle_id and ve.status = 'approved') then
      raise exception 'AURA: current vehicle is not approved' using errcode = '23514';
    end if;
    if d.wasl_status <> 'eligible' or not exists (
         select 1 from public.vehicles ve where ve.id = d.current_vehicle_id and ve.wasl_status = 'eligible') then
      raise exception 'AURA: captain and vehicle must be Wasl-eligible before approval' using errcode = '23514';
    end if;
  end if;

  perform set_config('aura.reason', coalesce(p_reason, ''), true);
  update public.drivers
     set status = p_status,
         status_reason = p_reason,
         approved_at = case when p_status = 'approved' then now() else approved_at end,
         approved_by = case when p_status = 'approved' then (select auth.uid()) else approved_by end
   where id = p_driver_id
  returning * into d;
  return d;
end;
$$;

create or replace function public.admin_review_document(
  p_document_id uuid, p_approve boolean, p_reason text default null)
returns public.driver_documents
language plpgsql security definer
set search_path = ''
as $$
declare
  v public.driver_documents;
begin
  if not private.admin_can('drivers.edit') then
    raise exception 'AURA: permission drivers.edit required' using errcode = '42501';
  end if;
  select * into v from public.driver_documents where id = p_document_id for update;
  if not found or v.status <> 'uploaded' then
    raise exception 'AURA: document is not awaiting review' using errcode = '55000';
  end if;
  if p_approve and v.expires_at is not null and v.expires_at < current_date then
    raise exception 'AURA: document has expired' using errcode = '23514';
  end if;
  perform set_config('aura.reason', coalesce(p_reason, ''), true);
  update public.driver_documents
     set status = case when p_approve then 'approved' else 'rejected' end::public.document_status,
         rejection_reason = case when p_approve then null else p_reason end,
         reviewed_by = (select auth.uid()), reviewed_at = now()
   where id = p_document_id
  returning * into v;
  return v;
end;
$$;

create or replace function public.admin_review_vehicle(
  p_vehicle_id uuid, p_approve boolean, p_reason text default null)
returns public.vehicles
language plpgsql security definer
set search_path = ''
as $$
declare
  v public.vehicles;
begin
  if not private.admin_can('vehicles.edit') then
    raise exception 'AURA: permission vehicles.edit required' using errcode = '42501';
  end if;
  select * into v from public.vehicles where id = p_vehicle_id for update;
  if not found or v.status <> 'pending_review' then
    raise exception 'AURA: vehicle is not awaiting review' using errcode = '55000';
  end if;
  if p_approve and exists (
       select 1 from unnest(array['vehicle_registration', 'vehicle_insurance']::public.document_type[]) t
        where not exists (select 1 from public.driver_documents x
                           where x.vehicle_id = v.id and x.doc_type = t and x.status = 'approved')) then
    raise exception 'AURA: vehicle documents must be approved first' using errcode = '23514';
  end if;
  if not p_approve and nullif(trim(p_reason), '') is null then
    raise exception 'AURA: a reason is required' using errcode = '23502';
  end if;
  perform set_config('aura.reason', coalesce(p_reason, ''), true);
  update public.vehicles
     set status = case when p_approve then 'approved' else 'rejected' end::public.vehicle_status,
         status_reason = p_reason
   where id = p_vehicle_id
  returning * into v;
  return v;
end;
$$;

create or replace function public.admin_set_profile_blocked(
  p_profile_id uuid, p_blocked boolean, p_reason text default null)
returns public.profiles
language plpgsql security definer
set search_path = ''
as $$
declare
  v public.profiles;
begin
  if not private.admin_can('customers.block') then
    raise exception 'AURA: permission customers.block required' using errcode = '42501';
  end if;
  select * into v from public.profiles where id = p_profile_id for update;
  if not found then
    raise exception 'AURA: profile not found' using errcode = 'P0002';
  end if;
  if v.role = 'admin' and not private.admin_can('roles.manage') then
    raise exception 'AURA: only a super admin can block staff' using errcode = '42501';
  end if;
  if p_blocked and nullif(trim(p_reason), '') is null then
    raise exception 'AURA: a reason is required' using errcode = '23502';
  end if;
  perform set_config('aura.reason', coalesce(p_reason, ''), true);
  update public.profiles set is_blocked = p_blocked, blocked_reason = case when p_blocked then p_reason end
   where id = p_profile_id returning * into v;
  if p_blocked then
    update public.drivers set is_online = false where id = p_profile_id and is_online;
  end if;
  return v;
end;
$$;

create or replace function public.admin_set_payout_status(
  p_payout_id uuid, p_status public.payout_status, p_reason text default null)
returns public.payouts
language plpgsql security definer
set search_path = ''
as $$
declare
  v public.payouts;
begin
  if not private.admin_can('finance.settle') then
    raise exception 'AURA: permission finance.settle required' using errcode = '42501';
  end if;
  if p_status not in ('approved', 'processing', 'cancelled') then
    raise exception 'AURA: admins may approve, send or cancel payouts only' using errcode = '22023';
  end if;
  perform set_config('aura.reason', coalesce(p_reason, ''), true);
  update public.payouts
     set status = p_status,
         approved_at = case when p_status = 'approved' then now() else approved_at end,
         approved_by = case when p_status = 'approved' then (select auth.uid()) else approved_by end,
         failure_reason = case when p_status = 'cancelled' then p_reason else failure_reason end
   where id = p_payout_id
  returning * into v;
  if not found then
    raise exception 'AURA: payout not found' using errcode = 'P0002';
  end if;
  return v;
end;
$$;

-- Promote an existing user to staff. Run from the SQL editor / service_role only.
create or replace function private.grant_admin(p_user_id uuid, p_role public.admin_role)
returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  perform set_config('aura.reason', 'grant_admin ' || p_role, true);
  update public.profiles set role = 'admin', admin_role = p_role where id = p_user_id;
  if not found then
    raise exception 'AURA: user % not found', p_user_id using errcode = 'P0002';
  end if;
end;
$$;

-- ── Execute privileges ───────────────────────────────────────────────────────
revoke execute on all functions in schema public from public, anon, authenticated;
grant  execute on all functions in schema public to service_role;
grant  execute on function
  public.quote_fare(text, public.vehicle_class, integer, integer, numeric, text),
  public.nearby_vehicle_markers(double precision, double precision, integer),
  public.ride_counterpart(uuid),
  public.accept_ride(uuid),
  public.transition_ride(uuid, public.ride_status, text, integer, integer),
  public.issue_ride_verification_code(uuid),
  public.start_ride(uuid, text),
  public.rate_ride(uuid, integer, text),
  public.submit_driver_application(),
  public.set_default_payment_method(uuid),
  public.remove_payment_method(uuid),
  public.request_payout(integer),
  public.admin_set_driver_status(uuid, public.driver_status, text),
  public.admin_review_document(uuid, boolean, text),
  public.admin_review_vehicle(uuid, boolean, text),
  public.admin_set_profile_blocked(uuid, boolean, text),
  public.admin_set_payout_status(uuid, public.payout_status, text)
to authenticated;

-- private.*: nothing callable by clients except the RLS helpers.
revoke execute on all functions in schema private from public, anon, authenticated;
grant  execute on all functions in schema private to service_role;
grant  execute on function
  private.is_admin(), private.admin_can(text), private.is_approved_driver(), private.current_actor(),
  private.is_ride_participant(uuid), private.owns_wallet_account(uuid), private.owns_ticket(uuid),
  private.is_my_active_driver(uuid)
to authenticated;
