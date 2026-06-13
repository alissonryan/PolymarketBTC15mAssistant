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

### Unattended 24/7 (auto-restart)

The bots are long-running. A built-in memory monitor exits with code 17 if RSS
passes `MEM_SOFT_CAP_MB` (default 1200) so an external loop can recycle the
process cleanly. Run any bot under a restart loop:

```bash
while true; do npm run polymarket:btc:15m; echo "restarting in 5s..."; sleep 5; done
```

The paper lock is released on exit, so the restart re-acquires it without a stale
`rm`. Tune the cutoff with `MEM_SOFT_CAP_MB` and oracle freshness with
`ORACLE_STALE_MS` (trade/price feeds, default 120000) / `CHAINLINK_STALE_MS`
(sparse on-chain feed, default 900000).

### Clean-slate run (separate log prefix)

Use `PAPER_LOG_PREFIX` to write to a fresh set of log files without affecting previous results:

```bash
PAPER_LOG_PREFIX=clean_poly_5m_ npm run polymarket:btc:5m
PAPER_LOG_PREFIX=clean_poly_15m_ npm run polymarket:btc:15m
PAPER_LOG_PREFIX=clean_kalshi_btc_ npm run kalshi:btc
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
