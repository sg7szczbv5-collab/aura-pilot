-- ============================================================================
-- AURA · 013 · Payments, tips, wallet holds, settlement, captain settlements
-- ----------------------------------------------------------------------------
-- Money stays BIGINT halalas end to end; every client-facing money API returns
-- amounts as TEXT so browsers parse them with BigInt (no float rounding).
--
--  Wallet ride  : fare reserved at request (rider_wallet → wallet_holds),
--                 released on cancel, settled from the hold on completion.
--  Cash ride    : settled automatically on completion (captain owes commission+VAT).
--  Card ride    : authorized before dispatch (create_payment_intent → provider →
--                 record_provider_payment), captured on completion by the
--                 payments worker, voided on cancellation; settled when captured.
--  Tips         : 100% to the captain, no commission, after completion.
--  Captains     : cash deposits, weekly payout batches, earnings statement.
--  Integrity    : ledger_health() proves the ledger balances.
-- ============================================================================

insert into public.wallet_accounts (account_type, allow_negative) values
  ('wallet_holds', false),
  ('cash_deposits', true)
on conflict do nothing;

alter table public.payouts alter column amount_halalas type bigint;

alter table public.payments
  add constraint payments_tip_has_ride check (kind <> 'tip' or ride_id is not null);
-- At most one live card charge and one live tip per ride.
create unique index payments_one_live_charge_ix on public.payments (ride_id)
  where kind = 'charge' and status in ('initiated', 'authorized', 'paid');
create unique index payments_one_live_tip_ix on public.payments (ride_id)
  where kind = 'tip' and status in ('initiated', 'authorized', 'paid');

-- Money limits in one place (halalas).
create or replace function private.money_limit(p_key text)
returns bigint
language sql immutable
set search_path = ''
as $$
  select case p_key
    when 'topup_min'  then 1000      -- 10 SAR
    when 'topup_max'  then 200000    -- 2,000 SAR per top-up
    when 'wallet_max' then 500000    -- 5,000 SAR stored balance (placeholder, confirm with SAMA rules)
    when 'tip_min'    then 100       -- 1 SAR
    when 'tip_max'    then 10000     -- 100 SAR
    when 'payout_min' then 5000      -- 50 SAR
    when 'deposit_max' then 100000000
  end::bigint;
$$;

create or replace function private.is_card_method(p public.payment_method_type)
returns boolean
language sql immutable
set search_path = ''
as $$
  select p in ('mada', 'card', 'apple_pay', 'stc_pay');
$$;

-- ── Wallet holds ────────────────────────────────────────────────────────────
create or replace function private.rides_wallet_hold()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  tx uuid := gen_random_uuid();
begin
  if new.payment_method = 'wallet' then
    perform private.post_entry(tx, private.owner_account('rider_wallet', new.rider_id), 'hold',
                               -new.fare_total_halalas, new.id, null, null, 'Reserved for ride');
    perform private.post_entry(tx, private.platform_account('wallet_holds'), 'hold',
                               new.fare_total_halalas, new.id, null, null, 'Reserved for ride');
  end if;
  return new;
end;
$$;
create trigger rides_wallet_hold after insert on public.rides
  for each row execute function private.rides_wallet_hold();

-- Settlement: wallet rides are paid from the hold (otherwise as in 008).
create or replace function public.settle_ride(p_ride_id uuid)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v     public.rides;
  v_pay public.payments;
  tx    uuid := gen_random_uuid();
