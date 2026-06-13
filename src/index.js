import { CONFIG } from "./config.js";
import { fetchKlines, fetchLastPrice } from "./data/binance.js";
import { fetchChainlinkBtcUsd } from "./data/chainlink.js";
import { startChainlinkPriceStream } from "./data/chainlinkWs.js";
import { startPolymarketChainlinkPriceStream } from "./data/polymarketLiveWs.js";
import {
  fetchMarketBySlug,
  fetchLiveEventsBySeriesId,
  flattenEventMarkets,
  pickLatestLiveMarket,
  isMarketLive,
  fetchClobPrice,
  fetchOrderBook,
  summarizeOrderBook
} from "./data/polymarket.js";
import { computeMacroTrend } from "./engines/macroTrend.js";
import { computeChop, computeBBWidth } from "./indicators/chop.js";
import { computeVwapSeries } from "./indicators/vwap.js";
import { computeRsi, computeRsiSeries, sma, slopeLast } from "./indicators/rsi.js";
import { computeMacd } from "./indicators/macd.js";
import { computeHeikenAshi, countConsecutive } from "./indicators/heikenAshi.js";
import { detectRegime } from "./engines/regime.js";
import { settlementProbability, estimateSigmaPerSqrtMin } from "./engines/settlementProb.js";
import { lookupRate, isCalibrationLoaded } from "./engines/calibratedRate.js";
import { computeEdge, decide } from "./engines/edge.js";
import { appendCsvRow, formatNumber, formatPct, getCandleWindowTiming, sleep } from "./utils.js";
import { startBinanceTradeStream } from "./data/binanceWs.js";
import { onSignal, emergencyShutdown, getBotStatus } from "./execution/bot.js";
import { acquirePaperLock, releasePaperLock, onPaperTick, getPaperStats, getPaperPosition, hasPaperPosition } from "./execution/paperTrading.js";
import { CVDAnalyzer } from "./indicators/cvd.js";
import { TimePriceConvergence } from "./engines/timePriceField.js";
import { LockStrategy } from "./engines/lockStrategy.js";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { applyGlobalProxyFromEnv } from "./net/proxy.js";

function countVwapCrosses(closes, vwapSeries, lookback) {
  if (closes.length < lookback || vwapSeries.length < lookback) return null;
  let crosses = 0;
  for (let i = closes.length - lookback + 1; i < closes.length; i += 1) {
    const prev = closes[i - 1] - vwapSeries[i - 1];
    const cur = closes[i] - vwapSeries[i];
    if (prev === 0) continue;
    if ((prev > 0 && cur < 0) || (prev < 0 && cur > 0)) crosses += 1;
  }
  return crosses;
}

applyGlobalProxyFromEnv();

function fmtTimeLeft(mins) {
  const totalSeconds = Math.max(0, Math.floor(mins * 60));
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const ANSI = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  lightRed: "\x1b[91m",
  gray: "\x1b[90m",
  white: "\x1b[97m",
  dim: "\x1b[2m"
};

function screenWidth() {
  const w = Number(process.stdout?.columns);
  return Number.isFinite(w) && w >= 40 ? w : 80;
}

function sepLine(ch = "─") {
  const w = screenWidth();
  return `${ANSI.white}${ch.repeat(w)}${ANSI.reset}`;
}

function renderScreen(text) {
  try {
    readline.cursorTo(process.stdout, 0, 0);
    readline.clearScreenDown(process.stdout);
  } catch {
    // ignore
  }
  process.stdout.write(text);
}

function stripAnsi(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, "");
}

function padLabel(label, width) {
  const visible = stripAnsi(label).length;
  if (visible >= width) return label;
  return label + " ".repeat(width - visible);
}

function centerText(text, width) {
  const visible = stripAnsi(text).length;
  if (visible >= width) return text;
  const left = Math.floor((width - visible) / 2);
  const right = width - visible - left;
  return " ".repeat(left) + text + " ".repeat(right);
}

const LABEL_W = 16;
function kv(label, value) {
  const l = padLabel(String(label), LABEL_W);
  return `${l}${value}`;
}

function section(title) {
  return `${ANSI.white}${title}${ANSI.reset}`;
}

function colorPriceLine({ label, price, prevPrice, decimals = 0, prefix = "" }) {
  if (price === null || price === undefined) {
    return `${label}: ${ANSI.gray}-${ANSI.reset}`;
  }

  const p = Number(price);
  const prev = prevPrice === null || prevPrice === undefined ? null : Number(prevPrice);

  let color = ANSI.reset;
  let arrow = "";
  if (prev !== null && Number.isFinite(prev) && Number.isFinite(p) && p !== prev) {
    if (p > prev) {
      color = ANSI.green;
      arrow = " ↑";
    } else {
      color = ANSI.red;
      arrow = " ↓";
    }
  }

  const formatted = `${prefix}${formatNumber(p, decimals)}`;
  return `${label}: ${color}${formatted}${arrow}${ANSI.reset}`;
}

function formatSignedDelta(delta, base) {
  if (delta === null || base === null || base === 0) return `${ANSI.gray}-${ANSI.reset}`;
  const sign = delta > 0 ? "+" : delta < 0 ? "-" : "";
  const pct = (Math.abs(delta) / Math.abs(base)) * 100;
  return `${sign}$${Math.abs(delta).toFixed(2)}, ${sign}${pct.toFixed(2)}%`;
}

