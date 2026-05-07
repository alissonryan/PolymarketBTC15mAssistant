import { Side, OrderType } from "@polymarket/clob-client";

const SLIPPAGE_CENTS = 0.03;

async function getTickSize(client, tokenId) {
  try {
    const ts = await client.getTickSize(tokenId);
    return String(ts ?? "0.01");
  } catch {
    return "0.01";
  }
}

function roundToTick(price, tickSizeStr) {
  const tick = Number(tickSizeStr);
  return Math.round(price / tick) * tick;
}

function parseOrderId(resp) {
  return resp?.orderID ?? resp?.order_id ?? resp?.id ?? null;
}

function parseStatus(resp) {
  return String(resp?.status ?? resp?.orderStatus ?? "").toLowerCase();
}

// Compra a mercado (FOK = Fill or Kill: preenche tudo ou cancela)
// usdcAmount = quantos USDC gastar
// priceLimit = preço máximo que aceita pagar (slippage control)
export async function placeFokBuy(client, { tokenId, usdcAmount, currentPrice }) {
  const tickSize = await getTickSize(client, tokenId);
  const priceLimit = roundToTick(
    Math.min(0.97, (currentPrice ?? 0.5) + SLIPPAGE_CENTS),
    tickSize
  );

  const resp = await client.createAndPostMarketOrder(
    {
      tokenID: tokenId,
      amount: usdcAmount,
      side: Side.BUY,
      price: priceLimit,
      orderType: OrderType.FOK
    },
    { tickSize },
    OrderType.FOK
  );

  return {
    raw: resp,
    orderId: parseOrderId(resp),
    status: parseStatus(resp),
    filled: parseStatus(resp) === "matched"
  };
}

// Compra com ordem limitada (GTC = Good Till Cancelled: fica no book até preencher)
// price = preço exato em USDC por share (ex: 0.65)
// size = quantidade de shares
export async function placeGtcBuy(client, { tokenId, price, size }) {
  const tickSize = await getTickSize(client, tokenId);
  const roundedPrice = roundToTick(price, tickSize);

  const resp = await client.createAndPostOrder(
    {
      tokenID: tokenId,
      price: roundedPrice,
      size,
      side: Side.BUY
    },
    { tickSize, negRisk: false },
    OrderType.GTC
  );

  return {
    raw: resp,
    orderId: parseOrderId(resp),
    status: parseStatus(resp)
  };
}

export async function cancelOrder(client, orderId) {
  return await client.cancelOrder({ orderID: orderId });
}

export async function cancelAllOrders(client) {
  return await client.cancelAll();
}

export async function getOpenOrders(client, tokenId = null) {
  const params = tokenId ? { asset_id: tokenId } : {};
  return await client.getOpenOrders(params);
}

export async function getOrderStatus(client, orderId) {
  try {
    return await client.getOrder(orderId);
  } catch {
    return null;
  }
}
