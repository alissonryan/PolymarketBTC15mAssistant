import { fetchKlines, fetchLastPrice } from "./data/binance.js";
import { computeMacroTrend } from "./engines/macroTrend.js";
import { computeChop, computeBBWidth } from "./indicators/chop.js";
import { startBinanceTradeStream } from "./data/binanceWs.js";
import { fetchKalshiSnapshot, kalshiToBinanceSymbol } from "./data/kalshi.js";
import { computeVwapSeries } from "./indicators/vwap.js";
import { computeRsi, computeRsiSeries, sma, slopeLast } from "./indicators/rsi.js";
import { computeMacd } from "./indicators/macd.js";
import { computeHeikenAshi, countConsecutive } from "./indicators/heikenAshi.js";
import { CVDAnalyzer } from "./indicators/cvd.js";
import { detectRegime } from "./engines/regime.js";
import { applyTimeAwareness } from "./engines/probability.js";
import { lookupRate } from "./engines/calibratedRate.js";
import { computeEdge, decide } from "./engines/edge.js";
import { TimePriceConvergence } from "./engines/timePriceField.js";
import { LockStrategy } from "./engines/lockStrategy.js";
import { acquirePaperLock, releasePaperLock, onPaperTick, getPaperStats, getPaperPosition } from "./execution/paperTrading.js";
import { appendCsvRow, sleep, formatNumber, formatPct } from "./utils.js";
import { applyGlobalProxyFromEnv } from "./net/proxy.js";
import readline from "node:readline";

applyGlobalProxyFromEnv();

// ─── configuração ─────────────────────────────────────────────────────────────

const SERIES     = process.env.KALSHI_SERIES || "KXBTC15M";
const SYMBOL     = kalshiToBinanceSymbol(SERIES);
const WINDOW_MIN = 15;
const POLL_MS    = 2_000;
const LOG_PREFIX = process.env.PAPER_LOG_PREFIX || "";

const ANSI = {
  reset: "\x1b[0m", red: "\x1b[31m", green: "\x1b[32m",
  yellow: "\x1b[33m", gray: "\x1b[90m", white: "\x1b[97m", dim: "\x1b[2m"
};

