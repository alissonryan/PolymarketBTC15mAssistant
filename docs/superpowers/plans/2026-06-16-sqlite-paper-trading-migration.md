# SQLite Paper-Trading Migration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate paper-trading persistence from per-bot JSON files to a single SQLite `logs/trades.db`, behind an env-selectable store mode (`json` | `dual` | `sqlite`) so the cutover is a config flip, never a risky code change.

**Architecture:** A new `src/execution/paperStore.js` factory owns all persistence (schema, connection, read/write of trades/positions/voids). `paperTrading.js` keeps every trade-logic line and just delegates persistence to one store instance. Mode `json` (default) preserves today's behavior exactly; `dual` writes both JSON and SQLite while JSON stays canonical (read source); `sqlite` makes SQLite canonical. An importer backfills existing JSON into the DB and a comparison script proves zero divergence during the dual-write window.

**Tech Stack:** Node **v24.11.0** (ESM), `node --test`, built-in **`node:sqlite`** (`DatabaseSync`). Decision changed from `better-sqlite3`: it has no prebuilt binary for macOS arm64 + Node 20 and fails to compile from source (broken Command Line Tools SDK — `'climits' file not found`). `node:sqlite` is built into Node 22.5+ (no flag on v24), needs no native build, and works the same on the Ubuntu VPS with zero build toolchain. It is still flagged "experimental" (prints an `ExperimentalWarning` to stderr), but the API surface used here (`DatabaseSync`, `prepare/run/get/all`, `exec`) is small and stable in practice.

**Spec:** `docs/superpowers/specs/2026-06-16-sqlite-paper-trading-migration-design.md`

---

## File Structure

- **Create** `src/execution/paperStore.js` — persistence factory `createPaperStore({cwd, prefix, mode})`. Owns SQL schema, the `better-sqlite3` connection (WAL + busy_timeout), trade/position/void read+write, and the JSON-mode fallback. Single responsibility: persistence.
- **Modify** `src/execution/paperTrading.js` — replace inline `loadJson`/`saveJson`/`appendTrade`/`loadHistory` + initial position load with one `createPaperStore()` instance; record frozen-oracle voids via the store. No trade-logic change.
- **Create** `scripts/import-json-to-sqlite.js` — idempotent backfill of existing `logs/*_paper_trades.json` and `*_paper_position.json` into `trades.db`.
- **Create** `scripts/compare-stores.js` — reads JSON and SQLite for each bot, reports any divergence (exit non-zero if mismatch).
- **Create** `scripts/backup-db.sh` — dated copy of `logs/trades.db` to a backup dir outside the repo.
- **Create** `test/paperStore.test.js` — store round-trip (sqlite + dual), importer idempotency, comparison detection.
- **Modify** `package.json` — add `better-sqlite3` dep; add `import:sqlite` and `compare:stores` scripts.

`bot_id` is derived from `PAPER_LOG_PREFIX` by stripping the trailing `_` (e.g. `poly_btc_15m_` → `poly_btc_15m`). The lock file (`*_paper.lock`) stays file-based — out of scope.

**Node version:** all `node`/`npm` commands in this plan must run on **Node v24.11.0** (`nvm use 24` first). The repo currently runs on Node 20; this migration moves it to Node 24 because `node:sqlite` requires it.

---

### Task 1: Pin Node 24 and verify node:sqlite

**Files:**
- Create: `.nvmrc`
- Modify: `package.json` (add `engines`, suppress ExperimentalWarning in bot scripts)

- [ ] **Step 1: Pin the Node version**

Create `.nvmrc` with exactly:
```
v24.11.0
```

Run: `nvm use` (from repo root)
Expected: `Now using node v24.11.0`

- [ ] **Step 2: Smoke-test the built-in driver**

Run:
```bash
node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(':memory:');db.exec('PRAGMA journal_mode=WAL');db.exec('CREATE TABLE t(x)');db.prepare('INSERT INTO t VALUES (?)').run(1);console.log('rows',db.prepare('SELECT count(*) c FROM t').get().c)" 2>&1
```
Expected: `rows 1` (an `ExperimentalWarning` line on stderr is fine).

