/**
 * Bands wider than one position, against a running localnet.
 *
 * `sol:e2e` covers wrapping and `ui/scripts/e2e.ts` covers the single-position
 * lifecycle. This covers the one thing neither can: a deposit that does not fit
 * in a transaction. A position spans 70 bins, so a 160-bin band is three
 * positions and three signatures, and everything interesting about that is
 * invisible from any single transaction — whether the three chunks together lay
 * down the shape the user asked for, and whether a plan interrupted halfway can
 * be picked up without depositing twice.
 *
 * The strongest check here is `bins hold exactly what the plan predicted`. It
 * compares every funded bin on chain against `preview` of that chunk's own bps,
 * which means the chunk's share of the amounts, its renormalised bps and the
 * program's `mul_bps` all have to agree to the raw unit. A split that quietly
 * reshaped the deposit would still succeed on chain; it would fail here.
 *
 *   ./scripts/start-localnet.ps1
 *   bun run --cwd app wide:e2e
 */
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  type Signer,
  type TransactionInstruction
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createInitializeMintInstruction,
  createMintToInstruction
} from "@solana/spl-token";
import {
  INLINE_BINS_PER_POSITION,
  positionLenFor,
  MAX_BINS_PER_POSITION,
  MAX_TX_BYTES,
  TX_HEADROOM,
  amountOf,
  ataFor,
  configPda,
  initializeConfigIx,
  initializePoolIx,
  orderMints,
  parseConfig,
  parsePool,
  parsePosition,
  planDeposit,
  planExit,
  planRebalance,
  poolPda,
  preview,
  reservePda,
  splitRange,
  stepIsLegal,
  transactionSize,
  widthThatFits,
  type BaseAccounts,
  type PositionView,
  type Step,
  type TokenPair
} from "taper-amm-sdk";
import { presetParams, PRESETS } from "../src/lib/preset-defs";
import { loadBins } from "../src/lib/data";

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const connection = new Connection(arg("url", "http://127.0.0.1:8899"), "confirmed");
const wallet = Keypair.generate();

let failures = 0;
function check(label: string, condition: boolean, detail = "") {
  console.log(`${condition ? "  ok  " : " FAIL "} ${label}${detail ? `  — ${detail}` : ""}`);
  if (!condition) failures += 1;
}
const step = (name: string) => console.log(`\n· ${name}`);

async function confirm(signature: string) {
  for (let i = 0; i < 200; i += 1) {
    const { value } = await connection.getSignatureStatuses([signature]);
    const status = value[0];
    if (status?.err) {
      const tx = await connection
        .getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" })
        .catch(() => null);
      throw new Error(
        `${JSON.stringify(status.err)}\n${(tx?.meta?.logMessages ?? []).slice(-12).join("\n")}`
      );
    }
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") return;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error(`transaction ${signature.slice(0, 8)} was not confirmed`);
}

async function send(instructions: TransactionInstruction[], signers: Signer[] = [], units = 1_400_000) {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: wallet.publicKey, blockhash, lastValidBlockHeight });
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units }), ...instructions);
  tx.sign(wallet, ...(signers as Keypair[]));
  const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  await confirm(signature);
  return signature;
}

const exists = async (key: PublicKey) => Boolean(await connection.getAccountInfo(key));
const tokenAmount = async (key: PublicKey) => {
  const account = await connection.getAccountInfo(key);
  return account ? amountOf(account.data) : 0n;
};

/** What each step asked for, reported at the end. */
const budgets: { label: string; asked: number }[] = [];

/**
 * The runner's loop, without React.
 *
 * Deliberately the same order of operations as `src/lib/batch.ts` — re-read the
 * arrays, skip a step whose `creates` account is already there, then send — so
 * that what this proves is the real sequence and not a simplified one.
 */
