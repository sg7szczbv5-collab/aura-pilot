-- ============================================================================
-- AURA · 004 · Rides, ride events, trip state machine
-- Tables: 11 rides · 12 ride_events   (+ internal private.ride_verification)
-- The transition matrix is identical to TRANSITIONS in src/core/trip.ts and is
-- enforced by a trigger, so no code path (API, Edge Function, SQL) can skip it.
-- ============================================================================

-- 11 ─ rides ─────────────────────────────────────────────────────────────────
create table public.rides (
  id                       uuid primary key default gen_random_uuid(),
  ride_number              bigint generated always as identity unique,
  rider_id                 uuid not null references public.riders (id) on delete restrict,
  driver_id                uuid references public.drivers (id) on delete restrict,
  vehicle_id               uuid,
  city_id                  uuid not null references public.cities (id) on delete restrict,
  tariff_id                uuid not null references public.tariffs (id) on delete restrict,
  promo_id                 uuid references public.promos (id) on delete restrict,
  vehicle_class            public.vehicle_class not null,
  status                   public.ride_status not null default 'searching',

  pickup                   extensions.geography(Point, 4326) not null,
  pickup_address           text not null check (char_length(pickup_address) between 1 and 300),
  dropoff                  extensions.geography(Point, 4326) not null,
  dropoff_address          text not null check (char_length(dropoff_address) between 1 and 300),
  route_polyline           text,
  estimated_distance_m     integer not null check (estimated_distance_m >= 0),
  estimated_duration_s     integer not null check (estimated_duration_s >= 0),
  actual_distance_m        integer check (actual_distance_m >= 0),
  actual_duration_s        integer check (actual_duration_s >= 0),

  -- Upfront fare (halalas) — same breakdown as FareBreakdown in src/core/types.ts
  surge_multiplier         numeric(4, 2) not null default 1.00 check (surge_multiplier between 1.00 and 5.00),
  fare_base_halalas        integer not null check (fare_base_halalas >= 0),
  fare_distance_halalas    integer not null check (fare_distance_halalas >= 0),
  fare_time_halalas        integer not null check (fare_time_halalas >= 0),
  fare_surge_halalas       integer not null check (fare_surge_halalas >= 0),
  fare_min_topup_halalas   integer not null check (fare_min_topup_halalas >= 0),
  fare_subtotal_halalas    integer not null check (fare_subtotal_halalas >= 0),
  fare_discount_halalas    integer not null default 0 check (fare_discount_halalas >= 0),
  fare_vat_halalas         integer not null check (fare_vat_halalas >= 0),
  fare_total_halalas       integer not null check (fare_total_halalas >= 0),
  commission_halalas       integer not null check (commission_halalas >= 0),
  driver_net_halalas       integer not null check (driver_net_halalas >= 0),
  tip_halalas              integer not null default 0 check (tip_halalas >= 0),
  cancellation_fee_halalas integer not null default 0 check (cancellation_fee_halalas >= 0),
  commission_bps           integer not null check (commission_bps between 0 and 5000),
  vat_bps                  integer not null check (vat_bps between 0 and 10000),
  currency                 char(3) not null default 'SAR' check (currency = 'SAR'),

  payment_method           public.payment_method_type not null,
  payment_method_id        uuid, -- FK (payment_method_id, rider_id) added in 005

  offered_driver_id        uuid references public.drivers (id) on delete set null,
  offer_expires_at         timestamptz,

  requested_at             timestamptz not null default now(),
  assigned_at              timestamptz,
  arrived_at               timestamptz,
  started_at               timestamptz,
  completed_at             timestamptz,
  cancelled_at             timestamptz,
  cancelled_by             public.actor_kind,
  cancellation_reason      text check (char_length(cancellation_reason) <= 500),

  rating_by_rider          smallint check (rating_by_rider between 1 and 5),   -- rider → driver
  rating_by_driver         smallint check (rating_by_driver between 1 and 5),  -- driver → rider
  feedback_by_rider        text check (char_length(feedback_by_rider) <= 1000),

  settled_at               timestamptz,
  wasl_trip_reference      text,
  wasl_reported_at         timestamptz,

  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),

  constraint rides_vehicle_fk foreign key (vehicle_id, driver_id)
    references public.vehicles (id, driver_id) on delete restrict,
  -- Financial integrity
  constraint rides_fare_subtotal check (
    fare_subtotal_halalas = fare_base_halalas + fare_distance_halalas + fare_time_halalas
                          + fare_surge_halalas + fare_min_topup_halalas),
  constraint rides_fare_discount_cap check (fare_discount_halalas <= fare_subtotal_halalas),
  constraint rides_fare_total check (
    fare_total_halalas = fare_subtotal_halalas - fare_discount_halalas + fare_vat_halalas),
  constraint rides_commission_split check (commission_halalas + driver_net_halalas = fare_subtotal_halalas),
  constraint rides_promo_discount check (fare_discount_halalas = 0 or promo_id is not null),
  -- Lifecycle integrity
  constraint rides_offer_pair check ((offered_driver_id is null) = (offer_expires_at is null)),
  constraint rides_offer_only_searching check (status = 'searching' or offered_driver_id is null),
  constraint rides_driver_required check (
    status in ('searching', 'cancelled') or (driver_id is not null and vehicle_id is not null)),
  constraint rides_completed_ts check (status <> 'completed' or completed_at is not null),
  constraint rides_cancelled_ts check (status <> 'cancelled' or (cancelled_at is not null and cancelled_by is not null)),
  constraint rides_rating_only_completed check (
    (rating_by_rider is null and rating_by_driver is null) or status = 'completed'),
  constraint rides_settled_only_final check (settled_at is null or status in ('completed', 'cancelled')),
  constraint rides_saved_method_type check (
    payment_method_id is null or payment_method in ('mada', 'card', 'stc_pay'))
);

