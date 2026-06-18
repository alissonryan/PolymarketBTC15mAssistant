# Polymarket BTC 15m Assistant

Paper-trading bot for short-duration BTC binary prediction markets on Polymarket and Kalshi.

Supported markets:
- Polymarket BTC Up/Down 5m and 15m
- Kalshi BTC/ETH/SOL 15m

The bot combines two models:

1. **Calibrated base rates** — the historical probability that BTC goes UP for the current market conditions (UTC hour × 1H macro trend × price vs VWAP × RSI zone), computed over 365 days of Binance candles. Each market horizon has its own table: `scripts/calibration.json` (5m-ahead) and `scripts/calibration_15m.json` (15m-ahead), auto-selected by `CANDLE_WINDOW_MINUTES`.
2. **Diffusion settlement model** (`src/engines/settlementProb.js`) — `P(UP) = Φ((distance-to-strike + drift·t) / (σ·√t))`, where the drift is implied by the calibrated base rate and σ is realized vol from 1m candles. At window open it returns the calibrated rate; as time runs out it converges to 0/1 like the market itself.

Trades only enter when the edge over the market price clears an economic floor (fees + half-spread + safety margin) and the condition bucket is statistically significant (p < 0.05, n ≥ 100).

> Paper-trading only. Keep `EXECUTE_ORDERS=false` until results are audited.

---

## Requirements

- Node.js 20+
- npm

```bash
npm install
```

---

## Quick Start

### Interactive menu

```bash
npm start
```

Opens a menu to choose market, mode, and paper prefix.

### Direct commands

| Bot | Command |
|-----|---------|
| Polymarket BTC 5m | `npm run polymarket:btc:5m` |
| Polymarket BTC 15m | `npm run polymarket:btc:15m` |
| Kalshi BTC 15m | `npm run kalshi:btc` |
| Kalshi ETH 15m | `npm run kalshi:eth` |
| Kalshi SOL 15m | `npm run kalshi:sol` |

## Running the three bots

Each bot renders a full-screen live dashboard, so **one bot per terminal tab**.
The three normally run together: `polymarket:btc:5m`, `polymarket:btc:15m`, and
`kalshi:btc`. Pick ONE of the two modes below — don't run both at once or the
second instance of a bot collides on its paper lock.

> All commands assume you're in the project directory:
> ```bash
> cd ~/code/PolymarketBTC15mAssistant
> ```

### Mode A — watch live (foreground, with auto-restart)

Open **3 terminal tabs** (`Cmd+T`), one command per tab. The `while` loop keeps
the dashboard visible AND relaunches the bot in 5s if it ever crashes:

```bash
# Tab 1 — Polymarket 5m
while true; do npm run polymarket:btc:5m;  echo "caiu, religando em 5s..."; sleep 5; done

# Tab 2 — Polymarket 15m (stricter chop filter baked in)
while true; do npm run polymarket:btc:15m; echo "caiu, religando em 5s..."; sleep 5; done

# Tab 3 — Kalshi
while true; do npm run kalshi:btc;         echo "caiu, religando em 5s..."; sleep 5; done
```

Stop a bot: `Ctrl+C` in its tab (press twice — once to kill the bot, the loop
relaunches it, so Ctrl+C again to also break the loop). Closing the tab also
stops that bot. The machine sleeping/shutting down stops all of them.

### Mode B — run in background 24/7 (survives closing the terminal)

Use `nohup` so the bots keep running after you close the terminal. Output goes to
log files instead of the screen:

```bash
mkdir -p logs/run
# clear any stale locks from a previous run first
rm -f logs/poly_btc_5m_paper.lock logs/poly_btc_15m_paper.lock logs/kalshi_btc_paper.lock

nohup bash -c 'while true; do npm run polymarket:btc:5m;  sleep 5; done' > logs/run/poly5m.out  2>&1 &
nohup bash -c 'while true; do npm run polymarket:btc:15m; sleep 5; done' > logs/run/poly15m.out 2>&1 &
nohup bash -c 'while true; do npm run kalshi:btc;         sleep 5; done' > logs/run/kalshi.out   2>&1 &
```

