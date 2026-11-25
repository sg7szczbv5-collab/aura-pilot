-- ============================================================================
-- AURA · 001 · Extensions, schemas and enum types
-- ----------------------------------------------------------------------------
-- Conventions used by every AURA migration:
--   * All primary keys are UUID (gen_random_uuid()).
--   * All money is stored as INTEGER/BIGINT halalas (1 SAR = 100 halalas),
--     never as float. Currency is fixed to SAR.
--   * Geography uses PostGIS geography(…, 4326) (lat/lng, metres).
--   * `public`  = tables exposed through the Supabase API (protected by RLS).
--   * `private` = internal helpers/secrets, never exposed through the API.
-- ============================================================================

create schema if not exists extensions;
create extension if not exists postgis with schema extensions;

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated, service_role;

-- ── Identity & roles ────────────────────────────────────────────────────────
create type public.app_role as enum ('rider', 'driver', 'admin');

-- Mirrors AdminRole in src/core/types.ts
create type public.admin_role as enum (
  'super_admin', 'operations_manager', 'finance_manager',
  'customer_support', 'driver_manager', 'marketing_manager'
);

-- Who performed an action (src/core/types.ts Actor, with passenger → rider)
create type public.actor_kind as enum ('rider', 'driver', 'admin', 'system');

-- ── Geography / catalogue ───────────────────────────────────────────────────
create type public.city_status   as enum ('live', 'pilot', 'planned');
create type public.vehicle_class as enum ('go', 'comfort', 'black', 'xl');
create type public.zone_kind     as enum ('service', 'restricted', 'high_demand', 'airport');

-- ── Drivers ─────────────────────────────────────────────────────────────────
create type public.driver_status   as enum ('incomplete', 'pending_review', 'approved', 'rejected', 'suspended');
create type public.vehicle_status  as enum ('pending_review', 'approved', 'rejected', 'inactive');
create type public.document_type   as enum (
  'national_id', 'driving_license', 'profile_photo',
  'vehicle_registration', 'vehicle_insurance', 'vehicle_inspection'
);
create type public.document_status as enum ('uploaded', 'approved', 'rejected', 'expired');
create type public.wasl_status     as enum ('not_submitted', 'pending', 'eligible', 'ineligible', 'error');

-- ── Rides (identical to TRIP_STATUSES in src/core/trip.ts) ──────────────────
create type public.ride_status as enum (
  'searching', 'driver_assigned', 'driver_arriving', 'driver_arrived',
  'in_progress', 'completed', 'cancelled'
);

-- ── Money ───────────────────────────────────────────────────────────────────
create type public.payment_method_type as enum ('mada', 'card', 'apple_pay', 'stc_pay', 'wallet', 'cash');
create type public.payment_provider    as enum ('moyasar', 'hyperpay', 'wallet', 'cash', 'mock');
create type public.payment_kind        as enum ('charge', 'refund', 'wallet_topup');
create type public.payment_status      as enum ('initiated', 'authorized', 'paid', 'failed', 'voided');
create type public.account_type        as enum (
  'rider_wallet', 'driver_wallet',
  'platform_commission', 'platform_vat', 'gateway_clearing',
  'promo_expense', 'payout_clearing', 'adjustments'
);
create type public.ledger_entry_type as enum (
  'ride_fare', 'commission', 'vat', 'driver_earning', 'promo_discount',
  'cash_collected', 'wallet_topup', 'wallet_payment', 'refund', 'payout', 'tip', 'adjustment'
);
create type public.payout_status as enum ('pending', 'approved', 'processing', 'paid', 'failed', 'cancelled');
create type public.promo_type    as enum ('percent', 'fixed');

-- ── Support, Wasl ───────────────────────────────────────────────────────────
create type public.ticket_category as enum ('complaint', 'report', 'help', 'dispute', 'lost_item', 'safety');
create type public.ticket_status   as enum ('open', 'pending', 'resolved');
create type public.ticket_priority as enum ('low', 'normal', 'high', 'urgent');
create type public.message_author  as enum ('rider', 'driver', 'agent', 'system');
create type public.wasl_entity     as enum ('driver', 'vehicle', 'ride');
create type public.sync_status     as enum ('pending', 'success', 'failed');

-- ── Shared trigger: keep updated_at current ─────────────────────────────────
create or replace function private.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
