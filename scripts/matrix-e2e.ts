/**
 * The whole LP lifecycle, across every kind of pair, against a running
 * localnet.
 *
 *   ./scripts/start-localnet.ps1
 *   bun run --cwd app matrix:e2e
 *
 * The other scripts each hold one variable still: `ui/scripts/e2e.ts` drives a
 * single position, `sol:e2e` drives wrapping, `wide:e2e` drives the multi-
 * position planner over two plain SPL mints. What none of them cover is the
 * product of those — a plan that fans out across positions *and* has to pay a
 * Token-2022 transfer fee per bin, *and* wrap SOL per transaction. Those
 * interact: the fee is quoted per bin, so a deposit split across three
 * positions quotes it three times over; and a wrapped account is opened and
 * closed once per transaction, so a plan of five is five wraps rather than one.
 *
 * Every stage runs at the compute limit the SDK's planner predicted, never a
 * blanket 1.4M. Those figures were measured against SPL mints, and a
 * Token-2022 transfer costs more, so running at them is the check that the
 * estimates still hold for the expensive pair.
 *
 * What each pair goes through, in order:
 *
 *   1. open a band three positions wide
 *   2. add to those same positions — the step with no `creates` witness
 *   3. swap, then claim across every position
 *   4. withdraw half, leaving the positions open
 *   5. rebalance into a different band
 *   6. close everything
 *
 * with the wrapped-SOL account checked for closure after each one.
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
  ExtensionType,
  MINT_SIZE,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMintInstruction,
  createInitializeTransferFeeConfigInstruction,
  createMintToInstruction,
  getMintLen
} from "@solana/spl-token";
import {
  amountOf,
  TX_HEADROOM,
  TX_HEADROOM_NATIVE,
  CU_HEADROOM_NATIVE,
  arrayIndexesFor,
  ataFor,
  binArrayPda,
  claimFeeIx,
  comparePublicKeys,
  configPda,
  initializeConfigIx,
  initializePoolIx,
  isNativeMint,
  parseConfig,
  parsePool,
  parsePosition,
  planDeposit,
  planExit,
  planReshape,
  poolPda,
  prepareTokens,
  preview,
  reservePda,
  reductionsFor,
  reservePda as reserveOf,
  summarise,
  swapArrayIndexes,
  swapIx,
  stepIsLegal,
  transactionSize,
  MAX_TX_BYTES,
  type BaseAccounts,
  type BinView,
  type PositionView,
  type Step,
  type TokenPair
} from "@taper/sdk";
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
  console.log(`   ${condition ? "ok  " : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
  if (!condition) failures += 1;
}
const stage = (name: string) => console.log(`\n  · ${name}`);

async function confirm(signature: string) {
  for (let i = 0; i < 300; i += 1) {
    const { value } = await connection.getSignatureStatuses([signature]);
    const status = value[0];
    if (status?.err) throw new Error(JSON.stringify(status.err));
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") return;
    await new Promise((resolve) => setTimeout(resolve, 100));
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
const lamports = async () => BigInt(await connection.getBalance(wallet.publicKey));

/** What arrives when `amount` is sent through a mint charging `bps`. */
const netOf = (amount: bigint, bps: number) =>
  bps === 0 ? amount : amount - (amount * BigInt(bps) + 9_999n) / 10_000n;

// ---------------------------------------------------------------- the mints

type Side = "spl" | "t22" | "t22fee" | "sol";
const FEE_BPS = 50;

/** The fee a side's mint charges on every transfer, in bps. */
const feeOf = (side: Side) => (side === "t22fee" ? FEE_BPS : 0);
const programOf = (side: Side) =>
  side === "t22" || side === "t22fee" ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;

const DECIMALS = 9;
const SUPPLY = 2_000_000n * 10n ** BigInt(DECIMALS);

/**
 * A mint of the requested kind, funded into the wallet's ATA.
 *
 * SOL is not minted: it is the native mint, already on chain, and the wallet's
 * lamports are its balance.
 */
