import { test } from "node:test";
import assert from "node:assert/strict";
import { claimedSaleIds } from "../src/db.js";

/**
 * Minimal stub of the supabase query builder: records the status filter the
 * claimed-set query asks for, and returns canned rows.
 */
function stubDb(rows: Array<{ sale_ids: string[] }>) {
  const captured: { statuses?: string[] } = {};
  const db = {
    from() {
      return {
        select() {
          return {
            in(_column: string, statuses: string[]) {
              captured.statuses = statuses;
              return Promise.resolve({ data: rows, error: null });
            },
          };
        },
      };
    },
  };
  return { db: db as never, captured };
}

test("a failed run still claims its sales — no silent double-pay", async () => {
  // The brief's rule: failed runs release their sale ids ONLY via an explicit
  // retry. "Failed" means we could not prove the batch settled, not that we
  // proved it did not — a receipt timeout can still land minutes later, and
  // re-selecting those sales pays them twice.
  const { db, captured } = stubDb([]);
  await claimedSaleIds(db);

  assert.ok(
    captured.statuses?.includes("failed"),
    `claimed-set query must include "failed"; asked for ${JSON.stringify(captured.statuses)}`,
  );
});

test("claims cover every non-terminal and terminal-but-held status", async () => {
  const { db, captured } = stubDb([]);
  await claimedSaleIds(db);
  for (const status of ["pending", "broadcast", "confirmed", "failed"]) {
    assert.ok(captured.statuses?.includes(status), `missing status ${status}`);
  }
});

test("collects sale ids across runs, de-duplicated", async () => {
  // The same sales can appear in more than one run: a crashed run and the run
  // that re-claimed them after a retry both hold the ids.
  const { db } = stubDb([
    { sale_ids: ["a", "b"] },
    { sale_ids: ["b", "c"] },
    { sale_ids: [] },
  ]);
  const claimed = await claimedSaleIds(db);
  assert.deepEqual([...claimed].sort(), ["a", "b", "c"]);
});
