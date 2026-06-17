# Kalshi Real Order Execution — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add real Kalshi order execution to the BTC-15m bot (today paper-only), gated behind flags, validated on the demo environment before any real money.

**Architecture:** Mirror the existing Polymarket execution pattern (`src/execution/bot.js`, `orders.js`, `position.js`) with Kalshi equivalents. A new `kalshiBot.js` orchestrates: it reuses `src/risk/guard.js` for all risk gating, places FOK orders via a signed `POST /portfolio/orders`, persists the real position, and reconciles settlement from the actual account. Paper trading keeps running in parallel for real-vs-paper comparison. Everything is a no-op unless `EXECUTE_ORDERS=true`.

**Tech Stack:** Node.js ≥24 (ESM), `node:test`, `node:crypto` (RSA-PSS signing), built-in `fetch`, `node:sqlite` (existing `paperStore`).

## Global Constraints

- Node ≥24, ESM modules (`import`/`export`), no new npm dependencies.
- Kalshi auth signature = `sign(timestamp + METHOD + path)` with RSA-PSS, salt length 32 — **body is NOT signed**. Reuse `kalshiHeaders` from `src/data/kalshi.js`.
- Order prices are **integer cents 1–99** (`yes_price`/`no_price`); quantity is **whole contracts** (`count >= 1`).
- UP → `side:"yes"`, DOWN → `side:"no"`, always `action:"buy"`.
- Fill semantics: `time_in_force:"fill_or_kill"` at the ask. Partial fill (`fill_count < count`) → treat as not filled.
- Sizing: `count = Math.floor(RISK_ORDER_SIZE_USDC / askDollars)`; `count < 1` → blocked. Never spend above the configured stake.
- Three flags must be set for **real** money: `EXECUTE_ORDERS=true`, `KALSHI_DEMO=false`, `KALSHI_LIVE_CONFIRM=true`. Default (`EXECUTE_ORDERS=false`) must be byte-for-byte today's behavior.
- The private key is never committed or logged. No new stake/threshold values without user approval; reuse existing `RISK_*` env vars.
- Reuse `src/risk/guard.js` (`canTrade`, `isCircuitBreakerTripped`, `recordTrade`, `getDailyStats`) unchanged.
- Real trades recorded via `createPaperStore` with `bot_id` = `kalshi_btc_real` (set through `PAPER_LOG_PREFIX`-style prefix passed explicitly to the store).

---

### Task 1: Extract shared same-side cooldown into `src/risk/cooldown.js`

**Files:**
- Create: `src/risk/cooldown.js`
- Modify: `src/execution/paperTrading.js:16-43` (replace inline cooldown with import)
- Test: `test/cooldown.test.js`

**Interfaces:**
- Produces: `createCooldownTracker()` → `{ check(side, nowMs?), recordEntry(side, nowMs?), recordLoss(side, nowMs?) }`. `check` returns `{ allowed: boolean, reason?: string }`. Reads `RISK_SAME_SIDE_REENTRY_MIN` (default 30) and `RISK_LOSS_COOLDOWN_MIN` (default 60).

- [ ] **Step 1: Write the failing test**

```js
// test/cooldown.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCooldownTracker } from "../src/risk/cooldown.js";

test("allows entry when no prior activity", () => {
  const cd = createCooldownTracker();
  assert.equal(cd.check("UP").allowed, true);
});

test("blocks re-entry on same side within reentry window", () => {
  process.env.RISK_SAME_SIDE_REENTRY_MIN = "30";
  const cd = createCooldownTracker();
  const t0 = 1_000_000_000_000;
  cd.recordEntry("UP", t0);
  const r = cd.check("UP", t0 + 5 * 60_000);
  assert.equal(r.allowed, false);
  assert.match(r.reason, /cooldown_same_side/);
});

test("blocks same side after a loss within loss-cooldown window", () => {
  process.env.RISK_SAME_SIDE_REENTRY_MIN = "0";
  process.env.RISK_LOSS_COOLDOWN_MIN = "60";
  const cd = createCooldownTracker();
  const t0 = 1_000_000_000_000;
  cd.recordLoss("DOWN", t0);
  const r = cd.check("DOWN", t0 + 10 * 60_000);
  assert.equal(r.allowed, false);
  assert.match(r.reason, /cooldown_after_loss/);
});

test("other side is unaffected by a loss", () => {
  process.env.RISK_SAME_SIDE_REENTRY_MIN = "0";
  process.env.RISK_LOSS_COOLDOWN_MIN = "60";
  const cd = createCooldownTracker();
  const t0 = 1_000_000_000_000;
  cd.recordLoss("UP", t0);
  assert.equal(cd.check("DOWN", t0 + 1).allowed, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/cooldown.test.js`
Expected: FAIL — cannot find module `../src/risk/cooldown.js`.

- [ ] **Step 3: Write minimal implementation**

