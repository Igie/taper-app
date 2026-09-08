/**
 * Everything you can do to a position that already exists.
 *
 * One position at a time — picked here, and highlighted on the ladder above —
 * with the verbs behind tabs rather than side by side: **add**, **remove**,
 * **reshape** and **move** are four different questions about the same
 * account, and a panel that showed them all at once was mostly buttons.
 *
 * **All four read the ladder selection**, each asking its own question of the
 * same drag: which bins to fill, which to take back, which to pool and redraw,
 * and where the band should end up. Nothing selected means the whole band,
 * which is each verb's "no change" — a deposit across all of it, a plain full
 * withdrawal, a reshape of everything, a move that moves nothing.
 *
 * **Add** reads it for the same reason the others do and it was the last to:
 * `add_liquidity` takes a bps table over a contiguous run of bins and the
 * position's band has only to contain it, so filling a stretch needs nothing
 * new from the program. Handing the form the whole band whatever the chart had
 * highlighted spread a deposit meant for five bins over every bin in the
 * position — and normalised the shape against the wrong width, so even the
 * bins that were picked got the wrong share of the money.
 *
 * The last two are easy to confuse and are genuinely different instructions.
 * **Move** changes *where* the band is — extend an edge, shrink one, or slide
 * the whole thing — and empties whatever falls outside it into your wallet.
 * **Reshape** leaves the band exactly where it is and rearranges the liquidity
 * inside it, in one transaction, without the tokens ever leaving the pool.
 *
 * **None of them ask their question in a text field.** The
 * drag selection above *is* the target band, and the width and slide controls
 * here write back into it — so the range a move will produce is the range the
 * chart is drawing, and there is never a typed pair of bin ids disagreeing
 * with what is highlighted. With nothing selected each verb falls back to the
 * position's own band, which is the "no change" the forms open on.
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
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import type { PublicKey } from "@solana/web3.js";
import {
  arrayIndexesFor,
  assumeMissing,
  ataFor,
  binArrayPda,
  claimFeeIx,
  closePositionIx,
  compositionXShare,
  explorerTx,
  hasLiquidity,
  involvesSol,
  MAX_BINS_PER_POSITION,
  planExit,
  planRebalance,
  planReshape,
  prepareTokens,
  SHAPES,
  SPOT_BLEND_MAX,
  summarise,
  TX_HEADROOM,
  TX_HEADROOM_NATIVE,
  type BaseAccounts,
  type BinView,
  type LiquidityAccounts,
  type Shape,
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
import {
  Empty,
  HoverCard,
  Info,
  Metric,
  Panel,
  Segmented,
  Tabs
} from "../components/primitives";

type Props = {
  bundle: PoolBundle;
  tokens: TokenPair;
  bins: Map<number, BinView>;
  selected?: string;
  onSelect: (address?: string) => void;
  /**
   * The band selected on the ladder, and the target every verb here acts on.
   * Undefined means "nothing selected", which each reads as the position's own
   * band. See `clipped`, which is where that is turned into a stretch.
   */
  range?: Range;
  /** Written by the width and slide controls, so the chart shows the target. */
  onRange: (range: Range) => void;
  /** The pool page's view picker, which stands in for this panel's title. */
  header?: ReactNode;
  /** Raised while a plan is in flight or half-landed, so the picker holds us. */
  onBusyChange?: (busy: boolean) => void;
  onDone: () => void;
  push: (toast: Omit<Toast, "id">) => void;
};

type Tab = "add" | "remove" | "reshape" | "move";

/** Widths worth one click. 70 is one dense transaction's worth. */
const WIDTHS = [10, 35, 70, 140];

/**
 * A band the program would accept: inside the config's own range, at least one
 * bin wide, and at most `MAX_BINS_PER_POSITION`.
 *
 * **Width survives the clamp; position does not.** A band pushed past an end of
 * the ladder slides back inside it rather than being cut short there, because
 * every control here asks for a width and a place separately — silently
 * narrowing a slide would answer a question nobody asked.
 */
function clampBand(band: Range, limits: { min: number; max: number }): Range {
  const room = limits.max - limits.min + 1;
  const width = Math.max(1, Math.min(MAX_BINS_PER_POSITION, room, band.upper - band.lower + 1));
  const lower = Math.max(limits.min, Math.min(band.lower, limits.max - width + 1));
  return { lower, upper: lower + width - 1 };
}