begin
  select * into v from public.rides where id = p_ride_id for update;
  if not found or v.status <> 'completed' then
    raise exception 'AURA: only completed rides can be settled' using errcode = '55000';
  end if;
  if v.settled_at is not null then
    raise exception 'AURA: ride already settled' using errcode = '23505';
  end if;

  if private.is_card_method(v.payment_method) then
    select * into v_pay from public.payments
     where ride_id = v.id and kind = 'charge' and status = 'paid'
     order by paid_at desc limit 1;
    if not found then
      raise exception 'AURA: no paid charge for this ride' using errcode = '55000';
    end if;
    if v_pay.amount_halalas <> v.fare_total_halalas then
      raise exception 'AURA: charge % does not match fare %', v_pay.amount_halalas, v.fare_total_halalas using errcode = '23514';
    end if;
    perform private.post_entry(tx, private.platform_account('gateway_clearing'), 'ride_fare',
                               -v.fare_total_halalas, v.id, v_pay.id, null, 'Card payment');
  elsif v.payment_method = 'wallet' then
    perform private.post_entry(tx, private.platform_account('wallet_holds'), 'wallet_payment',
                               -v.fare_total_halalas, v.id, null, null, 'Wallet payment');
  else
    perform private.post_entry(tx, private.owner_account('driver_wallet', v.driver_id), 'cash_collected',
                               -v.fare_total_halalas, v.id, null, null, 'Cash collected by captain');
  end if;

  perform private.post_entry(tx, private.platform_account('promo_expense'), 'promo_discount',
                             -v.fare_discount_halalas, v.id, null, null, 'Promo funded by platform');
  perform private.post_entry(tx, private.owner_account('driver_wallet', v.driver_id), 'driver_earning',
                             v.driver_net_halalas, v.id, null, null, 'Ride earning');
  perform private.post_entry(tx, private.platform_account('platform_commission'), 'commission',
                             v.commission_halalas, v.id, null, null, 'Commission');
  perform private.post_entry(tx, private.platform_account('platform_vat'), 'vat',
                             v.fare_vat_halalas, v.id, null, null, 'VAT 15%');

  update public.rides set settled_at = now() where id = v.id;
  return tx;
end;
$$;

-- Money follows the final state: cash/wallet settle on completion; wallet holds
-- are released on cancellation. Card captures/voids are done by the worker.
create or replace function private.rides_money_on_final()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  tx uuid := gen_random_uuid();
begin
  if new.status = 'completed' and new.payment_method in ('cash', 'wallet') and new.settled_at is null then
    perform public.settle_ride(new.id);
  elsif new.status = 'cancelled' and new.payment_method = 'wallet' and new.settled_at is null then
    perform private.post_entry(tx, private.platform_account('wallet_holds'), 'hold_release',
                               -new.fare_total_halalas, new.id, null, null, 'Ride cancelled');
    perform private.post_entry(tx, private.owner_account('rider_wallet', new.rider_id), 'hold_release',
                               new.fare_total_halalas, new.id, null, null, 'Ride cancelled');
    update public.rides set settled_at = now() where id = new.id;
  end if;
  return new;
end;
$$;
create trigger rides_money_on_final after update on public.rides
  for each row when (old.status is distinct from new.status and new.status in ('completed', 'cancelled'))
  execute function private.rides_money_on_final();

-- Card rides are only dispatched once the fare is authorized.
create or replace function public.dispatch_ride(p_ride_id uuid)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v        public.rides;
  v_driver uuid;
  v_dist   double precision;
begin
  select * into v from public.rides where id = p_ride_id for update;
  if not found or v.status <> 'searching' then
    return null;
  end if;
  if private.is_card_method(v.payment_method) and not exists (
       select 1 from public.payments p
        where p.ride_id = v.id and p.kind = 'charge' and p.status in ('authorized', 'paid')) then
    return null; -- waiting for payment authorization
  end if;
  if v.offered_driver_id is not null and v.offer_expires_at > now() then
    return v.offered_driver_id;
  end if;

  update public.ride_offers set response = 'expired', responded_at = now()
   where ride_id = p_ride_id and response = 'pending';
  if v.offered_driver_id is not null then
    perform private.refresh_acceptance_rate(v.offered_driver_id);
  end if;

  select c.driver_id, c.distance_m into v_driver, v_dist
    from public.dispatch_candidates(p_ride_id, private.dispatch_setting('radius_m'), 50) c
   where not exists (select 1 from public.ride_offers o where o.ride_id = p_ride_id and o.driver_id = c.driver_id)
     and not exists (select 1 from public.ride_offers o
                      where o.driver_id = c.driver_id and o.response = 'pending' and o.expires_at > now())
   order by c.distance_m
   limit 1;

  if v_driver is null then
    update public.rides set offered_driver_id = null, offer_expires_at = null
     where id = p_ride_id and offered_driver_id is not null;
    return null;
  end if;

  update public.rides
     set offered_driver_id = v_driver,
         offer_expires_at = now() + make_interval(secs => private.dispatch_setting('offer_ttl_s'))
   where id = p_ride_id;
  insert into public.ride_offers (ride_id, driver_id, distance_m, expires_at)
  values (p_ride_id, v_driver, round(v_dist),
          now() + make_interval(secs => private.dispatch_setting('offer_ttl_s')));
  return v_driver;
