import WebSocket from "ws";
import { CONFIG } from "../config.js";
import { wsAgentForUrl } from "../net/proxy.js";

function toNumber(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function buildWsUrl(symbol) {
  const s = String(symbol || "").toLowerCase();
  return `wss://stream.binance.com:9443/ws/${s}@trade`;
}

export function startBinanceTradeStream({ symbol = CONFIG.symbol, onUpdate } = {}) {
  let ws = null;
  let closed = false;
  let reconnectMs = 500;
  let lastPrice = null;
  let lastTs = null;
  let lastTrade = null;

  const connect = () => {
    if (closed) return;

    const url = buildWsUrl(symbol);
    ws = new WebSocket(url, { agent: wsAgentForUrl(url) });

    ws.on("open", () => {
      reconnectMs = 500;
    });

    ws.on("message", (buf) => {
      try {
        const msg = JSON.parse(buf.toString());
        const p = toNumber(msg.p);
        if (p === null) return;
        lastPrice = p;
        lastTs = Date.now();
        lastTrade = { p: msg.p, q: msg.q, m: msg.m, T: msg.T, price: p, ts: lastTs };
        if (typeof onUpdate === "function") onUpdate(lastTrade);
      } catch {
        return;
      }
    });

    const scheduleReconnect = () => {
      if (closed) return;
      try {
        ws?.terminate();
      } catch {
        // ignore
      }
      ws = null;
      const wait = reconnectMs;
      reconnectMs = Math.min(10_000, Math.floor(reconnectMs * 1.5));
      setTimeout(connect, wait);
    };

    ws.on("close", scheduleReconnect);
    ws.on("error", scheduleReconnect);
  };

  connect();

  return {
    getLast() {
      return lastTrade ?? { price: lastPrice, ts: lastTs };
    },
    close() {
      closed = true;
      try {
        ws?.close();
      } catch {
        // ignore
      }
      ws = null;
    }
  };
}
