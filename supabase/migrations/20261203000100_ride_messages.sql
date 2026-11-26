-- ============================================================================
-- AURA · 018 · In-trip chat between rider and captain (server-backed)
-- ----------------------------------------------------------------------------
-- Until now chat lived only in the sender's browser in live mode, so the other
-- party never received it. public.ride_messages:
--   • only the rider and the assigned captain of a ride can read / write;
--   • writing is allowed only while the ride is active (assigned → in progress);
--   • sender and sender kind are set by the database, never by the client;
--   • staff with trips.view can read (disputes, safety);
--   • streamed with Realtime (RLS applies to Realtime too);
--   • personal data: purged 30 days after the ride ends (private.purge_ride_messages).
-- Additive only: no existing table or data is changed.
-- ============================================================================

create table public.ride_messages (
  id          uuid primary key default gen_random_uuid(),
  ride_id     uuid not null references public.rides (id) on delete cascade,
  sender_id   uuid references public.profiles (id) on delete set null,
  sender_kind public.message_author not null default 'system',
  body        text not null check (char_length(btrim(body)) between 1 and 500),
  created_at  timestamptz not null default now()
);
create index ride_messages_ride_ix on public.ride_messages (ride_id, created_at);

create or replace function private.ride_messages_before_insert()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  r public.rides;
begin
  select * into r from public.rides where id = new.ride_id;
  new.sender_id := (select auth.uid());
  new.sender_kind := case
    when new.sender_id is null then 'system'
    when new.sender_id = r.rider_id then 'rider'
    when new.sender_id = r.driver_id then 'driver'
    else 'system' end::public.message_author;
  new.body := btrim(new.body);
  new.created_at := now();
  return new;
end;
$$;
create trigger ride_messages_before_insert before insert on public.ride_messages
  for each row execute function private.ride_messages_before_insert();
revoke execute on function private.ride_messages_before_insert() from public, anon, authenticated;

alter table public.ride_messages enable row level security;
revoke all on public.ride_messages from anon, authenticated;
grant select on public.ride_messages to authenticated;
grant insert (ride_id, body) on public.ride_messages to authenticated;
grant all on public.ride_messages to service_role;

create policy ride_messages_read on public.ride_messages for select to authenticated
  using (
    exists (select 1 from public.rides r where r.id = ride_id and (select auth.uid()) in (r.rider_id, r.driver_id))
    or private.admin_can('trips.view'));

create policy ride_messages_insert on public.ride_messages for insert to authenticated
  with check (
    exists (select 1 from public.rides r
             where r.id = ride_id
               and (select auth.uid()) in (r.rider_id, r.driver_id)
               and r.status in ('driver_assigned', 'driver_arriving', 'driver_arrived', 'in_progress')));

-- Messages are never edited or deleted by clients (no update/delete grants or policies).

-- Retention: chat is only needed around the trip (and for a dispute window).
create or replace function private.purge_ride_messages(p_days integer default 30)
returns integer
language plpgsql security definer
set search_path = ''
as $$
declare n integer;
begin
  delete from public.ride_messages m
   using public.rides r
   where r.id = m.ride_id
     and r.status in ('completed', 'cancelled')
     and coalesce(r.completed_at, r.cancelled_at, r.updated_at) < now() - make_interval(days => p_days);
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke execute on function private.purge_ride_messages(integer) from public, anon, authenticated;
grant execute on function private.purge_ride_messages(integer) to service_role;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.ride_messages;
  end if;
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('aura-purge-ride-messages', '45 3 * * *', 'select private.purge_ride_messages(30)');
  end if;
end $$;
