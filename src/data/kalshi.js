import crypto from "node:crypto";
import fs from "node:fs";

const BASE_URL = process.env.KALSHI_DEMO === "true"
  ? "https://external-api.demo.kalshi.co/trade-api/v2"
  : "https://api.kalshi.com/trade-api/v2";

function loadPrivateKey() {
  const keyPath = process.env.KALSHI_PRIVATE_KEY_PATH;
  const keyInline = process.env.KALSHI_PRIVATE_KEY;
  if (keyInline) return keyInline.replace(/\\n/g, "\n");
  if (keyPath) return fs.readFileSync(keyPath, "utf8");
  return null;
}

function kalshiHeaders(method, path) {
  const apiKeyId = process.env.KALSHI_API_KEY_ID;
  const privateKey = loadPrivateKey();

  if (!apiKeyId || !privateKey) {
    throw new Error("KALSHI_API_KEY_ID e KALSHI_PRIVATE_KEY (ou KALSHI_PRIVATE_KEY_PATH) são obrigatórios");
  }

  const timestampMs = Date.now().toString();
  const message = timestampMs + method.toUpperCase() + path;

  const signature = crypto.sign(null, Buffer.from(message), {
    key: privateKey,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: 32
  }).toString("base64");

  return {
    "Content-Type": "application/json",
    "KALSHI-ACCESS-KEY": apiKeyId,
    "KALSHI-ACCESS-SIGNATURE": signature,
    "KALSHI-ACCESS-TIMESTAMP": timestampMs
  };
}

async function kalshiGet(path) {
  const headers = kalshiHeaders("GET", path);
  const res = await fetch(`${BASE_URL}${path}`, { headers });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Kalshi API ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

// Returns the most recently opened market for a given series (e.g. KXBTC15M)
export async function fetchKalshiActiveMarket(seriesTicker) {
  const path = `/markets?series_ticker=${seriesTicker}&status=active&limit=10`;
  const data = await kalshiGet(path);
  const markets = data.markets ?? [];
  if (markets.length === 0) return null;

  // sort by close_time ascending, pick the one closing soonest that's still open
  markets.sort((a, b) => new Date(a.close_time) - new Date(b.close_time));
  const now = Date.now();
  const active = markets.find(m => new Date(m.close_time).getTime() > now);
  return active ?? markets[0];
}

// Returns a normalized snapshot compatible with the scoring engine
// { ok, market, prices: { yes, no }, ticker, endTime }
export async function fetchKalshiSnapshot(seriesTicker) {
  try {
    const market = await fetchKalshiActiveMarket(seriesTicker);
    if (!market) return { ok: false, reason: "no_active_market" };

    const yesBuy  = parseFloat(market.yes_ask_dollars)  || null;
    const noBuy   = parseFloat(market.no_ask_dollars)   || null;
    const yesBid  = parseFloat(market.yes_bid_dollars)  || null;
    const noBid   = parseFloat(market.no_bid_dollars)   || null;

    const closeTime = market.close_time ? new Date(market.close_time).getTime() : null;
    const openTime  = market.open_time  ? new Date(market.open_time).getTime()  : null;

    return {
      ok: true,
      market,
      ticker: market.ticker,
      seriesTicker,
      prices: {
        yes: yesBuy,
        no:  noBuy,
        yesBid,
        noBid
      },
      endTime:   closeTime,
      startTime: openTime
    };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

// Map Kalshi series to the equivalent Binance symbol for price data
export function kalshiToBinanceSymbol(seriesTicker) {
  if (seriesTicker.startsWith("KXBTC"))  return "BTCUSDT";
  if (seriesTicker.startsWith("KXETH"))  return "ETHUSDT";
  if (seriesTicker.startsWith("KXSOL"))  return "SOLUSDT";
  if (seriesTicker.startsWith("KXXRP"))  return "XRPUSDT";
  if (seriesTicker.startsWith("KXBNB"))  return "BNBUSDT";
  return "BTCUSDT";
}
