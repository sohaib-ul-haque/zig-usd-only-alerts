import "dotenv/config";
import { decimalToRaw } from "./amount";

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

// Primary URL plus an optional comma-separated list of fallbacks from
// `${backupKey}`, e.g. ZIG_RPC_WS_BACKUP="wss://a,wss://b". The monitor
// rotates through this list in order whenever the active connection drops.
function urlList(primary: string, backupKey: string): string[] {
  const backups = (process.env[backupKey] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return [primary, ...backups];
}

export interface AssetConfig {
  symbol: string;
  denom: string; // full on-chain denom, used to match transfer.amount events
  displayDenom: string; // short label shown in the alert text
  decimals: number;
  minThresholdRaw: bigint;
  coingeckoId: string | null; // null = no USD line for this asset
}

function assetConfig(
  symbol: string,
  denomKey: string,
  displayDenom: string,
  decimalsKey: string,
  thresholdKey: string,
  coingeckoId: string | null
): AssetConfig {
  const decimals = parseInt(requireEnv(decimalsKey), 10);
  if (!Number.isSafeInteger(decimals) || decimals < 0) {
    throw new Error(`Invalid ${decimalsKey}: ${requireEnv(decimalsKey)}`);
  }

  return {
    symbol,
    denom: requireEnv(denomKey),
    displayDenom,
    decimals,
    minThresholdRaw: decimalToRaw(requireEnv(thresholdKey), decimals),
    coingeckoId,
  };
}

export const config = {
  telegram: {
    botToken: requireEnv("ONCHAIN_BOT_TOKEN"),
    chatId: requireEnv("ALERT_CHAT_ID"), // fixed supergroup, e.g. -1004399156891
  },
  rpc: {
    http: requireEnv("ZIG_RPC_HTTP"),
    wsUrls: urlList(requireEnv("ZIG_RPC_WS"), "ZIG_RPC_WS_BACKUP"),
    timeoutMs: parseInt(process.env.RPC_TIMEOUT_MS ?? "10000"),
  },
  txExplorer: requireEnv("TX_EXPLORER"),
  assets: [
    assetConfig(
      "ZIG",
      "ZIG_DENOM",
      requireEnv("ZIG_DENOM"),
      "ZIG_DECIMALS",
      "THRESHOLD_ZIG",
      process.env.COINGECKO_ID ?? "zignaly"
    ),
    assetConfig(
      "stZIG",
      "STZIG_DENOM",
      process.env.STZIG_DISPLAY_DENOM ?? "stzig",
      "STZIG_DECIMALS",
      "THRESHOLD_STZIG",
      process.env.STZIG_COINGECKO_ID ?? "staked-zig"
    ),
  ] as AssetConfig[],
  price: {
    cacheMs: parseInt(process.env.PRICE_CACHE_MS ?? "60000"),
  },
};
