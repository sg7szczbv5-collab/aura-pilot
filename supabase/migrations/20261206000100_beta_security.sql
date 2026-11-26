-- ═══════════════════════════════════════════════════════════════════════════
-- 021 · BETA security: environment guard (ops_guard), fail-closed live operations,
--       direct-write revocation, closed sign-ups and integrity monitoring.
--
-- Layers (see docs/beta/BETA_SECURITY.md):
--   P1  preventive  no direct INSERT/UPDATE/DELETE/TRUNCATE on payments, payment_methods,
--                   payouts, wasl_sync_log for anon, authenticated or service_role. The
--                   privilege check runs before any trigger, so a disabled trigger cannot
--                   be exploited through the REST API. Legitimate writes go through
--                   SECURITY DEFINER functions owned by postgres.
--   P2  preventive  every sensitive writer calls ops_guard.assert_environment() first, and
--                   ops_guard.assert_live_allowed() before any non-mock (live) effect.
--   P3  preventive  guard triggers on the four tables, ENABLE ALWAYS (they also fire under
--                   session_replication_role = replica).
--   D1  detection   ops_guard.integrity_check() every minute (pg_cron when available).
--   D2  detection   /health returns 503 when the marker or the integrity check fails or is stale.
--   D3  detection   workers read public.ops_runtime_config() and refuse to run.
--   C*  compensating no live credentials in BETA (preflight + runtime), closed sign-ups,
--                   allowlisted testers, revoke_tester().
--
-- Live operations are allowed ONLY when the environment marker says production AND its
-- project ref equals ops_guard.prod_project_ref(). That function returns NULL until a
-- human verifies the production ref and ships a new migration, so after this migration
-- live operations are refused everywhere (fail closed). Mock providers keep working.
--
-- Operational prerequisite: the environment marker must be inserted (as postgres) with
-- ops_guard.set_environment() right after this migration, or every financial and Wasl
-- operation and every sign-up is refused.
-- ═══════════════════════════════════════════════════════════════════════════

-- The role Supabase Auth uses to call hooks. Present on Supabase; created only where missing
-- (local tests) so the grants below are valid everywhere.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    create role supabase_auth_admin nologin noinherit;
  end if;
end $$;

create schema if not exists ops_guard;
revoke all on schema ops_guard from public, anon, authenticated, service_role;
grant usage on schema ops_guard to supabase_auth_admin;

-- ── Environment marker (single, immutable row) ───────────────────────────────
create table ops_guard.environment (
  id          boolean primary key default true check (id),
  mode        text not null check (mode in ('production', 'beta')),
  project_ref text not null check (project_ref ~ '^[a-z0-9]{20}$'),
  digest      text not null,
  created_at  timestamptz not null default now()
);

-- Allowlisted identities (normalised phone digits, or lower-case e-mail) for a BETA project.
create table ops_guard.allowlist (
  identity   text primary key check (identity ~ '^([0-9]{8,15}|[^@\s]+@[^@\s]+)$'),
  note       text check (char_length(note) <= 200),
  added_at   timestamptz not null default now()
);

-- Who changed the allowlist (append-only).
create table ops_guard.allowlist_log (
  id         bigint generated always as identity primary key,
  identity   text not null,
  action     text not null check (action in ('allow', 'revoke')),
  actor      text not null default current_user,
  created_at timestamptz not null default now()
);

-- Latest integrity result (single row) and the append-only history used for alerting.
create table ops_guard.integrity_status (
  id         boolean primary key default true check (id),
  ok         boolean not null,
  failures   jsonb not null default '[]'::jsonb,
  checked_at timestamptz not null default now()
);
create table ops_guard.integrity_events (
  id         bigint generated always as identity primary key,
  ok         boolean not null,
  failures   jsonb not null,
  created_at timestamptz not null default now()
);

alter table ops_guard.environment      enable row level security;
alter table ops_guard.allowlist        enable row level security;
alter table ops_guard.allowlist_log    enable row level security;
alter table ops_guard.integrity_status enable row level security;
alter table ops_guard.integrity_events enable row level security;
revoke all on all tables in schema ops_guard from public, anon, authenticated, service_role, supabase_auth_admin;
revoke all on all sequences in schema ops_guard from public, anon, authenticated, service_role, supabase_auth_admin;
alter default privileges in schema ops_guard revoke all on tables from public, anon, authenticated, service_role;
alter default privileges in schema ops_guard revoke execute on functions from public;

create or replace function ops_guard.marker_digest(p_mode text, p_ref text)
returns text
language sql immutable
set search_path = ''
as $$ select md5('aura-ops-guard:v1:' || p_mode || ':' || p_ref) $$;

-- The marker never changes once written: no UPDATE, DELETE or TRUNCATE, even by postgres.
create or replace function ops_guard.environment_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'AURA_GUARD: the environment marker is immutable' using errcode = '42501';
end;
$$;
create trigger environment_no_update before update or delete on ops_guard.environment
  for each row execute function ops_guard.environment_immutable();
create trigger environment_no_truncate before truncate on ops_guard.environment
  for each statement execute function ops_guard.environment_immutable();
alter table ops_guard.environment enable always trigger environment_no_update;
alter table ops_guard.environment enable always trigger environment_no_truncate;

create or replace function ops_guard.history_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'AURA_GUARD: integrity history is append-only' using errcode = '42501';
end;
$$;
create trigger allowlist_log_append_only before update or delete on ops_guard.allowlist_log
  for each row execute function ops_guard.history_append_only();
create trigger allowlist_log_no_truncate before truncate on ops_guard.allowlist_log
  for each statement execute function ops_guard.history_append_only();