create index rides_rider_ix   on public.rides (rider_id, requested_at desc);
create index rides_driver_ix  on public.rides (driver_id, requested_at desc) where driver_id is not null;
create index rides_city_ix    on public.rides (city_id, requested_at desc);
create index rides_active_ix  on public.rides (status)
  where status in ('searching', 'driver_assigned', 'driver_arriving', 'driver_arrived', 'in_progress');
create index rides_offer_ix   on public.rides (offered_driver_id) where offered_driver_id is not null;
create index rides_pickup_gix on public.rides using gist (pickup) where status = 'searching';
create index rides_unsettled_ix on public.rides (completed_at) where status = 'completed' and settled_at is null;
-- One active ride per rider and per driver.
create unique index rides_one_active_per_rider_ix on public.rides (rider_id)
  where status in ('searching', 'driver_assigned', 'driver_arriving', 'driver_arrived', 'in_progress');
create unique index rides_one_active_per_driver_ix on public.rides (driver_id)
  where status in ('driver_assigned', 'driver_arriving', 'driver_arrived', 'in_progress');

-- 12 ─ ride_events (append-only lifecycle log) ─────────────────────────────────
create table public.ride_events (
  id          uuid primary key default gen_random_uuid(),
  ride_id     uuid not null references public.rides (id) on delete cascade,
  from_status public.ride_status,
  to_status   public.ride_status not null,
  actor       public.actor_kind not null,
  actor_id    uuid,
  note        text check (char_length(note) <= 500),
  created_at  timestamptz not null default now()
);
create index ride_events_ride_ix on public.ride_events (ride_id, created_at);

-- Internal: hashed 4-digit pickup code (never readable through the API).
create table private.ride_verification (
  ride_id    uuid primary key references public.rides (id) on delete cascade,
  code_hash  text not null,
  attempts   smallint not null default 0 check (attempts between 0 and 10),
  issued_at  timestamptz not null default now()
);
revoke all on private.ride_verification from public;

-- ── State machine (src/core/trip.ts, passenger → rider) ──────────────────────
create or replace function private.ride_transition_allowed(
  p_from public.ride_status, p_to public.ride_status, p_actor public.actor_kind)
returns boolean
language sql immutable
set search_path = ''
as $$
  select coalesce(case p_from
    when 'searching' then
         (p_to = 'driver_assigned' and p_actor in ('driver', 'system'))
      or (p_to = 'cancelled'       and p_actor in ('rider', 'admin', 'system'))
    when 'driver_assigned' then
         (p_to = 'driver_arriving' and p_actor in ('driver', 'system'))
      or (p_to = 'cancelled'       and p_actor in ('rider', 'driver', 'admin'))
    when 'driver_arriving' then
         (p_to = 'driver_arrived'  and p_actor in ('driver', 'system'))
      or (p_to = 'cancelled'       and p_actor in ('rider', 'driver', 'admin'))
    when 'driver_arrived' then
         (p_to = 'in_progress'     and p_actor in ('driver', 'system'))
      or (p_to = 'cancelled'       and p_actor in ('rider', 'driver', 'admin'))
    when 'in_progress' then
         (p_to = 'completed'       and p_actor in ('driver', 'system'))
      or (p_to = 'cancelled'       and p_actor in ('admin'))
    else false
  end, false);
$$;

-- Actor for the current statement: set by RPC functions via set_config('aura.actor', …);
-- direct service-role writes default to `system`.
create or replace function private.request_actor()
returns public.actor_kind
language sql stable
set search_path = ''
as $$
  select coalesce(nullif(current_setting('aura.actor', true), ''), 'system')::public.actor_kind;
$$;

