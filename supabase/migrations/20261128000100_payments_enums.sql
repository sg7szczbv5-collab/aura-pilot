-- ============================================================================
-- AURA · 012 · Payment enum values (separate migration: new enum values cannot
-- be used in the transaction that adds them; 013 uses them).
-- ============================================================================
alter type public.payment_kind      add value if not exists 'tip';
alter type public.account_type      add value if not exists 'wallet_holds';   -- rider funds reserved for an active wallet ride
alter type public.account_type      add value if not exists 'cash_deposits';  -- cash captains hand over to AURA
alter type public.ledger_entry_type add value if not exists 'hold';
alter type public.ledger_entry_type add value if not exists 'hold_release';
alter type public.ledger_entry_type add value if not exists 'cash_deposit';