- [ ] **Step 3: Declare the engine and silence the warning in bot scripts**

In `package.json`, add a top-level `engines` block:
```json
  "engines": { "node": ">=24" },
```

Add `NODE_NO_WARNINGS=1` to the three bot scripts so the ExperimentalWarning doesn't spam the logs. Example for the 5m script (apply the same prefix to `polymarket:btc:15m` and `kalshi:btc`):
```json
    "polymarket:btc:5m": "NODE_NO_WARNINGS=1 CANDLE_WINDOW_MINUTES=5 EXECUTE_ORDERS=false PAPER_TRADING=true PAPER_LOG_PREFIX=${PAPER_LOG_PREFIX:-poly_btc_5m_} node --env-file=.env src/index.js",
```

- [ ] **Step 4: Verify core deps load on Node 24**

Run:
```bash
node -e "Promise.all([import('ws'),import('ethers'),import('undici'),import('dotenv'),import('@polymarket/clob-client'),import('viem')]).then(()=>console.log('deps OK')).catch(e=>{console.error('FAIL',e.message);process.exit(1)})"
```
Expected: `deps OK`

- [ ] **Step 5: Commit**

```bash
git add .nvmrc package.json
git commit -m "build: pin Node 24 for built-in node:sqlite; silence experimental warning"
```

---

### Task 2: Create paperStore with SQLite schema and modes (TDD)

**Files:**
- Create: `src/execution/paperStore.js`
- Test: `test/paperStore.test.js`

- [ ] **Step 1: Write the failing test — sqlite round-trip + dual-write**

Create `test/paperStore.test.js`:

```js
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createPaperStore } from "../src/execution/paperStore.js";

function tradeFixture(overrides = {}) {
  return {
    side: "UP", entryPrice: 0.55, usdcAmount: 5, priceToBeat: 63000.5,
    settlementPrice: 63010.2, won: true, grossPnl: 4.09, feeAtEntry: 0.02,
    pnl: 4.07, edgeAtEntry: 0.06, oracleSource: "binance", entryTimeLeftMin: 7,
    bestBidAtEntry: 0.54, bestAskAtEntry: 0.56, spreadAtEntry: 0.02,
    marketSlug: "btc-updown-15m-123", enteredAt: "2026-06-16T10:00:00.000Z",
    settledAt: "2026-06-16T10:15:00.000Z", ...overrides
  };
}

test("sqlite mode: appendTrade then loadHistory round-trips with bot_id and boolean won", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "store-sqlite-"));
  try {
    const store = createPaperStore({ cwd, prefix: "poly_btc_15m_", mode: "sqlite" });
    store.appendTrade(tradeFixture());
    store.appendTrade(tradeFixture({ side: "DOWN", won: false, pnl: -5 }));
    const { trades } = store.loadHistory();
    assert.equal(trades.length, 2);
    assert.equal(trades[0].side, "UP");
    assert.equal(trades[0].won, true);
    assert.equal(trades[1].won, false);
    assert.equal(trades[0].entryPrice, 0.55);
    store.close();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("sqlite mode: trades are isolated per bot_id", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "store-iso-"));
  try {
    const a = createPaperStore({ cwd, prefix: "poly_btc_5m_", mode: "sqlite" });
    const b = createPaperStore({ cwd, prefix: "kalshi_btc_", mode: "sqlite" });
    a.appendTrade(tradeFixture());
    assert.equal(a.loadHistory().trades.length, 1);
    assert.equal(b.loadHistory().trades.length, 0);
    a.close(); b.close();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("dual mode: writes JSON (canonical for reads) and SQLite", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "store-dual-"));
  try {
    const store = createPaperStore({ cwd, prefix: "poly_btc_5m_", mode: "dual" });
    store.appendTrade(tradeFixture());
    const jsonPath = path.join(cwd, "logs", "poly_btc_5m_paper_trades.json");
    assert.ok(existsSync(jsonPath), "json file written in dual mode");
    assert.equal(JSON.parse(readFileSync(jsonPath, "utf8")).trades.length, 1);
    // dual reads come from JSON (canonical) and the sqlite row also exists
    assert.equal(store.loadHistory().trades.length, 1);
    assert.equal(store.sqliteCount(), 1);
    store.close();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("position save/load round-trips in sqlite mode", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "store-pos-"));
  try {
    const store = createPaperStore({ cwd, prefix: "poly_btc_15m_", mode: "sqlite" });
    assert.equal(store.loadPosition(), null);
    const pos = { open: true, side: "UP", entryPrice: 0.5, usdcAmount: 5,
      priceToBeat: 1, marketSlug: "m", enteredAt: "t", edgeAtEntry: 0.05,
      oracleSource: "binance", entryTimeLeftMin: 7, bestBidAtEntry: 0.49,
      bestAskAtEntry: 0.51, spreadAtEntry: 0.02, feeAtEntry: 0.02 };
    store.savePosition(pos);
    assert.deepEqual(store.loadPosition(), pos);
    store.close();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/paperStore.test.js`
