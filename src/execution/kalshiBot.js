import * as ordersMod from "./kalshiOrders.js";
import * as accountMod from "./kalshiAccount.js";
import * as positionMod from "./kalshiPosition.js";
import { canTrade, recordTrade, getDailyStats } from "../risk/guard.js";
import { createCooldownTracker } from "../risk/cooldown.js";
import { createPaperStore } from "./paperStore.js";

const _deps = { orders: ordersMod, account: accountMod, position: positionMod };
export function __setDeps(partial) { Object.assign(_deps, partial); }

const _cooldown = createCooldownTracker();
let _store = null;
let _initialized = false;
let _initError = null;

function store() {
  if (!_store) _store = createPaperStore({ prefix: "kalshi_btc_real_" });
  return _store;
}

function executeOn() {
  return (process.env.EXECUTE_ORDERS ?? "false").toLowerCase() === "true";
}

function demoOn() {
  return (process.env.KALSHI_DEMO ?? "false").toLowerCase() === "true";
}

async function ensureInit() {
  if (_initialized) return !_initError;
  _initialized = true;
  try {
    const balance = await _deps.account.getBalanceDollars();
    if (!demoOn()) {
      if ((process.env.KALSHI_LIVE_CONFIRM ?? "false").toLowerCase() !== "true") {
        _initError = "live_confirm_ausente_KALSHI_LIVE_CONFIRM_nao_e_true";
        return false;
      }
      if (!(balance > 0)) {
        _initError = "saldo_zero_deposite_antes_de_operar_real";
        return false;
      }
    }
    return true;
  } catch (err) {
    _initError = err?.message ?? String(err);
    return false;
  }
}

export async function onKalshiSignal({ rec, snap, priceToBeat, timeLeftMin }) {
  if (!executeOn()) return { mode: "monitor" };

  const ready = await ensureInit();
  if (!ready) return { mode: "blocked", reason: _initError };

  if (_deps.position.hasOpenPosition()) {
    const pos = _deps.position.getPosition();
    const changed = snap?.ok && snap.ticker && pos.ticker && snap.ticker !== pos.ticker;
    if (changed) return _settle(pos);
    return { mode: "holding", position: pos };
  }

  if (!rec || rec.action !== "ENTER") {
    return { mode: "waiting", reason: rec?.reason ?? rec?.phase ?? "no_signal" };
  }
  if (!snap?.ok) return { mode: "waiting", reason: "snapshot_indisponivel" };
  if (!Number.isFinite(Number(timeLeftMin)) || Number(timeLeftMin) <= 0) {
    return { mode: "blocked", reason: "market_expired" };
  }

  const side = rec.side === "UP" ? "yes" : "no";
  const askDollars = side === "yes" ? snap.prices?.yes : snap.prices?.no;
  if (!askDollars || askDollars <= 0) return { mode: "waiting", reason: "preco_kalshi_indisponivel" };

  const risk = canTrade({ openPositions: 0, edgeBest: rec.edge ?? 0, tokenPrice: askDollars });
  if (!risk.allowed) return { mode: "blocked", reason: risk.reason };

  const cd = _cooldown.check(rec.side);
  if (!cd.allowed) return { mode: "blocked", reason: cd.reason };

  const stake = Number(process.env.RISK_ORDER_SIZE_USDC ?? 5);
  const count = Math.floor(stake / askDollars);
  if (count < 1) return { mode: "blocked", reason: "order_size_menor_que_1_contrato" };

  const limitPriceCents = _deps.orders.dollarsToCents(askDollars);
  const balanceBefore = await _deps.account.getBalanceDollars().catch(() => null);

  let result;
  try {
    result = await _deps.orders.placeFokBuy({
      ticker: snap.ticker,
      side,
      count,
      limitPriceCents,
      clientOrderId: `${snap.ticker}-${Date.now()}`
    });
  } catch (err) {
    return { mode: "error", reason: err?.message ?? String(err) };
  }

  if (!result.filled) {
    return { mode: "not_filled", orderId: result.orderId, fillCount: result.fillCount };
  }

  _cooldown.recordEntry(rec.side);
  const entryPriceDollars = result.fillCostDollars != null && count > 0
    ? result.fillCostDollars / count
    : askDollars;

  _deps.position.openPosition({
    side,
    ticker: snap.ticker,
    orderId: result.orderId,
    count,
    entryPriceDollars,
    feeDollars: result.feesDollars ?? 0,
    marketSlug: snap.ticker,
    priceToBeat,
    balanceBefore
  });

  return { mode: "entered", side, count, entryPriceDollars, orderId: result.orderId };
}

async function _settle(pos) {
  const settlement = await _deps.account.getSettlement(pos.ticker);
  if (!settlement) return { mode: "holding", position: pos, note: "settlement_pendente" };

  const won = settlement.settledResult === pos.side;
  const cost = pos.count * pos.entryPriceDollars + (pos.feeDollars ?? 0);
  const revenue = settlement.revenueDollars ?? (won ? pos.count : 0);
  const pnl = parseFloat((revenue - cost).toFixed(4));

  if (!won) _cooldown.recordLoss(pos.side === "yes" ? "UP" : "DOWN");
  recordTrade({ pnl });

  store().appendTrade({
    side: pos.side === "yes" ? "UP" : "DOWN",
    entryPrice: pos.entryPriceDollars,
    usdcAmount: cost,
    priceToBeat: pos.priceToBeat,
    settlementPrice: null,
    won,
    grossPnl: parseFloat((revenue - pos.count * pos.entryPriceDollars).toFixed(4)),
    feeAtEntry: pos.feeDollars ?? 0,
    pnl,
    edgeAtEntry: null,
    oracleSource: "kalshi_account_settlement",
    entryTimeLeftMin: null,
    bestBidAtEntry: null,
    bestAskAtEntry: null,
    spreadAtEntry: null,
    marketSlug: pos.marketSlug,
    enteredAt: pos.enteredAt,
    settledAt: new Date().toISOString()
  });

  _deps.position.closePosition();
  return { mode: "settled", won, pnl, ticker: pos.ticker };
}

export async function emergencyShutdown() {
  try {
    if (_deps.position.hasOpenPosition()) _deps.position.closePosition();
  } catch {
    // ignore
  }
}

export function getKalshiBotStatus() {
  const hasPosition = _deps.position.hasOpenPosition();
  return {
    executeOrders: executeOn(),
    demo: demoOn(),
    initialized: _initialized,
    initError: _initError,
    hasPosition,
    position: hasPosition ? _deps.position.getPosition() : null,
    daily: getDailyStats()
  };
}
