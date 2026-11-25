-- ============================================================================
-- AURA · 011 · Trip lifecycle on the server: dispatch, live location, breadcrumbs
-- ----------------------------------------------------------------------------
--  * 24 ride_offers       : every offer made to a captain (accepted/declined/expired)
--  * 25 ride_route_points : GPS breadcrumbs while a trip is in progress (PostGIS)
--  * driver_locations gets plain lat/lng columns so Realtime payloads are usable
--  * dispatch_ride()        nearest eligible captain not yet offered (PostGIS KNN)
--  * decline_ride()         captain declines → next captain
--  * expire_ride_offers()   offer timeouts + "no captain" cancellation (pg_cron)
--  * update_driver_location() validated GPS ingestion (+ anti-teleport, breadcrumbs)
--  * actual distance/duration computed from breadcrumbs when a trip completes
--  * ride_view()            one JSON document per ride for the apps (mirror)
-- ============================================================================

create type public.offer_response as enum ('pending', 'accepted', 'declined', 'expired', 'cancelled');

-- Dispatch tuning in one place.
create or replace function private.dispatch_setting(p_key text)
returns integer
language sql immutable
set search_path = ''
as $$
  select case p_key
    when 'radius_m'       then 5000   -- search radius around pickup
    when 'offer_ttl_s'    then 20     -- seconds a captain has to accept
    when 'max_search_s'   then 300    -- give up after 5 minutes
    when 'max_speed_kmh'  then 250    -- faster jumps are treated as GPS glitches
    when 'point_min_m'    then 15     -- breadcrumb spacing
    when 'point_min_s'    then 15
    when 'max_accuracy_m' then 50     -- worse fixes are not recorded as breadcrumbs
  end;
$$;

-- 24 ─ ride_offers ──────────────────────────────────────────────────────────
create table public.ride_offers (
  id           uuid primary key default gen_random_uuid(),
  ride_id      uuid not null references public.rides (id) on delete cascade,
  driver_id    uuid not null references public.drivers (id) on delete cascade,
  distance_m   integer check (distance_m >= 0),
  response     public.offer_response not null default 'pending',
  offered_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  responded_at timestamptz,
  constraint ride_offers_once_per_driver unique (ride_id, driver_id),
  constraint ride_offers_expiry_after_offer check (expires_at > offered_at),
  constraint ride_offers_responded_ts check (response = 'pending' or responded_at is not null)
);
create index ride_offers_driver_ix  on public.ride_offers (driver_id, offered_at desc);
create index ride_offers_pending_ix on public.ride_offers (expires_at) where response = 'pending';

-- 25 ─ ride_route_points (breadcrumbs during in_progress only: data minimisation) ─
create table public.ride_route_points (
  id          uuid primary key default gen_random_uuid(),
  ride_id     uuid not null references public.rides (id) on delete cascade,
  driver_id   uuid not null references public.drivers (id) on delete cascade,
  location    extensions.geography(Point, 4326) not null,
  speed_kmh   numeric(5, 1) check (speed_kmh between 0 and 300),
  recorded_at timestamptz not null default clock_timestamp()
);
create index ride_route_points_ride_ix on public.ride_route_points (ride_id, recorded_at);

-- Plain coordinates for Realtime payloads (geography arrives as EWKB hex otherwise).
alter table public.driver_locations
  add column lat double precision generated always as (extensions.st_y(location::extensions.geometry)) stored,
  add column lng double precision generated always as (extensions.st_x(location::extensions.geometry)) stored;

-- ── Offer bookkeeping follows the ride ──────────────────────────────────────
create or replace function private.rides_sync_offers()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if old.status = 'searching' and new.status <> 'searching' then
    update public.ride_offers
       set response = case when driver_id = new.driver_id and new.status = 'driver_assigned' then 'accepted' else 'cancelled' end::public.offer_response,
           responded_at = now()
     where ride_id = new.id and response = 'pending';
    if new.status = 'driver_assigned' then
      perform private.refresh_acceptance_rate(new.driver_id);
    end if;
  end if;
  return new;
end;
$$;

