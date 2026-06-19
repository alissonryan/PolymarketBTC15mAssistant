import crypto from "node:crypto";
import fs from "node:fs";

const API_PREFIX = "/trade-api/v2";
const BASE_URL = process.env.KALSHI_DEMO === "true"
  ? "https://external-api.demo.kalshi.co"
  : "https://external-api.kalshi.com";

function loadPrivateKey() {
  const useDemo = process.env.KALSHI_DEMO === "true";
  const keyInline = useDemo
    ? (process.env.KALSHI_DEMO_PRIVATE_KEY ?? process.env.KALSHI_PRIVATE_KEY)
    : process.env.KALSHI_PRIVATE_KEY;
  const keyPath = useDemo
    ? (process.env.KALSHI_DEMO_PRIVATE_KEY_PATH ?? process.env.KALSHI_PRIVATE_KEY_PATH)
    : process.env.KALSHI_PRIVATE_KEY_PATH;
  if (keyInline) return keyInline.replace(/\\n/g, "\n");
  if (keyPath) return fs.readFileSync(keyPath, "utf8");
  return null;
}

function apiKeyId() {
  return process.env.KALSHI_DEMO === "true"
    ? (process.env.KALSHI_DEMO_API_KEY_ID ?? process.env.KALSHI_API_KEY_ID)
    : process.env.KALSHI_API_KEY_ID;
}

function apiPath(path) {
  return path.startsWith(API_PREFIX) ? path : `${API_PREFIX}${path.startsWith("/") ? "" : "/"}${path}`;
}

export function kalshiSignedHeaders(method, path) {
  const keyId = apiKeyId();
  const privateKey = loadPrivateKey();

  if (!keyId || !privateKey) {
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
    "KALSHI-ACCESS-KEY": keyId,
    "KALSHI-ACCESS-SIGNATURE": signature,
    "KALSHI-ACCESS-TIMESTAMP": timestampMs
  };
}

const kalshiHeaders = kalshiSignedHeaders;

export function kalshiBaseUrl() { return BASE_URL; }

export async function kalshiGet(path) {
  const fullPath = apiPath(path);
  const headers = kalshiHeaders("GET", fullPath);
  const res = await fetch(`${BASE_URL}${fullPath}`, { headers });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Kalshi API ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

export async function kalshiPost(path, body) {
  const fullPath = apiPath(path);
  const res = await fetch(`${BASE_URL}${fullPath}`, {
    method: "POST",
    headers: kalshiHeaders("POST", fullPath),
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Kalshi API ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  if (data && typeof data === "object") {
    Object.defineProperty(data, "__httpStatus", { value: res.status, enumerable: false });
  }
  return data;
}

// Returns the most recently opened market for a given series (e.g. KXBTC15M)
export async function fetchKalshiActiveMarket(seriesTicker) {
  const path = `/markets?series_ticker=${seriesTicker}&status=open&limit=10`;
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

    // Kalshi returns prices as decimal strings in yes_ask_dollars / no_ask_dollars
    const yesBuy  = market.yes_ask_dollars != null ? parseFloat(market.yes_ask_dollars) : null;
    const noBuy   = market.no_ask_dollars  != null ? parseFloat(market.no_ask_dollars)  : null;
    const yesBid  = market.yes_bid_dollars != null ? parseFloat(market.yes_bid_dollars) : null;
    const noBid   = market.no_bid_dollars  != null ? parseFloat(market.no_bid_dollars)  : null;

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
      // floor_strike = preço de referência do CF Benchmarks no início da janela
      // equivalente ao priceToBeat na Polymarket
      floorStrike: market.floor_strike ?? null,
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
