-- ============================================================================
-- AURA · 006 · Support tickets, audit log, Wasl sync log
-- Tables: 18 tickets · 19 ticket_messages · 20 audit_log · 21 wasl_sync_log
-- ============================================================================

-- 18 ─ tickets ───────────────────────────────────────────────────────────────
create table public.tickets (
  id            uuid primary key default gen_random_uuid(),
  ticket_number bigint generated always as identity unique,
  opened_by     uuid not null default auth.uid() references public.profiles (id) on delete restrict,
  opener_kind   public.message_author not null default 'rider' check (opener_kind in ('rider', 'driver')),
  ride_id       uuid references public.rides (id) on delete restrict,
  category      public.ticket_category not null,
  priority      public.ticket_priority not null default 'normal',
  status        public.ticket_status not null default 'open',
  subject       text not null check (char_length(subject) between 3 and 200),
  assigned_to   uuid references public.profiles (id) on delete set null,
  resolved_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint tickets_resolved_ts check (status <> 'resolved' or resolved_at is not null)
);
create index tickets_opened_by_ix on public.tickets (opened_by, created_at desc);
create index tickets_queue_ix     on public.tickets (status, priority, created_at) where status <> 'resolved';
create index tickets_ride_ix      on public.tickets (ride_id) where ride_id is not null;

create or replace function private.tickets_before_write()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.opener_kind := case
      when exists (select 1 from public.drivers d where d.id = new.opened_by) then 'driver'
      else 'rider' end::public.message_author;
    -- Safety reports are always urgent
    if new.category = 'safety' then new.priority := 'urgent'; end if;
    if (select auth.uid()) is not null and not private.is_admin() then
      new.status := 'open';
      new.assigned_to := null;
    end if;
  else
    new.updated_at := now();
  end if;
  if new.status = 'resolved' and new.resolved_at is null then new.resolved_at := now(); end if;
  if new.status <> 'resolved' then new.resolved_at := null; end if;
  return new;
end;
$$;
create trigger tickets_before_write before insert or update on public.tickets
  for each row execute function private.tickets_before_write();

-- 19 ─ ticket_messages ────────────────────────────────────────────────────────
create table public.ticket_messages (
  id          uuid primary key default gen_random_uuid(),
  ticket_id   uuid not null references public.tickets (id) on delete cascade,
  author_id   uuid default auth.uid() references public.profiles (id) on delete set null,
  author_kind public.message_author not null default 'system',
  body        text not null check (char_length(body) between 1 and 4000),
  is_internal boolean not null default false,
  created_at  timestamptz not null default now(),
  constraint ticket_messages_internal_by_agent check (not is_internal or author_kind = 'agent')
);
create index ticket_messages_ticket_ix on public.ticket_messages (ticket_id, created_at);

create or replace function private.ticket_messages_before_insert()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  new.author_kind := case
    when (select auth.uid()) is null then 'system'::public.message_author
    when private.is_admin() then 'agent'::public.message_author
    else (select t.opener_kind from public.tickets t where t.id = new.ticket_id)
  end;
  new.created_at := now();
  return new;
end;
$$;
create trigger ticket_messages_before_insert before insert on public.ticket_messages
  for each row execute function private.ticket_messages_before_insert();
create trigger ticket_messages_append_only before update or delete on public.ticket_messages
  for each row execute function private.forbid_mutation();

-- 20 ─ audit_log (append-only) ────────────────────────────────────────────────
create table public.audit_log (
  id          uuid primary key default gen_random_uuid(),
  actor_id    uuid,
  actor_kind  public.actor_kind not null,
  admin_role  public.admin_role,
  action      text not null check (char_length(action) between 3 and 120),
  entity_type text not null,
  entity_id   uuid,
  old_data    jsonb,
  new_data    jsonb,
  reason      text check (char_length(reason) <= 1000),
  created_at  timestamptz not null default now()
);
create index audit_log_entity_ix  on public.audit_log (entity_type, entity_id, created_at desc);
create index audit_log_actor_ix   on public.audit_log (actor_id, created_at desc);
create index audit_log_created_ix on public.audit_log (created_at desc);
create trigger audit_log_append_only before update or delete on public.audit_log
  for each row execute function private.forbid_mutation();

-- Generic row audit. Noisy telemetry columns are ignored so toggling online
-- or rating updates do not flood the log.
create or replace function private.audit_row()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_noise  text[] := array['updated_at', 'is_online', 'rating', 'ratings_count', 'completed_rides',
                           'acceptance_rate', 'redemptions_count'];
  v_old    jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  v_new    jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) end;
  v_uid    uuid  := (select auth.uid());
begin
  if tg_op = 'UPDATE' and (v_old - v_noise) = (v_new - v_noise) then
    return null;
  end if;
  insert into public.audit_log (actor_id, actor_kind, admin_role, action, entity_type, entity_id, old_data, new_data, reason)
  values (
    v_uid,
    private.current_actor(),
    (select p.admin_role from public.profiles p where p.id = v_uid),
    tg_table_name || '.' || lower(tg_op),
    tg_table_name,
    coalesce((v_new ->> 'id'), (v_old ->> 'id'), (v_new ->> 'driver_id'))::uuid,
    v_old,
    v_new,
    nullif(current_setting('aura.reason', true), '')
  );
  return null;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array['profiles', 'drivers', 'vehicles', 'driver_documents', 'cities', 'zones',
                           'tariffs', 'promos', 'payments', 'payouts']
  loop
    execute format(
      'create trigger %1$s_audit after insert or update or delete on public.%1$s
         for each row execute function private.audit_row()', t);
  end loop;
end $$;

-- 21 ─ wasl_sync_log (TGA / Elm Wasl integration attempts) ───────────────────
create table public.wasl_sync_log (
  id               uuid primary key default gen_random_uuid(),
  entity_type      public.wasl_entity not null,
  entity_id        uuid not null,
  operation        text not null check (operation in (
                     'driver_registration', 'vehicle_registration', 'eligibility_check',
                     'trip_registration', 'trip_update')),
  provider         text not null default 'mock' check (provider in ('mock', 'wasl')),
  status           public.sync_status not null default 'pending',
  attempt          smallint not null default 1 check (attempt between 1 and 20),
  request_payload  jsonb,
  response_payload jsonb,
  error_message    text,
  next_retry_at    timestamptz,
  created_at       timestamptz not null default now(),
  completed_at     timestamptz,
  constraint wasl_sync_log_completed_ts check (status = 'pending' or completed_at is not null)
);
create index wasl_sync_log_entity_ix on public.wasl_sync_log (entity_type, entity_id, created_at desc);
create index wasl_sync_log_retry_ix  on public.wasl_sync_log (next_retry_at)
  where status in ('pending', 'failed');
