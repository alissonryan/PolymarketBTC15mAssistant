import { kalshiGet } from "../data/kalshi.js";

export async function getBalanceDollars() {
  const data = await kalshiGet("/trade-api/v2/portfolio/balance");
  if (data?.balance_dollars != null) return Number(data.balance_dollars);
  if (data?.balance != null) return Number(data.balance) / 100;
  return 0;
}

export async function getPosition(ticker) {
  const data = await kalshiGet(`/trade-api/v2/portfolio/positions?ticker=${encodeURIComponent(ticker)}`);
  const list = data?.market_positions ?? data?.positions ?? [];
  const match = list.find(p => p.ticker === ticker) ?? null;
  if (!match) return null;
  return {
    ticker,
    position: Number(match.position ?? 0),
    restingOrderCount: Number(match.resting_orders_count ?? 0)
  };
}

export async function getSettlement(ticker) {
  const data = await kalshiGet(`/trade-api/v2/portfolio/settlements?ticker=${encodeURIComponent(ticker)}`);
  const list = data?.settlements ?? [];
  const match = list.find(s => s.ticker === ticker) ?? null;
  if (!match) return null;
  return {
    ticker,
    settledResult: match.market_result ?? null,
    revenueDollars: match.revenue != null ? Number(match.revenue) / 100 : null,
    yesCount: Number(match.yes_count ?? 0),
    noCount: Number(match.no_count ?? 0)
  };
}
