import { test } from "node:test";
import assert from "node:assert/strict";
import { createCooldownTracker } from "../src/risk/cooldown.js";

test("allows entry when no prior activity", () => {
  const cd = createCooldownTracker();
  assert.equal(cd.check("UP").allowed, true);
});

test("blocks re-entry on same side within reentry window", () => {
  process.env.RISK_SAME_SIDE_REENTRY_MIN = "30";
  const cd = createCooldownTracker();
  const t0 = 1_000_000_000_000;
  cd.recordEntry("UP", t0);
  const r = cd.check("UP", t0 + 5 * 60_000);
  assert.equal(r.allowed, false);
  assert.match(r.reason, /cooldown_same_side/);
});

test("blocks same side after a loss within loss-cooldown window", () => {
  process.env.RISK_SAME_SIDE_REENTRY_MIN = "0";
  process.env.RISK_LOSS_COOLDOWN_MIN = "60";
  const cd = createCooldownTracker();
  const t0 = 1_000_000_000_000;
  cd.recordLoss("DOWN", t0);
  const r = cd.check("DOWN", t0 + 10 * 60_000);
  assert.equal(r.allowed, false);
  assert.match(r.reason, /cooldown_after_loss/);
});

test("other side is unaffected by a loss", () => {
  process.env.RISK_SAME_SIDE_REENTRY_MIN = "0";
  process.env.RISK_LOSS_COOLDOWN_MIN = "60";
  const cd = createCooldownTracker();
  const t0 = 1_000_000_000_000;
  cd.recordLoss("UP", t0);
  assert.equal(cd.check("DOWN", t0 + 1).allowed, true);
});
