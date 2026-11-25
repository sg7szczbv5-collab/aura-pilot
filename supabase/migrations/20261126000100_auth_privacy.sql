-- ============================================================================
-- AURA · 010 · Auth hardening + PDPL privacy (consents, data-subject requests)
-- ----------------------------------------------------------------------------
--  * Admin access now requires an MFA session (JWT aal = 'aal2'). A staff
--    password alone opens nothing.
--  * New permission `privacy.manage` (super_admin only by default).
--  * Tables: 22 user_consents (append-only) · 23 privacy_requests
--  * Required consents are enforced in the database: riders cannot request a
--    ride and captains cannot go online without the current versions.
--  * Self-service data export (right of access) and erasure workflow
--    (right to destruction), with legally-required records retained.
-- Consent versions and required sets mirror src/privacy/consents.ts.
-- ============================================================================

-- ── Admin = role admin + not blocked + MFA (aal2) ────────────────────────────
create or replace function private.session_aal()
returns text
language sql stable
set search_path = ''
as $$
  select coalesce((select auth.jwt()) ->> 'aal', 'aal1');
$$;

create or replace function private.is_admin()
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select private.session_aal() = 'aal2' and exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid()) and p.role = 'admin' and not p.is_blocked
  );
$$;

create or replace function private.admin_can(p_permission text)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select private.session_aal() = 'aal2' and coalesce((
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

-- ── Consent catalogue ───────────────────────────────────────────────────────
create type public.consent_purpose as enum (
  'terms_of_service',          -- contract
  'privacy_policy',            -- notice acknowledgement
  'location_tracking',         -- captains: location while online / on trip
  'regulatory_data_sharing',   -- captains: sharing with TGA (Wasl) and authorities
  'marketing_communications',  -- optional
  'analytics'                  -- optional
);
create type public.privacy_request_type   as enum ('access', 'correction', 'deletion', 'restriction', 'objection');
create type public.privacy_request_status as enum ('pending', 'in_progress', 'completed', 'rejected', 'cancelled');

create or replace function private.consent_version(p_purpose public.consent_purpose)
returns text
language sql immutable
set search_path = ''
as $$
  select case p_purpose
    when 'terms_of_service'         then '2026-11-26'
    when 'privacy_policy'           then '2026-11-26'
    when 'location_tracking'        then '2026-11-26'
    when 'regulatory_data_sharing'  then '2026-11-26'
    when 'marketing_communications' then '2026-11-26'
    when 'analytics'                then '2026-11-26'
  end;
$$;

-- p_app: 'rider' | 'driver'
create or replace function private.required_consents(p_app text)
returns public.consent_purpose[]
language sql immutable
set search_path = ''
as $$
  select case p_app
    when 'rider'  then array['terms_of_service', 'privacy_policy']::public.consent_purpose[]
    when 'driver' then array['terms_of_service', 'privacy_policy', 'location_tracking',
                             'regulatory_data_sharing']::public.consent_purpose[]
    else '{}'::public.consent_purpose[]
  end;
$$;

-- 22 ─ user_consents (append-only history = proof of consent) ─────────────────
create table public.user_consents (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles (id) on delete cascade,
  purpose        public.consent_purpose not null,
  granted        boolean not null,
  policy_version text not null check (policy_version ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  source         text not null check (source in ('rider_app', 'driver_app', 'admin_console', 'web')),
  locale         text not null default 'ar' check (locale in ('ar', 'en')),
  user_agent     text check (char_length(user_agent) <= 300),
  created_at     timestamptz not null default clock_timestamp()
);
create index user_consents_latest_ix on public.user_consents (user_id, purpose, created_at desc);
create trigger user_consents_append_only before update or delete on public.user_consents
  for each row execute function private.forbid_mutation();

-- 23 ─ privacy_requests (PDPL data-subject requests) ───────────────────────────
create table public.privacy_requests (
  id              uuid primary key default gen_random_uuid(),
  request_number  bigint generated always as identity unique,
  user_id         uuid not null references public.profiles (id) on delete cascade,
  request_type    public.privacy_request_type not null,
  status          public.privacy_request_status not null default 'pending',
  details         text check (char_length(details) <= 2000),
  resolution_note text check (char_length(resolution_note) <= 2000),
  due_at          timestamptz not null default (now() + interval '30 days'),
  handled_by      uuid references public.profiles (id) on delete set null,
  completed_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint privacy_requests_closed_ts check (
    status not in ('completed', 'rejected', 'cancelled') or completed_at is not null),
  constraint privacy_requests_reject_reason check (status <> 'rejected' or resolution_note is not null)
);
create index privacy_requests_user_ix  on public.privacy_requests (user_id, created_at desc);
create index privacy_requests_queue_ix on public.privacy_requests (status, due_at) where status in ('pending', 'in_progress');
create unique index privacy_requests_one_open_per_type_ix on public.privacy_requests (user_id, request_type)
  where status in ('pending', 'in_progress') and request_type <> 'access';
create trigger privacy_requests_touch before update on public.privacy_requests
  for each row execute function private.touch_updated_at();

-- ── Helpers ─────────────────────────────────────────────────────────────────
create or replace function private.missing_consents_for(p_user uuid, p_app text)
returns public.consent_purpose[]
language sql stable security definer
set search_path = ''
as $$
  select coalesce(array_agg(req order by req), '{}'::public.consent_purpose[])
  from unnest(private.required_consents(p_app)) as req
  where not exists (
    select 1 from (
      select c.granted, c.policy_version
      from public.user_consents c
      where c.user_id = p_user and c.purpose = req
      order by c.created_at desc
      limit 1
    ) last
    where last.granted and last.policy_version = private.consent_version(req)
  );
$$;

create or replace function private.has_consent(p_user uuid, p_purpose public.consent_purpose)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select coalesce((
    select c.granted and c.policy_version = private.consent_version(p_purpose)
    from public.user_consents c
    where c.user_id = p_user and c.purpose = p_purpose
    order by c.created_at desc limit 1), false);
$$;

-- ── Enforcement in the data path ────────────────────────────────────────────
create or replace function private.rides_require_consent()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if cardinality(private.missing_consents_for(new.rider_id, 'rider')) > 0 then
    raise exception 'AURA: rider must accept the current terms and privacy policy' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger rides_require_consent before insert on public.rides
  for each row execute function private.rides_require_consent();

create or replace function private.drivers_require_consent()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.is_online and not old.is_online
     and cardinality(private.missing_consents_for(new.id, 'driver')) > 0 then
    raise exception 'AURA: captain must accept the current terms, privacy, location and regulatory notices'
      using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger drivers_require_consent before update on public.drivers
  for each row execute function private.drivers_require_consent();

-- Erasure may rewrite otherwise append-only support messages.
create or replace function private.forbid_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and tg_table_name = 'ticket_messages'
     and current_setting('aura.erasure', true) = 'on' then
    return new;
  end if;
  raise exception 'AURA: % is append-only', tg_table_name using errcode = '42501';
end;
$$;

-- Audit rows written during an erasure do not copy the personal data again.
create or replace function private.audit_row()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_noise   text[] := array['updated_at', 'is_online', 'rating', 'ratings_count', 'completed_rides',
                            'acceptance_rate', 'redemptions_count'];
  v_old     jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  v_new     jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) end;
  v_uid     uuid  := (select auth.uid());
  v_erasure boolean := current_setting('aura.erasure', true) = 'on';
begin
  if tg_op = 'UPDATE' and (v_old - v_noise) = (v_new - v_noise) then
    return null;
  end if;
  insert into public.audit_log (actor_id, actor_kind, admin_role, action, entity_type, entity_id, old_data, new_data, reason)
  values (
    v_uid,
    private.current_actor(),
    (select p.admin_role from public.profiles p where p.id = v_uid),
    tg_table_name || '.' || case when v_erasure then 'erase' else lower(tg_op) end,
    tg_table_name,
    coalesce((v_new ->> 'id'), (v_old ->> 'id'), (v_new ->> 'driver_id'))::uuid,
    case when v_erasure then null else v_old end,
    case when v_erasure then null else v_new end,
    nullif(current_setting('aura.reason', true), '')
  );
  return null;
end;
$$;

create trigger privacy_requests_audit after insert or update on public.privacy_requests
  for each row execute function private.audit_row();

-- ── Client RPCs ─────────────────────────────────────────────────────────────
-- Everything the apps need right after sign-in, in one call.
create or replace function public.my_identity()
returns table (
  user_id uuid, app_role public.app_role, admin_role public.admin_role, is_blocked boolean,
  aal text, full_name text, phone text, email text, driver_status public.driver_status,
  missing_rider_consents text[], missing_driver_consents text[])
language sql stable security definer
set search_path = ''
as $$
  select p.id, p.role, p.admin_role, p.is_blocked, private.session_aal(), p.full_name, p.phone, p.email,
         d.status,
         private.missing_consents_for(p.id, 'rider')::text[],
         private.missing_consents_for(p.id, 'driver')::text[]
  from public.profiles p
  left join public.drivers d on d.id = p.id
  where p.id = (select auth.uid());
$$;

create or replace function public.record_consent(
  p_purpose public.consent_purpose, p_granted boolean, p_policy_version text,
  p_source text, p_locale text default 'ar', p_user_agent text default null)
returns public.user_consents
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v     public.user_consents;
begin
  if v_uid is null then
    raise exception 'AURA: sign in first' using errcode = '42501';
  end if;
  if p_policy_version is distinct from private.consent_version(p_purpose) then
    raise exception 'AURA: outdated policy version % for % (current %)',
      p_policy_version, p_purpose, private.consent_version(p_purpose) using errcode = '22023';
  end if;
  insert into public.user_consents (user_id, purpose, granted, policy_version, source, locale, user_agent)
  values (v_uid, p_purpose, p_granted, p_policy_version, p_source, coalesce(p_locale, 'ar'), left(p_user_agent, 300))
  returning * into v;
  -- Withdrawing a captain-required consent takes the captain offline immediately.
  if not p_granted and p_purpose = any (private.required_consents('driver')) then
    update public.drivers set is_online = false where id = v_uid and is_online;
  end if;
  return v;
end;
$$;

create or replace function public.my_consents()
returns table (purpose public.consent_purpose, granted boolean, policy_version text,
               current_version text, is_current boolean, recorded_at timestamptz)
language sql stable security definer
set search_path = ''
as $$
  select k.purpose, coalesce(l.granted, false), l.policy_version, private.consent_version(k.purpose),
         coalesce(l.granted and l.policy_version = private.consent_version(k.purpose), false), l.created_at
  from unnest(enum_range(null::public.consent_purpose)) as k (purpose)
  left join lateral (
    select c.granted, c.policy_version, c.created_at from public.user_consents c
    where c.user_id = (select auth.uid()) and c.purpose = k.purpose
    order by c.created_at desc limit 1
  ) l on true;
$$;

-- Right of access: a machine-readable copy of the caller's personal data.
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
    'format', 'aura.personal-data.v1',
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
                                     'dropoff', extensions.st_asgeojson(r.dropoff)::jsonb)
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

create or replace function public.submit_privacy_request(
  p_type public.privacy_request_type, p_details text default null)
returns public.privacy_requests
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v     public.privacy_requests;
begin
  if v_uid is null then
    raise exception 'AURA: sign in first' using errcode = '42501';
  end if;
  if p_type = 'access' then
    raise exception 'AURA: use export_my_data for access requests' using errcode = '22023';
  end if;
  if p_type = 'deletion' and exists (
       select 1 from public.rides r where (r.rider_id = v_uid or r.driver_id = v_uid)
         and r.status in ('searching', 'driver_assigned', 'driver_arriving', 'driver_arrived', 'in_progress')) then
    raise exception 'AURA: finish your active ride before requesting deletion' using errcode = '55000';
  end if;
  if exists (select 1 from public.privacy_requests
              where user_id = v_uid and request_type = p_type and status in ('pending', 'in_progress')) then
    raise exception 'AURA: you already have an open % request', p_type using errcode = '23505';
  end if;
  insert into public.privacy_requests (user_id, request_type, details)
  values (v_uid, p_type, left(p_details, 2000))
  returning * into v;
  return v;
end;
$$;

create or replace function public.cancel_privacy_request(p_request_id uuid)
returns public.privacy_requests
language plpgsql security definer
set search_path = ''
as $$
declare
  v public.privacy_requests;
begin
  update public.privacy_requests set status = 'cancelled', completed_at = now()
   where id = p_request_id and user_id = (select auth.uid()) and status = 'pending'
  returning * into v;
  if not found then
    raise exception 'AURA: request cannot be cancelled' using errcode = '55000';
  end if;
  return v;
end;
$$;

-- ── Erasure (right to destruction) ──────────────────────────────────────────
-- Removes or masks personal data. Kept, as required by law: rides/payments/ledger
-- (tax, TGA trip records), consent history (proof), audit entries.
-- Afterwards the Edge Function deletes Storage files and bans the auth user.
create or replace function private.erase_user(p_user_id uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.profiles where id = p_user_id and role = 'admin') then
    raise exception 'AURA: revoke the staff role before erasing this account' using errcode = '55000';
  end if;
  if exists (select 1 from public.rides r where (r.rider_id = p_user_id or r.driver_id = p_user_id)
               and r.status in ('searching', 'driver_assigned', 'driver_arriving', 'driver_arrived', 'in_progress')) then
    raise exception 'AURA: account has an active ride' using errcode = '55000';
  end if;
  if exists (select 1 from public.wallet_accounts where owner_id = p_user_id and balance_halalas <> 0) then
    raise exception 'AURA: settle the wallet balance to zero before erasure' using errcode = '55000';
  end if;
  if exists (select 1 from public.payouts where driver_id = p_user_id and status in ('pending', 'approved', 'processing')) then
    raise exception 'AURA: account has a payout in progress' using errcode = '55000';
  end if;

  perform set_config('aura.erasure', 'on', true);
  perform set_config('aura.reason', 'PDPL erasure', true);

  update public.profiles
     set full_name = null, phone = null, email = null, avatar_path = null,
         is_blocked = true, blocked_reason = 'account_erased'
   where id = p_user_id;
  update public.riders
     set emergency_contact_name = null, emergency_contact_phone = null, default_payment_method_id = null
   where id = p_user_id;
  update public.payment_methods set deleted_at = coalesce(deleted_at, now()), is_default = false, holder_name = null
   where rider_id = p_user_id;
  delete from private.payment_tokens t using public.payment_methods m
   where m.id = t.payment_method_id and m.rider_id = p_user_id;
  update public.drivers
     set national_id = null, date_of_birth = null, iban = null, bank_name = null,
         is_online = false, status = 'suspended', status_reason = 'account_erased'
   where id = p_user_id;
  update public.vehicles set status = 'inactive' where driver_id = p_user_id;
  update public.driver_documents set status = 'expired'
   where driver_id = p_user_id and status in ('uploaded', 'approved');
  delete from public.driver_locations where driver_id = p_user_id;
  update public.rides set feedback_by_rider = null where rider_id = p_user_id and feedback_by_rider is not null;
  update public.tickets set subject = '[erased]' where opened_by = p_user_id;
  update public.ticket_messages set body = '[erased]' where author_id = p_user_id;

  perform set_config('aura.erasure', '', true);
end;
$$;

-- ── Admin: handle requests (privacy.manage) ─────────────────────────────────
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

  if p_status = 'completed' and v.request_type = 'deletion' then
    perform private.erase_user(v.user_id);
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

-- ── RLS + privileges ────────────────────────────────────────────────────────
alter table public.user_consents    enable row level security;
alter table public.privacy_requests enable row level security;

revoke all on public.user_consents, public.privacy_requests from anon, authenticated;
grant select on public.user_consents, public.privacy_requests to authenticated;
grant all on public.user_consents, public.privacy_requests to service_role;

create policy user_consents_read on public.user_consents for select to authenticated
  using (user_id = (select auth.uid()) or private.admin_can('privacy.manage'));
create policy privacy_requests_read on public.privacy_requests for select to authenticated
  using (user_id = (select auth.uid()) or private.admin_can('privacy.manage'));

revoke execute on all functions in schema public from public, anon;
revoke execute on function
  public.my_identity(), public.record_consent(public.consent_purpose, boolean, text, text, text, text),
  public.my_consents(), public.export_my_data(),
  public.submit_privacy_request(public.privacy_request_type, text), public.cancel_privacy_request(uuid),
  public.admin_update_privacy_request(uuid, public.privacy_request_status, text)
from authenticated;
grant execute on function
  public.my_identity(), public.record_consent(public.consent_purpose, boolean, text, text, text, text),
  public.my_consents(), public.export_my_data(),
  public.submit_privacy_request(public.privacy_request_type, text), public.cancel_privacy_request(uuid),
  public.admin_update_privacy_request(uuid, public.privacy_request_status, text)
to authenticated, service_role;

revoke execute on all functions in schema private from public, anon, authenticated;
grant  execute on all functions in schema private to service_role;
grant  execute on function
  private.is_admin(), private.admin_can(text), private.is_approved_driver(), private.current_actor(),
  private.is_ride_participant(uuid), private.owns_wallet_account(uuid), private.owns_ticket(uuid),
  private.is_my_active_driver(uuid), private.session_aal()
to authenticated;
