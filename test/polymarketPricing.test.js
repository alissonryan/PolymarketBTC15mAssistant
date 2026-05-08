import assert from "node:assert/strict";
import test from "node:test";
import { getExecutableBuyPrice, summarizeOrderBook } from "../src/data/polymarket.js";

test("summarizeOrderBook identifies best bid, best ask, and spread", () => {
  const summary = summarizeOrderBook({
    bids: [{ price: "0.43", size: "10" }, { price: "0.45", size: "5" }],
    asks: [{ price: "0.53", size: "6" }, { price: "0.51", size: "4" }]
  });

  assert.equal(summary.bestBid, 0.45);
  assert.equal(summary.bestAsk, 0.51);
  assert.equal(summary.spread, 0.06);
});

test("getExecutableBuyPrice uses ask before bid or gamma fallback", () => {
  assert.equal(getExecutableBuyPrice({ bestAsk: 0.52, bestBid: 0.48 }, 0.5), 0.52);
  assert.equal(getExecutableBuyPrice({ bestAsk: null, bestBid: 0.48 }, 0.5), 0.5);
});
