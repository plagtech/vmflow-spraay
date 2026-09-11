// Revenue split math.
//
// bps (basis points) sum to exactly 10000. Applying them to a total in raw USDC
// units almost always leaves a remainder, because integer division truncates.
// Largest-remainder (Hamilton) apportionment hands those leftover units out one
// at a time to the recipients with the biggest truncated fractions, so:
//
//   sum(payouts) === total   exactly, always.
//
// No dust is stranded in the operator's wallet and no dust is over-paid out of
// it. A batch that does not sum to the total is a bug, so `splitAmount` asserts
// it before returning.

export interface SplitRule {
  readonly label: string;
  readonly wallet: string;
  readonly bps: number;
}

export interface SplitLine {
  readonly label: string;
  readonly wallet: string;
  readonly bps: number;
  readonly raw: bigint;
}

export const TOTAL_BPS = 10_000;

export function assertSplitRules(rules: readonly SplitRule[]): void {
  if (rules.length === 0) throw new Error("split rules are empty");
  if (rules.length > 200) {
    throw new Error(`${rules.length} split rules exceeds the gateway's 200-recipient cap`);
  }

  let sum = 0;
  for (const rule of rules) {
    if (!Number.isInteger(rule.bps) || rule.bps <= 0) {
      throw new Error(`split "${rule.label}": bps must be a positive integer, got ${rule.bps}`);
    }
    sum += rule.bps;
  }
  if (sum !== TOTAL_BPS) {
    throw new Error(`split bps sum to ${sum}, must sum to exactly ${TOTAL_BPS}`);
  }

  const seen = new Set<string>();
  for (const rule of rules) {
    const key = rule.wallet.toLowerCase();
    if (seen.has(key)) {
      // Two lines paying one address would still settle, but it doubles the
      // per-recipient gas and makes the run row ambiguous to audit. Merge them.
      throw new Error(`wallet ${rule.wallet} appears in more than one split rule; merge the bps`);
    }
    seen.add(key);
  }
}

/**
 * Apportion `total` raw units across `rules` by bps, largest-remainder.
 * Returns lines in the same order as `rules`.
 */
export function splitAmount(total: bigint, rules: readonly SplitRule[]): SplitLine[] {
  assertSplitRules(rules);
  if (total <= 0n) throw new Error(`nothing to split: total is ${total}`);

  const bpsTotal = BigInt(TOTAL_BPS);

  const base = rules.map((rule) => {
    const scaled = total * BigInt(rule.bps);
    return { rule, floor: scaled / bpsTotal, remainder: scaled % bpsTotal };
  });

  let distributed = base.reduce((sum, entry) => sum + entry.floor, 0n);
  let leftover = total - distributed;

  // Hand out the leftover units, biggest truncated fraction first. Ties break on
  // the original rule order, so the same input always produces the same batch.
  const order = base
    .map((entry, index) => ({ index, remainder: entry.remainder }))
    .sort((a, b) => (b.remainder === a.remainder ? a.index - b.index : b.remainder > a.remainder ? 1 : -1));

  const extra = new Array<bigint>(rules.length).fill(0n);
  let cursor = 0;
  while (leftover > 0n) {
    const slot = order[cursor % order.length];
    if (!slot) throw new Error("unreachable: empty apportionment order");
    extra[slot.index] = (extra[slot.index] ?? 0n) + 1n;
    leftover -= 1n;
    cursor += 1;
  }

  const lines: SplitLine[] = base.map((entry, index) => ({
    label: entry.rule.label,
    wallet: entry.rule.wallet,
    bps: entry.rule.bps,
    raw: entry.floor + (extra[index] ?? 0n),
  }));

  const check = lines.reduce((sum, line) => sum + line.raw, 0n);
  if (check !== total) {
    throw new Error(`split does not reconcile: ${check} != ${total}`);
  }
  for (const line of lines) {
    if (line.raw <= 0n) {
      throw new Error(
        `split "${line.label}" rounds to 0 at this cycle size; raise the payout threshold`,
      );
    }
  }

  return lines;
}
