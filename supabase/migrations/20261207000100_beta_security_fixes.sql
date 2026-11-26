-- ═══════════════════════════════════════════════════════════════════════════
-- 022 · BETA security fixes (review of 021: F1, F2, F4, F5). Forward-only: 021 is unchanged.
--
-- F1  Privacy must not be blocked by the money guard, and must not become a way around it.
--     The P3 trigger now recognises one narrow shape — a REDACTION — and lets it through even
--     with a missing / corrupt marker or a failed integrity check:
--       payment_methods : only deleted_at (null → set), is_default (→ false), holder_name (→ null)
--       wasl_sync_log   : only request_payload / response_payload (→ null)
--     Every other column must be byte-for-byte unchanged (provider, amounts, ids…), INSERTs are
--     never redactions, payments and payouts have no redaction shape at all. A redaction cannot
--     create a payment, a payout, a Wasl submission or any live effect. Who may run it is
--     unchanged: P1 still forbids direct writes, so only postgres-owned functions (erase_user,
--     redact_wasl_payloads via apply_retention) reach the trigger. Redactions done while the
--     environment is NOT healthy are recorded in ops_guard.guard_exemptions (audit).
-- F2  revoke_tester(): the allowlist removal and the block always happen; deleting
--     auth.sessions / auth.refresh_tokens is attempted separately and the outcome of each step
--     is returned and logged (ops_guard.revocation_log). It never claims a step that failed.
-- F4  Staff (e-mail) and testers (phone) share the allowlist; the integrity check also verifies
--     the new audit tables.
-- F5  integrity_events: one row per change of state or of the failure set (not per minute),
--     failing_since on the status row, and a retention rule (≥ 365 days, monthly purge).
--     allowlist_log, guard_exemptions and revocation_log are never purged (investigation trail).
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Audit tables (append-only, ALWAYS) ──────────────────────────────────────
create table ops_guard.guard_exemptions (
  id            bigint generated always as identity primary key,
  table_name    text not null,
  row_id        uuid,
  marker_state  text not null,
  integrity_ok  boolean,
  actor         text not null default current_user,
  created_at    timestamptz not null default now()
);
create table ops_guard.revocation_log (
  id                bigint generated always as identity primary key,
  identity          text not null,
  users             integer not null,
  allowlist_removed boolean not null,
  blocked           integer not null,
  sessions          text not null,
  refresh_tokens    text not null,
  actor             text not null default current_user,
  created_at        timestamptz not null default now()
);
alter table ops_guard.guard_exemptions enable row level security;
alter table ops_guard.revocation_log   enable row level security;
revoke all on ops_guard.guard_exemptions, ops_guard.revocation_log from public, anon, authenticated, service_role, supabase_auth_admin;

do $$
declare
  t text;
begin
  foreach t in array array['guard_exemptions', 'revocation_log'] loop
    execute format('create trigger %I before update or delete on ops_guard.%I for each row execute function ops_guard.history_append_only()', t || '_append_only', t);
    execute format('create trigger %I before truncate on ops_guard.%I for each statement execute function ops_guard.history_append_only()', t || '_no_truncate', t);
    execute format('alter table ops_guard.%I enable always trigger %I', t, t || '_append_only');
    execute format('alter table ops_guard.%I enable always trigger %I', t, t || '_no_truncate');
  end loop;
end $$;

-- ── F5: integrity history retention ─────────────────────────────────────────
alter table ops_guard.integrity_status add column failing_since timestamptz;

-- Rows may only be deleted by purge_integrity_events(), and only when older than 365 days.
create or replace function ops_guard.integrity_events_retention()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' and coalesce(current_setting('ops_guard.history_purge', true), '') = 'on'
     and old.created_at < now() - interval '365 days' then
    return old;
  end if;
  raise exception 'AURA_GUARD: integrity history is append-only (retention purge only, > 365 days)' using errcode = '42501';
end;
$$;
drop trigger integrity_events_append_only on ops_guard.integrity_events;
create trigger integrity_events_retention_only before update or delete on ops_guard.integrity_events
  for each row execute function ops_guard.integrity_events_retention();
alter table ops_guard.integrity_events enable always trigger integrity_events_retention_only;

