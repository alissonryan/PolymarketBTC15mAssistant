# Polymarket BTC 15m Assistant

Console assistant for short-duration crypto prediction markets, focused on:

- Polymarket BTC Up/Down 5m and 15m markets
- Kalshi BTC/ETH/SOL 15m paper trading adapters
- Paper-first validation before any real execution

The bot combines Polymarket/Kalshi market data, Chainlink/Polymarket live reference prices, Binance spot/trade data, short-term technical indicators, CVD/order-flow signals, regime detection, risk guards, and paper-trading logs.

Important: the on-screen LONG/SHORT value is a heuristic score, not a calibrated probability. Treat it as a signal candidate until paper/replay proves positive expected value after spread, slippage, and fees.

## Current Safety Mode

The recommended mode is still paper trading. Running `npm start` opens an interactive paper-trading menu:

```bash
npm start
```

Do not enable real execution until paper results are positive and auditable.

Recommended `.env` baseline:

```env
EXECUTE_ORDERS=false
PAPER_TRADING=true
RISK_ORDER_SIZE_USDC=5
RISK_MAX_DAILY_LOSS_USDC=25
RISK_MAX_OPEN_POSITIONS=1
RISK_MIN_EDGE=0.15
RISK_MIN_TOKEN_PRICE=0.30
RISK_SESSION_START_UTC=8
RISK_SESSION_END_UTC=23
RISK_TAKER_FEE_RATE=0.07
```

## What The Bot Does

- Auto-selects the latest Polymarket BTC Up/Down market unless a slug is pinned.
- Reads Polymarket CLOB order books and uses executable buy prices based on ask-side liquidity.
- Tracks Polymarket live Chainlink BTC/USD price and falls back to Chainlink/Polygon RPC when needed.
- Uses Binance spot/trades for reference indicators, not as the official Polymarket settlement source.
- Computes VWAP, RSI, MACD, Heiken Ashi, CVD, Time-Price Convergence, and regime labels.
- Runs paper trading with saved positions/trades and a local analyzer.
- Supports Kalshi paper adapters for BTC, ETH, and SOL 15m markets.

## Recent Changes

Recent work by Alisson Ryan on this branch:

- Added Kalshi paper trading adapter for BTC/ETH/SOL 15m markets.
- Fixed Kalshi adapter URL, status filtering, and price fields.
- Added `RISK_MIN_TOKEN_PRICE`.
- Added CVD, Time-Price Convergence, and Lock Strategy components.
- Added paper trading, execution/risk layers, and Chainlink oracle handling.
- Added proxy support for HTTP and WebSocket requests.

Latest local changes in this commit:

- Polymarket entry pricing now uses executable ask-side prices instead of treating bid as the buy price.
- Paper trading now accepts venue reference/settlement prices and records `oracleSource`.
- Paper P&L now supports taker fee estimation through `RISK_TAKER_FEE_RATE`.
- Added validation log `logs/paper_validation_signals.csv`.
- Added `npm run analyze:paper`.
- Added Node test coverage for risk guard, executable pricing, paper reference price, and fee math.
- Renamed visible "Predict/Prob" wording to "Score" because the signal is not calibrated probability.
- Ignored local `.claude/` settings.

## Requirements

- Node.js 18+
- npm

Install dependencies:

```bash
npm install
```

## Run Polymarket Paper Trading

Interactive menu:

```bash
npm start
```

Direct commands are kept for automation and remote runners.

BTC 5m:

```bash
npm run polymarket:btc:5m
```

BTC 15m:

```bash
npm run polymarket:btc:15m
```

Equivalent manual commands:

```bash
EXECUTE_ORDERS=false PAPER_TRADING=true CANDLE_WINDOW_MINUTES=5 node --env-file=.env src/index.js
EXECUTE_ORDERS=false PAPER_TRADING=true CANDLE_WINDOW_MINUTES=15 node --env-file=.env src/index.js
```

Pin a specific Polymarket market:

```bash
POLYMARKET_SLUG=btc-updown-15m-... EXECUTE_ORDERS=false PAPER_TRADING=true npm start
```

## Run Kalshi Paper Trading

Kalshi choices are available in the `npm start` menu. Direct commands:

BTC:

```bash
EXECUTE_ORDERS=false PAPER_TRADING=true npm run kalshi:btc
```

ETH:

```bash
EXECUTE_ORDERS=false PAPER_TRADING=true npm run kalshi:eth
```

SOL:

```bash
EXECUTE_ORDERS=false PAPER_TRADING=true npm run kalshi:sol
```

Kalshi requires API credentials in `.env` for market reads:

```env
KALSHI_API_KEY_ID=...
KALSHI_PRIVATE_KEY_PATH=./kalshi_private.pem
KALSHI_DEMO=false
```

Private keys and `.env` files are ignored by git.

## Validation Commands

The `npm start` menu also includes shortcuts for paper analysis and tests.

