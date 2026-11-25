-- ============================================================================
-- AURA · 003 · Identity: profiles, riders, drivers, vehicles, documents, live locations
-- Tables: 5 profiles · 6 riders · 7 drivers · 8 vehicles · 9 driver_documents · 10 driver_locations
-- ============================================================================

-- 5 ─ profiles (1:1 with auth.users) ──────────────────────────────────────────
create table public.profiles (
  id             uuid primary key references auth.users (id) on delete cascade,
  role           public.app_role not null default 'rider',
  admin_role     public.admin_role,
  full_name      text check (char_length(full_name) <= 120),
  phone          text unique check (phone ~ '^\+[1-9][0-9]{7,14}$'),
  email          text check (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  locale         text not null default 'ar' check (locale in ('ar', 'en')),
  avatar_path    text,
  is_blocked     boolean not null default false,
  blocked_reason text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint profiles_admin_role_matches check ((role = 'admin') = (admin_role is not null))
);
create index profiles_role_ix on public.profiles (role);
create trigger profiles_touch before update on public.profiles
  for each row execute function private.touch_updated_at();

-- 6 ─ riders ─────────────────────────────────────────────────────────────────
create table public.riders (
  id                        uuid primary key references public.profiles (id) on delete cascade,
  rating                    numeric(3, 2) check (rating between 1 and 5),
  ratings_count             integer not null default 0 check (ratings_count >= 0),
  completed_rides           integer not null default 0 check (completed_rides >= 0),
  default_payment_method_id uuid, -- FK added in 005 (payment_methods)
  emergency_contact_name    text check (char_length(emergency_contact_name) <= 120),
  emergency_contact_phone   text check (emergency_contact_phone ~ '^\+[1-9][0-9]{7,14}$'),
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);
create trigger riders_touch before update on public.riders
  for each row execute function private.touch_updated_at();

-- 7 ─ drivers (captains) ─────────────────────────────────────────────────────
create table public.drivers (
  id                 uuid primary key references public.profiles (id) on delete cascade,
  status             public.driver_status not null default 'incomplete',
  city_id            uuid references public.cities (id) on delete restrict,
  national_id        text unique check (national_id ~ '^[12][0-9]{9}$'), -- NID (1…) or Iqama (2…)
  date_of_birth      date check (date_of_birth > date '1940-01-01'),
  iban               text check (iban ~ '^SA[0-9]{22}$'),
  bank_name          text check (char_length(bank_name) <= 80),
  rating             numeric(3, 2) check (rating between 1 and 5),
  ratings_count      integer not null default 0 check (ratings_count >= 0),
  completed_rides    integer not null default 0 check (completed_rides >= 0),
  acceptance_rate    numeric(5, 2) check (acceptance_rate between 0 and 100),
  is_online          boolean not null default false,
  current_vehicle_id uuid, -- composite FK below (must be the driver's own vehicle)
  wasl_status        public.wasl_status not null default 'not_submitted',
  wasl_reference     text,
  wasl_checked_at    timestamptz,
  submitted_at       timestamptz,
  approved_at        timestamptz,
  approved_by        uuid references public.profiles (id) on delete set null,
  status_reason      text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint drivers_online_requires_approval check (not is_online or status = 'approved'),
  constraint drivers_approved_has_timestamp   check (status <> 'approved' or approved_at is not null)
);
create index drivers_status_ix on public.drivers (status);
create index drivers_online_ix on public.drivers (city_id) where is_online;
create trigger drivers_touch before update on public.drivers
  for each row execute function private.touch_updated_at();

-- 8 ─ vehicles ───────────────────────────────────────────────────────────────
create table public.vehicles (
  id              uuid primary key default gen_random_uuid(),
  driver_id       uuid not null references public.drivers (id) on delete cascade,
  vehicle_class   public.vehicle_class not null,
  make            text not null check (char_length(make) between 1 and 40),
  model           text not null check (char_length(model) between 1 and 40),
  year            smallint not null check (year between 2000 and 2100),
  color           text not null check (char_length(color) between 1 and 30),
  plate_letters   text not null check (plate_letters ~ '^[A-Z]{3}$'),    -- Latin form of the Saudi plate letters
  plate_number    text not null check (plate_number ~ '^[0-9]{1,4}$'),
  sequence_number text not null unique check (sequence_number ~ '^[0-9]{6,12}$'), -- Istimara serial (needed by Wasl)
  seats           smallint not null check (seats between 1 and 8),
  status          public.vehicle_status not null default 'pending_review',
  status_reason   text,
  wasl_status     public.wasl_status not null default 'not_submitted',
  wasl_reference  text,
  wasl_checked_at timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint vehicles_plate_unique unique (plate_letters, plate_number),
  constraint vehicles_id_driver_unique unique (id, driver_id),
  constraint vehicles_xl_seats check (vehicle_class <> 'xl' or seats >= 6)
);
create index vehicles_driver_ix on public.vehicles (driver_id);
create trigger vehicles_touch before update on public.vehicles
  for each row execute function private.touch_updated_at();

alter table public.drivers
  add constraint drivers_current_vehicle_fk
  foreign key (current_vehicle_id, id) references public.vehicles (id, driver_id)
  on delete set null (current_vehicle_id);

-- 9 ─ driver_documents (files live in Storage bucket `driver-documents/<driver_id>/…`) ─
create table public.driver_documents (
  id               uuid primary key default gen_random_uuid(),
  driver_id        uuid not null references public.drivers (id) on delete cascade,
  vehicle_id       uuid,
  doc_type         public.document_type not null,
  storage_path     text not null,
  status           public.document_status not null default 'uploaded',
  expires_at       date,
  reviewed_by      uuid references public.profiles (id) on delete set null,
  reviewed_at      timestamptz,
  rejection_reason text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint driver_documents_vehicle_fk foreign key (vehicle_id, driver_id)
    references public.vehicles (id, driver_id) on delete cascade,
  constraint driver_documents_vehicle_scope check (
    (doc_type in ('vehicle_registration', 'vehicle_insurance', 'vehicle_inspection')) = (vehicle_id is not null)
  ),
  constraint driver_documents_own_folder check (storage_path like driver_id::text || '/%'),
  constraint driver_documents_rejection_reason check (status <> 'rejected' or rejection_reason is not null)
);
-- Only one live (uploaded/approved) document per driver × type × vehicle.
create unique index driver_documents_one_live_ix on public.driver_documents
  (driver_id, doc_type, coalesce(vehicle_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where status in ('uploaded', 'approved');
create index driver_documents_review_ix on public.driver_documents (status, created_at) where status = 'uploaded';
create trigger driver_documents_touch before update on public.driver_documents
  for each row execute function private.touch_updated_at();

-- 10 ─ driver_locations (latest position per driver; PostGIS) ─────────────────
create table public.driver_locations (
  driver_id     uuid primary key references public.drivers (id) on delete cascade,
  location      extensions.geography(Point, 4326) not null,
  heading       numeric(5, 2) check (heading >= 0 and heading < 360),
  speed_kmh     numeric(5, 1) check (speed_kmh between 0 and 300),
  accuracy_m    numeric(7, 1) check (accuracy_m >= 0),
  vehicle_class public.vehicle_class,           -- maintained by trigger from current vehicle
  is_available  boolean not null default false, -- maintained by trigger (online, approved, no active ride)
  updated_at    timestamptz not null default now()
);
create index driver_locations_gix           on public.driver_locations using gist (location);
create index driver_locations_available_gix on public.driver_locations using gist (location) where is_available;

-- ============================================================================
-- Authorization helpers (SECURITY DEFINER so RLS policies can call them
-- without recursive policy evaluation). Permission names mirror
-- DEFAULT_ROLE_PERMISSIONS in src/core/seed.ts.
-- ============================================================================
create or replace function private.is_admin()
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid()) and p.role = 'admin' and not p.is_blocked
  );
$$;

create or replace function private.admin_can(p_permission text)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select coalesce((
    select case p.admin_role
      when 'super_admin' then true
      when 'operations_manager' then p_permission = any (array[
        'dashboard.view','livemap.view','trips.view','trips.cancel','drivers.view','customers.view',
        'vehicles.view','zones.view','zones.edit','pricing.view','support.view','reports.view','reports.export'])
      when 'finance_manager' then p_permission = any (array[
        'dashboard.view','trips.view','finance.view','finance.settle','pricing.view','pricing.edit',
        'reports.view','reports.export','audit.view'])
      when 'customer_support' then p_permission = any (array[
        'dashboard.view','trips.view','customers.view','customers.block','drivers.view','support.view','support.reply'])
      when 'driver_manager' then p_permission = any (array[
        'dashboard.view','livemap.view','drivers.view','drivers.edit','drivers.approve','drivers.suspend',
        'vehicles.view','vehicles.edit','trips.view'])
      when 'marketing_manager' then p_permission = any (array[
        'dashboard.view','marketing.view','marketing.edit','customers.view','reports.view'])
      else false
    end
    from public.profiles p
    where p.id = (select auth.uid()) and p.role = 'admin' and not p.is_blocked
  ), false);
$$;

create or replace function private.is_approved_driver()
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.drivers d join public.profiles p on p.id = d.id
    where d.id = (select auth.uid()) and d.status = 'approved' and not p.is_blocked
  );
$$;

-- Actor kind of the current request (used by audit + events).
create or replace function private.current_actor()
returns public.actor_kind
language sql stable security definer
set search_path = ''
as $$
  select case
    when (select auth.uid()) is null then 'system'::public.actor_kind
    when private.is_admin() then 'admin'::public.actor_kind
    when exists (select 1 from public.drivers d where d.id = (select auth.uid())) then 'driver'::public.actor_kind
    else 'rider'::public.actor_kind
  end;
$$;

-- Which requested class a vehicle may serve (SERVES in src/core/pricing.ts).
create or replace function private.class_serves(p_vehicle public.vehicle_class, p_requested public.vehicle_class)
returns boolean
language sql immutable
set search_path = ''
as $$
  select case p_vehicle
    when 'go'      then p_requested in ('go')
    when 'comfort' then p_requested in ('comfort', 'go')
    when 'black'   then p_requested in ('black', 'comfort')
    when 'xl'      then p_requested in ('xl', 'go')
  end;
$$;

-- ── Identity triggers ───────────────────────────────────────────────────────

-- New auth user → profile + rider (+ rider wallet, created in 005). Never trusts
-- user metadata for privileges: everyone starts as a rider.
create or replace function private.handle_new_user()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, role, full_name, phone, email)
  values (
    new.id,
    'rider',
    nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''),
    case when nullif(new.phone, '') is null then null else '+' || ltrim(new.phone, '+') end,
    nullif(new.email, '')
  );
  insert into public.riders (id) values (new.id);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

