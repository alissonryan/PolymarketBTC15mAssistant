import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs1", format: "pem" });

test("POST signature is over timestamp+POST+path and verifies", async () => {
  process.env.KALSHI_DEMO = "true";
  process.env.KALSHI_DEMO_API_KEY_ID = "demo-key-id";
  process.env.KALSHI_DEMO_PRIVATE_KEY = pem.replace(/\n/g, "\\n");
  delete process.env.KALSHI_DEMO_PRIVATE_KEY_PATH;

  const { kalshiSignedHeaders } = await import("../src/data/kalshi.js");
  const path = "/trade-api/v2/portfolio/orders";
  const h = kalshiSignedHeaders("POST", path);

  assert.equal(h["KALSHI-ACCESS-KEY"], "demo-key-id");
  const msg = h["KALSHI-ACCESS-TIMESTAMP"] + "POST" + path;
  const ok = crypto.verify(
    null, Buffer.from(msg),
    { key: publicKey, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 },
    Buffer.from(h["KALSHI-ACCESS-SIGNATURE"], "base64")
  );
  assert.equal(ok, true);
});
