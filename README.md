# vmflow-spraay

Turns VMflow machine revenue into automated multi-party payouts.

The worker reads the operator's own VMflow `sales` table, computes the revenue
split (operator / location owner / route driver / anyone), and settles each cycle
as **one Spraay batch transaction on Base**.

**Your keys never leave your machine.** The gateway's only job is to *encode*:
it takes the recipient list and prices the batch, and hands back an **unsigned**
transaction. Nothing else. The operator's key signs that transaction locally, in
this process, on the operator's own box, and broadcasts it to Base directly.

Spraay never sees a private key, never holds funds, never takes custody, and
cannot move an operator's money — it has nothing to move it with. The one thing
it is granted is a bounded ERC-20 allowance, approved at exactly the amount the
current cycle needs and no more. Settlement is USDC on Base,
recipient-to-recipient.

This is not a claim to take on faith; it is visible in the verification below.
Every transfer of value originates from a transaction signed by the operator's
own key, and the worker refuses outright to report a transaction it did not
sign — see *The worker stops rather than adapts*.

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

The worker parses **decimal text** into integer cents and then into raw 6dp USDC
units with BigInt throughout. `0.31 * 100 === 31.000000000000004` is precisely
the bug this avoids, and it is covered by tests.

Note that upstream `sales.item_price` is a `double precision` column, not a
decimal numeric. The worker reads each value's shortest exact decimal form and
refuses anything carrying sub-cent precision rather than silently rounding
someone's money. The float column is a pre-existing upstream property; this
worker is additive and does not change it.

### Failed runs do not auto-release

A `failed` run keeps its sales claimed until an operator runs `retry <id>`
explicitly. "Failed" means the worker could not prove the batch settled — not
that it proved the batch did not. A receipt timeout can still land minutes
later, and re-selecting those sales would pay them twice. If a failed run has a
`tx_hash`, `retry` refuses outright until a human confirms on-chain that it
never landed.

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

`recover` and `run` accept `--stale-minutes N` to override the 10-minute window
before an interrupted run is checked against the chain.

Start with `dry-run`. It performs no payment and makes no network call to the
gateway, so it is safe against a live database.

Secrets are read from the environment. Keep them in a `.env` outside the repo
and point Node at it, so a key never lands in the working tree:

```bash
node --env-file=../.env dist/index.js run
```

---

## Notes for operators

Three things that will otherwise surprise you.

**`sales.item_price` is a `double precision` column, not a decimal numeric.**
That is upstream VMflow's choice and this worker is additive, so it does not
change it. What the worker does instead: it reads each value's *shortest exact
decimal form* and parses that as text, never multiplying the float. A price
carrying sub-cent precision — the residue of float arithmetic upstream, say
`0.1 + 0.2` — is **refused**, and the cycle stops rather than quietly rounding
somebody's money. If a cycle halts complaining about sub-cent precision, the
sale row is the thing to look at, not the worker.

**A cycle that aborts after the `execute` call still pays the $0.02 fee.** The
gateway charges for pricing the batch, and that payment settles before the
worker has seen a single byte of the response. So every safety stop after that
point — an unrecognised response shape, a total that does not match, a failed
broadcast — costs $0.02 and moves no payout money. That is the intended trade:
$0.02 is the price of *not* broadcasting something unverified. It does mean a
misconfiguration can burn fees in a loop, so watch for repeated `failed` runs
rather than letting cron grind.

**The gateway mixes units, and the worker always prefers the raw figure.** Its
`batch` summary is in human decimals — `"totalAmount": "0.09"`, `"fee":
"0.00027"` — while `approvalRequired.amount` is in raw base units, `"90270"`.
Reading the summary as raw would approve a millionth of the intended allowance;
reading the raw field as decimal would approve a million times it. The worker
parses each in its own units and uses `approvalRequired.amount` verbatim for
the approval and the balance check. If you extend this code, keep that
distinction: it is the single easiest place here to lose money.

---

## Verifying the x402 client

The gateway speaks **x402 protocol v2** with CAIP-2 network ids
(`eip155:8453`). This matters when choosing a client:

| package | result against this gateway |
| --- | --- |
| `x402-fetch@1.2.0` (unscoped) | **fails** — its schema admits protocol v1 only, and a network enum of legacy names (`"base"`, `"base-sepolia"`, …). It rejects the 402 body before attempting any payment. |
| `@x402/fetch@2.25.0` + `@x402/evm@2.25.0` (scoped) | **works** — parses the v2 402, signs an EIP-3009 authorization, retries with `X-PAYMENT`. |

So the worker pins the scoped v2 packages. An ethers `Wallet` is adapted to the
viem-shaped `ClientEvmSigner` the EVM scheme expects (see `toClientEvmSigner` in
`src/gateway.ts`).

This was first verified with a throwaway **unfunded** key: the client got all the
way to settlement and failed only on funds (`invalid_payload: … execution
reverted`), which is the correct outcome for a wallet holding no USDC. No money
was spent to establish it.

### One paid call per cycle

The live gateway answers a **second paid call from the same payer**, seconds
after the first, with `HTTP 409 duplicate_payment_detected`. Reproduced with
fresh unfunded payers: each distinct payer's first call is accepted for
settlement; that payer's next call within the window is refused as a duplicate.

Estimating immediately before executing is exactly that pattern. So
`preflightEstimate` defaults to **false** and a cycle makes exactly one paid call
— the `execute` that actually moves the money.

### The worker stops rather than adapts

`parseExecute` validates the execute response against the verified contract and
refuses anything else. In particular, a response carrying a broadcast
`transactions[]` array (with hashes) instead of one unsigned `transaction` is a
**hard stop**: that would mean the gateway broadcast on the operator's behalf, a
different trust model than this worker implements, and the worker will not report
a transaction it did not sign as its own.

The gateway's x402 discovery metadata advertises that broadcast shape as its
example response; it is a stale docstring. Every paid call observed returns an
unsigned transaction, which is the real contract.

---

## Verified end-to-end (real money, Base mainnet)

Run against a local VMflow stack (the `docker/` compose from
mdb-esp32-cashless) with a funded operator wallet. Every figure below was read
back from the on-chain transaction logs, not from the worker's own output.

**Split under test** — recipient A is `PAYOUT_RECIPIENT_2`, recipient B is the
operator wallet itself, 50/50:

| role | address | share |
| --- | --- | --- |
| A `location-owner` | `0x85E4d5A1F42F6da2c6f12994a089E7aAA14079a2` | 5000 bps |
| B `operator` | `0x302B44f3ABbc8180d49f9dB7b0217880f912A29D` | 5000 bps |

### Settlement 1 — 5 sales, $0.09