async function runSteps(steps: Step[], pool: PublicKey, label: string) {
  let sent = 0;
  let skipped = 0;
  for (const s of steps) {
    if (s.creates && (await exists(s.creates))) {
      skipped += 1;
      continue;
    }
    if (s.destroys && !(await exists(s.destroys))) {
      skipped += 1;
      continue;
    }
    if (s.grows) {
      const account = await connection.getAccountInfo(s.grows.account);
      if ((account?.data.length ?? 0) >= s.grows.toLength) {
        skipped += 1;
        continue;
      }
    }
    const activeId = parsePool((await connection.getAccountInfo(pool))!.data).activeId;
    if (!stepIsLegal(s, activeId)) throw new Error(`${s.label}: active bin moved to ${activeId}`);

    const have = new Set<number>();
    for (const index of s.binArrays) {
      if (await exists(binArrayOf(pool, index))) have.add(index);
    }
    // Sent with the plan's own estimate, never a blanket 1.4M. That is the
    // point: a wallet sets the limit from `CU` in the planner, so an estimate
    // that is too low is a transaction that fails for a user — and the only way
    // to find out is to run at it. The localnet has no `getTransaction`, so the
    // consumption cannot be read back; succeeding at the planned budget is the
    // assertion, and `tests/tests/compute.rs` is where the numbers are metered.
    // `s.signers` carries the new position's keypair on an opening step: a
    // position is a keypair account and signs itself into existence.
    await send(s.build(have), s.signers ?? [], s.computeUnits);
    budgets.push({ label: s.label, asked: s.computeUnits });
    sent += 1;
  }
  console.log(`  ${label}: ${sent} sent, ${skipped} skipped`);
  return { sent, skipped };
}

// `binArrayPda` needs the pool; wrap it so `runSteps` reads cleanly.
const { binArrayPda } = await import("taper-amm-sdk");
const binArrayOf = (pool: PublicKey, index: number) => binArrayPda(pool, index);

// --------------------------------------------------------------------------

step("localnet reachable");
if (!(await connection.getVersion().catch(() => null))) {
  console.error("no RPC at the configured url — start scripts/start-localnet.ps1 first");
  process.exit(1);
}
await confirm(await connection.requestAirdrop(wallet.publicKey, 500 * 1e9));

// --------------------------------------------------------------------------

step("two mints and a pool");
const mints = [Keypair.generate(), Keypair.generate()];
const supply = 1_000_000n * 10n ** 9n;
for (const m of mints) {
  const ata = ataFor(m.publicKey, wallet.publicKey, TOKEN_PROGRAM_ID);
  await send(
    [
      SystemProgram.createAccount({
        fromPubkey: wallet.publicKey,
        newAccountPubkey: m.publicKey,
        lamports: await connection.getMinimumBalanceForRentExemption(MINT_SIZE),
        space: MINT_SIZE,
        programId: TOKEN_PROGRAM_ID
      }),
      createInitializeMintInstruction(m.publicKey, 9, wallet.publicKey, null, TOKEN_PROGRAM_ID),
      createAssociatedTokenAccountInstruction(
        wallet.publicKey,
        ata,
        wallet.publicKey,
        m.publicKey,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      ),
      createMintToInstruction(m.publicKey, ata, wallet.publicKey, supply, [], TOKEN_PROGRAM_ID)
    ],
    [m]
  );
}

const [mintX, mintY] = orderMints(mints[0].publicKey, mints[1].publicKey);
const tokens: TokenPair = { mintX, programX: TOKEN_PROGRAM_ID, mintY, programY: TOKEN_PROGRAM_ID };

const preset = PRESETS[0];
const config = configPda(wallet.publicKey, preset.index);
if (!(await exists(config))) await send([initializeConfigIx(wallet.publicKey, presetParams(preset))], [], 200_000);
const pool = poolPda(config, mintX, mintY);
if (!(await exists(pool))) {
  await send([initializePoolIx(wallet.publicKey, config, tokens, 0)], [], 200_000);
}

const configView = parseConfig((await connection.getAccountInfo(config))!.data);
const poolView = parsePool((await connection.getAccountInfo(pool))!.data);
const reserveX = reservePda(pool, mintX);
const reserveY = reservePda(pool, mintY);
const userX = ataFor(mintX, wallet.publicKey, TOKEN_PROGRAM_ID);
const userY = ataFor(mintY, wallet.publicKey, TOKEN_PROGRAM_ID);