create or replace function private.rides_before_insert()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.status := 'searching';
  new.driver_id := null;
  new.vehicle_id := null;
  new.requested_at := now();
  new.assigned_at := null; new.arrived_at := null; new.started_at := null;
  new.completed_at := null; new.cancelled_at := null; new.cancelled_by := null;
  new.rating_by_rider := null; new.rating_by_driver := null; new.settled_at := null;
  return new;
end;
$$;
create trigger rides_before_insert before insert on public.rides
  for each row execute function private.rides_before_insert();

create or replace function private.rides_before_update()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_actor public.actor_kind := private.request_actor();
begin
  -- Immutable after creation
  if new.rider_id <> old.rider_id or new.requested_at <> old.requested_at
     or new.city_id <> old.city_id or new.vehicle_class <> old.vehicle_class
     or new.ride_number <> old.ride_number then
    raise exception 'AURA: immutable ride fields cannot change' using errcode = '23514';
  end if;
  -- The upfront fare is locked once a driver accepted
  if old.status <> 'searching' and (
       new.fare_subtotal_halalas <> old.fare_subtotal_halalas or new.fare_total_halalas <> old.fare_total_halalas
    or new.commission_halalas <> old.commission_halalas or new.driver_net_halalas <> old.driver_net_halalas) then
    raise exception 'AURA: fare is locked after assignment' using errcode = '23514';
  end if;
  if old.driver_id is not null and new.driver_id is distinct from old.driver_id then
    raise exception 'AURA: assigned driver cannot change' using errcode = '23514';
  end if;

  if new.status is distinct from old.status then
    if not private.ride_transition_allowed(old.status, new.status, v_actor) then
      raise exception 'AURA: illegal ride transition % -> % by %', old.status, new.status, v_actor
        using errcode = '23514';
    end if;
    case new.status
      when 'driver_assigned' then new.assigned_at  := now();
      when 'driver_arrived'  then new.arrived_at   := now();
      when 'in_progress'     then new.started_at   := now();
      when 'completed'       then new.completed_at := now();
      when 'cancelled'       then new.cancelled_at := now(); new.cancelled_by := v_actor;
      else null;
    end case;
    if new.status <> 'searching' then
      new.offered_driver_id := null;
      new.offer_expires_at := null;
    end if;
  end if;
  new.updated_at := now();
  return new;
end;
$$;
create trigger rides_before_update before update on public.rides
  for each row execute function private.rides_before_update();

create or replace function private.rides_after_write()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.ride_events (ride_id, from_status, to_status, actor, actor_id)
    values (new.id, null, new.status, private.request_actor(), (select auth.uid()));
    if new.promo_id is not null then
      update public.promos set redemptions_count = redemptions_count + 1 where id = new.promo_id;
    end if;
    return new;
  end if;

  if new.status is distinct from old.status then
    insert into public.ride_events (ride_id, from_status, to_status, actor, actor_id, note)
    values (new.id, old.status, new.status, private.request_actor(), (select auth.uid()),
            case when new.status = 'cancelled' then new.cancellation_reason end);

    -- Driver availability follows the ride
    if new.driver_id is not null then
      update public.driver_locations dl
         set is_available = (new.status in ('completed', 'cancelled'))
                            and exists (select 1 from public.drivers d where d.id = dl.driver_id and d.is_online)
       where dl.driver_id = new.driver_id;
    end if;

    if new.status = 'completed' then
      update public.riders  set completed_rides = completed_rides + 1 where id = new.rider_id;
      update public.drivers set completed_rides = completed_rides + 1 where id = new.driver_id;
    elsif new.status = 'cancelled' and new.promo_id is not null then
      update public.promos set redemptions_count = greatest(redemptions_count - 1, 0) where id = new.promo_id;
    end if;
  end if;
  return new;
end;
$$;
create trigger rides_after_insert after insert on public.rides
  for each row execute function private.rides_after_write();
create trigger rides_after_update after update on public.rides
  for each row execute function private.rides_after_write();

-- ride_events are append-only
create or replace function private.forbid_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'AURA: % is append-only', tg_table_name using errcode = '42501';
end;
$$;
create trigger ride_events_append_only before update or delete on public.ride_events
  for each row execute function private.forbid_mutation();

-- driver_locations: derive class + availability on every ping
create or replace function private.driver_locations_before_write()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  select v.vehicle_class into new.vehicle_class
    from public.drivers d join public.vehicles v on v.id = d.current_vehicle_id
   where d.id = new.driver_id;
  new.is_available := exists (
      select 1 from public.drivers d
       where d.id = new.driver_id and d.status = 'approved' and d.is_online)
    and not exists (
      select 1 from public.rides r
       where r.driver_id = new.driver_id
         and r.status in ('driver_assigned', 'driver_arriving', 'driver_arrived', 'in_progress'));
  new.updated_at := now();
  return new;
end;
$$;
create trigger driver_locations_before_write before insert or update on public.driver_locations
  for each row execute function private.driver_locations_before_write();
