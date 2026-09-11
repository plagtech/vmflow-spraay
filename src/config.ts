// Configuration: payout.config.json + environment.
//
// Secrets are NEVER in the config file. The config names the env vars that hold
// them; the values are read from the environment and never logged or persisted.

import { readFileSync } from "node:fs";
import { isAddress, getAddress } from "ethers";
import { assertSplitRules, type SplitRule } from "./splits.js";
import { usdThresholdToRaw } from "./money.js";

export const DEFAULT_GATEWAY_URL = "https://gateway.spraay.app";

/** USDC on Base (6dp). The gateway hardcodes chain 8453; worker v1 matches it. */
export const BASE_CHAIN_ID = 8453n;
export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

export interface RawConfig {
  supabase: { url: string; serviceRoleKeyEnv: string };
  operator: { privateKeyEnv: string; rpcUrlEnv: string };
  splits: Array<{ label: string; wallet: string; bps: number }>;
  schedule?: { cron?: string; minPayoutUsd?: string | number };
  /** Pre-flight $0.001 gas estimate. Off by default; see README. */
  preflightEstimate?: boolean;
  gatewayUrl?: string;
}

export interface Config {
  readonly supabaseUrl: string;
  readonly supabaseServiceRoleKey: string;
  readonly operatorPrivateKey: string;
  readonly rpcUrl: string;
  readonly splits: readonly SplitRule[];
  readonly cron: string | undefined;
  readonly thresholdRaw: bigint;
  readonly gatewayUrl: string;
  readonly preflightEstimate: boolean;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`env ${name} is not set (named by payout.config.json)`);
  }
  return value.trim();
}

/**
 * Resolve a split rule's `wallet` field. Three accepted forms:
 *
 *   "0x..."                 a literal address
 *   "env:PAYOUT_RECIPIENT_2" read the address out of that env var
 *   "operator"              the operator's own wallet, derived from the
 *                           operator private key
 *
 * The "operator" form exists because a split almost always pays the operator
 * their own share, and duplicating that address into the config invites it
 * drifting away from the key that actually signs.
 */
export function resolveWallet(wallet: string, operatorAddress: string): string {
  const value = wallet.trim();

  if (value.toLowerCase() === "operator") return operatorAddress;

  const resolved = value.startsWith("env:") ? requireEnv(value.slice(4)) : value;

  if (!isAddress(resolved)) {
    const source = value.startsWith("env:") ? ` (from ${value})` : "";
    throw new Error(`split wallet is not a valid address: ${resolved}${source}`);
  }
  return getAddress(resolved);
}

export function loadConfig(path: string, operatorAddress: string): Config {
  let raw: RawConfig;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as RawConfig;
  } catch (error) {
    throw new Error(`cannot read ${path}: ${(error as Error).message}`);
  }

  if (!raw.supabase?.url) throw new Error("payout.config.json: supabase.url is required");
  if (!raw.supabase?.serviceRoleKeyEnv) {
    throw new Error("payout.config.json: supabase.serviceRoleKeyEnv is required");
  }
  if (!Array.isArray(raw.splits) || raw.splits.length === 0) {
    throw new Error("payout.config.json: splits[] is required");
  }

  const splits: SplitRule[] = raw.splits.map((rule) => {
    if (!rule?.label) throw new Error("payout.config.json: every split needs a label");
    return {
      label: rule.label,
      wallet: resolveWallet(rule.wallet, operatorAddress),
      bps: rule.bps,
    };
  });
  assertSplitRules(splits);

  return {
    supabaseUrl: raw.supabase.url,
    supabaseServiceRoleKey: requireEnv(raw.supabase.serviceRoleKeyEnv),
    operatorPrivateKey: requireEnv(raw.operator?.privateKeyEnv ?? "OPERATOR_PRIVATE_KEY"),
    rpcUrl: requireEnv(raw.operator?.rpcUrlEnv ?? "BASE_RPC_URL"),
    splits,
    cron: raw.schedule?.cron,
    thresholdRaw: usdThresholdToRaw(raw.schedule?.minPayoutUsd ?? "0"),
    gatewayUrl: (raw.gatewayUrl ?? DEFAULT_GATEWAY_URL).replace(/\/+$/, ""),
    preflightEstimate: raw.preflightEstimate === true,
  };
}

/** Read the operator key before the config, so "operator" splits can resolve. */
export function operatorPrivateKeyFromEnv(envName = "OPERATOR_PRIVATE_KEY"): string {
  return requireEnv(envName);
}