Run tests:

```bash
npm test
```

Syntax checks:

```bash
node --check src/index.js
node --check src/index-kalshi.js
node --check src/data/polymarket.js
node --check src/execution/paperTrading.js
node --check src/execution/paperMath.js
node --check scripts/analyze-paper.js
```

Analyze paper trades:

```bash
npm run analyze:paper
```

Analyze a specific paper trade file:

```bash
node scripts/analyze-paper.js logs/paper_trades.json
```

The analyzer reports:

- total trades
- wins/losses/win rate
- gross P&L, fees, net P&L
- ROI and average P&L
- breakdown by side, UTC session, time-left bucket, edge bucket, and spread bucket

## Logs

Runtime logs are written under `logs/` and are ignored by git.

Important files:

- `logs/signals.csv`: legacy signal stream, kept stable for compatibility.
- `logs/paper_validation_signals.csv`: richer validation stream with bid/ask/spread, score, edge, reference price, current price, and oracle source.
- `logs/paper_position.json`: current paper position.
- `logs/paper_trades.json`: settled paper trades.
- `logs/daily_pnl.json`: real-execution daily P&L guard state.

Existing old paper logs may not contain all new fields. New trades will include the richer validation fields.

## Configuration

### Polymarket

- `CANDLE_WINDOW_MINUTES`: `15` by default. Set `5` for 5m markets.
- `POLYMARKET_AUTO_SELECT_LATEST`: default `true`.
- `POLYMARKET_SERIES_ID`: defaults to `10192` for 15m and `10684` for 5m.
- `POLYMARKET_SERIES_SLUG`: defaults to `btc-up-or-down-15m` or `btc-up-or-down-5m`.
- `POLYMARKET_SLUG`: optional pinned market slug.
- `POLYMARKET_LIVE_WS_URL`: default `wss://ws-live-data.polymarket.com`.
- `POLYMARKET_UP_LABEL`: default `Up`.
- `POLYMARKET_DOWN_LABEL`: default `Down`.

### Chainlink / Polygon

- `CHAINLINK_BTC_USD_AGGREGATOR`: BTC/USD aggregator address.
- `POLYGON_RPC_URL`: default `https://polygon-rpc.com`.
- `POLYGON_RPC_URLS`: comma-separated HTTP RPC fallbacks.
- `POLYGON_WSS_URL`: optional WSS RPC.
- `POLYGON_WSS_URLS`: comma-separated WSS RPC fallbacks.

### Risk

- `EXECUTE_ORDERS`: must stay `false` while validating.
- `PAPER_TRADING`: set `true` for paper mode.
- `RISK_ORDER_SIZE_USDC`: paper/real order size.
- `RISK_MAX_DAILY_LOSS_USDC`: circuit breaker limit.
- `RISK_MAX_OPEN_POSITIONS`: default `1`.
- `RISK_MIN_EDGE`: default `0.15`.
- `RISK_MIN_TOKEN_PRICE`: default `0.30`.
- `RISK_SESSION_START_UTC`: default `8`.
- `RISK_SESSION_END_UTC`: default `23`.
- `RISK_TAKER_FEE_RATE`: default `0.07`, used for paper fee estimation.

### Proxy

The bot supports standard proxy environment variables:

- `HTTPS_PROXY` / `https_proxy`
- `HTTP_PROXY` / `http_proxy`
- `ALL_PROXY` / `all_proxy`

Examples:

```bash
HTTPS_PROXY=http://127.0.0.1:8080 npm start
ALL_PROXY=socks5://127.0.0.1:1080 npm start
```

For credentials, URL-encode special characters:

```bash
HTTPS_PROXY=http://USERNAME:PASSWORD@HOST:PORT npm start
```

## Real Execution

Real execution code exists, but it should remain disabled during strategy validation.

Before enabling `EXECUTE_ORDERS=true`, require at minimum:

- paper trading with realistic entry price using ask-side liquidity
- venue-correct reference/settlement price
- positive net P&L after fee estimate
- enough trades to evaluate by session, spread, edge bucket, and time-left bucket
- no unresolved bugs in pricing, settlement, or logs

## Troubleshooting

- If no Chainlink updates appear, Polymarket live WS may be unavailable; the bot falls back through configured Chainlink/Polygon sources.
- If paper trades show `unknown` for spread or time-left, they were likely created before the latest validation fields were added.
- If Kalshi fails with authentication errors, check `KALSHI_API_KEY_ID` and `KALSHI_PRIVATE_KEY_PATH`.
- If the console appears to spam output, your terminal may not handle `readline.cursorTo` and `clearScreenDown` cleanly.

## Safety

This is not financial advice. Short-duration binary markets are highly adversarial, spread-sensitive, and latency-sensitive. Keep real orders disabled until the paper logs prove the strategy under realistic assumptions.

Created by @krajekis. Maintained locally by Alisson Ryan.