Expected: FAIL — `Cannot find module '../src/execution/paperStore.js'`

- [ ] **Step 3: Implement `paperStore.js`**

Create `src/execution/paperStore.js`:

```js
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id TEXT NOT NULL,
  side TEXT NOT NULL,
  entry_price REAL NOT NULL,
  usdc_amount REAL NOT NULL,
  price_to_beat REAL,
  settlement_price REAL,
  won INTEGER NOT NULL,
  gross_pnl REAL NOT NULL,
  fee_at_entry REAL NOT NULL DEFAULT 0,
  pnl REAL NOT NULL,
  edge_at_entry REAL,
  oracle_source TEXT,
  entry_time_left_min REAL,
  best_bid_at_entry REAL,
  best_ask_at_entry REAL,
  spread_at_entry REAL,
  market_slug TEXT,
  entered_at TEXT NOT NULL,
  settled_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trades_bot ON trades(bot_id);
CREATE INDEX IF NOT EXISTS idx_trades_settled ON trades(settled_at);
CREATE TABLE IF NOT EXISTS positions (
  bot_id TEXT PRIMARY KEY,
  open INTEGER NOT NULL DEFAULT 0,
  side TEXT,
  entry_price REAL,
  usdc_amount REAL,
  price_to_beat REAL,
  market_slug TEXT,
  entered_at TEXT,
  edge_at_entry REAL,
  oracle_source TEXT,
  entry_time_left_min REAL,
  best_bid_at_entry REAL,
  best_ask_at_entry REAL,
  spread_at_entry REAL,
  fee_at_entry REAL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS voided_trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id TEXT NOT NULL,
  side TEXT,
  entry_price REAL,
  price_to_beat REAL,
  settlement_price REAL,
  void_reason TEXT,
  entered_at TEXT,
  voided_at TEXT NOT NULL
);
`;

const TRADE_COLS = [
  "side", "entryPrice", "usdcAmount", "priceToBeat", "settlementPrice", "won",
  "grossPnl", "feeAtEntry", "pnl", "edgeAtEntry", "oracleSource",
  "entryTimeLeftMin", "bestBidAtEntry", "bestAskAtEntry", "spreadAtEntry",
  "marketSlug", "enteredAt", "settledAt"
];

const POS_FIELDS = [
  "open", "side", "entryPrice", "usdcAmount", "priceToBeat", "marketSlug",
  "enteredAt", "edgeAtEntry", "oracleSource", "entryTimeLeftMin",
  "bestBidAtEntry", "bestAskAtEntry", "spreadAtEntry", "feeAtEntry"
];

