import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

test("index-kalshi wires real execution behind EXECUTE_ORDERS status", () => {
  const src = fs.readFileSync(path.join(process.cwd(), "src", "index-kalshi.js"), "utf8");
  assert.match(src, /from "\.\/execution\/kalshiBot\.js"/);
  assert.match(src, /await onKalshiSignal/);
  assert.match(src, /getKalshiBotStatus\(\)\.executeOrders/);
  assert.match(src, /await emergencyShutdown\(\)/);
});
