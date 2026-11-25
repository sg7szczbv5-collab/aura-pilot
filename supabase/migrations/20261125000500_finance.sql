-- ============================================================================
-- AURA · 005 · Money: payment methods, payments, wallets, double-entry ledger, payouts
-- Tables: 13 payment_methods · 14 payments · 15 wallet_accounts · 16 wallet_ledger · 17 payouts
--         (+ internal private.payment_tokens)
--
-- Ledger rules
--   * amount_halalas > 0 credits an account (its balance goes up), < 0 debits it.
--   * Every transaction_id must sum to exactly 0 (checked at COMMIT).
--   * Rows are immutable; corrections are new reversing entries.
--   * wallet_accounts.balance_halalas is maintained only by the ledger trigger
--     and may not go below 0 unless allow_negative (driver wallets, platform
--     clearing accounts).
-- ============================================================================

-- 13 ─ payment_methods (tokenized cards; raw PAN never touches AURA) ───────────
create table public.payment_methods (
  id           uuid primary key default gen_random_uuid(),
  rider_id     uuid not null references public.riders (id) on delete cascade,
  provider     public.payment_provider not null check (provider in ('moyasar', 'hyperpay', 'mock')),
  method_type  public.payment_method_type not null check (method_type in ('mada', 'card', 'stc_pay')),
  brand        text check (char_length(brand) <= 20),
  last4        char(4) check (last4 ~ '^[0-9]{4}$'),
  exp_month    smallint check (exp_month between 1 and 12),
  exp_year     smallint check (exp_year between 2020 and 2100),
  holder_name  text check (char_length(holder_name) <= 120),
  is_default   boolean not null default false,
  created_at   timestamptz not null default now(),
  deleted_at   timestamptz,
  constraint payment_methods_id_rider_unique unique (id, rider_id),
  constraint payment_methods_default_not_deleted check (not (is_default and deleted_at is not null))
);
create index payment_methods_rider_ix on public.payment_methods (rider_id) where deleted_at is null;
create unique index payment_methods_one_default_ix on public.payment_methods (rider_id)
  where is_default and deleted_at is null;

-- Provider token kept outside the API surface.
create table private.payment_tokens (
  payment_method_id uuid primary key references public.payment_methods (id) on delete cascade,
  provider_token    text not null,
  created_at        timestamptz not null default now()
);
revoke all on private.payment_tokens from public;

alter table public.riders
  add constraint riders_default_payment_method_fk
  foreign key (default_payment_method_id, id) references public.payment_methods (id, rider_id)
  on delete set null (default_payment_method_id);

alter table public.rides
  add constraint rides_payment_method_fk
  foreign key (payment_method_id, rider_id) references public.payment_methods (id, rider_id)
  on delete restrict;

-- 14 ─ payments (charges, refunds, wallet top-ups) ─────────────────────────────
create table public.payments (
  id                  uuid primary key default gen_random_uuid(),
  kind                public.payment_kind not null,
  parent_payment_id   uuid references public.payments (id) on delete restrict,
  rider_id            uuid not null references public.riders (id) on delete restrict,
  ride_id             uuid references public.rides (id) on delete restrict,
  provider            public.payment_provider not null,
  method_type         public.payment_method_type not null,
  payment_method_id   uuid,
  provider_payment_id text,
  amount_halalas      integer not null check (amount_halalas > 0),
  currency            char(3) not null default 'SAR' check (currency = 'SAR'),
  status              public.payment_status not null default 'initiated',
  idempotency_key     text not null unique check (char_length(idempotency_key) between 8 and 200),
  failure_code        text,
  failure_message     text,
  metadata            jsonb not null default '{}'::jsonb,
  authorized_at       timestamptz,
  paid_at             timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint payments_provider_ref_unique unique (provider, provider_payment_id),
  constraint payments_method_fk foreign key (payment_method_id, rider_id)
    references public.payment_methods (id, rider_id) on delete restrict,
  constraint payments_refund_parent check ((kind = 'refund') = (parent_payment_id is not null)),
  constraint payments_charge_has_ride check (kind <> 'charge' or ride_id is not null),
  constraint payments_topup_shape check (
    kind <> 'wallet_topup' or (ride_id is null and provider in ('moyasar', 'hyperpay', 'mock'))),
  constraint payments_cash_provider check ((method_type = 'cash') = (provider = 'cash')),
  constraint payments_wallet_provider check ((method_type = 'wallet') = (provider = 'wallet')),
  constraint payments_paid_ts check (status <> 'paid' or paid_at is not null)
);
create index payments_rider_ix  on public.payments (rider_id, created_at desc);
create index payments_ride_ix   on public.payments (ride_id) where ride_id is not null;
create index payments_parent_ix on public.payments (parent_payment_id) where parent_payment_id is not null;
create index payments_status_ix on public.payments (status, created_at) where status in ('initiated', 'authorized');