create or replace function ops_guard.purge_integrity_events(p_keep_days integer default 400)
returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  n integer;
begin
  if p_keep_days is null or p_keep_days < 365 then
    raise exception 'AURA_GUARD: integrity history is kept at least 365 days' using errcode = '22023';
  end if;
  perform set_config('ops_guard.history_purge', 'on', true);
  delete from ops_guard.integrity_events where created_at < now() - make_interval(days => p_keep_days);
  get diagnostics n = row_count;
  perform set_config('ops_guard.history_purge', 'off', true);
  return n;
end;
$$;

-- ── F1: the redaction shape ─────────────────────────────────────────────────
create or replace function ops_guard.is_redaction(p_table text, p_old jsonb, p_new jsonb)
returns boolean
language sql immutable
set search_path = ''
as $$
  select case p_table
    when 'payment_methods' then
          (p_old - array['deleted_at', 'is_default', 'holder_name']) = (p_new - array['deleted_at', 'is_default', 'holder_name'])
      and (p_new -> 'deleted_at' = p_old -> 'deleted_at' or (p_old -> 'deleted_at' = 'null'::jsonb and p_new -> 'deleted_at' <> 'null'::jsonb))
      and (p_new -> 'is_default' = p_old -> 'is_default' or p_new -> 'is_default' = 'false'::jsonb)
      and (p_new -> 'holder_name' = p_old -> 'holder_name' or p_new -> 'holder_name' = 'null'::jsonb)
    when 'wasl_sync_log' then
          (p_old - array['request_payload', 'response_payload']) = (p_new - array['request_payload', 'response_payload'])
      and (p_new -> 'request_payload' = p_old -> 'request_payload' or p_new -> 'request_payload' = 'null'::jsonb)
      and (p_new -> 'response_payload' = p_old -> 'response_payload' or p_new -> 'response_payload' = 'null'::jsonb)
    else false
  end
$$;

create or replace function ops_guard.guard_write()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_live boolean;
  v_state text;
  v_integrity boolean;
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'AURA_GUARD: TRUNCATE is not allowed on %', tg_table_name using errcode = '42501';
  end if;
  -- F1: a pure redaction (privacy / retention) has no financial or Wasl effect; it is never refused.
  if tg_op = 'UPDATE' and ops_guard.is_redaction(tg_table_name, to_jsonb(old), to_jsonb(new)) then
    v_state := ops_guard.marker_state();
    select ok into v_integrity from ops_guard.integrity_status;
    if v_state <> 'ok' or v_integrity is false then
      insert into ops_guard.guard_exemptions (table_name, row_id, marker_state, integrity_ok)
      values (tg_table_name, (to_jsonb(new) ->> 'id')::uuid, v_state, v_integrity);
    end if;
    return new;
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

-- ── F2: revoke_tester reports every step ────────────────────────────────────
drop function ops_guard.revoke_tester(text);
create function ops_guard.revoke_tester(p_identity text)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  i         text := ops_guard.normalize_identity(case when p_identity like '%@%' then null else p_identity end,
                                                 case when p_identity like '%@%' then p_identity end);
  ids       uuid[];
  removed   boolean;
  blocked   integer := 0;
  sess      text := 'absent';
  tokens    text := 'absent';
  n         integer;
