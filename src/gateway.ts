// Spraay gateway client.
//
// Two endpoints, both x402-paywalled, both paid with the operator key via the
// standard X-PAYMENT header flow (wrapFetchWithPayment). That $0.001 / $0.02
// fee is a SEPARATE payment from the batch itself — never conflate the two.
//
//   POST /api/v1/batch/estimate  $0.001  -> gas estimate
//   POST /api/v1/batch/execute   $0.02   -> an UNSIGNED transaction
//
// The worker signs and broadcasts that transaction itself, with the operator
// key, on the operator's own box. The gateway never holds funds and never sees
// a key. That property is the whole point of this worker, so parseExecute below
// refuses to proceed on anything it does not recognise rather than adapting to
// a response shape it was not built for.

import type { Wallet } from "ethers";
import { BASE_CHAIN_ID } from "./config.js";

export interface BatchRequest {
  readonly token: "USDC";
  readonly recipients: readonly string[];
  readonly amounts: readonly string[]; // RAW base units, 6dp for USDC
  readonly sender: string;
}

export interface UnsignedBatchTx {
  readonly to: string;
  readonly data: string;
  readonly value: string;
  readonly chainId: number;
  readonly gasLimit: string;
}

export interface ApprovalRequired {
  readonly token: string;
  readonly spender: string;
  /** Fee-INCLUSIVE raw allowance. Use verbatim; do not recompute. */
  readonly amount: string;
}

export interface BatchSummary {
  readonly totalAmount: string;
  readonly fee: string;
  readonly feePercent: string;
  readonly totalWithFee: string;
}

export interface ExecuteResponse {
  readonly transaction: UnsignedBatchTx;
  readonly batch: BatchSummary;
  readonly approvalRequired: ApprovalRequired | undefined;
  readonly raw: unknown;
}

/**
 * Thrown when the gateway answers with something the verified contract does not
 * describe. The brief's rule: stop and report, never adapt silently. Adapting
 * here could mean paying a batch twice, or trusting a hash the operator's own
 * key never signed.
 */
export class GatewayContractError extends Error {
  readonly body: unknown;

