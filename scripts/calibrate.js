/**
 * scripts/calibrate.js
 *
 * Computes historical base rates for BTC 5-minute direction by condition slice.
 *
 * Usage:
 *   node scripts/calibrate.js
 *
 * Reads:
 *   scripts/cache/BTCUSDT_5m_365d.json  — Binance kline arrays (5-minute)
 *   scripts/cache/BTCUSDT_1h_365d.json  — Binance kline arrays (1-hour)
 *
 * Writes:
 *   scripts/calibration.json            — flat array of calibration entries
 *
 * Kline array format (Binance):
 *   [openTime, open, high, low, close, volume, closeTime, quoteVol, trades,
 *    takerBaseVol, takerQuoteVol, ignore]
 *   All price/volume fields are strings.
 */

import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, "cache");
const OUT_PATH = path.join(__dirname, "calibration.json");

// ---------------------------------------------------------------------------
// Kline helpers — parse a raw Binance kline array into a plain object
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Indicator implementations (inline — no src/ imports needed)
// ---------------------------------------------------------------------------

/** EMA over an array of values. Returns the final scalar. */
function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let val = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) {
    val = values[i] * k + val * (1 - k);
  }
  return val;
}

/** RSI(period) — Wilder smoothing (simple average over window for speed). */
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
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** Bollinger Band Width as % of midband = (upper-lower)/mean*100 = 4*std/mean*100 */
function bbWidth(closes, period) {
  if (closes.length < period) return null;
  const slice = closes.slice(closes.length - period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  if (mean === 0) return null;
  const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
  const std = Math.sqrt(variance);
  return (4 * std / mean) * 100; // equivalent to (upper-lower)/mean*100
}

/**
 * Choppiness Index (period=14).
 * candles must be objects with {high, low, close}.
 * Needs period+1 candles (period TR values, computed pairwise).
 */
function chop(candles, period) {
  if (candles.length < period + 1) return null;
  const slice = candles.slice(candles.length - period - 1);
  let atrSum = 0;
  let highestHigh = -Infinity;
  let lowestLow = Infinity;
  for (let i = 1; i <= period; i++) {
    const cur = slice[i];
    const prev = slice[i - 1];
    const tr = Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prev.close),
      Math.abs(cur.low - prev.close),
    );
    atrSum += tr;
    if (cur.high > highestHigh) highestHigh = cur.high;
    if (cur.low < lowestLow) lowestLow = cur.low;
  }
  const rangeHL = highestHigh - lowestLow;
  if (rangeHL === 0) return null;
  const val = (100 * Math.log10(atrSum / rangeHL)) / Math.log10(period);
  return Math.max(0, Math.min(100, val));
}

// ---------------------------------------------------------------------------
// Load and validate cache files
// ---------------------------------------------------------------------------
function loadJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (err) {
    console.error(`ERROR: Cannot load ${filePath}`);
    console.error(err.message);
    process.exit(1);
  }
}

console.log("Loading cache files...");
const raw5m = loadJson(path.join(CACHE_DIR, "BTCUSDT_5m_365d.json"));
const raw1h = loadJson(path.join(CACHE_DIR, "BTCUSDT_1h_365d.json"));

if (!Array.isArray(raw5m) || raw5m.length === 0) {
  console.error("ERROR: BTCUSDT_5m_365d.json is empty or not an array");
  process.exit(1);
}
if (!Array.isArray(raw1h) || raw1h.length === 0) {
  console.error("ERROR: BTCUSDT_1h_365d.json is empty or not an array");
  process.exit(1);
}

const candles5m = raw5m.map(parseKline);
const candles1h = raw1h.map(parseKline);

console.log(`Loaded ${candles5m.length} 5m candles and ${candles1h.length} 1h candles.`);

// ---------------------------------------------------------------------------
// Build a map from hourly open-time -> EMA50 on 1h closes
// We compute the full EMA50 series so each hour has its own EMA value.
// ---------------------------------------------------------------------------
console.log("Computing 1h EMA50 series...");

const EMA50_PERIOD = 50;
const k50 = 2 / (EMA50_PERIOD + 1);

// Seed with SMA of first 50 closes
const h1Closes = candles1h.map((c) => c.close);
let ema50Val =
  h1Closes.slice(0, EMA50_PERIOD).reduce((a, b) => a + b, 0) / EMA50_PERIOD;

// Map: openTime (ms) -> { close, ema50 }
const hourEma50Map = new Map();
for (let i = 0; i < candles1h.length; i++) {
  if (i >= EMA50_PERIOD) {
    ema50Val = candles1h[i].close * k50 + ema50Val * (1 - k50);
  }
  hourEma50Map.set(candles1h[i].openTime, {
    close: candles1h[i].close,
    ema50: i >= EMA50_PERIOD ? ema50Val : null,
  });
}

/**
 * Given a 5m candle open time (ms), find the current hourly candle's EMA50.
 * A 5m candle at time T belongs to the 1h candle that opened at floor(T, 1h).
 */
