/**
 * The positions this wallet holds in this pool.
 *
 * The fee figure shown is not the one stored on the position. The program only
 * moves fee growth into `fee_*_pending` when it *touches* a position — on a
 * deposit, a withdrawal or a claim — so a position that has been earning all
 * along still reads zero until then. `summarise` adds the uncredited growth
 * back, which is why the number here can move without any transaction.
 *
 * Closing needs an empty position, so "remove 100% and close" is offered as
 * one action: two instructions, one signature, and no state in between where a
 * user is left holding an empty position they have to notice and clean up.
 */
import { useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import {
  arrayIndexesFor,
  binArrayPda,
  claimFeeIx,
  closePositionIx,
  hasLiquidity,
  reductionsFor,
  removeLiquidityIx,
  summarise,
  type BinView,
  type LiquidityAccounts,
  type TokenPair
} from "@taper/sdk";
import type { PoolBundle } from "./PoolView";
import type { Toast } from "../lib/providers";
import { assumeMissing, ataFor } from "../lib/accounts";
import { involvesSol, prepareTokens } from "../lib/native";
import { amount as fmtAmount, price as fmtPrice, shortAddress } from "../lib/format";
import { send, TxFailure } from "../lib/tx";
import { Empty, Panel } from "../components/primitives";

export function PositionPanel({
  bundle,
  tokens,
  bins,
  selected,
  onSelect,
  onDone,
  push
}: {
  bundle: PoolBundle;
  tokens: TokenPair;
  bins: Map<number, BinView>;
  selected?: string;
  onSelect: (address?: string) => void;
  onDone: () => void;
  push: (toast: Omit<Toast, "id">) => void;
}) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const [busy, setBusy] = useState<string>();
  const [removeBps, setRemoveBps] = useState(10_000);

  const owner = wallet.publicKey;
  if (!owner) {
    return (
      <Panel title="My positions">
        <Empty>Connect a wallet to see your positions in this pool.</Empty>
      </Panel>
    );
  }
  if (!bundle.positions.length) {
    return (
      <Panel title="My positions">
        <Empty>No position here yet.</Empty>
      </Panel>
    );
  }

  const accountsFor = (position: { address: { toBase58(): string } }, lower: number, upper: number) =>
    ({
      owner,
      position: position.address as never,
      pool: bundle.address,
      config: bundle.configAddress,
      tokens,
      userTokenX: ataFor(tokens.mintX, owner, tokens.programX),
      userTokenY: ataFor(tokens.mintY, owner, tokens.programY),
      reserveX: bundle.pool.reserveX,
      reserveY: bundle.pool.reserveY,
      binArrays: arrayIndexesFor(lower, upper).map((index) => binArrayPda(bundle.address, index))
    }) as LiquidityAccounts;

  /**
   * Claiming and withdrawing only ever pay *into* the wallet, so both accounts
   * have to exist first — a wSOL account that a previous unwrap closed would
   * otherwise fail the transfer — and a SOL side is unwrapped once the program
   * has paid into it.
   */
  const around = () =>
    prepareTokens(owner, [
      {
        mint: tokens.mintX,
        program: tokens.programX,
        state: assumeMissing(tokens.mintX, owner, tokens.programX),
        needed: 0n
      },
      {
        mint: tokens.mintY,
        program: tokens.programY,
        state: assumeMissing(tokens.mintY, owner, tokens.programY),
        needed: 0n
      }
    ]);

  async function run(key: string, label: string, build: () => Promise<ReturnType<typeof claimFeeIx>[]>) {
    setBusy(key);
    try {
      const { before, after } = around();
      const instructions = [...before, ...(await build()), ...after];
      const signature = await send(connection, wallet, instructions, { computeUnits: 1_400_000 });
      push({ kind: "ok", label, signature });
      onDone();
    } catch (error) {
      const failure = error as TxFailure;
      push({ kind: "bad", label: `${label} failed`, detail: failure.message, logs: failure.logs });
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <Panel title="My positions">
      {involvesSol(tokens.mintX, tokens.mintY) && (
        <p className="hint">
          Fees and withdrawals are paid into a wrapped SOL account, which this app closes in the same
          transaction — so what reaches your wallet is SOL.
        </p>
      )}
      <div className="position-list">
        {bundle.positions.map(({ address, view }) => {
          const key = address.toBase58();
          const summary = summarise(view, bins);
          const drained = !hasLiquidity(view);
          const isSelected = selected === key;
          const accounts = accountsFor({ address }, view.lowerBinId, view.upperBinId);

          return (
            <div key={key} className={`position ${isSelected ? "selected" : ""}`}>
              <button type="button" className="position-head" onClick={() => onSelect(isSelected ? undefined : key)}>
                <strong>
                  bins {view.lowerBinId} – {view.upperBinId}
                </strong>
                <small className="mono">
                  {fmtPrice(bundle.ladder.price(view.lowerBinId) * bundle.scale)} –{" "}
                  {fmtPrice(bundle.ladder.price(view.upperBinId) * bundle.scale)}
                </small>
                <span className={summary.activeBins ? "live" : "idle"}>
                  {summary.activeBins} funded bin{summary.activeBins === 1 ? "" : "s"}
                </span>
              </button>

              <div className="readout">
                <dt>holdings</dt>
                <dd className="mono">
                  <span className="sym-x">
                    {fmtAmount(summary.amountX, bundle.pool.tokenXDecimals)} {bundle.x.symbol}
                  </span>
                  <span className="dim"> · </span>
                  <span className="sym-y">
                    {fmtAmount(summary.amountY, bundle.pool.tokenYDecimals)} {bundle.y.symbol}
                  </span>
                </dd>
                <dt>unclaimed fees</dt>
                <dd className="mono">
                  <span className="sym-x">{fmtAmount(summary.feeX, bundle.pool.tokenXDecimals)}</span>
                  <span className="dim"> · </span>
                  <span className="sym-y">{fmtAmount(summary.feeY, bundle.pool.tokenYDecimals)}</span>
                </dd>
                <dt>claimed to date</dt>
                <dd className="mono dim">
                  {fmtAmount(view.totalClaimedFeeX, bundle.pool.tokenXDecimals)} ·{" "}
                  {fmtAmount(view.totalClaimedFeeY, bundle.pool.tokenYDecimals)}
                </dd>
                <dt>address</dt>
                <dd className="mono dim">{shortAddress(key, 6, 6)}</dd>
              </div>

              <div className="actions">
                <button
                  type="button"
                  className="ghost"
                  disabled={Boolean(busy) || (summary.feeX === 0n && summary.feeY === 0n)}
                  onClick={() => run(key + ":claim", "Fees claimed", async () => [claimFeeIx(accounts)])}
                >
                  {busy === key + ":claim" ? "claiming…" : "Claim fees"}
                </button>

                {!drained && (
                  <>
                    <div className="segmented inline">
                      {[2_500, 5_000, 10_000].map((bps) => (
                        <button
                          key={bps}
                          type="button"
                          className={bps === removeBps ? "selected" : ""}
                          onClick={() => setRemoveBps(bps)}
                        >
                          {bps / 100}%
                        </button>
                      ))}
                    </div>
                    <button
                      type="button"
                      className="ghost"
                      disabled={Boolean(busy)}
                      onClick={() =>
                        run(key + ":remove", `Removed ${removeBps / 100}%`, async () => {
                          const reductions = reductionsFor(view, removeBps);
                          if (!reductions.length) throw new Error("Nothing to remove.");
                          const instructions = [removeLiquidityIx(accounts, reductions)];
                          // A full withdrawal empties the position, so closing
                          // it in the same transaction reclaims its rent now
                          // rather than leaving a husk behind. The claim is not
                          // optional: `close_position` refuses a position that
                          // still has a fee pending, and the withdrawal has
                          // just checkpointed one.
                          if (removeBps === 10_000) {
                            instructions.push(claimFeeIx(accounts), closePositionIx(owner, address));
                          }
                          return instructions;
                        })
                      }
                    >
                      {busy === key + ":remove"
                        ? "removing…"
                        : removeBps === 10_000
                          ? "Remove all and close"
                          : `Remove ${removeBps / 100}%`}
                    </button>
                  </>
                )}

                {drained && (
                  <button
                    type="button"
                    className="ghost"
                    disabled={Boolean(busy)}
                    onClick={() =>
                      run(key + ":close", "Position closed", async () => [
                        // Same rule as above: whatever fee the position is
                        // still owed has to be paid out before it can close.
                        claimFeeIx(accounts),
                        closePositionIx(owner, address)
                      ])
                    }
                  >
                    {busy === key + ":close"
                      ? "closing…"
                      : summary.feeX > 0n || summary.feeY > 0n
                        ? "Claim and close"
                        : "Close and reclaim rent"}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}
