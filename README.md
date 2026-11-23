# TaskMint

A rewards site where members earn points for completing offerwall surveys and
signups, then cash out to PayPal or bank. Built as a static front end plus a
zero-dependency Node backend that keeps the ledger authoritative.

The design goal was the opposite of the sites this was modelled on: no
referral-funded payouts, no crypto-only withdrawals, no single operator-decided
"payout day", and a public ledger that is generated from the database rather
than typed into the page.

## Two modes

| Mode | How it is selected | Where balances live |
| --- | --- | --- |
| Demo | `GET /api/health` fails (static hosting) | `localStorage`, clearly labelled "Prototype · demo data" |
| Live | `GET /api/health` returns `{ok:true}` | Server ledger, pill reads "Live ledger" |

Nothing in demo mode touches money. In live mode the browser never writes a
balance: every credit and debit is a server-side ledger entry.

Points economy: **1,000 points = $1**, **$5.00 minimum cash-out**, 25 points per
daily check-in, 250-point 7-day streak bonus, 500-point referral bonus once the
referred member completes their first offer. Revenue share target is 65–70% of
offer revenue to the member; the landing page shows a worked example.

## Run it

```bash
node server/index.js          # http://localhost:8080
```

No install, no build step, no dependencies. Open `/` for the marketing site,
`/app.html` for the member dashboard, `/payouts.html` for the public ledger.

End-to-end backend test (start the server first, with the same `ADMIN_KEY`):

```bash
ADMIN_KEY=test-admin-key node server/test.mjs
BASE=http://localhost:8124 ADMIN_KEY=... node server/test.mjs   # different port
```

Environment:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8080` | Listen port |
| `PORTAL_SECRET` | `dev-only-portal-secret` | HMAC key for session tokens |
| `OFFERWALL_SECRET` | `dev-only-offerwall-secret` | HMAC key for partner postbacks |
| `ADMIN_KEY` | *(unset)* | Enables `POST /api/admin/payouts/paid`; unset disables the route |
| `SIMULATE_PARTNER` | `1` | `0` in production: only signed postbacks credit points |
| `POINTS_PER_USD` | `1000` | Points per dollar |
| `MIN_WITHDRAW_USD` | `5` | Cash-out minimum |

**The default secrets are dev placeholders.** Set both, plus `ADMIN_KEY`, before
the server listens on anything other than localhost.

## API

All member routes take `Authorization: Bearer <token>`. JSON in, JSON out.

| Route | Method | Auth | Notes |
| --- | --- | --- | --- |
| `/api/health` | GET | none | Mode probe |
| `/api/signup` | POST | none | `{handle}` → `{token, state}`; handle is `^[a-z0-9_]{3,20}$` |
| `/api/state` | GET | token | Full member state |
| `/api/checkin` | POST | token | Once per UTC day; `409 already_checked_in` |
| `/api/offers/start` | POST | token | `{offerId}`; marks pending, `409 already_started` |
| `/api/withdraw` | POST | token | `{usd, method}`; `below_minimum`, `insufficient_points` |
| `/api/postback` | POST | partner signature | Server-to-server offer confirmation |
| `/api/admin/payouts/paid` | POST | `x-admin-key` | `{handle, payoutId}`; marks payout paid |
| `/api/public/payouts` | GET | none | Paid totals, distinct paid members, queued totals |

### Partner postback contract

The offerwall or survey partner calls this server-to-server when an offer is
confirmed. Signature covers every field:

```
payload = `${tx}|${handle}|${offer}|${amount}|${status}`
sig     = base64url(HMAC-SHA256(payload, OFFERWALL_SECRET))
```

```json
{
  "tx": "partner-transaction-id",
  "user": "member_handle",
  "offer": "survey-spending",
  "amount": 5,
  "status": 1,
  "sig": "<base64url hmac>"
}
```

`amount` is **US dollars of revenue**, not points. `status: 1` means confirmed;
anything else is recorded and credits nothing. `tx` is idempotent — replays
return `{ok:true, duplicate:true}` and never double-credit. Unknown handles or
bad signatures are rejected.

## Payout operations

1. Members request cash-outs in the app. Points are debited at request time and
   the payout enters the `queued` state.
2. Weekly, an operator reviews queued payouts (amount, account age, offer mix,
   identity check) and sends money out.
3. Each completed transfer is marked with:

   ```bash
   curl -X POST http://localhost:8080/api/admin/payouts/paid \
     -H "content-type: application/json" \
     -H "x-admin-key: $ADMIN_KEY" \
     -d '{"handle":"member","payoutId":"<uuid>"}'
   ```

4. `/payouts.html` reads `/api/public/payouts`, so paid totals and distinct
   paid members update from the database, while queued requests are shown
   separately. There is no hand-edited figure on the page.

## Anti-fraud and compliance requirements before taking real money

This repo is the software, not a licensed payout operation. Before launch:

- **Offerwall partner account.** Sign with BitLabs, AdGem, Ayet or RevU and
  replace the stub catalog in `server/index.js`. Commission and fraud rules come
  from the partner contract.
- **No compensating users for ad views.** AdSense and most display-ad networks
  forbid paying users to view ads, so this site monetises offers and surveys
  only. Rewarded-video SDK policies also restrict cash-out of ad rewards. Do not
  add a display-ad path that pays out.
- **Business entity, address and contact route.** Needed for partner onboarding,
  payment accounts and the terms page.
- **Identity verification at first cash-out.** One verified identity per person;
  name on the payout account must match. Keep records for KYC/AML.
- **Tax reporting.** US operators generally need W-9/W-8BEN and 1099-NEC above
  the reporting threshold; earnings pages must be accurate.
- **Fraud controls.** Device/IP velocity limits, offerwall postback allow-lists,
  minimum account age and offer-completion history before the first payout,
  clawback of reversed partner transactions, and holds on chargeback risk.
- **Privacy law.** GDPR/CCPA deletion and export, cookie/consent handling, and an
  age gate (16+). Update `legal.html` with the operator's real details.
- **Hosted deployment.** HTTPS behind a reverse proxy, `PORTAL_SECRET`,
  `OFFERWALL_SECRET` and `ADMIN_KEY` set to strong random values,
  `SIMULATE_PARTNER=0`, rate limiting at the edge, and a real database. The
  JSON file store here is single-node and loses writes on crash.

## Layout

```
index.html        marketing site (how it works, earnings example, revenue split)
app.html          member dashboard: earn, referrals, wallet
payouts.html      public payout ledger, generated from /api/public/payouts
legal.html        terms, privacy, earnings disclosure
assets/           styles and client app (demo + live modes)
server/index.js   zero-dependency HTTP server, ledger, postbacks, admin
```
