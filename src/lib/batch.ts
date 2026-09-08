/**
 * Running a plan: several transactions, signed one at a time.
 *
 * A wide band is several positions and so several signatures, and the failure
 * that matters is the one in the middle — three of five transactions landed,
 * the fourth was rejected, and the user is holding an unfinished position set
 * they did not ask for. Everything here is about making that state legible and
 * recoverable rather than final.
 *
 * The rules it runs by:
 *
 * **Chain state decides what still needs doing, not memory.** Before each step
 * the runner re-reads which bin arrays exist and where the active bin is. A
 * step whose `creates` account is already there is skipped as done, and one
 * whose `destroys` account is already gone likewise — so a retry after a
 * timeout that actually landed does not send the transaction twice.
 *
 * **A step with no witness is never re-sent blind.** Adding to a position that
 * already existed leaves no trace distinguishable from the liquidity that was
 * there before, so if its outcome is unknown the runner stops and says so
 * instead of guessing. Losing a deposit is worse than asking. The exception is
 * a step marked `idempotent` — `resize_position` asks a position to *span* a
 * band rather than to grow by so many bins, so re-sending it cannot do
 * anything twice and an ambiguous timeout is simply retried.
 *
 * Three witnesses, then: `creates` for an account that must appear, `destroys`
 * for one that must vanish, and `grows` for one that must reach a length. A
 * *fill* has none of them, which is why a plan lives in memory for the length
 * of its run and is never replayed from cold: the completed set below is the
 * only thing that knows a chunk already landed.
 *
 * **The active bin is checked before sending, not after.** A bin above the
 * active one may only hold X and one below it only Y, so a deposit planned at
 * one price becomes illegal the moment the pool trades past it. Catching that
 * here costs a read; catching it in the runtime costs a signature and a
 * confusing error.
 *
 * The plan itself is fixed at build time and never re-split mid-run — see the
 * note in `taper-amm-sdk`'s `plan` module for why re-planning would over-deposit.
 */
