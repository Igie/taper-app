/**
 * Swapping.
 *
 * The quote is not decoration. `min_amount_out` is the only protection a
 * trader has, and the program checks it against what reaches their wallet —
 * so the number sent is the quote, less the output mint's transfer fee, less
 * the slippage tolerance, in that order. Getting that order wrong on a
 * fee-bearing mint produces a bound that can never be met.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import {
  amountAfterTransferFee,
  binArrayPda,
  involvesSol,
  minOutFor,
  prepareTokens,
  quoteSwap,
  SOL_RESERVE,
  spendable,
  swapArrayIndexes,
  swapIx,
  type BinView,
  type TokenAccountState,
  type TokenPair
} from "taper-amm-sdk";
import type { PoolBundle } from "./PoolView";
import type { Toast } from "../lib/providers";
import { loadBalances } from "../lib/accounts";
import { amount as fmtAmount, exact, price as fmtPrice, toRaw } from "../lib/format";
import { send, TxFailure } from "../lib/tx";
import { Info, Panel, Segmented } from "../components/primitives";

export function SwapPanel({
  bundle,
  tokens,
  header,
  onBusyChange,
  onDone,
  push
}: {
  bundle: PoolBundle;
  tokens: TokenPair;
  /** The pool page's view picker, which stands in for this panel's title. */
  header?: ReactNode;
  /** Raised while a signature is in flight, so the picker refuses to unmount us. */
  onBusyChange?: (busy: boolean) => void;
  onDone: () => void;
  push: (toast: Omit<Toast, "id">) => void;
}) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const [swapForY, setSwapForY] = useState(true);
  const [input, setInput] = useState("");
  const [slippageBps, setSlippageBps] = useState(50);
  const [busy, setBusy] = useState(false);
  const [accounts, setAccounts] = useState<{ states: TokenAccountState[]; lamports: bigint }>();

  useEffect(() => {
    onBusyChange?.(busy);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);

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

  const inToken = swapForY ? bundle.x : bundle.y;
  const outToken = swapForY ? bundle.y : bundle.x;
  const inDecimals = swapForY ? bundle.pool.tokenXDecimals : bundle.pool.tokenYDecimals;
  const outDecimals = swapForY ? bundle.pool.tokenYDecimals : bundle.pool.tokenXDecimals;
  const inMint = swapForY ? tokens.mintX : tokens.mintY;
  // Paying in SOL spends lamports too: they are wrapped by this transaction.
  const inBalance = accounts
    ? spendable(inMint, swapForY ? accounts.states[0] : accounts.states[1], accounts.lamports)
    : undefined;
  const inMax = accounts
    ? spendable(inMint, swapForY ? accounts.states[0] : accounts.states[1], accounts.lamports, SOL_RESERVE)
    : undefined;

  const existingArrays = useMemo(() => {
    const set = new Set<number>();
    for (const cell of bundle.cells) if (cell.arrayExists) set.add(cell.arrayIndex);
    return set;
  }, [bundle.cells]);

  const arrayIndexes = useMemo(
    () => swapArrayIndexes(bundle.pool.activeId, swapForY, (i) => existingArrays.has(i)),
    [bundle.pool.activeId, swapForY, existingArrays]
  );

  const bins = useMemo(() => {
    const map = new Map<number, BinView>();
    for (const cell of bundle.cells) map.set(cell.binId, cell);
    return map;
  }, [bundle.cells]);

  const quote = useMemo(() => {
    let raw: bigint;
    try {
      raw = toRaw(input, inDecimals);
    } catch {
      return undefined;
    }
    if (raw <= 0n) return undefined;

    const carried = new Set(arrayIndexes);
    // The walk is budgeted in what reaches the reserve, not what leaves the
    // wallet: a transfer-fee mint delivers less than it is sent.
    const budget = amountAfterTransferFee(inToken, raw);
    const result = quoteSwap({
      pool: bundle.pool,
      config: bundle.config,
      bins,
      hasArray: (index) => carried.has(index),
      amountIn: budget,
      swapForY,
      now: Math.floor(Date.now() / 1000)
    });

    // What the trader actually receives, after the output mint's own fee.
    const received = amountAfterTransferFee(outToken, result.amountOut);
    return { sent: raw, budget, result, received, minOut: minOutFor(received, slippageBps) };
  }, [input, inDecimals, arrayIndexes, inToken, outToken, bundle.pool, bundle.config, bins, swapForY, slippageBps]);

  const noLiquidity = arrayIndexes.length === 0;
  const blocked =
    !owner ||
    !quote ||
    quote.result.amountOut === 0n ||
    noLiquidity ||
    bundle.pool.status !== 0 ||
    (inBalance !== undefined && quote.sent > inBalance);

  async function doSwap() {
    if (!owner || !quote || !accounts) return;
    setBusy(true);
    try {
      const [xState, yState] = accounts.states;
      // The side being sold has to be funded — wrapped, if it is SOL — and the
      // side being bought only has to exist. Either, being SOL, is unwrapped
      // again once the swap has paid into it.
      const { before, after } = prepareTokens(owner, [
        {
          mint: tokens.mintX,
          program: tokens.programX,
          state: xState,
          needed: swapForY ? quote.sent : 0n
        },
        {
          mint: tokens.mintY,
          program: tokens.programY,
          state: yState,
          needed: swapForY ? 0n : quote.sent
        }
      ]);

      const signature = await send(
        connection,
        wallet,
        [
          ...before,
          swapIx(
            owner,
            bundle.address,
            bundle.configAddress,
            tokens,
            swapForY ? xState.address : yState.address,
            swapForY ? yState.address : xState.address,
            bundle.pool.reserveX,
            bundle.pool.reserveY,
            arrayIndexes.map((index) => binArrayPda(bundle.address, index)),
            quote.sent,
            quote.minOut,
            swapForY
          ),
          ...after
        ],
        // Each bin crossed re-derives a price; a long walk is the expensive case.
        { computeUnits: 1_000_000 }
      );

      push({
        kind: "ok",
        label: `Swapped ${inToken.symbol} → ${outToken.symbol}`,
        detail: `${fmtAmount(quote.result.amountIn, inDecimals)} in, ${fmtAmount(
          quote.received,
          outDecimals
        )} out across ${quote.result.binsCrossed} bin${quote.result.binsCrossed === 1 ? "" : "s"}`,
        signature
      });
      setInput("");
      onDone();
    } catch (error) {
      const failure = error as TxFailure;
      push({ kind: "bad", label: "Swap failed", detail: failure.message, logs: failure.logs });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="Swap" header={header}>
      <Segmented
        value={swapForY ? "xy" : "yx"}
        options={[
          { id: "xy", label: `${bundle.x.symbol} → ${bundle.y.symbol}`, hint: "walks the ladder down" },
          { id: "yx", label: `${bundle.y.symbol} → ${bundle.x.symbol}`, hint: "walks the ladder up" }
        ]}
        onChange={(id) => setSwapForY(id === "xy")}
      />

      <label className="field wide" htmlFor="swap-pay">
        <span>
          You pay ({inToken.symbol})
          {inBalance !== undefined && (
            <button
              type="button"
              className="link"
              onClick={() => setInput(exact(inMax ?? inBalance, inDecimals))}
            >
              balance {fmtAmount(inBalance, inDecimals, 4)}
            </button>
          )}
        </span>
        <input
          id="swap-pay"
          className="mono"
          inputMode="decimal"
          placeholder="0.0"
          value={input}
          onChange={(e) => setInput(e.target.value.replace(/[^\d.]/g, ""))}
        />
      </label>

      {/*
        A div, not a label: <button> is labelable, so a wrapping <label> adopts
        the first chip as its control and browsers forward the label's hover
        and caption clicks to it — 0.1% lit up wherever the cursor went.
      */}
      <div className="field wide">
        <span>Slippage tolerance</span>
        <div className="segmented inline">
          {[10, 50, 100, 500].map((bps) => (
            <button
              key={bps}
              type="button"
              className={bps === slippageBps ? "selected" : ""}
              onClick={() => setSlippageBps(bps)}
            >
              {bps / 100}%
            </button>
          ))}
        </div>
      </div>

      {noLiquidity && (
        <p className="hint warn">
          No initialised bin array at the active bin in that direction, so there is nothing to trade against.
        </p>
      )}

      {quote && quote.result.amountOut === 0n && !noLiquidity && (
        <p className="hint warn">
          This pool cannot fill any of that. The bins in the direction of travel hold no{" "}
          {outToken.symbol}.
        </p>
      )}

      {quote && quote.result.amountOut > 0n && (
        <div className="readout">
          <dt>you receive</dt>
          <dd className="mono">
            {fmtAmount(quote.received, outDecimals)} {outToken.symbol}
          </dd>
          <dt>minimum received</dt>
          <dd className="mono">{fmtAmount(quote.minOut, outDecimals)}</dd>
          <dt>execution price</dt>
          <dd className="mono">{fmtPrice(quote.result.executionPrice * bundle.scale)}</dd>
          <dt>
            fee
            <Info>
              The rate is the bin's own, not the pool's: a base rate that widens with the bin and a
              variable part that rises with volatility. A walk across several bins pays each one's.
            </Info>
          </dt>
          <dd className="mono">{(quote.result.effectiveFeeRate * 100).toFixed(4)}%</dd>
          <dt>bins crossed</dt>
          <dd className="mono">
            {quote.result.binsCrossed} ({quote.result.startId} → {quote.result.endId})
          </dd>
        </div>
      )}

      {quote?.result.partial && (
        <p className="hint warn">
          Only {fmtAmount(quote.result.amountIn, inDecimals)} of{" "}
          {fmtAmount(quote.budget, inDecimals)} can be filled; the rest stays in your wallet.
          <Info>
            The ladder runs out of liquidity, or out of the bin arrays this transaction carries. The
            program fills partially rather than over-consuming.
          </Info>
        </p>
      )}

      {inBalance !== undefined && quote && quote.sent > inBalance && (
        <p className="hint warn">That is more {inToken.symbol} than you hold.</p>
      )}

      <div className="actions">
        <button type="button" className="primary" disabled={blocked || busy} onClick={doSwap}>
          {busy ? "swapping…" : "Swap"}
        </button>
        {involvesSol(tokens.mintX, tokens.mintY) && (
          <span className="hint">
            paid in SOL
            <Info>
              A pool holds wrapped SOL, so this transaction wraps what it needs and closes the wrapped
              account afterwards — you pay in SOL and are paid in SOL. Any wrapped SOL already sitting
              in your wallet is unwrapped along with it.
            </Info>
          </span>
        )}
        {!owner && <span className="hint">Connect a wallet to trade.</span>}
        {bundle.pool.status !== 0 && <span className="hint warn">This pool is disabled.</span>}
      </div>
    </Panel>
  );
}