const accounts: BaseAccounts = {
  owner: wallet.publicKey,
  pool,
  config,
  tokens,
  userTokenX: userX,
  userTokenY: userY,
  reserveX,
  reserveY
};
check("pool opened at bin 0", poolView.activeId === 0);

// --------------------------------------------------------------------------

step("a band wider than one transaction, in one position");
const LOWER = -80;
const UPPER = 79;
const BAND = UPPER - LOWER + 1;
const AMOUNT = 100_000n * 10n ** 9n;

// Two different limits produce transactions here, and they are worth naming
// apart. The *packet* caps a deposit chunk; the position's own storage caps
// where a chunk may land until `extend_position` has grown it.
const cap = widthThatFits(accounts, TX_HEADROOM);
check(
  `${BAND} bins is one position, filled ${cap} bins at a time`,
  splitRange(LOWER, UPPER).length === 1 && BAND > cap && BAND <= MAX_BINS_PER_POSITION,
  `chunk cap ${cap}, ceiling ${MAX_BINS_PER_POSITION}`
);
// And a caller who wants several narrow positions can still have them.
const narrow = splitRange(LOWER, UPPER, "packed", INLINE_BINS_PER_POSITION);
check(
  `the same band splits into ${narrow.length} on request`,
  narrow.length > 1 && narrow.every((sp) => sp.width <= INLINE_BINS_PER_POSITION),
  narrow.map((sp) => `${sp.lowerBinId}…${sp.upperBinId}`).join("  ")
);

const plan = planDeposit({
  accounts,
  lower: LOWER,
  upper: UPPER,
  activeId: 0,
  amountX: AMOUNT,
  amountY: AMOUNT,
  shape: "curve",
  spotBlendBps: 2_000,
  headroom: TX_HEADROOM
});
const kinds = plan.steps.map((st) => st.kind);
check(
  "open at the whole band, then fill — no growth on the way",
  plan.positions.length === 1 &&
    kinds[0] === "openPosition" &&
    !kinds.includes("resizePosition") &&
    kinds.slice(1).every((k) => k === "addLiquidity"),
  kinds.join(" → ")
);
check(
  "the account is allocated for the whole band up front",
  plan.positions[0].capacity === BAND && plan.newPositionBytes === positionLenFor(BAND),
  `${plan.positions[0].capacity} bins, ${plan.newPositionBytes} bytes`
);
check(
  "the split spends the whole deposit",
  plan.allocatedX === AMOUNT && plan.allocatedY === AMOUNT,
  `${plan.allocatedX} / ${plan.allocatedY}`
);
check(
  "every step fits the compute budget",
  plan.steps.every((s) => s.computeUnits <= 1_400_000),
  plan.steps.map((s) => s.computeUnits).join(", ")
);
const sizes = plan.steps.map((s) =>
  // An opening step carries a second signature, 64 bytes the others do not.
  transactionSize(s.build(new Set()), wallet.publicKey, 1 + (s.signers?.length ?? 0))
);
check(
  "every step fits the packet, cold",
  sizes.every((n) => n + TX_HEADROOM <= MAX_TX_BYTES),
  `${sizes.join(", ")} bytes of ${MAX_TX_BYTES - TX_HEADROOM}`
);

await runSteps(plan.steps, pool, "deposit");

for (const p of plan.positions) {
  check(`position ${p.spec.lowerBinId}…${p.spec.upperBinId} exists`, await exists(p.address));
}

// --------------------------------------------------------------------------

step("bins hold exactly what the plan predicted");
const cells = await loadBins(connection, pool, poolView, configView, LOWER, UPPER);
const onChain = new Map(cells.map((c) => [c.binId, c]));

