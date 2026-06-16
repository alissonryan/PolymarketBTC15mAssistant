# hf-backtest — out-of-sample strategy validation

Replays the **real** production engines (`src/engines/*`, `src/indicators/*`) against
independent historical markets to check whether our BTC up/down edge survives on data
the bot never traded. Built 2026-06-16.

Two data sources:
- **Polymarket** — the HuggingFace dataset `BrockMisner/polymarket-crypto-5m-15m`
  (download to `data/external/polymarket-crypto-5m-15m/`, gitignored). Mar 2026.
- **Kalshi** — pulled live from the public Kalshi API (`KXBTC15M` series). No auth needed.

## Run it

```bash
# Polymarket (needs the dataset downloaded + duckdb: pip install --user duckdb)
python3 scripts/hf-backtest/extract.py 15     # -> entries_15m.json
python3 scripts/hf-backtest/extract.py 5      # -> entries_5m.json
node    scripts/hf-backtest/run.mjs 15         # replay 15m
node    scripts/hf-backtest/run.mjs 5          # replay 5m

# Kalshi (live API, ~6 min to fetch ~2 weeks)
node    scripts/hf-backtest/kalshi-extract.mjs 14   # -> entries_kalshi.json
node    scripts/hf-backtest/run.mjs 15 kalshi       # replay (15m engine, kalshi entries)
```

`run.mjs` fetches+caches Binance 1m/1h klines for feature computation, applies
`lookupRate -> settlementProbability -> computeEdge -> decide` + the canTrade gates
(mocking the clock to the historical entry time so `decide()`'s blocked-hours gate is
honest), simulates the fill net of the measured effective spread, and prints a
min-edge sweep plus a directional diagnostic.

## ⚠️ Before trusting any result

Run the **momentum-monotonicity sanity check**: "spot > strike" must predict the
outcome at a win rate that *rises* toward ~90%+ as you approach window close. A flat
~50% near close means the Binance klines are misaligned with the market windows
(this caught a GMT-3 timezone bug in `extract.py` that had inverted the verdict —
`datetime.timestamp()` on naive-UTC timestamps; now pinned via `to_ms_utc()`).
Always cross-check the backtest verdict against live paper trades in `logs/trades.db`.

Generated `entries*.json` and `cache/` are gitignored — reproducible from the scripts.