Watch a background bot's output live:

```bash
tail -f logs/run/poly15m.out   # Ctrl+C to stop watching (bot keeps running)
```

### Check what's running

```bash
pgrep -fl "src/index"          # lists the live bot processes (expect 3)
cat logs/poly_btc_15m_paper.lock   # shows the pid holding each lock
```

### Stop everything

```bash
pkill -f "while true; do npm run"   # kills the restart loops (background mode)
pkill -f "src/index"                # kills the bot processes
```

After stopping, the paper locks are released automatically. If a bot was killed
hard and left a stale lock, remove it before restarting:

```bash
rm -f logs/poly_btc_5m_paper.lock logs/poly_btc_15m_paper.lock logs/kalshi_btc_paper.lock
```

### Tuning

A built-in memory monitor exits with code 17 if RSS passes `MEM_SOFT_CAP_MB`
(default 1200) so the restart loop recycles the process cleanly. Other knobs:

| Env var | Default | Effect |
|---------|---------|--------|
| `MEM_SOFT_CAP_MB` | 1200 | RSS ceiling before a clean self-exit for restart |
| `ORACLE_STALE_MS` | 120000 | Trade/price feed freshness cutoff (Binance/Polymarket WS) |
| `CHAINLINK_STALE_MS` | 900000 | Sparse on-chain feed freshness cutoff |
| `RISK_CHOP_THRESHOLD` | 61.8 (45 for 15m) | Block trades when CHOP exceeds this |

Example — loosen the 15m chop filter for one run:

```bash
RISK_CHOP_THRESHOLD=50 npm run polymarket:btc:15m
```

### Clean-slate run (separate log prefix)

Use `PAPER_LOG_PREFIX` to write to a fresh set of log files without affecting previous results:

```bash
PAPER_LOG_PREFIX=clean_poly_5m_ npm run polymarket:btc:5m
PAPER_LOG_PREFIX=clean_poly_15m_ npm run polymarket:btc:15m
PAPER_LOG_PREFIX=clean_kalshi_btc_ npm run kalshi:btc
```

---

## Persistência: SQLite store & rollout

Paper-trade history is migrating from per-bot JSON files to a shared SQLite store
(`logs/trades.db`). The migration runs in three stages — JSON only → dual-write →
SQLite canonical — so we can validate parity before flipping the switch.

### Node 24 requirement

The SQLite store uses the built-in `node:sqlite` module, so the project now needs
**Node ≥ 24** (no native build toolchain, no `better-sqlite3`). There is a `.nvmrc`
pinning `v24.11.0` — `nvm use` picks it up automatically.

On the Ubuntu VPS:

```bash
nvm install 24 && nvm use 24   # or just `nvm use` (reads .nvmrc)
node -v                        # expect v24.x
```

**Restart the three bots on Node 24** before enabling any SQLite store mode.

### Store modes (`PAPER_STORE`)

The `PAPER_STORE` env var selects where trades are written:

| Mode | Behavior |
|------|----------|
| `json` (default) | Current behavior — JSON files only (`logs/<prefix>paper_trades.json`). |
| `dual` | Writes to **both** JSON and SQLite. JSON stays canonical for reads — the safety mode during rollout. |
| `sqlite` | SQLite `logs/trades.db` is canonical. |

All three bots share one `logs/trades.db`, distinguished by a `bot_id` column
derived from `PAPER_LOG_PREFIX` (so `poly_btc_5m_`, `poly_btc_15m_`, `kalshi_btc_`
each map to their own `bot_id`).

### Dual-write rollout procedure

1. **One-time backfill** of existing history into the DB:

   ```bash
   npm run import:sqlite   # imports logs/*_paper_trades.json into logs/trades.db
   ```

2. **Restart the 3 bots with `PAPER_STORE=dual`** (on Node 24):

   ```bash
   PAPER_STORE=dual npm run polymarket:btc:5m
   PAPER_STORE=dual npm run polymarket:btc:15m
   PAPER_STORE=dual npm run kalshi:btc
   ```

