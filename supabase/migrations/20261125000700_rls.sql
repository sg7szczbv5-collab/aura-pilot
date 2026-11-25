-- ============================================================================
-- AURA · 007 · Row Level Security + privileges
-- ----------------------------------------------------------------------------
-- Model
--   anon           : no table access at all.
--   authenticated  : rider / driver / admin. RLS decides which rows; column
--                    GRANTs decide which columns may be written directly.
--                    Everything sensitive (status changes, money, approvals)
--                    goes through SECURITY DEFINER RPCs in 008.
--   service_role   : Edge Functions (bypasses RLS). Never ship this key to a client.
-- Admin access is per permission (private.admin_can) mirroring src/core/seed.ts.
-- ============================================================================

-- ── Extra helpers that need the full schema ──────────────────────────────────
create or replace function private.is_ride_participant(p_ride_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.rides r
    where r.id = p_ride_id
      and ((select auth.uid()) in (r.rider_id, r.driver_id)
           or (r.offered_driver_id = (select auth.uid()) and r.status = 'searching'))
  );
$$;

create or replace function private.owns_wallet_account(p_account_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.wallet_accounts a
    where a.id = p_account_id and a.owner_id = (select auth.uid())
  );
$$;

create or replace function private.owns_ticket(p_ticket_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.tickets t where t.id = p_ticket_id and t.opened_by = (select auth.uid())
  );
$$;

-- Rider may track the driver of their own active ride.
create or replace function private.is_my_active_driver(p_driver_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.rides r
    where r.driver_id = p_driver_id and r.rider_id = (select auth.uid())
      and r.status in ('driver_assigned', 'driver_arriving', 'driver_arrived', 'in_progress')
  );
$$;

revoke all on all functions in schema private from public, anon;
grant execute on function
  private.is_admin(), private.admin_can(text), private.is_approved_driver(), private.current_actor(),
  private.is_ride_participant(uuid), private.owns_wallet_account(uuid), private.owns_ticket(uuid),
  private.is_my_active_driver(uuid)
to authenticated, service_role;

-- ── Enable RLS on all 21 public tables ───────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array[
    'cities', 'zones', 'tariffs', 'promos',
    'profiles', 'riders', 'drivers', 'vehicles', 'driver_documents', 'driver_locations',
    'rides', 'ride_events',
    'payment_methods', 'payments', 'wallet_accounts', 'wallet_ledger', 'payouts',
    'tickets', 'ticket_messages', 'audit_log', 'wasl_sync_log']
  loop
    -- ENABLE (not FORCE): SECURITY DEFINER RPCs owned by the migration role
    -- act as the table owner and do their own authorization checks.
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

-- ── Table privileges (defence in depth on top of RLS) ────────────────────────
revoke all on all tables    in schema public  from anon, authenticated;
revoke all on all sequences in schema public  from anon, authenticated;
revoke all on all tables    in schema private from anon, authenticated;
grant  all on all tables    in schema public  to service_role;
grant  all on all sequences in schema public  to service_role;
grant  all on all tables    in schema private to service_role;
grant usage on all sequences in schema public to authenticated;

-- Read access (rows still filtered by RLS)
grant select on all tables in schema public to authenticated;

-- Catalogue: admins write directly (RLS limits to the right permission)
grant insert, update, delete on public.cities, public.zones, public.tariffs, public.promos to authenticated;

-- Column-limited self-service writes
grant update (full_name, locale, avatar_path)                                   on public.profiles to authenticated;
grant update (emergency_contact_name, emergency_contact_phone, default_payment_method_id) on public.riders to authenticated;
grant insert (id, city_id, national_id, date_of_birth, iban, bank_name)         on public.drivers to authenticated;
grant update (city_id, iban, bank_name, is_online, current_vehicle_id)          on public.drivers to authenticated;
grant insert (driver_id, vehicle_class, make, model, year, color,
              plate_letters, plate_number, sequence_number, seats)              on public.vehicles to authenticated;
grant insert (driver_id, vehicle_id, doc_type, storage_path, expires_at)       on public.driver_documents to authenticated;
grant insert (driver_id, location, heading, speed_kmh, accuracy_m)             on public.driver_locations to authenticated;
grant update (location, heading, speed_kmh, accuracy_m)                        on public.driver_locations to authenticated;
grant insert (opened_by, ride_id, category, subject)                          on public.tickets to authenticated;
grant update (status, priority, assigned_to)                                   on public.tickets to authenticated;
grant insert (ticket_id, author_id, body, is_internal)                         on public.ticket_messages to authenticated;
-- rides, ride_events, payment_methods, payments, wallet_*, payouts, audit_log,
-- wasl_sync_log: read-only for clients; writes only via RPC / service_role.

-- ============================================================================
-- Policies
-- ============================================================================

-- cities / zones / tariffs ----------------------------------------------------
create policy cities_read on public.cities for select to authenticated using (true);
create policy cities_admin_write on public.cities for all to authenticated
  using (private.admin_can('zones.edit')) with check (private.admin_can('zones.edit'));

create policy zones_read on public.zones for select to authenticated
  using (is_active or private.admin_can('zones.view'));
