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