3. **Validate parity:**

   ```bash
   npm run compare:stores   # should print all ✅ and exit 0 (JSON count == SQLite count per bot)
   ```

### Cutover criteria

Per the design spec, wait for the **last** of:

- (a) **3 days** of dual-write, AND
- (b) **≥ 20 settled trades** with **zero divergence** between JSON and SQLite.

Target review window: ~**2026-06-20/21**. Once both are met, restart the bots with
`PAPER_STORE=sqlite` and **archive** the JSON files (move them aside — **do NOT
delete**):

```bash
PAPER_STORE=sqlite npm run polymarket:btc:5m   # + 15m + kalshi:btc
```

### Backup

`./scripts/backup-db.sh` makes a dated copy of `logs/trades.db` to
`$HOME/paper-db-backups` (override the destination with `PAPER_DB_BACKUP_DIR`). It
uses `sqlite3 .backup` for a safe online copy when `sqlite3` is on `PATH`, else
falls back to `cp`.

```bash
./scripts/backup-db.sh                       # -> $HOME/paper-db-backups/trades-<stamp>.db
PAPER_DB_BACKUP_DIR=/mnt/backups ./scripts/backup-db.sh
```

Suggested cron (laptop or VPS), every 30 minutes:

```
*/30 * * * * cd /path/to/PolymarketBTC15mAssistant && ./scripts/backup-db.sh >> $HOME/paper-db-backups/backup.log 2>&1
```

---

## Calibration Workflow

The model reads pre-computed base rates from `scripts/calibration.json` (5m horizon) and `scripts/calibration_15m.json` (15m horizon). Both must exist before starting the bots — each bot auto-selects its table by `CANDLE_WINDOW_MINUTES` (the Kalshi 15m bots also use the 15m table).

### First-time setup or monthly refresh

```bash
npm run calibrate            # generates BOTH tables (5m and 15m horizon)
npm run validate:calibration # walk-forward out-of-sample check — run after EVERY recalibration
```

`calibrate` pulls 365 days of 5m and 1h BTCUSDT klines from Binance (cached to `scripts/cache/`), computes historical UP probabilities for 288 condition buckets per horizon. `validate:calibration` trains on the first 70% of the data, selects buckets with the live bot's rule, and reports their accuracy on the unseen 30% — **if OOS accuracy is ~50%, the table is noise; do not trade on it.** Reference results (June 2026): 53.7% OOS at 5m horizon, 55.5% at 15m, vs ~52% fee breakeven.

### Force re-download (bypass cache)

```bash
node scripts/calibrate.js --no-cache
```

### When to re-calibrate

- Once a month (data ages)
- After a major BTC regime change (e.g., sustained bull → bear)
- After changing the bucketing logic in `scripts/calibrate.js`

The bot logs `[calibratedRate] Loaded 288 calibration entries from .../calibration[_15m].json` at startup — check the filename matches the market you're trading. If the file is missing it falls back to 0.5/0.5 (no edge, no trades).

---

## Backtest & Analysis

### Historical backtest (365 days of 5m data)

```bash
node scripts/backtest.js --days 365 > scripts/backtest_report.md
```

Options:

| Flag | Default | Description |
|------|---------|-------------|
| `--days N` | `365` | How many days of history to analyse |
| `--interval` | `5m` | Kline interval (`5m` or `15m`) |
| `--no-cache` | — | Force re-download from Binance |

Outputs a Markdown report with WR by hour, day, month, edge bucket, BB Width, CHOP, and macro trend.

### Analyse paper trades

```bash
npm run analyze:paper
```

Or target a specific file:

```bash
node scripts/analyze-paper.js logs/clean_poly_5m_paper_trades.json
```

Reports: total trades, win rate, gross/net P&L, ROI, breakdown by side / hour / edge / spread / time-left.

---

## Tests

```bash
npm test
```

Syntax check only (no execution):

```bash
node --check src/index.js
node --check src/index-kalshi.js
```

---

## Log Files

All logs live in `logs/` (git-ignored).