let worstX = 0n;
let worstY = 0n;
let funded = 0;
for (const p of plan.positions) {
  for (const row of preview(p.dist, p.amountX, p.amountY)) {
    const bin = onChain.get(row.binId)!;
    const dx = bin.amountX > row.amountX ? bin.amountX - row.amountX : row.amountX - bin.amountX;
    const dy = bin.amountY > row.amountY ? bin.amountY - row.amountY : row.amountY - bin.amountY;
    if (dx > worstX) worstX = dx;
    if (dy > worstY) worstY = dy;
    funded += 1;
  }
}
check("every funded bin matches the preview to the raw unit", worstX === 0n && worstY === 0n, `worst ${worstX} X / ${worstY} Y across ${funded} bins`);

// The shape must not step at a chunk boundary — the seam is where a wrong
// renormalisation shows, because each chunk spends a full 10_000 bps of its own.
// The active bin sits out the walk: it is the only bin holding both tokens,
// and the shape splits its weight between two legs that are normalised against
// two different sides, so the raw sum of its amounts is not comparable with a
// one-sided neighbour's. The SDK's own tests pin what that bin gets.
let steps = 0;
for (let id = LOWER + 1; id <= -1; id += 1) {
  const here = onChain.get(id)!;
  const below = onChain.get(id - 1)!;
  if (here.amountX + here.amountY < below.amountX + below.amountY) steps += 1;
}
for (let id = 1; id < UPPER; id += 1) {
  const here = onChain.get(id)!;
  const above = onChain.get(id + 1)!;
  if (here.amountX + here.amountY < above.amountX + above.amountY) steps += 1;
}
check("the curve falls away monotonically, chunk seams included", steps === 0, `${steps} reversals`);

const reserved = { x: await tokenAmount(reserveX), y: await tokenAmount(reserveY) };
check(
  "the reserves hold the deposit, less per-bin rounding",
  reserved.x <= AMOUNT && reserved.y <= AMOUNT && reserved.x > (AMOUNT * 9_999n) / 10_000n,
  `${reserved.x} of ${AMOUNT}`
);

// --------------------------------------------------------------------------

step("the witnessed steps are skipped on a re-run");
// `creates` and `grows` are the two witnesses a runner can check from chain
// state, and this is them working: the position exists, and it is already as
// long as every extension asked for. A *fill* has no witness, so those steps
// are deliberately excluded here — re-sending one would deposit twice, which
// is exactly why a plan is resumed inside the run that started it and never
// replayed from cold.
const witnessed = plan.steps.filter((st) => st.creates || st.grows);
const again = await runSteps(witnessed, pool, "resume");
check(
  `all ${witnessed.length} witnessed steps skipped`,
  again.sent === 0 && again.skipped === witnessed.length
);
check("and the fills are the ones with no witness", witnessed.length < plan.steps.length);

// --------------------------------------------------------------------------

step("read back what the deposit left on chain");
const held: { address: PublicKey; view: PositionView }[] = [];
for (const p of plan.positions) {
  held.push({ address: p.address, view: parsePosition((await connection.getAccountInfo(p.address))!.data) });
}

// Taken before the ranged withdrawal below, so the two withdrawals together
// are measured against what went in.
const beforeX = await tokenAmount(userX);
const beforeY = await tokenAmount(userY);

// --------------------------------------------------------------------------

step("a ranged withdrawal takes one edge and leaves the rest in the pool");
// `remove_liquidity` has always taken a bin-by-bin list, so narrowing a
// withdrawal is a matter of which bins that list is built from. What is being
// checked is that it really is a stretch: the bins outside it keep their
// shares, the position stays open, and nothing is closed.
const edgeOf = held[0];
const edgeWidth = Math.min(edgeOf.view.width, edgeOf.view.capacity);
const edge = {
  lower: edgeOf.view.lowerBinId,
  upper: edgeOf.view.lowerBinId + Math.min(9, edgeWidth - 1)
};
const inEdge = edgeOf.view.shares.filter(
  (share, i) => share > 0n && edgeOf.view.lowerBinId + i <= edge.upper
).length;

