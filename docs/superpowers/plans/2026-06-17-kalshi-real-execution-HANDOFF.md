# Handoff prompt — Kalshi real execution

Copy everything below the line into a fresh LLM coding session (Claude Code, Cursor,
etc.) opened at the repo root `PolymarketBTC15mAssistant`.

---

You are implementing real Kalshi order execution for a BTC-15m prediction-market
trading bot that is currently **paper-only**. Work strictly from the approved plan
and spec already in the repo:

- Plan (execute task-by-task): `docs/superpowers/plans/2026-06-17-kalshi-real-execution.md`
- Spec (the why + constraints): `docs/superpowers/specs/2026-06-17-kalshi-real-execution-design.md`

## How to work

1. Read the spec once for context, then implement the plan **one task at a time, in
   order (Task 1 → Task 8)**. Each task is TDD: write the failing test, run it, see it
   fail, implement, run it, see it pass, then commit. Do not batch tasks.
2. After each task, run the **full** suite `node --test` and confirm it passes before
   moving on. Stop and report if anything unexpected fails.
3. Use the exact file paths, function names, signatures, and code in the plan. The
   plan is self-contained — every step has real code, no placeholders.
4. Commit after each task with the commit message given in that task's final step.

## Non-negotiable safety rules

- **Never** commit, print, paste, or log the contents of `kalshi_private.pem` or any
  `.env`. They are gitignored — keep it that way. If a command would echo a secret,
  mask it.
- **Never place a real-money order.** This work is validated on the Kalshi **demo**
  environment only. The production account exists and has a $0 balance — do not
  deposit, do not set `KALSHI_LIVE_CONFIRM`, do not run with `KALSHI_DEMO=false` +
  `EXECUTE_ORDERS=true`. All tests mock `fetch`; no test hits the network.
- The default behavior (`EXECUTE_ORDERS=false`) must stay byte-for-byte identical to
  today. Task 7 Step 5 verifies this — take it seriously.
- Do **not** introduce new stake or threshold values. Reuse the existing `RISK_*`
  env vars exactly. Sizing is `floor(RISK_ORDER_SIZE_USDC / askDollars)`, skip if < 1.
- Do **not** change the strategy, scoring, or calibration. This is execution plumbing
  only.

## Key facts already verified (don't re-verify against the live API)

- Kalshi auth signature = `RSA-PSS sign(timestamp + METHOD + path)`, salt length 32,
  body **not** signed → the same scheme works for POST. Reuse `kalshiHeaders` logic in
  `src/data/kalshi.js`.
- `POST /trade-api/v2/portfolio/orders` body: `{ ticker, side:"yes"|"no",
  action:"buy", count (whole≥1), yes_price|no_price (cents 1-99),
  time_in_force:"fill_or_kill", client_order_id }`.
- Demo base URL `https://external-api.demo.kalshi.co/trade-api/v2` is already selected
  by `KALSHI_DEMO=true` in `src/data/kalshi.js`. **The production key does NOT work on
  demo** — a separate demo API key + private key are required (the human will provide
  these later; they are not needed to write code or run the mocked tests).
- Existing patterns to mirror: `src/execution/bot.js`, `orders.js`, `position.js`
  (Polymarket execution) and `src/risk/guard.js` (reused as-is).

## Definition of done

- All 8 tasks committed; `node --test` green.
- `EXECUTE_ORDERS=false` run renders the dashboard exactly as before with no `REAL:`
  line and places no order.
- `npm run kalshi:btc:demo` exists and, without demo creds, shows a clear blocked/auth
  reason on the `REAL:` line while the paper dashboard still renders (no crash, no
  real order).
- Report back: a summary of what changed, the test count, and the exact remaining
  manual steps for the human (generate demo API key, set `KALSHI_DEMO_*` env vars,
  then run `npm run kalshi:btc:demo` to watch real demo orders fill and settle).

Do not proceed to production/live trading — that is a separate, human-gated phase
after demo validation succeeds.
