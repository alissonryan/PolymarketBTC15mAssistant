import assert from "node:assert/strict";
import test from "node:test";
import { MENU_OPTIONS, buildRunnerEnv, findMenuOption } from "../src/cli.js";

test("menu exposes paper-first Polymarket and Kalshi choices", () => {
  const labels = MENU_OPTIONS.map((option) => option.label);

  assert.deepEqual(labels, [
    "Polymarket BTC 5m",
    "Polymarket BTC 15m",
    "Kalshi BTC 15m",
    "Kalshi ETH 15m",
    "Kalshi SOL 15m",
    "Analyze paper results",
    "Run tests"
  ]);
});

test("Polymarket 5m menu option forces paper mode and 5 minute window", () => {
  const option = findMenuOption("1");
  const env = buildRunnerEnv(option, { EXECUTE_ORDERS: "true", PAPER_TRADING: "false" });

  assert.equal(env.EXECUTE_ORDERS, "false");
  assert.equal(env.PAPER_TRADING, "true");
  assert.equal(env.CANDLE_WINDOW_MINUTES, "5");
});

test("Kalshi ETH menu option sets series and isolated paper log prefix", () => {
  const option = findMenuOption("4");
  const env = buildRunnerEnv(option, {});

  assert.equal(env.EXECUTE_ORDERS, "false");
  assert.equal(env.PAPER_TRADING, "true");
  assert.equal(env.KALSHI_SERIES, "KXETH15M");
  assert.equal(env.PAPER_LOG_PREFIX, "kalshi_eth_");
});