function rowToTrade(r) {
  return {
    side: r.side, entryPrice: r.entry_price, usdcAmount: r.usdc_amount,
    priceToBeat: r.price_to_beat, settlementPrice: r.settlement_price,
    won: !!r.won, grossPnl: r.gross_pnl, feeAtEntry: r.fee_at_entry, pnl: r.pnl,
    edgeAtEntry: r.edge_at_entry, oracleSource: r.oracle_source,
    entryTimeLeftMin: r.entry_time_left_min, bestBidAtEntry: r.best_bid_at_entry,
    bestAskAtEntry: r.best_ask_at_entry, spreadAtEntry: r.spread_at_entry,
    marketSlug: r.market_slug, enteredAt: r.entered_at, settledAt: r.settled_at
  };
}

function rowToPosition(r) {
  return {
    open: !!r.open, side: r.side, entryPrice: r.entry_price,
    usdcAmount: r.usdc_amount, priceToBeat: r.price_to_beat,
    marketSlug: r.market_slug, enteredAt: r.entered_at,
    edgeAtEntry: r.edge_at_entry, oracleSource: r.oracle_source,
    entryTimeLeftMin: r.entry_time_left_min, bestBidAtEntry: r.best_bid_at_entry,
    bestAskAtEntry: r.best_ask_at_entry, spreadAtEntry: r.spread_at_entry,
    feeAtEntry: r.fee_at_entry
  };
}

