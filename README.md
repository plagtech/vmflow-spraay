# vmflow-spraay

Turns VMflow machine revenue into automated multi-party payouts.

The worker reads the operator's own VMflow `sales` table, computes the revenue
split (operator / location owner / route driver / anyone), and settles each cycle
as **one Spraay batch transaction on Base**.

**Your keys never leave your box.** The Spraay gateway prices the batch and hands
back an *unsigned* transaction. This worker signs and broadcasts it locally with
the operator's own key. Spraay never holds funds, never custodies a key, and
cannot move money on the operator's behalf. Settlement is in USDC on Base,
recipient-to-recipient.

Nothing upstream is touched: VMflow's schema is untouched, and the worker adds
exactly one table of its own.

---

## How a cycle works

1. **Select** unsettled sales — every sale not already claimed by a live run.
2. **Threshold** — skip the cycle if the total is below `minPayoutUsd`.
3. **Split** by bps, largest-remainder, so the parts sum to the total *exactly*.
4. **Claim** — insert a `pending` run row holding those sale ids. This is the
   idempotency anchor; a crash after this point resumes rather than re-selecting.
5. **Execute** — x402-pay `/api/v1/batch/execute` ($0.02), receive an unsigned
   transaction.
6. **Approve** — if an allowance is required, approve *exactly* the
   fee-inclusive amount the gateway asked for. Never an infinite approval.
7. **Broadcast** — sign the gateway's transaction verbatim, record `tx_hash`
   immediately, mark `broadcast`.
8. **Confirm** — await the receipt, mark `confirmed` with `gas_used`. A revert or
   timeout marks `failed`.
9. **Recover** — on startup, any interrupted run is checked *on-chain* before
   anything else happens.

### Money never touches a float

`sales.item_price` is a decimal dollar numeric. The worker parses the **decimal
text** into integer cents and then into raw 6dp USDC units with BigInt
throughout. `0.31 * 100 === 31.000000000000004` is precisely the bug this avoids,
and it is covered by tests.

### Failed runs do not auto-release

A `failed` run keeps its sales claimed until an operator runs `retry <id>`
explicitly. Automatically releasing them is how a worker double-pays a batch that
actually landed but whose receipt was missed. If a failed run has a `tx_hash`,
`retry` refuses outright until a human confirms on-chain that it never landed.

---

## Setup

```bash
npm install
npm run build
```

Apply the migration to the operator's own VMflow Supabase:

```bash
psql "$DATABASE_URL" -f migrations/0001_spraay_payout_runs.sql
```

Copy `payout.config.example.json` to `payout.config.json` and edit. Secrets are
**never** in the config — it only names the env vars that hold them.

```jsonc
{
  "supabase": { "url": "http://localhost:8000", "serviceRoleKeyEnv": "SUPABASE_SERVICE_ROLE_KEY" },
  "operator":  { "privateKeyEnv": "OPERATOR_PRIVATE_KEY", "rpcUrlEnv": "BASE_RPC_URL" },
  "splits": [
    { "label": "location-owner", "wallet": "env:PAYOUT_RECIPIENT_2", "bps": 5000 },
    { "label": "operator",       "wallet": "operator",               "bps": 5000 }
  ],
  "schedule": { "cron": "0 * * * *", "minPayoutUsd": "0.01" },
  "preflightEstimate": false
}
```

A split `wallet` accepts three forms:

| form | meaning |
| --- | --- |
| `0x…` | a literal address |
| `env:NAME` | read the address from that environment variable |
| `operator` | the operator's own wallet, derived from the signing key |

The `operator` form exists so the operator's own share cannot drift away from the
key that actually signs. Note that this makes the operator both the `sender` and
one of the `recipients` of the batch — the contract fee applies to the whole
total, including the leg that returns to the sender.

### Commands

```bash
vmflow-spraay run          # recovery, then one payout cycle
vmflow-spraay dry-run      # compute and print the split, pay nothing
vmflow-spraay recover      # check interrupted runs against the chain
vmflow-spraay retry <id>   # release a failed run's sales back to unsettled
vmflow-spraay status       # show pending / broadcast runs
```

Start with `dry-run`. It performs no payment and makes no network call to the
gateway, so it is safe against a live database.

---

## Verifying the x402 client

The gateway speaks **x402 protocol v2** with CAIP-2 network ids
(`eip155:8453`). This matters when choosing a client:

| package | result against this gateway |
| --- | --- |
| `x402-fetch@1.2.0` (unscoped) | **fails** — its schema admits protocol v1 only, and a network enum of legacy names (`"base"`, `"base-sepolia"`, …). It rejects the 402 body before attempting any payment. |
| `@x402/fetch@2.25.0` + `@x402/evm@2.25.0` (scoped) | **works** — parses the v2 402, signs an EIP-3009 authorization, retries with `X-PAYMENT`. |

So the worker pins the scoped v2 packages. An ethers `Wallet` is adapted to the
viem-shaped `ClientEvmSigner` the EVM scheme expects (see
`toClientEvmSigner` in `src/gateway.ts`).

This was verified against the live gateway with a throwaway **unfunded** key: the
client got all the way to settlement and failed only on funds
(`invalid_payload: … execution reverted`), which is the correct outcome for a
wallet holding no USDC. No money was spent to establish it.

### One paid call per cycle

The live gateway answers a **second paid call from the same payer**, seconds
after the first, with `HTTP 409 duplicate_payment_detected`. Reproduced with
fresh unfunded payers: each distinct payer's first call is accepted for
settlement; that payer's next call within the window is refused as a duplicate.

Estimating immediately before executing is exactly that pattern. So
`preflightEstimate` defaults to **false** and a cycle makes exactly one paid call
— the `execute` that actually moves the money. Turn it on only once the dedupe
window is understood against a funded wallet.

### The worker stops rather than adapts

`parseExecute` validates the execute response against the verified contract and
refuses anything else. In particular, a response carrying a broadcast
`transactions[]` array (with hashes) instead of one unsigned `transaction` is a
**hard stop**: that would mean the gateway broadcast on the operator's behalf,
a different trust model than this worker implements, and the worker will not
report a transaction it did not sign as its own.

The gateway's own x402 discovery metadata currently advertises that broadcast
shape as its example response, while the verified paid contract returns an
unsigned transaction. Until a funded call settles the question, the strict parse
is what keeps the two apart.

---

## Verification status

Unit tests cover the money and split math and the gateway contract parse:

```bash
npm test        # 22 tests
npm run typecheck
```

The end-to-end run against a live stack with real money is **not yet done** and
is gated on review. It needs a funded Base wallet and will produce:

- [ ] Local VMflow stack, 3 seeded sales totalling ~$0.05 on one operator
- [ ] Two-way split, threshold $0.01
- [ ] Real `$0.02` execute fee, real approval, real batch broadcast on Base
- [ ] Proof transaction hashes, recorded here
- [ ] Recipients received exact split amounts; contract fee 0.3% on-chain
- [ ] Re-running immediately settles nothing (idempotency proof)
- [ ] `kill -9` between claim and broadcast, restart, clean recovery

---

## Licence

TBD before the repo goes public.
