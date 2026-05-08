import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const RealDate = Date;

async function loadGuardAt(hourUtc) {
  const dir = mkdtempSync(path.join(tmpdir(), "poly-risk-"));
  const previousCwd = process.cwd();
  process.chdir(dir);

  class FixedDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) return new RealDate(`2026-05-08T${String(hourUtc).padStart(2, "0")}:00:00.000Z`);
      return new RealDate(...args);
    }

    static now() {
      return new RealDate(`2026-05-08T${String(hourUtc).padStart(2, "0")}:00:00.000Z`).getTime();
    }
  }

  globalThis.Date = FixedDate;
  const mod = await import(`../src/risk/guard.js?case=${hourUtc}-${Math.random()}`);

  return {
    mod,
    cleanup() {
      globalThis.Date = RealDate;
      process.chdir(previousCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

test("canTrade blocks trading outside configured UTC session", async () => {
  process.env.RISK_SESSION_START_UTC = "8";
  process.env.RISK_SESSION_END_UTC = "23";
  process.env.RISK_MIN_EDGE = "0.15";

  const { mod, cleanup } = await loadGuardAt(7);
  try {
    const result = mod.canTrade({ edgeBest: 0.5, tokenPrice: 0.5 });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, "sessao_bloqueada_fora_janela_8h-23h_utc");
  } finally {
    cleanup();
  }
});

test("canTrade allows a valid trade inside configured UTC session", async () => {
  process.env.RISK_SESSION_START_UTC = "8";
  process.env.RISK_SESSION_END_UTC = "23";
  process.env.RISK_MIN_EDGE = "0.15";
  process.env.RISK_MIN_TOKEN_PRICE = "0.30";
  process.env.RISK_ORDER_SIZE_USDC = "5";

  const { mod, cleanup } = await loadGuardAt(12);
  try {
    const result = mod.canTrade({ edgeBest: 0.16, tokenPrice: 0.5 });
    assert.deepEqual(result, { allowed: true, orderSize: 5 });
  } finally {
    cleanup();
  }
});