begin
  if i is null then
    raise exception 'AURA_GUARD: identity required' using errcode = '22023';
  end if;
  -- 1. Allowlist removal (always): sign-up and token issuance stop for this identity.
  perform set_config('ops_guard.allowlist_write', 'on', true);
  delete from ops_guard.allowlist where identity = i;
  removed := found;
  insert into ops_guard.allowlist_log (identity, action) values (i, 'revoke');
  perform set_config('ops_guard.allowlist_write', 'off', true);
  -- 2. Block (always): every sensitive RPC checks is_blocked, so it takes effect immediately.
  select array_agg(id) into ids from auth.users
   where ops_guard.normalize_identity(phone, null) = i or lower(email) = i;
  if ids is not null then
    update public.profiles set is_blocked = true, blocked_reason = coalesce(blocked_reason, 'beta_access_revoked')
     where id = any (ids) and not is_blocked;
    get diagnostics blocked = row_count;
    -- 3. Sessions and refresh tokens: best effort, each on its own (may lack privileges on Supabase).
    if to_regclass('auth.sessions') is not null then
      begin
        execute 'delete from auth.sessions where user_id = any ($1)' using ids;
        get diagnostics n = row_count;
        sess := 'deleted:' || n;
      exception when others then
        sess := 'failed:' || sqlstate;
      end;
    end if;
    if to_regclass('auth.refresh_tokens') is not null then
      begin
        execute 'delete from auth.refresh_tokens where user_id in (select unnest($1)::text)' using ids;
        get diagnostics n = row_count;
        tokens := 'deleted:' || n;
      exception when others then
        tokens := 'failed:' || sqlstate;
      end;
    end if;
  end if;
  insert into ops_guard.revocation_log (identity, users, allowlist_removed, blocked, sessions, refresh_tokens)
  values (i, coalesce(array_length(ids, 1), 0), removed, blocked, sess, tokens);
  return jsonb_build_object('identity', i, 'users', coalesce(array_length(ids, 1), 0), 'allowlist_removed', removed,
                            'blocked', blocked, 'sessions', sess, 'refresh_tokens', tokens,
                            'note', 'Access tokens already issued stay valid until they expire; ban the user with the Auth Admin API too.');
end;
$$;

-- ── F4 / F5: integrity check (same checks as 021, plus the audit tables; deduplicated history) ──
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
  prev_f jsonb;
  since  timestamptz;
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
  -- Audit trails: append-only triggers present and ENABLE ALWAYS.
  foreach t in array array['ops_guard.allowlist_log', 'ops_guard.integrity_events', 'ops_guard.guard_exemptions', 'ops_guard.revocation_log'] loop
    if (select count(*) from pg_trigger where tgrelid = t::regclass and tgenabled = 'A'
          and tgname in ('allowlist_log_append_only', 'allowlist_log_no_truncate', 'integrity_events_retention_only', 'integrity_events_no_truncate',
                         'guard_exemptions_append_only', 'guard_exemptions_no_truncate', 'revocation_log_append_only', 'revocation_log_no_truncate')) <> 2 then
      f := f || jsonb_build_array('audit_trigger_not_always:' || t);
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
  foreach t in array array['ops_guard.environment', 'ops_guard.allowlist', 'ops_guard.allowlist_log', 'ops_guard.integrity_status', 'ops_guard.integrity_events',
                             'ops_guard.guard_exemptions', 'ops_guard.revocation_log'] loop
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
  select ok, failures, failing_since into prev, prev_f, since from ops_guard.integrity_status;
  -- failing_since: when the current failure started (kept while it lasts, cleared on recovery).
  since := case when v_ok then null when prev is distinct from false then now() else coalesce(since, now()) end;
  insert into ops_guard.integrity_status (id, ok, failures, checked_at, failing_since) values (true, v_ok, f, now(), since)
  on conflict (id) do update set ok = excluded.ok, failures = excluded.failures, checked_at = excluded.checked_at,
                                 failing_since = excluded.failing_since;
  -- F5: one history row per change of state or of the set of failures, not one per minute.
  if prev is distinct from v_ok or (not v_ok and prev_f is distinct from f) then
    insert into ops_guard.integrity_events (ok, failures) values (v_ok, f);
  end if;
  if not v_ok then
    raise warning 'AURA_GUARD integrity failed: %', f;
  end if;
  return jsonb_build_object('ok', v_ok, 'failures', f, 'failing_since', since);
end;
$$;

-- ── Grants ──────────────────────────────────────────────────────────────────
revoke all on all functions in schema ops_guard from public, anon, authenticated, service_role;
grant execute on function ops_guard.integrity_check() to service_role;
grant execute on function ops_guard.hook_before_user_created(jsonb), ops_guard.hook_custom_access_token(jsonb) to supabase_auth_admin;

-- ── Schedule: monthly history purge (≥ 400 days kept) ───────────────────────
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('aura-ops-guard-history', '20 4 1 * *', 'select ops_guard.purge_integrity_events(400)');
  end if;
end $$;