create or replace function private.payments_before_write()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_parent   public.payments;
  v_refunded bigint;
begin
  -- Status machine: initiated → authorized → paid ; failure/void are terminal; paid is terminal.
  if tg_op = 'UPDATE' then
    if new.amount_halalas <> old.amount_halalas or new.kind <> old.kind or new.rider_id <> old.rider_id
       or new.parent_payment_id is distinct from old.parent_payment_id
       or new.ride_id is distinct from old.ride_id or new.idempotency_key <> old.idempotency_key then
      raise exception 'AURA: payment amount/kind/owner are immutable' using errcode = '23514';
    end if;
    if new.status <> old.status and not (
         (old.status = 'initiated'  and new.status in ('authorized', 'paid', 'failed', 'voided'))
      or (old.status = 'authorized' and new.status in ('paid', 'failed', 'voided'))) then
      raise exception 'AURA: illegal payment status % -> %', old.status, new.status using errcode = '23514';
    end if;
    new.updated_at := now();
  end if;

  if new.status = 'authorized' and new.authorized_at is null then new.authorized_at := now(); end if;
  if new.status = 'paid' and new.paid_at is null then new.paid_at := now(); end if;

  -- Refunds: parent must be a paid charge/top-up of the same rider; total refunds ≤ parent amount.
  if new.kind = 'refund' and new.status <> 'failed' and new.status <> 'voided' then
    select * into v_parent from public.payments where id = new.parent_payment_id for update;
    if v_parent.kind = 'refund' or v_parent.status <> 'paid' or v_parent.rider_id <> new.rider_id then
      raise exception 'AURA: refund parent must be a paid charge of the same rider' using errcode = '23514';
    end if;
    select coalesce(sum(amount_halalas), 0) into v_refunded
      from public.payments
     where parent_payment_id = new.parent_payment_id and kind = 'refund'
       and status not in ('failed', 'voided') and id <> new.id;
    if v_refunded + new.amount_halalas > v_parent.amount_halalas then
      raise exception 'AURA: refunds (% + %) exceed original payment %',
        v_refunded, new.amount_halalas, v_parent.amount_halalas using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;
create trigger payments_before_write before insert or update on public.payments
  for each row execute function private.payments_before_write();

-- 15 ─ wallet_accounts ────────────────────────────────────────────────────────
create table public.wallet_accounts (
  id              uuid primary key default gen_random_uuid(),
  account_type    public.account_type not null,
  owner_id        uuid references public.profiles (id) on delete restrict,
  currency        char(3) not null default 'SAR' check (currency = 'SAR'),
  balance_halalas bigint not null default 0,
  allow_negative  boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint wallet_accounts_owner_shape check (
    (account_type in ('rider_wallet', 'driver_wallet')) = (owner_id is not null)),
  constraint wallet_accounts_non_negative check (allow_negative or balance_halalas >= 0),
  constraint wallet_accounts_one_per_owner unique nulls not distinct (account_type, owner_id)
);
create index wallet_accounts_owner_ix on public.wallet_accounts (owner_id) where owner_id is not null;

-- Platform accounts (singletons)
insert into public.wallet_accounts (account_type, allow_negative) values
  ('platform_commission', true),
  ('platform_vat',        true),
  ('gateway_clearing',    true),
  ('promo_expense',       true),
  ('payout_clearing',     true),
  ('adjustments',         true);

-- Rider / driver wallets are created automatically.
create or replace function private.create_owner_wallet()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if tg_table_name = 'riders' then
    insert into public.wallet_accounts (account_type, owner_id, allow_negative)
    values ('rider_wallet', new.id, false) on conflict do nothing;
  else
    -- Driver wallets may go negative: commission + VAT owed on cash trips.
    insert into public.wallet_accounts (account_type, owner_id, allow_negative)
    values ('driver_wallet', new.id, true) on conflict do nothing;
  end if;
  return new;
end;
$$;
create trigger riders_create_wallet after insert on public.riders
  for each row execute function private.create_owner_wallet();
create trigger drivers_create_wallet after insert on public.drivers
  for each row execute function private.create_owner_wallet();