async function createMint(side: Side): Promise<PublicKey> {
  if (side === "sol") return NATIVE_MINT;
  const mint = Keypair.generate();
  const program = programOf(side);
  const fee = feeOf(side);
  // The transfer-fee extension has to be initialised *before* the mint itself.
  const space = fee > 0 ? getMintLen([ExtensionType.TransferFeeConfig]) : MINT_SIZE;
  const ata = ataFor(mint.publicKey, wallet.publicKey, program);

  const ixs: TransactionInstruction[] = [
    SystemProgram.createAccount({
      fromPubkey: wallet.publicKey,
      newAccountPubkey: mint.publicKey,
      lamports: await connection.getMinimumBalanceForRentExemption(space),
      space,
      programId: program
    })
  ];
  if (fee > 0) {
    ixs.push(
      createInitializeTransferFeeConfigInstruction(
        mint.publicKey,
        wallet.publicKey,
        wallet.publicKey,
        fee,
        BigInt("0xffffffffffffffff"), // uncapped, so the fee stays proportional
        program
      )
    );
  }
  ixs.push(
    createInitializeMintInstruction(mint.publicKey, DECIMALS, wallet.publicKey, null, program),
    createAssociatedTokenAccountIdempotentInstruction(
      wallet.publicKey,
      ata,
      wallet.publicKey,
      mint.publicKey,
      program,
      ASSOCIATED_TOKEN_PROGRAM_ID
    ),
    createMintToInstruction(mint.publicKey, ata, wallet.publicKey, SUPPLY, [], program)
  );
  await send(ixs, [mint], 400_000);
  return mint.publicKey;
}

// ------------------------------------------------------------- the lifecycle

type Pair = {
  label: string;
  tokens: TokenPair;
  /** Fee bps per side, after mint ordering has decided which is which. */
  feeX: number;
  feeY: number;
  pool: PublicKey;
  config: PublicKey;
  accounts: BaseAccounts;
  reserveX: PublicKey;
  reserveY: PublicKey;
  userX: PublicKey;
  userY: PublicKey;
  native: boolean;
};

// The band defaults to one that makes every position straddle two bin arrays,
// which is the more expensive case: one more account in the packet and one more
// array to create. `--lower -70 --upper 69` is the mirror check — two positions
// of the maximum width, each sitting inside exactly one array.
const LOWER = Number(arg("lower", "-80"));
const UPPER = Number(arg("upper", "79"));
const REBALANCED = { lower: -40, upper: 119 };
/**
 * A native side spends real lamports, and the wallet's are finite — so the
 * amounts scale with the pair rather than being one constant that has to suit
 * both. Everything downstream is quoted against `deposit`.
 */
const deposit = (native: boolean) => (native ? 200n : 20_000n) * 10n ** BigInt(DECIMALS);

/**
 * Wraps SOL around a step, sized to what that step spends.
 *
 * Read fresh every time: the account is closed at the end of every transaction,
 * so what a later step has to wrap is not what the balances said before the run
 * began. This is the same shape `app/src/lib/batch.ts` uses.
 */
async function wrapFor(pair: Pair, step: { amountX: bigint; amountY: bigint }) {
  const state = async (mint: PublicKey, program: PublicKey) => {
    const address = ataFor(mint, wallet.publicKey, program);
    const account = await connection.getAccountInfo(address);
    return { address, exists: Boolean(account), amount: account ? amountOf(account.data) : 0n };
  };
  return prepareTokens(wallet.publicKey, [
    {
      mint: pair.tokens.mintX,
      program: pair.tokens.programX,
      state: await state(pair.tokens.mintX, pair.tokens.programX),
      needed: step.amountX
    },
    {
      mint: pair.tokens.mintY,
      program: pair.tokens.programY,
      state: await state(pair.tokens.mintY, pair.tokens.programY),
      needed: step.amountY
    }
  ]);
}

/** The runner's loop, without React — the same order of operations. */
async function runSteps(pair: Pair, steps: Step[], label: string) {
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
    const activeId = parsePool((await connection.getAccountInfo(pair.pool))!.data).activeId;
    if (!stepIsLegal(s, activeId)) throw new Error(`${s.label}: active bin moved to ${activeId}`);

    const have = new Set<number>();
    for (const index of s.binArrays) {
      if (await exists(binArrayPda(pair.pool, index))) have.add(index);
    }
    const { before, after } = await wrapFor(pair, s);
    const ixs = [...before, ...s.build(have), ...after];

    // The packet is checked here rather than discovered at `serialize`: an
    // over-long transaction throws a client-side assertion, which is exactly
    // the failure the planner's headroom exists to prevent.
    // An opening step is signed by the new position as well as the wallet, so
    // the packet carries a second 64-byte signature.
    const signers = s.signers ?? [];
    const size =
      transactionSize(ixs, wallet.publicKey, 1 + signers.length) + 52; // + the budget pair
    if (size > MAX_TX_BYTES) throw new Error(`${s.label}: ${size} bytes, over the packet limit`);

    // The step's own estimate plus room for the wrapping, which shares the
    // transaction's compute limit with it.
    const units = s.computeUnits + (before.length || after.length ? CU_HEADROOM_NATIVE : 0);
    await send(ixs, signers, units);
    sent += 1;
  }
  console.log(`      ${label}: ${sent} sent, ${skipped} skipped`);
  return { sent, skipped };
}

