/**
 * The trader's own token accounts.
 *
 * Associated token accounts are derived, not looked up, so the address is
 * always known — what is not known is whether it exists. A swap or a deposit
 * that pays out into a missing account fails, so the create instruction is
 * folded into the same transaction whenever the account is not there yet.
 */
import { Connection, PublicKey, TransactionInstruction } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync
} from "@solana/spl-token";

export const ataFor = (mint: PublicKey, owner: PublicKey, program: PublicKey) =>
  getAssociatedTokenAddressSync(mint, owner, true, program, ASSOCIATED_TOKEN_PROGRAM_ID);

export type TokenAccountState = { address: PublicKey; exists: boolean; amount: bigint };

/** A token account's `amount` is a u64 at offset 64 in both token programs. */
export const amountOf = (data: Uint8Array) =>
  data.length >= 72 ? new DataView(data.buffer, data.byteOffset + 64, 8).getBigUint64(0, true) : 0n;

export async function loadTokenAccounts(
  connection: Connection,
  entries: { mint: PublicKey; program: PublicKey }[],
  owner: PublicKey
): Promise<TokenAccountState[]> {
  const addresses = entries.map((e) => ataFor(e.mint, owner, e.program));
  const accounts = await connection.getMultipleAccountsInfo(addresses);
  return addresses.map((address, i) => {
    const account = accounts[i];
    return { address, exists: Boolean(account), amount: account ? amountOf(account.data) : 0n };
  });
}

/**
 * A state for an account whose existence has not been read.
 *
 * Assuming it is missing is the safe half of the guess: the create that
 * follows is idempotent, so being wrong costs a few compute units, while the
 * other way round costs a failed transaction.
 */
export const assumeMissing = (
  mint: PublicKey,
  owner: PublicKey,
  program: PublicKey
): TokenAccountState => ({ address: ataFor(mint, owner, program), exists: false, amount: 0n });

/**
 * The same, plus the wallet's own lamports.
 *
 * The SOL side of a pair spends from both — a wrapped balance already sitting
 * in the ATA, and whatever can be wrapped in the same transaction — so a panel
 * that shows a spendable figure needs the two together. See `native.ts`.
 */
export async function loadBalances(
  connection: Connection,
  entries: { mint: PublicKey; program: PublicKey }[],
  owner: PublicKey
): Promise<{ states: TokenAccountState[]; lamports: bigint }> {
  const [states, lamports] = await Promise.all([
    loadTokenAccounts(connection, entries, owner),
    connection.getBalance(owner)
  ]);
  return { states, lamports: BigInt(lamports) };
}

/**
 * Instructions to create any of these accounts that are missing.
 *
 * Idempotent, so a race with another transaction that created the same account
 * first is not a failure.
 */
export function ensureAccounts(
  payer: PublicKey,
  owner: PublicKey,
  entries: { mint: PublicKey; program: PublicKey; state: TokenAccountState }[]
): TransactionInstruction[] {
  return entries
    .filter((e) => !e.state.exists)
    .map((e) =>
      createAssociatedTokenAccountIdempotentInstruction(
        payer,
        e.state.address,
        owner,
        e.mint,
        e.program,
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );
}
