import fs from "node:fs";
import path from "node:path";

const file = process.argv[2] ?? path.join(process.cwd(), "logs", `${process.env.PAPER_LOG_PREFIX ?? ""}paper_trades.json`);

function readTrades(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Arquivo nao encontrado: ${filePath}`);
  }
  const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
  return Array.isArray(data.trades) ? data.trades : [];
}

function sessionUtc(iso) {
  const h = new Date(iso).getUTCHours();
  if (h >= 0 && h < 8) return "Asia";
  if (h >= 8 && h < 13) return "Europe";
  if (h >= 13 && h < 16) return "Europe/US";
  if (h >= 16 && h < 22) return "US";
  return "Off-hours";
}

function timeBucket(mins) {
  const n = Number(mins);
  if (!Number.isFinite(n)) return "unknown";
  if (n > 10) return ">10m";
  if (n > 5) return "5-10m";
  if (n > 2) return "2-5m";
  return "0-2m";
}

function edgeBucket(edge) {
  const n = Number(edge);
  if (!Number.isFinite(n)) return "unknown";
  if (n < 0.15) return "<0.15";
  if (n < 0.25) return "0.15-0.25";
  if (n < 0.35) return "0.25-0.35";
  return ">=0.35";
}

function spreadBucket(spread) {
  const n = Number(spread);
  if (!Number.isFinite(n)) return "unknown";
  if (n <= 0.01) return "<=1c";
  if (n <= 0.03) return "1-3c";
  if (n <= 0.05) return "3-5c";
  return ">5c";
}

function summarize(trades) {
  const totalTrades = trades.length;
  const wins = trades.filter((t) => t.won).length;
  const totalPnl = Number(trades.reduce((acc, t) => acc + Number(t.pnl ?? 0), 0).toFixed(4));
  const grossPnl = Number(trades.reduce((acc, t) => acc + Number(t.grossPnl ?? t.pnl ?? 0), 0).toFixed(4));
  const fees = Number(trades.reduce((acc, t) => acc + Number(t.feeAtEntry ?? 0), 0).toFixed(5));
  const totalRisked = trades.reduce((acc, t) => acc + Number(t.usdcAmount ?? 0), 0);

  return {
    trades: totalTrades,
    wins,
    losses: totalTrades - wins,
    winRate: totalTrades ? Number(((wins / totalTrades) * 100).toFixed(1)) : null,
    grossPnl,
    fees,
    netPnl: totalPnl,
    avgPnl: totalTrades ? Number((totalPnl / totalTrades).toFixed(4)) : null,
    roi: totalRisked ? Number(((totalPnl / totalRisked) * 100).toFixed(2)) : null
  };
}

function groupBy(trades, label, fn) {
  const groups = new Map();
  for (const trade of trades) {
    const key = fn(trade);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(trade);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => String(a).localeCompare(String(b)))
    .map(([bucket, rows]) => ({ [label]: bucket, ...summarize(rows) }));
}

const trades = readTrades(file);
console.log(`Paper trades: ${file}`);
console.table([summarize(trades)]);

if (trades.length > 0) {
  console.log("\nPor lado");
  console.table(groupBy(trades, "side", (t) => t.side ?? "unknown"));
  console.log("\nPor sessao UTC");
  console.table(groupBy(trades, "session", (t) => sessionUtc(t.enteredAt)));
  console.log("\nPor tempo restante");
  console.table(groupBy(trades, "timeLeft", (t) => timeBucket(t.entryTimeLeftMin)));
  console.log("\nPor edge");
  console.table(groupBy(trades, "edge", (t) => edgeBucket(t.edgeAtEntry)));
  console.log("\nPor spread");
  console.table(groupBy(trades, "spread", (t) => spreadBucket(t.spreadAtEntry)));
}
