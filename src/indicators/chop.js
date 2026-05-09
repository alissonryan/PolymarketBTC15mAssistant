/**
 * Choppiness Index — detects ranging vs trending markets.
 * CHOP > 61.8 = ranging (do not trade)
 * CHOP < 38.2 = strong trend
 * Range: 0–100
 *
 * Formula: 100 × log10(Σ ATR(1,n) / (HighestHigh(n) - LowestLow(n))) / log10(n)
 */
export function computeChop(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length < period + 1) return null;

  const slice = candles.slice(candles.length - period - 1);

  let atrSum = 0;
  let highestHigh = -Infinity;
  let lowestLow = Infinity;

  for (let i = 1; i <= period; i++) {
    const cur = slice[i];
    const prev = slice[i - 1];
    if (!cur || !prev || cur.high == null || cur.low == null || prev.close == null) return null;

    const tr = Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prev.close),
      Math.abs(cur.low - prev.close)
    );
    atrSum += tr;

    if (cur.high > highestHigh) highestHigh = cur.high;
    if (cur.low < lowestLow) lowestLow = cur.low;
  }

  const rangeHL = highestHigh - lowestLow;
  if (rangeHL === 0) return null;

  const chop = (100 * Math.log10(atrSum / rangeHL)) / Math.log10(period);
  return Math.max(0, Math.min(100, chop));
}

/**
 * Bollinger Band Width as % of middle band.
 * BB Width < 1.0% = compressed / ranging (do not trade)
 * BB Width > 2.0% = expanded / trending
 */
export function computeBBWidth(closes, period = 20, stdMult = 2) {
  if (!Array.isArray(closes) || closes.length < period) return null;

  const slice = closes.slice(closes.length - period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
  const std = Math.sqrt(variance);

  const upper = mean + stdMult * std;
  const lower = mean - stdMult * std;

  if (mean === 0) return null;
  return ((upper - lower) / mean) * 100;
}
