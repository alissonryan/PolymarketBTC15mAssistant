import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const PREFIX = "test_kalshi_";
beforeEach(() => {
  process.env.PAPER_LOG_PREFIX = PREFIX;
  const file = path.join(process.cwd(), "logs", `${PREFIX}kalshi_real_position.json`);
  if (fs.existsSync(file)) fs.unlinkSync(file);
});

test("open then close round-trips through disk", async () => {
  const mod = await import(`../src/execution/kalshiPosition.js?ts=${Date.now()}`);
  assert.equal(mod.hasOpenPosition(), false);
  mod.openPosition({
    side: "yes", ticker: "T", orderId: "o1", count: 8,
    entryPriceDollars: 0.61, feeDollars: 0.12, marketSlug: "T", priceToBeat: 65000, balanceBefore: 50
  });
  assert.equal(mod.hasOpenPosition(), true);
  const p = mod.getPosition();
  assert.equal(p.side, "yes");
  assert.equal(p.count, 8);
  assert.equal(p.balanceBefore, 50);
  mod.closePosition();
  assert.equal(mod.hasOpenPosition(), false);
});
