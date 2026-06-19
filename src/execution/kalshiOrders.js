import { kalshiPost } from "../data/kalshi.js";

const ORDERS_PATH = "/trade-api/v2/portfolio/events/orders";

export function dollarsToCents(dollars) {
  const cents = Math.ceil(Number(dollars) * 100);
  return Math.max(1, Math.min(99, cents));
}

function num(value) {
  return value == null ? null : Number(value);
}

function formatPrice(dollars) {
  const n = Number(dollars);
  const clamped = Math.max(0.01, Math.min(0.99, n));
  return clamped.toFixed(4);
}

function formatCount(count) {
  return Number(count).toFixed(2);
}

export async function placeFokBuy({ ticker, direction, askDollars, count, clientOrderId, timeInForce = "fill_or_kill" }) {
  const side = direction === "UP" ? "bid" : "ask";
  const priceDollars = direction === "UP" ? Number(askDollars) : 1 - Number(askDollars);
  const body = {
    ticker,
    side,
    count: formatCount(count),
    price: formatPrice(priceDollars),
    time_in_force: timeInForce,
    self_trade_prevention_type: "taker_at_cross",
    ...(clientOrderId ? { client_order_id: clientOrderId } : {})
  };

  const raw = await kalshiPost(ORDERS_PATH, body);
  const fillCount = Math.floor(Number(raw?.fill_count ?? "0"));

  return {
    raw,
    httpStatus: raw?.__httpStatus ?? null,
    orderId: raw?.order_id ?? raw?.client_order_id ?? null,
    fillCount,
    filled: fillCount >= count,
    avgFillPriceDollars: num(raw?.average_fill_price),
    avgFeeDollars: num(raw?.average_fee_paid)
  };
}
