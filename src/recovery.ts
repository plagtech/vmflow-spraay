// Startup recovery.
//
// Rule from the brief: any pending/broadcast run older than N minutes gets its
// tx_hash checked ON-CHAIN before the worker does anything else. The chain is
// the source of truth — a run row that says "broadcast" only means we managed
// to write the row, and a row that says "pending" does not prove nothing was
// sent, only that we never got as far as recording it.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Chain } from "./chain.js";
import { lookupReceipt } from "./chain.js";
import { liveRuns, markConfirmed, markFailed, type RunRow } from "./db.js";
import { log } from "./log.js";

export const DEFAULT_STALE_MINUTES = 10;

export interface RecoveryOutcome {
  readonly runId: string;
  readonly action: "confirmed" | "failed" | "still-pending" | "needs-attention";
  readonly detail: string;
}

function ageMinutes(row: RunRow): number {
  return (Date.now() - new Date(row.created_at).getTime()) / 60_000;
}

export async function recover(
  db: SupabaseClient,
  chain: Chain,
  staleMinutes = DEFAULT_STALE_MINUTES,
): Promise<RecoveryOutcome[]> {
  const runs = await liveRuns(db);
  const outcomes: RecoveryOutcome[] = [];

  for (const run of runs) {
    const age = ageMinutes(run);
    if (age < staleMinutes) {
      outcomes.push({
        runId: run.id,
        action: "still-pending",
        detail: `${age.toFixed(1)}m old, under the ${staleMinutes}m stale window; leaving alone`,
      });
      continue;
    }

    if (run.tx_hash) {
      const receipt = await lookupReceipt(chain, run.tx_hash);

      if (!receipt) {
        // Broadcast, stale, and still not mined. Dropped from the mempool is the
        // likely story, but we cannot prove it, and re-sending risks a double
        // pay. Surface it for a human.
        outcomes.push({
          runId: run.id,
          action: "needs-attention",
          detail:
            `tx ${run.tx_hash} has no receipt after ${age.toFixed(1)}m. Check it on Basescan. ` +
            `If it never landed, mark the run failed and release it with "retry" by hand.`,
        });
        log.warn(`run ${run.id}: ${outcomes[outcomes.length - 1]!.detail}`);
        continue;
      }

      if (receipt.status === 1) {
        await markConfirmed(db, run.id, receipt.gasUsed);
        outcomes.push({
          runId: run.id,
          action: "confirmed",
          detail: `tx ${run.tx_hash} landed; run marked confirmed (gas ${receipt.gasUsed})`,
        });
        log.info(`recovered run ${run.id}: confirmed via ${run.tx_hash}`);
      } else {
        await markFailed(db, run.id, `batch transaction ${run.tx_hash} reverted (recovered)`);
        outcomes.push({
          runId: run.id,
          action: "failed",
          detail: `tx ${run.tx_hash} reverted; run marked failed`,
        });
        log.warn(`recovered run ${run.id}: reverted`);
      }
      continue;
    }

    // Pending with no hash: we died between claiming the sales and broadcasting.
    // Nothing was sent, so failing the run is safe — but the sales stay claimed
    // until an operator releases them with "retry", per the no-silent-double-pay
    // rule.
    await markFailed(
      db,
      run.id,
      `interrupted before broadcast (${age.toFixed(1)}m stale, no tx_hash); released on retry`,
    );
    outcomes.push({
      runId: run.id,
      action: "failed",
      detail: `pending with no tx_hash after ${age.toFixed(1)}m; marked failed, run "retry" to release its sales`,
    });
    log.warn(`recovered run ${run.id}: interrupted before broadcast, marked failed`);
  }

  return outcomes;
}
