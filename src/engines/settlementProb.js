/**
 * src/engines/settlementProb.js
 *
 * Probability that the market settles UP, modeled as drifted Brownian motion:
 *
 *   P(UP) = Φ( (d + μ·t) / (σ·√t) )
 *
 *   d  = spot − strike (distance already travelled, in $)
 *   t  = remaining minutes
 *   σ  = realized volatility in $ per √minute (from recent 1m candles)
 *   μ  = drift per minute implied by the calibrated base rate over the full window:
 *        baseUpRate = Φ(μ·√W/σ)  ⇒  μ = Φ⁻¹(baseUpRate)·σ/√W
 *
 * Properties (unlike the old applyTimeAwareness, which shrank toward 0.5):
 *   - At window open (d=0, t=W) it returns exactly the calibrated base rate.
 *   - As t→0 it converges to 0 or 1 depending on which side of the strike spot is —
 *     matching how the market itself prices, which kills the fake late-window edges.
 *   - In between, it weighs displacement against the volatility left on the clock.
 */

import { clamp } from "../utils.js";

/** Standard normal CDF (Abramowitz & Stegun 7.1.26, |err| < 7.5e-8). */
export function normCdf(z) {
  if (z < -8) return 0;
  if (z > 8) return 1;
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const p = 1 - Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI) * poly;
  return z >= 0 ? p : 1 - p;
}

/** Inverse standard normal CDF (Acklam's approximation, |rel err| < 1.15e-9). */
export function invNorm(p) {
  if (p <= 0 || p >= 1) throw new RangeError(`invNorm: p must be in (0,1), got ${p}`);
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.383577518672690e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pLow = 0.02425;
  let q, r;
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p <= 1 - pLow) {
    q = p - 0.5;
    r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
    ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

/**
 * Realized volatility from 1m candles, in $ per √minute.
 * Returns null when there isn't enough data to estimate (< 20 bars).
 */
export function estimateSigmaPerSqrtMin(klines1m, lookback = 60) {
  if (!Array.isArray(klines1m) || klines1m.length < 21) return null;
  const closes = klines1m.slice(-(lookback + 1)).map((k) => Number(k.close)).filter(Number.isFinite);
  if (closes.length < 21) return null;
  const returns = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0) returns.push(closes[i] / closes[i - 1] - 1);
  }
  if (returns.length < 20) return null;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, r) => a + (r - mean) ** 2, 0) / (returns.length - 1);
  const sigmaPct = Math.sqrt(variance);
  const lastPrice = closes[closes.length - 1];
  const sigma = sigmaPct * lastPrice;
  return sigma > 0 ? sigma : null;
}

/**
 * @param {object} p
 * @param {number|null} p.spot              - current oracle/spot price
 * @param {number|null} p.strike            - priceToBeat of the live market
 * @param {number} p.remainingMinutes
 * @param {number} p.windowMinutes          - full market window (5 or 15)
 * @param {number|null} p.sigmaPerSqrtMin   - from estimateSigmaPerSqrtMin()
 * @param {number} p.baseUpRate             - calibrated base rate for current conditions
 * @returns {{adjustedUp: number, adjustedDown: number, mode: string, z: number|null}}
 */
export function settlementProbability({
  spot = null,
  strike = null,
  remainingMinutes,
  windowMinutes,
  sigmaPerSqrtMin = null,
  baseUpRate = 0.5,
}) {
  const base = Number.isFinite(Number(baseUpRate)) ? clamp(Number(baseUpRate), 0.02, 0.98) : 0.5;
  const t = Number(remainingMinutes);
  const W = Math.max(Number(windowMinutes) || 0, 1e-6);

  const canDiffuse =
    Number.isFinite(Number(spot)) && Number(spot) > 0 &&
    Number.isFinite(Number(strike)) && Number(strike) > 0 &&
    Number.isFinite(sigmaPerSqrtMin) && sigmaPerSqrtMin > 0 &&
    Number.isFinite(t) && t > 0;

  if (!canDiffuse) {
    // Fallback: legacy time-decay toward 0.5 (no displacement information available)
    const timeDecay = clamp((Number.isFinite(t) ? t : 0) / W, 0, 1);
    const adjustedUp = clamp(0.5 + (base - 0.5) * timeDecay, 0, 1);
    return { adjustedUp, adjustedDown: 1 - adjustedUp, mode: "fallback_time_decay", z: null };
  }

  const tEff = Math.min(t, W);
  const mu = (invNorm(base) * sigmaPerSqrtMin) / Math.sqrt(W);
  const d = Number(spot) - Number(strike);
  const z = (d + mu * tEff) / (sigmaPerSqrtMin * Math.sqrt(tEff));
  const adjustedUp = clamp(normCdf(z), 0.001, 0.999);

  return { adjustedUp, adjustedDown: 1 - adjustedUp, mode: "diffusion", z };
}
