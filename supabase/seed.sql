-- ============================================================================
-- AURA · seed (reference data only, for local/dev). `supabase db reset` runs it.
-- Values mirror the DEMO values in src/core/geo.ts and src/core/pricing.ts.
-- Tariffs are placeholders: real tariffs must be approved before launch.
-- No users are seeded: create them through Supabase Auth.
-- ============================================================================

insert into public.cities (code, name_ar, name_en, status, center, service_area) values
  ('riyadh',  'الرياض',          'Riyadh',  'live',    'SRID=4326;POINT(46.6753 24.7136)',
     'SRID=4326;MULTIPOLYGON(((46.52 24.58, 46.84 24.58, 46.84 24.99, 46.52 24.99, 46.52 24.58)))'),
  ('jeddah',  'جدة',             'Jeddah',  'live',    'SRID=4326;POINT(39.1728 21.5433)', null),
  ('dammam',  'الدمام',          'Dammam',  'live',    'SRID=4326;POINT(50.0888 26.4207)', null),
  ('khobar',  'الخبر',           'Khobar',  'pilot',   'SRID=4326;POINT(50.1971 26.2172)', null),
  ('makkah',  'مكة المكرمة',     'Makkah',  'pilot',   'SRID=4326;POINT(39.8579 21.3891)', null),
  ('madinah', 'المدينة المنورة', 'Madinah', 'planned', 'SRID=4326;POINT(39.5692 24.5247)', null)
on conflict (code) do nothing;

-- Riyadh base tariffs scaled per city exactly like scaleTariffs() in pricing.ts
with base (vehicle_class, base_fare, per_km, per_min, min_fare, commission_bps) as (
  values ('go'::public.vehicle_class,      600, 165, 30, 1200, 2000),
         ('comfort'::public.vehicle_class, 800, 190, 35, 1500, 2000),
         ('black'::public.vehicle_class,  1500, 300, 55, 3000, 2200),
         ('xl'::public.vehicle_class,     1200, 260, 45, 2500, 2000)
), factor (code, f) as (
  values ('riyadh', 1.00), ('jeddah', 1.00), ('dammam', 0.95),
         ('khobar', 0.95), ('makkah', 1.05), ('madinah', 0.95)
)
insert into public.tariffs (city_id, vehicle_class, base_fare_halalas, per_km_halalas, per_min_halalas,
                            min_fare_halalas, commission_bps, vat_bps)
select c.id, b.vehicle_class, round(b.base_fare * f.f), round(b.per_km * f.f), round(b.per_min * f.f),
       b.min_fare, b.commission_bps, 1500
from base b
cross join factor f
join public.cities c on c.code = f.code
where not exists (select 1 from public.tariffs t where t.city_id = c.id and t.vehicle_class = b.vehicle_class and t.is_active);

-- Riyadh zones
insert into public.zones (city_id, kind, name_ar, name_en, area, surge_multiplier)
select c.id, z.kind, z.name_ar, z.name_en, z.area::extensions.geography, z.mult
from public.cities c
cross join (values
  ('airport'::public.zone_kind, 'مطار الملك خالد الدولي', 'King Khalid International Airport',
   'SRID=4326;POLYGON((46.67 24.93, 46.73 24.93, 46.73 24.98, 46.67 24.98, 46.67 24.93))', 1.00),
  ('high_demand'::public.zone_kind, 'مركز الملك عبدالله المالي', 'KAFD',
   'SRID=4326;POLYGON((46.632 24.755, 46.650 24.755, 46.650 24.772, 46.632 24.772, 46.632 24.755))', 1.20)
) as z (kind, name_ar, name_en, area, mult)
where c.code = 'riyadh'
  and not exists (select 1 from public.zones x where x.city_id = c.id and x.name_en = z.name_en);