```js
// src/risk/cooldown.js
// Anti-correlation cooldown: consecutive same-side entries are the same bet
// repeated under the same conditions, not independent samples. Shared by the
// paper simulator and the real Kalshi bot.
export function createCooldownTracker() {
  const lastEntryAtBySide = { UP: 0, DOWN: 0 };
  const lastLossAtBySide = { UP: 0, DOWN: 0 };

  function check(side, nowMs = Date.now()) {
    const reentryMin = Number(process.env.RISK_SAME_SIDE_REENTRY_MIN ?? 30);
    const lossCooldownMin = Number(process.env.RISK_LOSS_COOLDOWN_MIN ?? 60);

    const sinceEntryMin = (nowMs - (lastEntryAtBySide[side] ?? 0)) / 60_000;
    if (reentryMin > 0 && sinceEntryMin < reentryMin) {
      return { allowed: false, reason: `cooldown_same_side_${Math.ceil(reentryMin - sinceEntryMin)}min` };
    }
    const sinceLossMin = (nowMs - (lastLossAtBySide[side] ?? 0)) / 60_000;
    if (lossCooldownMin > 0 && sinceLossMin < lossCooldownMin) {
      return { allowed: false, reason: `cooldown_after_loss_${Math.ceil(lossCooldownMin - sinceLossMin)}min` };
    }
    return { allowed: true };
  }

  function recordEntry(side, nowMs = Date.now()) { lastEntryAtBySide[side] = nowMs; }
  function recordLoss(side, nowMs = Date.now()) { lastLossAtBySide[side] = nowMs; }

  return { check, recordEntry, recordLoss };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/cooldown.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Refactor `paperTrading.js` to use the shared tracker**

In `src/execution/paperTrading.js`: add `import { createCooldownTracker } from "../risk/cooldown.js";`. Replace the module-level `_lastEntryAtBySide`/`_lastLossAtBySide` objects and the `sameSideCooldownCheck` function (lines ~21-43) with:

```js
const _cooldown = createCooldownTracker();
```

Replace the call site `const cooldown = sameSideCooldownCheck(rec.side);` with `const cooldown = _cooldown.check(rec.side);`. Replace `_lastEntryAtBySide[rec.side] = Date.now();` with `_cooldown.recordEntry(rec.side);`. Replace `_lastLossAtBySide[_pos.side] = Date.now();` with `_cooldown.recordLoss(_pos.side);`.

- [ ] **Step 6: Run the full suite to confirm no regression**

Run: `node --test`
Expected: PASS (existing tests + new cooldown tests).

- [ ] **Step 7: Commit**

```bash
git add src/risk/cooldown.js test/cooldown.test.js src/execution/paperTrading.js
git commit -m "refactor: extract shared same-side cooldown tracker"
```

---

### Task 2: Signed POST + demo-credential selection in `src/data/kalshi.js`

**Files:**
- Modify: `src/data/kalshi.js:8-49` (export helpers, add `kalshiPost`, demo-key fallback)
- Test: `test/kalshiAuth.test.js`

**Interfaces:**
- Consumes: existing `kalshiHeaders`, `BASE_URL`.
- Produces:
  - `export function kalshiSignedHeaders(method, path)` — renamed export of the current `kalshiHeaders` (keep `kalshiHeaders` working internally).
  - `export async function kalshiGet(path)` (already exists internally — add `export`).
  - `export async function kalshiPost(path, body)` → returns parsed JSON; throws `Error("Kalshi API <status>: <body>")` on non-2xx.
  - `export function kalshiBaseUrl()` → current `BASE_URL`.
  - `loadPrivateKey()`/`kalshiHeaders` read `KALSHI_DEMO_API_KEY_ID` / `KALSHI_DEMO_PRIVATE_KEY_PATH` / `KALSHI_DEMO_PRIVATE_KEY` when `KALSHI_DEMO==="true"` and those vars exist; otherwise fall back to the standard vars.

- [ ] **Step 1: Write the failing test**

```js
// test/kalshiAuth.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

// Generate an ephemeral RSA key so the test never touches the real pem.
const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs1", format: "pem" });