create or replace function private.refresh_acceptance_rate(p_driver_id uuid)
returns void
language sql security definer
set search_path = ''
as $$
  update public.drivers d
     set acceptance_rate = s.rate
    from (
      select round(100.0 * count(*) filter (where response = 'accepted')
                   / nullif(count(*) filter (where response in ('accepted', 'declined', 'expired')), 0), 2) as rate
      from (select response from public.ride_offers
             where driver_id = p_driver_id and response <> 'pending'
             order by offered_at desc limit 100) last100
    ) s
   where d.id = p_driver_id and s.rate is not null;
$$;

create trigger rides_sync_offers after update on public.rides
  for each row when (old.status is distinct from new.status)
  execute function private.rides_sync_offers();

-- ── Dispatch ────────────────────────────────────────────────────────────────
-- Offer the ride to the nearest eligible captain who has not been offered it
-- yet and is not holding another live offer. Returns the captain or null.
create or replace function public.dispatch_ride(p_ride_id uuid)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v        public.rides;
  v_driver uuid;
  v_dist   double precision;
begin
  select * into v from public.rides where id = p_ride_id for update;
  if not found or v.status <> 'searching' then
    return null;
  end if;
  if v.offered_driver_id is not null and v.offer_expires_at > now() then
    return v.offered_driver_id; -- live offer still running
  end if;

  update public.ride_offers set response = 'expired', responded_at = now()
   where ride_id = p_ride_id and response = 'pending';
  if v.offered_driver_id is not null then
    perform private.refresh_acceptance_rate(v.offered_driver_id);
  end if;

  select c.driver_id, c.distance_m into v_driver, v_dist
    from public.dispatch_candidates(p_ride_id, private.dispatch_setting('radius_m'), 50) c
   where not exists (select 1 from public.ride_offers o where o.ride_id = p_ride_id and o.driver_id = c.driver_id)
     and not exists (select 1 from public.ride_offers o
                      where o.driver_id = c.driver_id and o.response = 'pending' and o.expires_at > now())
   order by c.distance_m
   limit 1;

  if v_driver is null then
    update public.rides set offered_driver_id = null, offer_expires_at = null
     where id = p_ride_id and offered_driver_id is not null;
    return null;
  end if;

  update public.rides
     set offered_driver_id = v_driver,
         offer_expires_at = now() + make_interval(secs => private.dispatch_setting('offer_ttl_s'))
   where id = p_ride_id;
  insert into public.ride_offers (ride_id, driver_id, distance_m, expires_at)
  values (p_ride_id, v_driver, round(v_dist),
          now() + make_interval(secs => private.dispatch_setting('offer_ttl_s')));
  return v_driver;
end;
$$;