import { useCallback, useRef, useState } from "react";
import { PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { CU_HEADROOM_NATIVE, stepIsLegal, type Step } from "taper-amm-sdk";
import { send, TxFailure } from "./tx";

export type StepState = "pending" | "running" | "done" | "skipped" | "failed" | "unknown";

export type StepStatus = {
  id: string;
  label: string;
  state: StepState;
  signature?: string;
  detail?: string;
};

/** What the runner needs from the outside world, so it owns no RPC of its own. */
export type BatchContext = {
  /** Re-read the pool's live state. Called once before every step. */
  refresh: () => Promise<{ existingArrays: Set<number>; activeId: number }>;
  /** Whether an account is currently on chain. */
  exists: (address: PublicKey) => Promise<boolean>;
  /**
   * How long an account's data is, or 0 if it is not there.
   *
   * The witness for a growth step: a position's length is its capacity, so a
   * long-enough account proves the extension landed.
   */
  lengthOf: (address: PublicKey) => Promise<number>;
  /**
   * Instructions to wrap around a step — the SOL side of a pair is wrapped and
   * unwrapped per transaction, so each step gets its own, sized to what that
   * step spends.
   */
  decorate?: (
    step: Step
  ) => Promise<{ before: TransactionInstruction[]; after: TransactionInstruction[] }>;
  priorityFee?: number;
};

export type BatchResult = {
  completed: number;
  skipped: number;
  /** The step that stopped the run, if one did. */
  failed?: StepStatus;
};

const initial = (steps: Step[]): StepStatus[] =>
  steps.map((s) => ({ id: s.id, label: s.label, state: "pending" as const }));

export function useBatch() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const [statuses, setStatuses] = useState<StepStatus[]>([]);
  const [running, setRunning] = useState(false);
  // Survives a re-render so a retry resumes rather than restarting.
  const done = useRef(new Set<string>());

  const update = useCallback((id: string, patch: Partial<StepStatus>) => {
    setStatuses((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  }, []);

  const reset = useCallback(() => {
    done.current = new Set();
    setStatuses([]);
  }, []);

  /**
   * Runs every step not already recorded as done, in order, stopping at the
   * first failure. Call again with the same plan to resume.
   */
  const run = useCallback(
    async (steps: Step[], ctx: BatchContext): Promise<BatchResult> => {
      setStatuses((prev) => {
        const known = new Map(prev.map((s) => [s.id, s]));
        return initial(steps).map((s) => (done.current.has(s.id) ? known.get(s.id) ?? s : s));
      });
      setRunning(true);

      let completed = 0;
      let skipped = 0;
      try {
        for (const step of steps) {
          if (done.current.has(step.id)) {
            completed += 1;
            continue;
          }

          const { existingArrays, activeId } = await ctx.refresh();

          // Already run? The account a step creates, or the one it closes, is
          // the only honest answer — and the only one a timeout cannot muddle.
          if (step.creates && (await ctx.exists(step.creates))) {
            done.current.add(step.id);
            update(step.id, { state: "skipped", detail: "already open" });
            skipped += 1;
            continue;
          }
          if (step.destroys && !(await ctx.exists(step.destroys))) {
            done.current.add(step.id);
            update(step.id, { state: "skipped", detail: "already closed" });
            skipped += 1;
            continue;
          }
          if (step.grows && (await ctx.lengthOf(step.grows.account)) >= step.grows.toLength) {
            done.current.add(step.id);
            update(step.id, { state: "skipped", detail: "already this wide" });
            skipped += 1;
            continue;
          }

          if (!stepIsLegal(step, activeId)) {
            const status: StepStatus = {
              id: step.id,
              label: step.label,
              state: "failed",
              detail:
                `The active bin moved to ${activeId}, which puts this deposit on ` +
                `the wrong side of it. Nothing was sent — re-plan against the new price.`
            };
            update(step.id, status);
            return { completed, skipped, failed: status };
          }

          update(step.id, { state: "running" });
          // Read fresh: the wrapped-SOL account is closed at the end of every
          // transaction, so what a later step has to wrap is not what the
          // balances said before the run began.
          const { before = [], after = [] } = (await ctx.decorate?.(step)) ?? {};
          try {
            const signature = await send(
              connection,
              wallet,
              [...before, ...step.build(existingArrays), ...after],
              {
                // The step's own estimate plus room for what we wrapped around
                // it. A compute limit covers the whole transaction, so a
                // decorated step that budgeted only its own instructions would
                // spend most of a growth step's estimate on an ATA create.
                computeUnits:
                  step.computeUnits + (before.length || after.length ? CU_HEADROOM_NATIVE : 0),
                priorityFee: ctx.priorityFee,
                // An opening step carries the new position's own key: a
                // position is a keypair account, so it signs itself into
                // existence alongside the wallet.
                signers: step.signers ?? []
              }
            );
            done.current.add(step.id);
            update(step.id, { state: "done", signature });
            completed += 1;
          } catch (error) {
            const failure = error as TxFailure;
            // A submitted transaction whose confirmation never arrived is the
            // one case that is not simply a failure: it may have landed. Where
            // the step has a witness, look; where it does not, stop and say so
            // rather than risk sending a deposit twice.
            const submitted = Boolean(failure.signature);
            let state: StepState = "failed";
            let detail = failure.message;

            if (submitted && step.creates && (await ctx.exists(step.creates))) {
              done.current.add(step.id);
              update(step.id, {
                state: "done",
                signature: failure.signature,
                detail: "confirmation timed out, but it landed"
              });
              completed += 1;
              continue;
            }
            if (submitted && step.idempotent) {
              // Re-sending cannot do the work twice — `resize_position` takes
              // an absolute band — so an ambiguous timeout is just a retry,
              // not a question for the user.
              detail = `${failure.message} — this step is safe to retry.`;
            } else if (submitted && !step.creates && !step.destroys) {
              state = "unknown";
              detail =
                `${failure.message} — this step adds to a position that already ` +
                `existed, so whether it landed cannot be told from chain state. ` +
                `Check the signature before retrying.`;
            }

            const status: StepStatus = {
              id: step.id,
              label: step.label,
              state,
              signature: failure.signature,
              detail
            };
            update(step.id, status);
            return { completed, skipped, failed: status };
          }
        }
        return { completed, skipped };
      } finally {
        setRunning(false);
      }
    },
    [connection, update, wallet]
  );

  return { statuses, running, run, reset, completed: done.current };
}
