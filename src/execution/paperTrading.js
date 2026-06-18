import fs from "node:fs";
import path from "node:path";
import { canTrade } from "../risk/guard.js";
import { createCooldownTracker } from "../risk/cooldown.js";
import { estimateTakerFee } from "./paperMath.js";
import { createPaperStore } from "./paperStore.js";

const _prefix = process.env.PAPER_LOG_PREFIX || "";
const LOCK_FILE = path.join(process.cwd(), "logs", `${_prefix}paper.lock`);
let _lockFd = null;

// Preço da Binance latched no início de cada janela de mercado
// Usado em vez do Chainlink (que pode ficar congelado por horas em baixa volatilidade)
let _paperPtbSlug = null;
let _paperPtbPrice = null;

const _cooldown = createCooldownTracker();

// Last settled price — used to detect a frozen feed printing the same price across
// consecutive (different) markets. See _settlePosition.
let _lastSettlementPrice = null;

const EMPTY_POSITION = {
  open: false,
  side: null,
  entryPrice: null,
  usdcAmount: null,
  priceToBeat: null,
  marketSlug: null,
  enteredAt: null,
  edgeAtEntry: null,
  oracleSource: null,
  entryTimeLeftMin: null,
  bestBidAtEntry: null,
  bestAskAtEntry: null,
  spreadAtEntry: null,
  feeAtEntry: 0
};

// ─── persistência ────────────────────────────────────────────────────────────

function ensureDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

const _store = createPaperStore(); // mode from PAPER_STORE env (default "json")

export function acquirePaperLock() {
  if (_lockFd !== null) return { acquired: true, file: LOCK_FILE };
  try {
    ensureDir(LOCK_FILE);
    _lockFd = fs.openSync(LOCK_FILE, "wx");
    fs.writeFileSync(_lockFd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), "utf8");
    return { acquired: true, file: LOCK_FILE };
  } catch (err) {
    if (err?.code === "EEXIST") {
      try {
        const lock = JSON.parse(fs.readFileSync(LOCK_FILE, "utf8"));
        if (lock?.pid && Number(lock.pid) !== process.pid) {
          try {
            process.kill(Number(lock.pid), 0);
          } catch (pidErr) {
            if (pidErr?.code === "ESRCH") {
              fs.unlinkSync(LOCK_FILE);
              return acquirePaperLock();
            }
          }
        }
      } catch {
        // If the lock file is unreadable, keep the conservative block.
      }
      return { acquired: false, file: LOCK_FILE, reason: `paper_lock_exists_${LOCK_FILE}` };
    }
    return { acquired: false, file: LOCK_FILE, reason: err?.message ?? String(err) };
  }
}

export function releasePaperLock() {
  if (_lockFd !== null) {
    try { fs.closeSync(_lockFd); } catch { /* ignore */ }
    _lockFd = null;
  }
  try { fs.unlinkSync(LOCK_FILE); } catch { /* ignore */ }
}

// ─── estado em memória ───────────────────────────────────────────────────────

let _pos = _store.loadPosition() ?? { ...EMPTY_POSITION };

function savePos() { _store.savePosition(_pos); }

// ─── cálculo de P&L ──────────────────────────────────────────────────────────

// Prediction market payout:
//   Comprou UP a 0.65 e ganhou → recebe 1 USDC por share → pnl = amount*(1/price - 1)
//   Comprou UP a 0.65 e perdeu → recebe 0                → pnl = -amount
function calcPnl(usdcAmount, entryPrice, won) {
  if (won) return parseFloat((usdcAmount * (1 / entryPrice - 1)).toFixed(4));
  return -usdcAmount;
}

// ─── API pública ─────────────────────────────────────────────────────────────

export function hasPaperPosition() {
  return _pos.open === true;
}

export function getPaperPosition() {
  return { ..._pos };
}