create or replace function public.decline_ride(p_ride_id uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  update public.ride_offers set response = 'declined', responded_at = now()
   where ride_id = p_ride_id and driver_id = v_uid and response = 'pending';
  if not found then
    raise exception 'AURA: no pending offer for this ride' using errcode = '55000';
  end if;
  update public.rides set offered_driver_id = null, offer_expires_at = null
   where id = p_ride_id and offered_driver_id = v_uid and status = 'searching';
  perform private.refresh_acceptance_rate(v_uid);
  perform public.dispatch_ride(p_ride_id);
end;
$$;

-- Run every few seconds (pg_cron below, or the dispatch-tick Edge Function).
create or replace function public.expire_ride_offers(p_max_search_s integer default null)
returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  r     record;
  n     integer := 0;
  v_max integer := coalesce(p_max_search_s, private.dispatch_setting('max_search_s'));
begin
  -- Give up on rides nobody accepted in time.
  for r in
    select id from public.rides
     where status = 'searching' and requested_at < now() - make_interval(secs => v_max)
     for update skip locked
  loop
    perform set_config('aura.actor', 'system', true);
    update public.rides set status = 'cancelled', cancellation_reason = 'no_captain_available' where id = r.id;
    perform set_config('aura.actor', '', true);
    n := n + 1;
  end loop;

  -- Expired or missing offers → next captain.
  for r in
    select id from public.rides
     where status = 'searching' and (offer_expires_at is null or offer_expires_at <= now())
     for update skip locked
  loop
    perform public.dispatch_ride(r.id);
    n := n + 1;
  end loop;
  return n;
end;
$$;

-- ── Live location ───────────────────────────────────────────────────────────
-- Captain app calls this every few seconds while online. Returns false when the
-- fix was ignored (offline, implausible jump).
create or replace function public.update_driver_location(
  p_lat double precision, p_lng double precision,
  p_heading numeric default null, p_speed_kmh numeric default null, p_accuracy_m numeric default null)
returns boolean
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid   uuid := (select auth.uid());
  v_point extensions.geography;
  v_prev  public.driver_locations;
  v_secs  double precision;
  v_ride  uuid;
  v_last  public.ride_route_points;
begin
  if p_lat is null or p_lng is null or p_lat not between -90 and 90 or p_lng not between -180 and 180 then
    raise exception 'AURA: invalid coordinates' using errcode = '22023';
  end if;
  if not exists (select 1 from public.drivers d join public.profiles p on p.id = d.id
                  where d.id = v_uid and d.status = 'approved' and not p.is_blocked) then
    raise exception 'AURA: only approved captains can share location' using errcode = '42501';
  end if;
  if not exists (select 1 from public.drivers where id = v_uid and is_online) then
    return false; -- location is only collected while online (consent scope)
  end if;

  v_point := extensions.st_setsrid(extensions.st_makepoint(p_lng, p_lat), 4326)::extensions.geography;

  select * into v_prev from public.driver_locations where driver_id = v_uid;
  if found then
    v_secs := greatest(extract(epoch from (now() - v_prev.updated_at)), 0.5);
    if v_secs < 120 and extensions.st_distance(v_prev.location, v_point) / v_secs * 3.6
                        > private.dispatch_setting('max_speed_kmh') then
      return false; -- GPS glitch / spoofing
    end if;
  end if;

  insert into public.driver_locations (driver_id, location, heading, speed_kmh, accuracy_m)
  values (v_uid, v_point,
          case when p_heading is null then null else mod(mod(p_heading, 360) + 360, 360) end,
          least(greatest(p_speed_kmh, 0), 300), greatest(p_accuracy_m, 0))
  on conflict (driver_id) do update
    set location = excluded.location, heading = excluded.heading,
        speed_kmh = excluded.speed_kmh, accuracy_m = excluded.accuracy_m;

  -- Breadcrumbs only during the paid part of the trip.
  select id into v_ride from public.rides where driver_id = v_uid and status = 'in_progress';
  if v_ride is not null and coalesce(p_accuracy_m, 0) <= private.dispatch_setting('max_accuracy_m') then
    select * into v_last from public.ride_route_points where ride_id = v_ride order by recorded_at desc limit 1;
    if v_last.id is null
       or extensions.st_distance(v_last.location, v_point) >= private.dispatch_setting('point_min_m')
       or clock_timestamp() - v_last.recorded_at >= make_interval(secs => private.dispatch_setting('point_min_s')) then
      insert into public.ride_route_points (ride_id, driver_id, location, speed_kmh)
      values (v_ride, v_uid, v_point, least(greatest(p_speed_kmh, 0), 300));
    end if;
  end if;
  return true;
end;
$$;

-- Actual distance/duration from the breadcrumbs when a trip completes.
create or replace function private.rides_compute_actuals()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_len double precision;
begin
  if new.status = 'completed' and old.status is distinct from 'completed' then
    if new.actual_distance_m is null then
      select extensions.st_length(extensions.st_makeline(p.location::extensions.geometry order by p.recorded_at)::extensions.geography)
        into v_len
        from public.ride_route_points p where p.ride_id = new.id
      having count(*) >= 2;
      new.actual_distance_m := round(v_len);
    end if;
    if new.actual_duration_s is null and new.started_at is not null then
      new.actual_duration_s := greatest(round(extract(epoch from (coalesce(new.completed_at, now()) - new.started_at))), 0);
    end if;
  end if;
  return new;
end;
$$;
create trigger rides_compute_actuals before update on public.rides
  for each row execute function private.rides_compute_actuals();

-- Breadcrumb retention (PDPL minimisation). Scheduled below when pg_cron exists.
create or replace function private.purge_route_points(p_days integer default 180)
returns integer
language sql security definer
set search_path = ''
as $$
  with d as (delete from public.ride_route_points where recorded_at < now() - make_interval(days => p_days) returning 1)
  select count(*)::integer from d;
$$;

-- ── One JSON document per ride for the apps ─────────────────────────────────
create or replace function public.ride_view(p_ride_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_uid   uuid := (select auth.uid());
  r       public.rides;
  v_role  text;
  v_track boolean;
begin
  select * into r from public.rides where id = p_ride_id;
  if not found then
    return null;
  end if;
  v_role := case
    when v_uid = r.rider_id then 'rider'
    when v_uid = r.driver_id then 'driver'
    when v_uid = r.offered_driver_id and r.status = 'searching' then 'offered'
    when v_uid is null or private.admin_can('trips.view') then 'admin'
  end;
  if v_role is null then
    raise exception 'AURA: not a participant of this ride' using errcode = '42501';
  end if;
  v_track := r.status in ('driver_assigned', 'driver_arriving', 'driver_arrived', 'in_progress')
             or v_role in ('driver', 'admin');

  return jsonb_build_object(
    'id', r.id, 'ride_number', r.ride_number, 'viewer', v_role,
    'status', r.status, 'vehicle_class', r.vehicle_class,
    'city', (select c.code from public.cities c where c.id = r.city_id),
    'rider_id', r.rider_id, 'driver_id', r.driver_id,
    'offered_driver_id', case when v_role in ('offered', 'admin') then r.offered_driver_id end,
    'offer_expires_at', case when v_role in ('offered', 'admin') then r.offer_expires_at end,
    'pickup', jsonb_build_object('lat', extensions.st_y(r.pickup::extensions.geometry), 'lng', extensions.st_x(r.pickup::extensions.geometry), 'address', r.pickup_address),
    'dropoff', jsonb_build_object('lat', extensions.st_y(r.dropoff::extensions.geometry), 'lng', extensions.st_x(r.dropoff::extensions.geometry), 'address', r.dropoff_address),
    'route_polyline', r.route_polyline,
    'estimated_distance_m', r.estimated_distance_m, 'estimated_duration_s', r.estimated_duration_s,
    'actual_distance_m', r.actual_distance_m, 'actual_duration_s', r.actual_duration_s,
    'fare', jsonb_build_object(
      'base', r.fare_base_halalas, 'distance', r.fare_distance_halalas, 'time', r.fare_time_halalas,
      'surge', r.fare_surge_halalas, 'min_topup', r.fare_min_topup_halalas, 'subtotal', r.fare_subtotal_halalas,
      'discount', r.fare_discount_halalas, 'vat', r.fare_vat_halalas, 'total', r.fare_total_halalas,
      'commission', r.commission_halalas, 'driver_net', r.driver_net_halalas, 'tip', r.tip_halalas,
      'surge_multiplier', r.surge_multiplier, 'commission_bps', r.commission_bps, 'vat_bps', r.vat_bps,
      'promo_code', (select p.code from public.promos p where p.id = r.promo_id)),
    'payment_method', r.payment_method,
    'requested_at', r.requested_at, 'assigned_at', r.assigned_at, 'arrived_at', r.arrived_at,
    'started_at', r.started_at, 'completed_at', r.completed_at, 'cancelled_at', r.cancelled_at,
    'cancelled_by', r.cancelled_by, 'cancellation_reason', r.cancellation_reason,
    'rating_by_rider', case when v_role in ('rider', 'admin') then r.rating_by_rider end,
    'rating_by_driver', case when v_role in ('driver', 'admin') then r.rating_by_driver end,
    'updated_at', r.updated_at,
    'events', coalesce((select jsonb_agg(jsonb_build_object('status', e.to_status, 'actor', e.actor, 'at', e.created_at, 'note', e.note)
                                         order by e.created_at)
                        from public.ride_events e where e.ride_id = r.id), '[]'::jsonb),
    'driver', case when r.driver_id is null then null else (
      select jsonb_build_object(
        'id', d.id, 'name', p.full_name, 'rating', d.rating, 'ratings_count', d.ratings_count,
        'vehicle', (select jsonb_build_object('id', ve.id, 'class', ve.vehicle_class, 'make', ve.make, 'model', ve.model,
                                              'year', ve.year, 'color', ve.color, 'plate_letters', ve.plate_letters,
                                              'plate_number', ve.plate_number)
                    from public.vehicles ve where ve.id = r.vehicle_id),
        'location', case when v_track then (
          select jsonb_build_object('lat', dl.lat, 'lng', dl.lng, 'heading', dl.heading, 'at', dl.updated_at)
          from public.driver_locations dl where dl.driver_id = d.id) end)
      from public.drivers d join public.profiles p on p.id = d.id where d.id = r.driver_id) end,
    'rider', (select jsonb_build_object('id', x.id, 'first_name', split_part(coalesce(p.full_name, ''), ' ', 1), 'rating', x.rating)
              from public.riders x join public.profiles p on p.id = x.id where x.id = r.rider_id)
  );
end;
$$;

-- ── Upfront quote with the same surge rule as create_ride ───────────────────
create or replace function private.surge_at(p_city_id uuid, p_point extensions.geography)
returns numeric
language sql stable security definer
set search_path = ''
as $$
  select coalesce(max(z.surge_multiplier), 1.00)
  from public.zones z
  where z.city_id = p_city_id and z.kind = 'high_demand' and z.is_active
    and (z.starts_at is null or z.starts_at <= now()) and (z.ends_at is null or z.ends_at > now())
    and extensions.st_covers(z.area, p_point);
$$;

-- The price the rider will be charged if they confirm now (used by the request-ride
-- Edge Function in dry-run mode, with the server-computed route).
create or replace function public.quote_trip(
  p_city_code text, p_vehicle_class public.vehicle_class,
  p_pickup_lat double precision, p_pickup_lng double precision,
  p_distance_m integer, p_duration_s integer, p_promo_code text default null)
returns table (
  city_id uuid, tariff_id uuid, promo_id uuid, surge_multiplier numeric,
  fare_base_halalas integer, fare_distance_halalas integer, fare_time_halalas integer,
  fare_surge_halalas integer, fare_min_topup_halalas integer, fare_subtotal_halalas integer,
  fare_discount_halalas integer, fare_vat_halalas integer, fare_total_halalas integer,
  commission_halalas integer, driver_net_halalas integer, commission_bps integer, vat_bps integer)
language sql stable security definer
set search_path = ''
as $$
  select q.* from private.compute_quote(
    (select auth.uid()), p_city_code, p_vehicle_class, p_distance_m, p_duration_s,
    private.surge_at((select c.id from public.cities c where c.code = p_city_code),
                     extensions.st_setsrid(extensions.st_makepoint(p_pickup_lng, p_pickup_lat), 4326)::extensions.geography),
    p_promo_code) q;
$$;

-- ── RLS + privileges ────────────────────────────────────────────────────────
alter table public.ride_offers       enable row level security;
alter table public.ride_route_points enable row level security;
revoke all on public.ride_offers, public.ride_route_points from anon, authenticated;
grant select on public.ride_offers, public.ride_route_points to authenticated;
grant all on public.ride_offers, public.ride_route_points to service_role;

create policy ride_offers_read on public.ride_offers for select to authenticated
  using (driver_id = (select auth.uid()) or private.admin_can('trips.view'));
create policy ride_route_points_read on public.ride_route_points for select to authenticated
  using (private.is_ride_participant(ride_id) or private.admin_can('trips.view'));

revoke execute on all functions in schema public from public, anon;
revoke execute on function public.dispatch_ride(uuid), public.expire_ride_offers(integer) from authenticated;
grant  execute on function public.dispatch_ride(uuid), public.expire_ride_offers(integer) to service_role;
grant  execute on function
  public.decline_ride(uuid),
  public.update_driver_location(double precision, double precision, numeric, numeric, numeric),
  public.ride_view(uuid),
  public.quote_trip(text, public.vehicle_class, double precision, double precision, integer, integer, text)
to authenticated, service_role;

revoke execute on all functions in schema private from public, anon, authenticated;
grant  execute on all functions in schema private to service_role;
grant  execute on function
  private.is_admin(), private.admin_can(text), private.is_approved_driver(), private.current_actor(),
  private.is_ride_participant(uuid), private.owns_wallet_account(uuid), private.owns_ticket(uuid),
  private.is_my_active_driver(uuid), private.session_aal()
to authenticated;

-- ── Schedules (Supabase: enable the pg_cron extension first) ─────────────────
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('aura-dispatch-tick', '5 seconds', 'select public.expire_ride_offers()');
    perform cron.schedule('aura-purge-route-points', '30 3 * * *', 'select private.purge_route_points(180)');
  end if;
end $$;
