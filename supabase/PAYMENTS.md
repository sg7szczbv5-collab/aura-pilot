# AURA: payments, wallet and captain settlements (Stage 5)

## Principles

- **Halalas as BigInt everywhere.** The database uses `bigint`. Every money API returns amounts as **text** (`"12345"`), and the apps and Edge Functions parse them with `BigInt`; nothing passes through a float. `supabase/functions/_shared/money.ts` (re-exported as `src/money/halalas.ts`) rounds half away from zero, exactly like PostgreSQL `round()`.
- **Double-entry ledger is the source of truth.** Every movement is a balanced transaction (sum = 0, checked at commit) and ledger rows can't be changed. `ledger_health()` proves three things: the whole ledger sums to 0, no transaction is unbalanced, and each account balance equals the sum of its entries.
- **The server sets every price.** The fare comes from `create_ride` / `quote_trip`. A card charge is created for exactly `fare_total_halalas`, and a provider result with any other amount is rejected (`amount_mismatch`) and flagged.
- **Raw card numbers never reach AURA.** The app tokenizes with Moyasar using the publishable key (`save_only`). AURA stores only the token (in `private.payment_tokens`, not reachable from the API), the brand, the last 4 digits and the expiry.

## Flows

| Payment | At request | On completion | On cancellation |
|---|---|---|---|
| **Cash** | — | Auto-settled: the captain owes commission + VAT (their wallet goes negative) | — |
| **Wallet** | Fare moved from `rider_wallet` to `wallet_holds` (fails if the balance is short) | Auto-settled from the hold | Hold released to the rider |
| **Card / mada / Apple Pay** | `request-ride` authorizes the fare (`manual`). The **ride is dispatched only once authorized**; a decline cancels it (`payment_failed`). | The `payments-worker` captures it, `record_provider_payment('paid')` settles it | The worker voids the authorization |

**Settlement entries** (`settle_ride`, credit > 0):
- the source (card clearing, wallet hold, or the captain's cash) is debited `−total`
- promo expense `−discount`
- captain `+driver_net`
- commission `+commission`
- VAT `+vat`

Commission is charged on the subtotal, VAT on (subtotal − discount), and discounts are funded by the platform.

**Tips** go 100% to the captain, with no commission. They're allowed within 24 hours of a completed ride, once per ride, between 1 SAR and the lower of 100 SAR or the fare. Wallet tips use `add_wallet_tip`; card tips go through `payments` `{ action: 'tip' }` and are credited only once the provider confirms payment.

**Wallet top-ups** are 10–2,000 SAR per top-up, with a 5,000 SAR maximum balance (a placeholder to confirm against SAMA rules). They're charged immediately and credited by `record_provider_payment('paid')`.

**Refunds** (`finance.settle`):
- `admin_refund_payment` queues a card refund, which the worker executes. Refunds can never exceed the original payment. A refund of a ride or tip is a platform cost; a refund of a top-up comes out of the wallet.
- `admin_refund_wallet_ride` refunds to the wallet immediately, up to the fare.

**Captain settlements:**
- `driver_earnings(from, to)` is the statement the captain app shows: gross, commission, earnings, tips, cash collected, deposits, payouts and balance.
- `admin_record_cash_deposit` records cash a captain hands over.
- `create_payout_batch()` runs weekly (pg_cron, Sunday 06:00 UTC) or on demand. It creates one payout per approved captain whose balance is at least 50 SAR.
- Each payout then goes `admin_set_payout_status` (approve → processing), then `complete_payout`, which posts to the ledger.

**Idempotency and safety:**
- one live charge and one live tip per ride
- `create_payment_intent` returns the existing intent on retry
- `record_provider_payment` ignores replays and out-of-order events
- the provider reference can't change once set
- the webhook re-fetches the payment from Moyasar and never trusts the body

## Edge Functions

| Function | Auth | Purpose |
|---|---|---|
| `request-ride` | rider JWT | Card rides: creates the ride, then authorizes it (3-D Secure → `transactionUrl`) |
| `payments` | rider JWT | `save_card`, `authorize_ride`, `topup`, `tip`, `sync` (after 3-D Secure) |
| `payments-webhook` | Moyasar secret token | Verifies, re-fetches and applies the result. Deploy with `--no-verify-jwt` |
| `payments-worker` | `x-cron-secret` | Captures completed card rides, voids cancelled ones, runs refunds, re-syncs stale payments. Run every minute |

Provider interface: `_shared/payments/provider.ts`. Moyasar is `_shared/payments/moyasar.ts`; the offline mock is `_shared/payments/mock.ts`. HyperPay = one new adapter registered in `_shared/payments/registry.ts`, with no handler or database changes.

## Setup

```bash
npx supabase db push        # 20261128000100_payments_enums.sql + 20261128000200_payments.sql
npx supabase functions deploy payments
npx supabase functions deploy payments-worker
npx supabase functions deploy payments-webhook --no-verify-jwt
npx supabase secrets set PAYMENT_PROVIDER=moyasar MOYASAR_SECRET_KEY=sk_test_... \
  MOYASAR_WEBHOOK_SECRET=... PAYMENT_CALLBACK_URL=https://your-domain/#/passenger PAYMENTS_CRON_SECRET=...
```

- **App:** set `VITE_MOYASAR_PUBLISHABLE_KEY=pk_test_...`. Without it the app uses mock tokens, so the server must then run `PAYMENT_PROVIDER=mock`.
- **Moyasar dashboard:** set the webhook URL to `…/functions/v1/payments-webhook` with the same secret token, and enable mada, Visa/Mastercard and Apple Pay (merchant validation).
- **Scheduler:** call `payments-worker` every minute (Supabase Cron → HTTP request) with the header `x-cron-secret`.

**Check against Moyasar before going live** (marked in `moyasar.ts`):
- `source.manual` for authorize-then-capture
- `given_id` for idempotent creation
- the token fields (`last_four`, `month`, `year`)
- the webhook `secret_token`

Apple Pay merchant validation and STC Pay (OTP flow) are not implemented yet.

## Mock mode (no keys)

| Test card | Result |
|---|---|
| `4111 1111 1111 1111` | Success |
| `4000 0000 0000 0002` | Declined |
| `4000 0000 0000 3220` | 3-D Secure, then success |

Mock payment IDs encode their state, so the Edge Functions stay stateless.
