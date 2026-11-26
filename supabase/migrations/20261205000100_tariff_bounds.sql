-- ============================================================================
-- AURA · 020 · Server-side bounds for tariff edits
-- ----------------------------------------------------------------------------
-- Staff with pricing.edit can change tariffs from the admin console (live mode).
-- Until now the table only rejected negative values, so an accidental 0 (or an
-- extra digit) went live for every rider at once. These bounds mirror
-- src/apps/admin/live/tariffValidation.ts (TARIFF_BOUNDS) — keep both in sync:
--
--   base fare            0.00 – 100.00 SAR      (0 – 10 000 halalas)
--   per km               0.50 –  20.00 SAR      (50 – 2 000)
--   per minute           0.00 –   5.00 SAR      (0 – 500)
--   minimum fare         5.00 – 200.00 SAR      (500 – 20 000)
--   cancellation fee     0.00 – 100.00 SAR      (0 – 10 000)
--   commission           0 – 50 %               (already enforced: 0 – 5 000 bps)
--
-- NOT VALID: enforced for every new or edited row; existing rows are not
-- re-checked, so the migration cannot fail on an environment holding an older
-- out-of-range value (run `alter table … validate constraint …` after review).
-- ============================================================================

alter table public.tariffs
  add constraint tariffs_base_fare_bounds        check (base_fare_halalas between 0 and 10000) not valid,
  add constraint tariffs_per_km_bounds           check (per_km_halalas between 50 and 2000) not valid,
  add constraint tariffs_per_min_bounds          check (per_min_halalas between 0 and 500) not valid,
  add constraint tariffs_min_fare_bounds         check (min_fare_halalas between 500 and 20000) not valid,
  add constraint tariffs_cancellation_fee_bounds check (cancellation_fee_halalas between 0 and 10000) not valid;