// Chamado a cada tick do loop principal
// spotPrice = preço Binance WebSocket (sempre atualizado, nunca congela)
export function onPaperTick({ rec, poly, spotPrice, referencePrice = null, settlementPrice = null, oracleSource = null, timeLeftMin }) {
  const marketSlug = poly.ok ? (poly.market?.slug ?? null) : null;
  const marketReferencePrice = referencePrice ?? poly.referencePrice ?? spotPrice ?? null;
  const marketSettlementPrice = settlementPrice ?? referencePrice ?? poly.referencePrice ?? spotPrice ?? null;

  // ── 1. Detecta liquidação: mercado mudou de slug ──────────────────────────
  if (_pos.open && marketSlug && _pos.marketSlug && _pos.marketSlug !== marketSlug) {
    _settlePosition(marketSettlementPrice);
  }

  // ── Latch da referência oficial/preferida no início de cada janela ─────────
  if (marketSlug && marketSlug !== _paperPtbSlug) {
    _paperPtbSlug = marketSlug;
    _paperPtbPrice = marketReferencePrice;
  }

  // ── 2. Sem posição aberta: avalia entrada ─────────────────────────────────
  if (!_pos.open) {
    if (rec.action !== "ENTER" || !poly.ok || !poly.tokens) {
      return { mode: "waiting", reason: rec.reason ?? rec.phase };
    }

    if (!Number.isFinite(Number(timeLeftMin)) || Number(timeLeftMin) <= 0) {
      return { mode: "blocked", reason: "market_expired" };
    }

    if (!spotPrice) {
      return { mode: "waiting", reason: "spot_price_indisponivel" };
    }

    const orderSize = Number(process.env.RISK_ORDER_SIZE_USDC ?? 5);
    const entryPrice = rec.side === "UP" ? poly.prices?.up : poly.prices?.down;
    const bookSide = rec.side === "UP" ? poly.orderbook?.up : poly.orderbook?.down;
    const feeAtEntry = estimateTakerFee({ usdcAmount: orderSize, entryPrice });

    if (!entryPrice || entryPrice <= 0) {
      return { mode: "waiting", reason: "preco_polymarket_indisponivel" };
    }

    const edgeBest = rec.edge ?? 0;
    const risk = canTrade({ openPositions: 0, edgeBest, tokenPrice: entryPrice });
    if (!risk.allowed) {
      return { mode: "blocked", reason: risk.reason };
    }

    const cooldown = _cooldown.check(rec.side);
    if (!cooldown.allowed) {
      return { mode: "blocked", reason: cooldown.reason };
    }
    _cooldown.recordEntry(rec.side);

    _pos = {
      open: true,
      side: rec.side,
      entryPrice,
      usdcAmount: orderSize,
      priceToBeat: _paperPtbPrice,
      marketSlug,
      enteredAt: new Date().toISOString(),
      edgeAtEntry: edgeBest,
      oracleSource: oracleSource ?? "unknown",
      entryTimeLeftMin: Number.isFinite(Number(timeLeftMin)) ? Number(timeLeftMin) : null,
      bestBidAtEntry: bookSide?.bestBid ?? null,
      bestAskAtEntry: bookSide?.bestAsk ?? null,
      spreadAtEntry: bookSide?.spread ?? null,
      feeAtEntry
    };
    savePos();

    return { mode: "entered", side: rec.side, usdcAmount: orderSize, entryPrice };
  }

  // ── 3. Posição aberta: retorna mark-to-market ─────────────────────────────
  const side = _pos.side === "UP" ? "up" : "down";
  const currentMarketPrice = poly.ok ? (poly.prices?.[side] ?? null) : null;
  const unrealizedPnl = currentMarketPrice
    ? _pos.usdcAmount * currentMarketPrice / (_pos.entryPrice ?? currentMarketPrice) - _pos.usdcAmount
    : null;

  return { mode: "holding", position: _pos, unrealizedPnl };
}