const ranged = planExit({ accounts, positions: held, bps: 10_000, range: edge, headroom: TX_HEADROOM });
check(
  "a range never closes, whatever the percentage",
  ranged.closing === 0 && ranged.steps.every((st) => st.destroys === undefined)
);
check(
  `${inEdge} bins burned, and only in the first position`,
  ranged.bins === inEdge && ranged.steps.length === 1,
  `${ranged.bins} bins over ${ranged.steps.length} steps`
);
await runSteps(ranged.steps, pool, "ranged");

const shed = parsePosition((await connection.getAccountInfo(edgeOf.address))!.data);
check("the position is still open", await exists(edgeOf.address));
check(
  "the edge is empty and the rest of the band is not",
  shed.shares.every((share, i) => (shed.lowerBinId + i <= edge.upper ? share === 0n : true)) &&
    shed.shares.some((share, i) => shed.lowerBinId + i > edge.upper && share > 0n)
);
check(
  "and the reserves kept what the other bins hold",
  (await tokenAmount(reserveX)) > 0n && (await tokenAmount(reserveY)) > 0n
);

// Re-aimed at bins it has just emptied, the same plan is nothing at all — not
// even a claim. A claim rides along with a withdrawal because a withdrawal
// checkpoints a fee on its way out; with no shares to burn there is nothing to
// ride on, and sweeping the whole position's fees is not what a range asked
// for.
const emptied = planExit({
  accounts,
  positions: [{ address: edgeOf.address, view: shed }],
  bps: 10_000,
  range: edge,
  headroom: TX_HEADROOM
});
check("re-aiming at emptied bins plans nothing", emptied.steps.length === 0 && emptied.bins === 0);

// --------------------------------------------------------------------------

step("a ranged deposit refills that edge, and only that edge");
/*
 * The mirror of the withdrawal above, and the reason both are here: a range is
 * *which bins receive liquidity*, not a band to open. Refilling ten bins of a
 * 160-bin position is one `add_liquidity` over those ten — the planner matches
 * the stretch to the position that contains it, the band does not move, and no
 * second position is opened over bins the first one already spans.
 *
 * Y only. Every bin in this edge sits below the active one, so it can hold
 * nothing else; the planner would allocate an X amount to no bin at all, which
 * is why `DepositForm` refuses that token at its own field rather than sending
 * a deposit that quietly drops it.
 */
const REFILL = AMOUNT / 100n;
const edgeBand = { lowerBinId: shed.lowerBinId, upperBinId: shed.upperBinId, capacity: shed.capacity };
const refill = planDeposit({
  accounts,
  lower: edge.lower,
  upper: edge.upper,
  activeId: 0,
  amountX: 0n,
  amountY: REFILL,
  shape: "spot",
  existingPositions: [{ address: edgeOf.address, ...edgeBand }],
  // Every array this band spans is already on chain — the first deposit paid
  // for them. A stretch quotes rent for the bins it names and no others, so
  // with the arrays declared there is nothing left to rent.
  existingArrays: cells.map((c) => c.arrayIndex),
  headroom: TX_HEADROOM
});
check(
  "a stretch of a held band opens no second position",
  refill.newPositions === 0 &&
    refill.positions.length === 1 &&
    refill.positions[0].address.equals(edgeOf.address),
  `${refill.newPositions} opened, ${refill.positions.length} targeted`
);
check(
  "and resizes nothing — the band it names is the band it has",
  refill.steps.every((st) => st.kind === "addLiquidity") &&
    refill.positions[0].band.lower === shed.lowerBinId &&
    refill.positions[0].band.upper === shed.upperBinId,
  refill.steps.map((st) => st.kind).join(" → ")
);
check(
  "the whole amount goes into the stretch, not a share of it",
  refill.allocatedY === REFILL && refill.allocatedX === 0n,
  `${refill.allocatedY} of ${REFILL}`
);
check(
  "and it rents no arrays, because these bins are already on chain",
  refill.missingArrays.length === 0,
  refill.missingArrays.join(", ")
);
// What the client has to refuse for itself: a stretch below the price has no
// bin that may hold X, so the shape weights nothing and the amount would be
// dropped rather than deposited. `takesX` in `DepositForm` is that check.
const wrongSide = planDeposit({
  accounts,
  lower: edge.lower,
  upper: edge.upper,
  activeId: 0,
  amountX: REFILL,
  amountY: 0n,
  shape: "spot",
  existingPositions: [{ address: edgeOf.address, ...edgeBand }],
  headroom: TX_HEADROOM
});
check(
  "X offered to a stretch below the price allocates nowhere",
  wrongSide.allocatedX === 0n && wrongSide.steps.length === 0
);

