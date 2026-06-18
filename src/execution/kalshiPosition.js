import fs from "node:fs";
import path from "node:path";

const PREFIX = process.env.PAPER_LOG_PREFIX || "";
const FILE = path.join(process.cwd(), "logs", `${PREFIX}kalshi_real_position.json`);

const EMPTY = {
  open: false,
  side: null,
  ticker: null,
  orderId: null,
  count: null,
  entryPriceDollars: null,
  feeDollars: 0,
  marketSlug: null,
  priceToBeat: null,
  enteredAt: null,
  balanceBefore: null
};

function load() {
  try {
    if (fs.existsSync(FILE)) return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return { ...EMPTY };
  }
  return { ...EMPTY };
}

function save(state) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(state, null, 2), "utf8");
}

let _state = load();

export function hasOpenPosition() { return _state.open === true; }
export function getPosition() { return { ..._state }; }

export function openPosition({
  side, ticker, orderId, count, entryPriceDollars, feeDollars, marketSlug, priceToBeat, balanceBefore
}) {
  _state = {
    open: true,
    side,
    ticker,
    orderId,
    count,
    entryPriceDollars: entryPriceDollars ?? null,
    feeDollars: feeDollars ?? 0,
    marketSlug: marketSlug ?? null,
    priceToBeat: priceToBeat ?? null,
    enteredAt: new Date().toISOString(),
    balanceBefore: balanceBefore ?? null
  };
  save(_state);
}

export function closePosition() {
  _state = { ...EMPTY };
  save(_state);
}