function _settlePosition(settlementChainlinkPrice) {
  // Frozen-oracle guards. Two shapes of a stale price feed, both fatal to results:
  //  (a) settlement == strike: strike and settlement read the same dead tick.
  //  (b) settlement == previous market's settlement: the feed printed the SAME
  //      price across two different markets — impossible with a live oracle over
  //      a full window (this is what poisoned 12/06 Kalshi: 22 markets all settled
  //      at the identical 63503.62 spot). Void instead of recording phantom results.
  const frozenVsStrike =
    _pos.priceToBeat !== null &&
    settlementChainlinkPrice !== null &&
    Number(settlementChainlinkPrice) === Number(_pos.priceToBeat);
  const frozenVsPrev =
    settlementChainlinkPrice !== null &&
    _lastSettlementPrice !== null &&
    Number(settlementChainlinkPrice) === Number(_lastSettlementPrice);

  if (frozenVsStrike || frozenVsPrev) {
    console.warn(
      `[paper] ⚠ VOID | ${_pos.side} @ ${_pos.entryPrice} | ` +
      `settlement ${Number(settlementChainlinkPrice).toFixed(2)} ` +
      `(${frozenVsStrike ? "== strike" : "== settlement anterior"}) — oracle congelado, trade anulado`
    );
    _store.appendVoided({
      side: _pos.side,
      entryPrice: _pos.entryPrice,
      priceToBeat: _pos.priceToBeat,
      settlementPrice: settlementChainlinkPrice,
      voidReason: frozenVsStrike ? "frozen_vs_strike" : "frozen_vs_prev",
      enteredAt: _pos.enteredAt,
      voidedAt: new Date().toISOString()
    });
    _pos = { ...EMPTY_POSITION };
    savePos();
    return;
  }
  _lastSettlementPrice = settlementChainlinkPrice;

  const won = _determineWinner(_pos.side, _pos.priceToBeat, settlementChainlinkPrice);
  if (!won && (_pos.side === "UP" || _pos.side === "DOWN")) {
    _cooldown.recordLoss(_pos.side);
  }
  const grossPnl = calcPnl(_pos.usdcAmount, _pos.entryPrice, won);
  const pnl = parseFloat((grossPnl - (_pos.feeAtEntry ?? 0)).toFixed(4));

  const trade = {
    side:             _pos.side,
    entryPrice:       _pos.entryPrice,
    usdcAmount:       _pos.usdcAmount,
    priceToBeat:      _pos.priceToBeat,
    settlementPrice:  settlementChainlinkPrice,
    won,
    grossPnl,
    feeAtEntry:       _pos.feeAtEntry ?? 0,
    pnl,
    edgeAtEntry:      _pos.edgeAtEntry,
    oracleSource:     _pos.oracleSource,
    entryTimeLeftMin: _pos.entryTimeLeftMin,
    bestBidAtEntry:   _pos.bestBidAtEntry,
    bestAskAtEntry:   _pos.bestAskAtEntry,
    spreadAtEntry:    _pos.spreadAtEntry,
    marketSlug:       _pos.marketSlug,
    enteredAt:        _pos.enteredAt,
    settledAt:        new Date().toISOString()
  };

  _store.appendTrade(trade);

  console.log(
    `[paper] ${won ? "✅ WIN" : "❌ LOSS"} | ${_pos.side} @ ${_pos.entryPrice} | ` +
    `ptb: ${_pos.priceToBeat?.toFixed(2)} → ${settlementChainlinkPrice?.toFixed(2)} | ` +
    `P&L: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`
  );

  _pos = { ...EMPTY_POSITION };
  savePos();
}

function _determineWinner(side, priceToBeat, settlementPrice) {
  if (priceToBeat === null || settlementPrice === null) return false;
  if (side === "UP") return settlementPrice > priceToBeat;
  if (side === "DOWN") return settlementPrice < priceToBeat;
  return false;
}

// ─── estatísticas ─────────────────────────────────────────────────────────────

export function getPaperStats() {
  const { trades } = _store.loadHistory();

  if (trades.length === 0) {
    return {
      totalTrades: 0, wins: 0, losses: 0, winRate: null,
      totalPnl: 0, avgPnl: null, bestTrade: null, worstTrade: null,
      roi: null
    };
  }

  const wins   = trades.filter(t => t.won).length;
  const losses = trades.length - wins;
  const totalPnl  = parseFloat(trades.reduce((a, t) => a + t.pnl, 0).toFixed(4));
  const totalRisked = trades.reduce((a, t) => a + t.usdcAmount, 0);
  const pnls   = trades.map(t => t.pnl);

  return {
    totalTrades: trades.length,
    wins,
    losses,
    winRate:    parseFloat((wins / trades.length * 100).toFixed(1)),
    totalPnl,
    avgPnl:     parseFloat((totalPnl / trades.length).toFixed(4)),
    bestTrade:  parseFloat(Math.max(...pnls).toFixed(4)),
    worstTrade: parseFloat(Math.min(...pnls).toFixed(4)),
    roi:        parseFloat((totalPnl / totalRisked * 100).toFixed(2))
  };
}

export function getLastTrades(n = 5) {
  const { trades } = _store.loadHistory();
  return trades.slice(-n);
}