await runSteps(refill.steps, pool, "refill");

const refilled = parsePosition((await connection.getAccountInfo(edgeOf.address))!.data);
check(
  "the band is exactly where it was",
  refilled.lowerBinId === shed.lowerBinId &&
    refilled.upperBinId === shed.upperBinId &&
    refilled.capacity === shed.capacity,
  `${refilled.lowerBinId}…${refilled.upperBinId}`
);
check(
  "the edge holds shares again",
  refilled.shares.some((share, i) => refilled.lowerBinId + i <= edge.upper && share > 0n)
);
check(
  "and no bin outside it moved",
  refilled.shares.every(
    (share, i) => refilled.lowerBinId + i <= edge.upper || share === shed.shares[i]
  )
);

// --------------------------------------------------------------------------

step("rebalance the rest into a higher band");
// The views the exit below burns from have to be the ones on chain, not the
// ones the ranged withdrawal invalidated.
held.length = 0;
for (const p of plan.positions) {
  held.push({ address: p.address, view: parsePosition((await connection.getAccountInfo(p.address))!.data) });
}

const exit = planExit({ accounts, positions: held, bps: 10_000, close: true, headroom: TX_HEADROOM });
check(
  `emptied in ${exit.steps.length} chunks, closed once`,
  exit.steps.filter((st) => st.destroys).length === plan.positions.length &&
    exit.closing === plan.positions.length &&
    exit.steps[exit.steps.length - 1].destroys !== undefined
);
await runSteps(exit.steps, pool, "exit");

for (const p of plan.positions) check(`position ${p.spec.lowerBinId}… is closed`, !(await exists(p.address)));
check(
  "the reserves are empty again",
  (await tokenAmount(reserveX)) === 0n && (await tokenAmount(reserveY)) === 0n,
  `${await tokenAmount(reserveX)} X / ${await tokenAmount(reserveY)} Y`
);

// The measurement a rebalance makes: what came back, not what is held.
const proceedsX = (await tokenAmount(userX)) - beforeX;
const proceedsY = (await tokenAmount(userY)) - beforeY;
check(
  "the closures returned the deposit",
  proceedsX > (AMOUNT * 9_999n) / 10_000n && proceedsY > (AMOUNT * 9_999n) / 10_000n,
  `${proceedsX} X / ${proceedsY} Y back of ${AMOUNT} each`
);

const redeposit = planDeposit({
  accounts,
  lower: -40,
  upper: 119,
  activeId: 0,
  amountX: proceedsX,
  amountY: proceedsY,
  shape: "bidask",
  spotBlendBps: 3_000,
  existingPositions: [],
  headroom: TX_HEADROOM
});
check(
  "the new band is planned the same way",
  redeposit.positions.length === 1 && redeposit.steps[0].kind === "openPosition",
  redeposit.steps.map((st) => st.kind).join(" → ")
);
await runSteps(redeposit.steps, pool, "redeposit");

for (const p of redeposit.positions) {
  check(`reopened ${p.spec.lowerBinId}…${p.spec.upperBinId}`, await exists(p.address));
}
check(
  "the proceeds went back in",
  (await tokenAmount(reserveX)) > (proceedsX * 9_999n) / 10_000n,
  `${await tokenAmount(reserveX)} of ${proceedsX}`
);

// --------------------------------------------------------------------------

step("move a band in place, without closing the position");
// The difference from the close-and-reopen above: the position keeps its
// address, its fee checkpoints and its claimed totals, and the bins the two
// bands share never leave the reserve.
const moving = redeposit.positions[0];
const beforeMove = parsePosition((await connection.getAccountInfo(moving.address))!.data);
const target = { lower: beforeMove.lowerBinId + 40, upper: beforeMove.upperBinId + 40 };

