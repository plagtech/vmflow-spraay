-- vmflow-spraay: one additive table in the operator's own VMflow Supabase.
-- Nothing in VMflow's schema is modified. Safe to run on a live stack.

create table if not exists public.spraay_payout_runs (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),

  -- The sales this run claims. Membership here is what makes a sale "settled";
  -- it is the worker's whole idempotency story, so it is written before any
  -- money moves.
  sale_ids      uuid[] not null default '{}',

  -- [{ label, wallet, bps, raw }] — raw is a decimal STRING of USDC base units,
  -- because JSON numbers cannot hold uint256 exactly.
  splits        jsonb not null,

  status        text not null default 'pending'
                check (status in ('pending','broadcast','confirmed','failed')),

  x402_estimate jsonb,
  tx_hash       text,
  gas_used      text,
  error         text
);

create index if not exists spraay_payout_runs_status_idx
  on public.spraay_payout_runs (status);

create index if not exists spraay_payout_runs_created_at_idx
  on public.spraay_payout_runs (created_at desc);

-- Claimed-sale lookups scan sale_ids across live runs every cycle.
create index if not exists spraay_payout_runs_sale_ids_idx
  on public.spraay_payout_runs using gin (sale_ids);

-- A broadcast or confirmed run without a tx_hash would be unauditable.
alter table public.spraay_payout_runs
  drop constraint if exists spraay_payout_runs_hash_required;
alter table public.spraay_payout_runs
  add constraint spraay_payout_runs_hash_required
  check (status not in ('broadcast','confirmed') or tx_hash is not null);

-- The worker connects with the service role, which bypasses RLS. Enabling it
-- with no policy keeps anon/authenticated clients (the VMflow dashboard, the
-- machines) from reading payout history they have no business seeing.
alter table public.spraay_payout_runs enable row level security;

comment on table public.spraay_payout_runs is
  'vmflow-spraay payout runs. Additive; owned by the payout worker, not by VMflow.';
