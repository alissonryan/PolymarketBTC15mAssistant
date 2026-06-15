import assert from "node:assert/strict";
import test from "node:test";
import { decide } from "../src/engines/edge.js";
import { computeMacroTrend } from "../src/engines/macroTrend.js";

// Disable the wall-clock UTC-hour gate so these tests are deterministic regardless
// of when they run (decide() reads RISK_BLOCK_HOURS_UTC per-call).
process.env.RISK_BLOCK_HOURS_UTC = "";

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

// Macro trend gate removed — calibrated model already incorporates macro as input dimension.
// These tests verify that macroTrend is accepted but no longer blocks trades.
test("decide allows DOWN bet even when macroTrend is UP (calibrated model)", () => {
  const rec = decide({
    remainingMinutes: 4,
    edgeUp: 0.1,
    edgeDown: 0.15,
    modelUp: 0.44,
    modelDown: 0.63,
    regime: "TREND_DOWN",
    macroTrend: "UP"
  });
  // With calibrated model, macro gate is gone — DOWN edge should be evaluated on its own merit
  assert.ok(rec.action === "ENTER" || rec.action === "NO_TRADE"); // either is valid, gate is gone
  assert.ok(rec.reason !== "macro_trend_up_blocks_down");
});

test("decide allows UP bet even when macroTrend is DOWN (calibrated model)", () => {
  const rec = decide({
    remainingMinutes: 4,
    edgeUp: 0.15,
    edgeDown: 0.1,
    modelUp: 0.63,
    modelDown: 0.44,
    regime: "TREND_UP",
    macroTrend: "DOWN"
  });
  assert.ok(rec.action === "ENTER" || rec.action === "NO_TRADE");
  assert.ok(rec.reason !== "macro_trend_down_blocks_up");
});

test("decide enters trade when edge and model prob are sufficient", () => {
  const rec = decide({
    remainingMinutes: 4,
    edgeUp: 0.15,
    edgeDown: 0.05,
    modelUp: 0.63,
    modelDown: 0.37,
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
