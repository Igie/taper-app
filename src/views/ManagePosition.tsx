/**
 * Everything you can do to a position that already exists.
 *
 * One position at a time — picked here, and highlighted on the ladder above —
 * with the four verbs behind tabs rather than side by side: **add**, **remove**
 * and **move** are three different questions about the same account, and a
 * panel that showed all three at once was mostly buttons.
 *
 * Claim and close stay out of the tabs, in the panel's header. They are not a
 * mode you work in; they are the two things you do to a position on your way
 * out of it, and they have to be reachable from whichever tab is open —
 * `close_position` refuses a position with a fee still pending, so the pair
 * belongs together and near.
 *
 * The fee figure shown is not the one stored on the position. The program only
 * moves fee growth into `fee_*_pending` when it *touches* a position — on a
 * deposit, a withdrawal or a claim — so a position that has been earning all
 * along still reads zero until then. `summarise` adds the uncredited growth
 * back, which is why the number here can move without any transaction.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import type { PublicKey } from "@solana/web3.js";
import {
  arrayIndexesFor,
  assumeMissing,
  ataFor,
  binArrayPda,
  claimFeeIx,
  closePositionIx,
  explorerTx,
  hasLiquidity,
  involvesSol,
  MAX_BINS_PER_POSITION,
  planExit,
  planRebalance,
  prepareTokens,
  summarise,
  TX_HEADROOM,
  TX_HEADROOM_NATIVE,
  type BaseAccounts,
  type BinView,
  type LiquidityAccounts,
  type TokenPair
} from "@taper/sdk";
import type { PoolBundle } from "./PoolView";
import type { Toast } from "../lib/providers";
import { useCluster } from "../lib/providers";
import { loadBalances } from "../lib/accounts";
import { useBatch } from "../lib/batch";
import { loadPool } from "../lib/data";
import { BatchProgress } from "../components/BatchProgress";
import { DepositForm, type Range } from "../components/DepositForm";
import { amount as fmtAmount, price as fmtPrice, shortAddress } from "../lib/format";
import { send, TxFailure } from "../lib/tx";
import { Empty, HoverCard, Info, Metric, Panel, Tabs } from "../components/primitives";

type Props = {
  bundle: PoolBundle;
  tokens: TokenPair;
  bins: Map<number, BinView>;
  selected?: string;
  onSelect: (address?: string) => void;
  /** The band selected on the ladder, offered as a target for a move. */
  range?: Range;
  onDone: () => void;
  push: (toast: Omit<Toast, "id">) => void;
};

type Tab = "add" | "remove" | "move";

/**
 * The two guards, kept in a component of their own.
 *
 * They cannot live inside the panel below. Half of it is memoised, so an early
 * return would run fewer hooks while the wallet held no position here and more
 * the moment it opened one — which React refuses mid-render, taking the whole
 * page down with it rather than just this panel. A component boundary is the
 * one place a condition may decide whether hooks run at all.
 */
export function ManagePosition(props: Props) {
  const { publicKey } = useWallet();
  if (!publicKey) {
    return (
      <Panel title="Manage position">
        <Empty>Connect a wallet to see your positions in this pool.</Empty>
      </Panel>
    );
  }
  if (!props.bundle.positions.length) {
    return (
      <Panel title="Manage position">
        <Empty>No position here yet — open one with the panel above.</Empty>
      </Panel>
    );
  }
  return <Held {...props} owner={publicKey} />;
}