| File | Description |
|------|-------------|
| `logs/<prefix>paper_trades.json` | Settled paper trades |
| `logs/<prefix>paper_position.json` | Current open position |
| `logs/<prefix>paper.lock` | Runtime lock (prevents duplicate processes) |
| `logs/signals.csv` | Signal stream (disabled by default, set `SIGNAL_LOG=true` to enable) |

Default prefixes per npm script: `poly_btc_5m_`, `poly_btc_15m_`, `kalshi_btc_`, `kalshi_eth_`, `kalshi_sol_`. Pre-June-2026 history (old strategy versions) is archived in `logs/archive_pre_v2/`.

---

## Configuration

Copy `.env.example` to `.env` and fill in the values.

### Recommended `.env` baseline

```env
# Execution
EXECUTE_ORDERS=false
PAPER_TRADING=true

# Position sizing
RISK_ORDER_SIZE_USDC=5
RISK_MAX_DAILY_LOSS_USDC=50
RISK_MAX_OPEN_POSITIONS=1

# Entry filters
RISK_MIN_EDGE=0.05
RISK_MIN_TOKEN_PRICE=0.30
RISK_MAX_SPREAD=0.03

# Risk gates (tunable)
RISK_CHOP_THRESHOLD=61.8        # CHOP > this = ranging, no trade
                                # NOTE: the 15m bot ships with a stricter 45 baked into
                                # its npm script — it bleeds in chop, so it only trades
                                # in trend/mild-neutral. Override with RISK_CHOP_THRESHOLD.
RISK_BB_WIDTH_MIN=0.08          # BB Width < this = compressed, no trade (1m candle scale)
RISK_MAX_EDGE=0.35              # Edge > this = model overconfident, no trade
RISK_BLOCK_HOURS_UTC=7,8,9,10  # UTC hours to skip (European open reversal zone)
RISK_EDGE_MARGIN=0.02           # Safety margin added to the economic edge floor

# Anti-correlation cooldowns (consecutive same-side entries are one repeated bet)
RISK_SAME_SIDE_REENTRY_MIN=30   # Min minutes between entries on the same side
RISK_LOSS_COOLDOWN_MIN=60       # Min minutes before re-entering a side after losing on it

# Fees
RISK_TAKER_FEE_RATE=0.07

# Session window (UTC)
RISK_SESSION_START_UTC=0
RISK_SESSION_END_UTC=23

# Logging
SIGNAL_LOG=false
```

### Polymarket settings

```env
CANDLE_WINDOW_MINUTES=5         # 5 for 5m markets, 15 for 15m
POLYMARKET_AUTO_SELECT_LATEST=true
# Optional: pin a specific market
# POLYMARKET_SLUG=btc-updown-5m-1234567890
```

### Kalshi settings

```env
KALSHI_API_KEY_ID=your-key-id
KALSHI_PRIVATE_KEY_PATH=./kalshi_private.pem
KALSHI_DEMO=false
KALSHI_SERIES=KXBTC15M          # KXBTC15M | KXETH15M | KXSOL15M
```

### Proxy (optional)

```env
HTTPS_PROXY=http://user:pass@host:port
# or
ALL_PROXY=socks5://127.0.0.1:1080
```

---

## Risk Gates (in order of evaluation)

The `decide()` function applies gates sequentially. The first gate to trigger returns `NO_TRADE`.

| Gate | Variable | Default | Reason |
|------|----------|---------|--------|
| Market expired | — | — | No time remaining |
| CHOP Index | `RISK_CHOP_THRESHOLD` | 61.8 | Ranging market |
| BB Width | `RISK_BB_WIDTH_MIN` | 0.08% | Compressed volatility |
| Bad hours | `RISK_BLOCK_HOURS_UTC` | 7,8,9,10 | European open reversal zone |
| Regime | — | — | Regime detected as CHOP/RANGE |
| Spread | `RISK_MAX_SPREAD` | 0.03 | Spread too wide |
| Economic edge floor | `RISK_EDGE_MARGIN` | fee + spread/2 + 0.02 | Trade must clear fees before it can profit |
| Edge too low | phase threshold | 0.05–0.08 | Model has no edge |
| Edge too high | `RISK_MAX_EDGE` | 0.35 | Market disagrees too much — it usually knows more |
| Model prob | — | 0.52–0.54 | Calibrated upRate too low |
| Same-side cooldown | `RISK_SAME_SIDE_REENTRY_MIN` | 30 min | Consecutive same-side entries are correlated bets |
| After-loss cooldown | `RISK_LOSS_COOLDOWN_MIN` | 60 min | Don't repeat a losing bet under the same conditions |

