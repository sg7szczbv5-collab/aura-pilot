-- ============================================================================
-- AURA · 019 · In-trip chat (018) under the PDPL guarantees
-- ----------------------------------------------------------------------------
-- public.ride_messages holds personal data (free text). Like ticket messages it
-- must be covered by the data-subject rights already implemented:
--   • erasure  (private.erase_user): the text a user sent is replaced by '[erased]';
--   • access   (public.export_my_data): the export includes the messages the user
--               sent (not the other party's, which are that person's data).
-- Both functions are redefined from their latest versions (auth_privacy for
-- erase_user, compliance for export_my_data) with only these additions; grants,
-- checks, limits and the audit / request logging are unchanged.
-- Depends on 018 (ride_messages). Additive: no data is changed by this migration.
-- ============================================================================

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
  -- 019: in-trip chat (migration 018) — the text this user sent.
  update public.ride_messages set body = '[erased]' where sender_id = p_user_id;

  perform set_config('aura.erasure', '', true);
end;
$$;

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
    'format', 'aura.personal-data.v2',
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
                                     'dropoff', extensions.st_asgeojson(r.dropoff)::jsonb,
                                     'route_points', coalesce((
                                        select jsonb_agg(jsonb_build_object('at', pt.recorded_at,
                                                 'lat', extensions.st_y(pt.location::extensions.geometry),
                                                 'lng', extensions.st_x(pt.location::extensions.geometry)) order by pt.recorded_at)
                                        from public.ride_route_points pt where pt.ride_id = r.id), '[]'::jsonb))
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
    'wasl', jsonb_build_object(
      'driver_status', (select d.wasl_status from public.drivers d where d.id = v_uid),
      'submissions', coalesce((select jsonb_agg(jsonb_build_object('entity', w.entity_type, 'operation', w.operation,
                                        'status', w.status, 'at', w.created_at) order by w.created_at)
                               from public.wasl_sync_log w
                               where (w.entity_type = 'driver' and w.entity_id = v_uid)
                                  or (w.entity_type = 'vehicle' and w.entity_id in (select id from public.vehicles where driver_id = v_uid))), '[]'::jsonb)),
    'trip_shares', coalesce((select jsonb_agg(to_jsonb(s) - 'token_hash' order by s.created_at)
                             from public.trip_shares s where s.created_by = v_uid), '[]'),
    'tickets', coalesce((select jsonb_agg(to_jsonb(t) - 'assigned_to' || jsonb_build_object('messages', coalesce((
                           select jsonb_agg(jsonb_build_object('from', m.author_kind, 'body', m.body, 'at', m.created_at)
                                            order by m.created_at)
                           from public.ticket_messages m where m.ticket_id = t.id and not m.is_internal), '[]')))
                         from public.tickets t where t.opened_by = v_uid), '[]'),
    -- 019: in-trip chat messages this user sent (the other party's messages are theirs).
    'ride_messages', coalesce((select jsonb_agg(jsonb_build_object('ride_number', r.ride_number, 'sender', m.sender_kind,
                                       'body', m.body, 'at', m.created_at) order by m.created_at)
                               from public.ride_messages m join public.rides r on r.id = m.ride_id
                               where m.sender_id = v_uid), '[]'),
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
