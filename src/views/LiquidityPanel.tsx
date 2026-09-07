/**
 * Opening a position and depositing into it.
 *
 * Three constraints from the program shape this panel, and each is enforced
 * here rather than discovered as an error:
 *
 * - A position is a **fixed-width PDA** seeded with its lower bin and width,
 *   so the range is chosen once and cannot be resized afterwards. Changing it
 *   means a new position.
 * - A bin **below** the active bin may only take Y, and one **above** it may
 *   only take X. `distribute` already respects that; the preview shows it.
 * - Bins live in **arrays that must exist first**, and an array is 6,792 bytes
 *   of rent. Which ones are missing is the most useful thing to know before
 *   committing, so it is stated before the button.
 */
import { useEffect, useMemo, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import {
  ACCOUNT_LEN,
  MAX_BINS_PER_POSITION,
  SHAPES,
  addLiquidityIx,
  arrayIndexesFor,
  binArrayPda,
  distribute,
  initializeBinArrayIx,
  initializePositionIx,
  positionPda,
  preview,
  type Shape,
  type TokenPair
} from "@taper/sdk";
import type { PoolBundle } from "./PoolView";
import type { Toast } from "../lib/providers";
import { loadBalances, type TokenAccountState } from "../lib/accounts";
import { involvesSol, prepareTokens, rentFor, spendable, SOL_RESERVE } from "../lib/native";
import { amount as fmtAmount, exact, price as fmtPrice, toRaw } from "../lib/format";
import { send, TxFailure } from "../lib/tx";
import { Panel, Segmented } from "../components/primitives";

export function LiquidityPanel({
  bundle,
  tokens,
  range,
  onRange,
  onDone,
  push
}: {
  bundle: PoolBundle;
  tokens: TokenPair;
  range?: { lower: number; upper: number };
  onRange: (range: { lower: number; upper: number }) => void;
  onDone: () => void;
  push: (toast: Omit<Toast, "id">) => void;
}) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const [shape, setShape] = useState<Shape>("spot");
  const [amountX, setAmountX] = useState("");
  const [amountY, setAmountY] = useState("");
  const [busy, setBusy] = useState(false);
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

  // A sensible default range: a band around the active bin, inside the config.
  useEffect(() => {
    if (range) return;
    const half = 10;
    onRange({
      lower: Math.max(bundle.config.minBinId, bundle.pool.activeId - half),
      upper: Math.min(bundle.config.maxBinId, bundle.pool.activeId + half)
    });
  }, [range, onRange, bundle.pool.activeId, bundle.config.minBinId, bundle.config.maxBinId]);

  const width = range ? range.upper - range.lower + 1 : 0;

  const plan = useMemo(() => {
    if (!range || !owner) return undefined;
    if (width < 1 || width > MAX_BINS_PER_POSITION) {
      return { error: `A position spans 1 to ${MAX_BINS_PER_POSITION} bins; this one is ${width}.` };
    }
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

    const dist = distribute(range.lower, range.upper, bundle.pool.activeId, shape);
    const rows = preview(dist, rawX, rawY);
    const needsX = dist.some((d) => d.distributionX > 0);
    const needsY = dist.some((d) => d.distributionY > 0);

    const arrays = arrayIndexesFor(range.lower, range.upper);
    const existing = new Set(bundle.cells.filter((c) => c.arrayExists).map((c) => c.arrayIndex));
    const missing = arrays.filter((index) => !existing.has(index));

    const position = positionPda(bundle.address, owner, range.lower, width);

    return { dist, rows, rawX, rawY, arrays, missing, position, needsX, needsY };
  }, [range, owner, width, bundle, amountX, amountY, shape]);

  const existingPosition = bundle.positions.find(
    (p) => plan && !("error" in plan) && p.address.equals(plan.position)
  );

  // The SOL side of a pair can spend unwrapped lamports as well as whatever is
  // already wrapped, so its ceiling is the two together. What the max button
  // offers is lower again: this transaction may also rent bin arrays and a
  // position, and rent cannot be paid out of a wrapped balance.
  const rentAhead =
    plan && !("error" in plan)
      ? BigInt(plan.missing.length) * rentFor(ACCOUNT_LEN.binArray) +
        (existingPosition ? 0n : rentFor(ACCOUNT_LEN.position))
      : 0n;
  const balances = accounts
    ? {
        x: spendable(tokens.mintX, accounts.states[0], accounts.lamports),
        y: spendable(tokens.mintY, accounts.states[1], accounts.lamports),
        maxX: spendable(tokens.mintX, accounts.states[0], accounts.lamports, SOL_RESERVE + rentAhead),
        maxY: spendable(tokens.mintY, accounts.states[1], accounts.lamports, SOL_RESERVE + rentAhead)
      }
    : undefined;
  const overspending =
    balances && plan && !("error" in plan) && (plan.rawX > balances.x || plan.rawY > balances.y);

  const blocked =
    !owner ||
    !plan ||
    "error" in plan ||
    (plan.rawX === 0n && plan.rawY === 0n) ||
    (plan.needsX && plan.rawX === 0n) ||
    (plan.needsY && plan.rawY === 0n) ||
    Boolean(overspending) ||
    bundle.pool.status !== 0;

  async function deposit() {
    if (!owner || !plan || "error" in plan || !accounts || !range) return;
    setBusy(true);
    try {
      const [xState, yState] = accounts.states;
      // Creates whatever is missing and wraps the SOL side, if there is one.
      const { before, after } = prepareTokens(owner, [
        { mint: tokens.mintX, program: tokens.programX, state: xState, needed: plan.rawX },
        { mint: tokens.mintY, program: tokens.programY, state: yState, needed: plan.rawY }
      ]);
      const instructions = [
        ...before,
        // Rent the arrays the range needs before anything tries to write to them.
        ...plan.missing.map((index) =>
          initializeBinArrayIx(owner, bundle.address, bundle.configAddress, index)
        )
      ];
      if (!existingPosition) {
        instructions.push(
          initializePositionIx(owner, bundle.address, bundle.configAddress, range.lower, width)
        );
      }
      instructions.push(
        addLiquidityIx(
          {
            owner,
            position: plan.position,
            pool: bundle.address,
            config: bundle.configAddress,
            tokens,
            userTokenX: xState.address,
            userTokenY: yState.address,
            reserveX: bundle.pool.reserveX,
            reserveY: bundle.pool.reserveY,
            binArrays: plan.arrays.map((index) => binArrayPda(bundle.address, index))
          },
          plan.rawX,
          plan.rawY,
          plan.dist
        )
      );
      // Unwrapping last returns the change: a deposit is quoted per bin and
      // rounds down, so a little of what was wrapped is usually left over.
      instructions.push(...after);

      const signature = await send(connection, wallet, instructions, { computeUnits: 1_400_000 });
      push({
        kind: "ok",
        label: existingPosition ? "Liquidity added" : "Position opened",
        detail: `bins ${range.lower}–${range.upper}, ${plan.dist.length} funded${
          plan.missing.length ? `, ${plan.missing.length} bin array(s) created` : ""
        }`,
        signature
      });
      setAmountX("");
      setAmountY("");
      onDone();
    } catch (error) {
      const failure = error as TxFailure;
      push({ kind: "bad", label: "Deposit failed", detail: failure.message, logs: failure.logs });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title={existingPosition ? "Add liquidity" : "Open a position"}>
      {range && (
        <div className="range-row">
          <label className="field">
            <span>lower bin</span>
            <input
              className="mono"
              type="number"
              value={range.lower}
              onChange={(e) => onRange({ lower: Number(e.target.value), upper: range.upper })}
            />
          </label>
          <label className="field">
            <span>upper bin</span>
            <input
              className="mono"
              type="number"
              value={range.upper}
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

      <Segmented value={shape} options={SHAPES} onChange={setShape} />

      <div className="range-row">
        <label className="field">
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
            className="mono"
            inputMode="decimal"
            placeholder="0.0"
            value={amountX}
            onChange={(e) => setAmountX(e.target.value.replace(/[^\d.]/g, ""))}
          />
        </label>
        <label className="field">
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
            className="mono"
            inputMode="decimal"
            placeholder="0.0"
            value={amountY}
            onChange={(e) => setAmountY(e.target.value.replace(/[^\d.]/g, ""))}
          />
        </label>
      </div>

      {plan && "error" in plan && <p className="error">{plan.error}</p>}

      {plan && !("error" in plan) && (
        <>
          <div className="readout">
            <dt>bins funded</dt>
            <dd className="mono">
              {plan.dist.length} of {width}
            </dd>
            <dt>bin arrays</dt>
            <dd className="mono">
              {plan.arrays.length} needed
              {plan.missing.length > 0 && (
                <span className="warn"> · {plan.missing.length} to create</span>
              )}
            </dd>
            <dt>position</dt>
            <dd className="mono">{existingPosition ? "already open" : "will be created"}</dd>
          </div>

          {plan.needsX && plan.rawX === 0n && (
            <p className="hint warn">
              This range reaches above the active bin, so it needs {bundle.x.symbol}. Bins above the active
              one can only hold X.
            </p>
          )}
          {plan.needsY && plan.rawY === 0n && (
            <p className="hint warn">
              This range reaches below the active bin, so it needs {bundle.y.symbol}. Bins below the active
              one can only hold Y.
            </p>
          )}
          {overspending && <p className="hint warn">That is more than you hold.</p>}
          {involvesSol(tokens.mintX, tokens.mintY) && (
            <p className="hint">
              The SOL side is wrapped by this transaction and unwrapped again at the end of it, so the balance
              above counts your unwrapped SOL and the change comes back as SOL. Rent for the position and any
              bin arrays is paid in SOL too, which is why the max button stops short of the balance.
            </p>
          )}
          {plan.missing.length > 0 && (
            <p className="hint">
              {plan.missing.length} bin array{plan.missing.length === 1 ? "" : "s"} will be created and paid
              for by this transaction. Each is 6,792 bytes of rent, refundable only by closing it — this is
              the cost the taper is designed to reduce at low prices.
            </p>
          )}
          {range && range.lower <= bundle.pool.activeId && range.upper >= bundle.pool.activeId && (
            <p className="hint">
              This range spans the active bin. A deposit that shifts the active bin's X/Y mix pays a
              composition fee, at that bin's own swap rate.
            </p>
          )}
        </>
      )}

      <div className="actions">
        <button type="button" className="primary" disabled={blocked || busy} onClick={deposit}>
          {busy ? "depositing…" : existingPosition ? "Add liquidity" : "Open position"}
        </button>
        {!owner && <span className="hint">Connect a wallet to provide liquidity.</span>}
      </div>
    </Panel>
  );
}
