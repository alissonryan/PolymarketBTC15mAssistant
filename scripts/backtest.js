/**
 * Historical backtest + pattern analysis for BTC 5m/15m binary prediction.
 *
 * Usage:
 *   node scripts/backtest.js [--interval 5m|15m] [--days 365] [--no-cache]
 *
 * Output: markdown report to stdout.
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(__dir, "cache");
if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });

// ── CLI args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const INTERVAL  = args.includes("--interval") ? args[args.indexOf("--interval") + 1] : "5m";
const DAYS      = args.includes("--days")     ? Number(args[args.indexOf("--days") + 1])    : 365;
const NO_CACHE  = args.includes("--no-cache");

const INTERVAL_MS = INTERVAL === "15m" ? 15 * 60 * 1000 : 5 * 60 * 1000;

// ── Data fetching ─────────────────────────────────────────────────────────────

async function fetchKlines(symbol, interval, startMs, endMs) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&startTime=${startMs}&endTime=${endMs}&limit=1000`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance API ${res.status}: ${await res.text()}`);
  return res.json();
}

function cacheKey(interval, days) {
  return join(CACHE_DIR, `BTCUSDT_${interval}_${days}d.json`);
}

async function loadOrFetch(interval, days) {
  const key = cacheKey(interval, days);
  if (!NO_CACHE && existsSync(key)) {
    process.stderr.write(`[cache] loading ${key}\n`);
    return JSON.parse(readFileSync(key, "utf8"));
  }

  const endMs   = Date.now();
  const startMs = endMs - days * 24 * 60 * 60 * 1000;
  const all     = [];
  let   cursor  = startMs;

  process.stderr.write(`[fetch] pulling ${days}d of ${interval} BTCUSDT from Binance…\n`);

  while (cursor < endMs) {
    const batch = await fetchKlines("BTCUSDT", interval, cursor, endMs);
    if (!batch.length) break;
    all.push(...batch);
    cursor = batch[batch.length - 1][0] + INTERVAL_MS;
    process.stderr.write(`  ${all.length} candles fetched\r`);
    if (batch.length < 1000) break;
    await new Promise(r => setTimeout(r, 80)); // gentle rate limiting
  }

  process.stderr.write(`\n[fetch] done — ${all.length} candles\n`);
  writeFileSync(key, JSON.stringify(all));
  return all;
}

// ── Indicator helpers ─────────────────────────────────────────────────────────

function computeRsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses += -d;
  }
  const rs = (gains / period) / (losses / period || 1e-9);
  return 100 - 100 / (1 + rs);
}

function computeEma(closes, period) {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let v = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) v = closes[i] * k + v * (1 - k);
  return v;
}

function computeMacdSimple(closes) {
  if (closes.length < 35) return null;
  const fast = computeEma(closes, 12);
  const slow = computeEma(closes, 26);
  if (fast === null || slow === null) return null;
  const macdLine = fast - slow;
  // approximate signal from last 9 macd values
  const macdSeries = [];
  for (let i = 26; i < closes.length; i++) {
    const f = computeEma(closes.slice(0, i + 1), 12);
    const s = computeEma(closes.slice(0, i + 1), 26);
    if (f !== null && s !== null) macdSeries.push(f - s);
  }
  const signalLine = computeEma(macdSeries, 9);
  if (signalLine === null) return null;
  const hist = macdLine - signalLine;
  const prevHist = macdSeries.length >= 2
    ? macdSeries[macdSeries.length - 2] - computeEma(macdSeries.slice(0, -1), 9)
    : null;
  return { macd: macdLine, hist, histDelta: prevHist === null ? null : hist - prevHist };
}

function computeHeikenLast(candles) {
  if (candles.length < 2) return null;
  let prevHaOpen = (candles[0].open + candles[0].close) / 2;
  let prevHaClose = (candles[0].open + candles[0].high + candles[0].low + candles[0].close) / 4;
  let count = 1, color = prevHaClose >= prevHaOpen ? "green" : "red";

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const haClose = (c.open + c.high + c.low + c.close) / 4;
    const haOpen  = (prevHaOpen + prevHaClose) / 2;
    const newColor = haClose >= haOpen ? "green" : "red";
    if (newColor === color) count++; else { count = 1; color = newColor; }
    prevHaOpen = haOpen; prevHaClose = haClose;
  }
  return { color, count };
}

function computeBbWidth(closes, period = 20) {
  if (closes.length < period) return null;
  const sl = closes.slice(-period);
  const m  = sl.reduce((a, b) => a + b, 0) / period;
  const v  = sl.reduce((a, b) => a + (b - m) ** 2, 0) / period;
  return m === 0 ? null : (4 * Math.sqrt(v) / m) * 100;
}

function computeChop(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const sl = candles.slice(-period - 1);
  let atr = 0, hh = -Infinity, ll = Infinity;
  for (let i = 1; i <= period; i++) {
    const c = sl[i], p = sl[i - 1];
    atr += Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    if (c.high > hh) hh = c.high;
    if (c.low  < ll) ll = c.low;
  }
  const range = hh - ll;
  return range === 0 ? null : (100 * Math.log10(atr / range)) / Math.log10(period);
}

// Daily VWAP reset at midnight UTC
function buildDailyVwapSeries(candles) {
  const vwap = new Array(candles.length).fill(null);
  let pv = 0, vol = 0, dayStart = -1;

  for (let i = 0; i < candles.length; i++) {
    const c   = candles[i];
    const day = Math.floor(c.time / 86400000);
    if (day !== dayStart) { pv = 0; vol = 0; dayStart = day; }
    const tp = (c.high + c.low + c.close) / 3;
    pv  += tp * c.volume;
    vol += c.volume;
    vwap[i] = vol === 0 ? null : pv / vol;
  }
  return vwap;
}

// ── Scoring (mirrors probability.js scoreDirection) ───────────────────────────

function scoreDirection({ price, vwap, vwapSlope, rsi, rsiSlope, macd, heiken }) {
  let up = 1, down = 1;

  if (price !== null && vwap !== null) {
    if (price > vwap) up += 2; else down += 2;
  }
  if (vwapSlope !== null) {
    if (vwapSlope > 0) up += 2; else down += 2;
  }
  if (rsi !== null && rsiSlope !== null) {
    if (rsi > 55 && rsiSlope > 0) up += 2;
    if (rsi < 45 && rsiSlope < 0) down += 2;
  }
  if (macd !== null) {
    if (macd.hist > 0 && macd.histDelta > 0) up += 2;
    if (macd.hist < 0 && macd.histDelta < 0) down += 2;
    if (macd.macd > 0) up += 1; else down += 1;
  }
  if (heiken !== null) {
    if (heiken.color === "green" && heiken.count >= 2) up += 1;
    if (heiken.color === "red"   && heiken.count >= 2) down += 1;
  }

  const rawUp = up / (up + down);
  const edge  = Math.abs(rawUp - 0.5) * 2; // 0..1 normalised
  return { rawUp, edge, side: rawUp > 0.5 ? "UP" : "DOWN" };
}

// ── Main ──────────────────────────────────────────────────────────────────────

const raw = await loadOrFetch("5m", DAYS);

// Also fetch 1h for macro trend
const raw1h = await loadOrFetch("1h", DAYS);

// Parse candles
const candles5m = raw.map(k => ({
  time:   k[0],
  open:   parseFloat(k[1]),
  high:   parseFloat(k[2]),
  low:    parseFloat(k[3]),
  close:  parseFloat(k[4]),
  volume: parseFloat(k[5]),
}));

const candles1h = raw1h.map(k => ({
  time:  k[0],
  close: parseFloat(k[4]),
}));

process.stderr.write(`[analyse] ${candles5m.length} 5m candles, ${candles1h.length} 1h candles\n`);

// Build VWAP series on 5m
const vwapSeries = buildDailyVwapSeries(candles5m);

// Build 1h EMA50 lookup by timestamp
const ema1hByHour = new Map();
for (let i = 50; i < candles1h.length; i++) {
  const closes = candles1h.slice(0, i + 1).map(x => x.close);
  const e = computeEma(closes, 50);
  ema1hByHour.set(candles1h[i].time, e);
}
function getMacroAt(tsMs) {
  // find nearest 1h candle at or before tsMs
  const hourMs = 3600000;
  const bucket = Math.floor(tsMs / hourMs) * hourMs;
  return ema1hByHour.get(bucket) ?? null;
}

// Warmup period needed
const WARMUP = 80; // enough for MACD(26) + signal(9) + CHOP(14) + RSI(14)

// ── Simulation ────────────────────────────────────────────────────────────────

const trades = [];

for (let i = WARMUP; i < candles5m.length - 1; i++) {
  const c    = candles5m[i];
  const next = candles5m[i + 1];

  const closes = candles5m.slice(i - 60, i + 1).map(x => x.close);
  const rsi    = computeRsi(closes.slice(-15));
  const rsiPrev= computeRsi(closes.slice(-16, -1));
  const rsiSlope = rsi !== null && rsiPrev !== null ? rsi - rsiPrev : null;

  const macd   = computeMacdSimple(closes);
  const heiken = computeHeikenLast(candles5m.slice(i - 10, i + 1));
  const vwap   = vwapSeries[i];
  const vwapPrev = vwapSeries[i - 1];
  const vwapSlope = vwap !== null && vwapPrev !== null ? vwap - vwapPrev : null;
  const bbWidth = computeBbWidth(closes.slice(-20));
  const chop    = computeChop(candles5m.slice(i - 14, i + 1).map(x => ({
    high: x.high, low: x.low, close: x.close
  })));

  const macro1hEma = getMacroAt(c.time);
  const macroTrend = macro1hEma !== null
    ? (c.close > macro1hEma ? "UP" : "DOWN")
    : null;

  const score = scoreDirection({ price: c.close, vwap, vwapSlope, rsi, rsiSlope, macd, heiken });

  const actualUp = next.close > c.close;
  const utcHour  = new Date(c.time).getUTCHours();
  const utcDay   = new Date(c.time).getUTCDay(); // 0=Sun
  const utcMonth = new Date(c.time).getUTCMonth() + 1;

  trades.push({
    ts: c.time,
    utcHour,
    utcDay,
    utcMonth,
    side: score.side,
    rawUp: score.rawUp,
    edge: score.edge,
    actualUp,
    correct: score.side === "UP" ? actualUp : !actualUp,
    bbWidth,
    chop,
    macroTrend,
    priceChange: (next.close - c.close) / c.close * 100,
  });
}

process.stderr.write(`[analyse] ${trades.length} simulated decisions\n`);

// ── Analysis helpers ──────────────────────────────────────────────────────────

function wr(arr) {
  if (!arr.length) return null;
  return arr.filter(x => x.correct).length / arr.length;
}

function wrFmt(arr) {
  const w = wr(arr);
  if (w === null) return "N/A";
  return `${(w * 100).toFixed(1)}% (n=${arr.length})`;
}

function table(rows, headers) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map(r => String(r[i]).length)));
  const sep = "| " + widths.map(w => "-".repeat(w)).join(" | ") + " |";
  const head = "| " + headers.map((h, i) => h.padEnd(widths[i])).join(" | ") + " |";
  const body = rows.map(r => "| " + r.map((c, i) => String(c).padEnd(widths[i])).join(" | ") + " |");
  return [head, sep, ...body].join("\n");
}

const DAYS_STR = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
const MONTHS_STR = ["","Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

// ── Report ────────────────────────────────────────────────────────────────────

const lines = [];
const push = (...l) => lines.push(...l);

const period = `${new Date(candles5m[0].time).toISOString().slice(0,10)} → ${new Date(candles5m[candles5m.length-1].time).toISOString().slice(0,10)}`;
const overallWr = wr(trades);

push(
  `# BTC 5m Binary Prediction — Historical Backtest`,
  ``,
  `**Period:** ${period} (${DAYS} days)  `,
  `**Candles:** ${candles5m.length}  `,
  `**Simulated decisions:** ${trades.length}  `,
  `**Overall model accuracy:** ${(overallWr * 100).toFixed(2)}%`,
  ``,
  `> Base rate (random 50/50): 50.00%  `,
  `> Model lift: ${((overallWr - 0.5) * 100).toFixed(2)}pp`,
  ``,
);

// ── By UTC hour ──────────────────────────────────────────────────────────────
push(`## 1. Performance by UTC Hour`, ``);
const hourRows = [];
for (let h = 0; h < 24; h++) {
  const slice = trades.filter(x => x.utcHour === h);
  if (!slice.length) continue;
  const w = wr(slice);
  const flag = w >= 0.54 ? "✅" : w <= 0.46 ? "❌" : "~";
  hourRows.push([`${String(h).padStart(2,"0")}h UTC`, slice.length, `${(w*100).toFixed(1)}%`, flag]);
}
push(table(hourRows, ["Hour", "n", "WR", ""]));
push(``);

// ── By day of week ────────────────────────────────────────────────────────────
push(`## 2. Performance by Day of Week`, ``);
const dayRows = DAYS_STR.map((d, i) => {
  const slice = trades.filter(x => x.utcDay === i);
  const w = wr(slice);
  if (!slice.length) return null;
  const flag = w >= 0.54 ? "✅" : w <= 0.46 ? "❌" : "~";
  return [d, slice.length, `${(w*100).toFixed(1)}%`, flag];
}).filter(Boolean);
push(table(dayRows, ["Day", "n", "WR", ""]));
push(``);

// ── By month ──────────────────────────────────────────────────────────────────
push(`## 3. Performance by Month`, ``);
const monthRows = [];
for (let m = 1; m <= 12; m++) {
  const slice = trades.filter(x => x.utcMonth === m);
  if (!slice.length) continue;
  const w = wr(slice);
  const flag = w >= 0.54 ? "✅" : w <= 0.46 ? "❌" : "~";
  monthRows.push([MONTHS_STR[m], slice.length, `${(w*100).toFixed(1)}%`, flag]);
}
push(table(monthRows, ["Month", "n", "WR", ""]));
push(``);

// ── By edge bucket ────────────────────────────────────────────────────────────
push(`## 4. Model Edge vs Actual Accuracy`, ``);
push(`> If model is calibrated, higher edge should → higher WR.`, ``);
const edgeBuckets = [[0,0.1],[0.1,0.2],[0.2,0.3],[0.3,0.4],[0.4,0.5],[0.5,0.6],[0.6,1.0]];
const edgeRows = edgeBuckets.map(([lo,hi]) => {
  const slice = trades.filter(x => x.edge >= lo && x.edge < hi);
  if (!slice.length) return null;
  const w = wr(slice);
  const flag = w >= 0.54 ? "✅" : w <= 0.46 ? "❌" : "~";
  return [`${lo.toFixed(1)}–${hi.toFixed(1)}`, slice.length, `${(w*100).toFixed(1)}%`, flag];
}).filter(Boolean);
push(table(edgeRows, ["Edge bucket", "n", "WR", ""]));
push(``);

// ── By BB Width ──────────────────────────────────────────────────────────────
push(`## 5. Performance by BB Width (volatility)`, ``);
const bbBuckets = [[0,0.05],[0.05,0.10],[0.10,0.15],[0.15,0.25],[0.25,1.0]];
const bbRows = bbBuckets.map(([lo,hi]) => {
  const slice = trades.filter(x => x.bbWidth !== null && x.bbWidth >= lo && x.bbWidth < hi);
  if (!slice.length) return null;
  const w = wr(slice);
  const flag = w >= 0.54 ? "✅" : w <= 0.46 ? "❌" : "~";
  return [`${lo.toFixed(2)}–${hi.toFixed(2)}%`, slice.length, `${(w*100).toFixed(1)}%`, flag];
}).filter(Boolean);
push(table(bbRows, ["BB Width", "n", "WR", ""]));
push(``);

// ── By CHOP ──────────────────────────────────────────────────────────────────
push(`## 6. Performance by Choppiness Index`, ``);
const chopBuckets = [[0,38.2],[38.2,50],[50,61.8],[61.8,80],[80,100]];
const chopRows = chopBuckets.map(([lo,hi]) => {
  const slice = trades.filter(x => x.chop !== null && x.chop >= lo && x.chop < hi);
  if (!slice.length) return null;
  const w = wr(slice);
  const flag = w >= 0.54 ? "✅" : w <= 0.46 ? "❌" : "~";
  const label = hi <= 38.2 ? "strong trend" : hi <= 61.8 ? "neutral" : "ranging";
  return [`${lo}–${hi} (${label})`, slice.length, `${(w*100).toFixed(1)}%`, flag];
}).filter(Boolean);
push(table(chopRows, ["CHOP range", "n", "WR", ""]));
push(``);

// ── By macro trend ────────────────────────────────────────────────────────────
push(`## 7. Performance by 1H Macro Trend`, ``);
const macroRows = ["UP","DOWN",null].map(mt => {
  const slice = trades.filter(x => x.macroTrend === mt);
  if (!slice.length) return null;
  const w = wr(slice);
  const flag = w >= 0.54 ? "✅" : w <= 0.46 ? "❌" : "~";
  // also check aligned vs counter
  const aligned  = slice.filter(x => x.macroTrend === x.side);
  const counter  = slice.filter(x => x.macroTrend !== x.side && x.macroTrend !== null);
  const wAligned = aligned.length ? `${(wr(aligned)*100).toFixed(1)}%` : "N/A";
  const wCounter = counter.length ? `${(wr(counter)*100).toFixed(1)}%` : "N/A";
  return [mt ?? "NEUTRAL", slice.length, `${(w*100).toFixed(1)}%`, flag, wAligned, wCounter];
}).filter(Boolean);
push(table(macroRows, ["Macro", "n", "WR overall", "", "WR aligned", "WR counter"]));
push(``);

// ── Best / worst combos ───────────────────────────────────────────────────────
push(`## 8. Best & Worst Hour × Macro Trend Combos`, ``);
const comboRows = [];
for (let h = 0; h < 24; h++) {
  for (const mt of ["UP","DOWN"]) {
    const slice = trades.filter(x => x.utcHour === h && x.macroTrend === mt);
    if (slice.length < 30) continue;
    const w = wr(slice);
    if (w >= 0.56 || w <= 0.44) {
      comboRows.push([`${String(h).padStart(2,"0")}h UTC`, mt, slice.length, `${(w*100).toFixed(1)}%`, w>=0.56?"✅ BOM":"❌ RUIM"]);
    }
  }
}
comboRows.sort((a,b) => parseFloat(b[3]) - parseFloat(a[3]));
push(table(comboRows, ["Hour", "Macro", "n", "WR", ""]));
push(``);

// ── Summary & recommendations ─────────────────────────────────────────────────
push(`## 9. Key Findings & Recommendations`, ``);

// best hours
const bestHours  = hourRows.filter(r=>r[3]==="✅").map(r=>r[0]).join(", ");
const worstHours = hourRows.filter(r=>r[3]==="❌").map(r=>r[0]).join(", ");
push(
  `### Hours`,
  `- **Best UTC hours:** ${bestHours || "none"}`,
  `- **Worst UTC hours:** ${worstHours || "none"}`,
  ``,
  `### Edge calibration`,
);
const edgeBest  = edgeRows.filter(r=>r[3]==="✅").map(r=>r[0]).join(", ");
const edgeWorst = edgeRows.filter(r=>r[3]==="❌").map(r=>r[0]).join(", ");
push(
  `- **High-WR edge buckets:** ${edgeBest || "none"}`,
  `- **Low-WR edge buckets (model overconfident):** ${edgeWorst || "none"}`,
  ``,
  `### Volatility`,
);
const bbBest  = bbRows.filter(r=>r[3]==="✅").map(r=>r[0]).join(", ");
const bbWorst = bbRows.filter(r=>r[3]==="❌").map(r=>r[0]).join(", ");
push(
  `- **Sweet spot BB Width:** ${bbBest || "none"}`,
  `- **Avoid BB Width:** ${bbWorst || "none"}`,
  ``,
  `### CHOP`,
);
const chopBest  = chopRows.filter(r=>r[3]==="✅").map(r=>r[0]).join(", ");
const chopWorst = chopRows.filter(r=>r[3]==="❌").map(r=>r[0]).join(", ");
push(
  `- **Best CHOP range:** ${chopBest || "none"}`,
  `- **Worst CHOP range:** ${chopWorst || "none"}`,
  ``,
);

push(`---`, `*Generated by scripts/backtest.js on ${new Date().toISOString()}*`);

console.log(lines.join("\n"));
