// The payout cycle.
//
// Step order is load-bearing. The run row (step 4) is the idempotency anchor:
// once it exists, those sale ids are claimed, and a crash anywhere after it
// resumes rather than re-selecting them. Everything before it is free to fail.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Config } from "./config.js";
import { BASE_USDC } from "./config.js";
import type { Chain } from "./chain.js";
import {
  approveExact,
  broadcastVerbatim,
  currentAllowance,
  usdcBalance,
  waitForReceipt,
} from "./chain.js";
import {
  assertBatchMatches,
  estimateBatch,
  totalWithFeeRaw,
  executeBatch,
  makePayingFetch,
  type BatchRequest,
} from "./gateway.js";
import {
  insertPendingRun,
  markBroadcast,
  markConfirmed,
  markFailed,
  serialiseSplits,
  unsettledSales,
  type SaleRow,
} from "./db.js";
import { centsToRaw, dollarsToCents, formatUsdc } from "./money.js";
import { splitAmount, type SplitLine } from "./splits.js";
import { log } from "./log.js";

/** Cap on what one x402 call may pay. */
const MAX_X402_FEE_USD = "$0.10"; // execute is $0.02; this leaves headroom

const RECEIPT_TIMEOUT_MS = 5 * 60 * 1000;

export interface CycleResult {
  readonly settled: boolean;
  readonly reason?: string;
  readonly runId?: string;
  readonly txHash?: string;
  readonly totalRaw?: bigint;
}

export function totalRawFromSales(sales: readonly SaleRow[]): bigint {
  let cents = 0n;
  for (const sale of sales) cents += dollarsToCents(sale.item_price);
  return centsToRaw(cents);
}

export async function runCycle(
  db: SupabaseClient,
  chain: Chain,
  config: Config,
  options: { dryRun?: boolean } = {},
): Promise<CycleResult> {
  // 1. Unsettled sales.
  const sales = await unsettledSales(db);
  if (sales.length === 0) {
    log.info("no unsettled sales; nothing to do");
    return { settled: false, reason: "no unsettled sales" };
  }

  const totalRaw = totalRawFromSales(sales);
  log.info(`${sales.length} unsettled sales totalling ${formatUsdc(totalRaw)} USDC`);

  // 2. Threshold.
  if (totalRaw < config.thresholdRaw) {
    const reason =
      `below threshold (${formatUsdc(totalRaw)} < ${formatUsdc(config.thresholdRaw)} USDC)`;
    log.info(`skipping cycle: ${reason}`);
    return { settled: false, reason };
  }

  // 3. Splits — exact, no dust.
  const lines = splitAmount(totalRaw, config.splits);
  for (const line of lines) {
    log.info(`  ${line.label.padEnd(20)} ${line.bps} bps  ${formatUsdc(line.raw)} -> ${line.wallet}`);
  }

  const request: BatchRequest = {
    token: "USDC",
    recipients: lines.map((line) => line.wallet),
    amounts: lines.map((line) => line.raw.toString()),
    sender: chain.address,
  };

  if (options.dryRun) {
    log.info("dry run: stopping before any payment");
    return { settled: false, reason: "dry run", totalRaw };
  }

  const payingFetch = await makePayingFetch(chain.wallet, MAX_X402_FEE_USD);

  // Optional pre-flight gas estimate ($0.001). Advisory only; a failure here
  // must not claim the sales, so it happens before the run row exists.
  //
  // OFF by default, and not merely to save $0.001: the live gateway answers a
  // second paid call from the same payer, seconds after the first, with HTTP
  // 409 duplicate_payment_detected. Estimating immediately before executing is
  // exactly that pattern, so the default path makes exactly ONE paid call per
  // cycle — the execute that actually moves money. Enable preflightEstimate
  // only once the window is understood against a funded wallet.
  let estimate: unknown = null;
  if (config.preflightEstimate) {
    try {
      estimate = await estimateBatch(payingFetch, config.gatewayUrl, request);
      log.info(`gas estimate: ${JSON.stringify(estimate)}`);
    } catch (error) {
      log.warn(`estimate failed (continuing, it is advisory): ${(error as Error).message}`);
    }
  }

  // 4. Idempotency anchor. From here on, these sales are claimed.
  const saleIds = sales.map((sale) => sale.id);
  const run = await insertPendingRun(db, saleIds, serialiseSplits(lines), estimate);
  log.info(`run ${run.id} pending, claiming ${saleIds.length} sales`);

  try {
    return await settleRun(db, chain, config, run.id, request, totalRaw, lines, payingFetch);
  } catch (error) {
    const message = (error as Error).message;
    log.error(`run ${run.id} failed: ${message}`);
    await markFailed(db, run.id, message);
    throw error;
  }
}

