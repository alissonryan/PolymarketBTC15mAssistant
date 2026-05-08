import fs from "node:fs";
import path from "node:path";

const DAILY_FILE = path.join(process.cwd(), "logs", "daily_pnl.json");

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function loadDaily() {
  try {
    if (fs.existsSync(DAILY_FILE)) {
      const data = JSON.parse(fs.readFileSync(DAILY_FILE, "utf8"));
      if (data.date === todayKey()) return data;
    }
  } catch {
    // ignore
  }
  return { date: todayKey(), realizedPnl: 0, tradeCount: 0, wins: 0, losses: 0 };
}

function saveDaily(data) {
  fs.mkdirSync(path.dirname(DAILY_FILE), { recursive: true });
  fs.writeFileSync(DAILY_FILE, JSON.stringify(data, null, 2), "utf8");
}

export function getDailyStats() {
  return loadDaily();
}

export function recordTrade({ pnl }) {
  const daily = loadDaily();
  daily.realizedPnl = parseFloat((daily.realizedPnl + pnl).toFixed(4));
  daily.tradeCount += 1;
  if (pnl > 0) daily.wins += 1;
  else daily.losses += 1;
  saveDaily(daily);
  return daily;
}

export function isCircuitBreakerTripped() {
  const maxLoss = Math.abs(Number(process.env.RISK_MAX_DAILY_LOSS_USDC ?? 25));
  const daily = loadDaily();
  return daily.realizedPnl <= -maxLoss;
}

export function canTrade({ openPositions = 0, edgeBest = 0, tokenPrice = null }) {
  const minEdge = Number(process.env.RISK_MIN_EDGE ?? 0.15);
  const maxOpen = Number(process.env.RISK_MAX_OPEN_POSITIONS ?? 1);
  const orderSize = Number(process.env.RISK_ORDER_SIZE_USDC ?? 5);
  const minTokenPrice = Number(process.env.RISK_MIN_TOKEN_PRICE ?? 0.30);
  const sessionStartUTC = Number(process.env.RISK_SESSION_START_UTC ?? 8);
  const sessionEndUTC   = Number(process.env.RISK_SESSION_END_UTC   ?? 23);

  if (isCircuitBreakerTripped()) {
    return { allowed: false, reason: "circuit_breaker_perda_diaria_maxima" };
  }

  const utcHour = new Date().getUTCHours();
  if (utcHour < sessionStartUTC || utcHour >= sessionEndUTC) {
    return { allowed: false, reason: `sessao_bloqueada_fora_janela_${sessionStartUTC}h-${sessionEndUTC}h_utc` };
  }

  if (openPositions >= maxOpen) {
    return { allowed: false, reason: `max_posicoes_abertas_${maxOpen}` };
  }

  if (edgeBest < minEdge) {
    return { allowed: false, reason: `edge_abaixo_do_minimo_${minEdge}` };
  }

  if (tokenPrice !== null && tokenPrice < minTokenPrice) {
    return { allowed: false, reason: `token_price_abaixo_do_minimo_${minTokenPrice}` };
  }

  return { allowed: true, orderSize };
}
