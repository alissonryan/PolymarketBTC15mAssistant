// Lock Strategy: when UP + DOWN tokens cost < $1, buying both guarantees profit.
// Only actionable in chop/range (no clear direction) by default.
export class LockStrategy {
  constructor(config = {}) {
    this.maxCostPerPair = config.maxCostPerPair ?? 0.99;
    this.minProfit = config.minProfit ?? 0.01;
    this.onlyInChop = config.onlyInChop !== false;
  }

  evaluate(upPrice, downPrice, regime) {
    if (!upPrice || !downPrice) {
      return { actionable: false, reason: "prices_unavailable" };
    }

    if (this.onlyInChop && regime !== "CHOP" && regime !== "RANGE") {
      return { actionable: false, reason: "not_in_chop", costPerPair: upPrice + downPrice };
    }

    const costPerPair = upPrice + downPrice;
    const profit = 1 - costPerPair;

    if (costPerPair >= this.maxCostPerPair) {
      return { actionable: false, reason: "cost_too_high", costPerPair, profit };
    }

    if (profit < this.minProfit) {
      return { actionable: false, reason: "profit_too_low", costPerPair, profit };
    }

    return {
      actionable: true,
      side: "BOTH",
      costPerPair,
      profit,
      roi: profit / costPerPair,
      guaranteed: true
    };
  }
}
