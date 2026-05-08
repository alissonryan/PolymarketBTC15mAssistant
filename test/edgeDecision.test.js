import assert from "node:assert/strict";
import test from "node:test";
import { decide } from "../src/engines/edge.js";

test("decide blocks expired markets", () => {
  const rec = decide({
    remainingMinutes: -0.1,
    edgeUp: 0.5,
    edgeDown: -0.5,
    modelUp: 0.9,
    modelDown: 0.1,
    regime: "TREND_UP"
  });

  assert.deepEqual(rec, { action: "NO_TRADE", side: null, phase: "EXPIRED", reason: "market_expired" });
});

test("decide blocks entries when best-side spread exceeds max spread", () => {
  const rec = decide({
    remainingMinutes: 4,
    edgeUp: 0.5,
    edgeDown: -0.5,
    modelUp: 0.9,
    modelDown: 0.1,
    regime: "TREND_UP",
    spreadUp: 0.04,
    spreadDown: 0.01,
    maxSpread: 0.03
  });

  assert.equal(rec.action, "NO_TRADE");
  assert.equal(rec.reason, "spread_acima_do_maximo_0.03");
});