alter table ops_guard.allowlist_log enable always trigger allowlist_log_append_only;
alter table ops_guard.allowlist_log enable always trigger allowlist_log_no_truncate;

-- The allowlist changes only through allow_tester() / revoke_tester(), which set a
-- transaction-local flag and leave a log row; anything else (including a stray UPDATE by
-- the owner) is refused, and TRUNCATE always is.
create or replace function ops_guard.allowlist_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'TRUNCATE' or coalesce(current_setting('ops_guard.allowlist_write', true), '') <> 'on' then
    raise exception 'AURA_GUARD: the allowlist changes only through allow_tester() / revoke_tester()' using errcode = '42501';
  end if;
  return coalesce(new, old);
end;
$$;
create trigger allowlist_guarded before insert or update or delete on ops_guard.allowlist
  for each row execute function ops_guard.allowlist_guard();
create trigger allowlist_no_truncate before truncate on ops_guard.allowlist
  for each statement execute function ops_guard.allowlist_guard();
alter table ops_guard.allowlist enable always trigger allowlist_guarded;
alter table ops_guard.allowlist enable always trigger allowlist_no_truncate;

create trigger integrity_events_append_only before update or delete on ops_guard.integrity_events
  for each row execute function ops_guard.history_append_only();
create trigger integrity_events_no_truncate before truncate on ops_guard.integrity_events
  for each statement execute function ops_guard.history_append_only();
alter table ops_guard.integrity_events enable always trigger integrity_events_append_only;
alter table ops_guard.integrity_events enable always trigger integrity_events_no_truncate;

-- ── Production binding ───────────────────────────────────────────────────────
-- UNVERIFIED on purpose: NULL means "no project is production", so live operations are
-- refused everywhere. Replace in a NEW migration only after a human confirms the ref in the
-- Supabase dashboard; the Edge constant PROD_PROJECT_REF (_shared/ops/runtimeGuard.ts) must match.
create or replace function ops_guard.prod_project_ref()
returns text
language sql immutable
set search_path = ''
as $$ select null::text $$;

-- Writes the marker once (postgres only: run it in the SQL editor of the right project).
create or replace function ops_guard.set_environment(p_mode text, p_project_ref text)
returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  if p_mode = 'production' and p_project_ref is distinct from ops_guard.prod_project_ref() then
    raise exception 'AURA_GUARD: production mode requires the verified production project ref' using errcode = '42501';
  end if;
  insert into ops_guard.environment (mode, project_ref, digest)
  values (p_mode, p_project_ref, ops_guard.marker_digest(p_mode, p_project_ref));
end;
$$;

-- 'ok' | 'missing' | 'corrupt' (digest mismatch, unknown mode, more than one row).
create or replace function ops_guard.marker_state()
returns text
language plpgsql stable security definer
set search_path = ''
as $$
declare
  e ops_guard.environment;
  n integer;
begin
  select count(*) into n from ops_guard.environment;
  if n = 0 then return 'missing'; end if;
  if n > 1 then return 'corrupt'; end if;
  select * into e from ops_guard.environment;
  if e.mode not in ('production', 'beta') or e.digest is distinct from ops_guard.marker_digest(e.mode, e.project_ref)
     or e.project_ref !~ '^[a-z0-9]{20}$' then
    return 'corrupt';
  end if;
  if e.mode = 'production' and e.project_ref is distinct from ops_guard.prod_project_ref() then
    return 'corrupt'; -- a production marker that is not bound to the verified ref
  end if;
  return 'ok';
end;
$$;

create or replace function ops_guard.current_mode()
returns text
language sql stable security definer
set search_path = ''
as $$
  select case when ops_guard.marker_state() = 'ok' then (select mode from ops_guard.environment) end
$$;

create or replace function ops_guard.integrity_fresh()
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select coalesce((select ok and checked_at > now() - interval '3 minutes' from ops_guard.integrity_status), false)
$$;

-- Live (non-mock) operations: production marker, bound to the verified ref, fresh integrity.
create or replace function ops_guard.live_allowed()
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select ops_guard.marker_state() = 'ok'
     and ops_guard.prod_project_ref() is not null
     and exists (select 1 from ops_guard.environment where mode = 'production' and project_ref = ops_guard.prod_project_ref())
     and ops_guard.integrity_fresh()
$$;

-- Any sensitive write: the marker must be valid and the last integrity check must not have failed.
create or replace function ops_guard.assert_environment(p_operation text)
returns void
language plpgsql stable security definer
set search_path = ''
as $$
declare
  s text := ops_guard.marker_state();
begin
  if s <> 'ok' then
    raise exception 'AURA_GUARD: environment marker %, % refused', s, p_operation using errcode = '42501';
  end if;
  if exists (select 1 from ops_guard.integrity_status where not ok) then
    raise exception 'AURA_GUARD: integrity check failed, % refused', p_operation using errcode = '42501';
  end if;
end;
$$;

create or replace function ops_guard.assert_live_allowed(p_operation text)
returns void
language plpgsql stable security definer
set search_path = ''
as $$
begin
  perform ops_guard.assert_environment(p_operation);
  if not ops_guard.live_allowed() then
    raise exception 'AURA_GUARD: live operations are not allowed in this environment (%)', p_operation using errcode = '42501';
  end if;
end;
$$;

-- ── Runtime configuration for the Edge Functions (D3) ────────────────────────
create or replace function ops_guard.runtime_config()
returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'marker_state', ops_guard.marker_state(),
    'mode', ops_guard.current_mode(),
    'project_ref', (select project_ref from ops_guard.environment limit 1),
    'prod_project_ref', ops_guard.prod_project_ref(),
    'live_allowed', ops_guard.live_allowed(),
    'integrity_ok', (select ok from ops_guard.integrity_status),
    'integrity_checked_at', (select checked_at from ops_guard.integrity_status))
