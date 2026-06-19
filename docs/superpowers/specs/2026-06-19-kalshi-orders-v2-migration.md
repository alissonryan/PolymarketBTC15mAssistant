# Spec: migrate Kalshi order placement to the V2 endpoint

**Status:** blocker — the bot cannot place any order (demo or live) until this lands.
**Discovered:** 2026-06-19, via `scripts/demo-order-test.mjs` (1× YES FOK @1¢ on demo) →
HTTP **410 `deprecated_v1_order_endpoint`** ("switch to V2 endpoints"). Auth/signing is
fine (not 401) — only the order-creation endpoint moved.

**Do this in a build session with TDD.** The DOWN→ask remap is real-money-critical: a
sign error places inverted trades. Default behavior must stay paper (`EXECUTE_ORDERS`
unset/false) and all existing paper tests must keep passing.

Docs: https://docs.kalshi.com/api-reference/orders/create-order-v2

---

## What changed (old deprecated → new V2)

| Aspect | OLD (current code, 410) | NEW V2 (target) |
|---|---|---|
| Path | `/trade-api/v2/portfolio/orders` | `/trade-api/v2/portfolio/events/orders` |
| `action` field | `"buy"` | removed (no `action`) |
| Side model | `side: "yes"\|"no"` + `yes_price`/`no_price` | `side: "bid"\|"ask"` on the **YES leg only** + single `price` |
| Price | integer cents 1–99 | **string, fixed-point dollars** e.g. `"0.5600"` |
| Count | integer | **string** e.g. `"1.00"` |
| `self_trade_prevention_type` | not sent | **required**: `"taker_at_cross"` or `"maker"` |
| `time_in_force` | `fill_or_kill` | same set: `fill_or_kill` \| `immediate_or_cancel` \| `good_till_canceled` |
| Response | `order.fill_count` / `fill_count_fp`, `taker_fill_cost_dollars` | `{order_id, fill_count:"0.00", remaining_count:"10.00", ts_ms, client_order_id, average_fill_price?, average_fee_paid?}` — **fill_count/remaining are STRINGS**; `average_fill_price` is a dollar string present only when fill_count>0 |

V2 request body (required fields bold): **ticker**, **side** (`bid`/`ask`), **count** (string),
**price** (string dollars), **time_in_force**, **self_trade_prevention_type**; optional:
`client_order_id`, `expiration_time`, `post_only`, `reduce_only`, `subaccount` (default 0),
`exchange_index` (default 0).

201 response example:
```json
{ "order_id": "...", "client_order_id": "...", "fill_count": "0.00", "remaining_count": "1.00", "ts_ms": 1715793600123 }
```

---

## ⚠️ The critical part: YES-leg remap

V2 quotes **everything from the YES side**: `bid` = buy YES, `ask` = sell YES, and
selling YES ≡ buying NO at `1 − price`. Our bot bets UP (buy YES) or DOWN (buy NO).
Map intent → V2 as:

- **UP (buy YES):** `side = "bid"`, `price = yesAsk` (dollars).
- **DOWN (buy NO):** `side = "ask"`, `price = 1 − noAsk` (dollars). *(sell YES at 1−noAsk ≡ buy NO at noAsk.)*

Worked examples:
- UP, YES ask = $0.54 → `{side:"bid", price:"0.5400"}`.
- DOWN, NO ask = $0.47 → sell YES at 1−0.47 = $0.53 → `{side:"ask", price:"0.5300"}`.

Sanity invariant for a test: a DOWN order's V2 `price` must equal `1 − noAsk` (≈ the YES
bid side), NOT `noAsk`. If a test ever sees DOWN producing `price ≈ noAsk`, the remap is wrong.

Formatting helpers:
- `price`: `Number(dollars).toFixed(4)` (4 dp string). Clamp to [0.01, 0.99] before formatting.
- `count`: `String(intCount)` or `intCount.toFixed(2)` — confirm which the API accepts (doc example uses `"10.00"`; send `"1.00"` style to be safe).

---

## Files to change (current symbols)

1. **`src/data/kalshi.js`** — no signing change needed (it signs `ts+METHOD+fullPath`, and
   `kalshiPost(path, body)` builds the signature from the path you pass). Just make sure the
   new path string flows through. `BASE_URL`/demo switch already correct.

