/**
 * Kalshi validation — Stage 1 (fetch).
 *
 * Pulls settled KXBTC15M markets over a date range from the PUBLIC Kalshi API
 * (no auth) and, per market, the yes-price at our entry time (~13 min left, the
 * live kalshi bot's observed entry_time_left). Emits entries_kalshi.json in the
 * SAME schema as the Polymarket entries so run.mjs can replay the real engines.
 *
 * Outcome = market `result` (yes->Up / no->Down). Market price at entry from the
 * 1-min candlestick covering entry (traded yes price, fallback bid/ask mid).
 *
 * Usage: node scripts/hf-backtest/kalshi-extract.mjs [days]
 */
import { writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));
const BASE = "https://api.elections.kalshi.com/trade-api/v2";
const SERIES = "KXBTC15M";
const ENTRY_LEFT_SEC = 13 * 60;
const DAYS = Number(process.argv[2]) || 14;

const nowSec = Math.floor(Date.now() / 1000);
const minClose = nowSec - DAYS * 86400;
const maxClose = nowSec;

async function getJson(url) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url);
    if (res.status === 429) { await new Promise(r => setTimeout(r, 500 * (attempt + 1))); continue; }
    if (!res.ok) throw new Error(`${res.status} ${url}: ${await res.text()}`);
    return res.json();
  }
  throw new Error(`rate-limited: ${url}`);
}

// 1) enumerate settled markets
const markets = [];
let cursor = "";
do {
  const url = `${BASE}/markets?series_ticker=${SERIES}&status=settled&min_close_ts=${minClose}&max_close_ts=${maxClose}&limit=1000${cursor ? `&cursor=${cursor}` : ""}`;
  const j = await getJson(url);
  for (const m of j.markets || []) markets.push(m);
  cursor = j.cursor || "";
  process.stderr.write(`\r[kalshi] markets: ${markets.length}`);
} while (cursor);
process.stderr.write(`\n[kalshi] settled KXBTC15M in last ${DAYS}d: ${markets.length}\n`);

const num = (x) => (x == null ? null : Number(x));

// 2) per-market: candlestick at entry
const entries = [];
let done = 0, skipped = 0;
for (const m of markets) {
  const startMs = new Date(m.open_time).getTime();
  const endMs = new Date(m.close_time).getTime();
  const entryMs = endMs - ENTRY_LEFT_SEC * 1000;
  const startTs = Math.floor(startMs / 1000), endTs = Math.floor(endMs / 1000);
  const url = `${BASE}/series/${SERIES}/markets/${m.ticker}/candlesticks?start_ts=${startTs - 60}&end_ts=${endTs + 60}&period_interval=1`;
  let cs;
  try { cs = await getJson(url); } catch { skipped++; continue; }
  const candles = cs.candlesticks || [];
  // candle whose end_period_ts is closest to entry
  let best = null, bestDt = Infinity;
  for (const c of candles) {
    const dt = Math.abs(c.end_period_ts - Math.floor(entryMs / 1000));
    if (dt < bestDt) { bestDt = dt; best = c; }
  }
  if (!best || bestDt > 90) { skipped++; continue; }
  const ba = best.yes_bid, aa = best.yes_ask, pr = best.price;
  const bid = num(ba?.close_dollars), ask = num(aa?.close_dollars), traded = num(pr?.close_dollars);
  let marketUp = traded != null && traded > 0.01 && traded < 0.99 ? traded
                 : (bid != null && ask != null ? (bid + ask) / 2 : null);
  if (marketUp == null) { skipped++; continue; }
  const effSpread = (bid != null && ask != null && ask >= bid) ? +(ask - bid).toFixed(4) : 0.0274;

  entries.push({
    market_id: m.ticker,
    start_ts: startMs, end_ts: endMs, entry_ts: entryMs,
    outcome: m.result === "yes" ? "Up" : "Down",
    marketUp: +Math.min(Math.max(marketUp, 0.01), 0.99).toFixed(4),
    marketDown: +Math.min(Math.max(1 - marketUp, 0.01), 0.99).toFixed(4),
    effSpread,
  });
  if (++done % 100 === 0) process.stderr.write(`\r[kalshi] candles: ${done}/${markets.length} (skip ${skipped})`);
  await new Promise(r => setTimeout(r, 25));
}
entries.sort((a, b) => a.entry_ts - b.entry_ts);
writeFileSync(join(__dir, "entries_kalshi.json"), JSON.stringify(entries));
process.stderr.write(`\n[kalshi] wrote ${entries.length} entries (skipped ${skipped})\n`);
if (entries.length) {
  const ups = entries.filter(e => e.outcome === "Up").length;
  process.stderr.write(`[kalshi] window: ${new Date(entries[0].entry_ts).toISOString()} .. ${new Date(entries.at(-1).entry_ts).toISOString()} | UP rate ${(ups/entries.length*100).toFixed(1)}%\n`);
}