$$;

-- PostgREST only exposes public: a thin wrapper, service_role only.
create or replace function public.ops_runtime_config()
returns jsonb
language sql stable security definer
set search_path = ''
as $$ select ops_guard.runtime_config() $$;

-- ── Sign-ups and tester access (C3) ─────────────────────────────────────────
create or replace function ops_guard.normalize_identity(p_phone text, p_email text)
returns text
language sql immutable
set search_path = ''
as $$
  select coalesce(nullif(regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g'), ''), nullif(lower(trim(p_email)), ''))
$$;

-- Fail closed: no valid marker → nobody; production → everybody; beta → allowlist only.
create or replace function ops_guard.signup_allowed(p_phone text, p_email text)
returns boolean
language plpgsql stable security definer
set search_path = ''
as $$
declare
  m text := ops_guard.current_mode();
  i text := ops_guard.normalize_identity(p_phone, p_email);
begin
  if m is null then return false; end if;
  if m = 'production' then return true; end if;
  return i is not null and (
    exists (select 1 from ops_guard.allowlist where identity = i)
    or exists (select 1 from ops_guard.allowlist where identity = lower(trim(p_email))));
end;
$$;

-- A user may get or refresh a token: production → not blocked; beta → allowlisted and not blocked.
create or replace function ops_guard.session_allowed(p_user_id uuid)
returns boolean
language plpgsql stable security definer
set search_path = ''
as $$
declare
  m text := ops_guard.current_mode();
  u record;
begin
  if m is null or p_user_id is null then return false; end if;
  if exists (select 1 from public.profiles where id = p_user_id and is_blocked) then return false; end if;
  if m = 'production' then return true; end if;
  select phone, email into u from auth.users where id = p_user_id;
  if not found then return false; end if;
  return ops_guard.signup_allowed(u.phone, u.email);
end;
$$;

-- Supabase Auth hook "Before User Created" (Dashboard → Authentication → Hooks).
create or replace function ops_guard.hook_before_user_created(event jsonb)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if ops_guard.signup_allowed(event -> 'user' ->> 'phone', event -> 'user' ->> 'email') then
    return '{}'::jsonb;
  end if;
  return jsonb_build_object('error', jsonb_build_object('http_code', 403, 'message', 'Sign-ups are closed'));
end;
$$;

-- Supabase Auth hook "Custom Access Token": runs at sign-in AND at every token refresh, so a
-- revoked tester loses access at the next refresh (≤ JWT expiry).
create or replace function ops_guard.hook_custom_access_token(event jsonb)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if ops_guard.session_allowed(nullif(event ->> 'user_id', '')::uuid) then
    return jsonb_build_object('claims', event -> 'claims');
  end if;
  return jsonb_build_object('error', jsonb_build_object('http_code', 403, 'message', 'Access is closed for this account'));
end;
$$;

-- Backup for the hook: refuse the row itself (fires for GoTrue, the Admin API and SQL).
create or replace function ops_guard.auth_users_gate()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if not ops_guard.signup_allowed(new.phone, new.email) then
    raise exception 'AURA_GUARD: sign-ups are closed in this environment' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger aa_ops_guard_signup before insert on auth.users
  for each row execute function ops_guard.auth_users_gate();
-- ENABLE ALWAYS needs ownership of auth.users, which postgres may not have on Supabase
-- (UNVERIFIED): try it, otherwise keep the trigger enabled in the normal mode.
do $$
begin
  alter table auth.users enable always trigger aa_ops_guard_signup;
exception when insufficient_privilege then
  raise notice 'AURA_GUARD: auth.users trigger left in ENABLE (origin) mode: not the table owner';
end $$;

-- Operator helpers (postgres only: SQL editor).
create or replace function ops_guard.allow_tester(p_identity text, p_note text default null)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  i text := ops_guard.normalize_identity(case when p_identity like '%@%' then null else p_identity end,
                                         case when p_identity like '%@%' then p_identity end);
begin
  perform set_config('ops_guard.allowlist_write', 'on', true);
  insert into ops_guard.allowlist (identity, note) values (i, p_note)
  on conflict (identity) do update set note = excluded.note;
  insert into ops_guard.allowlist_log (identity, action) values (i, 'allow');
  perform set_config('ops_guard.allowlist_write', 'off', true);
end;
$$;

-- Revoke a tester: allowlist removal + block the profile + end every session and refresh
-- token. The Auth ban (Admin API, ban_duration) is a separate manual step: see BETA_SECURITY.md.
create or replace function ops_guard.revoke_tester(p_identity text)
returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  i   text := ops_guard.normalize_identity(case when p_identity like '%@%' then null else p_identity end,
                                           case when p_identity like '%@%' then p_identity end);
  ids uuid[];
begin
  perform set_config('ops_guard.allowlist_write', 'on', true);
  delete from ops_guard.allowlist where identity = i;
  insert into ops_guard.allowlist_log (identity, action) values (i, 'revoke');
  perform set_config('ops_guard.allowlist_write', 'off', true);
  select array_agg(id) into ids from auth.users
   where ops_guard.normalize_identity(phone, null) = i or lower(email) = i;
  if ids is null then return 0; end if;
  update public.profiles set is_blocked = true where id = any (ids);
  if to_regclass('auth.refresh_tokens') is not null then
    execute 'delete from auth.refresh_tokens where user_id in (select unnest($1)::text)' using ids;
  end if;
  if to_regclass('auth.sessions') is not null then
    execute 'delete from auth.sessions where user_id = any ($1)' using ids;
  end if;
  return coalesce(array_length(ids, 1), 0);
end;
$$;

-- ── P3: guard triggers (ENABLE ALWAYS) ──────────────────────────────────────
create or replace function ops_guard.guard_write()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_live boolean;
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'AURA_GUARD: TRUNCATE is not allowed on %', tg_table_name using errcode = '42501';
  end if;
  perform ops_guard.assert_environment(tg_table_name || '.' || lower(tg_op));
  v_live := case tg_table_name
    when 'payments'        then new.provider::text in ('moyasar', 'hyperpay')
    when 'payment_methods' then new.provider::text in ('moyasar', 'hyperpay')
    when 'payouts'         then new.provider <> 'mock'
    when 'wasl_sync_log'   then new.provider <> 'mock'
    else true end;
  if v_live then
    perform ops_guard.assert_live_allowed(tg_table_name || '.' || lower(tg_op));
  end if;
  return new;
end;
$$;

do $$
declare
  t text;
begin
  foreach t in array array['payments', 'payment_methods', 'payouts', 'wasl_sync_log'] loop
    execute format('create trigger aa_ops_guard_write before insert or update on public.%I for each row execute function ops_guard.guard_write()', t);
    execute format('create trigger aa_ops_guard_truncate before truncate on public.%I for each statement execute function ops_guard.guard_write()', t);
    execute format('alter table public.%I enable always trigger aa_ops_guard_write', t);
    execute format('alter table public.%I enable always trigger aa_ops_guard_truncate', t);
  end loop;
end $$;

-- ── P1: no direct writes (the privilege check precedes every trigger) ───────
-- REFERENCES and TRIGGER too: an API role must not be able to attach its own trigger or FK.
revoke insert, update, delete, truncate, references, trigger on public.payments, public.payment_methods, public.payouts, public.wasl_sync_log
  from public, anon, authenticated, service_role;

-- ── P2: sensitive writers check the environment first ───────────────────────
-- Generated from the latest earlier definitions (pg_get_functiondef); only the guard lines
-- after "begin" are new. Grants and ownership are kept by CREATE OR REPLACE.

-- create_payment_intent: unchanged body from the latest definition, with the P2 guard first.
CREATE OR REPLACE FUNCTION public.create_payment_intent(p_rider_id uuid, p_kind payment_kind, p_ride_id uuid, p_amount_halalas bigint, p_method_type payment_method_type, p_provider payment_provider, p_payment_method_id uuid DEFAULT NULL::uuid)
 RETURNS payments
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  r       public.rides;
  v       public.payments;
  v_amt   bigint := p_amount_halalas;
  v_bal   bigint;
begin
  -- P2 (migration 021): environment check before any write or external effect.
  perform ops_guard.assert_environment('create_payment_intent');
  if p_provider <> 'mock' then perform ops_guard.assert_live_allowed('payments.create_payment_intent'); end if;
  if p_kind not in ('charge', 'tip', 'wallet_topup') then
    raise exception 'AURA: unsupported payment kind %', p_kind using errcode = '22023';
  end if;
  if p_provider not in ('moyasar', 'hyperpay', 'mock') or not private.is_card_method(p_method_type) then
    raise exception 'AURA: card payments only' using errcode = '22023';
  end if;
  if exists (select 1 from public.profiles where id = p_rider_id and is_blocked) then
    raise exception 'AURA: account is blocked' using errcode = '42501';
  end if;
  if p_payment_method_id is not null and not exists (
       select 1 from public.payment_methods m where m.id = p_payment_method_id and m.rider_id = p_rider_id and m.deleted_at is null) then
    raise exception 'AURA: payment method not found' using errcode = 'P0002';
  end if;

  if p_kind = 'charge' then
    select * into r from public.rides where id = p_ride_id for update;
    if not found or r.rider_id <> p_rider_id then
      raise exception 'AURA: not your ride' using errcode = '42501';
    end if;
    if r.status <> 'searching' or not private.is_card_method(r.payment_method) then
      raise exception 'AURA: ride is not awaiting card payment' using errcode = '55000';
    end if;
    if v_amt is not null and v_amt <> r.fare_total_halalas then
      raise exception 'AURA: amount does not match the fare' using errcode = '23514';
    end if;
    v_amt := r.fare_total_halalas; -- the server price, never the client's
    select * into v from public.payments
     where ride_id = r.id and kind = 'charge' and status in ('initiated', 'authorized', 'paid');
    if found then
      return v; -- idempotent retry
    end if;
  elsif p_kind = 'tip' then
    r := private.assert_tip_allowed(p_ride_id, p_rider_id, v_amt);
  else
    if p_ride_id is not null then
      raise exception 'AURA: top-ups are not linked to rides' using errcode = '22023';
    end if;
    if v_amt is null or v_amt < private.money_limit('topup_min') or v_amt > private.money_limit('topup_max') then
      raise exception 'AURA: top-up must be between % and % halalas', private.money_limit('topup_min'),
        private.money_limit('topup_max') using errcode = '22023';
    end if;
    select balance_halalas into v_bal from public.wallet_accounts where account_type = 'rider_wallet' and owner_id = p_rider_id;
    if coalesce(v_bal, 0) + v_amt > private.money_limit('wallet_max') then
      raise exception 'AURA: wallet limit exceeded' using errcode = '23514';
    end if;
  end if;

  insert into public.payments (kind, rider_id, ride_id, provider, method_type, payment_method_id, amount_halalas, idempotency_key)
  values (p_kind, p_rider_id, case when p_kind = 'wallet_topup' then null else p_ride_id end, p_provider, p_method_type,
          p_payment_method_id, v_amt,
          case p_kind when 'charge' then 'charge:' || p_ride_id
                      when 'tip' then 'tip:' || p_ride_id || ':' || gen_random_uuid()
                      else 'topup:' || gen_random_uuid() end)
  returning * into v;
  return v;
end;
$function$;

-- record_provider_payment: unchanged body from the latest definition, with the P2 guard first.
CREATE OR REPLACE FUNCTION public.record_provider_payment(p_payment_id uuid, p_status payment_status, p_provider_payment_id text DEFAULT NULL::text, p_amount_halalas bigint DEFAULT NULL::bigint, p_failure_code text DEFAULT NULL::text, p_failure_message text DEFAULT NULL::text, p_raw jsonb DEFAULT NULL::jsonb)
 RETURNS payments
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v        public.payments;
  v_parent public.payments;
  r        public.rides;
  v_status public.payment_status := p_status;
  v_code   text := p_failure_code;
  tx       uuid := gen_random_uuid();
begin
  -- P2 (migration 021): environment check before any write or external effect.
  perform ops_guard.assert_environment('record_provider_payment');
  if exists (select 1 from public.payments where id = p_payment_id and provider <> 'mock') then perform ops_guard.assert_live_allowed('payments.record_provider_payment'); end if;
  select * into v from public.payments where id = p_payment_id for update;
  if not found then
    raise exception 'AURA: payment not found' using errcode = 'P0002';
  end if;
  if p_provider_payment_id is not null and v.provider_payment_id is not null and v.provider_payment_id <> p_provider_payment_id then
    raise exception 'AURA: provider reference mismatch' using errcode = '23514';
  end if;
  -- The provider must confirm exactly the amount we asked for.
  if v_status in ('authorized', 'paid') and p_amount_halalas is distinct from v.amount_halalas::bigint then
    v_status := 'failed';
    v_code := 'amount_mismatch';
  end if;
  if v.status = v_status then
    return v;
  end if;
  if not ((v.status = 'initiated' and v_status in ('authorized', 'paid', 'failed', 'voided'))
       or (v.status = 'authorized' and v_status in ('paid', 'failed', 'voided'))) then
    return v; -- late or out-of-order event
  end if;

  update public.payments
     set status = v_status,
         provider_payment_id = coalesce(provider_payment_id, p_provider_payment_id),
         failure_code = case when v_status = 'failed' then left(v_code, 100) end,
         failure_message = case when v_status = 'failed' then left(p_failure_message, 500) end,
         metadata = metadata || jsonb_build_object('last_event', coalesce(p_raw, '{}'::jsonb), 'last_event_at', now())
   where id = v.id
  returning * into v;

  if v.kind = 'charge' then
    select * into r from public.rides where id = v.ride_id for update;
    if v.status in ('authorized', 'paid') and r.status = 'searching' then
      perform public.dispatch_ride(r.id);
    end if;
    if v.status = 'paid' and r.status = 'completed' and r.settled_at is null then
      perform public.settle_ride(r.id);
    end if;
    if v.status in ('failed', 'voided') and r.status = 'searching' then
      perform set_config('aura.actor', 'system', true);
      update public.rides set status = 'cancelled', cancellation_reason = 'payment_failed' where id = r.id;
      perform set_config('aura.actor', '', true);
    end if;
  elsif v.kind = 'tip' and v.status = 'paid' then
    select * into r from public.rides where id = v.ride_id for update;
    perform private.post_entry(tx, private.platform_account('gateway_clearing'), 'tip', -v.amount_halalas, r.id, v.id, null, 'Card tip');
    perform private.post_entry(tx, private.owner_account('driver_wallet', r.driver_id), 'tip', v.amount_halalas, r.id, v.id, null, 'Tip from rider');
    update public.rides set tip_halalas = tip_halalas + v.amount_halalas where id = r.id;
  elsif v.kind = 'wallet_topup' and v.status = 'paid' then
    perform private.post_entry(tx, private.platform_account('gateway_clearing'), 'wallet_topup', -v.amount_halalas, null, v.id, null, 'Card top-up');
    perform private.post_entry(tx, private.owner_account('rider_wallet', v.rider_id), 'wallet_topup', v.amount_halalas, null, v.id, null, 'Wallet top-up');
  elsif v.kind = 'refund' and v.status = 'paid' then
    select * into v_parent from public.payments where id = v.parent_payment_id;
    -- Money goes back to the card. Top-up refunds come out of the wallet; ride/tip
    -- refunds are a platform cost (commission and captain earnings are unchanged).
    perform private.post_entry(tx, private.platform_account('gateway_clearing'), 'refund', v.amount_halalas, v_parent.ride_id, v.id, null, 'Refund to card');
    perform private.post_entry(tx,
      case when v_parent.kind = 'wallet_topup' then private.owner_account('rider_wallet', v.rider_id)
           else private.platform_account('adjustments') end,
      'refund', -v.amount_halalas, v_parent.ride_id, v.id, null, 'Refund to card');
  end if;
  return v;
end;
$function$;

-- save_payment_method: unchanged body from the latest definition, with the P2 guard first.
CREATE OR REPLACE FUNCTION public.save_payment_method(p_rider_id uuid, p_provider payment_provider, p_method_type payment_method_type, p_token text, p_brand text, p_last4 text, p_exp_month integer, p_exp_year integer, p_holder text DEFAULT NULL::text)
 RETURNS payment_methods
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v public.payment_methods;
  v_first boolean := not exists (select 1 from public.payment_methods where rider_id = p_rider_id and deleted_at is null);
begin
  -- P2 (migration 021): environment check before any write or external effect.
  perform ops_guard.assert_environment('save_payment_method');
  if p_provider <> 'mock' then perform ops_guard.assert_live_allowed('payments.save_payment_method'); end if;
  insert into public.payment_methods (rider_id, provider, method_type, brand, last4, exp_month, exp_year, holder_name, is_default)
  values (p_rider_id, p_provider, p_method_type, left(p_brand, 20), p_last4, p_exp_month, p_exp_year, left(p_holder, 120), v_first)
  returning * into v;
  insert into private.payment_tokens (payment_method_id, provider_token) values (v.id, p_token);
  if v_first then
    update public.riders set default_payment_method_id = v.id where id = p_rider_id;
  end if;
  return v;
end;
$function$;

-- admin_refund_payment: unchanged body from the latest definition, with the P2 guard first.
CREATE OR REPLACE FUNCTION public.admin_refund_payment(p_payment_id uuid, p_amount_halalas bigint, p_reason text)
 RETURNS payments
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  p public.payments;
  v public.payments;
begin
  -- P2 (migration 021): environment check before any write or external effect.
  perform ops_guard.assert_environment('admin_refund_payment');
  if exists (select 1 from public.payments where id = p_payment_id and provider <> 'mock') then perform ops_guard.assert_live_allowed('payments.admin_refund_payment'); end if;
  if not private.admin_can('finance.settle') then
    raise exception 'AURA: permission finance.settle required' using errcode = '42501';
  end if;
  if nullif(trim(p_reason), '') is null then
    raise exception 'AURA: a reason is required' using errcode = '23502';
  end if;
  select * into p from public.payments where id = p_payment_id;
  if not found or p.kind = 'refund' or p.provider not in ('moyasar', 'hyperpay', 'mock') then
    raise exception 'AURA: only card payments can be refunded to the card' using errcode = '22023';
  end if;
  perform set_config('aura.reason', p_reason, true);
  insert into public.payments (kind, parent_payment_id, rider_id, ride_id, provider, method_type, amount_halalas, idempotency_key, metadata)
  values ('refund', p.id, p.rider_id, p.ride_id, p.provider, p.method_type, p_amount_halalas,
          'refund:' || gen_random_uuid(), jsonb_build_object('reason', left(p_reason, 500), 'by', (select auth.uid())))
  returning * into v;
  return v;
end;
$function$;

-- remove_payment_method: unchanged body from the latest definition, with the P2 guard first.
CREATE OR REPLACE FUNCTION public.remove_payment_method(p_payment_method_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid uuid := (select auth.uid());
begin
  -- P2 (migration 021): environment check before any write or external effect.
  perform ops_guard.assert_environment('remove_payment_method');
  update public.payment_methods set deleted_at = now(), is_default = false
   where id = p_payment_method_id and rider_id = v_uid and deleted_at is null;
  if not found then
    raise exception 'AURA: payment method not found' using errcode = 'P0002';
  end if;
  update public.riders set default_payment_method_id = null
   where id = v_uid and default_payment_method_id = p_payment_method_id;
  delete from private.payment_tokens where payment_method_id = p_payment_method_id;
end;
$function$;

-- set_default_payment_method: unchanged body from the latest definition, with the P2 guard first.
CREATE OR REPLACE FUNCTION public.set_default_payment_method(p_payment_method_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid uuid := (select auth.uid());
begin
  -- P2 (migration 021): environment check before any write or external effect.
  perform ops_guard.assert_environment('set_default_payment_method');
  if not exists (select 1 from public.payment_methods
                  where id = p_payment_method_id and rider_id = v_uid and deleted_at is null) then
    raise exception 'AURA: payment method not found' using errcode = 'P0002';
  end if;
  update public.payment_methods set is_default = false where rider_id = v_uid and is_default;
  update public.payment_methods set is_default = true where id = p_payment_method_id;
  update public.riders set default_payment_method_id = p_payment_method_id where id = v_uid;
end;
$function$;

-- request_payout: unchanged body from the latest definition, with the P2 guard first.
CREATE OR REPLACE FUNCTION public.request_payout(p_amount_halalas integer)
 RETURNS payouts
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  d         public.drivers;
  v_balance bigint;
  v         public.payouts;
begin
  -- P2 (migration 021): environment check before any write or external effect.
  perform ops_guard.assert_environment('request_payout');
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
$function$;

-- create_payout_batch: unchanged body from the latest definition, with the P2 guard first.
CREATE OR REPLACE FUNCTION public.create_payout_batch(p_min_halalas bigint DEFAULT NULL::bigint)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  d   record;
  n   integer := 0;
  v_min bigint := coalesce(p_min_halalas, private.money_limit('payout_min'));
begin
  -- P2 (migration 021): environment check before any write or external effect.
  perform ops_guard.assert_environment('create_payout_batch');
  if (select auth.uid()) is not null and not private.admin_can('finance.settle') then
    raise exception 'AURA: permission finance.settle required' using errcode = '42501';
  end if;
  for d in
    select dr.id, dr.iban, a.balance_halalas
      from public.drivers dr
      join public.wallet_accounts a on a.owner_id = dr.id and a.account_type = 'driver_wallet'
      join public.profiles p on p.id = dr.id and not p.is_blocked
     where dr.status = 'approved' and dr.iban is not null and a.balance_halalas >= v_min
       and not exists (select 1 from public.payouts o where o.driver_id = dr.id and o.status in ('pending', 'approved', 'processing'))
  loop
    insert into public.payouts (driver_id, amount_halalas, iban, idempotency_key)
    values (d.id, d.balance_halalas, d.iban, 'batch:' || d.id || ':' || to_char(now(), 'YYYYMMDD'));
    n := n + 1;
  end loop;
  return n;
end;
$function$;

-- admin_set_payout_status: unchanged body from the latest definition, with the P2 guard first.
CREATE OR REPLACE FUNCTION public.admin_set_payout_status(p_payout_id uuid, p_status payout_status, p_reason text DEFAULT NULL::text)
 RETURNS payouts
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v public.payouts;
begin
  -- P2 (migration 021): environment check before any write or external effect.
  perform ops_guard.assert_environment('admin_set_payout_status');
  if exists (select 1 from public.payouts where id = p_payout_id and provider <> 'mock') then perform ops_guard.assert_live_allowed('payouts.admin_set_payout_status'); end if;
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
$function$;

-- complete_payout: unchanged body from the latest definition, with the P2 guard first.
CREATE OR REPLACE FUNCTION public.complete_payout(p_payout_id uuid, p_success boolean, p_provider_payout_id text DEFAULT NULL::text, p_failure_reason text DEFAULT NULL::text)
 RETURNS payouts
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v  public.payouts;
  tx uuid := gen_random_uuid();
begin
  -- P2 (migration 021): environment check before any write or external effect.
  perform ops_guard.assert_environment('complete_payout');
  if exists (select 1 from public.payouts where id = p_payout_id and provider <> 'mock') then perform ops_guard.assert_live_allowed('payouts.complete_payout'); end if;
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
$function$;

-- record_wasl_result: unchanged body from the latest definition, with the P2 guard first.
CREATE OR REPLACE FUNCTION public.record_wasl_result(p_entity wasl_entity, p_entity_id uuid, p_operation text, p_provider text, p_success boolean, p_reference text DEFAULT NULL::text, p_request jsonb DEFAULT NULL::jsonb, p_response jsonb DEFAULT NULL::jsonb, p_error text DEFAULT NULL::text)
 RETURNS wasl_sync_log
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_log     public.wasl_sync_log;
  v_attempt integer;
  v_status  public.wasl_status := case when p_success then 'eligible' when p_error is not null then 'error' else 'ineligible' end;
begin
  -- P2 (migration 021): environment check before any write or external effect.
  perform ops_guard.assert_environment('record_wasl_result');
  if p_provider <> 'mock' then perform ops_guard.assert_live_allowed('wasl.record_wasl_result'); end if;
  select case when w.status = 'failed' then w.attempt + 1 else 1 end into v_attempt
    from public.wasl_sync_log w
   where w.entity_type = p_entity and w.entity_id = p_entity_id and w.operation = p_operation
   order by w.created_at desc limit 1;
  v_attempt := least(coalesce(v_attempt, 1), 20);

  insert into public.wasl_sync_log (entity_type, entity_id, operation, provider, status, attempt,
                                    request_payload, response_payload, error_message, next_retry_at, completed_at)
  values (p_entity, p_entity_id, p_operation, p_provider,
          case when p_success then 'success' else 'failed' end::public.sync_status, v_attempt,
          p_request, p_response, left(p_error, 1000),
          case when not p_success and p_error is not null
               then now() + make_interval(mins => least((2 ^ v_attempt)::integer, 1440)) end,
          now())
  returning * into v_log;

  if p_entity = 'driver' then
    perform set_config('aura.reason', 'Wasl ' || p_operation || ': ' || v_status, true);
    update public.drivers
       set wasl_status = case when v_status = 'error' and wasl_status = 'eligible' then wasl_status else v_status end,
           wasl_reference = coalesce(p_reference, wasl_reference),
           wasl_checked_at = case when v_status = 'error' then wasl_checked_at else now() end,
           status = case when v_status = 'ineligible' and status = 'approved' then 'suspended' else status end,
           status_reason = case when v_status = 'ineligible' and status = 'approved' then 'Wasl eligibility failed' else status_reason end
     where id = p_entity_id;
  elsif p_entity = 'vehicle' then
    update public.vehicles
       set wasl_status = case when v_status = 'error' and wasl_status = 'eligible' then wasl_status else v_status end,
           wasl_reference = coalesce(p_reference, wasl_reference),
           wasl_checked_at = case when v_status = 'error' then wasl_checked_at else now() end,
           status = case when v_status = 'ineligible' and status = 'approved' then 'inactive' else status end
     where id = p_entity_id;
    if v_status = 'ineligible' then
      update public.drivers set is_online = false where current_vehicle_id = p_entity_id and is_online;
    end if;
  elsif p_entity = 'ride' and p_success then
    if p_operation = 'trip_registration' then
      update public.rides set wasl_trip_reference = coalesce(p_reference, 'WASL-' || ride_number) where id = p_entity_id;
    elsif p_operation = 'trip_update' then
      update public.rides set wasl_reported_at = now() where id = p_entity_id;
    end if;
  end if;
  return v_log;
end;
$function$;

-- ── D1: integrity check ─────────────────────────────────────────────────────
-- Verifies that every preventive layer above is still in place, records the result and
-- appends a history row whenever the state changes (alert source). A failure makes
-- assert_environment() refuse every sensitive write and /health return 503.
create or replace function ops_guard.integrity_check()
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  f      jsonb := '[]'::jsonb;
  t      text;
  r      text;
  fn     text;
  priv   text;
  prev   boolean;
  v_ok   boolean;
  v_mode text := ops_guard.current_mode();
begin
  if ops_guard.marker_state() <> 'ok' then
    f := f || jsonb_build_array('marker_' || ops_guard.marker_state());
  end if;
  -- P3 + marker immutability triggers: present and ENABLE ALWAYS ('A').
  foreach t in array array['public.payments', 'public.payment_methods', 'public.payouts', 'public.wasl_sync_log'] loop
    foreach r in array array['aa_ops_guard_write', 'aa_ops_guard_truncate'] loop
      if not exists (select 1 from pg_trigger where tgrelid = t::regclass and tgname = r and tgenabled = 'A') then
        f := f || jsonb_build_array('trigger_not_always:' || t || '.' || r);
      end if;
    end loop;
    -- P1: no direct write privilege for API roles.
    foreach r in array array['anon', 'authenticated', 'service_role'] loop
      foreach priv in array array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] loop
        if has_table_privilege(r, t, priv) then
          f := f || jsonb_build_array('direct_write:' || r || ':' || priv || ':' || t);
        end if;
      end loop;
    end loop;
  end loop;
  foreach r in array array['environment_no_update', 'environment_no_truncate'] loop
    if not exists (select 1 from pg_trigger where tgrelid = 'ops_guard.environment'::regclass and tgname = r and tgenabled = 'A') then
      f := f || jsonb_build_array('trigger_not_always:ops_guard.environment.' || r);
    end if;
  end loop;
  foreach r in array array['allowlist_guarded', 'allowlist_no_truncate'] loop
    if not exists (select 1 from pg_trigger where tgrelid = 'ops_guard.allowlist'::regclass and tgname = r and tgenabled = 'A') then
      f := f || jsonb_build_array('trigger_not_always:ops_guard.allowlist.' || r);
    end if;
  end loop;
  if not exists (select 1 from pg_trigger where tgrelid = 'auth.users'::regclass and tgname = 'aa_ops_guard_signup' and tgenabled in ('O', 'A')) then
    f := f || jsonb_build_array('trigger_disabled:auth.users.aa_ops_guard_signup');
  end if;
  -- Guard tables: no API role may touch them.
  foreach t in array array['ops_guard.environment', 'ops_guard.allowlist', 'ops_guard.allowlist_log', 'ops_guard.integrity_status', 'ops_guard.integrity_events'] loop
    foreach r in array array['anon', 'authenticated', 'service_role'] loop
      if has_table_privilege(r, t, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') then
        f := f || jsonb_build_array('guard_table_privilege:' || r || ':' || t);
      end if;
    end loop;
  end loop;
  -- P2: every sensitive writer is still a postgres-owned SECURITY DEFINER calling the guard.
  foreach fn in array array['create_payment_intent', 'record_provider_payment', 'save_payment_method', 'admin_refund_payment',
                            'remove_payment_method', 'set_default_payment_method', 'request_payout', 'create_payout_batch',
                            'admin_set_payout_status', 'complete_payout', 'record_wasl_result'] loop
    if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname = 'public' and p.proname = fn and p.prosecdef
                      and p.prosrc like '%ops_guard.assert_environment%'
                      and p.proowner = (select nspowner from pg_namespace where nspname = 'ops_guard')) then
      f := f || jsonb_build_array('p2_missing:' || fn);
    end if;
  end loop;
  -- The production binding cannot be widened by anything but a reviewed migration.
  if v_mode = 'beta' and ops_guard.prod_project_ref() is not null
     and ops_guard.prod_project_ref() = (select project_ref from ops_guard.environment) then
    f := f || jsonb_build_array('beta_marker_on_production_ref');
  end if;
  -- BETA data: nothing live may exist, and every account must be allowlisted or blocked.
  if v_mode = 'beta' then
    if exists (select 1 from public.payments where provider::text in ('moyasar', 'hyperpay')) then
      f := f || jsonb_build_array('beta_live_payments');
    end if;
    if exists (select 1 from public.payment_methods where provider::text in ('moyasar', 'hyperpay')) then
      f := f || jsonb_build_array('beta_live_payment_methods');
    end if;
    if exists (select 1 from public.payouts where provider <> 'mock') then
      f := f || jsonb_build_array('beta_live_payouts');
    end if;
    if exists (select 1 from public.wasl_sync_log where provider <> 'mock') then
      f := f || jsonb_build_array('beta_live_wasl');
    end if;
    if exists (select 1 from auth.users u
                where not ops_guard.signup_allowed(u.phone, u.email)
                  and not exists (select 1 from public.profiles p where p.id = u.id and p.is_blocked)) then
      f := f || jsonb_build_array('beta_unlisted_accounts');
    end if;
  end if;

  v_ok := jsonb_array_length(f) = 0;
  select ok into prev from ops_guard.integrity_status;
  insert into ops_guard.integrity_status (id, ok, failures, checked_at) values (true, v_ok, f, now())
  on conflict (id) do update set ok = excluded.ok, failures = excluded.failures, checked_at = excluded.checked_at;
  if prev is distinct from v_ok or not v_ok then
    insert into ops_guard.integrity_events (ok, failures) values (v_ok, f);
  end if;
  if not v_ok then
    raise warning 'AURA_GUARD integrity failed: %', f;
  end if;
  return jsonb_build_object('ok', v_ok, 'failures', f);
end;
$$;

-- ── Grants (least privilege) ────────────────────────────────────────────────
revoke all on all functions in schema ops_guard from public, anon, authenticated, service_role;
revoke execute on function public.ops_runtime_config() from public, anon, authenticated;
grant execute on function public.ops_runtime_config() to service_role;
grant execute on function ops_guard.integrity_check() to service_role;
-- Fallback when pg_cron is unavailable: /health (with the health secret) runs the check.
create or replace function public.ops_integrity_check()
returns jsonb
language sql security definer
set search_path = ''
as $$ select ops_guard.integrity_check() $$;
revoke execute on function public.ops_integrity_check() from public, anon, authenticated;
grant execute on function public.ops_integrity_check() to service_role;
grant execute on function ops_guard.hook_before_user_created(jsonb), ops_guard.hook_custom_access_token(jsonb) to supabase_auth_admin;
-- The guard/hook functions are SECURITY DEFINER owned by postgres; ownership is asserted by
-- the integrity check (P2) and the database tests.

-- ── Schedule (D1) ───────────────────────────────────────────────────────────
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('aura-ops-guard-integrity', '* * * * *', 'select ops_guard.integrity_check()');
  end if;
end $$;
