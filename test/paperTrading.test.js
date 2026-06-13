import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { estimateTakerFee } from "../src/execution/paperMath.js";

async function loadPaper(prefix) {
  const dir = mkdtempSync(path.join(tmpdir(), "poly-paper-"));
  const previousCwd = process.cwd();
  process.chdir(dir);
  process.env.PAPER_LOG_PREFIX = prefix;
  process.env.RISK_SESSION_START_UTC = "0";
  process.env.RISK_SESSION_END_UTC = "24";
  process.env.RISK_MIN_EDGE = "0.01";
  process.env.RISK_MIN_TOKEN_PRICE = "0.01";
  const mod = await import(`../src/execution/paperTrading.js?case=${prefix}-${Math.random()}`);

  return {
    mod,
    cleanup() {
      process.chdir(previousCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

test("paper trading uses venue reference price instead of Binance spot when provided", async () => {
  const { mod, cleanup } = await loadPaper("poly_");
  try {
    const rec = { action: "ENTER", side: "UP", edge: 0.2, phase: "LATE" };
    const poly = {
      ok: true,
      market: { slug: "btc-updown-5m-test" },
      tokens: { upTokenId: "up", downTokenId: "down" },
      prices: { up: 0.52, down: 0.51 },
      referencePrice: 100
    };

    mod.onPaperTick({ rec, poly, spotPrice: 90, referencePrice: 100, oracleSource: "polymarket_ws", timeLeftMin: 3 });
    const pos = mod.getPaperPosition();

    assert.equal(pos.priceToBeat, 100);
    assert.equal(pos.oracleSource, "polymarket_ws");
  } finally {
    cleanup();
  }
});

test("estimateTakerFee applies prediction market taker fee formula", () => {
  assert.equal(estimateTakerFee({ usdcAmount: 5, entryPrice: 0.5, feeRate: 0.07 }), 0.175);
});

test("paper lock prevents two instances with the same prefix", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "poly-lock-"));
  const previousCwd = process.cwd();
  process.chdir(dir);
  process.env.PAPER_LOG_PREFIX = "same_";

  const first = await import(`../src/execution/paperTrading.js?case=lock-a-${Math.random()}`);
  const second = await import(`../src/execution/paperTrading.js?case=lock-b-${Math.random()}`);

  try {
    const firstLock = first.acquirePaperLock();
    assert.equal(firstLock.acquired, true);
    assert.equal(existsSync(path.join(dir, "logs", "same_paper.lock")), true);

    const secondLock = second.acquirePaperLock();
    assert.equal(secondLock.acquired, false);
    assert.match(secondLock.reason, /paper_lock_exists/);

    first.releasePaperLock();
  } finally {
    process.chdir(previousCwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("paper lock recovers stale lock files from dead pids", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "poly-stale-lock-"));
  const previousCwd = process.cwd();
  process.chdir(dir);
  process.env.PAPER_LOG_PREFIX = "stale_";
  mkdirSync(path.join(dir, "logs"), { recursive: true });
  writeFileSync(path.join(dir, "logs", "stale_paper.lock"), JSON.stringify({ pid: 99999999 }), "utf8");

  const mod = await import(`../src/execution/paperTrading.js?case=stale-lock-${Math.random()}`);

  try {
    const lock = mod.acquirePaperLock();
    assert.equal(lock.acquired, true);
    mod.releasePaperLock();
  } finally {
    process.chdir(previousCwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("same-side cooldown blocks immediate re-entry on the same side", async () => {
  const { mod, cleanup } = await loadPaper("cool_");
  try {
    process.env.RISK_SAME_SIDE_REENTRY_MIN = "30";
    const rec = { action: "ENTER", side: "UP", edge: 0.2, phase: "EARLY" };
    const mkPoly = (slug) => ({
      ok: true,
      market: { slug },
      tokens: { upTokenId: "up", downTokenId: "down" },
      prices: { up: 0.52, down: 0.51 },
      referencePrice: 100
    });

    const first = mod.onPaperTick({ rec, poly: mkPoly("btc-updown-15m-a"), spotPrice: 100, referencePrice: 100, timeLeftMin: 14 });
    assert.equal(first.mode, "entered");

    // Novo slug liquida a posição; mesma direção logo em seguida deve ser bloqueada
    const second = mod.onPaperTick({ rec, poly: mkPoly("btc-updown-15m-b"), spotPrice: 100, referencePrice: 100, timeLeftMin: 14 });
    assert.equal(second.mode, "blocked");
    assert.match(second.reason, /cooldown/);

    // Lado oposto não é afetado pelo cooldown do lado UP
    const recDown = { action: "ENTER", side: "DOWN", edge: 0.2, phase: "EARLY" };
    const third = mod.onPaperTick({ rec: recDown, poly: mkPoly("btc-updown-15m-b"), spotPrice: 100, referencePrice: 100, timeLeftMin: 14 });
    assert.equal(third.mode, "entered");
  } finally {
    delete process.env.RISK_SAME_SIDE_REENTRY_MIN;
    cleanup();
  }
});

test("settlement equal to strike voids the trade instead of recording a loss", async () => {
  const { mod, cleanup } = await loadPaper("void_");
  try {
    const rec = { action: "ENTER", side: "UP", edge: 0.2, phase: "EARLY" };
    const mkPoly = (slug) => ({
      ok: true,
      market: { slug },
      tokens: { upTokenId: "up", downTokenId: "down" },
      prices: { up: 0.52, down: 0.51 },
      referencePrice: 100
    });

    const first = mod.onPaperTick({ rec, poly: mkPoly("btc-updown-15m-a"), spotPrice: 100, referencePrice: 100, settlementPrice: 100, timeLeftMin: 14 });
    assert.equal(first.mode, "entered");

    // Novo slug com settlement EXATAMENTE igual ao strike (oracle congelado) → VOID
    const noTrade = { action: "NO_TRADE", side: null, phase: "EARLY", reason: "x" };
    mod.onPaperTick({ rec: noTrade, poly: mkPoly("btc-updown-15m-b"), spotPrice: 100, referencePrice: 100, settlementPrice: 100, timeLeftMin: 14 });

    const stats = mod.getPaperStats();
    assert.equal(stats.totalTrades, 0); // nada gravado
    assert.equal(mod.hasPaperPosition(), false); // posição fechada
  } finally {
    cleanup();
  }
});

test("settlement equal to previous market's settlement voids (frozen feed across markets)", async () => {
  const { mod, cleanup } = await loadPaper("frz_");
  try {
    const rec = { action: "ENTER", side: "UP", edge: 0.2, phase: "EARLY" };
    const mkPoly = (slug) => ({
      ok: true, market: { slug }, tokens: { upTokenId: "up", downTokenId: "down" },
      prices: { up: 0.52, down: 0.51 }, referencePrice: 100
    });
    const noTrade = { action: "NO_TRADE", side: null, phase: "EARLY", reason: "x" };

    // 1ª posição entra (strike 100), liquida no slug B com settlement 105 (real, !=strike)
    mod.onPaperTick({ rec, poly: mkPoly("m-a"), spotPrice: 100, referencePrice: 100, settlementPrice: 100, timeLeftMin: 14 });
    mod.onPaperTick({ rec, poly: mkPoly("m-b"), spotPrice: 105, referencePrice: 105, settlementPrice: 105, timeLeftMin: 14 });
    const after1 = mod.getPaperStats().totalTrades; // 1 trade real gravado

    // Nova posição no slug B (strike 105) liquida no slug C com settlement 105 de novo → feed congelado → VOID
    mod.onPaperTick({ rec: noTrade, poly: mkPoly("m-c"), spotPrice: 105, referencePrice: 105, settlementPrice: 105, timeLeftMin: 14 });
    const after2 = mod.getPaperStats().totalTrades;

    assert.equal(after1, 1);
    assert.equal(after2, 1); // nada novo gravado — o segundo settlement repetido foi anulado
  } finally {
    cleanup();
  }
});
