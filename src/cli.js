import { spawn } from "node:child_process";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

export const MENU_OPTIONS = [
  {
    key: "1",
    label: "Polymarket BTC 5m",
    command: process.execPath,
    args: ["--env-file=.env", "src/index.js"],
    env: { EXECUTE_ORDERS: "false", PAPER_TRADING: "true", CANDLE_WINDOW_MINUTES: "5" }
  },
  {
    key: "2",
    label: "Polymarket BTC 15m",
    command: process.execPath,
    args: ["--env-file=.env", "src/index.js"],
    env: { EXECUTE_ORDERS: "false", PAPER_TRADING: "true", CANDLE_WINDOW_MINUTES: "15" }
  },
  {
    key: "3",
    label: "Kalshi BTC 15m",
    command: process.execPath,
    args: ["--env-file=.env", "src/index-kalshi.js"],
    env: { EXECUTE_ORDERS: "false", PAPER_TRADING: "true", KALSHI_SERIES: "KXBTC15M", PAPER_LOG_PREFIX: "kalshi_btc_" }
  },
  {
    key: "4",
    label: "Kalshi ETH 15m",
    command: process.execPath,
    args: ["--env-file=.env", "src/index-kalshi.js"],
    env: { EXECUTE_ORDERS: "false", PAPER_TRADING: "true", KALSHI_SERIES: "KXETH15M", PAPER_LOG_PREFIX: "kalshi_eth_" }
  },
  {
    key: "5",
    label: "Kalshi SOL 15m",
    command: process.execPath,
    args: ["--env-file=.env", "src/index-kalshi.js"],
    env: { EXECUTE_ORDERS: "false", PAPER_TRADING: "true", KALSHI_SERIES: "KXSOL15M", PAPER_LOG_PREFIX: "kalshi_sol_" }
  },
  {
    key: "6",
    label: "Analyze paper results",
    command: process.execPath,
    args: ["scripts/analyze-paper.js"],
    env: {}
  },
  {
    key: "7",
    label: "Run tests",
    command: "npm",
    args: ["test"],
    env: {}
  }
];

export function findMenuOption(choice) {
  return MENU_OPTIONS.find((option) => option.key === String(choice).trim()) ?? null;
}

export function buildRunnerEnv(option, baseEnv = process.env) {
  return { ...baseEnv, ...(option?.env ?? {}) };
}

function renderMenu() {
  const lines = [
    "",
    "Polymarket/Kalshi Paper Trading",
    "",
    ...MENU_OPTIONS.map((option) => `${option.key}. ${option.label}`),
    "0. Exit",
    ""
  ];
  return lines.join("\n");
}

function runOption(option) {
  return new Promise((resolve) => {
    const child = spawn(option.command, option.args, {
      cwd: process.cwd(),
      env: buildRunnerEnv(option),
      stdio: "inherit"
    });

    child.on("exit", (code, signal) => {
      if (signal) {
        resolve(128);
        return;
      }
      resolve(code ?? 0);
    });
  });
}

export async function main() {
  const rl = readline.createInterface({ input, output });
  try {
    output.write(renderMenu());
    const answer = await rl.question("Choose an option: ");
    const choice = answer.trim();

    if (choice === "0" || choice.toLowerCase() === "q") {
      return 0;
    }

    const option = findMenuOption(choice);
    if (!option) {
      output.write(`Invalid option: ${choice}\n`);
      return 1;
    }

    output.write(`Starting ${option.label}...\n`);
    return await runOption(option);
  } finally {
    rl.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const code = await main();
  process.exit(code);
}
