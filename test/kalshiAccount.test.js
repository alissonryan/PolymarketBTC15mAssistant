import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

const realFetch = globalThis.fetch;
const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs1", format: "pem" });

beforeEach(() => {
  process.env.KALSHI_DEMO = "true";
  process.env.KALSHI_DEMO_API_KEY_ID = "d";
  process.env.KALSHI_DEMO_PRIVATE_KEY = pem.replace(/\n/g, "\\n");
});
afterEach(() => { globalThis.fetch = realFetch; });

function stub(jsonByPath) {
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    const path = u.pathname + (u.search || "");
    const key = Object.keys(jsonByPath).find(k => path.includes(k));
    const body = jsonByPath[key] ?? {};
    return { ok: true, status: 200, json: async () => body, text: async () => "" };
  };
}

test("getBalanceDollars prefers balance_dollars", async () => {
  const { getBalanceDollars } = await import("../src/execution/kalshiAccount.js");
  stub({ "/portfolio/balance": { balance: 5000, balance_dollars: "50.0000" } });
  assert.equal(await getBalanceDollars(), 50);
});

test("getSettlement returns the matching market's realized revenue", async () => {
  const { getSettlement } = await import("../src/execution/kalshiAccount.js");
  stub({
    "/portfolio/settlements": {
      settlements: [
        { ticker: "KXBTC15M-A", market_result: "yes", revenue: 800, yes_count: 8, no_count: 0 },
        { ticker: "KXBTC15M-B", market_result: "no", revenue: 0, yes_count: 5, no_count: 0 }
      ]
    }
  });
  const s = await getSettlement("KXBTC15M-A");
  assert.equal(s.settledResult, "yes");
  assert.equal(s.revenueDollars, 8);
  assert.equal(s.yesCount, 8);
});