create policy zones_admin_write on public.zones for all to authenticated
  using (private.admin_can('zones.edit')) with check (private.admin_can('zones.edit'));

create policy tariffs_read on public.tariffs for select to authenticated
  using (is_active or private.admin_can('pricing.view'));
create policy tariffs_admin_write on public.tariffs for all to authenticated
  using (private.admin_can('pricing.edit')) with check (private.admin_can('pricing.edit'));

-- promos: codes are not listable by riders (validate via public.quote_fare) ----
create policy promos_admin_read on public.promos for select to authenticated
  using (private.admin_can('marketing.view'));
create policy promos_admin_write on public.promos for all to authenticated
  using (private.admin_can('marketing.edit')) with check (private.admin_can('marketing.edit'));

-- profiles ---------------------------------------------------------------------
create policy profiles_read on public.profiles for select to authenticated
  using (id = (select auth.uid()) or private.is_admin());
create policy profiles_update_self on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- riders -----------------------------------------------------------------------
create policy riders_read on public.riders for select to authenticated
  using (id = (select auth.uid()) or private.admin_can('customers.view'));
create policy riders_update_self on public.riders for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- drivers ----------------------------------------------------------------------
create policy drivers_read on public.drivers for select to authenticated
  using (id = (select auth.uid()) or private.admin_can('drivers.view'));
create policy drivers_insert_self on public.drivers for insert to authenticated
  with check (id = (select auth.uid()));
create policy drivers_update_self on public.drivers for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- vehicles ---------------------------------------------------------------------
create policy vehicles_read on public.vehicles for select to authenticated
  using (driver_id = (select auth.uid()) or private.admin_can('vehicles.view'));
create policy vehicles_insert_self on public.vehicles for insert to authenticated
  with check (driver_id = (select auth.uid()));

-- driver_documents -------------------------------------------------------------
create policy driver_documents_read on public.driver_documents for select to authenticated
  using (driver_id = (select auth.uid()) or private.admin_can('drivers.view'));
create policy driver_documents_insert_self on public.driver_documents for insert to authenticated
  with check (driver_id = (select auth.uid()));

-- driver_locations -------------------------------------------------------------
create policy driver_locations_read on public.driver_locations for select to authenticated
  using (driver_id = (select auth.uid())
         or private.admin_can('livemap.view')
         or private.is_my_active_driver(driver_id));
create policy driver_locations_insert_self on public.driver_locations for insert to authenticated
  with check (driver_id = (select auth.uid()) and private.is_approved_driver());
create policy driver_locations_update_self on public.driver_locations for update to authenticated
  using (driver_id = (select auth.uid()))
  with check (driver_id = (select auth.uid()) and private.is_approved_driver());

-- rides / ride_events ------------------------------------------------------------
create policy rides_read on public.rides for select to authenticated
  using (rider_id = (select auth.uid())
         or driver_id = (select auth.uid())
         or (offered_driver_id = (select auth.uid()) and status = 'searching')
         or private.admin_can('trips.view'));

create policy ride_events_read on public.ride_events for select to authenticated
  using (private.is_ride_participant(ride_id) or private.admin_can('trips.view'));

-- payment_methods / payments -----------------------------------------------------
create policy payment_methods_read on public.payment_methods for select to authenticated
  using ((rider_id = (select auth.uid()) and deleted_at is null) or private.admin_can('finance.view'));

create policy payments_read on public.payments for select to authenticated
  using (rider_id = (select auth.uid()) or private.admin_can('finance.view'));

-- wallets / ledger / payouts -----------------------------------------------------
create policy wallet_accounts_read on public.wallet_accounts for select to authenticated
  using (owner_id = (select auth.uid()) or private.admin_can('finance.view'));

create policy wallet_ledger_read on public.wallet_ledger for select to authenticated
  using (private.owns_wallet_account(account_id) or private.admin_can('finance.view'));

create policy payouts_read on public.payouts for select to authenticated
  using (driver_id = (select auth.uid()) or private.admin_can('finance.view'));

-- tickets / ticket_messages ------------------------------------------------------
create policy tickets_read on public.tickets for select to authenticated
  using (opened_by = (select auth.uid()) or private.admin_can('support.view'));
create policy tickets_insert_self on public.tickets for insert to authenticated
  with check (opened_by = (select auth.uid())
              and (ride_id is null or private.is_ride_participant(ride_id)));
create policy tickets_agent_update on public.tickets for update to authenticated
  using (private.admin_can('support.reply')) with check (private.admin_can('support.reply'));

create policy ticket_messages_read on public.ticket_messages for select to authenticated
  using ((not is_internal and private.owns_ticket(ticket_id)) or private.admin_can('support.view'));
create policy ticket_messages_insert on public.ticket_messages for insert to authenticated
  with check (
    author_id = (select auth.uid()) and (
      (not is_internal and private.owns_ticket(ticket_id))
      or private.admin_can('support.reply')));

-- audit_log / wasl_sync_log ------------------------------------------------------
create policy audit_log_read on public.audit_log for select to authenticated
  using (private.admin_can('audit.view'));

create policy wasl_sync_log_read on public.wasl_sync_log for select to authenticated
  using (private.admin_can('drivers.view') or private.admin_can('audit.view'));
