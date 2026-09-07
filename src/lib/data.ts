/**
 * Reading the program's state.
 *
 * Everything here is a `getProgramAccounts` or a `getMultipleAccounts` — there
 * is no indexer behind this app, which is the honest position for a devnet
 * deployment. The cost of that shows up in two places, both handled here:
 * pool enumeration is filtered by `dataSize` so it never scans the whole
 * program, and bin reads are batched a whole array at a time rather than a bin
 * at a time.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import {
  ExtensionType,
  getTokenMetadata,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID
} from "@solana/spl-token";
import {
  ACCOUNT_LEN,
  BINS_PER_ARRAY,
  Ladder,
  PROGRAM_ID,
  arrayIndexesFor,
  binArrayIndex,
  binArrayLower,
  binArrayPda,
  configFilters,
  feeRateForStep,
  parseBin,
  parseConfig,
  parsePool,
  parsePosition,
  poolFilters,
  positionFilters,
  screenMint,
  type BinView,
  type ConfigView,
  type MintInfo,
  type PoolView,
  type PositionView
} from "@taper/sdk";
import { amountOf } from "./accounts";

export type Keyed<T> = { address: PublicKey; view: T };

export type TokenMeta = MintInfo & { symbol: string; name?: string };

// --------------------------------------------------------------- configs

export async function listConfigs(connection: Connection): Promise<Keyed<ConfigView>[]> {
  const accounts = await connection.getProgramAccounts(PROGRAM_ID, {
    filters: configFilters() as never
  });
  return accounts
    .map((a) => ({ address: a.pubkey, view: parseConfig(a.account.data) }))
    .sort((a, b) => a.view.index - b.view.index);
}

// ----------------------------------------------------------------- pools

export async function listPools(connection: Connection, config?: PublicKey): Promise<Keyed<PoolView>[]> {
  const accounts = await connection.getProgramAccounts(PROGRAM_ID, {
    filters: poolFilters(config) as never
  });
  return accounts.map((a) => ({ address: a.pubkey, view: parsePool(a.account.data) }));
}

export async function loadPool(connection: Connection, address: PublicKey): Promise<PoolView> {
  const account = await connection.getAccountInfo(address);
  if (!account) throw new Error(`No pool at ${address.toBase58()}`);
  if (account.data.length !== ACCOUNT_LEN.pool) throw new Error(`${address.toBase58()} is not a pool account`);
  return parsePool(account.data);
}

export async function loadConfig(connection: Connection, address: PublicKey): Promise<ConfigView> {
  const account = await connection.getAccountInfo(address);
  if (!account) throw new Error(`No config at ${address.toBase58()}`);
  return parseConfig(account.data);
}

// ------------------------------------------------------------------ mints

/**
 * Mint data plus a display symbol.
 *
 * There is no token registry on devnet, so a symbol comes from the
 * Token-2022 metadata extension when the mint carries one and from the
 * address otherwise. Showing a truncated address is better than inventing a
 * ticker: two pools can hold different tokens with the same symbol.
 */
export async function loadTokens(connection: Connection, mints: PublicKey[]): Promise<Map<string, TokenMeta>> {
  const unique = [...new Map(mints.map((m) => [m.toBase58(), m])).values()];
  const accounts = await connection.getMultipleAccountsInfo(unique);
  const out = new Map<string, TokenMeta>();

  await Promise.all(
    unique.map(async (mint, i) => {
      const account = accounts[i];
      if (!account) return;
      let info: MintInfo;
      try {
        info = screenMint(mint, account.data, account.owner);
      } catch {
        return;
      }

      let symbol = mint.equals(NATIVE_MINT) ? "SOL" : `${mint.toBase58().slice(0, 4)}…`;
      let name: string | undefined = mint.equals(NATIVE_MINT) ? "Wrapped SOL" : undefined;
      // One request per mint, so it is only worth making when the mint says it
      // carries metadata. A list of twenty pools is otherwise forty requests a
      // public endpoint will start refusing part way through.
      const carriesMetadata = info.extensions.some(
        (e) => e === ExtensionType.TokenMetadata || e === ExtensionType.MetadataPointer
      );
      if (account.owner.equals(TOKEN_2022_PROGRAM_ID) && carriesMetadata) {
        const metadata = await getTokenMetadata(connection, mint, undefined, TOKEN_2022_PROGRAM_ID).catch(
          () => null
        );
        if (metadata?.symbol) symbol = metadata.symbol;
        if (metadata?.name) name = metadata.name;
      }
      out.set(mint.toBase58(), { ...info, symbol, name });
    })
  );

  return out;
}

/** One mint, screened against what `initialize_pool` will accept. */
export async function loadMint(connection: Connection, mint: PublicKey): Promise<MintInfo> {
  const account = await connection.getAccountInfo(mint);
  if (!account) throw new Error(`No account at ${mint.toBase58()}`);
  return screenMint(mint, account.data, account.owner);
}

export type WalletToken = TokenMeta & {
  /** Raw units held. For SOL this is lamports plus any already-wrapped balance. */
  balance: bigint;
  isNative: boolean;
};

/** A mint's own limit on `getMultipleAccountsInfo`, minus the native one. */
const MINT_LOOKUP_LIMIT = 99;

/**
 * What this wallet holds, as things a pool could be opened against.
 *
 * Both token programs are asked separately — `getTokenAccountsByOwner` filters
 * on one program id, and either side of a pair may be Token-2022. SOL is then
 * prepended by hand, because a wallet's lamports are not a token account and
 * would otherwise be invisible in an app where every pair is made of mints.
 * Its balance is the sum of the two forms it can be in: unwrapped lamports,
 * and anything left in the wrapped account.
 *
 * Balances come from the token accounts, but decimals, program and extension
 * screening come from the mints — a picker that offered a token the program
 * will reject would just be a slower way to reach the same error.
 */
