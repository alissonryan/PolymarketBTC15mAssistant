# Polymarket BTC 15m Assistant

Paper-trading bot for short-duration BTC binary prediction markets on Polymarket and Kalshi.

Supported markets:
- Polymarket BTC Up/Down 5m and 15m
- Kalshi BTC/ETH/SOL 15m

The bot uses a **statistically-calibrated model** — rather than lagging technical indicators, it looks up the historical probability that BTC goes UP for the current market conditions (UTC hour × 1H macro trend × price vs VWAP × RSI zone), calibrated over 365 days of 5-minute candles. It only enters trades when a condition has a statistically significant edge (p < 0.05, n ≥ 100).

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

### Clean-slate run (separate log prefix)

Use `PAPER_LOG_PREFIX` to write to a fresh set of log files without affecting previous results:

```bash
PAPER_LOG_PREFIX=clean_poly_5m_ npm run polymarket:btc:5m
PAPER_LOG_PREFIX=clean_poly_15m_ npm run polymarket:btc:15m
PAPER_LOG_PREFIX=clean_kalshi_btc_ npm run kalshi:btc
```

---

## Calibration Workflow

The model reads pre-computed base rates from `scripts/calibration.json`. This file must exist before starting the bots.

### First-time setup or monthly refresh

```bash
npm run calibrate
```

This pulls 365 days of 5m and 1h BTCUSDT klines from Binance (cached to `scripts/cache/`), computes historical UP probabilities for 288 condition buckets, and writes `scripts/calibration.json`.

### Force re-download (bypass cache)

```bash
node scripts/calibrate.js --no-cache
```

### When to re-calibrate

- Once a month (data ages)
- After a major BTC regime change (e.g., sustained bull → bear)
- After changing the bucketing logic in `scripts/calibrate.js`

The bot logs `[calibratedRate] Loaded 288 calibration entries` at startup. If the file is missing it falls back to 0.5/0.5 (no edge, no trades).

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

Default prefixes: `paper_`, `poly_btc_5m_paper_`, `poly_btc_15m_paper_`, `kalshi_btc_paper_`.

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
| Edge too low | `RISK_MIN_EDGE` | phase-dependent | Model has no edge |
| Edge too high | `RISK_MAX_EDGE` | 0.35 | Model overconfident (lagging indicators) |
| Model prob | — | phase-dependent | Calibrated upRate too low |
| Spread | `RISK_MAX_SPREAD` | 0.03 | Spread too wide |
| Macro trend | — | — | Counter-trend vs 1H EMA50 |

---

## How the Model Works

### Signal pipeline

```
1. Conditions detected:
   - UTC hour (0–23)
   - 1H macro trend: price vs EMA50(50) on 1H candles → UP / DOWN
   - Price vs intraday VWAP → ABOVE / BELOW
   - RSI(14) zone → OVERBOUGHT (>60) / OVERSOLD (<40) / NEUTRAL

2. lookupRate(conditions) → historical UP probability from calibration.json

3. applyTimeAwareness(upRate, timeLeft) → decays signal toward 50% as market closes

4. computeEdge(modelUp, marketYesPrice) → edge over market price

5. decide(edge, gates...) → ENTER or NO_TRADE
```

### Calibration logic

`scripts/calibrate.js` divides 365 days × 105k candles into 288 condition buckets and records:

- `upRate`: fraction of candles where BTC closed higher in the next 5 minutes
- `ci95`: 95% confidence interval (Wilson)
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
    calibratedRate.js   Historical base-rate lookup (main model)
    edge.js             Edge computation + all risk gates
    macroTrend.js       1H EMA50 macro trend
    regime.js           Intraday regime detection (VWAP-based)
    probability.js      applyTimeAwareness (time decay)
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
  calibrate.js          Builds scripts/calibration.json from Binance history
  backtest.js           365-day historical accuracy report
  analyze-paper.js      Paper trade analysis CLI
  cache/                Cached Binance kline data (git-ignored)

test/
  chopFilter.test.js    CHOP + BB Width + gate tests
  edgeDecision.test.js  Edge engine + macro trend tests
```

---

## Troubleshooting

**Bot starts but `[calibratedRate] calibration.json not found`**
Run `npm run calibrate` first.

**No trades entering despite gate OPEN**
Check `RISK_MAX_EDGE` — if the calibrated upRate is very high (e.g. 0.63), after `applyTimeAwareness` the adjusted edge may exceed 0.35 and be blocked. This is intentional; the model waits for a moderate, high-confidence condition rather than extreme ones.

**Kalshi authentication error**
Verify `KALSHI_API_KEY_ID` and that `KALSHI_PRIVATE_KEY_PATH` points to a valid RSA PEM file.

**High memory / CPU after long runs**
Signal CSV logging (`SIGNAL_LOG=true`) can grow large with 2-second ticks. Keep it `false` in production.

**Lock file prevents start**
If a bot crashed without releasing its lock: `rm logs/<prefix>paper.lock`

---

## Safety

This is not financial advice. Binary prediction markets are adversarial, spread-sensitive, and time-sensitive. The calibrated model shows statistical edge in backtesting, but past performance does not guarantee future results. Keep `EXECUTE_ORDERS=false` until paper results are positive and stable across different market regimes.
