import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

let calls;
const realFetch = globalThis.fetch;
const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs1", format: "pem" });

beforeEach(() => {
  calls = [];
  process.env.KALSHI_DEMO = "true";
  process.env.KALSHI_DEMO_API_KEY_ID = "demo";
  process.env.KALSHI_DEMO_PRIVATE_KEY = pem.replace(/\n/g, "\\n");
});
afterEach(() => { globalThis.fetch = realFetch; });

function stubFetch(status, jsonBody) {
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts, body: JSON.parse(opts.body) });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => jsonBody,
      text: async () => JSON.stringify(jsonBody)
    };
  };
}

test("dollarsToCents ceils and clamps", async () => {
  const { dollarsToCents } = await import("../src/execution/kalshiOrders.js");
  assert.equal(dollarsToCents(0.601), 61);
  assert.equal(dollarsToCents(0.005), 1);
  assert.equal(dollarsToCents(0.999), 99);
});

test("placeFokBuy posts a FOK yes order and reports a full fill", async () => {
  const { placeFokBuy } = await import("../src/execution/kalshiOrders.js");
  stubFetch(201, {
    order: {
      order_id: "ord1",
      fill_count_fp: "8.00",
      taker_fill_cost_dollars: "4.8000",
      taker_fees_dollars: "0.1200"
    }
  });

  const r = await placeFokBuy({
    ticker: "KXBTC15M-X", side: "yes", count: 8,
    limitPriceCents: 61, clientOrderId: "c1"
  });

  const body = calls[0].body;
  assert.equal(body.ticker, "KXBTC15M-X");
  assert.equal(body.action, "buy");
  assert.equal(body.side, "yes");
  assert.equal(body.count, 8);
  assert.equal(body.yes_price, 61);
  assert.equal(body.time_in_force, "fill_or_kill");
  assert.equal(body.client_order_id, "c1");
  assert.equal(r.orderId, "ord1");
  assert.equal(r.fillCount, 8);
  assert.equal(r.filled, true);
  assert.equal(r.fillCostDollars, 4.8);
  assert.equal(r.feesDollars, 0.12);
});

test("placeFokBuy reports not-filled on a partial/zero fill", async () => {
  const { placeFokBuy } = await import("../src/execution/kalshiOrders.js");
  stubFetch(201, { order: { order_id: "ord2", fill_count_fp: "0.00" } });
  const r = await placeFokBuy({ ticker: "T", side: "no", count: 5, limitPriceCents: 40 });
  assert.equal(calls[0].body.no_price, 40);
  assert.equal(r.filled, false);
  assert.equal(r.fillCount, 0);
});
