import { kalshiPost } from "../data/kalshi.js";

const ORDERS_PATH = "/trade-api/v2/portfolio/orders";

export function dollarsToCents(dollars) {
  const cents = Math.ceil(Number(dollars) * 100);
  return Math.max(1, Math.min(99, cents));
}

function num(value) {
  return value == null ? null : Number(value);
}

export async function placeFokBuy({ ticker, side, count, limitPriceCents, clientOrderId }) {
  const body = {
    ticker,
    action: "buy",
    side,
    count,
    time_in_force: "fill_or_kill",
    ...(side === "yes" ? { yes_price: limitPriceCents } : { no_price: limitPriceCents }),
    ...(clientOrderId ? { client_order_id: clientOrderId } : {})
  };

  const raw = await kalshiPost(ORDERS_PATH, body);
  const order = raw?.order ?? {};
  const fillCount = order.fill_count_fp != null
    ? Math.floor(Number(order.fill_count_fp))
    : order.fill_count != null ? Number(order.fill_count) : 0;

  return {
    raw,
    orderId: order.order_id ?? order.client_order_id ?? null,
    fillCount,
    filled: fillCount >= count,
    fillCostDollars: num(order.taker_fill_cost_dollars),
    feesDollars: num(order.taker_fees_dollars)
  };
}