function getMacroTrend(openTimeMs) {
  const hourMs = Math.floor(openTimeMs / 3_600_000) * 3_600_000;
  const entry = hourEma50Map.get(hourMs);
  if (!entry || entry.ema50 === null) return null;
  return entry.close >= entry.ema50 ? "UP" : "DOWN";
}

// ---------------------------------------------------------------------------
// Intraday VWAP resetting at midnight UTC
// We process 5m candles in order, resetting cumulative PV/V each new UTC day.
// ---------------------------------------------------------------------------
console.log("Computing intraday VWAP for each 5m candle...");

/** Returns midnight UTC timestamp for a given ms timestamp */
function midnightUtc(ms) {
  return Math.floor(ms / 86_400_000) * 86_400_000;
}

const vwapValues = new Array(candles5m.length).fill(null);
let cumPV = 0;
let cumV = 0;
let currentDay = -1;

for (let i = 0; i < candles5m.length; i++) {
  const c = candles5m[i];
  const dayStart = midnightUtc(c.openTime);
  if (dayStart !== currentDay) {
    cumPV = 0;
    cumV = 0;
    currentDay = dayStart;
  }
  const tp = (c.high + c.low + c.close) / 3;
  cumPV += tp * c.volume;
  cumV += c.volume;
  vwapValues[i] = cumV === 0 ? null : cumPV / cumV;
}

// ---------------------------------------------------------------------------
// Main loop: compute per-candle features and accumulate calibration buckets
// ---------------------------------------------------------------------------
console.log("Computing features and accumulating calibration buckets...");

// We need rolling windows of closes for RSI(14), BB(20), and candle objects for CHOP(14).
// Use a sliding buffer approach — maintain arrays of the last N items.

const RSI_PERIOD = 14;
const BB_PERIOD = 20;
const CHOP_PERIOD = 14;

// Minimum window size needed: max(RSI_PERIOD+1, BB_PERIOD, CHOP_PERIOD+1)
// RSI needs 15 closes (i-14..i), BB needs 20, CHOP needs 15 candles
const MIN_WINDOW = Math.max(RSI_PERIOD + 1, BB_PERIOD, CHOP_PERIOD + 1);

// Rolling close buffer and candle buffer
const closeBuffer = [];
const candleBuffer = [];

// calibration map: key -> { n, upsN }
// key = `${hour}|${macro}|${pvwap}|${rsiZone}`
const calibMap = new Map();

function bucketKey(hour, macro, pvwap, rsiZone) {
  return `${hour}|${macro}|${pvwap}|${rsiZone}`;
}

function accum(key, isUp) {
  let entry = calibMap.get(key);
  if (!entry) {
    entry = { n: 0, upsN: 0 };
    calibMap.set(key, entry);
  }
  entry.n++;
  if (isUp) entry.upsN++;
}

// We iterate up to candles5m.length - 1 because we need the NEXT candle's close for actualUp
let skipped = 0;

for (let i = 0; i < candles5m.length - 1; i++) {
  const c = candles5m[i];
  const nextClose = candles5m[i + 1].close;

  // Update rolling buffers
  closeBuffer.push(c.close);
  candleBuffer.push(c);
  if (closeBuffer.length > MIN_WINDOW + 5) {
    closeBuffer.shift();
    candleBuffer.shift();
  }

  // Skip until we have enough history
  if (closeBuffer.length < MIN_WINDOW) {
    skipped++;
    continue;
  }

  // --- actualUp ---
  const actualUp = nextClose > c.close;

  // --- utcHour ---
  const utcHour = new Date(c.openTime).getUTCHours();

  // --- macroTrend ---
  const macro = getMacroTrend(c.openTime);
  if (macro === null) { skipped++; continue; }

  // --- priceVsVwap ---
  const vwap = vwapValues[i];
  if (vwap === null) { skipped++; continue; }
  const pvwap = c.close >= vwap ? "ABOVE" : "BELOW";

  // --- rsiZone ---
  const rsiVal = rsi(closeBuffer, RSI_PERIOD);
  if (rsiVal === null) { skipped++; continue; }
  const rsiZone =
    rsiVal > 60 ? "OVERBOUGHT" : rsiVal < 40 ? "OVERSOLD" : "NEUTRAL";

  // Accumulate into the calibration bucket
  const key = bucketKey(utcHour, macro, pvwap, rsiZone);
  accum(key, actualUp);
}

console.log(`Feature computation done. Skipped ${skipped} candles (warm-up / missing data).`);
console.log(`Unique condition buckets: ${calibMap.size}`);

// ---------------------------------------------------------------------------
// Build calibration output array
// ---------------------------------------------------------------------------
const calibration = [];

