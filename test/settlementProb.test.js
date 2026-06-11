import assert from "node:assert/strict";
import test from "node:test";
import {
  normCdf,
  invNorm,
  estimateSigmaPerSqrtMin,
  settlementProbability,
} from "../src/engines/settlementProb.js";

test("normCdf and invNorm are consistent inverses", () => {
  for (const p of [0.05, 0.25, 0.5, 0.75, 0.95]) {
    assert.ok(Math.abs(normCdf(invNorm(p)) - p) < 1e-6, `p=${p}`);
  }
  assert.ok(Math.abs(normCdf(0) - 0.5) < 1e-9);
});

test("settlementProbability returns the base rate at window open (d=0, t=W)", () => {
  const r = settlementProbability({
    spot: 100000,
    strike: 100000,
    remainingMinutes: 15,
    windowMinutes: 15,
    sigmaPerSqrtMin: 30,
    baseUpRate: 0.62,
  });
  assert.equal(r.mode, "diffusion");
  assert.ok(Math.abs(r.adjustedUp - 0.62) < 0.005, `got ${r.adjustedUp}`);
});

test("settlementProbability converges to ~1 when spot is far above strike with little time", () => {
  const r = settlementProbability({
    spot: 100300,
    strike: 100000,
    remainingMinutes: 0.5,
    windowMinutes: 15,
    sigmaPerSqrtMin: 30,
    baseUpRate: 0.5,
  });
  assert.ok(r.adjustedUp > 0.99, `got ${r.adjustedUp}`);
});

test("settlementProbability converges to ~0 when spot is far below strike with little time", () => {
  const r = settlementProbability({
    spot: 99700,
    strike: 100000,
    remainingMinutes: 0.5,
    windowMinutes: 15,
    sigmaPerSqrtMin: 30,
    baseUpRate: 0.6,
  });
  assert.ok(r.adjustedUp < 0.01, `got ${r.adjustedUp}`);
});

test("settlementProbability is monotonic in displacement", () => {
  const probs = [-100, -50, 0, 50, 100].map(
    (d) =>
      settlementProbability({
        spot: 100000 + d,
        strike: 100000,
        remainingMinutes: 7,
        windowMinutes: 15,
        sigmaPerSqrtMin: 30,
        baseUpRate: 0.5,
      }).adjustedUp,
  );
  for (let i = 1; i < probs.length; i++) {
    assert.ok(probs[i] > probs[i - 1], `probs not increasing: ${probs}`);
  }
});

test("settlementProbability falls back to time decay when strike or sigma is missing", () => {
  const r = settlementProbability({
    spot: 100000,
    strike: null,
    remainingMinutes: 15,
    windowMinutes: 15,
    sigmaPerSqrtMin: null,
    baseUpRate: 0.62,
  });
  assert.equal(r.mode, "fallback_time_decay");
  assert.ok(Math.abs(r.adjustedUp - 0.62) < 1e-9);
  assert.ok(Math.abs(r.adjustedUp + r.adjustedDown - 1) < 1e-9);
});

test("estimateSigmaPerSqrtMin computes realized vol from 1m candles", () => {
  // Alternating ±0.1% moves around 100k → sigma ≈ 0.1% of price ≈ 100 $/√min
  const klines = [];
  let price = 100000;
  for (let i = 0; i < 80; i++) {
    price = i % 2 === 0 ? price * 1.001 : price / 1.001;
    klines.push({ close: price });
  }
  const sigma = estimateSigmaPerSqrtMin(klines);
  assert.ok(sigma > 50 && sigma < 150, `got ${sigma}`);
});

test("estimateSigmaPerSqrtMin returns null with insufficient data", () => {
  assert.equal(estimateSigmaPerSqrtMin([{ close: 1 }, { close: 2 }]), null);
  assert.equal(estimateSigmaPerSqrtMin(null), null);
});
