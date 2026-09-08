/**
 * Publishes this deployment's ladder presets.
 *
 * A pool is always opened against a config, so until at least one exists the
 * program is deployed but unusable. This is the step between
 * `scripts\deploy.ps1` and anyone being able to create a pool.
 *
 *   bun run --cwd app configs:init
 *   bun run --cwd app configs:init -- --network localnet
 *   bun run --cwd app configs:init -- --network mainnet-beta --yes
 *   bun run --cwd app configs:init -- --url https://my-endpoint
 *
 * `--network` picks the endpoint from the SDK's own table so this script and
 * the app cannot disagree about where devnet is; `--url` overrides it. On a
 * live network the run stops unless `--yes` is passed, because the authority
 * this creates is not something to discover you set by accident: it collects
 * the protocol fee from every pool built on these presets, forever.
 *
 * The signer becomes each config's authority, which means it collects the
 * protocol share of fees in every pool built on them and can disable those
 * pools. Use the key you intend to keep, and set `VITE_TAPER_ADMIN` to its
 * address so the app labels these presets as its own.
 *
 * Idempotent: a config that already exists is reported and skipped.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction
} from "@solana/web3.js";
import { Ladder, configPda, initializeConfigIx, networkFor, parseConfig } from "taper-amm-sdk";
import { PRESETS, presetParams } from "../src/lib/preset-defs";

function arg(name: string, fallback: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const network = networkFor(arg("network", "devnet"));
if (!network) {
  console.error(`Unknown --network. Use mainnet-beta, devnet or localnet.`);
  process.exit(1);
}
const url = arg("url", network.defaultEndpoint);
const keypairPath = arg("keypair", join(homedir(), ".config", "solana", "id.json"));
const dryRun = process.argv.includes("--dry-run");

if (network.live && !dryRun && !process.argv.includes("--yes")) {
  console.error(
    `${network.label} is live. Re-run with --yes once you are sure this keypair is the authority ` +
      `you intend to keep — it collects the protocol fee from every pool built on these presets.`
  );
  process.exit(1);
}

let authority: Keypair;
try {
  authority = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keypairPath, "utf8"))));
} catch (error) {
  console.error(`Could not read a keypair from ${keypairPath}`);
  console.error(error instanceof Error ? error.message : error);
  console.error("\n    solana-keygen new -o <path>\n");
  process.exit(1);
}

const connection = new Connection(url, "confirmed");
console.log(`network    ${network.label}`);
console.log(`endpoint   ${url}`);
console.log(`authority  ${authority.publicKey.toBase58()}`);

const balance = await connection.getBalance(authority.publicKey);
console.log(`balance    ${(balance / 1e9).toFixed(4)} SOL\n`);

/**
 * Polled rather than subscribed: the localnet has no WebSocket, so
 * `confirmTransaction` would hang there forever.
 */
async function confirm(signature: string) {
  for (let i = 0; i < 120; i += 1) {
    const { value } = await connection.getSignatureStatuses([signature]);
    const status = value[0];
    if (status?.err) throw new Error(`transaction failed: ${JSON.stringify(status.err)}`);
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`transaction ${signature.slice(0, 8)} was not confirmed`);
}

let created = 0;
let failed = 0;

for (const preset of PRESETS) {
  const address = configPda(authority.publicKey, preset.index);
  const params = presetParams(preset);
  const ladder = new Ladder(params.baseWidthQ64, params.taperQ64);
  const ceiling = ladder.priceCeiling();

  console.log(`${preset.name}  (index ${preset.index})`);
  console.log(`  address   ${address.toBase58()}`);
  console.log(`  step      ${preset.bps} bps at the anchor`);
  console.log(
    `  taper     ${Number.isFinite(preset.halfLife) ? `halves every ${preset.halfLife.toLocaleString()} bins` : "none (uniform, exactly DLMM)"}`
  );
  console.log(`  band      bins ${params.minBinId.toLocaleString()} to ${params.maxBinId.toLocaleString()}`);
  console.log(`  ceiling   ${Number.isFinite(ceiling) ? ceiling.toExponential(3) : "none"}`);

  const existing = await connection.getAccountInfo(address);
  if (existing) {
    const view = parseConfig(existing.data);
    const matches = view.baseWidthQ64 === params.baseWidthQ64 && view.taperQ64 === params.taperQ64;
    console.log(`  status    already published${matches ? "" : "  ** DIFFERS FROM THIS DEFINITION **"}\n`);
    continue;
  }

  if (dryRun) {
    console.log("  status    would create (dry run)\n");
    continue;
  }

  try {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    const tx = new Transaction({ feePayer: authority.publicKey, blockhash, lastValidBlockHeight });
    tx.add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      initializeConfigIx(authority.publicKey, params)
    );
    tx.sign(authority);
    const signature = await connection.sendRawTransaction(tx.serialize());
    await confirm(signature);
    console.log(`  status    created  ${signature}\n`);
    created += 1;
  } catch (error) {
    failed += 1;
    console.error(`  status    FAILED  ${error instanceof Error ? error.message : error}\n`);
  }
}

console.log(`${created} created, ${failed} failed.`);
if (created > 0 || failed === 0) {
  console.log(`\nSet this in app/.env so the interface labels them as its own:`);
  console.log(`\n    VITE_TAPER_ADMIN=${authority.publicKey.toBase58()}\n`);
}
process.exit(failed > 0 ? 1 : 0);
