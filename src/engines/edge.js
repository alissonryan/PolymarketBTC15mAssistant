import { clamp } from "../utils.js";

export function computeEdge({ modelUp, modelDown, marketYes, marketNo }) {
  if (marketYes === null || marketNo === null) {
    return { marketUp: null, marketDown: null, edgeUp: null, edgeDown: null };
  }

  const sum = marketYes + marketNo;
  const marketUp = sum > 0 ? marketYes / sum : null;
  const marketDown = sum > 0 ? marketNo / sum : null;

  const edgeUp = marketUp === null ? null : modelUp - marketUp;
  const edgeDown = marketDown === null ? null : modelDown - marketDown;

  return {
    marketUp: marketUp === null ? null : clamp(marketUp, 0, 1),
    marketDown: marketDown === null ? null : clamp(marketDown, 0, 1),
    edgeUp,
    edgeDown
  };
}

export function decide({
  remainingMinutes,
  edgeUp,
  edgeDown,
  modelUp = null,
  modelDown = null,
  regime = null,
  macroTrend = null,
  spreadUp = null,
  spreadDown = null,
  maxSpread = Number(process.env.RISK_MAX_SPREAD ?? 0.03)
}) {
  if (!Number.isFinite(Number(remainingMinutes)) || Number(remainingMinutes) <= 0) {
    return { action: "NO_TRADE", side: null, phase: "EXPIRED", reason: "market_expired" };
  }

  const phase = remainingMinutes > 10 ? "EARLY" : remainingMinutes > 5 ? "MID" : "LATE";

  if (regime === "CHOP" || regime === "RANGE") {
    return { action: "NO_TRADE", side: null, phase, reason: `regime_${regime.toLowerCase()}` };
  }

  const threshold = phase === "EARLY" ? 0.05 : phase === "MID" ? 0.1 : 0.2;

  const minProb = phase === "EARLY" ? 0.55 : phase === "MID" ? 0.6 : 0.65;

  if (edgeUp === null || edgeDown === null) {
    return { action: "NO_TRADE", side: null, phase, reason: "missing_market_data" };
  }

  const bestSide = edgeUp > edgeDown ? "UP" : "DOWN";
  const bestEdge = bestSide === "UP" ? edgeUp : edgeDown;
  const bestModel = bestSide === "UP" ? modelUp : modelDown;
  const bestSpread = bestSide === "UP" ? spreadUp : spreadDown;

  // Macro trend gate: block DOWN bets when 1H trend is UP, and block UP bets when 1H trend is DOWN
  if (macroTrend === "UP" && bestSide === "DOWN") {
    return { action: "NO_TRADE", side: null, phase, reason: "macro_trend_up_blocks_down" };
  }
  if (macroTrend === "DOWN" && bestSide === "UP") {
    return { action: "NO_TRADE", side: null, phase, reason: "macro_trend_down_blocks_up" };
  }

  if (bestSpread !== null && Number.isFinite(Number(bestSpread)) && Number(bestSpread) > maxSpread) {
    return { action: "NO_TRADE", side: null, phase, reason: `spread_acima_do_maximo_${maxSpread}` };
  }

  if (bestEdge < threshold) {
    return { action: "NO_TRADE", side: null, phase, reason: `edge_below_${threshold}` };
  }

  if (bestModel !== null && bestModel < minProb) {
    return { action: "NO_TRADE", side: null, phase, reason: `prob_below_${minProb}` };
  }

  const strength = bestEdge >= 0.2 ? "STRONG" : bestEdge >= 0.1 ? "GOOD" : "OPTIONAL";
  return { action: "ENTER", side: bestSide, phase, strength, edge: bestEdge };
}
