/**
 * The deposit form, shared by opening a position and adding to one.
 *
 * Both are the same instruction with the same planner behind them; the only
 * difference is whether the band is a choice or a fact. So the band is a prop:
 * `New position` hands it an editable range, `Manage → Add` hands it the band
 * the position already spans and shows it as a readout.
 *
 * Four constraints from the program shape it, and each is enforced here rather
 * than discovered as an error:
 *
 * - A position spans at most `MAX_BINS_PER_POSITION` bins and one transaction
 *   carries fewer still, so a wide band is several positions and several
 *   signatures. `planDeposit` cuts it and `useBatch` signs the pieces in order.
 * - A bin **below** the active bin may only take Y, and one **above** it may
 *   only take X. The shape already respects that; the preview says so.
 * - Bins live in **arrays that must exist first**, and an array is 6,792 bytes
 *   of rent — the largest cost in the plan, and worth knowing before signing.
 * - Wrapped SOL is scratch space, so the SOL side is wrapped per transaction
 *   and the rent ahead is held back from the max button.
 *
 * What each of those *means* lives in a `HoverCard`, not on screen: the form
 * shows the numbers that change the next click and keeps the reasoning one
 * hover away.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import {
  ACCOUNT_LEN,
  ataFor,
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
} from "@taper/sdk";
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
  onRange,
  editableRange = false,
  onBusyChange,
  onDone,
  push
}: {
  bundle: PoolBundle;
  tokens: TokenPair;
  range?: Range;
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

  // A sensible default band: a spread around the active bin, inside the config.
  // Only when the band is the user's to choose — a fixed one is already given.
  useEffect(() => {
    if (range || !editableRange) return;
    const half = 10;
    onRange({
      lower: Math.max(bundle.config.minBinId, bundle.pool.activeId - half),
      upper: Math.min(bundle.config.maxBinId, bundle.pool.activeId + half)
    });
  }, [
    range,
    editableRange,
    onRange,
    bundle.pool.activeId,
    bundle.config.minBinId,
    bundle.config.maxBinId
  ]);

  const width = range ? range.upper - range.lower + 1 : 0;
  const activeId = bundle.pool.activeId;
  const native = involvesSol(tokens.mintX, tokens.mintY);

  // Room this form needs left in every packet for what it wraps around a step:
  // the compute-budget pair always, and the SOL wrapping when a side of the
  // pair is native. It narrows how many bins one position can carry.
  const headroom = native ? TX_HEADROOM_NATIVE : TX_HEADROOM;

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
    if (!range || !owner) return undefined;
    if (width < 1) return { error: "The upper bin must not be below the lower one." };
    if (range.lower < bundle.config.minBinId || range.upper > bundle.config.maxBinId) {
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
      lower: range.lower,
      upper: range.upper,
      activeId,
      amountX: rawX,
      amountY: rawY,
      shape,
      spotBlendBps: spotBlend,
      existingArrays: bundle.cells.filter((c) => c.arrayExists).map((c) => c.arrayIndex),
      // Bands rather than addresses: a position is a keypair account, so the
      // planner matches an existing one to a spec by the band it spans. The
      // capacity rides along so the plan does not schedule `resize_position`
      // calls that would be no-ops.
      existingPositions: bundle.positions.map((p) => ({
        address: p.address,
        lowerBinId: p.view.lowerBinId,
        upperBinId: p.view.upperBinId,
        capacity: p.view.capacity
      })),
      headroom
    });

    // Which sides the *range* needs, not which the plan funded: a range
    // reaching above the active bin needs X even when the user has typed no X
    // yet, and that is exactly the moment to say so.
    return {
      deposit,
      rawX,
      rawY,
      needsX: range.upper >= activeId,
      needsY: range.lower <= activeId,
      funded: deposit.positions.reduce((a, p) => a + p.dist.length, 0)
    };
  }, [
    range,
    owner,
    width,
    bundle,
    baseAccounts,
    activeId,
    amountX,
    amountY,
    shape,
    spotBlend,
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

  const blocked =
    !owner ||
    !ok ||
    (ok.rawX === 0n && ok.rawY === 0n) ||
    (ok.needsX && ok.rawX === 0n) ||
    (ok.needsY && ok.rawY === 0n) ||
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
    if (!owner || !range) throw new Error("nothing planned");
    return {
      refresh: async () => {
        const [pool, arrays] = await Promise.all([
          loadPool(connection, bundle.address),
          missingArrays(connection, bundle.address, range.lower, range.upper)
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
  }, [bundle.address, connection, entries, owner, range, tokens]);

  async function deposit() {
    if (!ok || !range) return;
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
          `bins ${range.lower}–${range.upper}, ${ok.funded} funded across ` +
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
      {range && editableRange && (
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
              value={range.lower}
              disabled={locked}
              onChange={(e) => onRange({ lower: Number(e.target.value), upper: range.upper })}
            />
          </label>
          <label className="field">
            <span>upper bin</span>
            <input
              className="mono"
              type="number"
              value={range.upper}
              disabled={locked}
              onChange={(e) => onRange({ lower: range.lower, upper: Number(e.target.value) })}
            />
          </label>
          <div className="field">
            <span>price range</span>
            <strong className="mono">
              {fmtPrice(bundle.ladder.price(range.lower) * bundle.scale)} –{" "}
              {fmtPrice(bundle.ladder.price(range.upper) * bundle.scale)}
            </strong>
          </div>
        </div>
      )}

      {range && !editableRange && (
        <div className="readout">
          <dt>band</dt>
          <dd className="mono">
            {range.lower} – {range.upper}
            <span className="dim"> · {width} bins</span>
          </dd>
          <dt>price range</dt>
          <dd className="mono">
            {fmtPrice(bundle.ladder.price(range.lower) * bundle.scale)} –{" "}
            {fmtPrice(bundle.ladder.price(range.upper) * bundle.scale)}
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

      <div className="range-row">
        <label className="field" htmlFor="deposit-x">
          <span>
            {bundle.x.symbol}
            {balances && (
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
            placeholder="0.0"
            value={amountX}
            disabled={locked}
            onChange={(e) => setAmountX(e.target.value.replace(/[^\d.]/g, ""))}
          />
        </label>
        <label className="field" htmlFor="deposit-y">
          <span>
            {bundle.y.symbol}
            {balances && (
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
            placeholder="0.0"
            value={amountY}
            disabled={locked}
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

          {ok.needsX && ok.rawX === 0n && (
            <p className="hint warn">
              This range reaches above the active bin, so it needs {bundle.x.symbol} — bins above the
              active one can only hold X.
            </p>
          )}
          {ok.needsY && ok.rawY === 0n && (
            <p className="hint warn">
              This range reaches below the active bin, so it needs {bundle.y.symbol} — bins below the
              active one can only hold Y.
            </p>
          )}
          {overspending && <p className="hint warn">That is more than you hold.</p>}
          {range && range.lower <= activeId && range.upper >= activeId && (
            <p className="hint">
              Spans the active bin.
              <Info>
                A deposit that shifts the active bin's X/Y mix pays a composition fee, at that bin's
                own swap rate.
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
