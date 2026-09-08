/**
 * The SOL lifecycle, against a running localnet.
 *
 * `ui/scripts/e2e.ts` drives the console's client code; this drives the app's,
 * and only the part of it that has no equivalent there: SOL is not a token, so
 * every pair that contains it goes through the SDK's `native.ts` — wrapped
 * before the program sees it, unwrapped after. Nothing about that is visible
 * on chain, which is exactly why it needs a test: a missing `sync_native` or a
 * close in the wrong place fails as "insufficient funds" three instructions
 * later, or silently leaves a user holding wSOL.
 *
 *   ./scripts/start-localnet.ps1
 *   bun run --cwd app sol:e2e
 *
 * Point it at another cluster with `-- --url <rpc>`; it airdrops, so devnet
 * works and mainnet does not.
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
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createInitializeMintInstruction,
  createMintToInstruction,
  createSyncNativeInstruction
} from "@solana/spl-token";
import {
  ACCOUNT_LEN,
  addLiquidityIx,
  amountOf,
  arrayIndexesFor,
  ataFor,
  binArrayPda,
  claimFeeIx,
  closePositionIx,
  configPda,
  distribute,
  initializeBinArrayIx,
  initializeConfigIx,
  initializePoolIx,
  openPositionIxs,
  orderMints,
  parsePool,
  parsePosition,
  poolPda,
  prepareTokens,
  reductionsFor,
  removeLiquidityIx,
  reservePda,
  SOL_RESERVE,
  spendable,
  swapArrayIndexes,
  swapIx,
  type TokenPair
} from "taper-amm-sdk";
import { presetParams, PRESETS } from "../src/lib/preset-defs";
import { loadBalances } from "../src/lib/accounts";
import { listWalletTokens } from "../src/lib/data";

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
const sol = (lamports: bigint | number) => `${(Number(lamports) / 1e9).toFixed(6)} SOL`;

/** Polled, never subscribed: the localnet has no WebSocket. */
async function confirm(signature: string) {
  for (let i = 0; i < 120; i += 1) {
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
    await new Promise((resolve) => setTimeout(resolve, 150));
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

const lamportsOf = async (key: PublicKey) => BigInt(await connection.getBalance(key));
const tokenAmount = async (key: PublicKey) => {
  const account = await connection.getAccountInfo(key);
  return account ? amountOf(account.data) : undefined;
};

// --------------------------------------------------------------------------

step("localnet reachable");
const version = await connection.getVersion().catch(() => null);
if (!version) {
  console.error("no RPC at the configured url — start scripts/start-localnet.ps1 first");
  process.exit(1);
}
const nativeMintAccount = await connection.getAccountInfo(NATIVE_MINT);
check("the native mint exists on this cluster", Boolean(nativeMintAccount));
if (!nativeMintAccount) {
  console.error("\nSo111…112 is missing: rebuild the localnet (cargo build --release in localnet/).");
  process.exit(1);
}

await confirm(await connection.requestAirdrop(wallet.publicKey, 200 * 1e9));
console.log(`wallet ${wallet.publicKey.toBase58()}  ${sol(await lamportsOf(wallet.publicKey))}`);

// --------------------------------------------------------------------------

step("a mint to pair SOL with");
// Nine decimals so a bin's price is the same number in whole tokens as it is
// in lamports, which keeps the amounts below readable.
const mint = Keypair.generate();
const mintAta = ataFor(mint.publicKey, wallet.publicKey, TOKEN_PROGRAM_ID);
await send([
  SystemProgram.createAccount({
    fromPubkey: wallet.publicKey,
    newAccountPubkey: mint.publicKey,
    lamports: await connection.getMinimumBalanceForRentExemption(MINT_SIZE),
    space: MINT_SIZE,
    programId: TOKEN_PROGRAM_ID
  }),
  createInitializeMintInstruction(mint.publicKey, 9, wallet.publicKey, null, TOKEN_PROGRAM_ID),
  createAssociatedTokenAccountInstruction(
    wallet.publicKey,
    mintAta,
    wallet.publicKey,
    mint.publicKey,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  ),
  createMintToInstruction(mint.publicKey, mintAta, wallet.publicKey, 1_000n * 10n ** 9n, [], TOKEN_PROGRAM_ID)
], [mint]);

const [mintX, mintY] = orderMints(NATIVE_MINT, mint.publicKey);
const solIsX = mintX.equals(NATIVE_MINT);
const tokens: TokenPair = {
  mintX,
  programX: TOKEN_PROGRAM_ID,
  mintY,
  programY: TOKEN_PROGRAM_ID
};
console.log(`  SOL is the ${solIsX ? "X" : "Y"} side`);

// --------------------------------------------------------------------------

step("the picker sees SOL and the token");
const held = await listWalletTokens(connection, wallet.publicKey);
const solRow = held.find((t) => t.address.equals(NATIVE_MINT));
check("SOL is listed", Boolean(solRow), solRow ? `${solRow.symbol}, ${sol(solRow.balance)}` : "missing");
check("SOL is first", held[0]?.address.equals(NATIVE_MINT) === true);
check(
  "SOL's balance is the wallet's lamports",
  solRow !== undefined && solRow.balance === (await lamportsOf(wallet.publicKey)),
  solRow ? sol(solRow.balance) : ""
);
check("SOL is not rejected by the mint screen", solRow?.rejected.length === 0);
check(
  "the minted token is listed",
  held.some((t) => t.address.equals(mint.publicKey) && t.balance === 1_000n * 10n ** 9n)
);

// --------------------------------------------------------------------------

step("a pool against the uniform preset");
const preset = PRESETS[0];
const config = configPda(wallet.publicKey, preset.index);
if (!(await connection.getAccountInfo(config))) {
  await send([initializeConfigIx(wallet.publicKey, presetParams(preset))], [], 200_000);
}
const pool = poolPda(config, mintX, mintY);
await send([initializePoolIx(wallet.publicKey, config, tokens, 0)], [], 300_000);
check("pool created", Boolean(await connection.getAccountInfo(pool)));

const reserveSol = reservePda(pool, NATIVE_MINT);
const wsol = ataFor(NATIVE_MINT, wallet.publicKey, TOKEN_PROGRAM_ID);

// --------------------------------------------------------------------------

step("deposit, wrapping SOL on the way in");
const lower = -5;
const upper = 5;
const width = upper - lower + 1;
const depositSol = 500_000_000n; // 0.5
const depositToken = 500_000_000n;
const rawX = solIsX ? depositSol : depositToken;
const rawY = solIsX ? depositToken : depositSol;
// A position is a keypair account, so the script generates one rather than
// deriving an address it could look up.
const positionKey = Keypair.generate();
const position = positionKey.publicKey;
const arrays = arrayIndexesFor(lower, upper);

const before = await loadBalances(
  connection,
  [
    { mint: mintX, program: TOKEN_PROGRAM_ID },
    { mint: mintY, program: TOKEN_PROGRAM_ID }
  ],
  wallet.publicKey
);
check("no wrapped SOL account yet", !before.states[solIsX ? 0 : 1].exists);
check(
  "the SOL side can spend the wallet's lamports",
  spendable(NATIVE_MINT, before.states[solIsX ? 0 : 1], before.lamports) === before.lamports
);
check(
  "the max button holds a reserve back",
  spendable(NATIVE_MINT, before.states[solIsX ? 0 : 1], before.lamports, SOL_RESERVE) ===
    before.lamports - SOL_RESERVE
);

const wrap = prepareTokens(wallet.publicKey, [
  { mint: mintX, program: TOKEN_PROGRAM_ID, state: before.states[0], needed: rawX },
  { mint: mintY, program: TOKEN_PROGRAM_ID, state: before.states[1], needed: rawY }
]);
check("the wrap closes the account it opened", wrap.after.length === 1);

const lamportsBeforeDeposit = await lamportsOf(wallet.publicKey);
await send([
  ...wrap.before,
  ...arrays.map((index) => initializeBinArrayIx(wallet.publicKey, pool, config, index)),
  ...openPositionIxs(wallet.publicKey, pool, config, position, lower, width),
  addLiquidityIx(
    {
      owner: wallet.publicKey,
      position,
      pool,
      config,
      tokens,
      userTokenX: before.states[0].address,
      userTokenY: before.states[1].address,
      reserveX: reservePda(pool, mintX),
      reserveY: reservePda(pool, mintY),
      binArrays: arrays.map((index) => binArrayPda(pool, index))
    },
    rawX,
    rawY,
    distribute(lower, upper, 0, "spot")
  ),
  ...wrap.after
], [positionKey]);

const reserveAfterDeposit = (await tokenAmount(reserveSol)) ?? 0n;
check("the pool's SOL reserve was funded", reserveAfterDeposit > 0n, sol(reserveAfterDeposit));
check("the wrapped account was closed again", (await connection.getAccountInfo(wsol)) === null);

const rent =
  BigInt(arrays.length) * BigInt(await connection.getMinimumBalanceForRentExemption(ACCOUNT_LEN.binArray)) +
  BigInt(await connection.getMinimumBalanceForRentExemption(ACCOUNT_LEN.position));
const spent = lamportsBeforeDeposit - (await lamportsOf(wallet.publicKey));
// Everything else that left is rent, the signature, and the deposit itself.
check(
  "lamports left the wallet as SOL, not as wSOL",
  spent >= reserveAfterDeposit + rent && spent <= reserveAfterDeposit + rent + 100_000n,
  `${sol(spent)} for ${sol(reserveAfterDeposit)} deposited + ${sol(rent)} rent`
);

// --------------------------------------------------------------------------

step("a wSOL balance the wallet already holds is spent first");
const preWrapped = 200_000_000n; // 0.2, left sitting in the account
await send([
  createAssociatedTokenAccountInstruction(
    wallet.publicKey,
    wsol,
    wallet.publicKey,
    NATIVE_MINT,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  ),
  SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: wsol, lamports: preWrapped }),
  createSyncNativeInstruction(wsol, TOKEN_PROGRAM_ID)
]);
check("wrapped SOL is sitting in the wallet", (await tokenAmount(wsol)) === preWrapped);