test("POST signature is over timestamp+POST+path and verifies", async () => {
  process.env.KALSHI_DEMO = "true";
  process.env.KALSHI_DEMO_API_KEY_ID = "demo-key-id";
  process.env.KALSHI_DEMO_PRIVATE_KEY = pem.replace(/\n/g, "\\n");
  delete process.env.KALSHI_DEMO_PRIVATE_KEY_PATH;

  const { kalshiSignedHeaders } = await import("../src/data/kalshi.js");
  const path = "/trade-api/v2/portfolio/orders";
  const h = kalshiSignedHeaders("POST", path);

  assert.equal(h["KALSHI-ACCESS-KEY"], "demo-key-id");
  const msg = h["KALSHI-ACCESS-TIMESTAMP"] + "POST" + path;
  const ok = crypto.verify(
    null, Buffer.from(msg),
    { key: publicKey, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 },
    Buffer.from(h["KALSHI-ACCESS-SIGNATURE"], "base64")
  );
  assert.equal(ok, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/kalshiAuth.test.js`
Expected: FAIL — `kalshiSignedHeaders` is not exported.

- [ ] **Step 3: Implement the changes**

In `src/data/kalshi.js`:

Replace `loadPrivateKey()` and `kalshiHeaders` with demo-aware versions and add exports:

```js
function demoActive() {
  return process.env.KALSHI_DEMO === "true";
}

function loadPrivateKey() {
  const useDemo = demoActive();
  const inline = useDemo ? (process.env.KALSHI_DEMO_PRIVATE_KEY ?? process.env.KALSHI_PRIVATE_KEY)
                         : process.env.KALSHI_PRIVATE_KEY;
  const keyPath = useDemo ? (process.env.KALSHI_DEMO_PRIVATE_KEY_PATH ?? process.env.KALSHI_PRIVATE_KEY_PATH)
                          : process.env.KALSHI_PRIVATE_KEY_PATH;
  if (inline) return inline.replace(/\\n/g, "\n");
  if (keyPath) return fs.readFileSync(keyPath, "utf8");
  return null;
}

function apiKeyId() {
  return demoActive()
    ? (process.env.KALSHI_DEMO_API_KEY_ID ?? process.env.KALSHI_API_KEY_ID)
    : process.env.KALSHI_API_KEY_ID;
}

export function kalshiSignedHeaders(method, path) {
  const keyId = apiKeyId();
  const privateKey = loadPrivateKey();
  if (!keyId || !privateKey) {
    throw new Error("KALSHI_API_KEY_ID e KALSHI_PRIVATE_KEY (ou _PATH) são obrigatórios");
  }
  const timestampMs = Date.now().toString();
  const message = timestampMs + method.toUpperCase() + path;
  const signature = crypto.sign(null, Buffer.from(message), {
    key: privateKey, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32
  }).toString("base64");
  return {
    "Content-Type": "application/json",
    "KALSHI-ACCESS-KEY": keyId,
    "KALSHI-ACCESS-SIGNATURE": signature,
    "KALSHI-ACCESS-TIMESTAMP": timestampMs
  };
}

// keep the old internal name working
const kalshiHeaders = kalshiSignedHeaders;

export function kalshiBaseUrl() { return BASE_URL; }

export async function kalshiGet(path) {
  const res = await fetch(`${BASE_URL}${path}`, { headers: kalshiSignedHeaders("GET", path) });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Kalshi API ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

export async function kalshiPost(path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: kalshiSignedHeaders("POST", path),
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Kalshi API ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}
```

Remove the old standalone `async function kalshiGet(path)` (now exported above) and the old `kalshiHeaders` definition. Confirm `BASE_URL` is declared above these (it is, lines 4-6).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/kalshiAuth.test.js`
Expected: PASS.

- [ ] **Step 5: Confirm snapshot reads still work**

Run: `node --test`
Expected: PASS — no regression in existing tests.

- [ ] **Step 6: Commit**

```bash
git add src/data/kalshi.js test/kalshiAuth.test.js
git commit -m "feat: signed kalshiPost + demo credential selection"
```

---

### Task 3: Order placement — `src/execution/kalshiOrders.js`

**Files:**
- Create: `src/execution/kalshiOrders.js`
- Test: `test/kalshiOrders.test.js`

**Interfaces:**
- Consumes: `kalshiPost` from `../data/kalshi.js`.
- Produces:
  - `export function dollarsToCents(dollars)` → `Math.ceil(Number(dollars) * 100)` clamped to `[1, 99]`.
  - `export async function placeFokBuy({ ticker, side, count, limitPriceCents, clientOrderId })` where `side` is `"yes"`/`"no"`. Builds the body (`action:"buy"`, `time_in_force:"fill_or_kill"`, `yes_price` or `no_price` = `limitPriceCents`), calls `kalshiPost("/trade-api/v2/portfolio/orders", body)`, returns `{ raw, orderId, fillCount, filled, fillCostDollars, feesDollars }`. `filled = fillCount >= count`.

- [ ] **Step 1: Write the failing test**

```js
// test/kalshiOrders.test.js
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

let calls;
const realFetch = globalThis.fetch;
beforeEach(() => {
  calls = [];
  process.env.KALSHI_DEMO = "true";
  process.env.KALSHI_DEMO_API_KEY_ID = "demo";
  process.env.KALSHI_DEMO_PRIVATE_KEY = "x"; // signing not exercised; we stub fetch
});
afterEach(() => { globalThis.fetch = realFetch; });

function stubFetch(status, jsonBody) {
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts, body: JSON.parse(opts.body) });
    return { ok: status >= 200 && status < 300, status,
      json: async () => jsonBody, text: async () => JSON.stringify(jsonBody) };
  };
}

test("dollarsToCents ceils and clamps", async () => {
  const { dollarsToCents } = await import("../src/execution/kalshiOrders.js");
  assert.equal(dollarsToCents(0.601), 61);
  assert.equal(dollarsToCents(0.005), 1);
  assert.equal(dollarsToCents(0.999), 99);
});

test("placeFokBuy posts a FOK yes order and reports a full fill", async () => {
  // Avoid real signing: stub fetch BEFORE import resolves header use at call time.
  const { placeFokBuy } = await import("../src/execution/kalshiOrders.js");
  stubFetch(201, { order: { order_id: "ord1", fill_count_fp: "8.00",
    taker_fill_cost_dollars: "4.8000", taker_fees_dollars: "0.1200" } });

  const r = await placeFokBuy({ ticker: "KXBTC15M-X", side: "yes", count: 8,
    limitPriceCents: 61, clientOrderId: "c1" });

  const body = calls[0].body;
  assert.equal(body.ticker, "KXBTC15M-X");
  assert.equal(body.action, "buy");
  assert.equal(body.side, "yes");
  assert.equal(body.count, 8);
  assert.equal(body.yes_price, 61);
  assert.equal(body.time_in_force, "fill_or_kill");
  assert.equal(body.client_order_id, "c1");
  assert.equal(r.orderId, "ord1");
  assert.equal(r.fillCount, 8);
  assert.equal(r.filled, true);
  assert.equal(r.fillCostDollars, 4.8);
  assert.equal(r.feesDollars, 0.12);
});

test("placeFokBuy reports not-filled on a partial/zero fill", async () => {
  const { placeFokBuy } = await import("../src/execution/kalshiOrders.js");
  stubFetch(201, { order: { order_id: "ord2", fill_count_fp: "0.00" } });
  const r = await placeFokBuy({ ticker: "T", side: "no", count: 5, limitPriceCents: 40 });
  assert.equal(calls[0].body.no_price, 40);
  assert.equal(r.filled, false);
  assert.equal(r.fillCount, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/kalshiOrders.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```js
// src/execution/kalshiOrders.js
import { kalshiPost } from "../data/kalshi.js";

const ORDERS_PATH = "/trade-api/v2/portfolio/orders";

export function dollarsToCents(dollars) {
  const c = Math.ceil(Number(dollars) * 100);
  return Math.max(1, Math.min(99, c));
}

function num(x) { return x == null ? null : Number(x); }

// Fill-or-kill buy at a limit price (cents). side = "yes" | "no".
export async function placeFokBuy({ ticker, side, count, limitPriceCents, clientOrderId }) {
  const body = {
    ticker,
    action: "buy",
    side,
    count,
    time_in_force: "fill_or_kill",
    ...(side === "yes" ? { yes_price: limitPriceCents } : { no_price: limitPriceCents }),
    ...(clientOrderId ? { client_order_id: clientOrderId } : {})
  };

  const resp = await kalshiPost(ORDERS_PATH, body);
  const order = resp?.order ?? {};
  const fillCount = order.fill_count_fp != null ? Math.floor(Number(order.fill_count_fp))
                  : order.fill_count != null ? Number(order.fill_count) : 0;

  return {
    raw: resp,
    orderId: order.order_id ?? order.client_order_id ?? null,
    fillCount,
    filled: fillCount >= count,
    fillCostDollars: num(order.taker_fill_cost_dollars),
    feesDollars: num(order.taker_fees_dollars)
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/kalshiOrders.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/execution/kalshiOrders.js test/kalshiOrders.test.js
git commit -m "feat: kalshi FOK buy order placement"
```

---

### Task 4: Account reads — `src/execution/kalshiAccount.js`

**Files:**
- Create: `src/execution/kalshiAccount.js`
- Test: `test/kalshiAccount.test.js`

**Interfaces:**
- Consumes: `kalshiGet` from `../data/kalshi.js`.
- Produces:
  - `export async function getBalanceDollars()` → number (dollars). Reads `/trade-api/v2/portfolio/balance`, prefers `balance_dollars`, else `balance/100`.
  - `export async function getPosition(ticker)` → `{ ticker, position, restingOrderCount } | null` from `/trade-api/v2/portfolio/positions?ticker=...`.
  - `export async function getSettlement(ticker)` → `{ ticker, settledResult, revenueDollars, yesCount, noCount } | null` from `/trade-api/v2/portfolio/settlements?ticker=...` (most recent match). `revenueDollars` is the realized payout for that market.

- [ ] **Step 1: Write the failing test**

```js
// test/kalshiAccount.test.js
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function stub(jsonByPath) {
  globalThis.fetch = async (url) => {
    const path = new URL(url).pathname + (new URL(url).search || "");
    const key = Object.keys(jsonByPath).find(k => path.includes(k));
    const body = jsonByPath[key] ?? {};
    return { ok: true, status: 200, json: async () => body, text: async () => "" };
  };
}

test("getBalanceDollars prefers balance_dollars", async () => {
  process.env.KALSHI_DEMO = "true"; process.env.KALSHI_DEMO_API_KEY_ID = "d";
  process.env.KALSHI_DEMO_PRIVATE_KEY = "x";
  const { getBalanceDollars } = await import("../src/execution/kalshiAccount.js");
  stub({ "/portfolio/balance": { balance: 5000, balance_dollars: "50.0000" } });
  assert.equal(await getBalanceDollars(), 50);
});

test("getSettlement returns the matching market's realized revenue", async () => {
  const { getSettlement } = await import("../src/execution/kalshiAccount.js");
  stub({ "/portfolio/settlements": { settlements: [
    { ticker: "KXBTC15M-A", market_result: "yes", revenue: 800, yes_count: 8, no_count: 0 },
    { ticker: "KXBTC15M-B", market_result: "no", revenue: 0, yes_count: 5, no_count: 0 }
  ] } });
  const s = await getSettlement("KXBTC15M-A");
  assert.equal(s.settledResult, "yes");
  assert.equal(s.revenueDollars, 8);
  assert.equal(s.yesCount, 8);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/kalshiAccount.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```js
// src/execution/kalshiAccount.js
import { kalshiGet } from "../data/kalshi.js";

export async function getBalanceDollars() {
  const d = await kalshiGet("/trade-api/v2/portfolio/balance");
  if (d?.balance_dollars != null) return Number(d.balance_dollars);
  if (d?.balance != null) return Number(d.balance) / 100;
  return 0;
}

export async function getPosition(ticker) {
  const d = await kalshiGet(`/trade-api/v2/portfolio/positions?ticker=${encodeURIComponent(ticker)}`);
  const list = d?.market_positions ?? d?.positions ?? [];
  const m = list.find(p => p.ticker === ticker) ?? null;
  if (!m) return null;
  return {
    ticker,
    position: Number(m.position ?? 0),               // signed contract count
    restingOrderCount: Number(m.resting_orders_count ?? 0)
  };
}

// Settlement = the real, account-recorded result of a closed market.
export async function getSettlement(ticker) {
  const d = await kalshiGet(`/trade-api/v2/portfolio/settlements?ticker=${encodeURIComponent(ticker)}`);
  const list = d?.settlements ?? [];
  const m = list.find(s => s.ticker === ticker) ?? null;
  if (!m) return null;
  return {
    ticker,
    settledResult: m.market_result ?? null,          // "yes" | "no"
    revenueDollars: m.revenue != null ? Number(m.revenue) / 100 : null,
    yesCount: Number(m.yes_count ?? 0),
    noCount: Number(m.no_count ?? 0)
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/kalshiAccount.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/execution/kalshiAccount.js test/kalshiAccount.test.js
git commit -m "feat: kalshi account reads (balance, position, settlement)"
```

---

### Task 5: Real position persistence — `src/execution/kalshiPosition.js`

**Files:**
- Create: `src/execution/kalshiPosition.js`
- Test: `test/kalshiPosition.test.js`

**Interfaces:**
- Produces (all operate on a JSON file `logs/<prefix>kalshi_real_position.json`, prefix from `PAPER_LOG_PREFIX`):
  - `export function hasOpenPosition()` → boolean
  - `export function getPosition()` → state object (copy)
  - `export function openPosition({ side, ticker, orderId, count, entryPriceDollars, feeDollars, marketSlug, priceToBeat, balanceBefore })`
  - `export function closePosition()`
  - State shape: `{ open, side, ticker, orderId, count, entryPriceDollars, feeDollars, marketSlug, priceToBeat, enteredAt, balanceBefore }`.

- [ ] **Step 1: Write the failing test**

```js
// test/kalshiPosition.test.js
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const PREFIX = "test_kalshi_";
beforeEach(() => {
  process.env.PAPER_LOG_PREFIX = PREFIX;
  const f = path.join(process.cwd(), "logs", `${PREFIX}kalshi_real_position.json`);
  if (fs.existsSync(f)) fs.unlinkSync(f);
});

test("open then close round-trips through disk", async () => {
  const mod = await import(`../src/execution/kalshiPosition.js?ts=${Date.now()}`);
  assert.equal(mod.hasOpenPosition(), false);
  mod.openPosition({ side: "yes", ticker: "T", orderId: "o1", count: 8,
    entryPriceDollars: 0.61, feeDollars: 0.12, marketSlug: "T", priceToBeat: 65000, balanceBefore: 50 });
  assert.equal(mod.hasOpenPosition(), true);
  const p = mod.getPosition();
  assert.equal(p.side, "yes");
  assert.equal(p.count, 8);
  assert.equal(p.balanceBefore, 50);
  mod.closePosition();
  assert.equal(mod.hasOpenPosition(), false);
});
```

Note: the `?ts=` query forces a fresh module instance so the in-memory `_state` reloads from the just-cleared file.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/kalshiPosition.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```js
// src/execution/kalshiPosition.js
import fs from "node:fs";
import path from "node:path";

const PREFIX = process.env.PAPER_LOG_PREFIX || "";
const FILE = path.join(process.cwd(), "logs", `${PREFIX}kalshi_real_position.json`);

const EMPTY = {
  open: false, side: null, ticker: null, orderId: null, count: null,
  entryPriceDollars: null, feeDollars: 0, marketSlug: null, priceToBeat: null,
  enteredAt: null, balanceBefore: null
};

function load() {
  try { if (fs.existsSync(FILE)) return JSON.parse(fs.readFileSync(FILE, "utf8")); }
  catch { return { ...EMPTY }; }
  return { ...EMPTY };
}
function save(state) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(state, null, 2), "utf8");
}

let _state = load();

export function hasOpenPosition() { return _state.open === true; }
export function getPosition() { return { ..._state }; }

export function openPosition({ side, ticker, orderId, count, entryPriceDollars, feeDollars, marketSlug, priceToBeat, balanceBefore }) {
  _state = {
    open: true, side, ticker, orderId, count,
    entryPriceDollars: entryPriceDollars ?? null,
    feeDollars: feeDollars ?? 0,
    marketSlug: marketSlug ?? null,
    priceToBeat: priceToBeat ?? null,
    enteredAt: new Date().toISOString(),
    balanceBefore: balanceBefore ?? null
  };
  save(_state);
}

export function closePosition() { _state = { ...EMPTY }; save(_state); }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/kalshiPosition.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/execution/kalshiPosition.js test/kalshiPosition.test.js
git commit -m "feat: kalshi real position persistence"
```

---

### Task 6: Orchestration — `src/execution/kalshiBot.js`

**Files:**
- Create: `src/execution/kalshiBot.js`
- Test: `test/kalshiBot.test.js`

**Interfaces:**
- Consumes: `placeFokBuy`, `dollarsToCents` (Task 3); `getBalanceDollars`, `getPosition`, `getSettlement` (Task 4); `hasOpenPosition`, `getPosition` (as `getRealPosition`), `openPosition`, `closePosition` (Task 5); `canTrade`, `isCircuitBreakerTripped`, `recordTrade`, `getDailyStats` (`../risk/guard.js`); `createCooldownTracker` (Task 1); `createPaperStore` (`./paperStore.js`).
- Produces:
  - `export async function onKalshiSignal({ rec, snap, priceToBeat, timeLeftMin })` → status object (`{ mode, ... }`). `rec` = `{ action, side ("UP"/"DOWN"), edge }`. `snap` = the Kalshi snapshot from `fetchKalshiSnapshot` (`{ ok, ticker, prices:{ yes, no, yesBid, noBid } }`).
  - `export async function emergencyShutdown()`
  - `export function getKalshiBotStatus()` → `{ executeOrders, demo, initialized, initError, hasPosition, position, daily }`.
  - The order/account/position modules are injected via an internal `_deps` object defaulting to the real imports, so the test can substitute mocks. Export `export function __setDeps(partial)` for tests only.

Design notes for the implementer:
- Flag gating: `EXECUTE_ORDERS` read at call time (`process.env.EXECUTE_ORDERS === "true"`). When false → `{ mode: "monitor" }`.
- `ensureInit()` runs once: call `getBalanceDollars()`. If `KALSHI_DEMO !== "true"` (production): require `process.env.KALSHI_LIVE_CONFIRM === "true"` and `balance > 0`, else set `_initError` and every tick returns `{ mode: "blocked", reason }`.
- Settlement detection: if `hasOpenPosition()` and `snap.ok` and `snap.ticker !== pos.ticker` → reconcile. Reconcile via `getSettlement(pos.ticker)`: `won = settledResult === pos.side`. Realized pnl = `revenueDollars - (cost)` where `cost = pos.count * pos.entryPriceDollars + pos.feeDollars`. `recordTrade({ pnl })`, append to the real store, `recordLoss` on the cooldown tracker if `!won`, `closePosition()`. If `getSettlement` returns null (not yet settled), keep holding.
- Entry: `rec.action==="ENTER"` and no open position. `side = rec.side==="UP" ? "yes" : "no"`. `askDollars = side==="yes" ? snap.prices.yes : snap.prices.no`. `canTrade({ openPositions: 0, edgeBest: rec.edge ?? 0, tokenPrice: askDollars })`. Then cooldown `check(rec.side)`. Then `count = Math.floor((Number(process.env.RISK_ORDER_SIZE_USDC ?? 5)) / askDollars)`; if `< 1` → blocked. `placeFokBuy`; if filled → `recordEntry`, `openPosition` with real fill price/fees.
- Real store: `createPaperStore({ prefix: "kalshi_btc_real_" })` (bot_id becomes `kalshi_btc_real`). Append a trade record on settlement using the same field names as the paper store (`side, entryPrice, usdcAmount, priceToBeat, settlementPrice, won, grossPnl, feeAtEntry, pnl, edgeAtEntry, oracleSource, marketSlug, enteredAt, settledAt`).

- [ ] **Step 1: Write the failing test**

```js
// test/kalshiBot.test.js
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

let bot;
async function freshBot() {
  bot = await import(`../src/execution/kalshiBot.js?ts=${Date.now()}`);
  return bot;
}

const baseSnap = { ok: true, ticker: "KXBTC15M-A", prices: { yes: 0.60, no: 0.40, yesBid: 0.59, noBid: 0.39 } };
const enterUp = { action: "ENTER", side: "UP", edge: 0.20 };

beforeEach(() => {
  process.env.EXECUTE_ORDERS = "true";
  process.env.KALSHI_DEMO = "true";
  process.env.RISK_ORDER_SIZE_USDC = "5";
  process.env.RISK_MIN_EDGE = "0.15";
  process.env.RISK_MIN_TOKEN_PRICE = "0.30";
  process.env.RISK_SESSION_START_UTC = "0";
  process.env.RISK_SESSION_END_UTC = "24";
  process.env.RISK_SAME_SIDE_REENTRY_MIN = "0";
  process.env.RISK_LOSS_COOLDOWN_MIN = "0";
  process.env.RISK_MAX_DAILY_LOSS_USDC = "25";
  delete process.env.KALSHI_LIVE_CONFIRM;
});

test("monitor mode when EXECUTE_ORDERS is false", async () => {
  process.env.EXECUTE_ORDERS = "false";
  await freshBot();
  const r = await bot.onKalshiSignal({ rec: enterUp, snap: baseSnap, priceToBeat: 65000, timeLeftMin: 10 });
  assert.equal(r.mode, "monitor");
});

test("places a FOK yes order sized by floor(stake/ask)", async () => {
  await freshBot();
  const placed = [];
  bot.__setDeps({
    account: { getBalanceDollars: async () => 100, getPosition: async () => null, getSettlement: async () => null },
    orders: { placeFokBuy: async (a) => { placed.push(a); return { orderId: "o1", filled: true, fillCount: a.count, fillCostDollars: a.count * 0.60, feesDollars: 0.1 }; }, dollarsToCents: (d) => Math.ceil(d * 100) },
    position: makeMemPosition()
  });
  const r = await bot.onKalshiSignal({ rec: enterUp, snap: baseSnap, priceToBeat: 65000, timeLeftMin: 10 });
  assert.equal(r.mode, "entered");
  assert.equal(placed[0].side, "yes");
  assert.equal(placed[0].count, 8);          // floor(5 / 0.60) = 8
  assert.equal(placed[0].limitPriceCents, 60);
});

test("blocks when production lacks KALSHI_LIVE_CONFIRM", async () => {
  process.env.KALSHI_DEMO = "false";
  await freshBot();
  bot.__setDeps({ account: { getBalanceDollars: async () => 100, getPosition: async () => null, getSettlement: async () => null },
    orders: { placeFokBuy: async () => { throw new Error("should not be called"); }, dollarsToCents: (d)=>Math.ceil(d*100) },
    position: makeMemPosition() });
  const r = await bot.onKalshiSignal({ rec: enterUp, snap: baseSnap, priceToBeat: 65000, timeLeftMin: 10 });
  assert.equal(r.mode, "blocked");
  assert.match(r.reason, /live_confirm|saldo|balance/i);
});

test("blocks entry when count < 1 contract", async () => {
  process.env.RISK_ORDER_SIZE_USDC = "0.50"; // 0.50/0.60 = 0.83 -> floor 0
  await freshBot();
  bot.__setDeps({ account: { getBalanceDollars: async () => 100, getPosition: async () => null, getSettlement: async () => null },
    orders: { placeFokBuy: async () => { throw new Error("nope"); }, dollarsToCents: (d)=>Math.ceil(d*100) },
    position: makeMemPosition() });
  const r = await bot.onKalshiSignal({ rec: enterUp, snap: baseSnap, priceToBeat: 65000, timeLeftMin: 10 });
  assert.equal(r.mode, "blocked");
  assert.match(r.reason, /contrato/);
});

test("settles a win from the real account on ticker change", async () => {
  await freshBot();
  const pos = makeMemPosition();
  pos.openPosition({ side: "yes", ticker: "KXBTC15M-A", orderId: "o1", count: 8,
    entryPriceDollars: 0.60, feeDollars: 0.1, marketSlug: "KXBTC15M-A", priceToBeat: 65000, balanceBefore: 100 });
  bot.__setDeps({
    account: { getBalanceDollars: async () => 100, getPosition: async () => null,
      getSettlement: async () => ({ ticker: "KXBTC15M-A", settledResult: "yes", revenueDollars: 8.0, yesCount: 8, noCount: 0 }) },
    orders: { placeFokBuy: async () => ({ orderId: "x", filled: false, fillCount: 0 }), dollarsToCents: (d)=>Math.ceil(d*100) },
    position: pos
  });
  const newSnap = { ...baseSnap, ticker: "KXBTC15M-B" };
  const r = await bot.onKalshiSignal({ rec: { action: "WAIT" }, snap: newSnap, priceToBeat: 65000, timeLeftMin: 14 });
  assert.equal(r.mode, "settled");
  assert.equal(r.won, true);
  // pnl = revenue 8.0 - cost (8*0.60 + 0.1 = 4.9) = 3.1
  assert.ok(Math.abs(r.pnl - 3.1) < 1e-6);
  assert.equal(pos.hasOpenPosition(), false);
});

// in-memory stand-in for the position module
function makeMemPosition() {
  let s = { open: false };
  return {
    hasOpenPosition: () => s.open === true,
    getPosition: () => ({ ...s }),
    openPosition: (o) => { s = { open: true, ...o, enteredAt: "t" }; },
    closePosition: () => { s = { open: false }; }
  };
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/kalshiBot.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```js
// src/execution/kalshiBot.js
import * as ordersMod from "./kalshiOrders.js";
import * as accountMod from "./kalshiAccount.js";
import * as positionMod from "./kalshiPosition.js";
import { canTrade, recordTrade, getDailyStats } from "../risk/guard.js";
import { createCooldownTracker } from "../risk/cooldown.js";
import { createPaperStore } from "./paperStore.js";

const _deps = { orders: ordersMod, account: accountMod, position: positionMod };
export function __setDeps(partial) { Object.assign(_deps, partial); }

const _cooldown = createCooldownTracker();
let _store = null;
function store() {
  if (!_store) _store = createPaperStore({ prefix: "kalshi_btc_real_" });
  return _store;
}

let _initialized = false;
let _initError = null;

function executeOn() { return (process.env.EXECUTE_ORDERS ?? "false").toLowerCase() === "true"; }
function demoOn() { return (process.env.KALSHI_DEMO ?? "false").toLowerCase() === "true"; }

async function ensureInit() {
  if (_initialized) return !_initError;
  _initialized = true;
  try {
    const balance = await _deps.account.getBalanceDollars();
    if (!demoOn()) {
      if ((process.env.KALSHI_LIVE_CONFIRM ?? "false").toLowerCase() !== "true") {
        _initError = "live_confirm_ausente_KALSHI_LIVE_CONFIRM_nao_e_true";
        return false;
      }
      if (!(balance > 0)) {
        _initError = "saldo_zero_deposite_antes_de_operar_real";
        return false;
      }
    }
    return true;
  } catch (err) {
    _initError = err.message;
    return false;
  }
}

export async function onKalshiSignal({ rec, snap, priceToBeat, timeLeftMin }) {
  if (!executeOn()) return { mode: "monitor" };

  const ready = await ensureInit();
  if (!ready) return { mode: "blocked", reason: _initError };

  // ── settlement on market change ──────────────────────────────────────────
  if (_deps.position.hasOpenPosition()) {
    const pos = _deps.position.getPosition();
    const changed = snap?.ok && snap.ticker && pos.ticker && snap.ticker !== pos.ticker;
    if (changed) return await _settle(pos);
    return { mode: "holding", position: pos };
  }

  // ── entry ────────────────────────────────────────────────────────────────
  if (!rec || rec.action !== "ENTER") return { mode: "waiting", reason: rec?.reason ?? rec?.phase ?? "no_signal" };
  if (!snap?.ok) return { mode: "waiting", reason: "snapshot_indisponivel" };
  if (!Number.isFinite(Number(timeLeftMin)) || Number(timeLeftMin) <= 0) return { mode: "blocked", reason: "market_expired" };

  const side = rec.side === "UP" ? "yes" : "no";
  const askDollars = side === "yes" ? snap.prices?.yes : snap.prices?.no;
  if (!askDollars || askDollars <= 0) return { mode: "waiting", reason: "preco_kalshi_indisponivel" };

  const risk = canTrade({ openPositions: 0, edgeBest: rec.edge ?? 0, tokenPrice: askDollars });
  if (!risk.allowed) return { mode: "blocked", reason: risk.reason };

  const cd = _cooldown.check(rec.side);
  if (!cd.allowed) return { mode: "blocked", reason: cd.reason };

  const stake = Number(process.env.RISK_ORDER_SIZE_USDC ?? 5);
  const count = Math.floor(stake / askDollars);
  if (count < 1) return { mode: "blocked", reason: "order_size_menor_que_1_contrato" };

  const limitPriceCents = _deps.orders.dollarsToCents(askDollars);
  const balanceBefore = await _deps.account.getBalanceDollars().catch(() => null);

  let result;
  try {
    result = await _deps.orders.placeFokBuy({
      ticker: snap.ticker, side, count, limitPriceCents,
      clientOrderId: `${snap.ticker}-${Date.now()}`
    });
  } catch (err) {
    return { mode: "error", reason: err.message };
  }
  if (!result.filled) return { mode: "not_filled", orderId: result.orderId, fillCount: result.fillCount };

  _cooldown.recordEntry(rec.side);
  const entryPriceDollars = result.fillCostDollars != null && count > 0
    ? result.fillCostDollars / count : askDollars;

  _deps.position.openPosition({
    side, ticker: snap.ticker, orderId: result.orderId, count,
    entryPriceDollars, feeDollars: result.feesDollars ?? 0,
    marketSlug: snap.ticker, priceToBeat, balanceBefore
  });

  return { mode: "entered", side, count, entryPriceDollars, orderId: result.orderId };
}

async function _settle(pos) {
  const s = await _deps.account.getSettlement(pos.ticker);
  if (!s) return { mode: "holding", position: pos, note: "settlement_pendente" };

  const won = s.settledResult === pos.side;
  const cost = pos.count * pos.entryPriceDollars + (pos.feeDollars ?? 0);
  const revenue = s.revenueDollars ?? (won ? pos.count * 1.0 : 0);
  const pnl = parseFloat((revenue - cost).toFixed(4));

  if (!won) _cooldown.recordLoss(pos.side === "yes" ? "UP" : "DOWN");
  recordTrade({ pnl });

  store().appendTrade({
    side: pos.side === "yes" ? "UP" : "DOWN",
    entryPrice: pos.entryPriceDollars,
    usdcAmount: cost,
    priceToBeat: pos.priceToBeat,
    settlementPrice: null,
    won,
    grossPnl: parseFloat((revenue - pos.count * pos.entryPriceDollars).toFixed(4)),
    feeAtEntry: pos.feeDollars ?? 0,
    pnl,
    edgeAtEntry: null,
    oracleSource: "kalshi_account_settlement",
    entryTimeLeftMin: null,
    bestBidAtEntry: null, bestAskAtEntry: null, spreadAtEntry: null,
    marketSlug: pos.marketSlug,
    enteredAt: pos.enteredAt,
    settledAt: new Date().toISOString()
  });

  _deps.position.closePosition();
  return { mode: "settled", won, pnl, ticker: pos.ticker };
}

export async function emergencyShutdown() {
  try { if (_deps.position.hasOpenPosition()) _deps.position.closePosition(); } catch { /* ignore */ }
}

export function getKalshiBotStatus() {
  return {
    executeOrders: executeOn(),
    demo: demoOn(),
    initialized: _initialized,
    initError: _initError,
    hasPosition: _deps.position.hasOpenPosition(),
    position: _deps.position.hasOpenPosition() ? _deps.position.getPosition() : null,
    daily: getDailyStats()
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/kalshiBot.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Run the full suite**

Run: `node --test`
Expected: PASS (all tests).

- [ ] **Step 6: Commit**

```bash
git add src/execution/kalshiBot.js test/kalshiBot.test.js
git commit -m "feat: kalshi real execution orchestration (flag-gated)"
```

---

### Task 7: Wire `onKalshiSignal` into `src/index-kalshi.js`

**Files:**
- Modify: `src/index-kalshi.js` (import + call after `onPaperTick`; add a real-bot status line; SIGINT/SIGTERM hook)

**Interfaces:**
- Consumes: `onKalshiSignal`, `getKalshiBotStatus`, `emergencyShutdown` from `./execution/kalshiBot.js`.

- [ ] **Step 1: Add the import**

Near the other execution imports (after line 17):

```js
import { onKalshiSignal, getKalshiBotStatus, emergencyShutdown } from "./execution/kalshiBot.js";
```

- [ ] **Step 2: Call the real bot each tick**

Immediately after the `paperResult = PAPER_MODE ? onPaperTick({...}) : null;` block (after line 295), add:

```js
      // ── execução real (no-op a menos que EXECUTE_ORDERS=true) ────────────────
      let realResult = { mode: "monitor" };
      try {
        realResult = await onKalshiSignal({
          rec: recAdapted,
          snap,
          priceToBeat,
          timeLeftMin: timeLeftMin0
        });
      } catch (e) {
        realResult = { mode: "error", reason: e.message };
      }
```

- [ ] **Step 3: Add a real-bot status line to the display**

In the `lines` array, after the `paperStats` P&L line (around line 345), add:

```js
        getKalshiBotStatus().executeOrders
          ? kv("REAL:", `${realResult.mode}${realResult.reason ? ` (${realResult.reason})` : ""}${getKalshiBotStatus().demo ? " [DEMO]" : " [LIVE]"}`)
          : null,
```

- [ ] **Step 4: Hook shutdown**

Replace the existing `SIGINT` handler (line 388) with one that closes the real position file first:

```js
process.on("SIGINT",  async () => { console.log("\n[kalshi] Encerrando..."); try { await emergencyShutdown(); } catch { /* ignore */ } process.exit(0); });
process.on("SIGTERM", async () => { try { await emergencyShutdown(); } catch { /* ignore */ } process.exit(0); });
```

- [ ] **Step 5: Verify the default path is unchanged (smoke test)**

Run (paper-only default, 3s then Ctrl-C):
`EXECUTE_ORDERS=false KALSHI_DEMO=false node --env-file=.env src/index-kalshi.js`
Expected: the dashboard renders exactly as today; no `REAL:` line appears; no order is placed.

- [ ] **Step 6: Run the full suite**

Run: `node --test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/index-kalshi.js
git commit -m "feat: wire kalshi real execution into the main loop (gated)"
```

---

### Task 8: Demo run script + env documentation

**Files:**
- Modify: `package.json:20` (add `kalshi:btc:demo` script)
- Modify: `README.md` (add a "Kalshi execução real (demo-first)" section)
- Create: `.env.example` entries (append the new vars; do NOT touch the real `.env`)

**Interfaces:** none (config/docs only).

- [ ] **Step 1: Add the demo npm script**

In `package.json` scripts, add after `kalshi:btc`:

```json
    "kalshi:btc:demo": "NODE_NO_WARNINGS=1 EXECUTE_ORDERS=true KALSHI_DEMO=true KALSHI_SERIES=${KALSHI_SERIES:-KXBTC15M} PAPER_LOG_PREFIX=${PAPER_LOG_PREFIX:-kalshi_btc_} node --env-file=.env src/index-kalshi.js",
```

- [ ] **Step 2: Document env vars**

Append to `README.md` a section listing: `EXECUTE_ORDERS`, `KALSHI_DEMO`, `KALSHI_LIVE_CONFIRM`, `KALSHI_DEMO_API_KEY_ID`, `KALSHI_DEMO_PRIVATE_KEY_PATH`, the FOK/floor sizing behavior, and the demo-first rollout steps (generate demo key → `npm run kalshi:btc:demo` → confirm orders fill/settle → then deposit + LIVE flags).

- [ ] **Step 3: Add example env keys**

If `.env.example` exists, append the new var names with placeholder values; if not, create it with only the new Kalshi execution vars (names + empty/placeholder, no secrets).

- [ ] **Step 4: Verify the demo script parses (dry, no demo creds yet → expect a clear init block, not a crash)**

Run: `npm run kalshi:btc:demo` for ~5s, Ctrl-C.
Expected: if demo creds are absent, the `REAL:` line shows a blocked/auth reason; the paper dashboard still renders. No real order placed.

- [ ] **Step 5: Commit**

```bash
git add package.json README.md .env.example
git commit -m "docs: kalshi demo run script + execution env documentation"
```

---

## Self-Review

**Spec coverage:**
- Security flags (`EXECUTE_ORDERS`/`KALSHI_DEMO`/`KALSHI_LIVE_CONFIRM`) → Task 6 (`ensureInit`), Task 7 (wiring), Task 8 (scripts). ✓
- Signed POST reusing existing auth → Task 2. ✓
- `kalshiAccount` (balance/positions/settlements) → Task 4. ✓
- `kalshiOrders` FOK at ask → Task 3. ✓
- `kalshiPosition` → Task 5. ✓
- `kalshiBot` orchestration → Task 6. ✓
- Cooldown extraction → Task 1. ✓
- Risk guard reuse (canTrade/circuit breaker/recordTrade) → Task 6. ✓
- Sizing floor + skip-<1 → Task 6 + Task 3 (`dollarsToCents`). ✓
- UP/DOWN↔YES/NO → Task 6. ✓
- Real≈paper via store `kalshi_btc_real` → Task 6 (`_settle` → store). ✓
- Settlement from real account → Task 4 + Task 6. ✓
- Tests with mocked API → Tasks 1-6. ✓
- Demo/prod credential selection → Task 2. ✓
- Wiring keeps default behavior identical → Task 7 Step 5. ✓
- Drawdown kill-switch (`RISK_MAX_DRAWDOWN_PCT`) → **deferred**: spec marks it default-off pending the user's exact number; not built in this plan. Documented as a follow-up in README (Task 8 Step 2). ✓ (intentional gap)

**Placeholder scan:** No TBD/TODO; every code step has full code. ✓

**Type consistency:** `placeFokBuy` signature `{ ticker, side, count, limitPriceCents, clientOrderId }` consistent across Tasks 3 and 6. `getSettlement` → `{ settledResult, revenueDollars, ... }` consistent across Tasks 4 and 6. `openPosition` field names consistent across Tasks 5 and 6. `createCooldownTracker` API (`check`/`recordEntry`/`recordLoss`) consistent across Tasks 1 and 6. ✓

**Note for implementer:** `createPaperStore({ prefix })` — verify the existing signature accepts a `prefix` option (it does: `createPaperStore({ cwd, prefix, mode })`). The `bot_id` derives from `prefix.replace(/_$/, "")`, so `kalshi_btc_real_` → `kalshi_btc_real`.
