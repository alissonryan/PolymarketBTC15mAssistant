import { ema } from "../indicators/rsi.js";

const EMA_PERIOD = 50;

/**
 * Computes macro trend from 1H klines.
 * Returns "UP" if current price > EMA50(1H), "DOWN" if below, "NEUTRAL" if insufficient data.
 */
export function computeMacroTrend(klines1h) {
  if (!Array.isArray(klines1h) || klines1h.length < EMA_PERIOD) {
    return { trend: "NEUTRAL", ema50: null, reason: "insufficient_data" };
  }

  const closes = klines1h.map((c) => c.close).filter((c) => c !== null && Number.isFinite(c));
  if (closes.length < EMA_PERIOD) {
    return { trend: "NEUTRAL", ema50: null, reason: "insufficient_data" };
  }

  const ema50 = ema(closes, EMA_PERIOD);
  if (ema50 === null) return { trend: "NEUTRAL", ema50: null, reason: "ema_failed" };

  const currentPrice = closes[closes.length - 1];
  const trend = currentPrice > ema50 ? "UP" : currentPrice < ema50 ? "DOWN" : "NEUTRAL";

  return { trend, ema50, currentPrice };
}