export function createPaperStore({
  cwd = process.cwd(),
  prefix = process.env.PAPER_LOG_PREFIX || "",
  mode = process.env.PAPER_STORE || "json"
} = {}) {
  const botId = prefix.replace(/_$/, "") || "default";
  const logsDir = path.join(cwd, "logs");
  const positionFile = path.join(logsDir, `${prefix}paper_position.json`);
  const historyFile = path.join(logsDir, `${prefix}paper_trades.json`);
  const dbFile = path.join(logsDir, "trades.db");

  const useSqlite = mode === "sqlite" || mode === "dual";
  const useJson = mode === "json" || mode === "dual";
  const sqliteCanonical = mode === "sqlite";

  let _db = null;
  function db() {
    if (_db) return _db;
    fs.mkdirSync(logsDir, { recursive: true });
    _db = new DatabaseSync(dbFile);
    // node:sqlite has no .pragma() helper — pragmas go through exec().
    _db.exec("PRAGMA journal_mode = WAL");
    _db.exec("PRAGMA busy_timeout = 5000");
    _db.exec(SCHEMA);
    return _db;
  }

  function readJson(file, fallback) {
    try { if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8")); }
    catch { /* ignore */ }
    return fallback;
  }
  function writeJson(file, data) {
    fs.mkdirSync(logsDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
  }

  function insertTrade(t) {
    const cols = ["bot_id", ...TRADE_COLS.map(toSnake)];
    const placeholders = cols.map(() => "?").join(", ");
    const vals = [botId, ...TRADE_COLS.map(k => k === "won" ? (t.won ? 1 : 0) : (t[k] ?? null))];
    db().prepare(`INSERT INTO trades (${cols.join(", ")}) VALUES (${placeholders})`).run(...vals);
  }

  return {
    botId,
    mode,
    sqliteCanonical,

    loadHistory() {
      if (sqliteCanonical) {
        const rows = db().prepare("SELECT * FROM trades WHERE bot_id = ? ORDER BY id").all(botId);
        return { trades: rows.map(rowToTrade) };
      }
      return readJson(historyFile, { trades: [] });
    },

    appendTrade(trade) {
      if (useJson) {
        const h = readJson(historyFile, { trades: [] });
        h.trades.push(trade);
        writeJson(historyFile, h);
      }
      if (useSqlite) insertTrade(trade);
    },

    loadPosition() {
      if (sqliteCanonical) {
        const r = db().prepare("SELECT * FROM positions WHERE bot_id = ?").get(botId);
        return r ? rowToPosition(r) : null;
      }
      return fs.existsSync(positionFile) ? readJson(positionFile, null) : null;
    },

    savePosition(pos) {
      if (useJson) writeJson(positionFile, pos);
      if (useSqlite) {
        const cols = ["bot_id", ...POS_FIELDS.map(toSnake)];
        const placeholders = cols.map(() => "?").join(", ");
        const vals = [botId, ...POS_FIELDS.map(k => k === "open" ? (pos.open ? 1 : 0) : (pos[k] ?? null))];
        db().prepare(
          `INSERT INTO positions (${cols.join(", ")}) VALUES (${placeholders})
           ON CONFLICT(bot_id) DO UPDATE SET ${cols.slice(1).map(c => `${c}=excluded.${c}`).join(", ")}`
        ).run(...vals);
      }
    },

    appendVoided(v) {
      if (!useSqlite) return; // JSON mode never persisted voids; keep that behavior
      db().prepare(
        `INSERT INTO voided_trades
           (bot_id, side, entry_price, price_to_beat, settlement_price, void_reason, entered_at, voided_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(botId, v.side ?? null, v.entryPrice ?? null, v.priceToBeat ?? null,
            v.settlementPrice ?? null, v.voidReason ?? null, v.enteredAt ?? null, v.voidedAt);
    },

    sqliteCount() {
      return db().prepare("SELECT count(*) c FROM trades WHERE bot_id = ?").get(botId).c;
    },

    close() { if (_db) { _db.close(); _db = null; } }
  };
}

function toSnake(camel) {
  return camel.replace(/[A-Z]/g, m => "_" + m.toLowerCase());
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/paperStore.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/execution/paperStore.js test/paperStore.test.js
git commit -m "feat: paperStore persistence factory (json|dual|sqlite modes)"
```

---

### Task 3: Wire paperTrading.js to use paperStore

**Files:**
- Modify: `src/execution/paperTrading.js:1-135` (imports, persistence helpers, position load)
- Modify: `src/execution/paperTrading.js:241-307` (void recording in `_settlePosition`)
- Test: `test/paperTrading.test.js` (existing — must stay green; default mode `json` keeps behavior)

- [ ] **Step 1: Replace persistence wiring**

In `src/execution/paperTrading.js`, change the import block and persistence section.

Add to imports (top of file):
```js
import { createPaperStore } from "./paperStore.js";
```

Remove the now-unused `POSITION_FILE` and `HISTORY_FILE` constants (keep `LOCK_FILE`):
```js
const _prefix = process.env.PAPER_LOG_PREFIX || "";
const LOCK_FILE = path.join(process.cwd(), "logs", `${_prefix}paper.lock`);
let _lockFd = null;
```

Delete the `loadJson`/`saveJson`/`loadHistory`/`appendTrade` helper functions (lines ~69-79 and ~127-135) and replace the persistence section with a single store instance:
```js
// ─── persistência ────────────────────────────────────────────────────────────

function ensureDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

const _store = createPaperStore(); // mode from PAPER_STORE env (default "json")

// ─── estado em memória ───────────────────────────────────────────────────────

let _pos = _store.loadPosition() ?? { ...EMPTY_POSITION };

function savePos() { _store.savePosition(_pos); }
```

Note: `ensureDir` stays because `acquirePaperLock` uses it for the lock file. `fs` and `path` imports stay.

- [ ] **Step 2: Repoint history reads/writes**

Replace remaining `loadHistory()` calls (in `getPaperStats` and `getLastTrades`) with `_store.loadHistory()`, and the `appendTrade(trade)` call in `_settlePosition` with `_store.appendTrade(trade)`.

- [ ] **Step 3: Persist frozen-oracle voids**

In `_settlePosition`, inside the `if (frozenVsStrike || frozenVsPrev) { ... }` block, before `_pos = { ...EMPTY_POSITION }`, add:
```js
    _store.appendVoided({
      side: _pos.side,
      entryPrice: _pos.entryPrice,
      priceToBeat: _pos.priceToBeat,
      settlementPrice: settlementChainlinkPrice,
      voidReason: frozenVsStrike ? "frozen_vs_strike" : "frozen_vs_prev",
      enteredAt: _pos.enteredAt,
      voidedAt: new Date().toISOString()
    });
```

- [ ] **Step 4: Run the full test suite**

Run: `node --test`
Expected: PASS — existing `paperTrading.test.js` green (default `json` mode = unchanged behavior) and `paperStore.test.js` green. The 4 pre-existing unrelated failures noted in project history (hour-gating) are out of scope; confirm no *new* failures vs. `git stash && node --test` baseline if unsure.

- [ ] **Step 5: Commit**

```bash
git add src/execution/paperTrading.js
git commit -m "refactor: route paperTrading persistence through paperStore; record voids"
```

---

### Task 4: Importer script (TDD)

**Files:**
- Create: `scripts/import-json-to-sqlite.js`
- Test: `test/paperStore.test.js` (append importer tests)

- [ ] **Step 1: Write the failing test**

Append to `test/paperStore.test.js`:

```js
import { importJsonToSqlite } from "../scripts/import-json-to-sqlite.js";
import { mkdirSync, writeFileSync as wf } from "node:fs";

test("importer backfills JSON trades and is idempotent", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "import-"));
  try {
    mkdirSync(path.join(cwd, "logs"), { recursive: true });
    wf(path.join(cwd, "logs", "poly_btc_5m_paper_trades.json"),
       JSON.stringify({ trades: [tradeFixture(), tradeFixture({ side: "DOWN", won: false })] }));
    importJsonToSqlite({ cwd, prefixes: ["poly_btc_5m_"] });
    importJsonToSqlite({ cwd, prefixes: ["poly_btc_5m_"] }); // second run must not duplicate
    const store = createPaperStore({ cwd, prefix: "poly_btc_5m_", mode: "sqlite" });
    assert.equal(store.loadHistory().trades.length, 2);
    store.close();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/paperStore.test.js`
Expected: FAIL — `Cannot find module '../scripts/import-json-to-sqlite.js'`

- [ ] **Step 3: Implement the importer**

Create `scripts/import-json-to-sqlite.js`:

```js
import fs from "node:fs";
import path from "node:path";
import { createPaperStore } from "../src/execution/paperStore.js";

const DEFAULT_PREFIXES = ["poly_btc_5m_", "poly_btc_15m_", "kalshi_btc_"];

export function importJsonToSqlite({ cwd = process.cwd(), prefixes = DEFAULT_PREFIXES } = {}) {
  for (const prefix of prefixes) {
    const store = createPaperStore({ cwd, prefix, mode: "sqlite" });
    const botId = store.botId;
    // Idempotent: clear this bot's rows then re-insert from JSON (single source = JSON file).
    store.clearBot();
    const tradesFile = path.join(cwd, "logs", `${prefix}paper_trades.json`);
    if (fs.existsSync(tradesFile)) {
      const { trades = [] } = JSON.parse(fs.readFileSync(tradesFile, "utf8"));
      for (const t of trades) store.appendTrade(t);
      console.log(`[import] ${botId}: ${trades.length} trades`);
    }
    const posFile = path.join(cwd, "logs", `${prefix}paper_position.json`);
    if (fs.existsSync(posFile)) {
      const pos = JSON.parse(fs.readFileSync(posFile, "utf8"));
      if (pos && pos.open) store.savePosition(pos);
    }
    store.close();
  }
}

// CLI entry
if (import.meta.url === `file://${process.argv[1]}`) {
  importJsonToSqlite({});
}
```

Add a `clearBot()` method to `createPaperStore`'s returned object in `src/execution/paperStore.js` (next to `close`):
```js
    clearBot() {
      db().prepare("DELETE FROM trades WHERE bot_id = ?").run(botId);
      db().prepare("DELETE FROM positions WHERE bot_id = ?").run(botId);
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/paperStore.test.js`
Expected: PASS (importer test green; double-run yields 2, not 4)

- [ ] **Step 5: Add npm script and commit**

In `package.json` `scripts`, add:
```json
    "import:sqlite": "node scripts/import-json-to-sqlite.js",
```

```bash
git add scripts/import-json-to-sqlite.js src/execution/paperStore.js test/paperStore.test.js package.json
git commit -m "feat: idempotent JSON->SQLite importer + clearBot"
```

---

### Task 5: Comparison script (TDD)

**Files:**
- Create: `scripts/compare-stores.js`
- Test: `test/paperStore.test.js` (append comparison tests)

- [ ] **Step 1: Write the failing test**

Append to `test/paperStore.test.js`:

```js
import { compareStores } from "../scripts/compare-stores.js";

test("compareStores reports match when JSON and SQLite agree", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "cmp-ok-"));
  try {
    const store = createPaperStore({ cwd, prefix: "poly_btc_5m_", mode: "dual" });
    store.appendTrade(tradeFixture());
    store.appendTrade(tradeFixture({ side: "DOWN", won: false }));
    store.close();
    const result = compareStores({ cwd, prefixes: ["poly_btc_5m_"] });
    assert.equal(result.ok, true);
    assert.equal(result.bots[0].jsonCount, 2);
    assert.equal(result.bots[0].sqliteCount, 2);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("compareStores flags divergence in counts", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "cmp-bad-"));
  try {
    // JSON has 1, SQLite has 0 (write JSON-only)
    const store = createPaperStore({ cwd, prefix: "poly_btc_5m_", mode: "json" });
    store.appendTrade(tradeFixture());
    store.close();
    const result = compareStores({ cwd, prefixes: ["poly_btc_5m_"] });
    assert.equal(result.ok, false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/paperStore.test.js`
Expected: FAIL — `Cannot find module '../scripts/compare-stores.js'`

- [ ] **Step 3: Implement the comparison**

Create `scripts/compare-stores.js`:

```js
import fs from "node:fs";
import path from "node:path";
import { createPaperStore } from "../src/execution/paperStore.js";

const DEFAULT_PREFIXES = ["poly_btc_5m_", "poly_btc_15m_", "kalshi_btc_"];

export function compareStores({ cwd = process.cwd(), prefixes = DEFAULT_PREFIXES } = {}) {
  const bots = [];
  let ok = true;
  for (const prefix of prefixes) {
    const tradesFile = path.join(cwd, "logs", `${prefix}paper_trades.json`);
    const jsonTrades = fs.existsSync(tradesFile)
      ? (JSON.parse(fs.readFileSync(tradesFile, "utf8")).trades ?? [])
      : [];
    const store = createPaperStore({ cwd, prefix, mode: "sqlite" });
    const sqliteCount = store.sqliteCount();
    store.close();
    const match = jsonTrades.length === sqliteCount;
    if (!match) ok = false;
    bots.push({ botId: prefix.replace(/_$/, ""), jsonCount: jsonTrades.length, sqliteCount, match });
  }
  return { ok, bots };
}

// CLI entry
if (import.meta.url === `file://${process.argv[1]}`) {
  const result = compareStores({});
  for (const b of result.bots) {
    console.log(`${b.match ? "✅" : "❌"} ${b.botId}: json=${b.jsonCount} sqlite=${b.sqliteCount}`);
  }
  process.exit(result.ok ? 0 : 1);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/paperStore.test.js`
Expected: PASS

- [ ] **Step 5: Add npm script and commit**

In `package.json` `scripts`, add:
```json
    "compare:stores": "node scripts/compare-stores.js",
```

```bash
git add scripts/compare-stores.js test/paperStore.test.js package.json
git commit -m "feat: JSON vs SQLite divergence check"
```

---

### Task 6: Backup script + deploy/cutover docs

**Files:**
- Create: `scripts/backup-db.sh`
- Modify: `README.md` (add a "SQLite store + cutover" section)

- [ ] **Step 1: Create the backup script**

Create `scripts/backup-db.sh`:
```bash
#!/usr/bin/env bash
# Dated backup of the paper-trade SQLite DB to a dir OUTSIDE the repo.
set -euo pipefail
SRC="${1:-logs/trades.db}"
DEST_DIR="${PAPER_DB_BACKUP_DIR:-$HOME/paper-db-backups}"
mkdir -p "$DEST_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
# Use sqlite3 .backup if available (safe online copy), else plain cp.
if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$SRC" ".backup '$DEST_DIR/trades-$STAMP.db'"
else
  cp "$SRC" "$DEST_DIR/trades-$STAMP.db"
fi
echo "backup -> $DEST_DIR/trades-$STAMP.db"
```

Run: `chmod +x scripts/backup-db.sh`

- [ ] **Step 2: Document deploy + cutover in README**

Add a section to `README.md` documenting:
- **Node 24 requirement:** the project now needs Node ≥24 (built-in `node:sqlite`). On the Ubuntu VPS: `nvm install 24 && nvm use 24` (no build toolchain needed). Restart bots on Node 24.
- Store modes: `PAPER_STORE=json` (default) | `dual` | `sqlite`.
- **Dual-write rollout:** restart the 3 bots with `PAPER_STORE=dual` (e.g. `PAPER_STORE=dual npm run polymarket:btc:5m`), after running `npm run import:sqlite` once to backfill history.
- **Validate:** `npm run compare:stores` should print all ✅ and exit 0.
- **Cutover criteria (from spec):** wait for the last of (a) 3 days dual-write and (b) ≥20 settled trades with zero divergence (target review ~2026-06-20/21), then restart bots with `PAPER_STORE=sqlite` and archive the JSON files (do not delete).
- **Backup cron** (laptop/VPS): `*/30 * * * * cd /path/to/repo && ./scripts/backup-db.sh >> ~/paper-db-backups/backup.log 2>&1`.

- [ ] **Step 3: Commit**

```bash
git add scripts/backup-db.sh README.md
git commit -m "docs: SQLite store modes, dual-write rollout, cutover, backup cron"
```

---

### Task 7: Record dual-write start date (post-deploy bookkeeping)

This task runs **after** the user has restarted the bots in `dual` mode on the laptop.

- [ ] **Step 1: Stamp the dual-write start**

After confirming `npm run compare:stores` exits 0 with all bots ✅, note the date in the spec file's "Janela de espera" section and in the `sqlite-migration-plan` memory file so a future session knows when the 3-day / ≥20-trade clock started.

- [ ] **Step 2: Commit the spec note**

```bash
git add docs/superpowers/specs/2026-06-16-sqlite-paper-trading-migration-design.md
git commit -m "docs: record dual-write start date for cutover countdown"
```

---

## Self-Review

**Spec coverage:**
- Schema (trades/positions/voided_trades, WAL, busy_timeout) → Task 2. ✅
- Persistence seam swap, no trade-logic change → Task 3. ✅
- Void persistence (new) → Task 3 Step 3. ✅
- Importer (idempotent, laptop) → Task 4. ✅
- Dual-write + comparison → modes in Task 2, compare in Task 5. ✅
- Wait window / cutover → documented Task 6 Step 2 + Task 7. ✅
- Backup → Task 6 Step 1. ✅
- `better-sqlite3` lib decision (Node 20 has no `node:sqlite`) → Task 1. ✅
- Single DB + `bot_id` (not per-bot DB) → schema + `botId` derivation. ✅
- Out of scope (VPS move, Hermes, Postgres) → not in any task. ✅

**Placeholder scan:** No TBD/TODO; every code step has full code. ✅

**Type consistency:** `createPaperStore` returns `{ botId, mode, sqliteCanonical, loadHistory, appendTrade, loadPosition, savePosition, appendVoided, sqliteCount, clearBot, close }`. `clearBot` is added in Task 4 Step 3 and used by the importer; `sqliteCount` defined in Task 2 and used by dual-mode test + compare. `appendVoided` takes `{side, entryPrice, priceToBeat, settlementPrice, voidReason, enteredAt, voidedAt}` — matches the call in Task 3 Step 3. Trade object keys match `TRADE_COLS`. ✅

**Note on test ordering:** `test/paperStore.test.js` imports `importJsonToSqlite` (Task 4) and `compareStores` (Task 5) at the top across tasks. When implementing strictly task-by-task, those imports won't resolve until the corresponding script exists — add each import alongside its task's tests (as written), not all upfront.
