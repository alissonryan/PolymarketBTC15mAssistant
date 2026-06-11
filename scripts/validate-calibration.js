/**
 * scripts/validate-calibration.js
 *
 * Walk-forward (out-of-sample) validation of the calibration approach.
 *
 * Splits the 365d of 5m candles into TRAIN (first 70%) and TEST (last 30%).
 * Builds the calibration table on TRAIN only, selects the "tradeable" buckets
 * (n >= MIN_N and |edge50| > ci95 — same rule the live bot uses), then measures
 * how those buckets actually performed on TEST data they never saw.
 *
 * If the edge is real, TEST accuracy of selected buckets should stay well above
 * 50% (after the direction implied by the bucket). If it collapses to ~50%,
 * the "significant" buckets are in-sample noise (multiple-comparisons artifact).
 *
 * Usage: node scripts/validate-calibration.js
 */

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, "cache");

const MIN_N = Number(process.env.VAL_MIN_N ?? 100);
const TRAIN_FRACTION = Number(process.env.VAL_TRAIN_FRACTION ?? 0.7);

function parseKline(k) {
  return {
    openTime: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
  };
}

function rsi(closes, period) {
  if (closes.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  const start = closes.length - period;
  for (let i = start; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + gains / period / avgLoss);
}

console.log("Loading cache files...");
const candles5m = JSON.parse(readFileSync(path.join(CACHE_DIR, "BTCUSDT_5m_365d.json"), "utf8")).map(parseKline);
const candles1h = JSON.parse(readFileSync(path.join(CACHE_DIR, "BTCUSDT_1h_365d.json"), "utf8")).map(parseKline);

// 1h EMA50 map (same as calibrate.js)
const EMA50 = 50;
const k50 = 2 / (EMA50 + 1);
let emaVal = candles1h.slice(0, EMA50).reduce((a, c) => a + c.close, 0) / EMA50;
const hourEma = new Map();
for (let i = 0; i < candles1h.length; i++) {
  if (i >= EMA50) emaVal = candles1h[i].close * k50 + emaVal * (1 - k50);
  hourEma.set(candles1h[i].openTime, { close: candles1h[i].close, ema50: i >= EMA50 ? emaVal : null });
}
function macroAt(ms) {
  const h = Math.floor(ms / 3_600_000) * 3_600_000;
  const e = hourEma.get(h);
  if (!e || e.ema50 === null) return null;
  return e.close >= e.ema50 ? "UP" : "DOWN";
}

// Intraday VWAP (same as calibrate.js)
const vwap = new Array(candles5m.length).fill(null);
let pv = 0, vv = 0, day = -1;
for (let i = 0; i < candles5m.length; i++) {
  const c = candles5m[i];
  const d = Math.floor(c.openTime / 86_400_000);
  if (d !== day) { pv = 0; vv = 0; day = d; }
  pv += ((c.high + c.low + c.close) / 3) * c.volume;
  vv += c.volume;
  vwap[i] = vv === 0 ? null : pv / vv;
}

// Build per-candle samples: { key, isUp, idx }
const RSI_P = 14;
const samples = [];
const closeBuf = [];
for (let i = 0; i < candles5m.length - 1; i++) {
  const c = candles5m[i];
  closeBuf.push(c.close);
  if (closeBuf.length > 40) closeBuf.shift();
  if (closeBuf.length < RSI_P + 1) continue;
  const macro = macroAt(c.openTime);
  if (macro === null || vwap[i] === null) continue;
  const r = rsi(closeBuf, RSI_P);
  if (r === null) continue;
  const zone = r > 60 ? "OVERBOUGHT" : r < 40 ? "OVERSOLD" : "NEUTRAL";
  const hour = new Date(c.openTime).getUTCHours();
  const pvw = c.close >= vwap[i] ? "ABOVE" : "BELOW";
  samples.push({
    key: `${hour}|${macro}|${pvw}|${zone}`,
    isUp: candles5m[i + 1].close > c.close,
  });
}

const splitIdx = Math.floor(samples.length * TRAIN_FRACTION);
const train = samples.slice(0, splitIdx);
const test = samples.slice(splitIdx);
console.log(`Samples: ${samples.length} | train: ${train.length} | test: ${test.length}`);

// Train calibration
const trainMap = new Map();
for (const s of train) {
  let e = trainMap.get(s.key);
  if (!e) { e = { n: 0, ups: 0 }; trainMap.set(s.key, e); }
  e.n++;
  if (s.isUp) e.ups++;
}

// Select tradeable buckets using the live bot's rule
const selected = new Map();
for (const [key, { n, ups }] of trainMap) {
  if (n < MIN_N) continue;
  const upRate = ups / n;
  const ci95 = 1.96 * Math.sqrt((upRate * (1 - upRate)) / n);
  if (Math.abs(upRate - 0.5) > ci95) {
    selected.set(key, { trainUpRate: upRate, dir: upRate > 0.5 ? "UP" : "DOWN", n, ci95 });
  }
}
console.log(`Selected buckets (n>=${MIN_N}, |edge|>ci95 on TRAIN): ${selected.size} / ${trainMap.size}`);

// Evaluate on TEST: when in a selected bucket, "bet" the bucket's direction
const testStats = new Map();
let bets = 0, wins = 0;
for (const s of test) {
  const sel = selected.get(s.key);
  if (!sel) continue;
  bets++;
  const won = (sel.dir === "UP") === s.isUp;
  if (won) wins++;
  let st = testStats.get(s.key);
  if (!st) { st = { n: 0, wins: 0 }; testStats.set(s.key, st); }
  st.n++;
  if (won) st.wins++;
}

console.log("\n========== OUT-OF-SAMPLE RESULT ==========");
console.log(`Test bets: ${bets} | wins: ${wins} | OOS accuracy: ${bets ? ((100 * wins) / bets).toFixed(2) : "-"}%`);
console.log(`(In-sample, these buckets averaged well above 50% by construction.)`);

// Per-bucket detail, sorted by train edge
const rows = [...selected.entries()]
  .map(([key, sel]) => {
    const st = testStats.get(key) ?? { n: 0, wins: 0 };
    return {
      key,
      dir: sel.dir,
      trainEdge: Math.abs(sel.trainUpRate - 0.5),
      trainN: sel.n,
      testN: st.n,
      testWR: st.n ? st.wins / st.n : null,
    };
  })
  .sort((a, b) => b.trainEdge - a.trainEdge);

console.log("\nBucket (hour|macro|vwap|rsi)            dir   trainEdge  trainN  testN  testWR");
for (const r of rows.slice(0, 25)) {
  console.log(
    `${r.key.padEnd(40)}${r.dir.padEnd(6)}${(r.trainEdge * 100).toFixed(1).padStart(7)}%  ${String(r.trainN).padStart(6)} ${String(r.testN).padStart(6)}  ${r.testWR === null ? "   -" : ((r.testWR * 100).toFixed(1) + "%").padStart(6)}`,
  );
}

// Aggregate: how many selected buckets stayed >50% OOS (with testN >= 30)?
const evaluable = rows.filter((r) => r.testN >= 30);
const held = evaluable.filter((r) => r.testWR > 0.5);
const fee = 0.04; // ~4% round-trip fee on stake observed in paper logs
const heldAfterFee = evaluable.filter((r) => r.testWR > 0.5 + fee / 2);
console.log(`\nBuckets with testN>=30: ${evaluable.length}`);
console.log(`  ...that stayed >50% OOS: ${held.length} (${evaluable.length ? ((100 * held.length) / evaluable.length).toFixed(0) : 0}%)`);
console.log(`  ...that beat fees (>52%) OOS: ${heldAfterFee.length}`);
console.log(`(Coin-flip expectation: ~50% of buckets stay >50% by chance.)`);
