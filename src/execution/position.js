import fs from "node:fs";
import path from "node:path";

const POSITION_FILE = path.join(process.cwd(), "logs", "position.json");

const EMPTY_STATE = {
  open: false,
  side: null,         // "UP" | "DOWN"
  tokenId: null,
  orderId: null,
  usdcAmount: null,
  shares: null,
  entryPrice: null,
  marketSlug: null,
  priceToBeat: null,
  enteredAt: null,
  balanceBefore: null
};

function load() {
  try {
    if (fs.existsSync(POSITION_FILE)) {
      return JSON.parse(fs.readFileSync(POSITION_FILE, "utf8"));
    }
  } catch {
    return { ...EMPTY_STATE };
  }
  return { ...EMPTY_STATE };
}

function save(state) {
  fs.mkdirSync(path.dirname(POSITION_FILE), { recursive: true });
  fs.writeFileSync(POSITION_FILE, JSON.stringify(state, null, 2), "utf8");
}

let _state = load();

export function hasOpenPosition() {
  return _state.open === true;
}

export function getPosition() {
  return { ..._state };
}

export function openPosition({ side, tokenId, orderId, usdcAmount, entryPrice, marketSlug, priceToBeat, balanceBefore }) {
  const shares = entryPrice && entryPrice > 0 ? usdcAmount / entryPrice : null;
  _state = {
    open: true,
    side,
    tokenId,
    orderId,
    usdcAmount,
    shares,
    entryPrice: entryPrice ?? null,
    marketSlug: marketSlug ?? null,
    priceToBeat: priceToBeat ?? null,
    enteredAt: new Date().toISOString(),
    balanceBefore: balanceBefore ?? null
  };
  save(_state);
}

export function closePosition() {
  _state = { ...EMPTY_STATE };
  save(_state);
}

// Estima P&L com base no preço atual do mercado (mark-to-market, não realizado)
export function estimatePnl(currentMarketPrice) {
  if (!_state.open || _state.shares === null || currentMarketPrice === null) return null;
  const currentValue = _state.shares * currentMarketPrice;
  return currentValue - _state.usdcAmount;
}

// Calcula P&L realizado usando delta de saldo USDC
export function calcRealizedPnl(balanceAfter) {
  if (_state.balanceBefore === null || balanceAfter === null) return null;
  return balanceAfter - _state.balanceBefore;
}
