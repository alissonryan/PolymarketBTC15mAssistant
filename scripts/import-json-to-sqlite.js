import fs from "node:fs";
import path from "node:path";
import { createPaperStore } from "../src/execution/paperStore.js";

const DEFAULT_PREFIXES = ["poly_btc_5m_", "poly_btc_15m_", "kalshi_btc_"];

export function importJsonToSqlite({ cwd = process.cwd(), prefixes = DEFAULT_PREFIXES } = {}) {
  for (const prefix of prefixes) {
    const store = createPaperStore({ cwd, prefix, mode: "sqlite" });
    const botId = store.botId;
    // Idempotent: clear this bot's rows then re-insert from JSON (single source = JSON file).
    store.clearBot();
    const tradesFile = path.join(cwd, "logs", `${prefix}paper_trades.json`);
    if (fs.existsSync(tradesFile)) {
      const { trades = [] } = JSON.parse(fs.readFileSync(tradesFile, "utf8"));
      for (const t of trades) store.appendTrade(t);
      console.log(`[import] ${botId}: ${trades.length} trades`);
    }
    const posFile = path.join(cwd, "logs", `${prefix}paper_position.json`);
    if (fs.existsSync(posFile)) {
      const pos = JSON.parse(fs.readFileSync(posFile, "utf8"));
      if (pos && pos.open) store.savePosition(pos);
    }
    store.close();
  }
}

// CLI entry
if (import.meta.url === `file://${process.argv[1]}`) {
  importJsonToSqlite({});
}
