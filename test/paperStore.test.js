import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createPaperStore } from "../src/execution/paperStore.js";

function tradeFixture(overrides = {}) {
  return {
    side: "UP", entryPrice: 0.55, usdcAmount: 5, priceToBeat: 63000.5,
    settlementPrice: 63010.2, won: true, grossPnl: 4.09, feeAtEntry: 0.02,
    pnl: 4.07, edgeAtEntry: 0.06, oracleSource: "binance", entryTimeLeftMin: 7,
    bestBidAtEntry: 0.54, bestAskAtEntry: 0.56, spreadAtEntry: 0.02,
    marketSlug: "btc-updown-15m-123", enteredAt: "2026-06-16T10:00:00.000Z",
    settledAt: "2026-06-16T10:15:00.000Z", ...overrides
  };
}

test("sqlite mode: appendTrade then loadHistory round-trips with bot_id and boolean won", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "store-sqlite-"));
  try {
    const store = createPaperStore({ cwd, prefix: "poly_btc_15m_", mode: "sqlite" });
    store.appendTrade(tradeFixture());
    store.appendTrade(tradeFixture({ side: "DOWN", won: false, pnl: -5 }));
    const { trades } = store.loadHistory();
    assert.equal(trades.length, 2);
    assert.equal(trades[0].side, "UP");
    assert.equal(trades[0].won, true);
    assert.equal(trades[1].won, false);
    assert.equal(trades[0].entryPrice, 0.55);
    store.close();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("sqlite mode: trades are isolated per bot_id", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "store-iso-"));
  try {
    const a = createPaperStore({ cwd, prefix: "poly_btc_5m_", mode: "sqlite" });
    const b = createPaperStore({ cwd, prefix: "kalshi_btc_", mode: "sqlite" });
    a.appendTrade(tradeFixture());
    assert.equal(a.loadHistory().trades.length, 1);
    assert.equal(b.loadHistory().trades.length, 0);
    a.close(); b.close();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("dual mode: writes JSON (canonical for reads) and SQLite", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "store-dual-"));
  try {
    const store = createPaperStore({ cwd, prefix: "poly_btc_5m_", mode: "dual" });
    store.appendTrade(tradeFixture());
    const jsonPath = path.join(cwd, "logs", "poly_btc_5m_paper_trades.json");
    assert.ok(existsSync(jsonPath), "json file written in dual mode");
    assert.equal(JSON.parse(readFileSync(jsonPath, "utf8")).trades.length, 1);
    assert.equal(store.loadHistory().trades.length, 1);
    assert.equal(store.sqliteCount(), 1);
    store.close();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("position save/load round-trips in sqlite mode", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "store-pos-"));
  try {
    const store = createPaperStore({ cwd, prefix: "poly_btc_15m_", mode: "sqlite" });
    assert.equal(store.loadPosition(), null);
    const pos = { open: true, side: "UP", entryPrice: 0.5, usdcAmount: 5,
      priceToBeat: 1, marketSlug: "m", enteredAt: "t", edgeAtEntry: 0.05,
      oracleSource: "binance", entryTimeLeftMin: 7, bestBidAtEntry: 0.49,
      bestAskAtEntry: 0.51, spreadAtEntry: 0.02, feeAtEntry: 0.02 };
    store.savePosition(pos);
    assert.deepEqual(store.loadPosition(), pos);
    store.close();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
