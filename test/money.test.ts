import { test } from "node:test";
import assert from "node:assert/strict";
import { centsToRaw, dollarsToCents, formatUsdc, usdThresholdToRaw } from "../src/money.js";

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