end;
$$;

-- ── Tips ────────────────────────────────────────────────────────────────────
create or replace function private.assert_tip_allowed(p_ride_id uuid, p_rider_id uuid, p_amount bigint)
returns public.rides
language plpgsql
set search_path = ''
as $$
declare
  r public.rides;
begin
  select * into r from public.rides where id = p_ride_id for update;
  if not found or r.rider_id is distinct from p_rider_id then
    raise exception 'AURA: not your ride' using errcode = '42501';
  end if;
  if r.status <> 'completed' or r.completed_at < now() - interval '24 hours' then
    raise exception 'AURA: tips are possible within 24 hours of a completed ride' using errcode = '55000';
  end if;
  if r.tip_halalas > 0 or exists (select 1 from public.payments p where p.ride_id = r.id and p.kind = 'tip'
                                    and p.status in ('initiated', 'authorized', 'paid')) then
    raise exception 'AURA: this ride already has a tip' using errcode = '23505';
  end if;
  if p_amount is null or p_amount < private.money_limit('tip_min')
     or p_amount > least(private.money_limit('tip_max'), r.fare_total_halalas::bigint) then
    raise exception 'AURA: tip must be between % and % halalas', private.money_limit('tip_min'),
      least(private.money_limit('tip_max'), r.fare_total_halalas::bigint) using errcode = '22023';
  end if;
  return r;
end;
$$;

-- Rider tips from the wallet (immediate). Card tips go through create_payment_intent.
create or replace function public.add_wallet_tip(p_ride_id uuid, p_amount_halalas bigint)
returns text
language plpgsql security definer
set search_path = ''
as $$
declare
  r  public.rides;
  tx uuid := gen_random_uuid();
begin
  r := private.assert_tip_allowed(p_ride_id, (select auth.uid()), p_amount_halalas);
  perform private.post_entry(tx, private.owner_account('rider_wallet', r.rider_id), 'tip', -p_amount_halalas, r.id, null, null, 'Tip');
  perform private.post_entry(tx, private.owner_account('driver_wallet', r.driver_id), 'tip', p_amount_halalas, r.id, null, null, 'Tip from rider');
  update public.rides set tip_halalas = p_amount_halalas where id = r.id;
  return p_amount_halalas::text;
end;
$$;

-- ── Card payments (called by the payments Edge Function, service role) ───────
create or replace function public.create_payment_intent(
  p_rider_id uuid, p_kind public.payment_kind, p_ride_id uuid, p_amount_halalas bigint,
  p_method_type public.payment_method_type, p_provider public.payment_provider,
  p_payment_method_id uuid default null)
returns public.payments
language plpgsql security definer
set search_path = ''
as $$
declare
  r       public.rides;
  v       public.payments;
  v_amt   bigint := p_amount_halalas;
  v_bal   bigint;
begin
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
$$;

-- Apply a provider result (API response, webhook, or worker). Idempotent:
-- replays and out-of-order events are ignored; amounts must match exactly.
create or replace function public.record_provider_payment(
  p_payment_id uuid, p_status public.payment_status, p_provider_payment_id text default null,
  p_amount_halalas bigint default null, p_failure_code text default null,
  p_failure_message text default null, p_raw jsonb default null)
returns public.payments
language plpgsql security definer
set search_path = ''
as $$
declare
  v        public.payments;
  v_parent public.payments;
  r        public.rides;
  v_status public.payment_status := p_status;
  v_code   text := p_failure_code;
  tx       uuid := gen_random_uuid();
begin
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
$$;

