/**
 * HF backtest — Stage 2 (strategy replay).
 *
 * Loads entries.json (per-market market price + spread + outcome) and replays the
 * REAL production strategy on each BTC-15m market, computing features from Binance
 * 1m/1h klines exactly as the live bot does (240×1m, 60×1h). No strategy logic is
 * reimplemented — engines are imported from src/.
 *
 * The live `decide()` reads `new Date().getUTCHours()` for its blocked-hours gate,
 * so we mock the clock to the historical entry time during each decide() call.
 *
 * Usage: node scripts/hf-backtest/run.mjs
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, "..", "..");

// ── Load .env then force the 15m calibration BEFORE importing engines ──────────
for (const line of readFileSync(join(ROOT, ".env"), "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
}
const WIN = Number(process.argv[2]) || 15;
process.env.CANDLE_WINDOW_MINUTES = String(WIN);

const { computeVwapSeries } = await import(join(ROOT, "src/indicators/vwap.js"));
const { computeRsi, computeRsiSeries, sma, slopeLast } = await import(join(ROOT, "src/indicators/rsi.js"));
const { computeChop, computeBBWidth } = await import(join(ROOT, "src/indicators/chop.js"));
const { computeMacroTrend } = await import(join(ROOT, "src/engines/macroTrend.js"));
const { estimateSigmaPerSqrtMin, settlementProbability } = await import(join(ROOT, "src/engines/settlementProb.js"));
const { lookupRate } = await import(join(ROOT, "src/engines/calibratedRate.js"));
const { computeEdge, decide } = await import(join(ROOT, "src/engines/edge.js"));
const { detectRegime } = await import(join(ROOT, "src/engines/regime.js"));
const { estimateTakerFee } = await import(join(ROOT, "src/execution/paperMath.js"));

const CFG = {
  vwapSlopeLookbackMinutes: 5, rsiPeriod: 14, rsiMaPeriod: 14,
  macdFast: 12, macdSlow: 26, macdSignal: 9, windowMinutes: WIN,
};
const ORDER_SIZE   = Number(process.env.RISK_ORDER_SIZE_USDC ?? 2);
const MIN_EDGE     = Number(process.env.RISK_MIN_EDGE ?? 0.15);
const MIN_TOKEN_PX = Number(process.env.RISK_MIN_TOKEN_PRICE ?? 0.30);
const SESS_START   = Number(process.env.RISK_SESSION_START_UTC ?? 8);
const SESS_END     = Number(process.env.RISK_SESSION_END_UTC ?? 23);

function withMockedNow(ts, fn) {
  const RealDate = Date;
  class MockDate extends RealDate {
    constructor(...a) { if (a.length === 0) super(ts); else super(...a); }
    static now() { return ts; }
  }
  globalThis.Date = MockDate;
  try { return fn(); } finally { globalThis.Date = RealDate; }
}

// ── Binance klines (fetch + cache) ─────────────────────────────────────────────
const CACHE = join(__dir, "cache");
if (!existsSync(CACHE)) mkdirSync(CACHE, { recursive: true });
const IVL_MS = { "1m": 60_000, "1h": 3_600_000 };

async function klines(interval, startMs, endMs) {
  const key = join(CACHE, `BTCUSDT_${interval}_${startMs}_${endMs}.json`);
  if (existsSync(key)) return JSON.parse(readFileSync(key, "utf8"));
  const out = []; let cursor = startMs;
  process.stderr.write(`[binance] fetching ${interval} ${new Date(startMs).toISOString()}..${new Date(endMs).toISOString()}\n`);
  while (cursor < endMs) {
    const url = `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=${interval}&startTime=${cursor}&endTime=${endMs}&limit=1000`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Binance ${res.status}: ${await res.text()}`);
    const batch = await res.json();
    if (!batch.length) break;
    out.push(...batch);
    cursor = batch[batch.length - 1][0] + IVL_MS[interval];
    if (batch.length < 1000) break;
    await new Promise(r => setTimeout(r, 60));
  }
  const mapped = out.map(k => ({
    openTime: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5],
  }));
  writeFileSync(key, JSON.stringify(mapped));
  return mapped;
}

// ── Main ────────────────────────────────────────────────────────────────────
const LABEL = process.argv[3] || `${WIN}m`;
const entries = JSON.parse(readFileSync(join(__dir, `entries_${LABEL}.json`), "utf8"));
const minEntry = Math.min(...entries.map(e => e.start_ts));
const maxEnd   = Math.max(...entries.map(e => e.end_ts));

const k1m = await klines("1m", minEntry - 5 * 3_600_000, maxEnd + 2 * 60_000);
const k1h = await klines("1h", minEntry - 70 * 3_600_000, maxEnd + 60_000);
process.stderr.write(`[binance] 1m=${k1m.length} 1h=${k1h.length}\n`);

// bars with openTime <= ts (k assumed ascending by openTime)
function barsUpTo(k, ts, count) {
  let hi = k.length - 1, lo = 0, idx = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (k[mid].openTime <= ts) { idx = mid; lo = mid + 1; } else hi = mid - 1; }
  if (idx < 0) return [];
  return k.slice(Math.max(0, idx - count + 1), idx + 1);
}
function priceAt(k, ts) { const b = barsUpTo(k, ts, 1); return b.length ? b[0].close : null; }
function priceAtOpen(k, ts) { // open of the bar covering ts (strike at window open)
  let hi = k.length - 1, lo = 0, idx = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (k[mid].openTime <= ts) { idx = mid; lo = mid + 1; } else hi = mid - 1; }
  return idx < 0 ? null : k[idx].open;
}

const clamp = (x, a, b) => Math.min(Math.max(x, a), b);
const noTradeReasons = {};
const candidates = []; // entries that pass decide() + session + tokenPrice gates
const allEval = [];    // every market with a computed model (pre-gate) — unbiased

for (const e of entries) {
  const candles = barsUpTo(k1m, e.entry_ts, 240);
  const k1hSlice = barsUpTo(k1h, e.entry_ts, 60);
  if (candles.length < 60 || k1hSlice.length < 50) { noTradeReasons.insufficient_klines = (noTradeReasons.insufficient_klines||0)+1; continue; }
  const closes = candles.map(c => c.close);
  const lastPrice = closes[closes.length - 1];

  const vwapSeries = computeVwapSeries(candles);
  const vwapNow = vwapSeries[vwapSeries.length - 1];
  const lb = CFG.vwapSlopeLookbackMinutes;
  const vwapSlope = vwapSeries.length >= lb ? (vwapNow - vwapSeries[vwapSeries.length - lb]) / lb : null;
  const rsiNow = computeRsi(closes, CFG.rsiPeriod);
  const chop = computeChop(candles, 60);
  const bbWidthPct = computeBBWidth(closes, 20, 2);
  const sigmaPerSqrtMin = estimateSigmaPerSqrtMin(candles);
  const macroInfo = computeMacroTrend(k1hSlice);

  // regime gate inputs
  const vwapCrossCount = (() => { let c = 0; for (let i = Math.max(1, closes.length - 20); i < closes.length; i++) {
    const a = closes[i-1] - (vwapSeries[i-1] ?? closes[i-1]); const b = closes[i] - (vwapSeries[i] ?? closes[i]);
    if ((a < 0 && b >= 0) || (a > 0 && b <= 0)) c++; } return c; })();
  const volumeRecent = candles.slice(-20).reduce((a, c) => a + c.volume, 0);
  const volumeAvg = candles.slice(-120).reduce((a, c) => a + c.volume, 0) / 6;
  const regimeInfo = detectRegime({ price: lastPrice, vwap: vwapNow, vwapSlope, vwapCrossCount, volumeRecent, volumeAvg });

  const priceVsVwap = (lastPrice !== null && vwapNow != null) ? (lastPrice >= vwapNow ? "ABOVE" : "BELOW") : null;
  const rsiZone = rsiNow === null ? null : rsiNow > 60 ? "OVERBOUGHT" : rsiNow < 40 ? "OVERSOLD" : "NEUTRAL";

  const calibrated = (priceVsVwap !== null && rsiZone !== null && macroInfo.trend !== "NEUTRAL")
    ? lookupRate({ hour: new Date(e.entry_ts).getUTCHours(), macro: macroInfo.trend, priceVsVwap, rsiZone })
    : { upRate: 0.5 };

  const strike = priceAtOpen(k1m, e.start_ts);
  const spot = priceAt(k1m, e.entry_ts);
  const remainingMinutes = (e.end_ts - e.entry_ts) / 60000; // ~14

  const timeAware = settlementProbability({
    spot, strike, remainingMinutes, windowMinutes: CFG.windowMinutes, sigmaPerSqrtMin, baseUpRate: calibrated.upRate,
  });
  const edge = computeEdge({ modelUp: timeAware.adjustedUp, modelDown: timeAware.adjustedDown, marketYes: e.marketUp, marketNo: e.marketDown });

  allEval.push({ modelUp: timeAware.adjustedUp, marketUp: e.marketUp, outcome: e.outcome,
    baseUp: calibrated.upRate, priceUpSinceOpen: spot > strike });

  const rec = withMockedNow(e.entry_ts, () => decide({
    remainingMinutes, edgeUp: edge.edgeUp, edgeDown: edge.edgeDown,
    modelUp: timeAware.adjustedUp, modelDown: timeAware.adjustedDown,
    regime: regimeInfo.regime, macroTrend: macroInfo.trend,
    chop, bbWidthPct, spreadUp: e.effSpread, spreadDown: e.effSpread,
  }));

  if (rec.action !== "ENTER") { noTradeReasons[rec.reason] = (noTradeReasons[rec.reason]||0)+1; continue; }

  // canTrade outer gates (replicated; circuit-breaker/open-positions N/A in backtest)
  const hour = new Date(e.entry_ts).getUTCHours();
  if (hour < SESS_START || hour >= SESS_END) { noTradeReasons.session_window = (noTradeReasons.session_window||0)+1; continue; }
  const mid = rec.side === "UP" ? e.marketUp : e.marketDown;
  if (mid < MIN_TOKEN_PX) { noTradeReasons.token_price_min = (noTradeReasons.token_price_min||0)+1; continue; }
  // (edge>=MIN_EDGE handled in the sweep below)

  candidates.push({ market_id: e.market_id, side: rec.side, edge: rec.edge, mid, effSpread: e.effSpread, outcome: e.outcome,
    modelUp: timeAware.adjustedUp, marketUp: e.marketUp });
}

// ── DIAGNOSTIC: is the signal real or inverted? ───────────────────────────────
{
  const wr = (arr, pick) => { let w=0; for (const c of arr) { const s = pick(c); if ((s==="UP"&&c.outcome==="Up")||(s==="DOWN"&&c.outcome==="Down")) w++; } return arr.length? w/arr.length*100:0; };
  const D = candidates;
  console.log(`\n[DIAGNÓSTICO] sobre ${D.length} candidatos:`);
  console.log(`  nosso lado (modelo vs mercado): ${wr(D, c=>c.side).toFixed(1)}%`);
  console.log(`  lado OPOSTO ao nosso:           ${wr(D, c=>c.side==="UP"?"DOWN":"UP").toFixed(1)}%`);
  console.log(`  favorito do mercado (mid>0.5):  ${wr(D, c=>c.marketUp>=0.5?"UP":"DOWN").toFixed(1)}%`);
  console.log(`  só pelo modelo (modelUp>0.5):   ${wr(D, c=>c.modelUp>=0.5?"UP":"DOWN").toFixed(1)}%`);
  console.log(`  sempre UP:                      ${wr(D, ()=> "UP").toFixed(1)}%`);
  const agree = D.filter(c => c.side === (c.marketUp>=0.5?"UP":"DOWN")).length;
  console.log(`  nosso lado == favorito mercado: ${(agree/D.length*100).toFixed(1)}% das vezes`);

  // Unbiased: model predictiveness over ALL markets (pre-gate)
  const A = allEval;
  const wrU = (arr, pick) => { let w=0; for (const c of arr) { const s = pick(c); if ((s==="UP"&&c.outcome==="Up")||(s==="DOWN"&&c.outcome==="Down")) w++; } return arr.length? w/arr.length*100:0; };
  console.log(`\n[DIAGNÓSTICO sem filtros] sobre ${A.length} mercados:`);
  console.log(`  modelo (modelUp>0.5):           ${wrU(A, c=>c.modelUp>=0.5?"UP":"DOWN").toFixed(1)}%`);
  console.log(`  calibração pura (baseUp>0.5):   ${wrU(A, c=>c.baseUp>=0.5?"UP":"DOWN").toFixed(1)}%`);
  console.log(`  preço subiu desde abertura:     ${wrU(A, c=>c.priceUpSinceOpen?"UP":"DOWN").toFixed(1)}%`);
  console.log(`  favorito do mercado:            ${wrU(A, c=>c.marketUp>=0.5?"UP":"DOWN").toFixed(1)}%`);
  console.log(`  sempre UP:                      ${wrU(A, ()=> "UP").toFixed(1)}%`);
}

// ── Aggregate + min-edge sweep ────────────────────────────────────────────────
function simulate(cands, { slippage }) {
  let pnl = 0, wins = 0, n = 0, staked = 0;
  for (const c of cands) {
    const entryPx = clamp(c.mid + (slippage ? c.effSpread / 2 : 0), 0.01, 0.99);
    const won = (c.side === "UP" && c.outcome === "Up") || (c.side === "DOWN" && c.outcome === "Down");
    const gross = won ? ORDER_SIZE * (1 / entryPx - 1) : -ORDER_SIZE;
    const fee = estimateTakerFee({ usdcAmount: ORDER_SIZE, entryPrice: entryPx });
    pnl += gross - fee; staked += ORDER_SIZE; if (won) wins++; n++;
  }
  return { n, wins, winRate: n ? wins / n : 0, pnl, roi: staked ? pnl / staked : 0 };
}

console.log(`\n${"=".repeat(72)}`);
console.log(`HF BACKTEST — BTC ${WIN}m — ${entries.length} mercados avaliados (Mar 2026)`);
console.log(`Engines reais de src/ • entrada ~14min • stake $${ORDER_SIZE} • fee ${process.env.RISK_TAKER_FEE_RATE ?? 0.07}`);
console.log("=".repeat(72));

console.log(`\nFiltrados (não entraram), por motivo:`);
for (const [r, c] of Object.entries(noTradeReasons).sort((a,b)=>b[1]-a[1])) console.log(`  ${String(r).padEnd(34)} ${c}`);
console.log(`\nCandidatos que passaram decide()+sessão+token: ${candidates.length}`);

const thresholds = [0.05, 0.08, 0.10, 0.12, 0.15, 0.18, 0.20, 0.25];
console.log(`\n${"min_edge".padEnd(9)}${"trades".padEnd(8)}${"winRate".padEnd(10)}${"ROI/trade".padEnd(12)}${"PnL($)".padEnd(11)}| sem slippage`);
console.log("-".repeat(72));
for (const t of thresholds) {
  const cs = candidates.filter(c => c.edge >= t);
  const w = simulate(cs, { slippage: true });
  const ns = simulate(cs, { slippage: false });
  console.log(
    `${String(t).padEnd(9)}${String(w.n).padEnd(8)}${(w.winRate*100).toFixed(1).padEnd(2)}%`.padEnd(27) +
    `${(w.roi*100>=0?"+":"")}${(w.roi*100).toFixed(2)}%`.padEnd(12) +
    `${(w.pnl>=0?"+":"")}${w.pnl.toFixed(2)}`.padEnd(11) +
    `| ${(ns.roi*100>=0?"+":"")}${(ns.roi*100).toFixed(2)}%  (${ns.wins}/${ns.n})`
  );
}

// live config uses MIN_EDGE — highlight that row
const liveCs = candidates.filter(c => c.edge >= MIN_EDGE);
const live = simulate(liveCs, { slippage: true });
const liveNoSlip = simulate(liveCs, { slippage: false });
console.log(`\n>>> CONFIG ATUAL (RISK_MIN_EDGE=${MIN_EDGE}):`);
console.log(`    trades=${live.n}  winRate=${(live.winRate*100).toFixed(1)}%  ROI/trade=${(live.roi*100).toFixed(2)}%  PnL=$${live.pnl.toFixed(2)}`);
console.log(`    breakeven winRate (no preço médio de entrada) ≈ ${(liveCs.length? (liveCs.reduce((a,c)=>a+clamp(c.mid+c.effSpread/2,0.01,0.99),0)/liveCs.length*100):0).toFixed(1)}%`);
console.log(`    sem slippage: ROI/trade=${(liveNoSlip.roi*100).toFixed(2)}%  winRate=${(liveNoSlip.winRate*100).toFixed(1)}%`);
console.log("");
