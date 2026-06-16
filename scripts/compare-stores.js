import fs from "node:fs";
import path from "node:path";
import { createPaperStore } from "../src/execution/paperStore.js";

const DEFAULT_PREFIXES = ["poly_btc_5m_", "poly_btc_15m_", "kalshi_btc_"];

export function compareStores({ cwd = process.cwd(), prefixes = DEFAULT_PREFIXES } = {}) {
  const bots = [];
  let ok = true;
  for (const prefix of prefixes) {
    const tradesFile = path.join(cwd, "logs", `${prefix}paper_trades.json`);
    const jsonTrades = fs.existsSync(tradesFile)
      ? (JSON.parse(fs.readFileSync(tradesFile, "utf8")).trades ?? [])
      : [];
    const store = createPaperStore({ cwd, prefix, mode: "sqlite" });
    const sqliteCount = store.sqliteCount();
    store.close();
    const match = jsonTrades.length === sqliteCount;
    if (!match) ok = false;
    bots.push({ botId: prefix.replace(/_$/, ""), jsonCount: jsonTrades.length, sqliteCount, match });
  }
  return { ok, bots };
}

// CLI entry
if (import.meta.url === `file://${process.argv[1]}`) {
  const result = compareStores({});
  for (const b of result.bots) {
    console.log(`${b.match ? "✅" : "❌"} ${b.botId}: json=${b.jsonCount} sqlite=${b.sqliteCount}`);
  }
  process.exit(result.ok ? 0 : 1);
}