-- Work for the payments worker: captures, voids, refunds, stale syncs.
create or replace function public.payment_work_queue(p_limit integer default 100)
returns table (payment_id uuid, action text, provider public.payment_provider, provider_payment_id text, amount_halalas bigint)
language sql stable security definer
set search_path = ''
as $$
  select * from (
    select p.id, 'capture'::text, p.provider, p.provider_payment_id, p.amount_halalas::bigint
      from public.payments p join public.rides r on r.id = p.ride_id
     where p.kind = 'charge' and p.status = 'authorized' and r.status = 'completed'
    union all
    select p.id, 'void', p.provider, p.provider_payment_id, p.amount_halalas::bigint
      from public.payments p join public.rides r on r.id = p.ride_id
     where p.kind in ('charge', 'tip') and p.status = 'authorized' and r.status = 'cancelled'
    union all
    select p.id, 'refund', p.provider, parent.provider_payment_id, p.amount_halalas::bigint
      from public.payments p join public.payments parent on parent.id = p.parent_payment_id
     where p.kind = 'refund' and p.status = 'initiated'
    union all
    select p.id, 'sync', p.provider, p.provider_payment_id, p.amount_halalas::bigint
      from public.payments p
     where p.kind <> 'refund' and p.status = 'initiated' and p.provider_payment_id is not null
       and p.created_at < now() - interval '10 minutes'
  ) q
  limit p_limit;
$$;

-- Saved cards: the token never reaches the client again.
create or replace function public.save_payment_method(
  p_rider_id uuid, p_provider public.payment_provider, p_method_type public.payment_method_type,
  p_token text, p_brand text, p_last4 text, p_exp_month integer, p_exp_year integer, p_holder text default null)
returns public.payment_methods
language plpgsql security definer
set search_path = ''
as $$
declare
  v public.payment_methods;
  v_first boolean := not exists (select 1 from public.payment_methods where rider_id = p_rider_id and deleted_at is null);
begin
  insert into public.payment_methods (rider_id, provider, method_type, brand, last4, exp_month, exp_year, holder_name, is_default)
  values (p_rider_id, p_provider, p_method_type, left(p_brand, 20), p_last4, p_exp_month, p_exp_year, left(p_holder, 120), v_first)
  returning * into v;
  insert into private.payment_tokens (payment_method_id, provider_token) values (v.id, p_token);
  if v_first then
    update public.riders set default_payment_method_id = v.id where id = p_rider_id;
  end if;
  return v;
end;
$$;

create or replace function public.payment_method_token(p_payment_method_id uuid, p_rider_id uuid)
returns text
language sql stable security definer
set search_path = ''
as $$
  select t.provider_token
  from private.payment_tokens t join public.payment_methods m on m.id = t.payment_method_id
  where m.id = p_payment_method_id and m.rider_id = p_rider_id and m.deleted_at is null;
$$;

-- ── Refunds (finance.settle) ────────────────────────────────────────────────
create or replace function public.admin_refund_payment(p_payment_id uuid, p_amount_halalas bigint, p_reason text)
returns public.payments
language plpgsql security definer
set search_path = ''
as $$
declare
  p public.payments;
  v public.payments;
begin
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
$$;

-- Wallet-paid rides are refunded to the wallet immediately.
create or replace function public.admin_refund_wallet_ride(p_ride_id uuid, p_amount_halalas bigint, p_reason text)
returns text
language plpgsql security definer
set search_path = ''
as $$
declare
  r        public.rides;
  v_done   bigint;
  tx       uuid := gen_random_uuid();
begin
  if not private.admin_can('finance.settle') then
    raise exception 'AURA: permission finance.settle required' using errcode = '42501';
  end if;
  if nullif(trim(p_reason), '') is null then
    raise exception 'AURA: a reason is required' using errcode = '23502';
  end if;
  select * into r from public.rides where id = p_ride_id for update;
  if not found or r.payment_method <> 'wallet' or r.status <> 'completed' or r.settled_at is null then
    raise exception 'AURA: only settled wallet rides can be refunded to the wallet' using errcode = '22023';
  end if;
  select coalesce(sum(l.amount_halalas), 0) into v_done
    from public.wallet_ledger l join public.wallet_accounts a on a.id = l.account_id
   where l.ride_id = r.id and l.entry_type = 'refund' and a.account_type = 'rider_wallet';
  if p_amount_halalas is null or p_amount_halalas <= 0 or v_done + p_amount_halalas > r.fare_total_halalas then
    raise exception 'AURA: refund exceeds the fare' using errcode = '23514';
  end if;
  perform set_config('aura.reason', p_reason, true);
  perform private.post_entry(tx, private.platform_account('adjustments'), 'refund', -p_amount_halalas, r.id, null, null, left('Refund: ' || p_reason, 300));
  perform private.post_entry(tx, private.owner_account('rider_wallet', r.rider_id), 'refund', p_amount_halalas, r.id, null, null, left('Refund: ' || p_reason, 300));
  return p_amount_halalas::text;
