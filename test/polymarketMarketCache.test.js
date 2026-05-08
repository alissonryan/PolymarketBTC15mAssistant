import assert from "node:assert/strict";
import test from "node:test";
import { isMarketLive } from "../src/data/polymarket.js";

test("isMarketLive rejects expired markets", () => {
  const market = {
    eventStartTime: "2026-05-08T10:00:00.000Z",
    endDate: "2026-05-08T10:05:00.000Z"
  };

  assert.equal(isMarketLive(market, Date.parse("2026-05-08T10:06:00.000Z")), false);
});

test("isMarketLive accepts currently open markets", () => {
  const market = {
    eventStartTime: "2026-05-08T10:00:00.000Z",
    endDate: "2026-05-08T10:05:00.000Z"
  };

  assert.equal(isMarketLive(market, Date.parse("2026-05-08T10:03:00.000Z")), true);
});