const swapAmount = 300_000_000n; // 0.3 in, so 0.1 has to be wrapped
const swapForY = solIsX;
const states = await loadBalances(
  connection,
  [
    { mint: mintX, program: TOKEN_PROGRAM_ID },
    { mint: mintY, program: TOKEN_PROGRAM_ID }
  ],
  wallet.publicKey
);
const prep = prepareTokens(wallet.publicKey, [
  { mint: mintX, program: TOKEN_PROGRAM_ID, state: states.states[0], needed: swapForY ? swapAmount : 0n },
  { mint: mintY, program: TOKEN_PROGRAM_ID, state: states.states[1], needed: swapForY ? 0n : swapAmount }
]);
const transfers = prep.before.filter((i) => i.programId.equals(SystemProgram.programId));
check("only the shortfall is wrapped", transfers.length === 1);

const existing = new Set(
  (await connection.getMultipleAccountsInfo(arrays.map((i) => binArrayPda(pool, i))))
    .map((account, i) => (account ? arrays[i] : undefined))
    .filter((i): i is number => i !== undefined)
);
const swapArrays = swapArrayIndexes(0, swapForY, (i) => existing.has(i));

const tokenBeforeSwap = (await tokenAmount(mintAta)) ?? 0n;
await send([
  ...prep.before,
  swapIx(
    wallet.publicKey,
    pool,
    config,
    tokens,
    swapForY ? states.states[0].address : states.states[1].address,
    swapForY ? states.states[1].address : states.states[0].address,
    reservePda(pool, mintX),
    reservePda(pool, mintY),
    swapArrays.map((index) => binArrayPda(pool, index)),
    swapAmount,
    // The quote is `ui/scripts/e2e.ts`'s job; this is about the wrapping.
    0n,
    swapForY
  ),
  ...prep.after
]);

