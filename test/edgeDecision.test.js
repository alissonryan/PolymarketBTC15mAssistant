import assert from "node:assert/strict";
import test from "node:test";
import { decide } from "../src/engines/edge.js";
import { computeMacroTrend } from "../src/engines/macroTrend.js";

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

test("decide blocks DOWN bet when macroTrend is UP", () => {
  const rec = decide({
    remainingMinutes: 4,
    edgeUp: 0.1,
    edgeDown: 0.35,
    modelUp: 0.4,
    modelDown: 0.75,
    regime: "TREND_DOWN",
    macroTrend: "UP"
  });

  assert.equal(rec.action, "NO_TRADE");
  assert.equal(rec.reason, "macro_trend_up_blocks_down");
});

test("decide blocks UP bet when macroTrend is DOWN", () => {
  const rec = decide({
    remainingMinutes: 4,
    edgeUp: 0.35,
    edgeDown: 0.1,
    modelUp: 0.75,
    modelDown: 0.4,
    regime: "TREND_UP",
    macroTrend: "DOWN"
  });

  assert.equal(rec.action, "NO_TRADE");
  assert.equal(rec.reason, "macro_trend_down_blocks_up");
});

test("decide allows aligned bet when macroTrend matches side", () => {
  const rec = decide({
    remainingMinutes: 4,
    edgeUp: 0.35,
    edgeDown: 0.1,
    modelUp: 0.75,
    modelDown: 0.4,
    regime: "TREND_UP",
    macroTrend: "UP"
  });

  assert.equal(rec.action, "ENTER");
  assert.equal(rec.side, "UP");
});

test("computeMacroTrend returns NEUTRAL with insufficient data", () => {
  const result = computeMacroTrend([]);
  assert.equal(result.trend, "NEUTRAL");
});

test("computeMacroTrend returns UP when price above EMA50", () => {
  const closes = Array.from({ length: 60 }, (_, i) => 80000 + i * 10);
  const klines = closes.map((c) => ({ close: c }));
  const result = computeMacroTrend(klines);
  assert.equal(result.trend, "UP");
  assert.ok(result.ema50 !== null);
});

test("computeMacroTrend returns DOWN when price below EMA50", () => {
  // Rising sequence then sharp drop
  const closes = Array.from({ length: 59 }, (_, i) => 80000 + i * 100);
  closes.push(75000); // price crashes below EMA
  const klines = closes.map((c) => ({ close: c }));
  const result = computeMacroTrend(klines);
  assert.equal(result.trend, "DOWN");
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