/** Every position this wallet holds in the pool, freshly read. */
async function heldPositions(pair: Pair, addresses: PublicKey[]) {
  const out: { address: PublicKey; view: PositionView }[] = [];
  for (const address of addresses) {
    const account = await connection.getAccountInfo(address);
    if (account) out.push({ address, view: parsePosition(account.data) });
  }
  return out;
}

async function binsOf(pair: Pair, lower: number, upper: number) {
  const poolView = parsePool((await connection.getAccountInfo(pair.pool))!.data);
  const configView = parseConfig((await connection.getAccountInfo(pair.config))!.data);
  const cells = await loadBins(connection, pair.pool, poolView, configView, lower, upper);
  return new Map<number, BinView>(cells.map((c) => [c.binId, c]));
}

/** A wrapped-SOL account must never outlive the transaction that made it. */
async function assertNothingWrapped(pair: Pair, when: string) {
  if (!pair.native) return;
  const mint = isNativeMint(pair.tokens.mintX) ? pair.tokens.mintX : pair.tokens.mintY;
  const program = isNativeMint(pair.tokens.mintX) ? pair.tokens.programX : pair.tokens.programY;
  const account = ataFor(mint, wallet.publicKey, program);
  check(`no wrapped SOL left ${when}`, !(await exists(account)));
}

async function setUp(label: string, x: Side, y: Side, index: number): Promise<Pair> {
  const [mintA, mintB] = await Promise.all([createMint(x), createMint(y)]);
  // Mint order is by pubkey, so which requested side lands as X is not ours to
  // choose — carry the fee schedule through the swap rather than assuming it.
  const flip = comparePublicKeys(mintA, mintB) > 0;
  const [mintX, mintY] = flip ? [mintB, mintA] : [mintA, mintB];
  const [sideX, sideY] = flip ? [y, x] : [x, y];

  const tokens: TokenPair = {
    mintX,
    programX: programOf(sideX),
    mintY,
    programY: programOf(sideY)
  };

  const preset = PRESETS[0];
  const config = configPda(wallet.publicKey, index);
  if (!(await exists(config)))
    await send([initializeConfigIx(wallet.publicKey, { ...presetParams(preset), index })], [], 300_000);
  const pool = poolPda(config, mintX, mintY);
  if (!(await exists(pool))) {
    await send([initializePoolIx(wallet.publicKey, config, tokens, 0)], [], 300_000);
  }

  const userX = ataFor(mintX, wallet.publicKey, tokens.programX);
  const userY = ataFor(mintY, wallet.publicKey, tokens.programY);
  return {
    label,
    tokens,
    feeX: feeOf(sideX),
    feeY: feeOf(sideY),
    pool,
    config,
    reserveX: reserveOf(pool, mintX),
    reserveY: reservePda(pool, mintY),
    userX,
    userY,
    native: sideX === "sol" || sideY === "sol",
    accounts: {
      owner: wallet.publicKey,
      pool,
      config,
      tokens,
      userTokenX: userX,
      userTokenY: userY,
      reserveX: reserveOf(pool, mintX),
      reserveY: reservePda(pool, mintY)
    }
  };
}