The macro trend gate was removed — the calibrated model already conditions on macro trend as an input dimension; blocking counter-trend trades defeated the calibration.

---

## How the Model Works

### Signal pipeline

```
1. Conditions detected:
   - UTC hour (0–23)
   - 1H macro trend: price vs EMA50(50) on 1H candles → UP / DOWN
   - Price vs intraday VWAP → ABOVE / BELOW
   - RSI(14) zone → OVERBOUGHT (>60) / OVERSOLD (<40) / NEUTRAL

2. lookupRate(conditions) → historical UP probability from the horizon-matched
   calibration table (calibration.json for 5m, calibration_15m.json for 15m)

3. settlementProbability(spot, strike, timeLeft, σ, baseRate) → drifted-diffusion
   P(UP): equals the base rate at window open, converges to 0/1 as time runs out
   based on distance to strike vs remaining volatility

4. computeEdge(modelUp, marketYesPrice) → edge over market price

5. decide(edge, gates...) → ENTER or NO_TRADE (economic floor, cooldowns, gates)
```

### Calibration logic

`scripts/calibrate.js` divides 365 days × 105k candles into 288 condition buckets and records:

- `upRate`: fraction of candles where BTC closed higher N minutes ahead (N = horizon: 5 or 15)
- `ci95`: 95% confidence interval
- `n`: sample count

A condition is considered to have **significant edge** when `|upRate − 0.50| > ci95` and `n ≥ 100`.

Example conditions with significant edge (calibrated May 2025–2026):

| Condition | upRate | Edge |
|-----------|--------|------|
| 13h UTC, Macro UP, Below VWAP, RSI Oversold | 63.2% | +13.2% |
| 20h UTC, Macro UP, Below VWAP, RSI Neutral | 61.7% | +11.7% |
| 16h UTC, Macro DOWN, Below VWAP, RSI Overbought | 34.2% | +15.8% DOWN |
| 15h UTC, Macro DOWN, Below VWAP, RSI Overbought | 34.2% | +15.8% DOWN |

---

## Architecture

```
src/
  index.js              Polymarket bot main loop
  index-kalshi.js       Kalshi bot main loop
  config.js             ENV-driven config
  engines/
    calibratedRate.js   Historical base-rate lookup (horizon-aware table selection)
    settlementProb.js   Drifted-diffusion settlement probability (main model)
    edge.js             Edge computation + economic floor + all risk gates
    macroTrend.js       1H EMA50 macro trend
    regime.js           Intraday regime detection (VWAP-based)
    probability.js      Legacy TA scoring (unused by the main loop)
    lockStrategy.js     Lock/hedge strategy
    timePriceField.js   Time-price convergence signal
  indicators/
    chop.js             Choppiness Index + BB Width
    vwap.js             Intraday VWAP
    rsi.js              RSI + EMA helpers
    macd.js             MACD
    heikenAshi.js       Heiken Ashi candles
    cvd.js              Cumulative Volume Delta
  data/
    binance.js          Kline + price fetching
    polymarket.js       Market data + CLOB
    chainlink.js        Chainlink BTC/USD oracle
    binanceWs.js        Trade stream WebSocket
    chainlinkWs.js      Chainlink live WS
    polymarketLiveWs.js Polymarket live price WS
  execution/
    paperTrading.js     Paper trade lifecycle
    paperMath.js        P&L + fee calculations
    position.js         Position state
    bot.js              Signal handling + shutdown
  net/
    proxy.js            HTTP/SOCKS proxy support

scripts/
  calibrate.js             Builds calibration tables (CALIB_HORIZON=1 → 5m, =3 → 15m)
  validate-calibration.js  Walk-forward OOS validation of the bucket selection
  backtest.js              365-day historical accuracy report
  analyze-paper.js         Paper trade analysis CLI
  cache/                   Cached Binance kline data (git-ignored)

test/
  chopFilter.test.js       CHOP + BB Width + gate tests
  edgeDecision.test.js     Edge engine tests
  settlementProb.test.js   Diffusion model convergence + vol estimation tests
  paperTrading.test.js     Paper lifecycle, locks, fees, cooldowns
```

