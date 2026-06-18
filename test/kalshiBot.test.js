import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

let bot;
let importSeq = 0;
async function freshBot() {
  bot = await import(`../src/execution/kalshiBot.js?ts=${Date.now()}-${++importSeq}`);
  return bot;
}

const baseSnap = { ok: true, ticker: "KXBTC15M-A", prices: { yes: 0.60, no: 0.40, yesBid: 0.59, noBid: 0.39 } };
const enterUp = { action: "ENTER", side: "UP", edge: 0.20 };

beforeEach(() => {
  process.env.EXECUTE_ORDERS = "true";
  process.env.KALSHI_DEMO = "true";
  process.env.RISK_ORDER_SIZE_USDC = "5";
  process.env.RISK_MIN_EDGE = "0.15";
  process.env.RISK_MIN_TOKEN_PRICE = "0.30";
  process.env.RISK_SESSION_START_UTC = "0";
  process.env.RISK_SESSION_END_UTC = "24";
  process.env.RISK_SAME_SIDE_REENTRY_MIN = "0";
  process.env.RISK_LOSS_COOLDOWN_MIN = "0";
  process.env.RISK_MAX_DAILY_LOSS_USDC = "25";
  delete process.env.KALSHI_LIVE_CONFIRM;
});

test("monitor mode when EXECUTE_ORDERS is false", async () => {
  process.env.EXECUTE_ORDERS = "false";
  await freshBot();
  const r = await bot.onKalshiSignal({ rec: enterUp, snap: baseSnap, priceToBeat: 65000, timeLeftMin: 10 });
  assert.equal(r.mode, "monitor");
});

test("places a FOK yes order sized by floor(stake/ask)", async () => {
  await freshBot();
  const placed = [];
  bot.__setDeps({
    account: { getBalanceDollars: async () => 100, getPosition: async () => null, getSettlement: async () => null },
    orders: {
      placeFokBuy: async (a) => {
        placed.push(a);
        return { orderId: "o1", filled: true, fillCount: a.count, fillCostDollars: a.count * 0.60, feesDollars: 0.1 };
      },
      dollarsToCents: (d) => Math.ceil(d * 100)
    },
    position: makeMemPosition()
  });
  const r = await bot.onKalshiSignal({ rec: enterUp, snap: baseSnap, priceToBeat: 65000, timeLeftMin: 10 });
  assert.equal(r.mode, "entered");
  assert.equal(placed[0].side, "yes");
  assert.equal(placed[0].count, 8);
  assert.equal(placed[0].limitPriceCents, 60);
});

test("blocks when production lacks KALSHI_LIVE_CONFIRM", async () => {
  process.env.KALSHI_DEMO = "false";
  await freshBot();
  bot.__setDeps({
    account: { getBalanceDollars: async () => 100, getPosition: async () => null, getSettlement: async () => null },
    orders: { placeFokBuy: async () => { throw new Error("should not be called"); }, dollarsToCents: (d) => Math.ceil(d * 100) },
    position: makeMemPosition()
  });
  const r = await bot.onKalshiSignal({ rec: enterUp, snap: baseSnap, priceToBeat: 65000, timeLeftMin: 10 });
  assert.equal(r.mode, "blocked");
  assert.match(r.reason, /live_confirm|saldo|balance/i);
});

test("blocks live mode unless KALSHI_DEMO is explicitly false", async () => {
  delete process.env.KALSHI_DEMO;
  process.env.KALSHI_LIVE_CONFIRM = "true";
  await freshBot();
  let balanceCalled = false;
  bot.__setDeps({
    account: {
      getBalanceDollars: async () => { balanceCalled = true; return 100; },
      getPosition: async () => null,
      getSettlement: async () => null
    },
    orders: { placeFokBuy: async () => { throw new Error("should not be called"); }, dollarsToCents: (d) => Math.ceil(d * 100) },
    position: makeMemPosition()
  });
  const r = await bot.onKalshiSignal({ rec: enterUp, snap: baseSnap, priceToBeat: 65000, timeLeftMin: 10 });
  assert.equal(r.mode, "blocked");
  assert.match(r.reason, /KALSHI_DEMO/);
  assert.equal(balanceCalled, false);
});

test("blocks entry when count < 1 contract", async () => {
  process.env.RISK_ORDER_SIZE_USDC = "0.50";
  await freshBot();
  bot.__setDeps({
    account: { getBalanceDollars: async () => 100, getPosition: async () => null, getSettlement: async () => null },
    orders: { placeFokBuy: async () => { throw new Error("nope"); }, dollarsToCents: (d) => Math.ceil(d * 100) },
    position: makeMemPosition()
  });
  const r = await bot.onKalshiSignal({ rec: enterUp, snap: baseSnap, priceToBeat: 65000, timeLeftMin: 10 });
  assert.equal(r.mode, "blocked");
  assert.match(r.reason, /contrato/);
});

test("settles a win from the real account on ticker change", async () => {
  await freshBot();
  const pos = makeMemPosition();
  pos.openPosition({
    side: "yes", ticker: "KXBTC15M-A", orderId: "o1", count: 8,
    entryPriceDollars: 0.60, feeDollars: 0.1, marketSlug: "KXBTC15M-A", priceToBeat: 65000, balanceBefore: 100
  });
  bot.__setDeps({
    account: {
      getBalanceDollars: async () => 100,
      getPosition: async () => null,
      getSettlement: async () => ({ ticker: "KXBTC15M-A", settledResult: "yes", revenueDollars: 8.0, yesCount: 8, noCount: 0 })
    },
    orders: { placeFokBuy: async () => ({ orderId: "x", filled: false, fillCount: 0 }), dollarsToCents: (d) => Math.ceil(d * 100) },
    position: pos
  });
  const newSnap = { ...baseSnap, ticker: "KXBTC15M-B" };
  const r = await bot.onKalshiSignal({ rec: { action: "WAIT" }, snap: newSnap, priceToBeat: 65000, timeLeftMin: 14 });
  assert.equal(r.mode, "settled");
  assert.equal(r.won, true);
  assert.ok(Math.abs(r.pnl - 3.1) < 1e-6);
  assert.equal(pos.hasOpenPosition(), false);
});

test("emergencyShutdown preserves open real position for restart reconciliation", async () => {
  await freshBot();
  const pos = makeMemPosition();
  pos.openPosition({
    side: "yes", ticker: "KXBTC15M-A", orderId: "o1", count: 8,
    entryPriceDollars: 0.60, feeDollars: 0.1, marketSlug: "KXBTC15M-A", priceToBeat: 65000, balanceBefore: 100
  });
  bot.__setDeps({ position: pos });
  await bot.emergencyShutdown();
  assert.equal(pos.hasOpenPosition(), true);
});

function makeMemPosition() {
  let s = { open: false };
  return {
    hasOpenPosition: () => s.open === true,
    getPosition: () => ({ ...s }),
    openPosition: (o) => { s = { open: true, ...o, enteredAt: "t" }; },
    closePosition: () => { s = { open: false }; }
  };
}
