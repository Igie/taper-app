/**
 * The deposit form, shared by opening a position and adding to one.
 *
 * Both are the same instruction with the same planner behind them; the only
 * difference is whether the range names a band to open or a stretch of one
 * that exists. So the range is a prop: `New position` hands it an editable
 * band, `Manage → Add` hands it the ladder selection clipped to the position's
 * band and shows it as a readout.
 *
 * **The range is where the liquidity goes, not where the position goes.** A
 * deposit into a few bins of a wide position is one `add_liquidity` over those
 * bins — the band stays where it is, and `planDeposit` matches the stretch to
 * the position that contains it rather than opening a second one over the same
 * bins. The shape is normalised against the stretch, so narrowing the range is
 * a different deposit and not a filtered one: all of what you enter lands in
 * the bins named.
 *
 * Four constraints from the program shape it, and each is enforced here rather
 * than discovered as an error:
 *
 * - A position spans at most `MAX_BINS_PER_POSITION` bins and one transaction
 *   carries fewer still, so a wide band is several positions and several
 *   signatures. `planDeposit` cuts it and `useBatch` signs the pieces in order.
 * - A bin **below** the active bin may only take Y, and one **above** it may
 *   only take X — the active bin itself takes either, which is what makes
 *   "reaches the active bin" the test rather than "crosses it". The shape
 *   already places each token on its own side of the price; `takesX` /
 *   `takesY` ask the same question of the range, and a token the range has
 *   nowhere to put is refused at its own field rather than at the button:
 *   the field empties and disables the moment the range moves off that side.
 *   But it does **not** require both. Funding one side of a band that spans
 *   the price is an ordinary deposit, and the other side's bins simply open
 *   empty.
 * - Bins live in **arrays that must exist first**, and an array is 6,792 bytes
 *   of rent — the largest cost in the plan, and worth knowing before signing.
 *   `planDeposit` rents only the arrays it actually funds, so a one-sided
 *   deposit is quoted one-sided rent.
 * - Wrapped SOL is scratch space, so the SOL side is wrapped per transaction
 *   and the rent ahead is held back from the max button.
 *
 * What each of those *means* lives in a `HoverCard`, not on screen: the form
 * shows the numbers that change the next click and keeps the reasoning one
 * hover away.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import type { PublicKey } from "@solana/web3.js";
import {
  ACCOUNT_LEN,
  ataFor,
  compositionXShare,
  explorerTx,
  involvesSol,
  MAX_BINS_PER_POSITION,
  planDeposit,
  prepareTokens,
  rentFor,
  SHAPES,
  SOL_RESERVE,
  spendable,
  SPOT_BLEND_MAX,
  TX_HEADROOM,
  TX_HEADROOM_NATIVE,
  type BaseAccounts,
  type Shape,
  type TokenAccountState,
  type TokenPair
} from "taper-amm-sdk";
import type { PoolBundle } from "../views/PoolView";
import type { Toast } from "../lib/providers";
import { useCluster } from "../lib/providers";
import { loadBalances } from "../lib/accounts";
import { useBatch } from "../lib/batch";
import { loadPool, missingArrays } from "../lib/data";
import { amount as fmtAmount, exact, price as fmtPrice, toRaw } from "../lib/format";
import { BatchProgress } from "./BatchProgress";
import { Info, Segmented } from "./primitives";

export type Range = { lower: number; upper: number };

export function DepositForm({
  bundle,
  tokens,
  range,
  into,
  onRange,
  editableRange = false,
  onBusyChange,
  onDone,
  push
}: {
  bundle: PoolBundle;
  tokens: TokenPair;
  /**
   * The stretch of bins this deposit fills.
   *
   * A band when the position is being opened, and any stretch of one when it
   * already exists — `Manage → Add` passes the ladder selection clipped to the
   * position's band, so a deposit lands where the chart says it will. The
   * shape is normalised against it, and `takesX` / `takesY` are asked of it,
   * which is what makes a one-sided stretch refuse the token it cannot hold.
   */
  range?: Range;
  /**
   * The position this deposit is aimed at, when there is one.
   *
   * Only an ordering hint, and only needed because a *stretch* can sit inside
   * more than one position when two of them overlap: the planner matches by
   * band and takes the first that contains the range, so the aimed-at one goes
   * to the front. Opening a position passes nothing.
   */
  into?: PublicKey;
  /** Ignored when the band is fixed, so `Add` may pass a no-op. */
  onRange: (range: Range) => void;
  editableRange?: boolean;
  /**
   * Raised while a run is in flight or half-landed.
   *
   * A parent that can unmount this form — the tab strip in `ManagePosition` —
   * has to be able to refuse to, because an unmount would drop the record of
   * which steps already landed and a re-run could deposit twice.
   */
  onBusyChange?: (busy: boolean) => void;
  onDone: () => void;
  push: (toast: Omit<Toast, "id">) => void;
}) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const { cluster } = useCluster();
  const batch = useBatch();
  const [shape, setShape] = useState<Shape>("spot");
  const [spotBlend, setSpotBlend] = useState(0);
  const [amountX, setAmountX] = useState("");
  const [amountY, setAmountY] = useState("");
  const [accounts, setAccounts] = useState<{ states: TokenAccountState[]; lamports: bigint }>();

  const owner = wallet.publicKey;
  const entries = useMemo(
    () => [
      { mint: tokens.mintX, program: tokens.programX },
      { mint: tokens.mintY, program: tokens.programY }
    ],
    [tokens]
  );

  useEffect(() => {
    if (!owner) return setAccounts(undefined);
    let cancelled = false;
    loadBalances(connection, entries, owner)
      .then((state) => !cancelled && setAccounts(state))
      .catch(() => !cancelled && setAccounts(undefined));
    return () => {
      cancelled = true;
    };
  }, [connection, entries, owner, bundle.pool.activeId]);

  /**
   * A sensible default band: a spread around the active bin, inside the config.
   *
   * Held locally rather than written back through `onRange`, because that state
   * is the *ladder selection* and is read by more than this form — `Manage`
   * takes it as the band to move to. Seeding it would stage a move the user
   * never asked for, so an untouched form shows this band and the ladder shows
   * no selection until one is actually made.
   */
  const band = useMemo(() => {
    if (range || !editableRange) return range;
    const half = 10;
    return {
      lower: Math.max(bundle.config.minBinId, bundle.pool.activeId - half),
      upper: Math.min(bundle.config.maxBinId, bundle.pool.activeId + half)
    };
  }, [range, editableRange, bundle.pool.activeId, bundle.config.minBinId, bundle.config.maxBinId]);

  const width = band ? band.upper - band.lower + 1 : 0;
  const activeId = bundle.pool.activeId;
  const native = involvesSol(tokens.mintX, tokens.mintY);

  /*
   * Which of the two tokens this range can hold at all.
   *
   * A bin above the active one may only hold X and one below it only Y, so a
   * band on one side of the price takes exactly one token and a band across it
   * takes either or both. A property of the range, not of the plan or of the
   * amounts — which is why it is answered before either is valid, and why the
   * amount fields can say so before anything is typed.
   *
   * Note what it is not: a requirement to fund both sides. Funding one side of
   * a band that spans the price opens the other side's bins empty, which is an
   * ordinary way to wait for the price to come to you.
   */
  const takesX = band ? band.upper >= activeId : false;
  const takesY = band ? band.lower <= activeId : false;

  /*
   * A range dragged off one side of the price takes that side's amount with
   * it.
   *
   * The refusal has to happen at the field, not at the button: an amount that
   * cannot be deposited is not a form to fix but a range that has moved, and
   * leaving it typed behind a dead button reads as the app being broken. So
   * the unusable field is emptied and disabled, which is the same answer the
   * `wrongSide` guard below gives, given before the number can be entered.
   *
   * Cleared rather than carried, because carrying it is what would let a
   * deposit go out ignoring it. That guard stays as the last defence — nothing
   * should reach it now.
   */
  useEffect(() => {
    if (band && !takesX) setAmountX("");
    if (band && !takesY) setAmountY("");
  }, [band, takesX, takesY]);

  // Room this form needs left in every packet for what it wraps around a step:
  // the compute-budget pair always, and the SOL wrapping when a side of the
  // pair is native. It narrows how many bins one position can carry.
  const headroom = native ? TX_HEADROOM_NATIVE : TX_HEADROOM;

  /**
   * What the active bin already holds, as a fraction of its value in X.
   *
   * The shape splits that one bin's weight by this rather than giving it a full
   * weight on each side, so the deposit lands in the ratio the bin is already
   * in — one bin's worth of liquidity, and no composition fee for a mix the
   * deposit never asked to change. An active bin outside the drawn window, or
   * one the program has never priced, reads as empty and splits evenly, which
   * is what an empty bin would want anyway.
   */
  const activeXShare = useMemo(
    () => compositionXShare(bundle.cells.find((cell) => cell.binId === activeId)),
    [bundle.cells, activeId]
  );

  /**
   * The positions the planner may deposit into, the aimed-at one first.
   *
   * Order is load-bearing only in one case. The match is by band: an exact one
   * wins outright, but a *stretch* can sit inside more than one position when
   * two of them overlap, and `planDeposit` takes the first that contains it.
   * `Manage → Add` is aimed at a position and says which, so it goes to the
   * front and the ambiguity never arises. `New position` passes none and the
   * order stays whatever `getProgramAccounts` returned.
   */
  const existingPositions = useMemo(() => {
    const all = bundle.positions.map((p) => ({
      address: p.address,
      lowerBinId: p.view.lowerBinId,
      upperBinId: p.view.upperBinId,
      capacity: p.view.capacity
    }));
    if (!into) return all;
    const aimed = into.toBase58();
    // Stable, so the rest keep their order: `Array#sort` has been required to
    // be since ES2019 and this only ever lifts one entry.
    return all.sort(
      (a, b) => Number(b.address.toBase58() === aimed) - Number(a.address.toBase58() === aimed)
    );
  }, [bundle.positions, into]);

  const baseAccounts = useMemo(
    (): BaseAccounts | undefined =>
      owner
        ? {
            owner,
            pool: bundle.address,
            config: bundle.configAddress,
            tokens,
            userTokenX: ataFor(tokens.mintX, owner, tokens.programX),
            userTokenY: ataFor(tokens.mintY, owner, tokens.programY),
            reserveX: bundle.pool.reserveX,
            reserveY: bundle.pool.reserveY
          }
        : undefined,
    [bundle.address, bundle.configAddress, bundle.pool.reserveX, bundle.pool.reserveY, owner, tokens]
  );

  const plan = useMemo(() => {
    if (!band || !owner) return undefined;
    if (width < 1) return { error: "The upper bin must not be below the lower one." };
    if (band.lower < bundle.config.minBinId || band.upper > bundle.config.maxBinId) {
      return { error: "That range reaches outside the preset's usable band." };
    }

    let rawX: bigint;
    let rawY: bigint;
    try {
      rawX = toRaw(amountX, bundle.pool.tokenXDecimals);
      rawY = toRaw(amountY, bundle.pool.tokenYDecimals);
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }

    if (!baseAccounts) return undefined;
    const deposit = planDeposit({
      accounts: baseAccounts,
      lower: band.lower,
      upper: band.upper,
      activeId,
      amountX: rawX,
      amountY: rawY,
      shape,
      spotBlendBps: spotBlend,
      activeXShare,
      existingArrays: bundle.cells.filter((c) => c.arrayExists).map((c) => c.arrayIndex),
      // Bands rather than addresses: a position is a keypair account, so the
      // planner matches an existing one to a spec by the band it spans, or by
      // containing it — which is what lets `range` be a stretch of a band the
      // owner already holds instead of a band to open. The capacity rides
      // along so the plan does not schedule `resize_position` no-ops.
      existingPositions,
      headroom
    });

    return {
      deposit,
      rawX,
      rawY,
      funded: deposit.positions.reduce((a, p) => a + p.dist.length, 0)
    };
  }, [
    band,
    owner,
    width,
    bundle,
    baseAccounts,
    activeId,
    amountX,
    amountY,
    shape,
    spotBlend,
    activeXShare,
    existingPositions,
    headroom
  ]);

  const ok = plan && !("error" in plan) ? plan : undefined;

  // Rent this plan will pay, and cannot pay out of a wrapped balance.
  const rentAhead = ok
    ? BigInt(ok.deposit.missingArrays.length) * rentFor(ACCOUNT_LEN.binArray) +
      // From the bytes, not the count: a position is 4,616 bytes plus 64 for
      // every bin past the inline 70, so a wide one costs proportionally more.
      rentFor(ok.deposit.newPositionBytes)
    : 0n;

  const balances = accounts
    ? {
        x: spendable(tokens.mintX, accounts.states[0], accounts.lamports),
        y: spendable(tokens.mintY, accounts.states[1], accounts.lamports),
        maxX: spendable(tokens.mintX, accounts.states[0], accounts.lamports, SOL_RESERVE + rentAhead),
        maxY: spendable(tokens.mintY, accounts.states[1], accounts.lamports, SOL_RESERVE + rentAhead)
      }
    : undefined;
  const overspending = balances && ok && (ok.rawX > balances.x || ok.rawY > balances.y);

  /**
   * An amount offered to a range that has nowhere to put it.
   *
   * The one hard rule the composition guard imposes: X may only land at or
   * above the active bin and Y only at or below it, so a band wholly on one
   * side of the price can take exactly one of the two tokens. Sending the
   * other would fail as `DepositXBelowActiveBin` / `DepositYAboveActiveBin`,
   * and dropping it silently would be worse than refusing it.
   */
  const wrongSide = Boolean(ok && ((ok.rawX > 0n && !takesX) || (ok.rawY > 0n && !takesY)));

  const blocked =
    !owner ||
    !ok ||
    (ok.rawX === 0n && ok.rawY === 0n) ||
    wrongSide ||
    !ok.deposit.steps.length ||
    Boolean(overspending) ||
    bundle.pool.status !== 0;

  /**
   * Signs the plan's transactions in order.
   *
   * The context is the whole of what the runner cannot know: where the active
   * bin is now, which arrays exist now, and how much SOL this particular step
   * needs wrapped. All three are re-read per step, because a plan of five
   * transactions spans enough time for every one of them to have changed.
   */
  const context = useCallback(() => {
    if (!owner || !band) throw new Error("nothing planned");
    return {
      refresh: async () => {
        const [pool, arrays] = await Promise.all([
          loadPool(connection, bundle.address),
          missingArrays(connection, bundle.address, band.lower, band.upper)
        ]);
        const missing = new Set(arrays.missing);
        return {
          existingArrays: new Set(arrays.all.filter((index) => !missing.has(index))),
          activeId: pool.activeId
        };
      },
      exists: async (address: Parameters<typeof connection.getAccountInfo>[0]) =>
        Boolean(await connection.getAccountInfo(address)),
      lengthOf: async (address: Parameters<typeof connection.getAccountInfo>[0]) =>
        (await connection.getAccountInfo(address))?.data.length ?? 0,
      // Wrapped SOL is scratch space closed at the end of every transaction, so
      // each step wraps only what it is about to spend — and the balances are
      // re-read because the previous step already closed the account.
      decorate: async (step: { amountX: bigint; amountY: bigint }) => {
        const fresh = await loadBalances(connection, entries, owner);
        return prepareTokens(owner, [
          {
            mint: tokens.mintX,
            program: tokens.programX,
            state: fresh.states[0],
            needed: step.amountX
          },
          {
            mint: tokens.mintY,
            program: tokens.programY,
            state: fresh.states[1],
            needed: step.amountY
          }
        ]);
      }
    };
  }, [bundle.address, connection, entries, owner, band, tokens]);

  async function deposit() {
    if (!ok || !band) return;
    const result = await batch.run(ok.deposit.steps, context());

    if (result.failed) {
      push({
        kind: "bad",
        label: `Stopped after ${result.completed} of ${ok.deposit.steps.length}`,
        detail: result.failed.detail
      });
    } else {
      push({
        kind: "ok",
        label: ok.deposit.newPositions ? "Position opened" : "Liquidity added",
        detail:
          `bins ${band.lower}–${band.upper}, ${ok.funded} funded across ` +
          `${ok.deposit.positions.length} position${ok.deposit.positions.length === 1 ? "" : "s"}`
      });
      setAmountX("");
      setAmountY("");
      batch.reset();
    }
    onDone();
  }

  const multi = (ok?.deposit.steps.length ?? 0) > 1;
  const retrying = batch.statuses.some((s) => s.state === "failed" || s.state === "unknown");

  /**
   * A run that landed some of its transactions and not the rest.
   *
   * While one is outstanding the inputs are locked, and that is a correctness
   * guard rather than tidiness: a step that only *adds* to a position which
   * already existed leaves no witness, so if the plan were edited and re-run
   * the runner would have no way to tell that step had already landed, and
   * would deposit twice. Resume finishes the plan as built; Discard abandons
   * it, and says plainly that what already landed stays.
   */
  const settled = (s: { state: string }) => s.state === "done" || s.state === "skipped";
  const outstanding =
    batch.statuses.some(settled) && batch.statuses.some((s) => !settled(s)) && !batch.running;
  const locked = outstanding || batch.running;
  const resuming = (outstanding || retrying) && !batch.running;

  useEffect(() => {
    onBusyChange?.(locked);
  }, [locked, onBusyChange]);

  return (
    <>
      {band && editableRange && (
        <div className="range-row">
          <label className="field">
            <span>
              lower bin
              <Info>
                Bins are the ladder's own numbering, not a price. Drag across the chart above to set
                both edges at once.
              </Info>
            </span>
            <input
              className="mono"
              type="number"
              value={band.lower}
              disabled={locked}
              onChange={(e) => onRange({ lower: Number(e.target.value), upper: band.upper })}
            />
          </label>
          <label className="field">
            <span>upper bin</span>
            <input
              className="mono"
              type="number"
              value={band.upper}
              disabled={locked}
              onChange={(e) => onRange({ lower: band.lower, upper: Number(e.target.value) })}
            />
          </label>
          <div className="field">
            <span>price range</span>
            <strong className="mono">
              {fmtPrice(bundle.ladder.price(band.lower) * bundle.scale)} –{" "}
              {fmtPrice(bundle.ladder.price(band.upper) * bundle.scale)}
            </strong>
          </div>
        </div>
      )}

      {band && !editableRange && (
        <div className="readout">
          <dt>band</dt>
          <dd className="mono">
            {band.lower} – {band.upper}
            <span className="dim"> · {width} bins</span>
          </dd>
          <dt>price range</dt>
          <dd className="mono">
            {fmtPrice(bundle.ladder.price(band.lower) * bundle.scale)} –{" "}
            {fmtPrice(bundle.ladder.price(band.upper) * bundle.scale)}
          </dd>
        </div>
      )}

      <Segmented value={shape} options={SHAPES} onChange={setShape} />

      {/*
        Curve and bid-ask are shapes to lean towards, not presets to pick. The
        slider mixes the chosen one with a flat spread: at 100% the deposit is
        spot whichever shape is selected, so a user who wants "mostly bid-ask,
        but keep some depth at the active bin" says so here rather than editing
        the bps table by hand.
      */}
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
            onChange={(e) => setSpotBlend(Number(e.target.value))}
          />
        </label>
      )}

      {/*
        Both fields stay, and the one the range cannot hold says so rather than
        vanishing: a field that disappears when the band is dragged past the
        price reads as a bug, and the note explains the refusal below.
      */}
      <div className="range-row">
        <label className={`field ${band && !takesX ? "unusable" : ""}`} htmlFor="deposit-x">
          <span>
            {bundle.x.symbol}
            {band && !takesX && <em>not in this range</em>}
            {balances && takesX && (
              <button
                type="button"
                className="link"
                onClick={() => setAmountX(exact(balances.maxX, bundle.pool.tokenXDecimals))}
              >
                {fmtAmount(balances.x, bundle.pool.tokenXDecimals, 4)}
              </button>
            )}
          </span>
          <input
            id="deposit-x"
            className="mono"
            inputMode="decimal"
            placeholder={band && !takesX ? "—" : "0.0"}
            value={amountX}
            disabled={locked || Boolean(band && !takesX)}
            onChange={(e) => setAmountX(e.target.value.replace(/[^\d.]/g, ""))}
          />
        </label>
        <label className={`field ${band && !takesY ? "unusable" : ""}`} htmlFor="deposit-y">
          <span>
            {bundle.y.symbol}
            {band && !takesY && <em>not in this range</em>}
            {balances && takesY && (
              <button
                type="button"
                className="link"
                onClick={() => setAmountY(exact(balances.maxY, bundle.pool.tokenYDecimals))}
              >
                {fmtAmount(balances.y, bundle.pool.tokenYDecimals, 4)}
              </button>
            )}
          </span>
          <input
            id="deposit-y"
            className="mono"
            inputMode="decimal"
            placeholder={band && !takesY ? "—" : "0.0"}
            value={amountY}
            disabled={locked || Boolean(band && !takesY)}
            onChange={(e) => setAmountY(e.target.value.replace(/[^\d.]/g, ""))}
          />
        </label>
      </div>

      {plan && "error" in plan && <p className="error">{plan.error}</p>}

      {ok && (
        <>
          <div className="readout">
            <dt>bins funded</dt>
            <dd className="mono">
              {ok.funded} of {width}
            </dd>
            <dt>
              transactions
              {multi && (
                <Info>
                  This band is {ok.deposit.positions.length} positions of at most{" "}
                  {ok.deposit.maxWidth} bins, so it takes {ok.deposit.steps.length} signatures. They
                  are not atomic: if one is rejected the ones before it stay, and the button resumes
                  from where it stopped rather than starting over.
                  {ok.deposit.maxWidth < MAX_BINS_PER_POSITION && (
                    <>
                      {" "}
                      The program allows {MAX_BINS_PER_POSITION} bins per position; the lower figure
                      is what fits in one transaction once the compute limit
                      {native ? " and the SOL wrapping are" : " is"} counted.
                    </>
                  )}
                </Info>
              )}
            </dt>
            <dd className="mono">
              {ok.deposit.steps.length}
              {ok.deposit.positions.length > 1 && (
                <span className="dim"> · {ok.deposit.positions.length} positions</span>
              )}
            </dd>
            {rentAhead > 0n && (
              <>
                <dt>
                  rent
                  <Info>
                    {ok.deposit.missingArrays.length > 0 && (
                      <>
                        {ok.deposit.missingArrays.length} bin array
                        {ok.deposit.missingArrays.length === 1 ? "" : "s"} will be created, each 6,792
                        bytes of rent and refundable only by closing it — this is the cost the taper
                        is designed to reduce at low prices.{" "}
                      </>
                    )}
                    {ok.deposit.newPositions > 0 && (
                      <>
                        Rent for {ok.deposit.newPositions} position
                        {ok.deposit.newPositions === 1 ? "" : "s"} (
                        {ok.deposit.newPositionBytes.toLocaleString()} bytes) comes back when they
                        close.
                      </>
                    )}
                  </Info>
                </dt>
                <dd className="mono">
                  ≈{fmtAmount(rentAhead, 9, 4)} SOL
                  {ok.deposit.missingArrays.length > 0 && (
                    <span className="warn"> · {ok.deposit.missingArrays.length} new arrays</span>
                  )}
                </dd>
              </>
            )}
          </div>

          {/*
            Two different things, deliberately styled differently. A token the
            range cannot hold is a refusal — stated as a fact about the range,
            because by here its field is already empty and disabled. A side
            left unfunded is a choice, and a common one: you fund the side the
            price has to cross to reach you, and the other side's bins wait
            empty.
          */}
          {/*
            The range sits inside a position the wallet already holds, so the
            planner fills that one rather than opening a second over the same
            bins — two positions in one stretch pay two rents and split the
            band's fees across two accounts. The button already says "Add
            liquidity"; this says which position it means.
          */}
          {editableRange && ok.deposit.newPositions === 0 && ok.deposit.positions.length > 0 && (
            <p className="hint">
              This range is inside a position you already hold, so it is added to that one rather
              than opening a second position over the same bins.
            </p>
          )}
          {!takesY && (
            <p className="hint warn">
              Every bin in this range is above the active bin, so it can hold only{" "}
              {bundle.x.symbol}. Drag the range down over the price to deposit {bundle.y.symbol}.
            </p>
          )}
          {!takesX && (
            <p className="hint warn">
              Every bin in this range is below the active bin, so it can hold only{" "}
              {bundle.y.symbol}. Drag the range up over the price to deposit {bundle.x.symbol}.
            </p>
          )}
          {takesX && takesY && ok.rawX === 0n && ok.rawY > 0n && (
            <p className="hint">
              One-sided: only the bins at and below the active bin are funded. The{" "}
              {bundle.x.symbol} side of the range opens empty and can be filled later, or when the
              price rises through it.
            </p>
          )}
          {takesX && takesY && ok.rawY === 0n && ok.rawX > 0n && (
            <p className="hint">
              One-sided: only the bins at and above the active bin are funded. The{" "}
              {bundle.y.symbol} side of the range opens empty and can be filled later, or when the
              price falls through it.
            </p>
          )}
          {overspending && <p className="hint warn">That is more than you hold.</p>}
          {band && band.lower <= activeId && band.upper >= activeId && (
            <p className="hint">
              Spans the active bin — {Math.round(activeXShare * 100)}% {bundle.x.symbol} by value.
              <Info>
                The active bin is the only one that holds both tokens, so it is the only one where a
                deposit can shift the mix — and shifting it pays a composition fee at that bin's own
                swap rate, because it is the work of a swap. Its share of this deposit is split in
                the ratio shown, so it takes one bin's worth of liquidity in the mix it is already
                in. What is left of the fee is whatever your two amounts are out of balance by.
              </Info>
            </p>
          )}
        </>
      )}

      <BatchProgress
        statuses={batch.statuses}
        explorer={(signature) => explorerTx(cluster, signature)}
      />

      {outstanding && (
        <p className="hint warn">
          Part of this plan has landed; the inputs stay locked until you finish or discard it.
          <Info>
            Editing now could re-send a deposit that already went through, because a step that only
            adds to a position you already held leaves nothing on chain to check against.
          </Info>
        </p>
      )}

      <div className="actions">
        <button
          type="button"
          className="primary"
          disabled={(blocked && !locked) || batch.running}
          onClick={deposit}
        >
          {batch.running
            ? "depositing…"
            : resuming
              ? "Resume"
              : ok?.deposit.newPositions === 0
                ? "Add liquidity"
                : `Open position${multi ? "s" : ""}`}
        </button>

        {resuming && !batch.running && (
          <button type="button" onClick={batch.reset} title="Whatever already landed stays on chain.">
            Discard
          </button>
        )}

        {native && (
          <span className="hint">
            paid in SOL
            <Info>
              The SOL side is wrapped for each transaction and unwrapped again at the end of it, so
              the balance above counts your unwrapped SOL and the change comes back as SOL. Rent for
              each position and any bin arrays is paid in SOL too, which is why the max button stops
              short of the balance.
            </Info>
          </span>
        )}
        {!owner && <span className="hint">Connect a wallet to provide liquidity.</span>}
        {bundle.pool.status !== 0 && <span className="hint warn">This pool is disabled.</span>}
      </div>
    </>
  );
}