-- Driver onboarding: new rows always start `incomplete`; profile becomes `driver`.
create or replace function private.drivers_before_insert()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (select auth.uid()) is not null then
    new.status := 'incomplete';
    new.is_online := false;
    new.wasl_status := 'not_submitted';
    new.approved_at := null;
    new.approved_by := null;
  end if;
  return new;
end;
$$;
create trigger drivers_before_insert before insert on public.drivers
  for each row execute function private.drivers_before_insert();

create or replace function private.drivers_after_insert()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  update public.profiles set role = 'driver' where id = new.id and role = 'rider';
  return new;
end;
$$;
create trigger drivers_after_insert after insert on public.drivers
  for each row execute function private.drivers_after_insert();

-- Going online requires an approved current vehicle; Wasl eligibility is required for approval (see admin_set_driver_status).
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
  end if;
  if new.status <> 'approved' then
    new.is_online := false;
  end if;
  return new;
end;
$$;
create trigger drivers_before_update before update on public.drivers
  for each row execute function private.drivers_before_update();

-- Vehicles inserted by drivers always start pending review.
create or replace function private.vehicles_before_insert()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (select auth.uid()) is not null then
    new.status := 'pending_review';
    new.wasl_status := 'not_submitted';
  end if;
  return new;
end;
$$;
create trigger vehicles_before_insert before insert on public.vehicles
  for each row execute function private.vehicles_before_insert();

-- Documents uploaded by drivers always start as `uploaded`.
create or replace function private.documents_before_insert()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (select auth.uid()) is not null then
    new.status := 'uploaded';
    new.reviewed_by := null;
    new.reviewed_at := null;
  end if;
  return new;
end;
$$;
create trigger driver_documents_before_insert before insert on public.driver_documents
  for each row execute function private.documents_before_insert();
