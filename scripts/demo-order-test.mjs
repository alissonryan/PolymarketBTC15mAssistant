/**
 * scripts/demo-order-test.mjs
 *
 * One-off DEMO mechanics test: places a single 1-contract UP IOC order at 1¢ on
 * the current Kalshi BTC 15m demo market. At 1¢ it should not fill (nothing sells
 * that low), IOC auto-cancels → no position created, balance untouched. The point is
 * purely to prove the signed POST /portfolio/events/orders round-trips (auth + request
 * shape accepted by the API).
 *
 * SAFETY: demo money only. Refuses to run unless KALSHI_DEMO=true.
 * Run:  KALSHI_DEMO=true <node24> --env-file=.env scripts/demo-order-test.mjs
 */

import crypto from "node:crypto";
import { fetchKalshiSnapshot } from "../src/data/kalshi.js";
import { placeFokBuy } from "../src/execution/kalshiOrders.js";
import { getBalanceDollars, getPosition } from "../src/execution/kalshiAccount.js";

if ((process.env.KALSHI_DEMO ?? "").toLowerCase() !== "true") {
  if (process.env.NODE_TEST_CONTEXT) {
    console.log("SKIP: demo-order-test requer KALSHI_DEMO=true.");
    process.exit(0);
  }
  console.error("ABORTADO: este teste só roda com KALSHI_DEMO=true (segurança).");
  process.exit(1);
}

const log = (...a) => console.log(...a);

try {
  const balBefore = await getBalanceDollars();
  log(`Saldo demo ANTES: $${balBefore.toFixed(2)}`);

  const snap = await fetchKalshiSnapshot(process.env.KALSHI_SERIES || "KXBTC15M");
  if (!snap.ok) {
    log(`Sem mercado ativo (${snap.reason}) — não dá pra testar agora. Tente na sessão US.`);
    process.exit(0);
  }
  log(`Mercado: ${snap.ticker}`);

  const clientOrderId = crypto.randomUUID();
  log(`Enviando ordem IOC: 1x UP/YES bid @ $0.0100 (client_order_id=${clientOrderId})`);
  log("--- (a 1¢ não deve preencher; IOC cancela sozinho) ---");

  const res = await placeFokBuy({
    ticker: snap.ticker,
    direction: "UP",
    askDollars: 0.01,
    count: 1,
    clientOrderId,
    timeInForce: "immediate_or_cancel",
  });

  log("\n=== RESPOSTA DA API ===");
  log("httpStatus:", res.httpStatus);
  log("orderId:", res.orderId);
  log("filled:", res.filled, "| fillCount:", res.fillCount);
  log("raw:", JSON.stringify(res.raw));

  const balAfter = await getBalanceDollars();
  const pos = await getPosition(snap.ticker).catch(() => null);
  log("\n=== PÓS-TESTE ===");
  log(`Saldo demo DEPOIS: $${balAfter.toFixed(2)} (mudou? ${balBefore !== balAfter ? "SIM" : "não"})`);
  log(`Posição no ticker: ${pos ? JSON.stringify(pos) : "nenhuma"}`);

  log("\n=== VEREDITO ===");
  if (res.httpStatus !== 201 || res.filled || balBefore !== balAfter || pos) {
    log("FALHA: esperado HTTP 201, filled=false, saldo inalterado e nenhuma posição.");
    process.exit(2);
  }
  log("MECÂNICA OK: a API aceitou o POST assinado (auth + formato V2 corretos).");
} catch (e) {
  log("\n=== ERRO ===");
  log(e?.message ?? String(e));
  log("\nSe for 401/403 → problema de auth/chave demo. Se for 4xx de validação → formato do pedido. Cole isto aqui que eu diagnostico.");
  process.exit(2);
}
