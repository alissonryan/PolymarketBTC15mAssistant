import assert from "node:assert/strict";
import test from "node:test";
import { computeChop, computeBBWidth } from "../src/indicators/chop.js";
import { decide } from "../src/engines/edge.js";

// ── computeChop ──────────────────────────────────────────────────────────────

test("computeChop returns null for insufficient data", () => {
  assert.equal(computeChop([], 14), null);
  assert.equal(computeChop([{ high: 100, low: 90, close: 95 }], 14), null);
});

test("computeChop returns value in 0-100 range for trending candles", () => {
  // Steady uptrend — low choppiness expected
  const candles = Array.from({ length: 20 }, (_, i) => ({
    high:  80000 + i * 100 + 50,
    low:   80000 + i * 100 - 50,
    close: 80000 + i * 100,
    open:  80000 + i * 100 - 20
  }));
  const chop = computeChop(candles, 14);
  assert.ok(chop !== null, "should return a number");
  assert.ok(chop >= 0 && chop <= 100, `expected 0-100, got ${chop}`);
  assert.ok(chop < 61.8, `trending market should have CHOP < 61.8, got ${chop}`);
});

test("computeChop returns high value for ranging candles", () => {
  // Oscillating market — high choppiness expected
  const candles = Array.from({ length: 20 }, (_, i) => {
    const up = i % 2 === 0;
    return {
      high:  80100,
      low:   79900,
      close: up ? 80050 : 79950,
      open:  up ? 79950 : 80050
    };
  });
  const chop = computeChop(candles, 14);
  assert.ok(chop !== null);
  assert.ok(chop > 61.8, `ranging market should have CHOP > 61.8, got ${chop}`);
});

// ── computeBBWidth ───────────────────────────────────────────────────────────

test("computeBBWidth returns null for insufficient data", () => {
  assert.equal(computeBBWidth([], 20), null);
  assert.equal(computeBBWidth([100, 100], 20), null);
});

test("computeBBWidth returns low value for flat prices", () => {
  const closes = Array.from({ length: 25 }, () => 80000);
  const width = computeBBWidth(closes, 20, 2);
  assert.ok(width !== null);
  assert.equal(width, 0); // no variation = zero width
});

test("computeBBWidth returns high value for volatile prices", () => {
  const closes = Array.from({ length: 25 }, (_, i) => 80000 + (i % 2 === 0 ? 500 : -500));
  const width = computeBBWidth(closes, 20, 2);
  assert.ok(width !== null);
  assert.ok(width > 2.0, `volatile market should have BB Width > 2%, got ${width}`);
});

// ── decide integration ───────────────────────────────────────────────────────

test("decide blocks trade when CHOP is above ranging threshold", () => {
  const rec = decide({
    remainingMinutes: 4,
    edgeUp: 0.3,
    edgeDown: 0.1,
    modelUp: 0.7,
    modelDown: 0.4,
    regime: "TREND_UP",
    chop: 70.0
  });
  assert.equal(rec.action, "NO_TRADE");
  assert.ok(rec.reason.startsWith("chop_"), `expected chop reason, got ${rec.reason}`);
});

test("decide blocks trade when BB Width is below minimum", () => {
  const rec = decide({
    remainingMinutes: 4,
    edgeUp: 0.3,
    edgeDown: 0.1,
    modelUp: 0.7,
    modelDown: 0.4,
    regime: "TREND_UP",
    chop: 40.0,
    bbWidthPct: 0.05
  });
  assert.equal(rec.action, "NO_TRADE");
  assert.ok(rec.reason.startsWith("bb_width_"), `expected bb_width reason, got ${rec.reason}`);
});

test("decide allows trade when CHOP and BB Width are healthy", () => {
  const rec = decide({
    remainingMinutes: 4,
    edgeUp: 0.3,
    edgeDown: 0.1,
    modelUp: 0.7,
    modelDown: 0.4,
    regime: "TREND_UP",
    chop: 35.0,
    bbWidthPct: 0.15
  });
  assert.equal(rec.action, "ENTER");
  assert.equal(rec.side, "UP");
});

test("decide skips CHOP/BB check when values are null", () => {
  const rec = decide({
    remainingMinutes: 4,
    edgeUp: 0.3,
    edgeDown: 0.1,
    modelUp: 0.7,
    modelDown: 0.4,
    regime: "TREND_UP",
    chop: null,
    bbWidthPct: null
  });
  assert.equal(rec.action, "ENTER");
});
