import { test } from "node:test";
import assert from "node:assert/strict";
import {
  centsToRaw,
  dollarsToCents,
  formatUsdc,
  usdThresholdToRaw,
  usdcDecimalToRaw,
} from "../src/money.js";

test("parses decimal dollar text into exact cents", () => {
  assert.equal(dollarsToCents("0.31"), 31n);
  assert.equal(dollarsToCents("1"), 100n);
  assert.equal(dollarsToCents("1.5"), 150n);
  assert.equal(dollarsToCents(".05"), 5n);
  assert.equal(dollarsToCents("12.34"), 1234n);
  assert.equal(dollarsToCents("0"), 0n);
});

test("0.31 survives the float trap", () => {
  // The bug this whole module exists to prevent: 0.31 * 100 === 31.000000000000004,
  // so Math.round-ing a float is fine until the value that rounds the wrong way.
  assert.equal(dollarsToCents(0.31), 31n);
  assert.equal(dollarsToCents(0.07), 7n);
  assert.equal(dollarsToCents(0.29), 29n);
});

test("refuses sub-cent precision instead of rounding money away", () => {
  assert.throws(() => dollarsToCents("1.005"), /sub-cent/);
  assert.throws(() => dollarsToCents("0.311"), /sub-cent/);
});

test("rejects malformed and negative amounts", () => {
  assert.throws(() => dollarsToCents("abc"), /not a decimal/);
  assert.throws(() => dollarsToCents(""), /not a decimal/);
  assert.throws(() => dollarsToCents("-1.00"), /negative/);
});

test("cents convert to 6dp USDC base units", () => {
  assert.equal(centsToRaw(31n), 310_000n);
  assert.equal(centsToRaw(5n), 50_000n);
  assert.equal(centsToRaw(100n), 1_000_000n);
});

test("formats raw units back to a readable string", () => {
  assert.equal(formatUsdc(310_000n), "0.310000");
  assert.equal(formatUsdc(1_000_000n), "1.000000");
  assert.equal(formatUsdc(1n), "0.000001");
});

test("threshold parses from config", () => {
  assert.equal(usdThresholdToRaw("0.01"), 10_000n);
  assert.equal(usdThresholdToRaw(0.05), 50_000n);
});

test("parses gateway decimal amounts into raw units exactly", () => {
  // Real values from a paid /batch/execute call. Note the 5-decimal fee: this
  // is why the gateway summary needs its own parser and not dollarsToCents.
  assert.equal(usdcDecimalToRaw("0.09"), 90_000n);
  assert.equal(usdcDecimalToRaw("0.00027"), 270n);
  assert.equal(usdcDecimalToRaw("0.09027"), 90_270n);
  assert.equal(usdcDecimalToRaw("1"), 1_000_000n);
  assert.equal(usdcDecimalToRaw("0.000001"), 1n);
});

test("the units trap: a decimal summary must never be read as raw", () => {
  // "0.09" parsed as if it were raw base units is the bug that would approve a
  // millionth of the intended allowance; BigInt() on it throws instead.
  assert.throws(() => BigInt("0.09"));
  assert.equal(usdcDecimalToRaw("0.09"), 90_000n);
});

test("refuses precision USDC cannot hold", () => {
  assert.throws(() => usdcDecimalToRaw("0.0000001"), /more precision/);
  assert.throws(() => usdcDecimalToRaw("abc"), /not a USDC decimal/);
});