  constructor(message: string, body: unknown) {
    super(
      message +
        "\n\nThis does not match the verified Spraay batch contract. The worker is " +
        "stopping rather than adapting to an unrecognised response.\nGateway response:\n" +
        JSON.stringify(body, null, 2),
    );
    this.name = "GatewayContractError";
    this.body = body;
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Adapt an ethers Wallet to the ClientEvmSigner the x402 EVM scheme expects.
 *
 * The scheme asks for a viem-shaped `signTypedData({domain, types, primaryType,
 * message})`; ethers takes three positional arguments and derives the primary
 * type itself, rejecting an explicit EIP712Domain entry in `types`.
 */
function toClientEvmSigner(wallet: Wallet) {
  return {
    address: wallet.address as `0x${string}`,
    async signTypedData(message: {
      domain: Record<string, unknown>;
      types: Record<string, unknown>;
      primaryType: string;
      message: Record<string, unknown>;
    }): Promise<`0x${string}`> {
      const types = { ...message.types };
      delete types["EIP712Domain"];
      return (await wallet.signTypedData(
        message.domain as never,
        types as never,
        message.message as never,
      )) as `0x${string}`;
    },
  };
}

/**
 * Build a fetch that answers 402s by signing an X-PAYMENT header with the
 * operator key.
 *
 * Uses the scoped @x402/* v2 packages, not the unscoped `x402-fetch`: this
 * gateway speaks x402 v2 with CAIP-2 network ids (`eip155:8453`), and the
 * unscoped client's schema only admits protocol v1 and legacy names like
 * "base" — it rejects the 402 before any payment is attempted. Verified
 * against the live gateway; see README "Verifying the x402 client".
 *
 * `maxUsdPerPayment` caps a single call, so a gateway that suddenly quotes $50
 * gets refused rather than paid.
 */
export async function makePayingFetch(
  wallet: Wallet,
  maxUsdPerPayment: string,
): Promise<FetchLike> {
  const { wrapFetchWithPaymentFromConfig } = await import("@x402/fetch");
  const { ExactEvmScheme } = await import("@x402/evm");

  return wrapFetchWithPaymentFromConfig(fetch, {
    schemes: [
      { network: "eip155:8453", client: new ExactEvmScheme(toClientEvmSigner(wallet)) as never },
    ],
    spendControls: { maxAmountPerPayment: maxUsdPerPayment as never },
  }) as unknown as FetchLike;
}

async function postJson(
  payingFetch: FetchLike,
  url: string,
  body: BatchRequest,
): Promise<{ status: number; body: unknown }> {
  const response = await payingFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new GatewayContractError("gateway returned non-JSON (HTTP " + response.status + ")", text);
  }

  if (!response.ok) {
    throw new GatewayContractError("gateway returned HTTP " + response.status, parsed);
  }
  return { status: response.status, body: parsed };
}

export async function estimateBatch(
  payingFetch: FetchLike,
  gatewayUrl: string,
  request: BatchRequest,
): Promise<unknown> {
  const { body } = await postJson(payingFetch, gatewayUrl + "/api/v1/batch/estimate", request);
  return body;
}

export async function executeBatch(
  payingFetch: FetchLike,
  gatewayUrl: string,
  request: BatchRequest,
): Promise<ExecuteResponse> {
  const { body } = await postJson(payingFetch, gatewayUrl + "/api/v1/batch/execute", request);
  return parseExecute(body);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Validate a /batch/execute response against the verified contract.
 *
 * Deliberately strict. In particular, a response carrying broadcast
 * transactions (a transactions[] array with hashes) instead of one unsigned
 * transaction means the gateway broadcast on our behalf — a different trust
 * model than this worker implements — and is treated as a hard stop.
 */
export function parseExecute(body: unknown): ExecuteResponse {
  if (typeof body !== "object" || body === null) {
    throw new GatewayContractError("execute response is not an object", body);
  }
  const root = body as Record<string, unknown>;

  if (root["transaction"] === undefined && Array.isArray(root["transactions"])) {
    throw new GatewayContractError(
      "execute returned a broadcast transactions[] array, not an unsigned transaction. " +
        "This worker signs and broadcasts locally with the operator key and cannot vouch for " +
        "a transaction it did not sign",
      body,
    );
  }

  const tx = root["transaction"];
  if (typeof tx !== "object" || tx === null) {
    throw new GatewayContractError("execute response has no transaction object", body);
  }
  const txRecord = tx as Record<string, unknown>;

  const to = str(txRecord["to"]);
  const data = str(txRecord["data"]);
  if (!to) throw new GatewayContractError("transaction.to is missing", body);
  if (!data) throw new GatewayContractError("transaction.data is missing", body);

  const chainId = txRecord["chainId"];
  const chainIdBig =
    typeof chainId === "number"
      ? BigInt(chainId)
      : typeof chainId === "string"
        ? BigInt(chainId)
        : undefined;
  if (chainIdBig === undefined) {
    throw new GatewayContractError("transaction.chainId is missing", body);
  }
  if (chainIdBig !== BASE_CHAIN_ID) {
    throw new GatewayContractError(
      "transaction.chainId is " + chainIdBig + ", expected Base (" + BASE_CHAIN_ID +
        "); worker v1 is Base/USDC only",
      body,
    );
  }

  const gasLimit = str(txRecord["gasLimit"]);
  if (!gasLimit) throw new GatewayContractError("transaction.gasLimit is missing", body);

  const batch = root["batch"];
  if (typeof batch !== "object" || batch === null) {
    throw new GatewayContractError("execute response has no batch summary", body);
  }
  const batchRecord = batch as Record<string, unknown>;
  const totalAmount = str(batchRecord["totalAmount"]);
  const totalWithFee = str(batchRecord["totalWithFee"]);
  if (!totalAmount) throw new GatewayContractError("batch.totalAmount is missing", body);
  if (!totalWithFee) throw new GatewayContractError("batch.totalWithFee is missing", body);

  let approvalRequired: ApprovalRequired | undefined;
  const approval = root["approvalRequired"];
  if (approval !== undefined && approval !== null) {
    if (typeof approval !== "object") {
      throw new GatewayContractError("approvalRequired is not an object", body);
    }
    const approvalRecord = approval as Record<string, unknown>;
    const spender = str(approvalRecord["spender"]);
    const amount = str(approvalRecord["amount"]);
    const token = str(approvalRecord["token"]);
    if (!spender || !amount || !token) {
      throw new GatewayContractError("approvalRequired is missing token/spender/amount", body);
    }
    approvalRequired = { token, spender, amount };
  }

  return {
    transaction: {
      to,
      data,
      value: str(txRecord["value"]) ?? "0x0",
      chainId: Number(chainIdBig),
      gasLimit,
    },
    batch: {
      totalAmount,
      fee: str(batchRecord["fee"]) ?? "0",
      feePercent: str(batchRecord["feePercent"]) ?? "unknown",
      totalWithFee,
    },
    approvalRequired,
    raw: body,
  };
}

/**
 * The batch the gateway priced must be the batch we computed. A mismatch means
 * the request was altered in flight or the gateway reinterpreted our amounts.
 */
export function assertBatchMatches(response: ExecuteResponse, expectedTotalRaw: bigint): void {
  let quoted: bigint;
  try {
    quoted = BigInt(response.batch.totalAmount);
  } catch {
    throw new GatewayContractError(
      "batch.totalAmount is not an integer: " + response.batch.totalAmount,
      response.raw,
    );
  }
  if (quoted !== expectedTotalRaw) {
    throw new GatewayContractError(
      "gateway priced " + quoted + " raw units but the cycle computed " + expectedTotalRaw,
      response.raw,
    );
  }
}
