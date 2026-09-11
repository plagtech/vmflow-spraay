import { test } from "node:test";
import assert from "node:assert/strict";
import { splitAmount, assertSplitRules, type SplitRule } from "../src/splits.js";

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";
const C = "0x3333333333333333333333333333333333333333";

const twoWay: SplitRule[] = [
  { label: "recipient-a", wallet: A, bps: 5000 },
  { label: "operator", wallet: B, bps: 5000 },
];

test("even split of an even total", () => {
  const lines = splitAmount(50_000n, twoWay);
  assert.deepEqual(lines.map((l) => l.raw), [25_000n, 25_000n]);
});

test("the split always sums to the total exactly", () => {
  // Totals chosen to be awkward for 1/3-style bps: every one must reconcile.
  const thirds: SplitRule[] = [
    { label: "a", wallet: A, bps: 3333 },
    { label: "b", wallet: B, bps: 3333 },
    { label: "c", wallet: C, bps: 3334 },
  ];
  // From 10 units up: below that the smallest share rounds to zero and the
  // cycle is correctly refused rather than apportioned (see the zero test).
  for (let total = 10n; total <= 2000n; total += 1n) {
    const lines = splitAmount(total, thirds);
    const sum = lines.reduce((acc, line) => acc + line.raw, 0n);
    assert.equal(sum, total, `total ${total} did not reconcile`);
  }
});

test("leftover units go to the largest remainders, deterministically", () => {
  const rules: SplitRule[] = [
    { label: "a", wallet: A, bps: 3333 },
    { label: "b", wallet: B, bps: 3333 },
    { label: "c", wallet: C, bps: 3334 },
  ];
  const first = splitAmount(10n, rules);
  const second = splitAmount(10n, rules);
  assert.deepEqual(first.map((l) => l.raw), second.map((l) => l.raw));
  assert.equal(first.reduce((acc, l) => acc + l.raw, 0n), 10n);
});

test("a lopsided split reconciles once every share clears one unit", () => {
  // 9999/1 bps needs 10_000 units before the 1-bps line is worth a transfer.
  const rules: SplitRule[] = [
    { label: "a", wallet: A, bps: 9999 },
    { label: "b", wallet: B, bps: 1 },
  ];
  const lines = splitAmount(10_000n, rules);
  assert.deepEqual(lines.map((l) => l.raw), [9_999n, 1n]);
  assert.equal(lines.reduce((acc, l) => acc + l.raw, 0n), 10_000n);

  // Largest-remainder still rescues the dust line well below that: at 9_999 the
  // 1-bps share floors to 0 but wins the single leftover unit.
  assert.deepEqual(splitAmount(9_999n, rules).map((l) => l.raw), [9_998n, 1n]);

  // It only breaks down when there are fewer leftover units than empty lines —
  // then someone would be paid nothing, and the cycle is refused.
  assert.throws(() => splitAmount(1n, rules), /rounds to 0/);
});

test("rejects bps that do not sum to 10000", () => {
  assert.throws(
    () => assertSplitRules([{ label: "a", wallet: A, bps: 4000 }, { label: "b", wallet: B, bps: 5000 }]),
    /sum to 9000/,
  );
});

test("rejects a duplicate wallet across rules", () => {
  assert.throws(
    () =>
      assertSplitRules([
        { label: "a", wallet: A, bps: 5000 },
        { label: "b", wallet: A.toUpperCase(), bps: 5000 },
      ]),
    /more than one split rule/,
  );
});

test("refuses a cycle where a recipient would round to zero", () => {
  // 1 unit across 5000/5000 leaves one side at 0 — paying nothing is a bug, not
  // a rounding detail, so the cycle must be held until it is worth settling.
  assert.throws(() => splitAmount(1n, twoWay), /rounds to 0|raise the payout threshold/);
});

test("rejects a non-positive total", () => {
  assert.throws(() => splitAmount(0n, twoWay), /nothing to split/);
});