end;
$$;

-- ── Captain settlements ─────────────────────────────────────────────────────
-- Cash a captain hands over (bank transfer / office) reduces what they owe.
create or replace function public.admin_record_cash_deposit(p_driver_id uuid, p_amount_halalas bigint, p_reference text)
returns text
language plpgsql security definer
set search_path = ''
as $$
declare
  tx uuid := gen_random_uuid();
  v_bal bigint;
begin
  if not private.admin_can('finance.settle') then
    raise exception 'AURA: permission finance.settle required' using errcode = '42501';
  end if;
  if p_amount_halalas is null or p_amount_halalas <= 0 or p_amount_halalas > private.money_limit('deposit_max') then
    raise exception 'AURA: invalid amount' using errcode = '22023';
  end if;
  if nullif(trim(p_reference), '') is null then
    raise exception 'AURA: a deposit reference is required' using errcode = '23502';
  end if;
  perform set_config('aura.reason', 'cash deposit ' || p_reference, true);
  perform private.post_entry(tx, private.platform_account('cash_deposits'), 'cash_deposit', -p_amount_halalas, null, null, null, left('Cash deposit ' || p_reference, 300));
  perform private.post_entry(tx, private.owner_account('driver_wallet', p_driver_id), 'cash_deposit', p_amount_halalas, null, null, null, left('Cash deposit ' || p_reference, 300));
  select balance_halalas into v_bal from public.wallet_accounts where account_type = 'driver_wallet' and owner_id = p_driver_id;
  return v_bal::text;
end;
$$;

-- Weekly: one payout per captain whose balance reached the minimum.
create or replace function public.create_payout_batch(p_min_halalas bigint default null)
returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  d   record;
  n   integer := 0;
  v_min bigint := coalesce(p_min_halalas, private.money_limit('payout_min'));
begin
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
$$;

-- ── Statements (amounts as text → BigInt in the apps) ───────────────────────
create or replace function public.my_wallet(p_account public.account_type default 'rider_wallet', p_limit integer default 50)
returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select case when a.id is null then null else jsonb_build_object(
    'account_type', a.account_type,
    'balance_halalas', a.balance_halalas::text,
    'entries', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', l.id, 'at', l.created_at, 'type', l.entry_type, 'amount_halalas', l.amount_halalas::text,
               'balance_after_halalas', l.balance_after_halalas::text, 'ride_id', l.ride_id, 'description', l.description)
             order by l.created_at desc)
      from (select * from public.wallet_ledger x where x.account_id = a.id order by x.created_at desc limit least(greatest(p_limit, 1), 200)) l
    ), '[]'::jsonb)) end
  from (select null) dummy
  left join public.wallet_accounts a
    on a.owner_id = (select auth.uid()) and a.account_type = p_account and p_account in ('rider_wallet', 'driver_wallet');
$$;

create or replace function public.driver_earnings(p_from timestamptz, p_to timestamptz default now())
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  a     public.wallet_accounts;
  v     jsonb;
