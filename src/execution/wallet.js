import { ethers } from "ethers";
import { ClobClient, getContractConfig } from "@polymarket/clob-client";
import fs from "node:fs";
import path from "node:path";

const CHAIN_ID = 137;
const CLOB_HOST = "https://clob.polymarket.com";
const CREDS_FILE = path.join(process.cwd(), "logs", "clob_creds.json");

const USDC_ABI = [
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)"
];

const CTF_ABI = [
  "function isApprovedForAll(address account, address operator) view returns (bool)",
  "function setApprovalForAll(address operator, bool approved)"
];

function loadCredsFromFile() {
  try {
    if (fs.existsSync(CREDS_FILE)) {
      return JSON.parse(fs.readFileSync(CREDS_FILE, "utf8"));
    }
  } catch {
    return null;
  }
  return null;
}

function saveCredsToFile(creds) {
  fs.mkdirSync(path.dirname(CREDS_FILE), { recursive: true });
  fs.writeFileSync(CREDS_FILE, JSON.stringify(creds, null, 2), "utf8");
}

function buildSigner(wallet) {
  // ethers v6 compatibility: clob-client internally calls _signTypedData (v5 style)
  return {
    _signTypedData: wallet.signTypedData.bind(wallet),
    getAddress: () => Promise.resolve(wallet.address)
  };
}

export function createWallet() {
  const key = process.env.WALLET_PRIVATE_KEY;
  if (!key || !key.trim()) throw new Error("WALLET_PRIVATE_KEY não está definido no .env");
  return new ethers.Wallet(key.trim());
}

export async function initClient() {
  const wallet = createWallet();
  const signer = buildSigner(wallet);
  const sigType = Number(process.env.WALLET_SIGNATURE_TYPE ?? 0);
  const funder = process.env.WALLET_ADDRESS?.trim() || undefined;

  let creds = loadCredsFromFile();

  if (!creds) {
    console.log("[wallet] Derivando credenciais L2 da carteira (apenas na primeira vez)...");
    const l1Client = new ClobClient(CLOB_HOST, CHAIN_ID, signer, undefined, sigType, funder);
    creds = await l1Client.createOrDeriveApiKey();
    saveCredsToFile(creds);
    console.log("[wallet] Credenciais salvas em logs/clob_creds.json");
  }

  const client = new ClobClient(CLOB_HOST, CHAIN_ID, signer, creds, sigType, funder);
  return { client, wallet, creds };
}

export async function checkAllowances(wallet) {
  const contracts = getContractConfig(CHAIN_ID);
  const rpcUrl = process.env.POLYGON_RPC_URL || "https://polygon-rpc.com";
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const connected = wallet.connect(provider);

  const usdc = new ethers.Contract(contracts.collateral, USDC_ABI, connected);
  const ctf = new ethers.Contract(contracts.conditionalTokens, CTF_ABI, connected);

  const [allowCtf, allowExchange, ctfApproved] = await Promise.all([
    usdc.allowance(wallet.address, contracts.conditionalTokens),
    usdc.allowance(wallet.address, contracts.exchange),
    ctf.isApprovedForAll(wallet.address, contracts.exchange)
  ]);

  const needs = [];
  if (allowCtf === 0n) needs.push("USDC → ConditionalTokens");
  if (allowExchange === 0n) needs.push("USDC → Exchange");
  if (!ctfApproved) needs.push("CTF → Exchange");

  if (needs.length === 0) {
    console.log("[wallet] Aprovações on-chain OK");
    return true;
  }

  console.log(`[wallet] Configurando aprovações: ${needs.join(", ")}`);

  if (allowCtf === 0n) {
    const tx = await usdc.approve(contracts.conditionalTokens, ethers.MaxUint256);
    await tx.wait();
  }
  if (allowExchange === 0n) {
    const tx = await usdc.approve(contracts.exchange, ethers.MaxUint256);
    await tx.wait();
  }
  if (!ctfApproved) {
    const tx = await ctf.setApprovalForAll(contracts.exchange, true);
    await tx.wait();
  }

  console.log("[wallet] Aprovações configuradas com sucesso");
  return true;
}

export async function getUsdcBalance(client) {
  try {
    const { AssetType } = await import("@polymarket/clob-client");
    const result = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    const raw = Number(result?.balance ?? 0);
    return raw / 1e6;
  } catch {
    return null;
  }
}
