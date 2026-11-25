-- ============================================================================
-- AURA · 002 · Catalogue: cities, zones (PostGIS), tariffs, promos
-- Tables: 1 cities · 2 zones · 3 tariffs · 4 promos
-- ============================================================================

-- 1 ─ cities ────────────────────────────────────────────────────────────────
create table public.cities (
  id            uuid primary key default gen_random_uuid(),
  code          text not null unique check (code ~ '^[a-z][a-z_]{1,30}$'),
  name_ar       text not null check (char_length(name_ar) between 1 and 80),
  name_en       text not null check (char_length(name_en) between 1 and 80),
  status        public.city_status not null default 'planned',
  center        extensions.geography(Point, 4326) not null,
  service_area  extensions.geography(MultiPolygon, 4326),
  timezone      text not null default 'Asia/Riyadh',
  currency      char(3) not null default 'SAR' check (currency = 'SAR'),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index cities_service_area_gix on public.cities using gist (service_area);
create trigger cities_touch before update on public.cities
  for each row execute function private.touch_updated_at();

-- 2 ─ zones (surge / airport / restricted / service polygons) ─────────────────
create table public.zones (
  id                 uuid primary key default gen_random_uuid(),
  city_id            uuid not null references public.cities (id) on delete restrict,
  kind               public.zone_kind not null,
  name_ar            text not null check (char_length(name_ar) between 1 and 120),
  name_en            text not null check (char_length(name_en) between 1 and 120),
  area               extensions.geography(Polygon, 4326) not null,
  surge_multiplier   numeric(4, 2) not null default 1.00 check (surge_multiplier between 1.00 and 5.00),
  is_active         boolean not null default true,
  starts_at          timestamptz,
  ends_at            timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint zones_window_valid check (ends_at is null or starts_at is null or ends_at > starts_at),
  constraint zones_surge_only_high_demand check (kind = 'high_demand' or surge_multiplier = 1.00)
);
create index zones_area_gix      on public.zones using gist (area);
create index zones_city_active_ix on public.zones (city_id, kind) where is_active;
create trigger zones_touch before update on public.zones
  for each row execute function private.touch_updated_at();

-- 3 ─ tariffs (one active tariff per city × vehicle class) ────────────────────
-- Mirrors ClassTariff in src/core/pricing.ts. Rates are basis points (2000 = 20%).
create table public.tariffs (
  id                       uuid primary key default gen_random_uuid(),
  city_id                  uuid not null references public.cities (id) on delete restrict,
  vehicle_class            public.vehicle_class not null,
  base_fare_halalas        integer not null check (base_fare_halalas >= 0),
  per_km_halalas           integer not null check (per_km_halalas >= 0),
  per_min_halalas          integer not null check (per_min_halalas >= 0),
  min_fare_halalas         integer not null check (min_fare_halalas >= 0),
  cancellation_fee_halalas integer not null default 0 check (cancellation_fee_halalas >= 0),
  commission_bps           integer not null check (commission_bps between 0 and 5000),
  vat_bps                  integer not null default 1500 check (vat_bps between 0 and 10000),
  is_active                boolean not null default true,
  effective_from           timestamptz not null default now(),
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);
create unique index tariffs_one_active_ix on public.tariffs (city_id, vehicle_class) where is_active;
create trigger tariffs_touch before update on public.tariffs
  for each row execute function private.touch_updated_at();

-- 4 ─ promos ─────────────────────────────────────────────────────────────────
create table public.promos (
  id                   uuid primary key default gen_random_uuid(),
  code                 text not null unique check (code ~ '^[A-Z0-9_-]{3,32}$'),
  description_ar       text,
  description_en       text,
  promo_type           public.promo_type not null,
  percent_bps          integer check (percent_bps between 1 and 10000),
  amount_halalas       integer check (amount_halalas > 0),
  max_discount_halalas integer check (max_discount_halalas > 0),
  min_subtotal_halalas integer not null default 0 check (min_subtotal_halalas >= 0),
  city_id              uuid references public.cities (id) on delete restrict,
  vehicle_class        public.vehicle_class,
  starts_at            timestamptz not null default now(),
  ends_at              timestamptz,
  max_redemptions      integer check (max_redemptions > 0),
  per_rider_limit      integer not null default 1 check (per_rider_limit > 0),
  redemptions_count    integer not null default 0 check (redemptions_count >= 0),
  is_active            boolean not null default true,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint promos_value_shape check (
    (promo_type = 'percent' and percent_bps is not null and amount_halalas is null) or
    (promo_type = 'fixed'   and amount_halalas is not null and percent_bps is null)
  ),
  constraint promos_window_valid check (ends_at is null or ends_at > starts_at),
  constraint promos_redemption_cap check (max_redemptions is null or redemptions_count <= max_redemptions)
);
create index promos_active_ix on public.promos (is_active, starts_at, ends_at);
create trigger promos_touch before update on public.promos
  for each row execute function private.touch_updated_at();