const rebalance = planRebalance({
  accounts,
  position: { address: moving.address, view: beforeMove },
  target,
  headroom: TX_HEADROOM
});
check(
  "the plan empties what leaves before it moves",
  rebalance.steps.findIndex((st) => st.kind === "resizePosition") > 0 &&
    rebalance.steps
      .slice(0, rebalance.steps.findIndex((st) => st.kind === "resizePosition"))
      .every((st) => st.kind === "exitPosition"),
  rebalance.steps.map((st) => st.kind).join(" → ")
);
check(
  "and it knows what survives",
  rebalance.kept.length === beforeMove.upperBinId - target.lower + 1 &&
    rebalance.leaving.length === 40 &&
    rebalance.arriving.length === 40,
  `${rebalance.kept.length} kept, ${rebalance.leaving.length} out, ${rebalance.arriving.length} in`
);

// What the kept bins hold before the move, so the move can be checked to have
// carried each one to its new slot without changing which bin owns it.
const keptBefore = rebalance.kept.map((bin) => ({
  bin,
  share: beforeMove.shares[bin - beforeMove.lowerBinId]
}));
const reserveXBeforeMove = await tokenAmount(reserveX);
const reserveYBeforeMove = await tokenAmount(reserveY);

await runSteps(rebalance.steps, pool, "move");

const afterMove = parsePosition((await connection.getAccountInfo(moving.address))!.data);
check("the position still exists at the same address", await exists(moving.address));
check(
  "the band moved",
  afterMove.lowerBinId === target.lower && afterMove.upperBinId === target.upper,
  `${afterMove.lowerBinId}…${afterMove.upperBinId}`
);
check(
  "every kept bin still holds exactly what it held, at its own bin id",
  keptBefore.every(({ bin, share }) => afterMove.shares[bin - afterMove.lowerBinId] === share),
  `${keptBefore.length} bins checked`
);
check(
  "the bins the move added are empty",
  rebalance.arriving.every((bin) => afterMove.shares[bin - afterMove.lowerBinId] === 0n)
);
check(
  "the claimed totals survived the move",
  afterMove.totalClaimedFeeX >= beforeMove.totalClaimedFeeX &&
    afterMove.totalClaimedFeeY >= beforeMove.totalClaimedFeeY
);
// The sharpest statement of what a move buys, and it falls out of which side
// of the active bin each bin sits on. The band slid *up*, so the bins that
// left are the ones below the active bin, which hold Y — and the bins that
// stayed are the ones above it, which hold X and never left the reserve.
check(
  "the Y the leaving bins held came out",
  (await tokenAmount(reserveY)) < reserveYBeforeMove,
  `${await tokenAmount(reserveY)} of ${reserveYBeforeMove}`
);
check(
  "and the X the overlap held never moved",
  (await tokenAmount(reserveX)) === reserveXBeforeMove,
  `${await tokenAmount(reserveX)} of ${reserveXBeforeMove}`
);

// --------------------------------------------------------------------------

step("a one-sided deposit opens no position it cannot fund");
const oneSided = planDeposit({
  accounts,
  lower: -150,
  upper: -71,
  activeId: 0,
  amountX: 1_000n * 10n ** 9n,
  amountY: 0n,
  shape: "spot",
  existingPositions: []
});
check(
  "nothing to do below the active bin with no Y",
  oneSided.steps.length === 0,
  `${oneSided.positions.length} positions planned`
);

// --------------------------------------------------------------------------

step("the compute estimates were sufficient");
// Every step above ran at the limit `CU` predicted for it rather than at a
// blanket 1.4M, so reaching here at all is the check: an under-estimate aborts
// with "exceeded CUs meter" and takes the run down with it.
check(
  "every step completed inside its own estimate",
  budgets.length > 0,
  budgets.map((b) => `${b.label.split(" ")[0]} ${b.asked}`).join(", ")
);

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
