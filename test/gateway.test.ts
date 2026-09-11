import { test } from "node:test";
import assert from "node:assert/strict";
import { assertBatchMatches, parseExecute, GatewayContractError } from "../src/gateway.js";

const valid = {
  transaction: {
    to: "0x4444444444444444444444444444444444444444",
    data: "0xdeadbeef",
    value: "0x0",
    chainId: 8453,
    gasLimit: "0x2d2d0",
  },
  batch: {
    totalAmount: "50000",
    fee: "150",
    feePercent: "0.3%",
    totalWithFee: "50150",
  },
  approvalRequired: {
    token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    spender: "0x5555555555555555555555555555555555555555",
    amount: "50150",
  },
};

test("parses the verified contract shape", () => {
  const parsed = parseExecute(valid);
  assert.equal(parsed.transaction.to, valid.transaction.to);
  assert.equal(parsed.transaction.chainId, 8453);
  assert.equal(parsed.batch.totalWithFee, "50150");
  assert.equal(parsed.approvalRequired?.amount, "50150");
});

test("approvalRequired is optional", () => {
  const { approvalRequired, ...rest } = valid;
  void approvalRequired;
  assert.equal(parseExecute(rest).approvalRequired, undefined);
});

test("HARD STOP: a broadcast transactions[] response is refused", () => {
  // The gateway's own discovery metadata advertises this shape. If a paid call
  // ever returns it, the gateway broadcast on our behalf — a different trust
  // model than this worker implements — and we must not treat it as success.
  assert.throws(
    () => parseExecute({ transactions: [{ hash: "0xabc", status: "submitted", gasUsed: "185000" }] }),
    (error: unknown) =>
      error instanceof GatewayContractError && /did not sign/.test((error as Error).message),
  );
});

test("HARD STOP: a non-Base chainId is refused", () => {
  const wrongChain = { ...valid, transaction: { ...valid.transaction, chainId: 1 } };
  assert.throws(() => parseExecute(wrongChain), /expected Base/);
});

test("HARD STOP: a missing transaction is refused", () => {
  assert.throws(() => parseExecute({ batch: valid.batch }), /no transaction object/);
});

test("HARD STOP: a partial approvalRequired is refused", () => {
  const partial = { ...valid, approvalRequired: { token: "0x1", spender: "0x2" } };
  assert.throws(() => parseExecute(partial), /missing token\/spender\/amount/);
});

test("the gateway's quoted total must equal the cycle's own total", () => {
  const parsed = parseExecute(valid);
  assert.doesNotThrow(() => assertBatchMatches(parsed, 50_000n));
  assert.throws(() => assertBatchMatches(parsed, 49_999n), /priced 50000 .* computed 49999/);
});