async function settleRun(
  db: SupabaseClient,
  chain: Chain,
  config: Config,
  runId: string,
  request: BatchRequest,
  totalRaw: bigint,
  lines: readonly SplitLine[],
  payingFetch: Awaited<ReturnType<typeof makePayingFetch>>,
): Promise<CycleResult> {
  // 5. Execute ($0.02) -> unsigned transaction.
  const response = await executeBatch(payingFetch, config.gatewayUrl, request);
  assertBatchMatches(response, totalRaw);
  log.info(
    `gateway quoted total ${response.batch.totalAmount}, fee ${response.batch.fee} ` +
      `(${response.batch.feePercent}), totalWithFee ${response.batch.totalWithFee}`,
  );

  // Balance check before spending gas on an approval that cannot settle.
  const needed = totalWithFeeRaw(response);
  const balance = await usdcBalance(chain, BASE_USDC);
  if (balance < needed) {
    throw new Error(
      `operator USDC balance ${formatUsdc(balance)} is short of ${formatUsdc(needed)} ` +
        `(payout + gateway fee). Fund ${chain.address} and retry this run.`,
    );
  }

  // 6. Allowance — approve the gateway's fee-inclusive figure verbatim.
  let approvalNonce: number | undefined;
  if (response.approvalRequired) {
    const { spender, amount, token } = response.approvalRequired;
    const required = BigInt(amount);
    const existing = await currentAllowance(chain, token, spender);

    if (existing < required) {
      log.info(`allowance ${existing} < ${required}; approving exactly ${required} to ${spender}`);
      const approval = await approveExact(chain, token, spender, required);
      approvalNonce = approval.nonce;
      log.info(`approve confirmed in ${approval.receipt.hash} (nonce ${approval.nonce})`);
    } else {
      log.info(`allowance ${existing} already covers ${required}; no approval needed`);
    }
  }

  // 7. Sign + broadcast verbatim, then record the hash IMMEDIATELY.
  const txHash = await broadcastVerbatim(
    chain,
    response.transaction,
    approvalNonce === undefined ? undefined : approvalNonce + 1,
  );
  await markBroadcast(db, runId, txHash);
  log.info(`run ${runId} broadcast: ${txHash}`);

  // 8. Receipt.
  const receipt = await waitForReceipt(chain, txHash, RECEIPT_TIMEOUT_MS);
  if (!receipt) {
    throw new Error(
      `no receipt for ${txHash} within ${RECEIPT_TIMEOUT_MS / 1000}s. The run stays claimed; ` +
        `re-run "recover" once the transaction settles.`,
    );
  }
  if (receipt.status !== 1) {
    throw new Error(`batch transaction ${txHash} reverted`);
  }

  await markConfirmed(db, runId, receipt.gasUsed);
  log.info(
    `run ${runId} confirmed in ${txHash}, gas ${receipt.gasUsed}, ` +
      `${lines.length} recipients paid ${formatUsdc(totalRaw)} USDC`,
  );

  return { settled: true, runId, txHash, totalRaw };
}
