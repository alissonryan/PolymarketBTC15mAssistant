/**
 * src/engines/calibratedRate.js
 *
 * Looks up historical UP/DOWN base rates from the pre-computed calibration table.
 * Run `node scripts/calibrate.js` first to generate scripts/calibration.json.
 *
 * Usage:
 *   import { lookupRate } from "./calibratedRate.js";
 *
 *   const { upRate, downRate, edge, n, hasEdge } = lookupRate({
 *     hour: 14,          // UTC hour 0-23
 *     macro: "UP",       // "UP" | "DOWN"  (1h EMA50 macro trend)
 *     priceVsVwap: "ABOVE", // "ABOVE" | "BELOW"  (intraday VWAP)
 *     rsiZone: "NEUTRAL",   // "OVERBOUGHT" | "OVERSOLD" | "NEUTRAL"
 *   });
 *
 *   // upRate   — historical probability BTC closes higher next 5m (0–1)
 *   // downRate — 1 - upRate
 *   // edge     — max(|upRate-0.5|, |downRate-0.5|) — magnitude of edge vs coin-flip
 *   // n        — sample count for this condition
 *   // hasEdge  — true if statistically significant and n >= 100
 */

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CALIBRATION_PATH = path.join(__dirname, "../../scripts/calibration.json");

const MIN_N = 100;

// ---------------------------------------------------------------------------
// Load calibration at module startup (synchronous — intentional)
// ---------------------------------------------------------------------------

/** @type {Map<string, {upRate: number, ci95: number, n: number}>} */
let calibrationMap = new Map();
let calibrationLoaded = false;

(function loadCalibration() {
  try {
    const raw = readFileSync(CALIBRATION_PATH, "utf8");
    const entries = JSON.parse(raw);
    if (!Array.isArray(entries)) {
      console.warn("[calibratedRate] calibration.json is not an array — falling back to 0.5/0.5");
      return;
    }
    for (const e of entries) {
      const key = makeKey(e.hour, e.macro, e.priceVsVwap, e.rsiZone);
      calibrationMap.set(key, { upRate: e.upRate, ci95: e.ci95, n: e.n });
    }
    calibrationLoaded = true;
    console.log(`[calibratedRate] Loaded ${calibrationMap.size} calibration entries from ${CALIBRATION_PATH}`);
  } catch (err) {
    if (err.code === "ENOENT") {
      console.warn(
        "[calibratedRate] calibration.json not found — run `node scripts/calibrate.js` to generate it. " +
        "All lookups will return 0.5/0.5 until then.",
      );
    } else {
      console.warn("[calibratedRate] Failed to load calibration.json:", err.message);
    }
  }
})();

// ---------------------------------------------------------------------------
// Key construction
// ---------------------------------------------------------------------------

function makeKey(hour, macro, priceVsVwap, rsiZone) {
  return `${hour}|${macro}|${priceVsVwap}|${rsiZone}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Look up historical base rates for the given market conditions.
 *
 * @param {object} conditions
 * @param {number} conditions.hour         - UTC hour (0-23)
 * @param {string} conditions.macro        - "UP" | "DOWN"
 * @param {string} conditions.priceVsVwap  - "ABOVE" | "BELOW"
 * @param {string} conditions.rsiZone      - "OVERBOUGHT" | "OVERSOLD" | "NEUTRAL"
 *
 * @returns {{ upRate: number, downRate: number, edge: number, n: number, hasEdge: boolean }}
 */
export function lookupRate({ hour, macro, priceVsVwap, rsiZone }) {
  const fallback = {
    upRate: 0.5,
    downRate: 0.5,
    edge: 0,
    n: 0,
    hasEdge: false,
    found: false,
  };

  if (!calibrationLoaded) return fallback;

  // Validate inputs
  if (
    !Number.isInteger(hour) ||
    hour < 0 ||
    hour > 23 ||
    (macro !== "UP" && macro !== "DOWN") ||
    (priceVsVwap !== "ABOVE" && priceVsVwap !== "BELOW") ||
    (rsiZone !== "OVERBOUGHT" && rsiZone !== "OVERSOLD" && rsiZone !== "NEUTRAL")
  ) {
    return fallback;
  }

  const key = makeKey(hour, macro, priceVsVwap, rsiZone);
  const entry = calibrationMap.get(key);

  if (!entry) return fallback;

  const { upRate, ci95, n } = entry;
  const downRate = 1 - upRate;
  // edge = how far upRate is from coin-flip on either side
  const edge = Math.abs(upRate - 0.5);
  const hasEdge = n >= MIN_N && edge > ci95;

  return {
    upRate,
    downRate,
    edge,
    ci95,
    n,
    hasEdge,
    found: true,
  };
}

/**
 * Returns true if the calibration table was successfully loaded.
 * Useful for health checks and startup logging.
 */
export function isCalibrationLoaded() {
  return calibrationLoaded;
}

/**
 * Returns the total number of condition buckets in the loaded calibration.
 */
export function calibrationSize() {
  return calibrationMap.size;
}
