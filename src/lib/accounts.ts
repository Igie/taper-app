/**
 * Reading the wallet's token accounts.
 *
 * The addresses, the balance parser and the create instructions all live in
 * `@taper/sdk`, because they are pure functions of the ABI and every client
 * needs them. What is left here is the half that needs a `Connection`, which
 * the SDK deliberately does not have: fetching. See `token.ts` and `native.ts`
 * there for everything else.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { ataFor, amountOf, type TokenAccountState } from "@taper/sdk";

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
 * The same, plus the wallet's own lamports.
 *
 * The SOL side of a pair spends from both — a wrapped balance already sitting
 * in the ATA, and whatever can be wrapped in the same transaction — so a panel
 * that shows a spendable figure needs the two together. See the SDK's
 * `spendable`.
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
