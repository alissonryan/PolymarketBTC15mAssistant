export class CVDAnalyzer {
  constructor(options = {}) {
    this.resetInterval = options.resetInterval || "1h";
    this.deltaHistory = [];
    this.cvd = 0;
    this.lastPrice = null;
    this.lastReset = Date.now();
  }

  // trade = { p, q, m, T } — Binance wire format
  processTrade(trade) {
    const price = parseFloat(trade.p);
    const size = parseFloat(trade.q);
    if (!Number.isFinite(price) || !Number.isFinite(size)) return null;

    // m = true → buyer is maker → sell-initiated; m = false → buy-initiated
    let isBuy;
    if (trade.m !== undefined) {
      isBuy = !trade.m;
    } else if (this.lastPrice !== null) {
      isBuy = price >= this.lastPrice;
    } else {
      isBuy = true;
    }

    this.lastPrice = price;
    const delta = isBuy ? size : -size;
    this.cvd += delta;

    this.deltaHistory.push({
      timestamp: trade.T || Date.now(),
      price,
      size,
      delta,
      cvd: this.cvd,
      isBuy
    });

    if (this.deltaHistory.length > 240) this.deltaHistory.shift();
    this._checkReset();

    return { delta, cvd: this.cvd, isBuy };
  }

  detectDivergence(lookback = 20) {
    if (this.deltaHistory.length < lookback) return null;
    const recent = this.deltaHistory.slice(-lookback);
    const priceStart = recent[0].price;
    const priceEnd = recent[recent.length - 1].price;
    const cvdStart = recent[0].cvd;
    const cvdEnd = recent[recent.length - 1].cvd;
    const priceChangePct = (priceEnd - priceStart) / priceStart;
    const cvdChange = cvdEnd - cvdStart;
    const MIN_MOVE = 0.001;
    if (priceChangePct < -MIN_MOVE && cvdChange > 0) {
      return { type: "BULLISH", strength: Math.abs(cvdChange), priceChange: priceChangePct, cvdChange };
    }
    if (priceChangePct > MIN_MOVE && cvdChange < 0) {
      return { type: "BEARISH", strength: Math.abs(cvdChange), priceChange: priceChangePct, cvdChange };
    }
    return null;
  }

  detectAbsorption(flatThreshold = 0.0005, cvdThreshold = 10) {
    if (this.deltaHistory.length < 10) return null;
    const recent = this.deltaHistory.slice(-10);
    const priceStart = recent[0].price;
    const priceEnd = recent[recent.length - 1].price;
    const priceChangePct = Math.abs(priceEnd - priceStart) / priceStart;
    if (priceChangePct > flatThreshold) return null;
    const cvdChange = recent[recent.length - 1].cvd - recent[0].cvd;
    if (Math.abs(cvdChange) < cvdThreshold) return null;
    return {
      type: cvdChange > 0 ? "BULLISH_ABSORPTION" : "BEARISH_ABSORPTION",
      cvdChange,
      priceChangePct
    };
  }

  getCurrentState() {
    const recent = this.deltaHistory.slice(-20);
    if (recent.length === 0) return { cvd: 0, trend: "NEUTRAL", intensity: 0 };
    const avgDelta = recent.reduce((a, b) => a + b.delta, 0) / recent.length;
    const totalVolume = recent.reduce((a, b) => a + b.size, 0);
    return {
      cvd: this.cvd,
      trend: avgDelta > 0 ? "BUYING" : "SELLING",
      intensity: Math.abs(avgDelta),
      totalVolume,
      deltaRatio: totalVolume > 0 ? Math.abs(this.cvd) / totalVolume : 0
    };
  }

  _checkReset() {
    const now = Date.now();
    const hourMs = 60 * 60 * 1000;
    let shouldReset = false;
    if (this.resetInterval === "1h") shouldReset = now - this.lastReset > hourMs;
    else if (this.resetInterval === "4h") shouldReset = now - this.lastReset > 4 * hourMs;
    else if (this.resetInterval === "1d") shouldReset = new Date(now).getDate() !== new Date(this.lastReset).getDate();
    if (shouldReset) {
      this.cvd = 0;
      this.deltaHistory = [];
      this.lastReset = now;
    }
  }
}