function colorByNarrative(text, narrative) {
  if (narrative === "LONG") return `${ANSI.green}${text}${ANSI.reset}`;
  if (narrative === "SHORT") return `${ANSI.red}${text}${ANSI.reset}`;
  return `${ANSI.gray}${text}${ANSI.reset}`;
}

function formatNarrativeValue(label, value, narrative) {
  return `${label}: ${colorByNarrative(value, narrative)}`;
}

function narrativeFromSign(x) {
  if (x === null || x === undefined || !Number.isFinite(Number(x)) || Number(x) === 0) return "NEUTRAL";
  return Number(x) > 0 ? "LONG" : "SHORT";
}

function narrativeFromRsi(rsi) {
  if (rsi === null || rsi === undefined || !Number.isFinite(Number(rsi))) return "NEUTRAL";
  const v = Number(rsi);
  if (v >= 55) return "LONG";
  if (v <= 45) return "SHORT";
  return "NEUTRAL";
}

function narrativeFromSlope(slope) {
  if (slope === null || slope === undefined || !Number.isFinite(Number(slope)) || Number(slope) === 0) return "NEUTRAL";
  return Number(slope) > 0 ? "LONG" : "SHORT";
}

function formatProbPct(p, digits = 0) {
  if (p === null || p === undefined || !Number.isFinite(Number(p))) return "-";
  return `${(Number(p) * 100).toFixed(digits)}%`;
}

function fmtEtTime(now = new Date()) {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    }).format(now);
  } catch {
    return "-";
  }
}

function getBtcSession(now = new Date()) {
  const h = now.getUTCHours();
  const inAsia = h >= 0 && h < 8;
  const inEurope = h >= 7 && h < 16;
  const inUs = h >= 13 && h < 22;

  if (inEurope && inUs) return "Europe/US overlap";
  if (inAsia && inEurope) return "Asia/Europe overlap";
  if (inAsia) return "Asia";
  if (inEurope) return "Europe";
  if (inUs) return "US";
  return "Off-hours";
}

const dumpedMarkets = new Set();

function safeFileSlug(x) {
  return String(x ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 120);
}

const marketCache = {
  market: null,
  fetchedAtMs: 0
};

async function resolveCurrentBtc15mMarket() {
  if (CONFIG.polymarket.marketSlug) {
    return await fetchMarketBySlug(CONFIG.polymarket.marketSlug);
  }

  if (!CONFIG.polymarket.autoSelectLatest) return null;

  const now = Date.now();
  if (marketCache.market && isMarketLive(marketCache.market, now) && now - marketCache.fetchedAtMs < CONFIG.marketCacheMs) {
    return marketCache.market;
  }

  const events = await fetchLiveEventsBySeriesId({ seriesId: CONFIG.polymarket.seriesId, limit: 25 });
  const markets = flattenEventMarkets(events);
  const picked = pickLatestLiveMarket(markets);

  marketCache.market = picked;
  marketCache.fetchedAtMs = now;
  return picked;
}

async function fetchPolymarketSnapshot() {
  const market = await resolveCurrentBtc15mMarket();

  if (!market) return { ok: false, reason: "market_not_found" };

  const outcomes = Array.isArray(market.outcomes) ? market.outcomes : (typeof market.outcomes === "string" ? JSON.parse(market.outcomes) : []);
  const outcomePrices = Array.isArray(market.outcomePrices)
    ? market.outcomePrices
    : (typeof market.outcomePrices === "string" ? JSON.parse(market.outcomePrices) : []);

  const clobTokenIds = Array.isArray(market.clobTokenIds)
    ? market.clobTokenIds
    : (typeof market.clobTokenIds === "string" ? JSON.parse(market.clobTokenIds) : []);

  let upTokenId = null;
  let downTokenId = null;
  for (let i = 0; i < outcomes.length; i += 1) {
    const label = String(outcomes[i]);
    const tokenId = clobTokenIds[i] ? String(clobTokenIds[i]) : null;
    if (!tokenId) continue;

    if (label.toLowerCase() === CONFIG.polymarket.upOutcomeLabel.toLowerCase()) upTokenId = tokenId;
    if (label.toLowerCase() === CONFIG.polymarket.downOutcomeLabel.toLowerCase()) downTokenId = tokenId;
  }

  const upIndex = outcomes.findIndex((x) => String(x).toLowerCase() === CONFIG.polymarket.upOutcomeLabel.toLowerCase());
  const downIndex = outcomes.findIndex((x) => String(x).toLowerCase() === CONFIG.polymarket.downOutcomeLabel.toLowerCase());

  const gammaYes = upIndex >= 0 ? Number(outcomePrices[upIndex]) : null;
  const gammaNo = downIndex >= 0 ? Number(outcomePrices[downIndex]) : null;

  if (!upTokenId || !downTokenId) {
    return {
      ok: false,
      reason: "missing_token_ids",
      market,
      outcomes,
      clobTokenIds,
      outcomePrices
    };
  }

  let upBuy = null;
  let downBuy = null;
  let upBookSummary = { bestBid: null, bestAsk: null, spread: null, bidLiquidity: null, askLiquidity: null };
  let downBookSummary = { bestBid: null, bestAsk: null, spread: null, bidLiquidity: null, askLiquidity: null };

  try {
    const [upAsk, downAsk, upBook, downBook] = await Promise.all([
      fetchClobPrice({ tokenId: upTokenId, side: "SELL" }),
      fetchClobPrice({ tokenId: downTokenId, side: "SELL" }),
      fetchOrderBook({ tokenId: upTokenId }),
      fetchOrderBook({ tokenId: downTokenId })
    ]);

    upBookSummary = summarizeOrderBook(upBook);
    downBookSummary = summarizeOrderBook(downBook);
    upBuy = upBookSummary.bestAsk ?? upAsk;
    downBuy = downBookSummary.bestAsk ?? downAsk;
  } catch {
    upBuy = null;
    downBuy = null;
    upBookSummary = {
      bestBid: Number(market.bestBid) || null,
      bestAsk: Number(market.bestAsk) || null,
      spread: Number(market.spread) || null,
      bidLiquidity: null,
      askLiquidity: null
    };
    downBookSummary = {
      bestBid: null,
      bestAsk: null,
      spread: Number(market.spread) || null,
      bidLiquidity: null,
      askLiquidity: null
    };
  }

  return {
    ok: true,
    market,
    tokens: { upTokenId, downTokenId },
    prices: {
      up: upBuy ?? gammaYes,
      down: downBuy ?? gammaNo
    },
    orderbook: {
      up: upBookSummary,
      down: downBookSummary
    }
  };
}

