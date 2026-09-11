#!/usr/bin/env node
// vmflow-spraay — VMflow operator payout worker.
//
//   vmflow-spraay run       one payout cycle (recovery first)
//   vmflow-spraay dry-run   compute and print the split, pay nothing
//   vmflow-spraay recover   check interrupted runs against the chain
//   vmflow-spraay retry <id> release a failed run's sales back to unsettled
//   vmflow-spraay status    show recent runs
//
// Config path: --config <path>, default ./payout.config.json

import { connectChain } from "./chain.js";
import { loadConfig, operatorPrivateKeyFromEnv } from "./config.js";
import { connectDb, liveRuns, releaseFailedRun } from "./db.js";
import { runCycle } from "./cycle.js";
import { recover } from "./recovery.js";
import { formatUsdc } from "./money.js";
import { log } from "./log.js";

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

async function main(): Promise<number> {
  const command = process.argv[2] ?? "run";
  const configPath = arg("config", "payout.config.json")!;

  // The operator key is read first: split rules may say "operator", which only
  // resolves once we know the address that key controls.
  const privateKey = operatorPrivateKeyFromEnv();

  // A throwaway config load just to learn the RPC url would be circular, so the
  // RPC env var is read directly here with the documented default name.
  const rpcUrl = process.env["BASE_RPC_URL"];
  if (!rpcUrl) throw new Error("env BASE_RPC_URL is not set");

  const chain = await connectChain(privateKey, rpcUrl);
  log.info(`operator wallet ${chain.address}`);

  const config = loadConfig(configPath, chain.address);
  const db = connectDb(config.supabaseUrl, config.supabaseServiceRoleKey);

  switch (command) {
    case "run": {
      const outcomes = await recover(db, chain);
      for (const outcome of outcomes) log.info(`recovery: ${outcome.runId} ${outcome.action} — ${outcome.detail}`);
      if (outcomes.some((outcome) => outcome.action === "needs-attention")) {
        log.error("a run needs manual attention; not starting a new cycle");
        return 2;
      }

      const result = await runCycle(db, chain, config);
      if (!result.settled) {
        log.info(`cycle settled nothing: ${result.reason}`);
        return 0;
      }
      log.info(`cycle complete: ${result.txHash}`);
      return 0;
    }

    case "dry-run": {
      const result = await runCycle(db, chain, config, { dryRun: true });
      log.info(
        result.totalRaw !== undefined
          ? `would settle ${formatUsdc(result.totalRaw)} USDC`
          : `nothing to settle: ${result.reason}`,
      );
      return 0;
    }

    case "recover": {
      const outcomes = await recover(db, chain);
      if (outcomes.length === 0) log.info("no interrupted runs");
      for (const outcome of outcomes) log.info(`${outcome.runId} ${outcome.action} — ${outcome.detail}`);
      return outcomes.some((outcome) => outcome.action === "needs-attention") ? 2 : 0;
    }

    case "retry": {
      const runId = process.argv[3];
      if (!runId) throw new Error('usage: vmflow-spraay retry <run-id>');
      await releaseFailedRun(db, runId);
      log.info(`run ${runId} released; its sales are unsettled again`);
      return 0;
    }

    case "status": {
      const runs = await liveRuns(db);
      if (runs.length === 0) log.info("no pending or broadcast runs");
      for (const run of runs) {
        log.info(`${run.id} ${run.status} sales=${run.sale_ids.length} tx=${run.tx_hash ?? "-"}`);
      }
      return 0;
    }

    default:
      log.error(`unknown command: ${command}`);
      log.info("commands: run | dry-run | recover | retry <id> | status");
      return 1;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    log.error((error as Error).message);
    process.exit(1);
  });