---

## Troubleshooting

**Bot starts but `[calibratedRate] calibration.json not found`**
Run `npm run calibrate` first.

**No trades entering despite gate OPEN**
This is expected most of the time — entry requires a significant calibration bucket AND an edge over the market that clears the economic floor AND no active cooldown. Check the `Calib:` line on screen: `sem edge sig.` means the current conditions have no historical edge. `edge_X_above_max` means the model disagrees with the market by more than `RISK_MAX_EDGE` — intentionally blocked, because extreme disagreement usually means the market knows something the model doesn't.

**Kalshi authentication error**
Verify `KALSHI_API_KEY_ID` and that `KALSHI_PRIVATE_KEY_PATH` points to a valid RSA PEM file.

**High memory / CPU after long runs**
Signal CSV logging (`SIGNAL_LOG=true`) can grow large with 2-second ticks. Keep it `false` in production.

**Lock file prevents start**
If a bot crashed without releasing its lock: `rm logs/<prefix>paper.lock`

---

## Safety

This is not financial advice. Binary prediction markets are adversarial, spread-sensitive, and time-sensitive. The calibrated model shows statistical edge in backtesting, but past performance does not guarantee future results. Keep `EXECUTE_ORDERS=false` until paper results are positive and stable across different market regimes.

---

## Kalshi execução real (demo-first)

Real execution is disabled by default. With `EXECUTE_ORDERS=false`, the Kalshi bot keeps the same paper-only behavior and does not show the `REAL:` status line.

Required flags and credentials:

| Variable | Purpose |
|----------|---------|
| `EXECUTE_ORDERS` | Must be `true` to enable the real-execution path. Default is `false`. |
| `KALSHI_DEMO` | Set `true` for demo trading. Set `false` only for the future live phase. |
| `KALSHI_LIVE_CONFIRM` | Must be `true` for live trading when `KALSHI_DEMO=false`. Leave unset for demo. |
| `KALSHI_DEMO_API_KEY_ID` | Demo API key id. |
| `KALSHI_DEMO_PRIVATE_KEY_PATH` | Local path to the demo RSA private key PEM. Do not commit this file. |
| `KALSHI_DEMO_PRIVATE_KEY` | Optional inline demo private key, with newlines escaped as `\\n`. Prefer the path var locally. |

Order behavior:

- Orders are fill-or-kill buys at the Kalshi ask.
- `UP` maps to `side: "yes"` and `DOWN` maps to `side: "no"`.
- Prices are integer cents (`yes_price` or `no_price`) and contract count is whole contracts.
- Sizing reuses `RISK_ORDER_SIZE_USDC`: `count = Math.floor(RISK_ORDER_SIZE_USDC / askDollars)`.
- If `count < 1`, the bot blocks the entry. It does not introduce any new stake or threshold env vars.
- Production live execution still needs a separate human gate: `EXECUTE_ORDERS=true`, `KALSHI_DEMO=false`, and `KALSHI_LIVE_CONFIRM=true`.

Demo-first rollout:

1. Generate a Kalshi demo API key and demo RSA private key.
2. Add only demo variables to your local `.env`, never commit `.env` or `.pem`.
3. Run `npm run kalshi:btc:demo`.
4. Confirm demo orders fill, remain FOK-only, persist position state, and settle from the demo account.
5. Review paper-vs-real logs under `logs/`.
6. Stop here. Deposits and live flags are a separate production phase with a human approval gate.

Follow-up: drawdown kill-switch tuning beyond `RISK_MAX_DAILY_LOSS_USDC` is intentionally deferred until the exact approved threshold is defined.
