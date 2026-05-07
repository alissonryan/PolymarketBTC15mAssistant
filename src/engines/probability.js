import { clamp } from "../utils.js";

export function scoreDirection(inputs) {
  const {
    price,
    vwap,
    vwapSlope,
    rsi,
    rsiSlope,
    macd,
    heikenColor,
    heikenCount,
    failedVwapReclaim,
    cvdTrend,
    cvdDivergence,
    cvdAbsorption,
    tpField
  } = inputs;

  let up = 1;
  let down = 1;

  if (price !== null && vwap !== null) {
    if (price > vwap) up += 2;
    if (price < vwap) down += 2;
  }

  if (vwapSlope !== null) {
    if (vwapSlope > 0) up += 2;
    if (vwapSlope < 0) down += 2;
  }

  if (rsi !== null && rsiSlope !== null) {
    if (rsi > 55 && rsiSlope > 0) up += 2;
    if (rsi < 45 && rsiSlope < 0) down += 2;
  }

  if (macd != null && macd.hist != null && macd.histDelta != null) {
    const expandingGreen = macd.hist > 0 && macd.histDelta > 0;
    const expandingRed = macd.hist < 0 && macd.histDelta < 0;
    if (expandingGreen) up += 2;
    if (expandingRed) down += 2;

    if (macd.macd > 0) up += 1;
    if (macd.macd < 0) down += 1;
  }

  if (heikenColor) {
    if (heikenColor === "green" && heikenCount >= 2) up += 1;
    if (heikenColor === "red" && heikenCount >= 2) down += 1;
  }

  if (failedVwapReclaim === true) down += 3;

  // CVD trend
  if (cvdTrend === "BUYING") up += 1;
  if (cvdTrend === "SELLING") down += 1;

  // CVD divergence (high-conviction signal)
  if (cvdDivergence?.type === "BULLISH") up += 2;
  if (cvdDivergence?.type === "BEARISH") down += 2;

  // CVD absorption (price flat but strong order flow)
  if (cvdAbsorption?.type === "BULLISH_ABSORPTION") up += 1;
  if (cvdAbsorption?.type === "BEARISH_ABSORPTION") down += 1;

  // Time-Price Convergence (late-window high-probability signal)
  if (tpField?.inField) {
    const boost = tpField.probability > 0.8 ? 3 : tpField.probability > 0.7 ? 2 : 1;
    if (tpField.direction === "UP") up += boost;
    if (tpField.direction === "DOWN") down += boost;
  }

  const rawUp = up / (up + down);
  return { upScore: up, downScore: down, rawUp };
}

export function applyTimeAwareness(rawUp, remainingMinutes, windowMinutes) {
  const timeDecay = clamp(remainingMinutes / windowMinutes, 0, 1);
  const adjustedUp = clamp(0.5 + (rawUp - 0.5) * timeDecay, 0, 1);
  return { timeDecay, adjustedUp, adjustedDown: 1 - adjustedUp };
}