for (const [key, { n, upsN }] of calibMap.entries()) {
  const [hourStr, macro, priceVsVwap, rsiZone] = key.split("|");
  const hour = parseInt(hourStr, 10);
  const upRate = n > 0 ? upsN / n : 0.5;
  const ci95 = n > 0 ? 1.96 * Math.sqrt((upRate * (1 - upRate)) / n) : 0.5;
  const edge50 = upRate - 0.5;

  calibration.push({
    hour,
    macro,
    priceVsVwap,
    rsiZone,
    n,
    upRate: parseFloat(upRate.toFixed(6)),
    ci95: parseFloat(ci95.toFixed(6)),
    edge50: parseFloat(edge50.toFixed(6)),
  });
}

// Sort by hour then macro then priceVsVwap then rsiZone for readability
calibration.sort((a, b) => {
  if (a.hour !== b.hour) return a.hour - b.hour;
  if (a.macro !== b.macro) return a.macro.localeCompare(b.macro);
  if (a.priceVsVwap !== b.priceVsVwap) return a.priceVsVwap.localeCompare(b.priceVsVwap);
  return a.rsiZone.localeCompare(b.rsiZone);
});

// Write JSON
writeFileSync(OUT_PATH, JSON.stringify(calibration, null, 2), "utf8");
console.log(`\nWrote ${calibration.length} entries to ${OUT_PATH}`);

// ---------------------------------------------------------------------------
// Markdown summary to stdout
// ---------------------------------------------------------------------------
const MIN_N = 100;

const qualified = calibration.filter((e) => e.n >= MIN_N);
const sigEdge = qualified.filter((e) => Math.abs(e.edge50) > e.ci95);

// Sort by upRate desc for top, asc for bottom
const byUpRateDesc = [...qualified].sort((a, b) => b.upRate - a.upRate);
const byUpRateAsc = [...qualified].sort((a, b) => a.upRate - b.upRate);

const top15 = byUpRateDesc.slice(0, 15);
const bot15 = byUpRateAsc.slice(0, 15);

function fmtRow(e) {
  const sig = Math.abs(e.edge50) > e.ci95 ? " ✓" : "";
  return (
    `| H${String(e.hour).padStart(2, "0")} ` +
    `| ${e.macro.padEnd(4)} ` +
    `| ${e.priceVsVwap.padEnd(5)} ` +
    `| ${e.rsiZone.padEnd(10)} ` +
    `| ${String(e.n).padStart(5)} ` +
    `| ${(e.upRate * 100).toFixed(2).padStart(6)}% ` +
    `| ±${(e.ci95 * 100).toFixed(2).padStart(5)}% ` +
    `| ${(e.edge50 * 100).toFixed(2).padStart(6)}%${sig} |`
  );
}

const header = [
  "| Hour | Macro | VWAP  | RSI Zone   |     N | upRate | CI95   | edge50     |",
  "|------|-------|-------|------------|-------|--------|--------|------------|",
];

const lines = [];
lines.push("");
lines.push("# Calibration Summary");
lines.push("");
lines.push(`Total candles processed: ${candles5m.length - 1}`);
lines.push(`Buckets with n ≥ ${MIN_N}: ${qualified.length} / ${calibration.length}`);
lines.push(`Statistically significant buckets (|edge50| > ci95, n ≥ ${MIN_N}): ${sigEdge.length}`);
lines.push("");
lines.push("## Top 15 — Highest UP Rate (n ≥ 100)");
lines.push("");
lines.push("✓ = statistically significant edge (|edge50| > CI95)");
lines.push("");
lines.push(...header);
top15.forEach((e) => lines.push(fmtRow(e)));
lines.push("");
lines.push("## Bottom 15 — Lowest UP Rate (n ≥ 100)");
lines.push("");
lines.push(...header);
bot15.forEach((e) => lines.push(fmtRow(e)));
lines.push("");
lines.push("## Statistical Significance Note");
lines.push("");
lines.push(
  "A condition has statistically significant edge when |edge50| > CI95 (95% confidence interval).",
);
lines.push(
  "This means the observed UP rate is unlikely to be random noise at the 5% significance level.",
);
lines.push(
  "Only trade conditions marked ✓ — unmarked rows may reflect sampling variance rather than true edge.",
);
lines.push(
  `\nOf ${qualified.length} qualified conditions (n ≥ ${MIN_N}), ${sigEdge.length} have significant edge ` +
  `(${((sigEdge.length / qualified.length) * 100).toFixed(1)}%).`,
);

if (sigEdge.length > 0) {
  const bullish = sigEdge.filter((e) => e.edge50 > 0).sort((a, b) => b.edge50 - a.edge50);
  const bearish = sigEdge.filter((e) => e.edge50 < 0).sort((a, b) => a.edge50 - b.edge50);
  lines.push(
    `\nBullish edge (upRate > 50%): ${bullish.length} conditions. ` +
    `Max upRate: ${bullish[0] ? (bullish[0].upRate * 100).toFixed(2) + "%" : "N/A"}`,
  );
  lines.push(
    `Bearish edge (upRate < 50%): ${bearish.length} conditions. ` +
    `Min upRate: ${bearish[0] ? (bearish[0].upRate * 100).toFixed(2) + "%" : "N/A"}`,
  );
}

lines.push("");
console.log(lines.join("\n"));
