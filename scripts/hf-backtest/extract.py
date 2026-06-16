#!/usr/bin/env python3
"""
HF backtest — Stage 1 (data wrangling), parametrized by window (5 or 15).

  python3 extract.py 15   -> entries_15m.json
  python3 extract.py 5    -> entries_5m.json

Set-based DuckDB queries (one scan of trades, windowed price_history lookups) so
it scales to the 3,238 BTC-5m markets. Emits one clean per-market entry record;
run.mjs applies the REAL strategy engines from src/.

Entry timing matches the live bot's observed entry_time_left_min: 15m->14.0,
5m->4.9. Token->Up/Down recovered via convergence (winning token -> ~1) matched
to the known resolution `outcome`.
"""
import duckdb, json, os, sys
from datetime import timezone

def to_ms_utc(dt):
    # DuckDB returns naive datetimes that are UTC; .timestamp() on a naive dt would
    # assume LOCAL tz (this box is GMT-3) and shift epoch by 3h, misaligning Binance
    # klines. Pin UTC explicitly.
    return int(dt.replace(tzinfo=timezone.utc).timestamp() * 1000)

WIN = int(sys.argv[1]) if len(sys.argv) > 1 else 15
MARKET_TYPE = f"crypto_{WIN}m"
ENTRY_LEFT_SEC = int(round((14.0 if WIN == 15 else 4.9) * 60))
SPREAD_LO_SEC = WIN * 60           # end - WIN min
SPREAD_HI_SEC = (WIN - 2) * 60     # end - (WIN-2) min
GLOBAL_SPREAD_FALLBACK = 0.0274

DATA = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "data", "external", "polymarket-crypto-5m-15m"))
OUT  = os.path.join(os.path.dirname(__file__), f"entries_{WIN}m.json")
def P(rel): return os.path.join(DATA, rel)
con = duckdb.connect()
def q(sql): return con.execute(sql).fetchall()

PH = f"read_parquet('{P('price_history/*.parquet')}')"
MK = f"read_parquet('{P('markets/all.parquet')}')"
RS = f"read_parquet('{P('resolutions/all.parquet')}')"
TR = f"read_parquet('{P('trades/*.parquet')}')"

# 0) target markets (have price_history coverage)
base = q(f"""
  SELECT m.market_id, r.start_time, r.end_time, r.outcome
  FROM {RS} r JOIN {MK} m USING (market_id)
  WHERE m.asset='BTC' AND m.market_type='{MARKET_TYPE}'
    AND m.market_id IN (SELECT DISTINCT market_id FROM {PH})
""")
markets = {row[0]: {"start": row[1], "end": row[2], "outcome": row[3]} for row in base}
print(f"[extract {WIN}m] markets with price_history: {len(markets)}", file=sys.stderr)

# 1) token labeling: last price per (market_id, token_id)
last_ph = q(f"""
  WITH t AS (
    SELECT ph.market_id, ph.token_id, ph.price,
           row_number() OVER (PARTITION BY ph.market_id, ph.token_id ORDER BY ph.timestamp DESC) rn
    FROM {PH} ph JOIN {MK} m USING (market_id)
    WHERE m.asset='BTC' AND m.market_type='{MARKET_TYPE}')
  SELECT market_id, token_id, price FROM t WHERE rn=1
""")
toks = {}
for mid, tok, px in last_ph:
    toks.setdefault(mid, []).append((tok, px))

# 2) price at entry: price_history row nearest to (end - ENTRY_LEFT), within 90s
ent = q(f"""
  WITH e AS (
    SELECT ph.market_id, ph.token_id, ph.price,
           abs(epoch(ph.timestamp) - epoch(m.end_time - to_seconds({ENTRY_LEFT_SEC}))) dt,
           row_number() OVER (PARTITION BY ph.market_id, ph.token_id
             ORDER BY abs(epoch(ph.timestamp) - epoch(m.end_time - to_seconds({ENTRY_LEFT_SEC})))) rn
    FROM {PH} ph JOIN {MK} m USING (market_id)
    WHERE m.asset='BTC' AND m.market_type='{MARKET_TYPE}')
  SELECT market_id, token_id, price FROM e WHERE rn=1 AND dt<=90
""")
entry_px = {}
for mid, tok, px in ent:
    entry_px.setdefault(mid, {})[tok] = px

# 3) effective spread per market (one scan of trades)
spreads = q(f"""
  SELECT t.market_id,
         avg(CASE WHEN side ILIKE 'buy%' THEN price END) - avg(CASE WHEN side ILIKE 'sell%' THEN price END)
  FROM {TR} t JOIN {MK} m USING (market_id)
  WHERE m.asset='BTC' AND m.market_type='{MARKET_TYPE}' AND t.asset='BTC'
    AND t.timestamp BETWEEN m.end_time - to_seconds({SPREAD_LO_SEC}) AND m.end_time - to_seconds({SPREAD_HI_SEC})
  GROUP BY 1
""")
spread_map = {mid: (s if s is not None and s > 0 else GLOBAL_SPREAD_FALLBACK) for mid, s in spreads}

entries, skipped = [], {"no_token_label": 0, "no_entry_price": 0}
for mid, info in markets.items():
    tl = toks.get(mid, [])
    if len(tl) != 2:
        skipped["no_token_label"] += 1; continue
    (tA, pA), (tB, pB) = tl
    winner, loser = (tA, tB) if pA >= pB else (tB, tA)
    up_tok, down_tok = (winner, loser) if str(info["outcome"]).lower().startswith("up") else (loser, winner)
    ep = entry_px.get(mid, {})
    mu, md = ep.get(up_tok), ep.get(down_tok)
    if mu is None and md is None:
        skipped["no_entry_price"] += 1; continue
    if mu is None: mu = 1.0 - md
    if md is None: md = 1.0 - mu
    entries.append({
        "market_id": mid,
        "start_ts": to_ms_utc(info["start"]),
        "end_ts": to_ms_utc(info["end"]),
        "entry_ts": to_ms_utc(info["end"]) - ENTRY_LEFT_SEC * 1000,
        "outcome": "Up" if str(info["outcome"]).lower().startswith("up") else "Down",
        "marketUp": round(float(mu), 4), "marketDown": round(float(md), 4),
        "effSpread": round(float(spread_map.get(mid, GLOBAL_SPREAD_FALLBACK)), 4),
    })

entries.sort(key=lambda e: e["entry_ts"])
with open(OUT, "w") as f: json.dump(entries, f)
print(f"[extract {WIN}m] wrote {len(entries)} entries -> {OUT}  skipped={skipped}", file=sys.stderr)