Batch [`0x04312f24…c2ff239b`](https://basescan.org/tx/0x04312f246c5e7aea57a7b8e620dd6adf2a626b269ee8acbe51062493c2ff239b)
(block 51153633, gas 93375) · approval
[`0xd575d35e…90ea9d98`](https://basescan.org/tx/0xd575d35eb26452fe2e2ca2fcd737e9e7a27803fe0198d4a4f5628b0290ea9d98)

Decoded USDC `Transfer` events, in order:

| from | to | amount | raw | |
| --- | --- | --- | --- | --- |
| operator | batch contract | 0.09027 | 90270 | payout + fee |
| batch contract | A | **0.045** | 45000 | 5000 bps |
| batch contract | B (operator) | **0.045** | 45000 | 5000 bps |
| batch contract | fee sink | 0.00027 | 270 | **0.3%** exactly |

`45000 + 45000 + 270 = 90270` — the batch reconciles to the unit.

### Settlement 2 — 3 sales, $0.04 (the post-crash run)

Batch [`0x74af3731…0e273186`](https://basescan.org/tx/0x74af37319e6dfade43145fb1f4fc566476240b98c769ecf002504b120e273186)
(block 51153799, gas 93375) · approval
[`0x67683132…33a41f21`](https://basescan.org/tx/0x676831327c14d7d9cede5cf972cd7aa0adbefd3b51adc2ded108c33f33a41f21)

| from | to | amount | raw | |
| --- | --- | --- | --- | --- |
| operator | batch contract | 0.04012 | 40120 | payout + fee |
| batch contract | A | **0.02** | 20000 | 5000 bps |
| batch contract | B (operator) | **0.02** | 20000 | 5000 bps |
| batch contract | fee sink | 0.00012 | 120 | **0.3%** exactly |

`20000 + 20000 + 120 = 40120`.

### What this proves

- **Exact split amounts.** Recipient A's balance moved `0.29 → 0.335 → 0.355`:
  exactly +0.045 and +0.020, to the base unit. Parts sum to the total; no dust
  stranded, none over-paid.
- **Contract fee is 0.3% on-chain.** `270/90000` and `120/40000`, both exactly
  0.003 — matching the `feePercent` the gateway quoted.
- **Bounded approvals.** Each cycle approved exactly the gateway's fee-inclusive
  figure (90270, then 40120). Never an infinite allowance.
- **Idempotency.** Re-running immediately reports `no unsettled sales` and
  settles nothing — operator USDC and ETH balances unchanged to the wei.
- **Crash recovery.** `kill -9` between the claim (step 4) and the broadcast
  (step 7) left the run `pending`, its sales claimed, no `tx_hash` — and those
  sales were *not* re-selectable. `recover` left the fresh run alone inside the
  stale window, then with `--stale-minutes 0` marked it failed as
  interrupted-before-broadcast. The sales stayed claimed until `retry` released
  them explicitly, and the next cycle settled them cleanly (settlement 2).

- **Non-custodial, demonstrably.** Both batch transactions and both approvals
  were signed by the operator key inside this process and broadcast straight to
  Base. The gateway supplied calldata and never a signature; it held no funds at
  any point and its allowance was capped at the cycle amount. Nothing in either
  settlement could have happened without the operator's own key.

All 8 seeded sales ($0.13) ended settled across the two confirmed runs.

### What it cost

Operator USDC went `0.46 → 0.31461`, which reconciles exactly:

| | |
| --- | --- |
| settlement 1 net (sent 0.09027, received own 0.045 leg) | 0.04527 |
| settlement 2 net (sent 0.04012, received own 0.020 leg) | 0.02012 |
| x402 `execute` fees — 4 paid calls at $0.02 | 0.08 |
| **total** | **0.14539** |

Two of those four calls settled. The other two were paid for responses the
worker then refused: the contract-parse stop described below, and the nonce
collision. Both are the strict checks doing their job — a $0.02 fee is the
price of *not* broadcasting something unverified — but it is worth knowing that
a cycle which aborts after the execute call still costs the gateway fee.

Base gas and the $0.00039 protocol fee are on top.

### Two bugs this run caught

- **Failed runs auto-released their sales.** `claimedSaleIds` omitted `failed`,
  so a run that could not prove its batch settled would have had its sales
  re-selected by the next cycle — a double-pay path, and the exact thing the
  retry-only rule exists to prevent. The code comment asserted the opposite of
  what the query did. Fixed, with a regression test.
- **Nonce race between approval and batch.** `getTransactionCount(…, "pending")`
  can still report the nonce the approval just consumed, and the batch send is
  then rejected `REPLACEMENT_UNDERPRICED` (observed once on Base). The batch now
  never goes below the approval's nonce + 1.

A third was caught before any money moved: on Windows, calling `process.exit()`
while the Supabase client's sockets were closing aborted the process, so a
*successful* cycle exited non-zero — which under cron reads as a failed payout
and invites a double-paying retry.

### One contract correction

The gateway's `batch` summary is in **human decimals** (`"totalAmount": "0.09"`,
`"fee": "0.00027"`), while `approvalRequired.amount` is in **raw base units**
(`"90270"`). Mixing those up would approve a millionth of the intended
allowance. The worker parses each in its own units and prefers the raw field for
the balance check. This cost one $0.02 call to discover: the strict parser
rejected the response and stopped the cycle before broadcasting, which is the
designed behaviour.

---

## Tests

```bash
npm test        # 28 tests
npm run typecheck
```

---

## Licence

TBD before the repo goes public.