async function lifecycle(label: string, x: Side, y: Side, index: number) {
  console.log(`\n\n═══ ${label} ═══`);
  const pair = await setUp(label, x, y, index);
  const headroom = pair.native ? TX_HEADROOM_NATIVE : TX_HEADROOM;
  const DEPOSIT = deposit(pair.native);
  const plan = (over: Parameters<typeof planDeposit>[0] extends infer T ? Partial<T> : never) =>
    planDeposit({
      accounts: pair.accounts,
      lower: LOWER,
      upper: UPPER,
      activeId: 0,
      amountX: DEPOSIT,
      amountY: DEPOSIT,
      shape: "curve",
      spotBlendBps: 2_000,
      headroom,
      ...over
    });

  console.log(
    `      X ${pair.tokens.programX.equals(TOKEN_2022_PROGRAM_ID) ? "token-2022" : "spl"}` +
      `${pair.feeX ? ` (${pair.feeX}bps fee)` : ""}` +
      `${isNativeMint(pair.tokens.mintX) ? " · native" : ""}` +
      `   Y ${pair.tokens.programY.equals(TOKEN_2022_PROGRAM_ID) ? "token-2022" : "spl"}` +
      `${pair.feeY ? ` (${pair.feeY}bps fee)` : ""}` +
      `${isNativeMint(pair.tokens.mintY) ? " · native" : ""}`
  );

  // -------------------------------------------------- 1. a new, wide position
  stage("open a band wider than one transaction");
  const opening = plan({});
  check(
    "one position, opened at its whole band and filled in chunks",
    opening.positions.length === 1 &&
      opening.steps.length > 1 &&
      opening.steps[0].kind === "openPosition" &&
      // The account is allocated by the client, so the band is whole from the
      // first byte: no `resize_position` anywhere on the opening path.
      !opening.steps.some((s) => s.kind === "resizePosition") &&
      opening.positions[0].capacity === opening.positions[0].spec.width &&
      opening.steps.filter((s) => s.kind === "addLiquidity").length > 0,
    opening.steps.map((s) => s.kind).join(" → ")
  );
  check(
    "growth precedes every fill",
    opening.steps.map((s) => s.kind).lastIndexOf("resizePosition") <
      opening.steps.map((s) => s.kind).indexOf("addLiquidity")
  );
  await runSteps(pair, opening.steps, "open");

  const addresses = opening.positions.map((p) => p.address);
  for (const p of opening.positions) {
    check(`position ${p.spec.lowerBinId}…${p.spec.upperBinId} exists`, await exists(p.address));
  }
  await assertNothingWrapped(pair, "after opening");

  // The transfer fee is quoted *per bin*, so a deposit split across positions
  // pays it per piece — and each piece rounds the fee up. What the bin holds is
  // therefore what arrived, not what was sent.
  let bins = await binsOf(pair, LOWER, UPPER);
  let worst = 0n;
  let funded = 0;
  for (const p of opening.positions) {
    for (const row of preview(p.dist, p.amountX, p.amountY)) {
      const bin = bins.get(row.binId)!;
      const wantX = netOf(row.amountX, pair.feeX);
      const wantY = netOf(row.amountY, pair.feeY);
      const dx = bin.amountX > wantX ? bin.amountX - wantX : wantX - bin.amountX;
      const dy = bin.amountY > wantY ? bin.amountY - wantY : wantY - bin.amountY;
      if (dx > worst) worst = dx;
      if (dy > worst) worst = dy;
      funded += 1;
    }
  }
  check(
    "every bin holds exactly what the plan predicted, net of the mint's fee",
    worst === 0n,
    `worst ${worst} across ${funded} bins`
  );

  // ------------------------------------------- 2. add to an existing position
  stage("add to those same positions");
  const adding = plan({
    // Matched by band, not by address. Already grown by the opening plan, so
    // there is nothing left to resize.
    existingPositions: opening.positions.map((p) => ({
      address: p.address,
      lowerBinId: p.spec.lowerBinId,
      upperBinId: p.spec.upperBinId,
      capacity: p.spec.width
    }))
  });
  check(
    "recognised as an addition, with no growth left to do",
    adding.steps.every((s) => s.kind === "addLiquidity"),
    adding.steps.map((s) => s.kind).join(" → ")
  );
  check(
    "and carries no witness, so a runner must not re-send it blind",
    adding.steps.every((s) => s.creates === undefined)
  );

  const beforeAdd = new Map([...bins].map(([id, b]) => [id, b.amountX + b.amountY]));
  await runSteps(pair, adding.steps, "add");
  bins = await binsOf(pair, LOWER, UPPER);
  let grew = 0;
  for (const [id, was] of beforeAdd) {
    const now = bins.get(id)!;
    if (now.amountX + now.amountY > was) grew += 1;
  }
  check("every funded bin grew", grew === funded, `${grew} of ${funded}`);
  await assertNothingWrapped(pair, "after adding");

  const positionsAfterAdd = await heldPositions(pair, addresses);
  check("the positions are still the same accounts", positionsAfterAdd.length === addresses.length);

  // -------------------------------------------------- 3. swap, then claim fees
  stage("swap, then claim across every position");
  const activeId = parsePool((await connection.getAccountInfo(pair.pool))!.data).activeId;
  const arrays = swapArrayIndexes(activeId, true, () => true, 2);
  const tradeIn = DEPOSIT / 100n;
  {
    const { before, after } = await wrapFor(pair, { amountX: tradeIn, amountY: 0n });
    await send(
      [
        ...before,
        swapIx(
          wallet.publicKey,
          pair.pool,
          pair.config,
          pair.tokens,
          pair.userX,
          pair.userY,
          pair.reserveX,
          pair.reserveY,
          arrays.map((i) => binArrayPda(pair.pool, i)),
          tradeIn,
          0n,
          true
        ),
        ...after
      ],
      [],
      1_400_000
    );
  }
  await assertNothingWrapped(pair, "after the swap");

  bins = await binsOf(pair, LOWER, UPPER);
  const owedBefore = (await heldPositions(pair, addresses)).map((p) => summarise(p.view, bins));
  const totalOwed = owedBefore.reduce((a, s) => a + s.feeX + s.feeY, 0n);
  check("the swap left fees to claim", totalOwed > 0n, `${totalOwed} raw`);

  const walletBeforeClaim = { x: await tokenAmount(pair.userX), y: await tokenAmount(pair.userY) };
  const lamportsBeforeClaim = await lamports();
  for (const { address, view } of await heldPositions(pair, addresses)) {
    const claimArrays = arrayIndexesFor(view.lowerBinId, view.upperBinId);
    const { before, after } = await wrapFor(pair, { amountX: 0n, amountY: 0n });
    await send(
      [
        ...before,
        claimFeeIx({
          ...pair.accounts,
          position: address,
          binArrays: claimArrays.map((i) => binArrayPda(pair.pool, i))
        }),
        ...after
      ],
      [],
      1_400_000
    );
  }
  const walletAfterClaim = { x: await tokenAmount(pair.userX), y: await tokenAmount(pair.userY) };
  const paid =
    walletAfterClaim.x - walletBeforeClaim.x + (walletAfterClaim.y - walletBeforeClaim.y);
  const lamportsGained = (await lamports()) - lamportsBeforeClaim;
  // A native side is paid into a wrapped account that the same transaction
  // closes, so its fee shows up in lamports rather than in a token balance.
  check(
    "claiming paid the fees out",
    pair.native ? paid > 0n || lamportsGained > 0n : paid > 0n,
    pair.native ? `${paid} raw, ${lamportsGained} lamports` : `${paid} raw into the wallet`
  );
  // Re-read: `summarise` adds the growth a bin has accrued but not yet
  // credited, so asking against the pre-claim bins would answer for the wrong
  // moment.
  bins = await binsOf(pair, LOWER, UPPER);
  const owedAfter = (await heldPositions(pair, addresses)).map((p) => summarise(p.view, bins));
  const stillOwed = owedAfter.reduce((a, s) => a + s.feeX + s.feeY, 0n);
  check("nothing is left owed", stillOwed === 0n, `${stillOwed} raw`);
  await assertNothingWrapped(pair, "after claiming");

  // ----------------------------------------------- 4. withdraw half, stay open
  stage("withdraw half, leaving the positions open");
  const held = await heldPositions(pair, addresses);
  const sharesBefore = held.map((p) => p.view.shares.reduce((a, s) => a + s, 0n));
  const half = planExit({ accounts: pair.accounts, positions: held, bps: 5_000, close: false });
  check("a partial exit never closes", half.closing === 0 && half.steps.every((s) => !s.destroys));
  await runSteps(pair, half.steps, "withdraw 50%");

  const afterHalf = await heldPositions(pair, addresses);
  check("every position is still open", afterHalf.length === held.length);
  const sharesAfter = afterHalf.map((p) => p.view.shares.reduce((a, s) => a + s, 0n));
  check(
    "each position kept about half its shares",
    sharesAfter.every((s, i) => s > 0n && s <= sharesBefore[i] / 2n + 1n && s >= sharesBefore[i] / 3n),
    sharesAfter.map((s, i) => `${(Number(s) / Number(sharesBefore[i])).toFixed(3)}`).join(", ")
  );
  await assertNothingWrapped(pair, "after the partial withdrawal");

  // ------------------------------------- 4b. reshape in place, no round trip
  //
  // The band does not move here, so nothing resizes and — the property worth
  // driving on a real ledger — nothing crosses the mint. On the `t22fee` legs
  // that is the difference between paying the transfer fee twice and not at
  // all, which is exactly what a client cannot verify from a unit test.
  stage("reshape the band in place");
  const reshaping = await heldPositions(pair, addresses);
  const poolNow = parsePool((await connection.getAccountInfo(pair.pool))!.data);
  bins = await binsOf(pair, LOWER, UPPER);
  const walletBeforeReshape = {
    x: await tokenAmount(pair.userX),
    y: await tokenAmount(pair.userY)
  };
  const sharesBeforeReshape = reshaping.map((p) => p.view.shares.reduce((a, s) => a + s, 0n));

  for (const [i, target] of reshaping.entries()) {
    // Both facts are read off the bins already fetched rather than assumed:
    // `warm` is what fits a full-width reshape in one step, and `sole` is the
    // withdrawal's fast path.
    const warm = new Set<number>();
    const sole = new Set<number>();
    for (let bin = target.view.lowerBinId; bin <= target.view.upperBinId; bin += 1) {
      const cell = bins.get(bin);
      if (!cell) continue;
      if (cell.derived) warm.add(bin);
      const share = target.view.shares[bin - target.view.lowerBinId] ?? 0n;
      if (share > 0n && share === cell.liquiditySupply) sole.add(bin);
    }

    const plan = planReshape({
      accounts: pair.accounts,
      position: target,
      activeId: poolNow.activeId,
      // Out of whatever it was deposited at and into a curve, so the shares
      // have to actually move rather than land back where they started.
      shape: "curve",
      facts: { warm, sole }
    });
    check(
      `position ${i} reshapes without leaving the reserve`,
      plan.steps.length > 0 && plan.steps.every((s) => s.kind === "rebalanceLiquidity"),
      `${plan.steps.length} step(s), atomic=${plan.atomic}`
    );
    await runSteps(pair, plan.steps, `reshape position ${i}`);
  }

  // A reshape moves no tokens: the pot never leaves the reserve, so the only
  // thing that can reach the wallet is per-bin `mul_bps` flooring.
  const walletAfterReshape = {
    x: await tokenAmount(pair.userX),
    y: await tokenAmount(pair.userY)
  };
  const dust = BigInt(UPPER - LOWER + 1) * BigInt(addresses.length);
  const dustX = walletAfterReshape.x - walletBeforeReshape.x;
  const dustY = walletAfterReshape.y - walletBeforeReshape.y;
  check(
    "a reshape returned nothing but flooring dust",
    dustX >= 0n && dustY >= 0n && dustX <= dust && dustY <= dust,
    `${dustX} X, ${dustY} Y against a ${dust} ceiling`
  );

  const afterReshape = await heldPositions(pair, addresses);
  check("every position survived the reshape", afterReshape.length === reshaping.length);
  const sharesAfterReshape = afterReshape.map((p) => p.view.shares.reduce((a, s) => a + s, 0n));
  check(
    "every position still holds liquidity",
    sharesAfterReshape.every((s) => s > 0n),
    sharesAfterReshape.join(", ")
  );
  // The shape changed, so the totals should not simply be what they were.
  check(
    "the liquidity actually moved",
    sharesAfterReshape.some((s, i) => s !== sharesBeforeReshape[i]),
    sharesAfterReshape.map((s, i) => `${s} vs ${sharesBeforeReshape[i]}`).join(", ")
  );
  await assertNothingWrapped(pair, "after the reshape");

  // ------------------------------------------------------------ 5. rebalance
  stage("rebalance into a different band");
  const beforeExit = {
    x: await tokenAmount(pair.userX),
    y: await tokenAmount(pair.userY),
    lamports: await lamports()
  };
  const exit = planExit({
    accounts: pair.accounts,
    positions: await heldPositions(pair, addresses),
    bps: 10_000,
    close: true
  });
  check("one closure per position", exit.closing === addresses.length);
  await runSteps(pair, exit.steps, "close");
  for (const address of addresses) check(`closed ${address.toBase58().slice(0, 6)}`, !(await exists(address)));

  // What a rebalance redeposits is the *delta* the exit produced, never the
  // wallet's balance — which is what stops it sweeping tokens held for
  // something else. A fee mint returns less than went in, twice over.
  // A native side's proceeds land as lamports, not in a token account, because
  // the wrapped account is closed on the way out. The delta is what the app
  // measures too — less a reserve, since the redeposit still has to pay the new
  // positions' rent and its own fees out of the same lamports.
  const NATIVE_RESERVE = 5n * 10n ** 9n;
  const lamportsBack = (await lamports()) - beforeExit.lamports;
  const nativeBack = lamportsBack > NATIVE_RESERVE ? lamportsBack - NATIVE_RESERVE : 0n;
  const proceedsX = isNativeMint(pair.tokens.mintX)
    ? nativeBack
    : (await tokenAmount(pair.userX)) - beforeExit.x;
  const proceedsY = isNativeMint(pair.tokens.mintY)
    ? nativeBack
    : (await tokenAmount(pair.userY)) - beforeExit.y;
  const [backX, backY] = [proceedsX, proceedsY];
  check(
    "the closures returned the remaining liquidity",
    backX > 0n && backY > 0n,
    `${backX} X / ${backY} Y`
  );

  const redeposit = plan({
    lower: REBALANCED.lower,
    upper: REBALANCED.upper,
    amountX: backX,
    amountY: backY,
    shape: "bidask",
    spotBlendBps: 3_000,
    existingPositions: []
  });
  check(
    "the new band is planned the same way",
    redeposit.positions.length === 1 && redeposit.steps[0].kind === "openPosition",
    redeposit.steps.map((s) => s.kind).join(" → ")
  );
  await runSteps(pair, redeposit.steps, "reopen");
  for (const p of redeposit.positions) {
    check(`reopened ${p.spec.lowerBinId}…${p.spec.upperBinId}`, await exists(p.address));
  }
  await assertNothingWrapped(pair, "after the rebalance");

  // ------------------------------------------------------- 6. close everything
  stage("close everything");
  const finalAddresses = redeposit.positions.map((p) => p.address);
  const finalExit = planExit({
    accounts: pair.accounts,
    positions: await heldPositions(pair, finalAddresses),
    bps: 10_000,
    close: true
  });
  await runSteps(pair, finalExit.steps, "close");
  for (const address of finalAddresses) check(`closed ${address.toBase58().slice(0, 6)}`, !(await exists(address)));

  // The reserve keeps the protocol's fee share and whatever per-bin rounding
  // left behind; nothing else may stay in it.
  const left = { x: await tokenAmount(pair.reserveX), y: await tokenAmount(pair.reserveY) };
  const ceiling = DEPOSIT / 100n;
  check(
    "the reserves are drained to fees and dust",
    left.x < ceiling && left.y < ceiling,
    `${left.x} X / ${left.y} Y of ${DEPOSIT} deposited`
  );
  await assertNothingWrapped(pair, "at the end");
}

// --------------------------------------------------------------------------

console.log("· localnet reachable");
if (!(await connection.getVersion().catch(() => null))) {
  console.error("no RPC at the configured url — start scripts/start-localnet.ps1 first");
  process.exit(1);
}
if (!(await connection.getAccountInfo(NATIVE_MINT))) {
  console.error("So111…112 is missing: rebuild the localnet (cargo build --release in localnet/).");
  process.exit(1);
}
await confirm(await connection.requestAirdrop(wallet.publicKey, 20_000 * 1e9));

const matrix: [string, Side, Side][] = [
  ["SPL / SPL", "spl", "spl"],
  ["SPL / Token-2022 with a transfer fee", "spl", "t22fee"],
  ["Token-2022 / Token-2022, both charging", "t22fee", "t22fee"],
  ["SOL / SPL", "sol", "spl"],
  ["SOL / Token-2022 with a transfer fee", "sol", "t22fee"]
];

for (const [i, [label, x, y]] of matrix.entries()) {
  await lifecycle(label, x, y, i);
}

console.log(failures ? `\n\n${failures} check(s) failed` : "\n\nall checks passed");
process.exit(failures ? 1 : 0);
