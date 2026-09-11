// On-chain operations, all signed locally with the operator key.
//
// The key is loaded once into an ethers Wallet and never leaves this process.
// Nothing here logs it, and nothing persists it.

import { Contract, JsonRpcProvider, Wallet, type TransactionReceipt } from "ethers";
import { BASE_CHAIN_ID } from "./config.js";
import type { UnsignedBatchTx } from "./gateway.js";

const ERC20_ABI = [
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

export interface Chain {
  readonly wallet: Wallet;
  readonly provider: JsonRpcProvider;
  readonly address: string;
}

export async function connectChain(privateKey: string, rpcUrl: string): Promise<Chain> {
  const provider = new JsonRpcProvider(rpcUrl, Number(BASE_CHAIN_ID), {
    staticNetwork: true,
  });
  const wallet = new Wallet(privateKey, provider);

  const network = await provider.getNetwork();
  if (network.chainId !== BASE_CHAIN_ID) {
    throw new Error(
      `RPC is chain ${network.chainId}, expected Base (${BASE_CHAIN_ID}). ` +
        `Worker v1 is Base/USDC only — check BASE_RPC_URL.`,
    );
  }

  return { wallet, provider, address: await wallet.getAddress() };
}

export async function usdcBalance(chain: Chain, token: string): Promise<bigint> {
  const erc20 = new Contract(token, ERC20_ABI, chain.provider);
  return (await erc20["balanceOf"]!(chain.address)) as bigint;
}

export async function currentAllowance(
  chain: Chain,
  token: string,
  spender: string,
): Promise<bigint> {
  const erc20 = new Contract(token, ERC20_ABI, chain.provider);
  return (await erc20["allowance"]!(chain.address, spender)) as bigint;
}

/**
 * Approve exactly `amount` — the fee-inclusive figure the gateway returned.
 * Deliberately NOT an infinite approval: this worker asks a vending operator to
 * point a key at a contract, and a bounded allowance is the difference between
 * "it can move this cycle's payout" and "it can move everything, forever".
 */
export async function approveExact(
  chain: Chain,
  token: string,
  spender: string,
  amount: bigint,
): Promise<{ receipt: TransactionReceipt; nonce: number }> {
  const erc20 = new Contract(token, ERC20_ABI, chain.wallet);
  const tx = await erc20["approve"]!(spender, amount);
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) {
    throw new Error(`approve(${spender}, ${amount}) reverted (tx ${tx.hash})`);
  }
  return { receipt: receipt as TransactionReceipt, nonce: tx.nonce as number };
}

/**
 * Sign and broadcast the gateway's transaction VERBATIM — to/data/value/gasLimit
 * exactly as given. Only nonce, fees and chainId are ours to fill in. Rewriting
 * any of the gateway's fields would mean broadcasting a batch it never priced.
 */
export async function broadcastVerbatim(
  chain: Chain,
  tx: UnsignedBatchTx,
  minNonce?: number,
): Promise<string> {
  // `pending` can still report the nonce the approval just consumed: the
  // receipt is in hand before the node's pending count catches up, and sending
  // the batch on that nonce is rejected REPLACEMENT_UNDERPRICED (observed on
  // Base). When an approval preceded us, never go below its nonce + 1.
  const pending = await chain.provider.getTransactionCount(chain.address, "pending");
  const nonce = minNonce === undefined ? pending : Math.max(pending, minNonce);
  const fees = await chain.provider.getFeeData();

  const sent = await chain.wallet.sendTransaction({
    to: tx.to,
    data: tx.data,
    value: BigInt(tx.value === "" ? "0" : tx.value),
    gasLimit: BigInt(tx.gasLimit),
    chainId: BASE_CHAIN_ID,
    nonce,
    ...(fees.maxFeePerGas != null && fees.maxPriorityFeePerGas != null
      ? { maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas }
      : {}),
  });

  return sent.hash;
}

export async function waitForReceipt(
  chain: Chain,
  hash: string,
  timeoutMs: number,
): Promise<TransactionReceipt | null> {
  return chain.provider.waitForTransaction(hash, 1, timeoutMs);
}

/** Startup recovery: has this hash already landed? */
export async function lookupReceipt(chain: Chain, hash: string): Promise<TransactionReceipt | null> {
  return chain.provider.getTransactionReceipt(hash);
}
