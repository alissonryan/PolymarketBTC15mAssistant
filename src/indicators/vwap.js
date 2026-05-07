export function computeSessionVwap(candles) {
  if (!Array.isArray(candles) || candles.length === 0) return null;

  let pv = 0;
  let v = 0;
  for (const c of candles) {
    const tp = (c.high + c.low + c.close) / 3;
    pv += tp * c.volume;
    v += c.volume;
  }
  if (v === 0) return null;
  return pv / v;
}

export function computeVwapSeries(candles) {
  const series = [];
  let cumulativePV = 0;
  let cumulativeV = 0;
  for (const c of candles) {
    const tp = (c.high + c.low + c.close) / 3;
    cumulativePV += tp * c.volume;
    cumulativeV += c.volume;
    series.push(cumulativeV === 0 ? null : cumulativePV / cumulativeV);
  }
  return series;
}