export async function listWalletTokens(
  connection: Connection,
  owner: PublicKey
): Promise<WalletToken[]> {
  const [spl, token2022, lamports] = await Promise.all([
    connection.getTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID }),
    connection.getTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM_ID }),
    connection.getBalance(owner)
  ]);

  // Both token programs lay the first 72 bytes out the same way: mint, owner,
  // then the u64 amount. One wallet can hold several accounts for one mint.
  const held = new Map<string, bigint>();
  for (const { account } of [...spl.value, ...token2022.value]) {
    const data = account.data;
    if (data.length < 72) continue;
    const mint = new PublicKey(data.subarray(0, 32)).toBase58();
    held.set(mint, (held.get(mint) ?? 0n) + amountOf(data));
  }

  const ranked = [...held.entries()]
    .filter(([mint]) => mint !== NATIVE_MINT.toBase58())
    .sort((a, b) => (a[1] === b[1] ? 0 : b[1] > a[1] ? 1 : -1))
    .slice(0, MINT_LOOKUP_LIMIT)
    .map(([mint]) => new PublicKey(mint));

  const metas = await loadTokens(connection, [NATIVE_MINT, ...ranked]);

  const sol = metas.get(NATIVE_MINT.toBase58());
  const wrapped = held.get(NATIVE_MINT.toBase58()) ?? 0n;
  const tokens: WalletToken[] = sol
    ? [{ ...sol, balance: BigInt(lamports) + wrapped, isNative: true }]
    : [];

  for (const mint of ranked) {
    const meta = metas.get(mint.toBase58());
    if (meta) tokens.push({ ...meta, balance: held.get(mint.toBase58()) ?? 0n, isNative: false });
  }
  return tokens;
}

// ------------------------------------------------------------------- bins

export type BinCell = BinView & {
  arrayIndex: number;
  arrayExists: boolean;
  arrayOccupied: boolean;
  feeRate: number;
};

/**
 * Every bin in `[lower, upper]`, whether or not its array exists yet.
 *
 * A bin the program has never touched has no stored price, so the ladder fills
 * one in. That is the same `f64` re-derivation the SDK uses to cross-check the
 * chain, which is why a drift between the two is visible rather than silent:
 * an uncreated bin and a created one are drawn on the same axis.
 */
export async function loadBins(
  connection: Connection,
  pool: PublicKey,
  poolView: PoolView,
  config: ConfigView,
  lower: number,
  upper: number
): Promise<BinCell[]> {
  const indexes = arrayIndexesFor(lower, upper);
  const accounts = await connection.getMultipleAccountsInfo(indexes.map((i) => binArrayPda(pool, i)));
  const arrays = new Map(indexes.map((index, i) => [index, accounts[i]?.data]));
  const ladder = new Ladder(config.baseWidthQ64, config.taperQ64);

  const cells: BinCell[] = [];
  for (let binId = lower; binId <= upper; binId += 1) {
    const arrayIndex = binArrayIndex(binId);
    const data = arrays.get(arrayIndex);
    const stored = data ? parseBin(data, arrayIndex, binId) : undefined;

    // Fall back to the client ladder for a bin the program has not derived.
    const stepBpX100 = stored?.derived ? stored.stepBpX100 : ladder.stepBpX100(binId);
    const bin: BinView = stored?.derived
      ? stored
      : {
          binId,
          amountX: stored?.amountX ?? 0n,
          amountY: stored?.amountY ?? 0n,
          priceQ64: 0n,
          price: ladder.price(binId),
          liquiditySupply: stored?.liquiditySupply ?? 0n,
          feeXPerShare: stored?.feeXPerShare ?? 0n,
          feeYPerShare: stored?.feeYPerShare ?? 0n,
          stepBpX100,
          derived: false
        };

    cells.push({
      ...bin,
      arrayIndex,
      arrayExists: Boolean(data),
      arrayOccupied: poolView.occupiedArrays.has(arrayIndex),
      feeRate: feeRateForStep(stepBpX100, config, poolView.volatilityAccumulator)
    });
  }
  return cells;
}

/** The bin arrays a range needs, split into those that exist and those that do not. */
export async function missingArrays(connection: Connection, pool: PublicKey, lower: number, upper: number) {
  const indexes = arrayIndexesFor(lower, upper);
  const accounts = await connection.getMultipleAccountsInfo(indexes.map((i) => binArrayPda(pool, i)));
  return {
    all: indexes,
    missing: indexes.filter((_, i) => !accounts[i]),
    lowerBinOf: (index: number) => binArrayLower(index),
    upperBinOf: (index: number) => binArrayLower(index) + BINS_PER_ARRAY - 1
  };
}

// -------------------------------------------------------------- positions

export async function listPositions(
  connection: Connection,
  owner: PublicKey,
  pool?: PublicKey
): Promise<Keyed<PositionView>[]> {
  const accounts = await connection.getProgramAccounts(PROGRAM_ID, {
    filters: positionFilters(owner, pool) as never
  });
  return accounts
    .map((a) => ({ address: a.pubkey, view: parsePosition(a.account.data) }))
    .sort((a, b) => a.view.lowerBinId - b.view.lowerBinId);
}

export async function loadPosition(connection: Connection, address: PublicKey): Promise<PositionView> {
  const account = await connection.getAccountInfo(address);
  if (!account) throw new Error(`No position at ${address.toBase58()}`);
  return parsePosition(account.data);
}
