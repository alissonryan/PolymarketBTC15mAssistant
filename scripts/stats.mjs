/**
 * scripts/stats.mjs
 *
 * Live paper-trading stats read straight from the SQLite store (logs/trades.db).
 * This is the SQLite-native reporting path we validate before the JSON cutover.
 *
 * Usage:
 *   npm run stats                 # accumulated since 2026-06-13 (clean window) + today
 *   node scripts/stats.mjs --all  # whole history, no date floor
 *   node scripts/stats.mjs --since 2026-06-15
 *
 * Requires Node >= 24 (built-in node:sqlite).
 */

import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB = path.join(__dirname, "../logs/trades.db");

const args = process.argv.slice(2);
const ALL = args.includes("--all");
const sinceArg = (() => {
  const i = args.indexOf("--since");
  return i >= 0 ? args[i + 1] : null;
})();
// "clean window" floor — trades before this were contaminated by the frozen-oracle eras
const CLEAN_FLOOR = "2026-06-13";
const since = ALL ? "0000" : (sinceArg ?? CLEAN_FLOOR);

const BOTS = ["poly_btc_5m", "poly_btc_15m", "kalshi_btc"];

let db;
try {
  db = new DatabaseSync(DB, { readOnly: true });
} catch (err) {
  console.error(`Não consegui abrir ${DB}: ${err.message}`);
  process.exit(1);
}

function agg(where, params = []) {
  const row = db
    .prepare(
      `SELECT COUNT(*) n,
              SUM(CASE WHEN won THEN 1 ELSE 0 END) wins,
              COALESCE(SUM(pnl), 0) pnl,
              COUNT(DISTINCT settlement_price) distinct_settle
       FROM trades WHERE ${where}`,
    )
    .get(...params);
  return row;
}

function fmt(label, r) {
  if (!r || r.n === 0) {
    console.log(`${label.padEnd(20)} (0 trades)`);
    return;
  }
  const wr = ((100 * r.wins) / r.n).toFixed(0);
  const frozen = r.n - r.distinct_settle;
  const flag = frozen > 0 ? `  ⚠ frozen=${frozen}` : "";
  console.log(
    `${label.padEnd(20)} n=${String(r.n).padStart(3)}  WR=${String(wr).padStart(3)}%  pnl=${r.pnl.toFixed(2).padStart(8)}${flag}`,
  );
}

const today = new Date().toISOString().slice(0, 10);

console.log(`\n📊 STATS (SQLite · logs/trades.db)  —  janela: ${ALL ? "tudo" : ">= " + since}\n`);

console.log(`=== Acumulado (>= ${since}) ===`);
let tot = { n: 0, wins: 0, pnl: 0 };
for (const bot of BOTS) {
  const r = agg("bot_id = ? AND entered_at >= ?", [bot, since]);
  fmt(bot, r);
  tot.n += r.n;
  tot.wins += r.wins;
  tot.pnl += r.pnl;
}
console.log("-".repeat(48));
fmt("TOTAL", { n: tot.n, wins: tot.wins, pnl: tot.pnl, distinct_settle: tot.n });

console.log(`\n=== Hoje (${today}) ===`);
let tday = { n: 0, wins: 0, pnl: 0 };
for (const bot of BOTS) {
  const r = agg("bot_id = ? AND entered_at >= ?", [bot, today]);
  fmt(bot, r);
  tday.n += r.n;
  tday.wins += r.wins;
  tday.pnl += r.pnl;
}
console.log("-".repeat(48));
fmt("TOTAL HOJE", { n: tday.n, wins: tday.wins, pnl: tday.pnl, distinct_settle: tday.n });

// ROI on a $100 bankroll basis (stake-agnostic: PnL is in USDC)
console.log(`\nPnL acumulado: $${tot.pnl.toFixed(2)}  (ROI sobre banca $100: ${tot.pnl.toFixed(1)}%)`);
console.log("");