begin
  select * into a from public.wallet_accounts where owner_id = v_uid and account_type = 'driver_wallet';
  if not found then
    raise exception 'AURA: captains only' using errcode = '42501';
  end if;
  with l as (
    select entry_type, coalesce(sum(amount_halalas), 0)::bigint s
      from public.wallet_ledger where account_id = a.id and created_at >= p_from and created_at < p_to
     group by entry_type
  ), r as (
    select count(*) n,
           coalesce(sum(fare_subtotal_halalas), 0)::bigint gross,
           coalesce(sum(commission_halalas), 0)::bigint commission,
           coalesce(sum(driver_net_halalas), 0)::bigint net,
           count(*) filter (where payment_method = 'cash') cash_rides
      from public.rides
     where driver_id = v_uid and status = 'completed' and completed_at >= p_from and completed_at < p_to
  )
  select jsonb_build_object(
    'from', p_from, 'to', p_to,
    'rides', r.n, 'cash_rides', r.cash_rides,
    'gross_halalas', r.gross::text,
    'commission_halalas', r.commission::text,
    'earnings_halalas', r.net::text,
    'tips_halalas', coalesce((select s from l where entry_type = 'tip'), 0)::text,
    'cash_collected_halalas', (-coalesce((select s from l where entry_type = 'cash_collected'), 0))::text,
    'cash_deposited_halalas', coalesce((select s from l where entry_type = 'cash_deposit'), 0)::text,
    'paid_out_halalas', (-coalesce((select s from l where entry_type = 'payout'), 0))::text,
    'balance_halalas', a.balance_halalas::text,
    'open_payout', (select jsonb_build_object('id', p.id, 'status', p.status, 'amount_halalas', p.amount_halalas::text, 'requested_at', p.requested_at)
                      from public.payouts p where p.driver_id = v_uid and p.status in ('pending', 'approved', 'processing') limit 1)
  ) into v from r;
  return v;
end;
$$;

-- Proof that the books balance (finance.view, or the service role).
create or replace function public.ledger_health()
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_total bigint;
  v_unbalanced integer;
  v_mismatch integer;
  v_flagged integer;
begin
  if (select auth.uid()) is not null and not private.admin_can('finance.view') then
    raise exception 'AURA: permission finance.view required' using errcode = '42501';
  end if;
  select coalesce(sum(amount_halalas), 0) into v_total from public.wallet_ledger;
  select count(*) into v_unbalanced from (
    select transaction_id from public.wallet_ledger group by transaction_id having sum(amount_halalas) <> 0) x;
  select count(*) into v_mismatch from public.wallet_accounts a
   where a.balance_halalas <> coalesce((select sum(l.amount_halalas) from public.wallet_ledger l where l.account_id = a.id), 0);
  select count(*) into v_flagged from public.payments where failure_code = 'amount_mismatch';
  return jsonb_build_object(
    'ok', v_total = 0 and v_unbalanced = 0 and v_mismatch = 0,
    'ledger_sum_halalas', v_total::text,
    'unbalanced_transactions', v_unbalanced,
    'account_balance_mismatches', v_mismatch,
    'amount_mismatch_payments', v_flagged,
    'checked_at', now());
end;
$$;

-- ── Privileges ──────────────────────────────────────────────────────────────
revoke execute on all functions in schema public from public, anon;
revoke execute on function
  public.create_payment_intent(uuid, public.payment_kind, uuid, bigint, public.payment_method_type, public.payment_provider, uuid),
  public.record_provider_payment(uuid, public.payment_status, text, bigint, text, text, jsonb),
  public.payment_work_queue(integer),
  public.save_payment_method(uuid, public.payment_provider, public.payment_method_type, text, text, text, integer, integer, text),
  public.payment_method_token(uuid, uuid),
  public.dispatch_ride(uuid), public.settle_ride(uuid)
from authenticated;
grant execute on all functions in schema public to service_role;
grant execute on function
  public.add_wallet_tip(uuid, bigint),
  public.my_wallet(public.account_type, integer),
  public.driver_earnings(timestamptz, timestamptz),
  public.admin_refund_payment(uuid, bigint, text),
  public.admin_refund_wallet_ride(uuid, bigint, text),
  public.admin_record_cash_deposit(uuid, bigint, text),
  public.create_payout_batch(bigint),
  public.ledger_health()
to authenticated;

revoke execute on all functions in schema private from public, anon, authenticated;
grant  execute on all functions in schema private to service_role;
grant  execute on function
  private.is_admin(), private.admin_can(text), private.is_approved_driver(), private.current_actor(),
  private.is_ride_participant(uuid), private.owns_wallet_account(uuid), private.owns_ticket(uuid),
  private.is_my_active_driver(uuid), private.session_aal()
to authenticated;

-- Weekly payout batch (Sunday 06:00 UTC) when pg_cron is enabled.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('aura-payout-batch', '0 6 * * 0', 'select public.create_payout_batch()');
  end if;
end $$;
