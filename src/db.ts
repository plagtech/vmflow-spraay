// The operator's own Supabase. Additive only: we READ `sales` and we own exactly
// one new table, `spraay_payout_runs`. Nothing in VMflow's schema is modified.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { SplitLine } from "./splits.js";

export type RunStatus = "pending" | "broadcast" | "confirmed" | "failed";

export interface SaleRow {
  readonly id: string;
  readonly item_price: string | number;
  readonly machine_id: string | null;
  readonly owner_id: string | null;
}

export interface RunRow {
  readonly id: string;
  readonly created_at: string;
  readonly sale_ids: string[];
  readonly splits: unknown;
  readonly status: RunStatus;
  readonly x402_estimate: unknown;
  readonly tx_hash: string | null;
  readonly gas_used: string | null;
  readonly error: string | null;
}

export interface PersistedSplit {
  readonly label: string;
  readonly wallet: string;
  readonly bps: number;
  readonly raw: string; // bigint does not survive JSON; store the decimal string
}

export function serialiseSplits(lines: readonly SplitLine[]): PersistedSplit[] {
  return lines.map((line) => ({
    label: line.label,
    wallet: line.wallet,
    bps: line.bps,
    raw: line.raw.toString(),
  }));
}

export function connectDb(url: string, serviceRoleKey: string): SupabaseClient {
  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Sale ids already spoken for by ANY run that still holds them — including
 * `failed` ones.
 *
 * A failed run keeps its claim on purpose. "Failed" here means the worker could
 * not prove the batch settled, which is not the same as proving it did not: a
 * receipt timeout at step 8 leaves a transaction that may still land minutes
 * later. Releasing those sales automatically is precisely how the next cycle
 * pays them a second time. The only way out is `retry`, which clears the run's
 * sale_ids after a human has checked the chain.
 */
export async function claimedSaleIds(db: SupabaseClient): Promise<Set<string>> {
  const { data, error } = await db
    .from("spraay_payout_runs")
    .select("sale_ids")
    .in("status", ["pending", "broadcast", "confirmed", "failed"]);

  if (error) throw new Error(`reading spraay_payout_runs: ${error.message}`);

  const claimed = new Set<string>();
  for (const row of data ?? []) {
    for (const id of (row as { sale_ids: string[] }).sale_ids ?? []) claimed.add(id);
  }
  return claimed;
}

/**
 * Unsettled sales = every sale not claimed by a live run.
 *
 * The claimed-set is read first and filtered here rather than in SQL, because
 * the sale ids live in a uuid[] column on our table and VMflow's `sales` table
 * has no column of ours to join on. Additive-only means we do not add one.
 */
export async function unsettledSales(db: SupabaseClient, limit = 5000): Promise<SaleRow[]> {
  const claimed = await claimedSaleIds(db);

  const { data, error } = await db
    .from("sales")
    .select("id, item_price, machine_id, owner_id")
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error) throw new Error(`reading sales: ${error.message}`);

  return (data ?? []).filter((row) => !claimed.has((row as SaleRow).id)) as SaleRow[];
}

export async function insertPendingRun(
  db: SupabaseClient,
  saleIds: readonly string[],
  splits: readonly PersistedSplit[],
  estimate: unknown,
): Promise<RunRow> {
  const { data, error } = await db
    .from("spraay_payout_runs")
    .insert({
      sale_ids: saleIds,
      splits,
      status: "pending" satisfies RunStatus,
      x402_estimate: estimate ?? null,
    })
    .select()
    .single();

  if (error) throw new Error(`inserting payout run: ${error.message}`);
  return data as RunRow;
}

export async function markBroadcast(
  db: SupabaseClient,
  runId: string,
  txHash: string,
): Promise<void> {
  const { error } = await db
    .from("spraay_payout_runs")
    .update({ status: "broadcast" satisfies RunStatus, tx_hash: txHash })
    .eq("id", runId);
  if (error) throw new Error(`marking run ${runId} broadcast: ${error.message}`);
}

export async function markConfirmed(
  db: SupabaseClient,
  runId: string,
  gasUsed: bigint,
): Promise<void> {
  const { error } = await db
    .from("spraay_payout_runs")
    .update({ status: "confirmed" satisfies RunStatus, gas_used: gasUsed.toString() })
    .eq("id", runId);
  if (error) throw new Error(`marking run ${runId} confirmed: ${error.message}`);
}

export async function markFailed(
  db: SupabaseClient,
  runId: string,
  message: string,
): Promise<void> {
  const { error } = await db
    .from("spraay_payout_runs")
    .update({ status: "failed" satisfies RunStatus, error: message.slice(0, 4000) })
    .eq("id", runId);
  if (error) throw new Error(`marking run ${runId} failed: ${error.message}`);
}

/** Runs that were interrupted before reaching a terminal state. */
export async function liveRuns(db: SupabaseClient): Promise<RunRow[]> {
  const { data, error } = await db
    .from("spraay_payout_runs")
    .select("*")
    .in("status", ["pending", "broadcast"])
    .order("created_at", { ascending: true });

  if (error) throw new Error(`reading live runs: ${error.message}`);
  return (data ?? []) as RunRow[];
}

export async function getRun(db: SupabaseClient, runId: string): Promise<RunRow | null> {
  const { data, error } = await db
    .from("spraay_payout_runs")
    .select("*")
    .eq("id", runId)
    .maybeSingle();

  if (error) throw new Error(`reading run ${runId}: ${error.message}`);
  return (data as RunRow | null) ?? null;
}

/**
 * Release a failed run's sales back to unsettled. Explicit operator action only
 * (the `retry` command) — never automatic.
 */
export async function releaseFailedRun(db: SupabaseClient, runId: string): Promise<void> {
  const run = await getRun(db, runId);
  if (!run) throw new Error(`run ${runId} not found`);
  if (run.status !== "failed") {
    throw new Error(`run ${runId} is ${run.status}, not failed; refusing to release its sales`);
  }
  if (run.tx_hash) {
    throw new Error(
      `run ${runId} has tx_hash ${run.tx_hash}. Confirm on-chain that it did NOT land ` +
        `before releasing, then clear tx_hash by hand. Refusing to create a double-pay path.`,
    );
  }

  const { error } = await db
    .from("spraay_payout_runs")
    .update({ sale_ids: [], error: `${run.error ?? ""}\n[released for retry]`.trim() })
    .eq("id", runId);
  if (error) throw new Error(`releasing run ${runId}: ${error.message}`);
}
