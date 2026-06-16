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
