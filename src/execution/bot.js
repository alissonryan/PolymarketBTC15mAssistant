import { initClient, getUsdcBalance, checkAllowances } from "./wallet.js";
import { placeFokBuy, cancelAllOrders } from "./orders.js";
import { hasOpenPosition, getPosition, openPosition, closePosition, estimatePnl, calcRealizedPnl } from "./position.js";
import { canTrade, recordTrade, getDailyStats, isCircuitBreakerTripped } from "../risk/guard.js";

const EXECUTE_ORDERS = (process.env.EXECUTE_ORDERS ?? "false").toLowerCase() === "true";

let _client = null;
let _wallet = null;
let _initialized = false;
let _initError = null;

// Inicializa carteira e cliente uma única vez
async function ensureInit() {
  if (_initialized) return !_initError;
  _initialized = true;
  try {
    const { client, wallet } = await initClient();
    _client = client;
    _wallet = wallet;
    await checkAllowances(wallet);
    console.log("[bot] Módulo de execução pronto");
    return true;
  } catch (err) {
    _initError = err.message;
    console.error(`[bot] Falha na inicialização: ${err.message}`);
    return false;
  }
}

// Chamado a cada tick do loop principal
// rec      = resultado do decide() { action, side, phase, strength, edge }
// poly     = snapshot da Polymarket { ok, tokens, prices, market }
// priceToBeat = preço de referência travado no início da janela
export async function onSignal({ rec, poly, priceToBeat, timeLeftMin }) {
  if (!EXECUTE_ORDERS) return { mode: "monitor" };

  const ready = await ensureInit();
  if (!ready) return { mode: "error", reason: _initError };

  // Detecta se posição anterior foi liquidada (mercado mudou)
  if (hasOpenPosition()) {
    const pos = getPosition();
    const marketSlugChanged = poly.ok && poly.market?.slug && pos.marketSlug && pos.marketSlug !== poly.market.slug;

    if (marketSlugChanged) {
      await _handleSettlement(pos);
    } else {
      // Posição ainda aberta — retorna status atual
      const side = pos.side === "UP" ? "up" : "down";
      const currentPrice = poly.ok ? poly.prices?.[side] : null;
      const unrealizedPnl = estimatePnl(currentPrice);
      return { mode: "holding", position: pos, unrealizedPnl };
    }
  }

  // Sem posição aberta — avalia se deve entrar
  if (rec.action !== "ENTER") {
    return { mode: "waiting", reason: rec.reason ?? rec.phase };
  }

  if (!poly.ok || !poly.tokens) {
    return { mode: "waiting", reason: "polymarket_unavailable" };
  }

  const edgeBest = rec.side === "UP" ? (rec.edge ?? 0) : (rec.edge ?? 0);
  const risk = canTrade({ openPositions: 0, edgeBest });

  if (!risk.allowed) {
    return { mode: "blocked", reason: risk.reason };
  }

  const tokenId = rec.side === "UP" ? poly.tokens.upTokenId : poly.tokens.downTokenId;
  const currentPrice = rec.side === "UP" ? poly.prices?.up : poly.prices?.down;

  if (!tokenId) {
    return { mode: "blocked", reason: "token_id_nao_encontrado" };
  }

  const balanceBefore = await getUsdcBalance(_client);

  let result;
  try {
    result = await placeFokBuy(_client, {
      tokenId,
      usdcAmount: risk.orderSize,
      currentPrice
    });
  } catch (err) {
    console.error(`[bot] Erro ao colocar ordem: ${err.message}`);
    return { mode: "error", reason: err.message };
  }

  if (!result.filled) {
    console.log(`[bot] Ordem FOK não preenchida (status: ${result.status})`);
    return { mode: "not_filled", orderId: result.orderId, status: result.status };
  }

  openPosition({
    side: rec.side,
    tokenId,
    orderId: result.orderId,
    usdcAmount: risk.orderSize,
    entryPrice: currentPrice,
    marketSlug: poly.market?.slug ?? null,
    priceToBeat,
    balanceBefore
  });

  console.log(`[bot] ✅ Posição aberta: ${rec.side} | $${risk.orderSize} USDC | preço: ${currentPrice} | orderId: ${result.orderId}`);

  return {
    mode: "entered",
    side: rec.side,
    usdcAmount: risk.orderSize,
    orderId: result.orderId,
    entryPrice: currentPrice
  };
}

async function _handleSettlement(pos) {
  try {
    const balanceAfter = await getUsdcBalance(_client);
    const pnl = calcRealizedPnl(balanceAfter) ?? 0;
    const won = pnl > 0;

    recordTrade({ pnl });

    const daily = getDailyStats();
    console.log(
      `[bot] 🏁 Posição liquidada: ${pos.side} | P&L: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} | ` +
      `Dia: ${daily.realizedPnl >= 0 ? "+" : ""}$${daily.realizedPnl.toFixed(2)} (${daily.wins}W/${daily.losses}L)`
    );

    closePosition();
  } catch (err) {
    console.error(`[bot] Erro ao processar liquidação: ${err.message}`);
    closePosition();
  }
}

// Cancela todas as ordens abertas e fecha posição (usar em emergência / Ctrl+C)
export async function emergencyShutdown() {
  if (!_client) return;
  try {
    await cancelAllOrders(_client);
    console.log("[bot] Todas as ordens canceladas");
  } catch (err) {
    console.error(`[bot] Erro ao cancelar ordens: ${err.message}`);
  }
  closePosition();
}

export function getBotStatus() {
  return {
    executeOrders: EXECUTE_ORDERS,
    initialized: _initialized,
    initError: _initError,
    hasPosition: hasOpenPosition(),
    position: hasOpenPosition() ? getPosition() : null,
    daily: getDailyStats(),
    circuitBreaker: isCircuitBreakerTripped()
  };
}