function screenWidth() {
  const w = Number(process.stdout?.columns);
  return Number.isFinite(w) && w >= 40 ? w : 80;
}
function sep() { return `${ANSI.white}${"─".repeat(screenWidth())}${ANSI.reset}`; }
function fmtTimeLeft(mins) {
  const s = Math.max(0, Math.floor(mins * 60));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
const LABEL_W = 16;
function kv(label, value) {
  const pad = Math.max(0, LABEL_W - label.length);
  return `${label}${" ".repeat(pad)}${value}`;
}
function renderScreen(text) {
  try {
    readline.cursorTo(process.stdout, 0, 0);
    readline.clearScreenDown(process.stdout);
  } catch { /* ignore */ }
  process.stdout.write(text);
}
function colorPct(n) {
  if (n === null || n === undefined) return `${ANSI.gray}-${ANSI.reset}`;
  const c = n >= 0 ? ANSI.green : ANSI.red;
  return `${c}${n >= 0 ? "+" : ""}${(n * 100).toFixed(0)}%${ANSI.reset}`;
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const cvdAnalyzer  = new CVDAnalyzer({ resetInterval: "1h" });
  const timePriceConv = new TimePriceConvergence({ minTimeRatio: 0.2, baseThreshold: 0.001, multiplier: 5 });
  const lockStrategy  = new LockStrategy({ maxCostPerPair: 0.99, minProfit: 0.01, onlyInChop: true });

  const binanceStream = startBinanceTradeStream({
    symbol: SYMBOL,
    onUpdate: (trade) => cvdAnalyzer.processTrade(trade)
  });
  const PAPER_MODE_BOOT = (process.env.PAPER_TRADING ?? "true").toLowerCase() === "true";
  if (PAPER_MODE_BOOT) {
    const lock = acquirePaperLock();
    if (!lock.acquired) throw new Error(lock.reason);
    process.once("exit", releasePaperLock);
  }

  let priceToBeatState = { ticker: null, value: null };
  const validationHeader = [
    "timestamp",
    "market_slug",
    "window_minutes",
    "time_left_min",
    "regime",
    "action",
    "side",
    "reason",
    "score_up",
    "score_down",
    "entry_price_up",
    "entry_price_down",
    "up_best_bid",
    "up_best_ask",
    "down_best_bid",
    "down_best_ask",
    "spread",
    "edge_up",
    "edge_down",
    "price_to_beat",
    "current_price",
    "oracle_source"
  ];

  console.log(`\n[kalshi] Iniciando paper trading — série: ${SERIES} (${SYMBOL})\n`);

  // 1H kline cache — refresh every 5 minutes
  let klines1hCache = { data: null, fetchedAtMs: 0 };
  const KLINES1H_TTL_MS = 5 * 60 * 1000;

  async function getKlines1h() {
    const now = Date.now();
    if (klines1hCache.data && now - klines1hCache.fetchedAtMs < KLINES1H_TTL_MS) {
      return klines1hCache.data;
    }
    try {
      const data = await fetchKlines({ symbol: SYMBOL, interval: "1h", limit: 60 });
      klines1hCache = { data, fetchedAtMs: now };
      return data;
    } catch {
      return klines1hCache.data ?? [];
    }
  }

  while (true) {
    try {
      const wsTick   = binanceStream.getLast();
      const spotPrice = wsTick?.price ?? null;

      const [klines1m, lastPrice, snap, klines1h] = await Promise.all([
        fetchKlines({ symbol: SYMBOL, interval: "1m", limit: 240 }),
        fetchLastPrice(SYMBOL),
        fetchKalshiSnapshot(SERIES),
        getKlines1h()
      ]);

      const macroInfo = computeMacroTrend(klines1h);

      if (!snap.ok) {
        renderScreen(`[kalshi] Aguardando mercado ativo... (${snap.reason})\n`);
        await sleep(POLL_MS);
        continue;
      }

      // ── timing ──────────────────────────────────────────────────────────────
      const nowMs        = Date.now();
      const timeLeftMin  = snap.endTime ? (snap.endTime - nowMs) / 60_000 : WINDOW_MIN;
      const timeLeftMin0 = Math.max(0, timeLeftMin);

      // Kalshi fornece o floor_strike = preço de referência oficial CF Benchmarks
      // Mais confiável que latchear o spot da Binance
      const priceToBeat = snap.floorStrike ?? (priceToBeatState.ticker === snap.ticker ? priceToBeatState.value : null);
      if (snap.ticker !== priceToBeatState.ticker) {
        priceToBeatState = { ticker: snap.ticker, value: spotPrice ?? lastPrice };
      }

      // ── indicadores ─────────────────────────────────────────────────────────
      const closes    = klines1m.map(c => c.close);
      const vwapSeries = computeVwapSeries(klines1m);
      const vwapNow   = vwapSeries[vwapSeries.length - 1];
      const vwapSlope = vwapSeries.length >= 5 ? (vwapNow - vwapSeries[vwapSeries.length - 5]) / 5 : null;
      const vwapDist  = vwapNow ? (lastPrice - vwapNow) / vwapNow : null;

      const rsiNow    = computeRsi(closes, 14);
      const rsiSeries = computeRsiSeries(closes, 14, 19);
      const rsiSlope  = slopeLast(rsiSeries, 3);

      const macd = computeMacd(closes, 12, 26, 9);
      const ha   = computeHeikenAshi(klines1m);
      const consec = countConsecutive(ha);

      const vwapCrossCount = (() => {
        let crosses = 0;
        for (let i = closes.length - 19; i < closes.length; i++) {
          const prev = closes[i - 1] - vwapSeries[i - 1];
          const cur  = closes[i]     - vwapSeries[i];
          if (prev !== 0 && ((prev > 0 && cur < 0) || (prev < 0 && cur > 0))) crosses++;
        }
        return crosses;
      })();
      const volumeRecent = klines1m.slice(-20).reduce((a, c) => a + c.volume, 0);
      const volumeAvg    = klines1m.slice(-120).reduce((a, c) => a + c.volume, 0) / 6;
      const failedVwapReclaim = vwapNow !== null && vwapSeries.length >= 3
        ? closes[closes.length - 1] < vwapNow && closes[closes.length - 2] > vwapSeries[vwapSeries.length - 2]
        : false;

      const chop      = computeChop(klines1m, 60);
      const bbWidthPct = computeBBWidth(closes, 20, 2);

      const regimeInfo = detectRegime({ price: lastPrice, vwap: vwapNow, vwapSlope, vwapCrossCount, volumeRecent, volumeAvg });

      // ── mercado Kalshi ───────────────────────────────────────────────────────
      const marketYes = snap.prices.yes;
      const marketNo  = snap.prices.no;
      const spreadYes = snap.prices.yes !== null && snap.prices.yesBid !== null ? snap.prices.yes - snap.prices.yesBid : null;
      const spreadNo = snap.prices.no !== null && snap.prices.noBid !== null ? snap.prices.no - snap.prices.noBid : null;
      const spread = spreadYes !== null && spreadNo !== null ? Math.max(spreadYes, spreadNo) : (spreadYes ?? spreadNo);

      // ── sinais avançados ─────────────────────────────────────────────────────
      const cvdState      = cvdAnalyzer.getCurrentState();
      const cvdDivergence = cvdAnalyzer.detectDivergence();
      const cvdAbsorption = cvdAnalyzer.detectAbsorption();
      const tpField       = timePriceConv.evaluate(spotPrice ?? lastPrice, priceToBeat, timeLeftMin0, WINDOW_MIN);
      const lockOp        = lockStrategy.evaluate(marketYes, marketNo, regimeInfo.regime);

      // ── scoring: calibrated historical base rates (replaces lagging TA signals) ──
      const utcHour = new Date().getUTCHours();
      const priceVsVwap = (lastPrice !== null && vwapNow !== null)
        ? (lastPrice >= vwapNow ? "ABOVE" : "BELOW")
        : null;
      const rsiZone = rsiNow === null ? null
        : rsiNow > 60 ? "OVERBOUGHT"
        : rsiNow < 40 ? "OVERSOLD"
        : "NEUTRAL";

      const calibrated = (priceVsVwap !== null && rsiZone !== null && macroInfo.trend !== "NEUTRAL")
        ? lookupRate({ hour: utcHour, macro: macroInfo.trend, priceVsVwap, rsiZone })
        : { upRate: 0.5, downRate: 0.5, edge: 0, hasEdge: false, found: false, n: 0 };

      const timeAware = applyTimeAwareness(calibrated.upRate, timeLeftMin0, WINDOW_MIN);
      const edge = computeEdge({
        modelUp: timeAware.adjustedUp, modelDown: timeAware.adjustedDown,
        marketYes, marketNo
      });

      // Kalshi: YES = preço sobe, NO = preço desce (mesma lógica que UP/DOWN)
      const rec = decide({
        remainingMinutes: timeLeftMin0,
        edgeUp: edge.edgeUp, edgeDown: edge.edgeDown,
        modelUp: timeAware.adjustedUp, modelDown: timeAware.adjustedDown,
        regime: regimeInfo.regime,
        macroTrend: macroInfo.trend,
        chop,
        bbWidthPct,
        spreadUp: spreadYes,
        spreadDown: spreadNo
      });

      // Adaptar rec para paper trading (UP/DOWN → YES/NO)
      const recAdapted = {
        ...rec,
        side: rec.side === "UP" ? "UP" : rec.side === "DOWN" ? "DOWN" : rec.side,
        edge: Math.max(edge.edgeUp ?? 0, edge.edgeDown ?? 0)
      };

      // Adaptar snap para paper trading (yes → up, no → down)
      const polyCompat = {
        ok: snap.ok,
        market: { slug: snap.ticker, endDate: snap.endTime ? new Date(snap.endTime).toISOString() : null },
        tokens: { upTokenId: "yes", downTokenId: "no" },
        prices: { up: marketYes, down: marketNo },
        orderbook: {
          up: { bestBid: snap.prices.yesBid, bestAsk: marketYes, spread: spreadYes },
          down: { bestBid: snap.prices.noBid, bestAsk: marketNo, spread: spreadNo }
        }
      };

      // ── paper trading ────────────────────────────────────────────────────────
      const PAPER_MODE = (process.env.PAPER_TRADING ?? "true").toLowerCase() === "true";
      const paperResult = PAPER_MODE
        ? onPaperTick({
          rec: recAdapted,
          poly: polyCompat,
          spotPrice: spotPrice ?? lastPrice,
          referencePrice: priceToBeat,
          settlementPrice: spotPrice ?? lastPrice,
          oracleSource: "kalshi_cf_benchmarks",
          timeLeftMin: timeLeftMin0
        })
        : null;

      const paperStats = PAPER_MODE ? getPaperStats() : null;
      const paperPos   = PAPER_MODE ? getPaperPosition() : null;

      // ── display ──────────────────────────────────────────────────────────────
      const timeColor  = timeLeftMin0 > 10 ? ANSI.green : timeLeftMin0 > 5 ? ANSI.yellow : ANSI.red;
      const cvdColor   = cvdState.trend === "BUYING" ? ANSI.green : cvdState.trend === "SELLING" ? ANSI.red : ANSI.gray;
      const macroColor  = macroInfo.trend === "UP" ? ANSI.green : macroInfo.trend === "DOWN" ? ANSI.red : ANSI.gray;
      const macroEmaStr = macroInfo.ema50 !== null ? ` | EMA50=$${macroInfo.ema50.toFixed(0)}` : "";
      const chopColor   = chop === null ? ANSI.gray : chop > 61.8 ? ANSI.red : chop > 50 ? ANSI.yellow : ANSI.green;
      const bbColor     = bbWidthPct === null ? ANSI.gray : bbWidthPct < 1.0 ? ANSI.red : bbWidthPct < 2.0 ? ANSI.yellow : ANSI.green;
      const recColor  = rec.action === "ENTER" ? (rec.side === "UP" ? ANSI.green : ANSI.red) : ANSI.gray;
      const pnlColor  = (paperStats?.totalPnl ?? 0) >= 0 ? ANSI.green : ANSI.red;

      const posLine = (() => {
        if (!paperPos?.open) return `${ANSI.gray}Sem posição${ANSI.reset}`;
        const side = paperPos.side === "UP" ? `${ANSI.green}YES${ANSI.reset}` : `${ANSI.red}NO${ANSI.reset}`;
        return `${side} $${paperPos.usdcAmount} @ ${paperPos.entryPrice?.toFixed(2)}`;
      })();

      const lines = [
        `${ANSI.white}KALSHI PAPER TRADING — ${SERIES} (${SYMBOL})${ANSI.reset}`,
        kv("Market:", snap.ticker ?? "-"),
        kv("Time left:", `${timeColor}${fmtTimeLeft(timeLeftMin0)}${ANSI.reset}`),
        "",
        sep(),
        "",
        kv("BTC Spot:", `${ANSI.white}$${formatNumber(spotPrice ?? lastPrice, 0)}${ANSI.reset}`),
        kv("Mkt YES:", `${ANSI.green}${marketYes?.toFixed(3) ?? "-"}${ANSI.reset}`),
        kv("Mkt NO:", `${ANSI.red}${marketNo?.toFixed(3) ?? "-"}${ANSI.reset}`),
        kv("Regime:", regimeInfo.regime),
        kv("Macro 1H:", `${macroColor}${macroInfo.trend}${ANSI.reset}${macroEmaStr}`),
        kv("Range:", `CHOP ${chopColor}${chop !== null ? chop.toFixed(1) : "-"}${ANSI.reset} | BB ${bbColor}${bbWidthPct !== null ? bbWidthPct.toFixed(2) : "-"}%${ANSI.reset}`),
        kv("CVD:", `${cvdColor}${cvdState.trend}${ANSI.reset}${cvdDivergence ? ` | ${cvdDivergence.type === "BULLISH" ? ANSI.green + "div↑" : ANSI.red + "div↓"}${ANSI.reset}` : ""}`),
        tpField.inField ? kv("TPC:", `${tpField.direction === "UP" ? ANSI.green : ANSI.red}${tpField.direction} ${(tpField.probability * 100).toFixed(0)}% [${tpField.urgency}]${ANSI.reset}`) : null,
        lockOp.actionable ? kv("LOCK:", `${ANSI.yellow}BOTH | +${(lockOp.profit * 100).toFixed(1)}% garantido${ANSI.reset}`) : null,
        "",
        sep(),
        "",
        kv("Sinal:", `${recColor}${rec.action === "ENTER" ? `${rec.side} (${rec.phase})` : `NO TRADE (${rec.reason ?? rec.phase})`}${ANSI.reset}`),
        kv("Edge:", `${ANSI.white}↑${colorPct(edge.edgeUp)} ↓${colorPct(edge.edgeDown)}${ANSI.reset}`),
        kv("Score:", `${ANSI.green}YES ${(timeAware.adjustedUp * 100).toFixed(0)}%${ANSI.reset} / ${ANSI.red}NO ${(timeAware.adjustedDown * 100).toFixed(0)}%${ANSI.reset}`),
        "",
        sep(),
        "",
        kv("Posição:", posLine),
        paperStats ? kv("Trades:", paperStats.totalTrades === 0
          ? `${ANSI.gray}Nenhum ainda${ANSI.reset}`
          : `${paperStats.totalTrades} | ${ANSI.green}${paperStats.wins}W${ANSI.reset} / ${ANSI.red}${paperStats.losses}L${ANSI.reset} | WR ${(paperStats.winRate ?? 0).toFixed(1)}%`) : null,
        paperStats?.totalTrades > 0 ? kv("P&L:", `${pnlColor}${paperStats.totalPnl >= 0 ? "+" : ""}$${paperStats.totalPnl.toFixed(2)} (ROI ${paperStats.roi >= 0 ? "+" : ""}${paperStats.roi}%)${ANSI.reset}`) : null,
        "",
        sep(),
        `${ANSI.dim}${ANSI.gray}kalshi paper trading — série ${SERIES}${ANSI.reset}`
      ].filter(x => x !== null);

      renderScreen(lines.join("\n") + "\n");

      if ((process.env.SIGNAL_LOG ?? "false").toLowerCase() === "true") {
        appendCsvRow(`./logs/${LOG_PREFIX}validation_signals.csv`, validationHeader, [
          new Date().toISOString(),
          snap.ticker ?? "",
          WINDOW_MIN,
          timeLeftMin0.toFixed(3),
          regimeInfo.regime,
          rec.action,
          rec.side,
          rec.reason ?? rec.phase,
          timeAware.adjustedUp,
          timeAware.adjustedDown,
          marketYes,
          marketNo,
          snap.prices.yesBid,
          marketYes,
          snap.prices.noBid,
          marketNo,
          spread,
          edge.edgeUp,
          edge.edgeDown,
          priceToBeat,
          spotPrice ?? lastPrice,
          "kalshi_cf_benchmarks"
        ]);
      }

    } catch (err) {
      process.stdout.write(`[kalshi] Erro: ${err.message}\n`);
    }

    await sleep(POLL_MS);
  }
}

process.on("SIGINT",  () => { console.log("\n[kalshi] Encerrando..."); process.exit(0); });
process.on("SIGTERM", () => process.exit(0));

main();