async function main() {
  const cvdAnalyzer = new CVDAnalyzer({ resetInterval: "1h" });
  const timePriceConv = new TimePriceConvergence({ minTimeRatio: 0.2, baseThreshold: 0.001, multiplier: 5 });
  const lockStrategy = new LockStrategy({ maxCostPerPair: 0.99, minProfit: 0.01, onlyInChop: true });

  const binanceStream = startBinanceTradeStream({
    symbol: CONFIG.symbol,
    onUpdate: (trade) => cvdAnalyzer.processTrade(trade)
  });
  const polymarketLiveStream = startPolymarketChainlinkPriceStream({});
  const chainlinkStream = startChainlinkPriceStream({});
  const PAPER_MODE_BOOT = (process.env.PAPER_TRADING ?? "false").toLowerCase() === "true";
  const EXECUTE_MODE_BOOT = (process.env.EXECUTE_ORDERS ?? "false").toLowerCase() === "true";
  if (PAPER_MODE_BOOT && !EXECUTE_MODE_BOOT) {
    const lock = acquirePaperLock();
    if (!lock.acquired) throw new Error(lock.reason);
    process.once("exit", releasePaperLock);
  }

  // Memory safety net: if RSS ever climbs past the soft cap, exit cleanly with a
  // non-zero code BEFORE V8 hits its hard limit and aborts. Under a restart loop
  // (see README) this recovers gracefully; standalone it at least logs the cause
  // instead of a cryptic mark-compact crash. The perMessageDeflate fix should keep
  // this from ever firing — it's diagnostics + defense in depth.
  const MEM_SOFT_CAP_MB = Number(process.env.MEM_SOFT_CAP_MB ?? 1200);
  const memMonitor = setInterval(() => {
    const rssMb = process.memoryUsage().rss / 1048576;
    if (rssMb > MEM_SOFT_CAP_MB) {
      console.error(`[mem] RSS ${rssMb.toFixed(0)}MB > soft cap ${MEM_SOFT_CAP_MB}MB — saindo para restart limpo`);
      try { releasePaperLock(); } catch { /* ignore */ }
      process.exit(17);
    }
  }, 60_000);
  memMonitor.unref?.();

  let prevSpotPrice = null;
  let prevCurrentPrice = null;
  let priceToBeatState = { slug: null, value: null, setAtMs: null };

  // 1H kline cache — refresh every 5 minutes to avoid API spam
  let klines1hCache = { data: null, fetchedAtMs: 0 };
  const KLINES1H_TTL_MS = 5 * 60 * 1000;

  async function getKlines1h() {
    const now = Date.now();
    if (klines1hCache.data && now - klines1hCache.fetchedAtMs < KLINES1H_TTL_MS) {
      return klines1hCache.data;
    }
    try {
      const data = await fetchKlines({ interval: "1h", limit: 60 });
      klines1hCache = { data, fetchedAtMs: now };
      return data;
    } catch {
      return klines1hCache.data ?? [];
    }
  }

  const header = [
    "timestamp",
    "entry_minute",
    "time_left_min",
    "regime",
    "signal",
    "model_up",
    "model_down",
    "mkt_up",
    "mkt_down",
    "edge_up",
    "edge_down",
    "recommendation"
  ];

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

  while (true) {
    const timing = getCandleWindowTiming(CONFIG.candleWindowMinutes);

    const wsTick = binanceStream.getLast();
    const wsPrice = wsTick?.price ?? null;

    const polymarketWsTick = polymarketLiveStream.getLast();
    const polymarketWsPrice = polymarketWsTick?.price ?? null;

    const chainlinkWsTick = chainlinkStream.getLast();
    const chainlinkWsPrice = chainlinkWsTick?.price ?? null;

    try {
      const chainlinkPromise = polymarketWsPrice !== null
        ? Promise.resolve({ price: polymarketWsPrice, updatedAt: polymarketWsTick?.updatedAt ?? null, source: "polymarket_ws" })
        : chainlinkWsPrice !== null
          ? Promise.resolve({ price: chainlinkWsPrice, updatedAt: chainlinkWsTick?.updatedAt ?? null, source: "chainlink_ws" })
          : fetchChainlinkBtcUsd();

      const [klines1m, lastPrice, chainlink, poly, klines1h] = await Promise.all([
        fetchKlines({ interval: "1m", limit: 240 }),
        fetchLastPrice(),
        chainlinkPromise,
        fetchPolymarketSnapshot(),
        getKlines1h()
      ]);

      const macroInfo = computeMacroTrend(klines1h);

      const settlementMs = poly.ok && poly.market?.endDate ? new Date(poly.market.endDate).getTime() : null;
      const settlementLeftMin = settlementMs ? (settlementMs - Date.now()) / 60_000 : null;

      const timeLeftMin = settlementLeftMin ?? timing.remainingMinutes;

      const candles = klines1m;
      const closes = candles.map((c) => c.close);

      const vwapSeries = computeVwapSeries(candles);
      const vwapNow = vwapSeries[vwapSeries.length - 1];

      const lookback = CONFIG.vwapSlopeLookbackMinutes;
      const vwapSlope = vwapSeries.length >= lookback ? (vwapNow - vwapSeries[vwapSeries.length - lookback]) / lookback : null;
      const vwapDist = vwapNow ? (lastPrice - vwapNow) / vwapNow : null;

      const rsiNow = computeRsi(closes, CONFIG.rsiPeriod);
      const rsiSeries = computeRsiSeries(closes, CONFIG.rsiPeriod, CONFIG.rsiMaPeriod + 5);
      const rsiMa = sma(rsiSeries, CONFIG.rsiMaPeriod);
      const rsiSlope = slopeLast(rsiSeries, 3);

      const macd = computeMacd(closes, CONFIG.macdFast, CONFIG.macdSlow, CONFIG.macdSignal);

      const ha = computeHeikenAshi(candles);
      const consec = countConsecutive(ha);

      const vwapCrossCount = countVwapCrosses(closes, vwapSeries, 20);
      const volumeRecent = candles.slice(-20).reduce((a, c) => a + c.volume, 0);
      const volumeAvg = candles.slice(-120).reduce((a, c) => a + c.volume, 0) / 6;

      const failedVwapReclaim = vwapNow !== null && vwapSeries.length >= 3
        ? closes[closes.length - 1] < vwapNow && closes[closes.length - 2] > vwapSeries[vwapSeries.length - 2]
        : false;

      // Choppiness Index and BB Width on 1m candles (60-bar = 1h lookback)
      const chop = computeChop(candles, 60);
      const bbWidthPct = computeBBWidth(closes, 20, 2);

      const regimeInfo = detectRegime({
        price: lastPrice,
        vwap: vwapNow,
        vwapSlope,
        vwapCrossCount,
        volumeRecent,
        volumeAvg
      });

      const marketUp = poly.ok ? poly.prices.up : null;
      const marketDown = poly.ok ? poly.prices.down : null;
      const spreadUp = poly.ok ? poly.orderbook.up.spread : null;
      const spreadDown = poly.ok ? poly.orderbook.down.spread : null;
      const spread = spreadUp !== null && spreadDown !== null ? Math.max(spreadUp, spreadDown) : (spreadUp ?? spreadDown);

      // Spot price and priceToBeat — needed by TPC and Lock before scoring
      const spotPrice = wsPrice ?? lastPrice;
      const currentPrice = chainlink?.price ?? null;
      const marketSlug = poly.ok ? String(poly.market?.slug ?? "") : "";
      const marketStartMs = poly.ok && poly.market?.eventStartTime ? new Date(poly.market.eventStartTime).getTime() : null;

      if (marketSlug && priceToBeatState.slug !== marketSlug) {
        priceToBeatState = { slug: marketSlug, value: null, setAtMs: null };
      }
      if (priceToBeatState.slug && priceToBeatState.value === null && currentPrice !== null) {
        const nowMs = Date.now();
        if (marketStartMs === null || nowMs >= marketStartMs) {
          priceToBeatState = { slug: priceToBeatState.slug, value: Number(currentPrice), setAtMs: nowMs };
        }
      }
      const priceToBeat = priceToBeatState.slug === marketSlug ? priceToBeatState.value : null;

      // Advanced signals (needs marketUp/Down and spotPrice/priceToBeat)
      const cvdState = cvdAnalyzer.getCurrentState();
      const cvdDivergence = cvdAnalyzer.detectDivergence();
      const cvdAbsorption = cvdAnalyzer.detectAbsorption();
      const tpField = timePriceConv.evaluate(spotPrice, priceToBeat, timeLeftMin, CONFIG.candleWindowMinutes);
      const lockOp = lockStrategy.evaluate(marketUp, marketDown, regimeInfo.regime);

      // Calibrated base-rate model: replaces lagging TA score with historically-calibrated
      // UP probability for the current market conditions (hour × macro × VWAP × RSI zone)
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

      // Settlement probability: drifted-diffusion model that combines the calibrated
      // base rate (drift) with displacement vs priceToBeat and realized vol. Converges
      // to 0/1 as time runs out — same as the market — instead of shrinking to 0.5.
      const sigmaPerSqrtMin = estimateSigmaPerSqrtMin(klines1m);
      const timeAware = settlementProbability({
        spot: currentPrice ?? spotPrice,
        strike: priceToBeat,
        remainingMinutes: timeLeftMin,
        windowMinutes: CONFIG.candleWindowMinutes,
        sigmaPerSqrtMin,
        baseUpRate: calibrated.upRate
      });

      const edge = computeEdge({ modelUp: timeAware.adjustedUp, modelDown: timeAware.adjustedDown, marketYes: marketUp, marketNo: marketDown });

      const rec = decide({
        remainingMinutes: timeLeftMin,
        edgeUp: edge.edgeUp,
        edgeDown: edge.edgeDown,
        modelUp: timeAware.adjustedUp,
        modelDown: timeAware.adjustedDown,
        regime: regimeInfo.regime,
        macroTrend: macroInfo.trend,
        chop,
        bbWidthPct,
        spreadUp,
        spreadDown
      });

      const vwapSlopeLabel = vwapSlope === null ? "-" : vwapSlope > 0 ? "UP" : vwapSlope < 0 ? "DOWN" : "FLAT";

      const macdLabel = macd === null
        ? "-"
        : macd.hist < 0
          ? (macd.histDelta !== null && macd.histDelta < 0 ? "bearish (expanding)" : "bearish")
          : (macd.histDelta !== null && macd.histDelta > 0 ? "bullish (expanding)" : "bullish");

      const lastCandle = klines1m.length ? klines1m[klines1m.length - 1] : null;
      const lastClose = lastCandle?.close ?? null;
      const close1mAgo = klines1m.length >= 2 ? klines1m[klines1m.length - 2]?.close ?? null : null;
      const close3mAgo = klines1m.length >= 4 ? klines1m[klines1m.length - 4]?.close ?? null : null;
      const delta1m = lastClose !== null && close1mAgo !== null ? lastClose - close1mAgo : null;
      const delta3m = lastClose !== null && close3mAgo !== null ? lastClose - close3mAgo : null;

      const haNarrative = (consec.color ?? "").toLowerCase() === "green" ? "LONG" : (consec.color ?? "").toLowerCase() === "red" ? "SHORT" : "NEUTRAL";
      const rsiNarrative = narrativeFromSlope(rsiSlope);
      const macdNarrative = narrativeFromSign(macd?.hist ?? null);
      const vwapNarrative = narrativeFromSign(vwapDist);

      const pLong = timeAware?.adjustedUp ?? null;
      const pShort = timeAware?.adjustedDown ?? null;
      const predictNarrative = (pLong !== null && pShort !== null && Number.isFinite(pLong) && Number.isFinite(pShort))
        ? (pLong > pShort ? "LONG" : pShort > pLong ? "SHORT" : "NEUTRAL")
        : "NEUTRAL";

      // Calibration display
      const calibEdgePct = calibrated.found ? ((calibrated.edge) * 100).toFixed(1) + "%" : "--";
      const calibDir = calibrated.found ? (calibrated.upRate > 0.5 ? "UP" : "DOWN") : "--";
      const calibStatus = calibrated.hasEdge
        ? `${ANSI.green}✓ edge ${calibEdgePct} → ${calibDir}${ANSI.reset} (n=${calibrated.n})`
        : calibrated.found
          ? `~ sem edge sig. (n=${calibrated.n})`
          : `${ANSI.red}sem dados${ANSI.reset}`;
      const predictValue = `${ANSI.green}LONG${ANSI.reset} ${ANSI.green}${formatProbPct(pLong, 0)}${ANSI.reset} / ${ANSI.red}SHORT${ANSI.reset} ${ANSI.red}${formatProbPct(pShort, 0)}${ANSI.reset}`;
      const predictLine = `Calib: ${calibStatus}`;

      const marketUpStr = `${marketUp ?? "-"}${marketUp === null || marketUp === undefined ? "" : "¢"}`;
      const marketDownStr = `${marketDown ?? "-"}${marketDown === null || marketDown === undefined ? "" : "¢"}`;
      const polyHeaderValue = `${ANSI.green}↑ UP${ANSI.reset} ${marketUpStr}  |  ${ANSI.red}↓ DOWN${ANSI.reset} ${marketDownStr}`;

      const heikenValue = `${consec.color ?? "-"} x${consec.count}`;
      const heikenLine = formatNarrativeValue("Heiken Ashi", heikenValue, haNarrative);

      const rsiArrow = rsiSlope !== null && rsiSlope < 0 ? "↓" : rsiSlope !== null && rsiSlope > 0 ? "↑" : "-";
      const rsiValue = `${formatNumber(rsiNow, 1)} ${rsiArrow}`;
      const rsiLine = formatNarrativeValue("RSI", rsiValue, rsiNarrative);

      const macdLine = formatNarrativeValue("MACD", macdLabel, macdNarrative);

      const delta1Narrative = narrativeFromSign(delta1m);
      const delta3Narrative = narrativeFromSign(delta3m);
      const deltaValue = `${colorByNarrative(formatSignedDelta(delta1m, lastClose), delta1Narrative)} | ${colorByNarrative(formatSignedDelta(delta3m, lastClose), delta3Narrative)}`;
      const deltaLine = `Delta 1/3Min: ${deltaValue}`;

      const vwapValue = `${formatNumber(vwapNow, 0)} (${formatPct(vwapDist, 2)}) | slope: ${vwapSlopeLabel}`;
      const vwapLine = formatNarrativeValue("VWAP", vwapValue, vwapNarrative);

      const signal = rec.action === "ENTER" ? (rec.side === "UP" ? "BUY UP" : "BUY DOWN") : "NO TRADE";

      const actionLine = rec.action === "ENTER"
        ? `${rec.action} NOW (${rec.phase} ENTRY)`
        : `NO TRADE (${rec.phase})`;

      const liquidity = poly.ok
        ? (Number(poly.market?.liquidityNum) || Number(poly.market?.liquidity) || null)
        : null;

      const currentPriceBaseLine = colorPriceLine({
        label: "CURRENT PRICE",
        price: currentPrice,
        prevPrice: prevCurrentPrice,
        decimals: 2,
        prefix: "$"
      });

      const ptbDelta = (currentPrice !== null && priceToBeat !== null && Number.isFinite(currentPrice) && Number.isFinite(priceToBeat))
        ? currentPrice - priceToBeat
        : null;
      const ptbDeltaColor = ptbDelta === null
        ? ANSI.gray
        : ptbDelta > 0
          ? ANSI.green
          : ptbDelta < 0
            ? ANSI.red
            : ANSI.gray;
      const ptbDeltaText = ptbDelta === null
        ? `${ANSI.gray}-${ANSI.reset}`
        : `${ptbDeltaColor}${ptbDelta > 0 ? "+" : ptbDelta < 0 ? "-" : ""}$${Math.abs(ptbDelta).toFixed(2)}${ANSI.reset}`;
      const currentPriceValue = currentPriceBaseLine.split(": ").slice(1).join(": ") || currentPriceBaseLine;
      const currentPriceLine = kv("CURRENT PRICE:", `${currentPriceValue} (${ptbDeltaText})`);

      if (poly.ok && poly.market && priceToBeatState.value === null) {
        const slug = safeFileSlug(poly.market.slug || poly.market.id || "market");
        if (slug && !dumpedMarkets.has(slug)) {
          dumpedMarkets.add(slug);
          try {
            fs.mkdirSync("./logs", { recursive: true });
            fs.writeFileSync(path.join("./logs", `polymarket_market_${slug}.json`), JSON.stringify(poly.market, null, 2), "utf8");
          } catch {
            // ignore
          }
        }
      }

      const binanceSpotBaseLine = colorPriceLine({ label: "BTC (Binance)", price: spotPrice, prevPrice: prevSpotPrice, decimals: 0, prefix: "$" });
      const diffLine = (spotPrice !== null && currentPrice !== null && Number.isFinite(spotPrice) && Number.isFinite(currentPrice) && currentPrice !== 0)
        ? (() => {
          const diffUsd = spotPrice - currentPrice;
          const diffPct = (diffUsd / currentPrice) * 100;
          const sign = diffUsd > 0 ? "+" : diffUsd < 0 ? "-" : "";
          return ` (${sign}$${Math.abs(diffUsd).toFixed(2)}, ${sign}${Math.abs(diffPct).toFixed(2)}%)`;
        })()
        : "";
      const binanceSpotLine = `${binanceSpotBaseLine}${diffLine}`;
      const binanceSpotValue = binanceSpotLine.split(": ").slice(1).join(": ") || binanceSpotLine;
      const binanceSpotKvLine = kv("BTC (Binance):", binanceSpotValue);

      const titleLine = poly.ok ? `${poly.market?.question ?? "-"}` : "-";
      const marketLine = kv("Market:", poly.ok ? (poly.market?.slug ?? "-") : "-");

      const timeColor = timeLeftMin >= 10 && timeLeftMin <= 15
        ? ANSI.green
        : timeLeftMin >= 5 && timeLeftMin < 10
          ? ANSI.yellow
          : timeLeftMin >= 0 && timeLeftMin < 5
            ? ANSI.red
            : ANSI.reset;
      const timeLeftLine = `⏱ Time left: ${timeColor}${fmtTimeLeft(timeLeftMin)}${ANSI.reset}`;

      const polyTimeLeftColor = settlementLeftMin !== null
        ? (settlementLeftMin >= 10 && settlementLeftMin <= 15
          ? ANSI.green
          : settlementLeftMin >= 5 && settlementLeftMin < 10
            ? ANSI.yellow
            : settlementLeftMin >= 0 && settlementLeftMin < 5
              ? ANSI.red
              : ANSI.reset)
        : ANSI.reset;

      // CVD display
      const cvdTrendColor = cvdState.trend === "BUYING" ? ANSI.green : cvdState.trend === "SELLING" ? ANSI.red : ANSI.gray;
      const cvdDivLine = cvdDivergence
        ? ` | ${cvdDivergence.type === "BULLISH" ? ANSI.green + "div↑" : ANSI.red + "div↓"}${ANSI.reset}`
        : "";
      const cvdAbsLine = cvdAbsorption
        ? ` | ${cvdAbsorption.type === "BULLISH_ABSORPTION" ? ANSI.green + "abs↑" : ANSI.red + "abs↓"}${ANSI.reset}`
        : "";
      const cvdDisplayLine = kv("CVD:", `${cvdTrendColor}${cvdState.trend}${ANSI.reset}${cvdDivLine}${cvdAbsLine}`);

      // Macro trend (1H EMA50)
      const macroColor = macroInfo.trend === "UP" ? ANSI.green : macroInfo.trend === "DOWN" ? ANSI.red : ANSI.gray;
      const macroEmaStr = macroInfo.ema50 !== null ? ` | EMA50=$${macroInfo.ema50.toFixed(0)}` : "";
      const macroDisplayLine = kv("Macro 1H:", `${macroColor}${macroInfo.trend}${ANSI.reset}${macroEmaStr}`);

      // Choppiness + BB Width
      const chopColor = chop === null ? ANSI.gray : chop > 61.8 ? ANSI.red : chop > 50 ? ANSI.yellow : ANSI.green;
      const bbColor   = bbWidthPct === null ? ANSI.gray : bbWidthPct < 1.0 ? ANSI.red : bbWidthPct < 2.0 ? ANSI.yellow : ANSI.green;
      const rangeDisplayLine = kv("Range filter:", `CHOP ${chopColor}${chop !== null ? chop.toFixed(1) : "-"}${ANSI.reset} | BB ${bbColor}${bbWidthPct !== null ? bbWidthPct.toFixed(2) : "-"}%${ANSI.reset}`);

      // TPC display
      const tpLine = tpField.inField
        ? kv("TPC:", `${tpField.direction === "UP" ? ANSI.green : ANSI.red}${tpField.direction} ${(tpField.probability * 100).toFixed(0)}% [${tpField.urgency}]${ANSI.reset}`)
        : null;

      // Lock display
      const lockLine = lockOp.actionable
        ? kv("LOCK:", `${ANSI.yellow}BOTH sides | cost ${lockOp.costPerPair?.toFixed(3)} | +${(lockOp.profit * 100).toFixed(1)}% guaranteed${ANSI.reset}`)
        : null;

      const lines = [
        titleLine,
        marketLine,
        kv("Time left:", `${timeColor}${fmtTimeLeft(timeLeftMin)}${ANSI.reset}`),
        "",
        sepLine(),
        "",
        kv("TA Score:", predictValue),
        kv("Heiken Ashi:", heikenLine.split(": ").slice(1).join(": ") || heikenLine),
        kv("RSI:", rsiLine.split(": ").slice(1).join(": ") || rsiLine),
        kv("MACD:", macdLine.split(": ").slice(1).join(": ") || macdLine),
        kv("Delta 1/3:", deltaLine.split(": ").slice(1).join(": ") || deltaLine),
        kv("VWAP:", vwapLine.split(": ").slice(1).join(": ") || vwapLine),
        cvdDisplayLine,
        macroDisplayLine,
        rangeDisplayLine,
        tpLine,
        lockLine,
        "",
        sepLine(),
        "",
        kv("POLYMARKET:", polyHeaderValue),
        liquidity !== null ? kv("Liquidity:", formatNumber(liquidity, 0)) : null,
        settlementLeftMin !== null ? kv("Time left:", `${polyTimeLeftColor}${fmtTimeLeft(settlementLeftMin)}${ANSI.reset}`) : null,
        priceToBeat !== null ? kv("PRICE TO BEAT: ", `$${formatNumber(priceToBeat, 0)}`) : kv("PRICE TO BEAT: ", `${ANSI.gray}-${ANSI.reset}`),
        currentPriceLine,
        "",
        sepLine(),
        "",
        binanceSpotKvLine,
        "",
        sepLine(),
        "",
        kv("ET | Session:", `${ANSI.white}${fmtEtTime(new Date())}${ANSI.reset} | ${ANSI.white}${getBtcSession(new Date())}${ANSI.reset}`),
        "",
        sepLine(),
        centerText(`${ANSI.dim}${ANSI.gray}created by @krajekis${ANSI.reset}`, screenWidth())
      ].filter((x) => x !== null);

      const PAPER_MODE = (process.env.PAPER_TRADING ?? "false").toLowerCase() === "true";
      const EXECUTE_MODE = (process.env.EXECUTE_ORDERS ?? "false").toLowerCase() === "true";

      // ── Paper Trading ─────────────────────────────────────────────────────
      const paperResult = PAPER_MODE && !EXECUTE_MODE
        ? onPaperTick({
          rec,
          poly,
          spotPrice,
          referencePrice: priceToBeat,
          settlementPrice: currentPrice,
          oracleSource: chainlink?.source ?? null,
          timeLeftMin
        })
        : null;

      const paperStats = PAPER_MODE ? getPaperStats() : null;
      const paperPos   = PAPER_MODE ? getPaperPosition() : null;

      // ── Execução de ordens reais ──────────────────────────────────────────
      const botResult = await onSignal({ rec, poly, priceToBeat, timeLeftMin });
      const botStatus = getBotStatus();

      // ── Linha de status: bot real ─────────────────────────────────────────
      const botStatusLine = (() => {
        if (PAPER_MODE && !EXECUTE_MODE) return null;
        if (!botStatus.executeOrders) {
          return kv("Bot:", `${ANSI.gray}MONITOR (EXECUTE_ORDERS=false)${ANSI.reset}`);
        }
        if (botStatus.circuitBreaker) {
          return kv("Bot:", `${ANSI.red}⛔ CIRCUIT BREAKER — perda máxima diária${ANSI.reset}`);
        }
        if (botStatus.initError) {
          return kv("Bot:", `${ANSI.red}⚠ Erro: ${botStatus.initError}${ANSI.reset}`);
        }
        if (botResult.mode === "entered") {
          return kv("Bot:", `${ANSI.green}✅ ENTROU ${botResult.side} $${botResult.usdcAmount} @ ${botResult.entryPrice}${ANSI.reset}`);
        }
        if (botResult.mode === "holding" && botStatus.position) {
          const pos = botStatus.position;
          const pnlStr = botResult.unrealizedPnl !== null
            ? ` | P&L: ${botResult.unrealizedPnl >= 0 ? ANSI.green + "+" : ANSI.red}$${(botResult.unrealizedPnl ?? 0).toFixed(2)}${ANSI.reset}`
            : "";
          return kv("Bot:", `${ANSI.yellow}⏳ Holding ${pos.side} $${pos.usdcAmount}${pnlStr}${ANSI.reset}`);
        }
        if (botResult.mode === "blocked") {
          return kv("Bot:", `${ANSI.gray}Bloqueado: ${botResult.reason}${ANSI.reset}`);
        }
        return kv("Bot:", `${ANSI.gray}Aguardando sinal...${ANSI.reset}`);
      })();

      const dailyStats = botStatus.daily;
      const dailyLine = EXECUTE_MODE
        ? kv("Dia:", `${dailyStats.realizedPnl >= 0 ? ANSI.green : ANSI.red}${dailyStats.realizedPnl >= 0 ? "+" : ""}$${dailyStats.realizedPnl.toFixed(2)}${ANSI.reset} | ${dailyStats.wins}W / ${dailyStats.losses}L`)
        : null;

      // ── Linhas de paper trading ───────────────────────────────────────────
      const paperLines = (() => {
        if (!PAPER_MODE || !paperStats) return [];

        const s = paperStats;
        const headerColor = ANSI.yellow;

        const posLine = (() => {
          if (!paperPos?.open) return kv("Posição:", `${ANSI.gray}Sem posição${ANSI.reset}`);
          const side = paperPos.side === "UP" ? `${ANSI.green}UP${ANSI.reset}` : `${ANSI.red}DOWN${ANSI.reset}`;
          return kv("Posição:", `${side} $${paperPos.usdcAmount} @ ${paperPos.entryPrice?.toFixed(2)}`);
        })();

        const winRateColor = s.winRate === null ? ANSI.gray
          : s.winRate >= 55 ? ANSI.green
          : s.winRate >= 45 ? ANSI.yellow
          : ANSI.red;

        const pnlColor = s.totalPnl >= 0 ? ANSI.green : ANSI.red;

        return [
          "",
          sepLine("─"),
          "",
          `${headerColor}PAPER TRADING${ANSI.reset}`,
          posLine,
          kv("Trades:", s.totalTrades === 0
            ? `${ANSI.gray}Nenhum ainda${ANSI.reset}`
            : `${s.totalTrades} | ${ANSI.green}${s.wins}W${ANSI.reset} / ${ANSI.red}${s.losses}L${ANSI.reset}`),
          s.totalTrades > 0 ? kv("Win rate:", `${winRateColor}${s.winRate}%${ANSI.reset}`) : null,
          s.totalTrades > 0 ? kv("P&L total:", `${pnlColor}${s.totalPnl >= 0 ? "+" : ""}$${s.totalPnl.toFixed(2)}${ANSI.reset} (ROI ${s.roi >= 0 ? "+" : ""}${s.roi}%)`) : null,
          s.totalTrades > 0 ? kv("Média/trade:", `${s.avgPnl >= 0 ? ANSI.green : ANSI.red}${s.avgPnl >= 0 ? "+" : ""}$${s.avgPnl.toFixed(2)}${ANSI.reset}`) : null,
        ].filter(Boolean);
      })();

      lines.push(...[
        "",
        sepLine(),
        "",
        botStatusLine,
        dailyLine,
        ...paperLines
      ].filter(Boolean));

      renderScreen(lines.join("\n") + "\n");

      prevSpotPrice = spotPrice ?? prevSpotPrice;
      prevCurrentPrice = currentPrice ?? prevCurrentPrice;

      if ((process.env.SIGNAL_LOG ?? "false").toLowerCase() === "true") {
        appendCsvRow("./logs/signals.csv", header, [
          new Date().toISOString(),
          timing.elapsedMinutes.toFixed(3),
          timeLeftMin.toFixed(3),
          regimeInfo.regime,
          signal,
          timeAware.adjustedUp,
          timeAware.adjustedDown,
          marketUp,
          marketDown,
          edge.edgeUp,
          edge.edgeDown,
          rec.action === "ENTER" ? `${rec.side}:${rec.phase}:${rec.strength}` : "NO_TRADE"
        ]);

        appendCsvRow("./logs/paper_validation_signals.csv", validationHeader, [
          new Date().toISOString(),
          marketSlug,
          CONFIG.candleWindowMinutes,
          timeLeftMin.toFixed(3),
          regimeInfo.regime,
          rec.action,
          rec.side,
          rec.reason ?? rec.phase,
          timeAware.adjustedUp,
          timeAware.adjustedDown,
          marketUp,
          marketDown,
          poly.ok ? poly.orderbook.up.bestBid : null,
          poly.ok ? poly.orderbook.up.bestAsk : null,
          poly.ok ? poly.orderbook.down.bestBid : null,
          poly.ok ? poly.orderbook.down.bestAsk : null,
          spread,
          edge.edgeUp,
          edge.edgeDown,
          priceToBeat,
          currentPrice,
          chainlink?.source ?? null
        ]);
      }
    } catch (err) {
      console.log("────────────────────────────");
      console.log(`Error: ${err?.message ?? String(err)}`);
      console.log("────────────────────────────");
    }

    await sleep(CONFIG.pollIntervalMs);
  }
}

process.on("SIGINT", async () => {
  console.log("\n[bot] Encerrando — cancelando ordens abertas...");
  await emergencyShutdown();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await emergencyShutdown();
  process.exit(0);
});

main();
