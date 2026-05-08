export function estimateTakerFee({ usdcAmount, entryPrice, feeRate = Number(process.env.RISK_TAKER_FEE_RATE ?? 0.07) }) {
  const amount = Number(usdcAmount);
  const price = Number(entryPrice);
  const rate = Number(feeRate);
  if (!Number.isFinite(amount) || !Number.isFinite(price) || !Number.isFinite(rate) || price <= 0 || rate <= 0) {
    return 0;
  }

  const shares = amount / price;
  return Number((shares * rate * price * (1 - price)).toFixed(5));
}