/**
 * The band `width` bins wide that keeps `band`'s middle where it is.
 *
 * The middle floors rather than rounds, which is what makes this an identity
 * at the width it is already at — `lower + floor((w-1)/2)` is exactly the
 * offset the new lower edge subtracts back off — so pressing a width button
 * twice, or the one the band already matches, moves nothing. Rounding drifted
 * an even-width band by a bin each press.
 */
function resize(band: Range, width: number, limits: { min: number; max: number }): Range {
  const middle = Math.floor((band.lower + band.upper) / 2);
  const lower = middle - Math.floor((width - 1) / 2);
  return clampBand({ lower, upper: lower + width - 1 }, limits);
}

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
      <Panel title="Manage position" header={props.header}>
        <Empty>Connect a wallet to see your positions in this pool.</Empty>
      </Panel>
    );
  }
  if (!props.bundle.positions.length) {
    return (
      <Panel title="Manage position" header={props.header}>
        <Empty>No position here yet — open one on the New position tab.</Empty>
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
  onRange,
  header,
  onBusyChange,
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
  const [shape, setShape] = useState<Shape>("curve");
  const [spotBlend, setSpotBlend] = useState(0);
  // Off by default. Compounding turns a claim into liquidity, which is a
  // second decision — and this panel deliberately keeps fees a separate
  // concern from whichever verb is running.
  const [compoundFees, setCompoundFees] = useState(false);

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

  // A fresh object every render would re-plan the deposit every render, so the
  // band the position already has is memoised on the two numbers it is made of.
  // It is what `Add` deposits into, what `Move` starts from and what the other
  // two verbs fall back to when the ladder has no selection.
  const band = useMemo(
    () => ({ lower: held.view.lowerBinId, upper: held.view.upperBinId }),
    [held.view.lowerBinId, held.view.upperBinId]
  );
  const keepBand = useCallback(() => {}, []);

  const limits = useMemo(
    () => ({ min: bundle.config.minBinId, max: bundle.config.maxBinId }),
    [bundle.config.minBinId, bundle.config.maxBinId]
  );

  const summary = summarise(held.view, bins);
  const drained = !hasLiquidity(held.view);
  const owed = summary.feeX > 0n || summary.feeY > 0n;
  const running = batch.running || Boolean(busy) || depositing;

  /**
   * Why the pool page's tab strip may not take this panel away.
   *
   * A plan that has landed some of its transactions and not the rest lives
   * only in `useBatch`'s memory — a fill leaves no witness on chain, so the
   * completed set is the only thing that knows a chunk is already done.
   * Unmounting would throw that away and a re-run could deposit twice, which
   * is the same reason the tabs *inside* this panel lock during a run.
   */
  const settled = (s: { state: string }) => s.state === "done" || s.state === "skipped";
  const halfLanded =
    !batch.running && batch.statuses.some(settled) && batch.statuses.some((s) => !settled(s));

  useEffect(() => {
    onBusyChange?.(running || halfLanded);
    return () => onBusyChange?.(false);
  }, [running, halfLanded, onBusyChange]);

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
   * **The ladder selection, clipped to this band** — the stretch every verb in
   * this panel acts on, and the whole band when nothing is selected.
   *
   * One computation rather than one per tab, because it is one decision: the
   * drag across the chart is the only place a stretch is chosen, and Add,
   * Remove and Reshape all ask it of the same band. Clipped rather than
   * refused, because the selection is shared with **Move**, where a drag
   * reaching past this band is a perfectly good target.
   *
   * `undefined` means the selection misses this band entirely. Each tab says
   * so rather than quietly acting on all of it — the difference between
   * "these five bins" and "everything you hold" is the whole position.
   */
  const clipped = useMemo(() => {
    if (!range) return band;
    const lower = Math.max(range.lower, band.lower);
    const upper = Math.min(range.upper, band.upper);
    return upper >= lower ? { lower, upper } : undefined;
  }, [range, band]);

  /**
   * The stretch a withdrawal takes from.
   *
   * Removing by range is not a display filter: `remove_liquidity` takes an
   * arbitrary `(bin_id, bps)` list, so a range is simply which part of the
   * position that list is built from — the bins outside it keep their shares,
   * their fee checkpoints and their place in the band.
   */
  const exitTarget = clipped;

  /**
   * Whether this is the plain whole-position withdrawal, which is the only one
   * that may close. A range leaves shares behind by definition, and
   * `close_position` refuses a position that still holds any — so the close,
   * the rent refund and the wording all hang off this one question.
   */
  const wholeBand =
    exitTarget !== undefined && exitTarget.lower === band.lower && exitTarget.upper === band.upper;
  const exitWidth = exitTarget ? exitTarget.upper - exitTarget.lower + 1 : 0;

  /**
   * A withdrawal, over one position or over every position in this pool, and
   * over the whole band or a stretch of it.
   *
   * `planExit` cuts a wide position into chunks and rides the claim along with
   * each — a withdrawal checkpoints a fee on its way out, so a bin emptied
   * without claiming still reads as non-empty — and puts the close on the last
   * step when the withdrawal is a full one.
   *
   * The range is passed only when it is a genuine narrowing, so the whole-band
   * case builds exactly the plan it always did. Aimed at several positions it
   * is intersected with each of their bands, which is what makes "take back
   * everything below the price" one operation across a pool rather than one
   * per position.
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
        range: wholeBand || !exitTarget ? undefined : exitTarget,
        close: removeBps === 10_000,
        headroom
      }),
    // `baseAccounts` is derived from these, and rebuilding it every render is
    // cheaper than memoising a PDA derivation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      applyAll,
      removeBps,
      exitTarget,
      wholeBand,
      headroom,
      bundle.positions,
      key,
      bundle.address,
      owner,
      tokens
    ]
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
      const where =
        exitTarget && !wholeBand ? ` from bins ${exitTarget.lower}–${exitTarget.upper}` : "";
      push({
        kind: "ok",
        label:
          exitPlan.closing > 0
            ? applyAll
              ? "All positions closed"
              : "Position closed"
            : `Withdrew ${removeBps / 100}%${where}`,
        detail: wholeBand
          ? `${result.completed} transaction${result.completed === 1 ? "" : "s"}`
          : `${exitPlan.bins} bin${exitPlan.bins === 1 ? "" : "s"} emptied and fees claimed; the rest of the band still holds its liquidity`
      });
      batch.reset();
    }
    onDone();
  }

  /**
   * What the caller already knows about the bins it is about to reshape.
   *
   * Both facts pick between a cheap path and an expensive one on chain, and
   * both are readable from the bin arrays this view has already fetched — so
   * the planner is told rather than left to assume the worst. It is not a
   * micro-optimisation: priced blind, a reshape is cut into chunks near 61
   * bins, and a chunked reshape cannot move liquidity across the cut.
   */
  const facts = useMemo(() => {
    const warm = new Set<number>();
    const sole = new Set<number>();
    const last = held.view.lowerBinId + Math.min(held.view.width, held.view.capacity) - 1;
    for (let bin = held.view.lowerBinId; bin <= last; bin += 1) {
      const cell = bins.get(bin);
      if (!cell) continue;
      if (cell.derived) warm.add(bin);
      const share = held.view.shares[bin - held.view.lowerBinId] ?? 0n;
      if (share > 0n && share === cell.liquiditySupply) sole.add(bin);
    }
    return { warm, sole };
  }, [bins, held.view]);

  /**
   * What the active bin already holds, as a fraction of its value in X.
   *
   * The shape splits that one bin's weight by it instead of handing it a full
   * weight on each side, so what the pot puts back lands in the ratio the bin
   * is already in and pays no composition fee to move a mix nobody asked to
   * change. A bin the window has not fetched reads as empty and splits evenly.
   */
  const activeXShare = useMemo(
    () => compositionXShare(bins.get(bundle.pool.activeId)),
    [bins, bundle.pool.activeId]
  );

  /**
   * The stretch of the band a reshape rewrites.
   *
   * A reshape is not all-or-nothing: bins outside this range keep their shares,
   * their fee checkpoints and their prices, and the pot is only ever what the
   * bins *inside* it gave up. So the range is a real choice and not a display
   * filter — narrowing it changes what the liquidity can move between, not just
   * what is redrawn. Which is exactly why it is picked by dragging across the
   * bins it will pool: the chart is showing that decision either way.
   */
  const reshapeTarget = clipped;

  /**
   * The stretch a deposit fills.
   *
   * The fourth verb to read the same drag, and the one that was missing: this
   * tab used to hand the form the whole band whatever the chart had
   * highlighted, so a deposit aimed at five bins spread itself over every bin
   * in the position — with the shape normalised against the wrong width, so
   * even the bins the user *did* pick got the wrong share of the money.
   *
   * Filling part of a band needs nothing new from the program. `add_liquidity`
   * takes a bps table over a contiguous run of bins and the position's band has
   * only to contain it, so the stretch goes straight through as the range;
   * `planDeposit` matches it to this position by containment rather than
   * opening a second one over the same bins.
   *
   * It is also what makes the one-sided refusal true here: `DepositForm` asks
   * `takesX` / `takesY` of the range it is given, so a stretch that sits
   * entirely below the price now disables the X field, where the whole band
   * would have left it open and let the deposit fail on chain.
   */
  const addTarget = clipped;

  /**
   * The stretch the form is actually working on: `addTarget`, **frozen while a
   * deposit is in flight or half-landed**.
   *
   * The same rule that locks the tabs, applied to the one input that is not a
   * field inside the form. A plan that has landed some of its transactions and
   * not the rest lives only in `DepositForm`'s memory — a fill leaves no
   * witness on chain — so the range it was built from may not change under it,
   * and the form may not unmount. The tab strip is held for that reason, but
   * the *ladder* stays draggable, and a drag off this band would otherwise
   * swap the form for the "misses this band" note and lose the record of which
   * chunks had already landed.
   */
  const [pinnedTarget, setPinnedTarget] = useState(addTarget);
  useEffect(() => {
    if (!depositing) setPinnedTarget(addTarget);
  }, [depositing, addTarget]);
  const addRange = depositing ? pinnedTarget : addTarget;
  const addWidth = addRange ? addRange.upper - addRange.lower + 1 : 0;

  const reshapePlan = useMemo(
    () =>
      reshapeTarget
        ? planReshape({
            accounts: baseAccounts,
            position: { address: held.address, view: held.view },
            activeId: bundle.pool.activeId,
            shape,
            spotBlendBps: spotBlend,
            activeXShare,
            range: reshapeTarget,
            compoundFees,
            facts,
            headroom
          })
        : undefined,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      key,
      held.view,
      bundle.pool.activeId,
      shape,
      spotBlend,
      activeXShare,
      reshapeTarget,
      compoundFees,
      facts,
      headroom,
      owner,
      tokens
    ]
  );

  const bandWidth = Math.min(held.view.width, held.view.capacity);
  const reshapeWidth = reshapeTarget ? reshapeTarget.upper - reshapeTarget.lower + 1 : 0;
  const warmInRange = reshapeTarget
    ? [...facts.warm].filter((bin) => bin >= reshapeTarget.lower && bin <= reshapeTarget.upper).length
    : 0;

  async function reshape() {
    if (!reshapePlan || !reshapeTarget) return;
    // Decorated like an exit: a reshape pays nothing *in*, and the only thing
    // that can come out is the per-bin rounding the program refuses to keep.
    const result = await batch.run(reshapePlan.steps, exitContext());
    if (result.failed) {
      push({
        kind: "bad",
        label: `Stopped after ${result.completed} of ${reshapePlan.steps.length}`,
        detail: result.failed.detail
      });
    } else {
      push({
        kind: "ok",
        label:
          reshapeWidth === bandWidth
            ? `Reshaped to ${shape}`
            : `Reshaped bins ${reshapeTarget.lower}–${reshapeTarget.upper} to ${shape}`,
        detail: compoundFees
          ? "Fees were compounded back into the band"
          : "Fees are untouched and still claimable"
      });
      batch.reset();
    }
    onDone();
  }

  /**
   * The band a move would produce: **the ladder selection**, or the band the
   * position already has when nothing is selected.
   *
   * Clamped rather than validated, so there is no invalid state to report and
   * no form to fix — every selection names *some* band `resize_position` would
   * accept, and the readout below says which. The config's own range is the
   * outer bound: the program checks it, and a band reaching past it fails as
   * `BinIdOutOfRange`.
   */
  const moveTarget = useMemo(
    () => clampBand(range ?? band, limits),
    [range, band, limits]
  );

  const moveWidth = moveTarget.upper - moveTarget.lower + 1;
  const moved = moveTarget.lower !== band.lower || moveTarget.upper !== band.upper;

  /**
   * The controls, all three of which write back into the ladder selection —
   * so the chart draws the target rather than a second copy of it living here.
   *
   * Widening keeps the middle where it is, which is what makes the width
   * buttons read as one control rather than as "extend both sides"; sliding
   * keeps the width. A move that lands leaves the selection where it is, which
   * is by then the band the position has, so the form settles on "no change".
   */
  const setWidth = (width: number) => onRange(resize(moveTarget, width, limits));
  const slide = (by: number) =>
    onRange(clampBand({ lower: moveTarget.lower + by, upper: moveTarget.upper + by }, limits));
  const centreOnPrice = () =>
    onRange(resize({ lower: bundle.pool.activeId, upper: bundle.pool.activeId }, moveWidth, limits));

  const movePlan = useMemo(() => {
    return planRebalance({
      accounts: baseAccounts,
      position: { address: held.address, view: held.view },
      target: moveTarget,
      headroom
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moveTarget.lower, moveTarget.upper, key, held.view, headroom, owner, tokens]);

  async function moveBand() {
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
      header={header}
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
      {/*
        Two columns rather than one tall one. Which position, and what it is
        worth, is context you read while working in the verb beside it — and
        stacking the two put the buttons a scroll below the numbers that decide
        which one to press.
      */}
      <div className="manage">
        <aside className="manage-side">
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

        </aside>

        <div className="manage-main">
          <Tabs
            value={tab}
            onChange={setTab}
            tabs={[
              { id: "add", label: "Add", hint: "deposit into this band", disabled: depositing && tab !== "add" },
              {
                id: "remove",
                label: "Remove",
                hint: "withdraw from the band, or a stretch of it",
                disabled: depositing
              },
              {
                id: "reshape",
                label: "Reshape",
                hint: "rearrange this band, without withdrawing",
                disabled: depositing
              },
              {
                id: "move",
                label: "Move band",
                hint: "extend, shrink or shift the band itself",
                disabled: depositing
              }
            ]}
          />

          {tab === "add" && (
            <>
              {/*
                The same drag the other three verbs read, asking the fourth
                question of it: which bins to fill. Nothing selected is the
                whole band, which is the deposit this tab has always made.
              */}
              <div className="target-row">
                <span className="step-label">adding to</span>
                <strong className="mono">
                  {addRange ? `${addRange.lower} – ${addRange.upper}` : "nothing"}
                </strong>
                <span className="dim">
                  {!addRange
                    ? "— your ladder selection misses this band"
                    : addWidth === bandWidth
                      ? "— the whole band"
                      : `— ${addWidth} of ${bandWidth} bins; the rest is left as it is`}
                </span>
                <Info>
                  The shape below is laid out over these bins and normalised against them, so a
                  narrower stretch is a different deposit rather than a filtered one: all of what
                  you enter goes into the bins named here. Bins outside it keep exactly what they
                  hold. Drag across the ladder to aim it — topping up the side the price has moved
                  towards is what this is for.
                </Info>
                {(!addRange || addWidth !== bandWidth) && (
                  <button type="button" className="link" disabled={running} onClick={() => onRange(band)}>
                    take all {bandWidth} bins
                  </button>
                )}
              </div>

              {addRange ? (
                <DepositForm
                  bundle={bundle}
                  tokens={tokens}
                  range={addRange}
                  into={held.address}
                  onRange={keepBand}
                  onBusyChange={setDepositing}
                  onDone={onDone}
                  push={push}
                />
              ) : (
                <p className="hint warn">
                  Nothing to deposit into — the bins you have selected are all outside this
                  position's band. Drag over the band, or take all {bandWidth} bins.
                </p>
              )}
            </>
          )}

          {tab === "remove" && (
            <>
              {/*
                The same drag the other two verbs read, asking the third
                question of it: which bins to take back. Nothing selected is
                the whole band, which is the withdrawal this tab has always
                done and the only one that can close.
              */}
              <div className="target-row">
                <span className="step-label">removing from</span>
                <strong className="mono">
                  {exitTarget ? `${exitTarget.lower} – ${exitTarget.upper}` : "nothing"}
                </strong>
                <span className="dim">
                  {!exitTarget
                    ? "— your ladder selection misses this band"
                    : wholeBand
                      ? "— the whole band"
                      : `— ${exitWidth} of ${bandWidth} bins; the rest stays in the pool`}
                </span>
                <Info>
                  `remove_liquidity` takes a bin-by-bin list, so a stretch costs no more than the
                  whole: drag across the ladder to take back one edge — the bins the price has left
                  behind, say — and leave the rest earning. Bins outside the stretch keep their
                  shares and their fee checkpoints, so the position stays open whatever percentage
                  you pick here.
                </Info>
                {!wholeBand && (
                  <button type="button" className="link" disabled={running} onClick={() => onRange(band)}>
                    take all {bandWidth} bins
                  </button>
                )}
              </div>

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
                  bins held
                  <Info>
                    How much of the stretch actually holds liquidity. A bin holding nothing is left out
                    of the table rather than sent as a zero, so it costs neither bytes nor compute.
                  </Info>
                </dt>
                <dd className="mono">
                  {exitPlan.bins} of {exitWidth}
                  {applyAll && bundle.positions.length > 1 && (
                    <span className="dim">{` · across ${bundle.positions.length} positions`}</span>
                  )}
                </dd>
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
                {removeBps === 10_000 && wholeBand && (
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

              {!exitTarget && (
                <p className="hint warn">
                  Your ladder selection is outside this band. Drag across bins {band.lower} – {band.upper}
                  , or take all of them with the button above.
                </p>
              )}

              {/*
                The one thing a ranged withdrawal does differently, and the one
                that surprises: it cannot close, because the bins outside the
                stretch still hold shares. The claim still rides along — it has
                to, since burning a bin checkpoints its fee — and `claim_fee`
                pays out everything pending, so a narrow withdrawal collects
                the whole position's fees all the same.
              */}
              {exitTarget && !wholeBand && removeBps === 10_000 && (
                <p className="hint">
                  These {exitWidth} bins are emptied and the position stays open — the other{" "}
                  {bandWidth - exitWidth} keep their liquidity. Fees are still paid out in full,
                  the whole band's, because a withdrawal claims on its way past.
                </p>
              )}

              <div className="actions">
                <button
                  type="button"
                  className="primary"
                  disabled={running || !exitPlan.steps.length}
                  onClick={withdraw}
                >
                  {batch.running
                    ? "withdrawing…"
                    : removeBps === 10_000 && wholeBand
                      ? applyAll
                        ? `Remove all and close ${bundle.positions.length}`
                        : "Remove all and close"
                      : `Remove ${removeBps / 100}%${wholeBand ? "" : ` of bins ${exitTarget?.lower}–${exitTarget?.upper}`}${applyAll ? " from all" : ""}`}
                </button>
                {batch.statuses.some((s) => s.state === "failed" || s.state === "unknown") && (
                  <button type="button" onClick={batch.reset} disabled={batch.running}>
                    Discard
                  </button>
                )}
              </div>
            </>
          )}

          {tab === "reshape" && (
            <>
              {/*
                The stretch is the ladder selection, so it is stated here and picked
                up there — no pair of typed bin ids to disagree with what the chart
                has highlighted.
              */}
              <div className="target-row">
                <span className="step-label">reshaping</span>
                <strong className="mono">
                  {reshapeTarget ? `${reshapeTarget.lower} – ${reshapeTarget.upper}` : "nothing"}
                </strong>
                <span className="dim">
                  {!reshapeTarget
                    ? "— your ladder selection misses this band"
                    : reshapeWidth === bandWidth
                      ? "— the whole band"
                      : `— ${reshapeWidth} of ${bandWidth} bins; the rest is left as it is`}
                </span>
                <Info>
                  Rearranges liquidity that is already in the band, leaving the band where it is. One
                  transaction, and the tokens never leave the pool: the program burns these bins into a
                  pot and lays that pot back out at the shape below. Drag across the ladder to pool a
                  narrower stretch — bins outside it keep exactly what they hold, the same shares and
                  the same fee checkpoints, so this is what the liquidity may move between and not just
                  what is redrawn.
                </Info>
                {(!reshapeTarget || reshapeWidth !== bandWidth) && (
                  <button type="button" className="link" disabled={running} onClick={() => onRange(band)}>
                    take all {bandWidth} bins
                  </button>
                )}
              </div>

              <Segmented value={shape} options={SHAPES} onChange={setShape} />

              {shape !== "spot" && (
                <label className="field">
                  <span>
                    spot blend
                    <strong className="mono">{Math.round(spotBlend / 100)}%</strong>
                    <Info>
                      {spotBlend === 0
                        ? `Pure ${shape === "curve" ? "curve" : "bid-ask"}.`
                        : spotBlend === SPOT_BLEND_MAX
                          ? "Flat — identical to spot."
                          : `${Math.round(spotBlend / 100)}% of each side laid out flat, the rest shaped.`}
                    </Info>
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={SPOT_BLEND_MAX}
                    step={100}
                    value={spotBlend}
                    disabled={running}
                    onChange={(e) => setSpotBlend(Number(e.target.value))}
                  />
                </label>
              )}

              <label className="check">
                <input
                  type="checkbox"
                  checked={compoundFees}
                  disabled={running}
                  onChange={(e) => setCompoundFees(e.target.checked)}
                />
                compound unclaimed fees
                <Info>
                  Folds what you are owed into the pot before it is spread, instead of leaving it
                  claimable. The fees are already sitting in the pool, so nothing is transferred either
                  way — this only decides whether they become liquidity or stay a claim.
                </Info>
              </label>

              <div className="readout">
                <dt>
                  cost
                  <Info>
                    A bin the program has already priced is far cheaper to reach than one it has never
                    touched, and how many of each this stretch holds is what decides whether it fits in
                    one transaction. The band itself does not move here — that is the Move tab.
                  </Info>
                </dt>
                <dd className="mono">
                  {warmInRange} of {reshapeWidth} bins priced
                  <span className="dim">
                    {" · "}
                    {reshapePlan?.steps.length || "no"} transaction
                    {reshapePlan?.steps.length === 1 ? "" : "s"}
                  </span>
                </dd>
              </div>

              {!reshapeTarget && (
                <p className="hint warn">
                  Your ladder selection is outside this band. Drag across bins {band.lower} – {band.upper}
                  , or take all of them with the button above.
                </p>
              )}

              {/*
                Not a performance note. A reshape's pot is whatever its own bins gave
                up, so a band cut into steps is several reshapes that cannot pass
                liquidity between them — the result is the chosen shape applied to
                each piece, not to the band. Worth saying plainly before it is run.
              */}
              {reshapePlan && !reshapePlan.atomic && reshapePlan.steps.length > 1 && (
                <p className="hint warn">
                  This stretch is too wide for one transaction, so it is reshaped in{" "}
                  {reshapePlan.steps.length} pieces. Liquidity cannot move between pieces — each is
                  shaped on its own. Narrow the stretch to keep it in one call, or to rearrange across
                  all of it, withdraw on the Remove tab and deposit again on Add.
                </p>
              )}

              <div className="actions">
                <button
                  type="button"
                  className="primary"
                  disabled={running || !reshapePlan?.steps.length}
                  onClick={reshape}
                >
                  {batch.running ? "reshaping…" : `Reshape to ${shape === "bidask" ? "bid-ask" : shape}`}
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
              {/*
                The band is picked on the ladder; these controls are the two edits a
                drag is clumsy at — an exact width, and a nudge along the ladder —
                and both write straight back into the selection the chart draws.
              */}
              <div className="target-row">
                <span className="step-label">new band</span>
                <strong className="mono">
                  {moveTarget.lower} – {moveTarget.upper}
                </strong>
                <span className="dim">
                  {moved
                    ? `— ${fmtPrice(bundle.ladder.price(moveTarget.lower) * bundle.scale)} – ` +
                      `${fmtPrice(bundle.ladder.price(moveTarget.upper) * bundle.scale)}`
                    : "— where it is now; drag the ladder or use the controls below"}
                </span>
                <Info>
                  Moving a band keeps this position — its address, its fee checkpoints and its claimed
                  totals — instead of closing and reopening it. Bins that stay in the band keep their
                  liquidity in the pool and never stop earning. Bins that leave are emptied into your
                  wallet on the way, because the program refuses to drop a bin still holding shares or
                  an unclaimed fee. Drag across the ladder to aim it anywhere.
                </Info>
                {moved && (
                  <button type="button" className="link" disabled={running} onClick={() => onRange(band)}>
                    back to {band.lower} – {band.upper}
                  </button>
                )}
              </div>

              <div className="step-row">
                <span className="step-label">width</span>
                <div className="stepper">
                  <button
                    type="button"
                    className="ghost"
                    aria-label="one bin narrower"
                    disabled={running || moveWidth <= 1}
                    onClick={() => setWidth(moveWidth - 1)}
                  >
                    −
                  </button>
                  <input
                    className="mono"
                    inputMode="numeric"
                    aria-label="bins wide"
                    value={moveWidth}
                    disabled={running}
                    onChange={(e) =>
                      setWidth(
                        Math.min(
                          MAX_BINS_PER_POSITION,
                          Math.max(1, Number.parseInt(e.target.value, 10) || 1)
                        )
                      )
                    }
                  />
                  <button
                    type="button"
                    className="ghost"
                    aria-label="one bin wider"
                    disabled={running || moveWidth >= MAX_BINS_PER_POSITION}
                    onClick={() => setWidth(moveWidth + 1)}
                  >
                    +
                  </button>
                </div>
                <div className="segmented inline">
                  {WIDTHS.map((n) => (
                    <button
                      key={n}
                      type="button"
                      className={n === moveWidth ? "selected" : ""}
                      disabled={running}
                      onClick={() => setWidth(n)}
                    >
                      {n}
                    </button>
                  ))}
                </div>

                <span className="step-rule" aria-hidden="true" />

                <span className="step-label">slide</span>
                <div className="stepper">
                  {/* Ordered as the ladder is: down the price to the left, up it
                      to the right, the bigger step further out. */}
                  {[-10, -1, 1, 10].map((by) => (
                    <button
                      key={by}
                      type="button"
                      className="ghost"
                      aria-label={`${Math.abs(by)} bin${Math.abs(by) === 1 ? "" : "s"} ${by < 0 ? "down" : "up"}`}
                      disabled={running}
                      onClick={() => slide(by)}
                    >
                      {by === -10 ? "◀◀" : by === -1 ? "◀" : by === 1 ? "▶" : "▶▶"}
                    </button>
                  ))}
                </div>
                <button type="button" className="ghost" disabled={running} onClick={centreOnPrice}>
                  centre on price
                </button>
              </div>

              <div className="readout">
                <dt>
                  what moves
                  <Info>
                    Bins in both bands keep their liquidity and their fee checkpoints and never leave
                    the reserve — that is the whole reason to move a band rather than close and reopen
                    it. Bins the move drops are withdrawn to your wallet first, because the program
                    refuses to drop one still holding shares. Bins it adds arrive empty; fill them on
                    the Add tab.
                  </Info>
                </dt>
                <dd className="mono">
                  {movePlan.kept.length} kept
                  <span className="dim">
                    {" · "}
                    {movePlan.leaving.length} emptied · {movePlan.arriving.length} added ·{" "}
                    {movePlan.steps.length || "no"} transaction
                    {movePlan.steps.length === 1 ? "" : "s"}
                  </span>
                </dd>
              </div>

              {!(bundle.pool.activeId >= moveTarget.lower && bundle.pool.activeId <= moveTarget.upper) && (
                <p className="hint warn">
                  The price is outside this band, so nothing in it would trade until the price comes
                  back.
                </p>
              )}

              <div className="actions">
                <button
                  type="button"
                  className="primary"
                  disabled={running || !movePlan.steps.length}
                  onClick={moveBand}
                >
                  {batch.running
                    ? "moving…"
                    : !movePlan.steps.length
                      ? "Band is already here"
                      : /* Named after what the band actually does rather than after a
                           mode, since the target is dragged rather than declared. */
                        `${
                          moveWidth > bandWidth
                            ? "Extend"
                            : moveWidth < bandWidth
                              ? "Shrink"
                              : "Slide"
                        } to ${moveTarget.lower}…${moveTarget.upper}`}
                </button>
              </div>
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
        </div>
      </div>
    </Panel>
  );
}
