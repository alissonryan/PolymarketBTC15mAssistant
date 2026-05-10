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

const CHOP_RANGE_THRESHOLD  = Number(process.env.RISK_CHOP_THRESHOLD  ?? 61.8);
const BB_WIDTH_MIN_PCT       = Number(process.env.RISK_BB_WIDTH_MIN    ?? 0.08);
const MAX_EDGE               = Number(process.env.RISK_MAX_EDGE         ?? 0.35);
// Block hours (UTC) where model historically underperforms due to lagging indicators
// chasing momentum reversals at European session open
const BLOCK_HOURS_UTC        = (process.env.RISK_BLOCK_HOURS_UTC ?? "7,8,9,10")
  .split(",").map(Number).filter(Number.isFinite);

export function decide({
  remainingMinutes,
  edgeUp,
  edgeDown,
  modelUp = null,
  modelDown = null,
  regime = null,
  macroTrend = null,
  chop = null,
  bbWidthPct = null,
  spreadUp = null,
  spreadDown = null,
  maxSpread = Number(process.env.RISK_MAX_SPREAD ?? 0.03)
}) {
  if (!Number.isFinite(Number(remainingMinutes)) || Number(remainingMinutes) <= 0) {
    return { action: "NO_TRADE", side: null, phase: "EXPIRED", reason: "market_expired" };
  }

  const phase = remainingMinutes > 10 ? "EARLY" : remainingMinutes > 5 ? "MID" : "LATE";

  // Choppiness Index gate — primary range filter
  if (chop !== null && Number.isFinite(chop) && chop > CHOP_RANGE_THRESHOLD) {
    return { action: "NO_TRADE", side: null, phase, reason: `chop_${chop.toFixed(1)}_above_${CHOP_RANGE_THRESHOLD}` };
  }

  // Bollinger Band Width gate — compressed market filter
  if (bbWidthPct !== null && Number.isFinite(bbWidthPct) && bbWidthPct < BB_WIDTH_MIN_PCT) {
    return { action: "NO_TRADE", side: null, phase, reason: `bb_width_${bbWidthPct.toFixed(2)}pct_below_${BB_WIDTH_MIN_PCT}` };
  }

  // Trading hours gate — block UTC hours where lagging indicators chase reversals
  const utcHour = new Date().getUTCHours();
  if (BLOCK_HOURS_UTC.includes(utcHour)) {
    return { action: "NO_TRADE", side: null, phase, reason: `blocked_hour_${utcHour}h_utc` };
  }

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

  // Max edge cap — very high edge means all lagging indicators aligned AFTER the move;
  // historically 35%+ WR in this zone (model chasing, market already priced the move)
  if (bestEdge > MAX_EDGE) {
    return { action: "NO_TRADE", side: null, phase, reason: `edge_${bestEdge.toFixed(3)}_above_max_${MAX_EDGE}` };
  }

  if (bestModel !== null && bestModel < minProb) {
    return { action: "NO_TRADE", side: null, phase, reason: `prob_below_${minProb}` };
  }

  const strength = bestEdge >= 0.2 ? "STRONG" : bestEdge >= 0.1 ? "GOOD" : "OPTIONAL";
  return { action: "ENTER", side: bestSide, phase, strength, edge: bestEdge };
}
