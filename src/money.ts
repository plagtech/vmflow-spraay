// Money handling. Every value on this path is an integer; floats never touch money.
//
// VMflow stores `sales.item_price` as a human-decimal dollar numeric ("0.31").
// supabase-js hands that back as a JS number or a string depending on driver
// settings, and 0.31 is not representable in binary floating point. So we parse
// the DECIMAL TEXT, never the float: dollars -> integer cents -> raw USDC units.
//
// USDC on Base has 6 decimals, so 1 cent = 10_000 raw units.

export const USDC_DECIMALS = 6;
export const RAW_PER_CENT = 10_000n; // 10 ** (6 - 2)

/**
 * Parse a decimal dollar amount into integer cents, without float math.
 * Accepts "0.31", ".31", "1", "1.5", 0.31 (number -> via its decimal form).
 * Rejects anything with more than 2 decimal places rather than silently
 * rounding money away.
 */
export function dollarsToCents(value: string | number): bigint {
  const text = typeof value === "number" ? decimalTextFromNumber(value) : value.trim();

  if (!/^-?\d*(\.\d+)?$/.test(text) || text === "" || text === "." || text === "-") {
    throw new Error(`not a decimal amount: ${JSON.stringify(value)}`);
  }
  if (text.startsWith("-")) {
    throw new Error(`negative sale amount: ${JSON.stringify(value)}`);
  }

  const [whole = "", fraction = ""] = text.split(".");
  if (fraction.length > 2) {
    throw new Error(
      `sale amount has sub-cent precision (${JSON.stringify(value)}); refusing to round money`,
    );
  }

  const cents = `${whole || "0"}${fraction.padEnd(2, "0")}`;
  return BigInt(cents);
}

/**
 * A JS number reaches us only when the Postgres driver has already widened the
 * numeric. Recover its shortest exact decimal form (what JSON.stringify gives)
 * and parse that as text; never multiply the float.
 */
function decimalTextFromNumber(n: number): string {
  if (!Number.isFinite(n)) throw new Error(`not a finite amount: ${n}`);
  const text = String(n);
  if (text.includes("e") || text.includes("E")) {
    // Exponential form would defeat the text parse; surface it instead of guessing.
    throw new Error(`amount in exponential form, cannot parse exactly: ${text}`);
  }
  return text;
}

/** Integer cents -> raw USDC base units (6dp). */
export function centsToRaw(cents: bigint): bigint {
  return cents * RAW_PER_CENT;
}

/** Raw USDC base units -> display string, for logs and the README. Never for math. */
export function formatUsdc(raw: bigint): string {
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const unit = 10n ** BigInt(USDC_DECIMALS);
  const whole = abs / unit;
  const fraction = (abs % unit).toString().padStart(USDC_DECIMALS, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

/** Parse a USD threshold from config ("0.01") into raw USDC units. */
export function usdThresholdToRaw(value: string | number): bigint {
  return centsToRaw(dollarsToCents(value));
}

/**
 * Parse a USDC decimal string into raw base units, exactly.
 *
 * The gateway reports its batch summary in human decimals ("0.09", "0.00027",
 * "0.09027") rather than base units — unlike `approvalRequired.amount`, which
 * is raw. Sub-cent precision is legitimate here (a 0.3% fee on dust), so this
 * accepts up to USDC's full 6 decimal places, where `dollarsToCents` stops at
 * 2. Still no float math: the text is parsed digit-wise.
 */
export function usdcDecimalToRaw(value: string): bigint {
  const text = String(value).trim();
  if (!/^\d+(\.\d+)?$/.test(text)) {
    throw new Error(`not a USDC decimal amount: ${JSON.stringify(value)}`);
  }

  const [whole = "0", fraction = ""] = text.split(".");
  if (fraction.length > USDC_DECIMALS) {
    throw new Error(
      `${JSON.stringify(value)} has more precision than USDC's ${USDC_DECIMALS} decimals`,
    );
  }
  return BigInt(whole + fraction.padEnd(USDC_DECIMALS, "0"));
}
