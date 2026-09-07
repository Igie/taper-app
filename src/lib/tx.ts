/**
 * Building, sending and confirming transactions.
 *
 * Two things here are not the defaults and are deliberate.
 *
 * **Confirmation is polled, never subscribed.** `confirmTransaction`
 * subscribes over WebSocket, which the LiteSVM localnet does not have, so it
 * would hang forever there. Polling `getSignatureStatuses` works on every
 * cluster and costs one request per second.
 *
 * **The compute limit is always set explicitly.** Deriving a bin price costs
 * roughly 10k CU in this program, so anything touching a wide range blows past
 * the 200k default. Every instruction in the program touches bins.
 */
import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  type Signer
} from "@solana/web3.js";
import type { WalletContextState } from "@solana/wallet-adapter-react";

export class TxFailure extends Error {
  constructor(
    message: string,
    readonly logs: string[] = [],
    readonly signature?: string
  ) {
    super(message);
    this.name = "TxFailure";
  }
}

/**
 * Anchor errors arrive as `{ InstructionError: [i, { Custom: n }] }`, which
 * tells a user nothing. The program's own log line names the guard that
 * rejected them, so prefer it whenever there is one.
 */
export function readableError(error: unknown, logs: string[] = []): string {
  const named = [...logs].reverse().find((line) => line.includes("Error Message:"));
  if (named) return named.replace(/^.*Error Message:\s*/, "").trim();
  const anchor = [...logs].reverse().find((line) => line.includes("AnchorError"));
  if (anchor) return anchor.replace(/^Program log:\s*/, "").trim();
  if (error instanceof Error) {
    // Wallet adapters wrap the RPC failure; the useful part is usually nested.
    const nested = (error as { logs?: string[] }).logs;
    if (nested?.length && nested !== logs) return readableError(error, nested);
    return error.message;
  }
  return String(error);
}

export type SendOptions = {
  computeUnits?: number;
  /** Micro-lamports per CU. Zero on a simulator, where there is no auction. */
  priorityFee?: number;
  signers?: Signer[];
};

/**
 * Signs with the connected wallet, submits, and waits for confirmation.
 *
 * Returns the signature. Throws `TxFailure` with the program logs attached —
 * which is almost always the fastest way to see which guard rejected a call.
 */
export async function send(
  connection: Connection,
  wallet: WalletContextState,
  instructions: TransactionInstruction[],
  { computeUnits = 400_000, priorityFee = 1_000, signers = [] }: SendOptions = {}
): Promise<string> {
  if (!wallet.publicKey || !wallet.sendTransaction) throw new TxFailure("Connect a wallet first.");

  const budget = [ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits })];
  if (priorityFee > 0) {
    budget.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee }));
  }

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({
    feePayer: wallet.publicKey,
    blockhash,
    lastValidBlockHeight
  });
  tx.add(...budget, ...instructions);

  let signature: string;
  try {
    signature = await wallet.sendTransaction(tx, connection, { signers, skipPreflight: false });
  } catch (error) {
    throw new TxFailure(readableError(error), (error as { logs?: string[] }).logs ?? []);
  }

  await confirm(connection, signature);
  return signature;
}

/**
 * Polls until the signature lands or the blockhash it was signed against can
 * no longer be accepted.
 *
 * `getSignatureStatuses` is used rather than `confirmTransaction` so this works
 * against the WebSocket-less localnet; see the module comment.
 */
export async function confirm(connection: Connection, signature: string, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { value } = await connection.getSignatureStatuses([signature]);
    const status = value[0];
    if (status) {
      if (status.err) {
        const tx = await connection
          .getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" })
          .catch(() => null);
        const logs = tx?.meta?.logMessages ?? [];
        throw new TxFailure(readableError(status.err, logs), logs, signature);
      }
      if (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized") return;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new TxFailure(`Transaction ${signature.slice(0, 8)} was not confirmed in time.`, [], signature);
}

/**
 * A priority fee that reflects what the cluster is actually charging.
 *
 * Devnet is usually free, but a deploy or a busy hour is not, and a
 * transaction stuck behind a zero fee looks to a user like a broken app.
 */
export async function suggestPriorityFee(connection: Connection, keys: PublicKey[]): Promise<number> {
  try {
    const recent = await connection.getRecentPrioritizationFees({ lockedWritableAccounts: keys });
    if (!recent.length) return 1_000;
    const fees = recent.map((r) => r.prioritizationFee).sort((a, b) => a - b);
    // The median is a better guide than the max, which is one desperate bot.
    const median = fees[Math.floor(fees.length / 2)];
    return Math.max(1_000, median);
  } catch {
    return 1_000;
  }
}
