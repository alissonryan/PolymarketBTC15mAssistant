export function createCooldownTracker() {
  const lastEntryAtBySide = { UP: 0, DOWN: 0 };
  const lastLossAtBySide = { UP: 0, DOWN: 0 };

  function check(side, nowMs = Date.now()) {
    const reentryMin = Number(process.env.RISK_SAME_SIDE_REENTRY_MIN ?? 30);
    const lossCooldownMin = Number(process.env.RISK_LOSS_COOLDOWN_MIN ?? 60);

    const sinceEntryMin = (nowMs - (lastEntryAtBySide[side] ?? 0)) / 60_000;
    if (reentryMin > 0 && sinceEntryMin < reentryMin) {
      return { allowed: false, reason: `cooldown_same_side_${Math.ceil(reentryMin - sinceEntryMin)}min` };
    }

    const sinceLossMin = (nowMs - (lastLossAtBySide[side] ?? 0)) / 60_000;
    if (lossCooldownMin > 0 && sinceLossMin < lossCooldownMin) {
      return { allowed: false, reason: `cooldown_after_loss_${Math.ceil(lossCooldownMin - sinceLossMin)}min` };
    }

    return { allowed: true };
  }

  function recordEntry(side, nowMs = Date.now()) { lastEntryAtBySide[side] = nowMs; }
  function recordLoss(side, nowMs = Date.now()) { lastLossAtBySide[side] = nowMs; }

  return { check, recordEntry, recordLoss };
}