check("the wrapped account is closed after the swap", (await connection.getAccountInfo(wsol)) === null);
check(
  "the token side was paid",
  ((await tokenAmount(mintAta)) ?? 0n) > tokenBeforeSwap,
  `+${sol(((await tokenAmount(mintAta)) ?? 0n) - tokenBeforeSwap)}`
);

// --------------------------------------------------------------------------

step("withdraw, unwrapping on the way out");
const view = parsePosition((await connection.getAccountInfo(position))!.data);
const lamportsBeforeExit = await lamportsOf(wallet.publicKey);
const exit = prepareTokens(wallet.publicKey, [
  { mint: mintX, program: TOKEN_PROGRAM_ID, state: states.states[0], needed: 0n },
  { mint: mintY, program: TOKEN_PROGRAM_ID, state: states.states[1], needed: 0n }
]);
check("nothing is wrapped when nothing is spent", exit.before.every((i) => !i.programId.equals(SystemProgram.programId)));

await send([
  ...exit.before,
  removeLiquidityIx(
    {
      owner: wallet.publicKey,
      position,
      pool,
      config,
      tokens,
      userTokenX: states.states[0].address,
      userTokenY: states.states[1].address,
      reserveX: reservePda(pool, mintX),
      reserveY: reservePda(pool, mintY),
      binArrays: arrayIndexesFor(view.lowerBinId, view.upperBinId).map((index) => binArrayPda(pool, index))
    },
    reductionsFor(view, 10_000)
  ),
  // The swap left a fee on the position, and `close_position` refuses to close
  // over one — the app claims in the same transaction for exactly this reason.
  claimFeeIx({
    owner: wallet.publicKey,
    position,
    pool,
    config,
    tokens,
    userTokenX: states.states[0].address,
    userTokenY: states.states[1].address,
    reserveX: reservePda(pool, mintX),
    reserveY: reservePda(pool, mintY),
    binArrays: arrayIndexesFor(view.lowerBinId, view.upperBinId).map((index) => binArrayPda(pool, index))
  }),
  closePositionIx(wallet.publicKey, position),
  ...exit.after
]);

check("the position is gone", (await connection.getAccountInfo(position)) === null);
check("the wrapped account is closed after the withdrawal", (await connection.getAccountInfo(wsol)) === null);
const returned = (await lamportsOf(wallet.publicKey)) - lamportsBeforeExit;
check("the SOL side came back as SOL", returned > 0n, `+${sol(returned)}`);
// Not zero: the protocol's share of every swap fee stays in the reserve until
// its authority withdraws it, and it is the SOL side that was sold into.
const poolView = parsePool((await connection.getAccountInfo(pool))!.data);
const leftInReserve = (await tokenAmount(reserveSol)) ?? 0n;
const protocolFee = solIsX ? poolView.protocolFeeX : poolView.protocolFeeY;
// Withdrawing floors a share into an amount, so a few lamports of dust can
// stay behind with it — the invariant is that the reserve never goes short.
check(
  "only the protocol's fee share and dust are left in the SOL reserve",
  leftInReserve >= protocolFee && leftInReserve - protocolFee <= 100n,
  `${leftInReserve} lamports left, ${protocolFee} owed to the protocol`
);

// --------------------------------------------------------------------------

console.log(`\n${failures === 0 ? "all checks passed" : `${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
