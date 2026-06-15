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

const FEE_RATE               = Number(process.env.RISK_TAKER_FEE_RATE   ?? 0.07);
const EDGE_SAFETY_MARGIN     = Number(process.env.RISK_EDGE_MARGIN      ?? 0.02);
const CHOP_RANGE_THRESHOLD  = Number(process.env.RISK_CHOP_THRESHOLD  ?? 61.8);
const BB_WIDTH_MIN_PCT       = Number(process.env.RISK_BB_WIDTH_MIN    ?? 0.08);
const MAX_EDGE               = Number(process.env.RISK_MAX_EDGE         ?? 0.35);

// Block hours (UTC) where the model historically underperforms (lagging indicators
// chasing reversals at the European open). Read per-call so it stays runtime-
// configurable and deterministic in tests (the old module-load const made the
// suite fail whenever it ran during a blocked hour).
function blockedHoursUtc() {
  return (process.env.RISK_BLOCK_HOURS_UTC ?? "7,8,9,10")
    .split(",").map(Number).filter(Number.isFinite);
}

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
  if (blockedHoursUtc().includes(utcHour)) {
    return { action: "NO_TRADE", side: null, phase, reason: `blocked_hour_${utcHour}h_utc` };
  }

  if (regime === "CHOP" || regime === "RANGE") {
    return { action: "NO_TRADE", side: null, phase, reason: `regime_${regime.toLowerCase()}` };
  }

  // Thresholds calibrated for the statistical base-rate model (max modelUp ≈ 0.65).
  // Old TA model used 0.20 for LATE but that required modelUp ≥ 0.84 to pass — impossible
  // with calibrated rates. 0.08 matches realistic edge from a 57-63% historical base rate.
  const threshold = phase === "EARLY" ? 0.05 : phase === "MID" ? 0.08 : 0.08;

  const minProb = phase === "EARLY" ? 0.52 : phase === "MID" ? 0.54 : 0.54;

  if (edgeUp === null || edgeDown === null) {
    return { action: "NO_TRADE", side: null, phase, reason: "missing_market_data" };
  }

  const bestSide = edgeUp > edgeDown ? "UP" : "DOWN";
  const bestEdge = bestSide === "UP" ? edgeUp : edgeDown;
  const bestModel = bestSide === "UP" ? modelUp : modelDown;
  const bestSpread = bestSide === "UP" ? spreadUp : spreadDown;

  // Note: macro trend gate removed — the calibrated model already incorporates macro as an
  // input dimension. Blocking DOWN when macro=UP defeats the calibration (which may have
  // significant DOWN edge even in UP macro regimes, e.g. overbought + above VWAP at 16h UTC).

  if (bestSpread !== null && Number.isFinite(Number(bestSpread)) && Number(bestSpread) > maxSpread) {
    return { action: "NO_TRADE", side: null, phase, reason: `spread_acima_do_maximo_${maxSpread}` };
  }

  // Economic edge floor: a trade must clear fees + half-spread + a safety margin,
  // not just the static phase threshold. Breakeven prob when buying at price q with
  // taker fee rate r is q*(1 + r*(1-q)), so the fee alone costs q*r*(1-q) of edge.
  const marketProb = bestModel !== null && Number.isFinite(Number(bestModel))
    ? clamp(Number(bestModel) - bestEdge, 0.01, 0.99)
    : 0.5;
  const feeEdge = marketProb * FEE_RATE * (1 - marketProb);
  const halfSpread = bestSpread !== null && Number.isFinite(Number(bestSpread)) ? Number(bestSpread) / 2 : 0;
  const economicMin = feeEdge + halfSpread + EDGE_SAFETY_MARGIN;
  const effectiveThreshold = Math.max(threshold, economicMin);

  if (bestEdge < effectiveThreshold) {
    return { action: "NO_TRADE", side: null, phase, reason: `edge_below_${effectiveThreshold.toFixed(3)}` };
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