-- 17 ─ payouts (created before the ledger so the ledger can reference it) ──────
create table public.payouts (
  id                 uuid primary key default gen_random_uuid(),
  driver_id          uuid not null references public.drivers (id) on delete restrict,
  amount_halalas     integer not null check (amount_halalas > 0),
  currency           char(3) not null default 'SAR' check (currency = 'SAR'),
  status             public.payout_status not null default 'pending',
  iban               text not null check (iban ~ '^SA[0-9]{22}$'),
  provider           text not null default 'mock' check (provider in ('mock', 'moyasar', 'hyperpay', 'bank', 'lean')),
  provider_payout_id text,
  idempotency_key    text not null unique check (char_length(idempotency_key) between 8 and 200),
  requested_at       timestamptz not null default now(),
  approved_by        uuid references public.profiles (id) on delete set null,
  approved_at        timestamptz,
  paid_at            timestamptz,
  failure_reason     text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint payouts_provider_ref_unique unique (provider, provider_payout_id),
  constraint payouts_paid_ts check (status <> 'paid' or paid_at is not null),
  constraint payouts_approved_ts check (status not in ('approved', 'processing', 'paid') or approved_at is not null)
);
create index payouts_driver_ix on public.payouts (driver_id, requested_at desc);
create unique index payouts_one_open_per_driver_ix on public.payouts (driver_id)
  where status in ('pending', 'approved', 'processing');
create trigger payouts_touch before update on public.payouts
  for each row execute function private.touch_updated_at();

create or replace function private.payouts_status_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.amount_halalas <> old.amount_halalas or new.driver_id <> old.driver_id or new.iban <> old.iban then
    raise exception 'AURA: payout amount/driver/iban are immutable' using errcode = '23514';
  end if;
  if new.status <> old.status and not (
       (old.status = 'pending'    and new.status in ('approved', 'cancelled'))
    or (old.status = 'approved'   and new.status in ('processing', 'cancelled'))
    or (old.status = 'processing' and new.status in ('paid', 'failed'))) then
    raise exception 'AURA: illegal payout status % -> %', old.status, new.status using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger payouts_status_guard before update on public.payouts
  for each row execute function private.payouts_status_guard();

-- 16 ─ wallet_ledger (double entry, append-only) ───────────────────────────────
create table public.wallet_ledger (
  id                    uuid primary key default gen_random_uuid(),
  transaction_id        uuid not null,
  account_id            uuid not null references public.wallet_accounts (id) on delete restrict,
  entry_type            public.ledger_entry_type not null,
  amount_halalas        bigint not null check (amount_halalas <> 0),
  balance_after_halalas bigint not null default 0,
  ride_id               uuid references public.rides (id) on delete restrict,
  payment_id            uuid references public.payments (id) on delete restrict,
  payout_id             uuid references public.payouts (id) on delete restrict,
  description           text check (char_length(description) <= 300),
  created_by            uuid,
  created_at            timestamptz not null default now()
);
create index wallet_ledger_account_ix on public.wallet_ledger (account_id, created_at desc);
create index wallet_ledger_tx_ix      on public.wallet_ledger (transaction_id);
create index wallet_ledger_ride_ix    on public.wallet_ledger (ride_id) where ride_id is not null;
create index wallet_ledger_payment_ix on public.wallet_ledger (payment_id) where payment_id is not null;
create index wallet_ledger_payout_ix  on public.wallet_ledger (payout_id) where payout_id is not null;

create or replace function private.ledger_apply_entry()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  update public.wallet_accounts
     set balance_halalas = balance_halalas + new.amount_halalas,
         updated_at = now()
   where id = new.account_id
  returning balance_halalas into new.balance_after_halalas;
  if not found then
    raise exception 'AURA: wallet account % not found', new.account_id using errcode = '23503';
  end if;
  new.created_by := (select auth.uid());
  new.created_at := now();
  return new;
end;
$$;
create trigger wallet_ledger_apply before insert on public.wallet_ledger
  for each row execute function private.ledger_apply_entry();

create trigger wallet_ledger_append_only before update or delete on public.wallet_ledger
  for each row execute function private.forbid_mutation();

-- Balanced-transaction check, deferred to COMMIT so multi-row postings work.
create or replace function private.ledger_assert_balanced()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_sum bigint;
begin
  select coalesce(sum(amount_halalas), 0) into v_sum
    from public.wallet_ledger where transaction_id = new.transaction_id;
  if v_sum <> 0 then
    raise exception 'AURA: ledger transaction % is unbalanced (sum = %)', new.transaction_id, v_sum
      using errcode = '23514';
  end if;
  return null;
end;
$$;
create constraint trigger wallet_ledger_balanced
  after insert on public.wallet_ledger
  deferrable initially deferred
  for each row execute function private.ledger_assert_balanced();