2. **`src/execution/kalshiOrders.js`** — rewrite `placeFokBuy`:
   - `const ORDERS_PATH = "/trade-api/v2/portfolio/events/orders";`
   - New signature (intent-based, so the remap lives in one tested place):
     `placeFokBuy({ ticker, direction /* "UP"|"DOWN" */, askDollars, count, clientOrderId })`
     - compute `side`/`price` per the remap above;
     - body: `{ ticker, side, count: String(count)+".00" (or toFixed(2)), price: priceStr, time_in_force: "fill_or_kill", self_trade_prevention_type: "taker_at_cross", ...(clientOrderId && {client_order_id: clientOrderId}) }`;
   - parse response from the NEW shape: `fillCount = Math.floor(Number(raw.fill_count ?? "0"))`,
     `filled = fillCount >= count`, `orderId = raw.order_id ?? raw.client_order_id`,
     `avgFillPriceDollars = raw.average_fill_price != null ? Number(raw.average_fill_price) : null`,
     `avgFeeDollars = raw.average_fee_paid != null ? Number(raw.average_fee_paid) : null`.
   - Keep/adjust `dollarsToCents` only if still used elsewhere; the V2 path no longer needs cents.

3. **`src/execution/kalshiBot.js`** (`onKalshiSignal`) — stop computing `limitPriceCents`; pass
   intent instead. Currently:
   ```js
   const side = rec.side === "UP" ? "yes" : "no";
   const askDollars = side === "yes" ? snap.prices?.yes : snap.prices?.no;
   ...
   result = await _deps.orders.placeFokBuy({ ticker, side, count, limitPriceCents, clientOrderId });
   ```
   Change to:
   ```js
   const askDollars = rec.side === "UP" ? snap.prices?.yes : snap.prices?.no;
   if (!askDollars || askDollars <= 0) return { mode: "waiting", reason: "preco_kalshi_indisponivel" };
   ...
   result = await _deps.orders.placeFokBuy({ ticker: snap.ticker, direction: rec.side, askDollars, count, clientOrderId });
   ```
   Entry-price for the stored position: prefer `result.avgFillPriceDollars` when present, else
   `askDollars`. (For a DOWN/ask fill, `average_fill_price` is the YES sell price; the NO cost the
   bot paid is `1 − avgFillPrice`. Store the bot's economic entry price as the NO price for DOWN —
   i.e. `entryPrice = direction==="UP" ? avg : 1 − avg` — so paperStore/stats stay consistent with
   the paper convention. Add a test asserting this.)

4. **`test/kalshiOrders.test.js`** — update for V2 body + add the remap tests:
   - UP → body has `side:"bid"`, `price` = yesAsk (4dp string), `count` string, `self_trade_prevention_type` present, path `/portfolio/events/orders`.
   - DOWN → `side:"ask"`, `price` = `(1 − noAsk).toFixed(4)`.
   - response parsing reads string `fill_count`; `filled` correct at `fill_count >= count`.
   - 410/4xx error surfaces cleanly (mock `kalshiPost` to throw).

5. **`scripts/demo-order-test.mjs`** — update the test call to the new intent signature
   (`direction:"UP", askDollars:0.01` → bid @ $0.01). Expect **HTTP 201**, `filled:false`,
   FOK auto-cancel, no position, balance unchanged. This is the go/no-go mechanics check.

6. **`README.md`** / `.env.example` — note V2 endpoint; no new env vars.

---

## Verification (acceptance)

1. `<node24> --test` → all tests pass (was 68/68; add ~3–4 new ones).
2. `KALSHI_DEMO=true <node24> --env-file=.env scripts/demo-order-test.mjs` → **201**, not 410;
   `filled:false`, no position, balance still $50.00. (Demo book is empty, so it won't fill — that's expected; 201 proves the V2 POST round-trips.)
3. Default `EXECUTE_ORDERS` unset → `npm run kalshi:btc` still paper, 0 `REAL:` lines, behavior unchanged.
4. No secrets in the diff (`git diff` review; `.pem`/`.env` stay gitignored).

## Guardrails
- **Do not deposit real money** until step 2 returns 201.
- Demo cannot validate FILLS (empty book) — fill/settlement validation happens in early LIVE with
  $50, watching the first 3–5 trades by hand (confirm fill ≈ expected price, settlement credits,
  position zeroes). Kill-switch (`RISK_MAX_DRAWDOWN_PCT`, ~−20%) on before live.
- Live still gated by `EXECUTE_ORDERS=true` + `KALSHI_DEMO=false` + `KALSHI_LIVE_CONFIRM=true`.