function Held({
  bundle,
  tokens,
  bins,
  selected,
  onSelect,
  range,
  onDone,
  push,
  owner
}: Props & { owner: PublicKey }) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const { cluster } = useCluster();
  const batch = useBatch();
  const [tab, setTab] = useState<Tab>("add");
  const [busy, setBusy] = useState<string>();
  const [depositing, setDepositing] = useState(false);
  const [removeBps, setRemoveBps] = useState(10_000);
  const [applyAll, setApplyAll] = useState(false);
  const [moveLower, setMoveLower] = useState("");
  const [moveUpper, setMoveUpper] = useState("");

  const native = involvesSol(tokens.mintX, tokens.mintY);
  const headroom = native ? TX_HEADROOM_NATIVE : TX_HEADROOM;

  // The selection lives in `PoolView` because the ladder draws from it too.
  // Falling back to the first position rather than to nothing means the panel
  // always has something to act on, and the ladder always shows a holding.
  const held = bundle.positions.find((p) => p.address.toBase58() === selected) ?? bundle.positions[0];
  const key = held.address.toBase58();

  useEffect(() => {
    if (selected !== key) onSelect(key);
  }, [selected, key, onSelect]);

  // Seeded with the band it already has, so the move form starts from "no
  // change" and every edit is a deliberate one.
  useEffect(() => {
    setMoveLower(String(held.view.lowerBinId));
    setMoveUpper(String(held.view.upperBinId));
  }, [key, held.view.lowerBinId, held.view.upperBinId]);

  // A fresh object every render would re-plan the deposit every render, so the
  // band handed to the shared form is memoised on the two numbers it is made of.
  const addRange = useMemo(
    () => ({ lower: held.view.lowerBinId, upper: held.view.upperBinId }),
    [held.view.lowerBinId, held.view.upperBinId]
  );
  const keepBand = useCallback(() => {}, []);

  const summary = summarise(held.view, bins);
  const drained = !hasLiquidity(held.view);
  const owed = summary.feeX > 0n || summary.feeY > 0n;
  const running = batch.running || Boolean(busy) || depositing;

  const baseAccounts: BaseAccounts = {
    owner,
    pool: bundle.address,
    config: bundle.configAddress,
    tokens,
    userTokenX: ataFor(tokens.mintX, owner, tokens.programX),
    userTokenY: ataFor(tokens.mintY, owner, tokens.programY),
    reserveX: bundle.pool.reserveX,
    reserveY: bundle.pool.reserveY
  };

  const accountsFor = (address: PublicKey, lower: number, upper: number) =>
    ({
      ...baseAccounts,
      position: address,
      binArrays: arrayIndexesFor(lower, upper).map((index) => binArrayPda(bundle.address, index))
    }) as LiquidityAccounts;

  /**
   * Claiming and closing only ever pay *into* the wallet, so both accounts
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

  async function run(id: string, label: string, build: () => ReturnType<typeof claimFeeIx>[]) {
    setBusy(id);
    try {
      const { before, after } = around();
      const signature = await send(connection, wallet, [...before, ...build(), ...after], {
        computeUnits: 1_400_000
      });
      push({ kind: "ok", label, signature });
      onDone();
    } catch (error) {
      const failure = error as TxFailure;
      push({ kind: "bad", label: `${label} failed`, detail: failure.message, logs: failure.logs });
    } finally {
      setBusy(undefined);
    }
  }

  /**
   * The context a multi-transaction withdrawal or move runs under.
   *
   * Withdrawals and fees only ever pay *into* the wallet, so both accounts have
   * to exist first and the SOL side is unwrapped once the program has paid into
   * it. Re-read per step: the previous one closed that account.
   */
  const exitContext = useCallback(
    () => ({
      refresh: async () => ({
        existingArrays: new Set<number>(),
        activeId: (await loadPool(connection, bundle.address)).activeId
      }),
      exists: async (address: Parameters<typeof connection.getAccountInfo>[0]) =>
        Boolean(await connection.getAccountInfo(address)),
      lengthOf: async (address: Parameters<typeof connection.getAccountInfo>[0]) =>
        (await connection.getAccountInfo(address))?.data.length ?? 0,
      decorate: async () => {
        const fresh = await loadBalances(
          connection,
          [
            { mint: tokens.mintX, program: tokens.programX },
            { mint: tokens.mintY, program: tokens.programY }
          ],
          owner
        );
        return prepareTokens(owner, [
          { mint: tokens.mintX, program: tokens.programX, state: fresh.states[0], needed: 0n },
          { mint: tokens.mintY, program: tokens.programY, state: fresh.states[1], needed: 0n }
        ]);
      }
    }),
    [bundle.address, connection, owner, tokens]
  );

  /**
   * A withdrawal, over one position or over every position in this pool.
   *
   * `planExit` cuts a wide position into chunks and rides the claim along with
   * each — a withdrawal checkpoints a fee on its way out, so a bin emptied
   * without claiming still reads as non-empty — and puts the close on the last
   * step when the withdrawal is a full one.
   */
  const exitPlan = useMemo(
    () =>
      planExit({
        accounts: baseAccounts,
        positions: (applyAll ? bundle.positions : [held]).map(({ address, view }) => ({
          address,
          view
        })),
        bps: removeBps,
        close: removeBps === 10_000,
        headroom
      }),
    // `baseAccounts` is derived from these, and rebuilding it every render is
    // cheaper than memoising a PDA derivation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [applyAll, removeBps, headroom, bundle.positions, key, bundle.address, owner, tokens]
  );

  async function withdraw() {
    const result = await batch.run(exitPlan.steps, exitContext());
    if (result.failed) {
      push({
        kind: "bad",
        label: `Stopped after ${result.completed} of ${exitPlan.steps.length}`,
        detail: result.failed.detail
      });
    } else {
      push({
        kind: "ok",
        label:
          removeBps === 10_000
            ? applyAll
              ? "All positions closed"
              : "Position closed"
            : `Withdrew ${removeBps / 100}%`,
        detail: `${result.completed} transaction${result.completed === 1 ? "" : "s"}`
      });
      batch.reset();
    }
    onDone();
  }

  /**
   * The band the move form is asking for, once both fields parse and the band
   * is one the program would accept.
   *
   * Validated here rather than on submit so the summary below can say what the
   * move would cost before it is run. The config's own range is the outer
   * bound: `resize_position` checks it, and a band reaching past it fails as
   * `BinIdOutOfRange`.
   */
  const moveTarget = (() => {
    const lower = Number.parseInt(moveLower, 10);
    const upper = Number.parseInt(moveUpper, 10);
    if (!Number.isFinite(lower) || !Number.isFinite(upper) || upper < lower) return undefined;
    if (upper - lower + 1 > MAX_BINS_PER_POSITION) return undefined;
    if (lower < bundle.config.minBinId || upper > bundle.config.maxBinId) return undefined;
    return { lower, upper };
  })();

  const movePlan = useMemo(() => {
    if (!moveTarget) return undefined;
    return planRebalance({
      accounts: baseAccounts,
      position: { address: held.address, view: held.view },
      target: moveTarget,
      headroom
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moveTarget?.lower, moveTarget?.upper, key, held.view, headroom, owner, tokens]);

  async function moveBand() {
    if (!movePlan || !moveTarget) return;
    // The same decoration as an exit: the withdrawals at the front of a move
    // pay into the wallet, and the resize steps need no tokens at all. The
    // runner adds nothing to a step that asks for nothing.
    const result = await batch.run(movePlan.steps, exitContext());
    if (result.failed) {
      push({
        kind: "bad",
        label: `Stopped after ${result.completed} of ${movePlan.steps.length}`,
        detail: result.failed.detail
      });
    } else {
      push({
        kind: "ok",
        label: `Band moved to ${moveTarget.lower}…${moveTarget.upper}`,
        detail: movePlan.kept.length
          ? `${movePlan.kept.length} bins kept their liquidity; ${movePlan.leaving.length} were emptied to your wallet`
          : `${movePlan.leaving.length} bins emptied to your wallet`
      });
      batch.reset();
    }
    onDone();
  }

  return (
    <Panel
      title="Manage position"
      aside={
        <div className="panel-actions">
          <button
            type="button"
            className="ghost"
            disabled={running || !owed}
            onClick={() =>
              run(`${key}:claim`, "Fees claimed", () => [
                claimFeeIx(accountsFor(held.address, held.view.lowerBinId, held.view.upperBinId))
              ])
            }
          >
            {busy === `${key}:claim` ? "claiming…" : "Claim fees"}
          </button>
          <HoverCard
            trigger={
              <button
                type="button"
                className="ghost"
                disabled={running || !drained}
                onClick={() =>
                  run(`${key}:close`, "Position closed", () => [
                    // Whatever fee the position is still owed has to be paid
                    // out before it can close.
                    claimFeeIx(accountsFor(held.address, held.view.lowerBinId, held.view.upperBinId)),
                    closePositionIx(owner, held.address)
                  ])
                }
              >
                {busy === `${key}:close` ? "closing…" : owed ? "Claim and close" : "Close"}
              </button>
            }
          >
            {drained
              ? "Claims what is owed and returns the account's rent, in one transaction."
              : "A position has to be empty to close. Withdraw 100% on the Remove tab — that closes it in the same run."}
          </HoverCard>
        </div>
      }
    >
      {bundle.positions.length > 1 && (
        <div className="position-picker" role="group" aria-label="your positions here">
          {bundle.positions.map(({ address, view }) => {
            const id = address.toBase58();
            return (
              <button
                key={id}
                type="button"
                aria-pressed={id === key}
                className={id === key ? "selected" : ""}
                disabled={running}
                onClick={() => onSelect(id)}
              >
                <strong className="mono">
                  {view.lowerBinId} – {view.upperBinId}
                </strong>
                <small className="mono">
                  {fmtPrice(bundle.ladder.price(view.lowerBinId) * bundle.scale)} –{" "}
                  {fmtPrice(bundle.ladder.price(view.upperBinId) * bundle.scale)}
                </small>
              </button>
            );
          })}
        </div>
      )}

      <div className="metrics">
        <Metric
          label="holdings"
          value={
            <>
              <span className="sym-x">{fmtAmount(summary.amountX, bundle.pool.tokenXDecimals)}</span>
              <span className="dim"> / </span>
              <span className="sym-y">{fmtAmount(summary.amountY, bundle.pool.tokenYDecimals)}</span>
            </>
          }
          hint={`${bundle.x.symbol} / ${bundle.y.symbol}, your share of every bin in the band.`}
        />
        <Metric
          label="unclaimed fees"
          value={
            <>
              <span className="sym-x">{fmtAmount(summary.feeX, bundle.pool.tokenXDecimals)}</span>
              <span className="dim"> / </span>
              <span className="sym-y">{fmtAmount(summary.feeY, bundle.pool.tokenYDecimals)}</span>
            </>
          }
          hint="Includes growth the program has not credited to the position yet, which is why it moves without a transaction."
        />
        <Metric
          label="funded bins"
          value={`${summary.activeBins} of ${held.view.width}`}
          hint={
            <dl>
              <dt>band</dt>
              <dd>
                {held.view.lowerBinId} – {held.view.upperBinId}
              </dd>
              <dt>storage</dt>
              <dd>{held.view.capacity} bins</dd>
              <dt>claimed to date</dt>
              <dd>
                {fmtAmount(held.view.totalClaimedFeeX, bundle.pool.tokenXDecimals)} /{" "}
                {fmtAmount(held.view.totalClaimedFeeY, bundle.pool.tokenYDecimals)}
              </dd>
              <dt>address</dt>
              <dd>{shortAddress(key, 4, 4)}</dd>
            </dl>
          }
        />
      </div>

      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "add", label: "Add", hint: "deposit into this band", disabled: depositing && tab !== "add" },
          { id: "remove", label: "Remove", hint: "withdraw, and close at 100%", disabled: depositing },
          { id: "move", label: "Move band", hint: "rebalance in place", disabled: depositing }
        ]}
      />

      {tab === "add" && (
        <DepositForm
          bundle={bundle}
          tokens={tokens}
          range={addRange}
          onRange={keepBand}
          onBusyChange={setDepositing}
          onDone={onDone}
          push={push}
        />
      )}

      {tab === "remove" && (
        <>
          <div className="actions">
            <div className="segmented inline">
              {[2_500, 5_000, 7_500, 10_000].map((bps) => (
                <button
                  key={bps}
                  type="button"
                  className={bps === removeBps ? "selected" : ""}
                  disabled={running}
                  onClick={() => setRemoveBps(bps)}
                >
                  {bps / 100}%
                </button>
              ))}
            </div>
            {bundle.positions.length > 1 && (
              <label className="check">
                <input
                  type="checkbox"
                  checked={applyAll}
                  disabled={running}
                  onChange={(e) => setApplyAll(e.target.checked)}
                />
                all {bundle.positions.length} positions
              </label>
            )}
          </div>

          <div className="readout">
            <dt>
              transactions
              {exitPlan.steps.length > 1 && (
                <Info>
                  A wide band is emptied in chunks, one transaction each — not atomic, and resumable
                  from wherever it stops.
                </Info>
              )}
            </dt>
            <dd className="mono">{exitPlan.steps.length || "nothing to withdraw"}</dd>
            {removeBps === 10_000 && (
              <>
                <dt>
                  closing
                  <Info>
                    A full withdrawal empties the position, so the claim and the close ride on the
                    last transaction — `close_position` refuses a position with a fee still pending,
                    and the withdrawal has just checkpointed one. The rent comes back.
                  </Info>
                </dt>
                <dd className="mono">
                  {exitPlan.closing} position{exitPlan.closing === 1 ? "" : "s"}
                </dd>
              </>
            )}
          </div>

          <div className="actions">
            <button
              type="button"
              className="primary"
              disabled={running || !exitPlan.steps.length}
              onClick={withdraw}
            >
              {batch.running
                ? "withdrawing…"
                : removeBps === 10_000
                  ? applyAll
                    ? `Remove all and close ${bundle.positions.length}`
                    : "Remove all and close"
                  : `Remove ${removeBps / 100}%${applyAll ? " from all" : ""}`}
            </button>
            {batch.statuses.some((s) => s.state === "failed" || s.state === "unknown") && (
              <button type="button" onClick={batch.reset} disabled={batch.running}>
                Discard
              </button>
            )}
          </div>
        </>
      )}

      {tab === "move" && (
        <>
          <div className="range-row">
            <label className="field">
              <span>
                lower bin
                <Info>
                  Moving a band keeps this position — its address, its fee checkpoints and its claimed
                  totals — instead of closing and reopening it. Bins that stay in the band keep their
                  liquidity in the pool and never stop earning. Bins that leave are emptied into your
                  wallet on the way, because the program refuses to drop a bin still holding shares or
                  an unclaimed fee.
                </Info>
              </span>
              <input
                className="mono"
                inputMode="numeric"
                value={moveLower}
                disabled={running}
                onChange={(e) => setMoveLower(e.target.value)}
              />
            </label>
            <label className="field">
              <span>upper bin</span>
              <input
                className="mono"
                inputMode="numeric"
                value={moveUpper}
                disabled={running}
                onChange={(e) => setMoveUpper(e.target.value)}
              />
            </label>
            {range && (
              <div className="field">
                <span>ladder selection</span>
                <button
                  type="button"
                  className="ghost"
                  disabled={running}
                  onClick={() => {
                    setMoveLower(String(range.lower));
                    setMoveUpper(String(range.upper));
                  }}
                >
                  use {range.lower} – {range.upper}
                </button>
              </div>
            )}
          </div>

          {!moveTarget && (
            <p className="hint warn">
              Give a band inside {bundle.config.minBinId}…{bundle.config.maxBinId}, at most{" "}
              {MAX_BINS_PER_POSITION} bins wide, with the lower bin first.
            </p>
          )}

          {movePlan && (
            <>
              <div className="readout">
                <dt>kept</dt>
                <dd className="mono">
                  {movePlan.kept.length} bin{movePlan.kept.length === 1 ? "" : "s"}
                  <span className="dim"> — liquidity stays in the pool</span>
                </dd>
                <dt>emptied</dt>
                <dd className="mono">
                  {movePlan.leaving.length} bin{movePlan.leaving.length === 1 ? "" : "s"}
                  <span className="dim"> — withdrawn to your wallet first</span>
                </dd>
                <dt>added</dt>
                <dd className="mono">
                  {movePlan.arriving.length} bin{movePlan.arriving.length === 1 ? "" : "s"}
                  <span className="dim"> — empty, fill them on the Add tab</span>
                </dd>
                <dt>transactions</dt>
                <dd className="mono dim">
                  {movePlan.steps.length || "none — the band is already there"}
                </dd>
              </div>
              <div className="actions">
                <button
                  type="button"
                  className="primary"
                  disabled={running || !movePlan.steps.length}
                  onClick={moveBand}
                >
                  {batch.running ? "moving…" : `Move band to ${moveTarget!.lower}…${moveTarget!.upper}`}
                </button>
              </div>
            </>
          )}
        </>
      )}

      {tab !== "add" && (
        <BatchProgress
          statuses={batch.statuses}
          explorer={(signature) => explorerTx(cluster, signature)}
        />
      )}

      {native && (
        <p className="hint">
          Paid out as SOL.
          <Info>
            Fees and withdrawals are paid into a wrapped SOL account, which this app closes in the
            same transaction — so what reaches your wallet is SOL.
          </Info>
        </p>
      )}
    </Panel>
  );
}
