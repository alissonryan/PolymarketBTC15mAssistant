export class TimePriceConvergence {
  constructor(config = {}) {
    this.minTimeRatio = config.minTimeRatio ?? 0.2;   // activate in last 20% of window
    this.baseThreshold = config.baseThreshold ?? 0.001; // 0.1% minimum price move
    this.multiplier = config.multiplier ?? 5;
  }

  // currentPrice = current BTC spot, openPrice = price at window start (priceToBeat)
  evaluate(currentPrice, openPrice, timeLeft, windowMinutes) {
    if (!currentPrice || !openPrice || !timeLeft || !windowMinutes) {
      return { inField: false };
    }

    const timeRatio = timeLeft / windowMinutes;
    if (timeRatio > this.minTimeRatio) return { inField: false };

    const priceDiff = Math.abs(currentPrice - openPrice) / openPrice;

    // dynamic threshold: less time → smaller move needed
    const requiredDiff = this.baseThreshold * (1 + this.multiplier * (1 - timeRatio));

    if (priceDiff < requiredDiff) return { inField: false };

    const direction = currentPrice > openPrice ? "UP" : "DOWN";

    // probability converges toward 1 as window closes with confirmed move
    const probability = Math.min(0.5 + (priceDiff / requiredDiff) * 0.5, 0.95);

    return {
      inField: true,
      direction,
      probability,
      priceDiff,
      timeRatio,
      requiredDiff,
      urgency: timeRatio < 0.1 ? "CRITICAL" : timeRatio < 0.15 ? "HIGH" : "MEDIUM"
    };
  }

  getScoreBoost(field) {
    if (!field?.inField) return { up: 0, down: 0 };
    const boost = field.probability > 0.8 ? 3 : field.probability > 0.7 ? 2 : 1;
    return field.direction === "UP" ? { up: boost, down: 0 } : { up: 0, down: boost };
  }
}
