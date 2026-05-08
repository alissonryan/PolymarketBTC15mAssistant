import { clamp } from "../utils.js";

export function computeRsi(closes, period) {
  if (!Array.isArray(closes) || closes.length < period + 1) return null;

  let gains = 0;
  let losses = 0;
  for (let i = closes.length - period; i < closes.length; i += 1) {
    const prev = closes[i - 1];
    const cur = closes[i];
    const diff = cur - prev;
    if (diff > 0) gains += diff;
    else losses += -diff;
  }

  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  const rsi = 100 - 100 / (1 + rs);
  return clamp(rsi, 0, 100);
}

export function sma(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  const slice = values.slice(values.length - period);
  const sum = slice.reduce((a, b) => a + b, 0);
  return sum / period;
}

export function slopeLast(values, points) {
  if (!Array.isArray(values) || values.length < points) return null;
  const slice = values.slice(values.length - points);
  const first = slice[0];
  const last = slice[slice.length - 1];
  return (last - first) / (points - 1);
}

export function ema(closes, period) {
  if (!Array.isArray(closes) || closes.length < period) return null;
  const k = 2 / (period + 1);
  let val = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i += 1) {
    val = closes[i] * k + val * (1 - k);
  }
  return val;
}

export function computeRsiSeries(closes, period, count) {
  const results = [];
  for (let i = Math.max(period, closes.length - count); i < closes.length; i += 1) {
    const r = computeRsi(closes.slice(i - period, i + 1), period);
    if (r !== null) results.push(r);
  }
  return results;
}
