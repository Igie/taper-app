/**
 * One pool: the ladder, and everything you can do to it.
 *
 * The window of bins drawn is bounded rather than complete. A config's band
 * can be hundreds of thousands of bins wide and a bin array is 6,792 bytes, so
 * this reads a fixed stretch around the active bin and lets the user pan. What
 * is drawn is always the truth for that stretch — a bin the program has never
 * touched is filled in from the client's own ladder and marked as such.
 *
 * **The chart stays; the verb changes.** Swap, new position and manage are one
 * panel behind a tab strip rather than three stacked under the ladder — they
 * are alternatives, and stacked they pushed the manage panel's buttons a
 * screen and a half below the chart every one of them is decided from. The
 * strip lives in that panel's own header, so there is one bar of chrome rather
 * than a tab named `Swap` above a header saying `SWAP`.
 *
 * Two pieces of state are shared across the three because they are one
 * decision: the **ladder selection**, which is a new position's band, a move's
 * target and a reshape's stretch, and **which position is selected**, which
 * the chart draws. Both live here for that reason.
 */
import { useCallback, useMemo, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import {
  BINS_PER_ARRAY,
  explorerAccount,
  isEndpointFailure,
  Ladder as LadderMath,
  MAX_BINS_PER_POSITION,
  POOL_DISABLED,
  priceScale,
  summarise,
  tokenPairOf,
  type BinView,
  type ConfigView,
  type PoolView as PoolViewData,
  type PositionView
} from "taper-amm-sdk";
import { useCluster, useToasts } from "../lib/providers";
import {
  listPositions,
  loadBins,
  loadConfig,
  loadPool,
  loadTokens,
  type BinCell,
  type Keyed,
  type TokenMeta
} from "../lib/data";
import { presetFor } from "../lib/presets";
import { amount, price as fmtPrice, shortAddress } from "../lib/format";
import { useAsync } from "../lib/useAsync";
import { HoverCard, LoadError, Metric, Panel, Tabs } from "../components/primitives";
import { Ladder } from "../components/Ladder";
import { SwapPanel } from "./SwapPanel";
import { NewPosition } from "./NewPosition";
import { ManagePosition } from "./ManagePosition";

/** Bins either side of the active one to read in a single pass. */
const WINDOW = BINS_PER_ARRAY * 3;

/**
 * The three things you can do to a pool, and only one of them at a time.
 *
 * They were three panels stacked under the ladder, which put the manage
 * panel's buttons a screen and a half below the chart they are decided from —
 * and the chart is the part every one of them is read against. Tabs keep the
 * ladder in view and cost nothing, because these are alternatives rather than
 * a sequence: nobody swaps *and* opens a position in the same gesture.
 */
type View = "swap" | "new" | "manage";

export type PoolBundle = {
  address: PublicKey;
  pool: PoolViewData;
  config: ConfigView;
  configAddress: PublicKey;
  x: TokenMeta;
  y: TokenMeta;
  cells: BinCell[];
  positions: Keyed<PositionView>[];
  ladder: LadderMath;
  /** Multiply a lamport price by this for a human one. */
  scale: number;
};

export function PoolView({ address, onChanged }: { address: PublicKey; onChanged: () => void }) {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const { cluster } = useCluster();
  const { push } = useToasts();
  const [centre, setCentre] = useState<number>();
  const [selectedPosition, setSelectedPosition] = useState<string>();
  const [range, setRange] = useState<{ lower: number; upper: number }>();
  // Undefined until the first click, so the default below may follow the data
  // as it lands without ever overriding a choice already made.
  const [chosenView, setChosenView] = useState<View>();
  /**
   * Whether the open view is in the middle of something.
   *
   * Switching tabs unmounts the panel, and a plan that has landed some of its
   * transactions and not the rest lives only in that panel's memory — a fill
   * leaves no witness on chain, so unmounting it could mean depositing twice
   * on the retry. So the other tabs lock rather than the run being abandoned.
   */
  const [busy, setBusy] = useState(false);

  const key = address.toBase58();
  const owner = publicKey?.toBase58();

  const { data, error, loading, reload } = useAsync<PoolBundle>(async () => {
    const pool = await loadPool(connection, address);
    const config = await loadConfig(connection, pool.config);

    const middle = centre ?? pool.activeId;
    const lower = Math.max(config.minBinId, middle - WINDOW);
    const upper = Math.min(config.maxBinId, middle + WINDOW);

    const [tokens, cells, positions] = await Promise.all([
      loadTokens(connection, [pool.tokenXMint, pool.tokenYMint]),
      loadBins(connection, address, pool, config, lower, upper),
      publicKey ? listPositions(connection, publicKey, address) : Promise.resolve([])
    ]);

    const x = tokens.get(pool.tokenXMint.toBase58());
    const y = tokens.get(pool.tokenYMint.toBase58());
    if (!x || !y) throw new Error("Could not read this pool's mints.");

    return {
      address,
      pool,
      config,
      configAddress: pool.config,
      x,
      y,
      cells,
      positions,
      ladder: new LadderMath(config.baseWidthQ64, config.taperQ64),
      scale: priceScale(pool.tokenXDecimals, pool.tokenYDecimals)
    };
  }, [connection, key, owner, centre, cluster.endpoint]);

  const afterTx = useCallback(() => {
    reload();
    onChanged();
  }, [reload, onChanged]);

  const bins = useMemo(() => {
    const map = new Map<number, BinView>();
    for (const cell of data?.cells ?? []) map.set(cell.binId, cell);
    return map;
  }, [data?.cells]);

  // The same fallback the panel below makes, so the band drawn is always the
  // one the verbs would act on — including before the first selection lands.
  const position =
    data?.positions.find((p) => p.address.toBase58() === selectedPosition) ?? data?.positions[0];
  const summary = position ? summarise(position.view, bins) : undefined;
  const band = position
    ? { lower: position.view.lowerBinId, upper: position.view.upperBinId }
    : undefined;

  const cells = useMemo(() => {
    if (!data) return [];
    return data.cells.map((cell) => {
      if (!position || !summary) return cell;
      const holding = summary.bins.find((b) => b.binId === cell.binId);
      return holding
        ? {
            ...cell,
            share: holding.share,
            // The position's cut of the bin, which is what the position row of
            // the chart draws — the bin's own balances are the pool row.
            myAmountX: holding.amountX,
            myAmountY: holding.amountY,
            pendingFeeX: holding.feeX,
            pendingFeeY: holding.feeY
          }
        : cell;
    });
  }, [data, position, summary]);

  if (error) {
    return (
      <Panel title="Pool">
        <LoadError error={error} />
        {!isEndpointFailure(error) && (
          <p className="hint">
            This address holds no pool on {cluster.label}. Pools are per-cluster — check the network
            selector.
          </p>
        )}
      </Panel>
    );
  }

  if (!data) {
    return (
      <Panel title="Pool">
        <p className="hint">{loading ? "Loading pool…" : "No data."}</p>
      </Panel>
    );
  }

  const preset = presetFor(data.config.authority, data.config.index);
  const disabled = data.pool.status === POOL_DISABLED;
  const tokens = tokenPairOf(data.pool);
  const activePrice = data.ladder.price(data.pool.activeId) * data.scale;
  const shownCentre = centre ?? data.pool.activeId;

  /*
   * Opens on the verb the wallet is most likely to want: manage, when it
   * already holds something here, and otherwise open a position. Swapping is
   * offered but is not what this app is for.
   */
  const view: View = chosenView ?? (data.positions.length ? "manage" : "new");
  const viewTabs = (
    <Tabs
      value={view}
      onChange={setChosenView}
      tabs={(
        [
          { id: "swap", label: "Swap", hint: "trade against this pool" },
          { id: "new", label: "New position", hint: "open a position over a band" },
          {
            id: "manage",
            label:
              data.positions.length > 1 ? `Manage (${data.positions.length})` : "Manage position",
            hint: "add, remove, reshape or move what you already hold"
          }
        ] satisfies { id: View; label: string; hint: string }[]
      ).map((tab) => ({
        ...tab,
        // Held rather than hidden: the run in flight is the reason, and the
        // open tab is where it is explained.
        disabled: busy && tab.id !== view
      }))}
    />
  );

  return (
    <div className="pool-stage">
      <Panel
        title={`${data.x.symbol} / ${data.y.symbol}`}
        aside={
          <div className="panel-actions">
            {disabled && <span className="tag bad">disabled — withdrawals only</span>}
            <HoverCard
              className="chip-card"
              trigger={<span className="tag">{preset?.name ?? `config #${data.config.index}`}</span>}
            >
              <dl>
                <dt>volatility</dt>
                <dd>{data.pool.volatilityAccumulator.toLocaleString()}</dd>
                <dt>protocol fees</dt>
                <dd>
                  {amount(data.pool.protocolFeeX, data.pool.tokenXDecimals, 3)} /{" "}
                  {amount(data.pool.protocolFeeY, data.pool.tokenYDecimals, 3)}
                </dd>
                <dt>usable bins</dt>
                <dd>
                  {data.config.minBinId} … {data.config.maxBinId}
                </dd>
                <dt>config</dt>
                <dd>{shortAddress(data.configAddress.toBase58(), 4, 4)}</dd>
              </dl>
            </HoverCard>
            <a
              className="ghost"
              href={explorerAccount(cluster, data.address.toBase58())}
              target="_blank"
              rel="noreferrer"
            >
              {shortAddress(data.address.toBase58(), 6, 6)}
            </a>
            <button type="button" className="ghost" onClick={reload} disabled={loading}>
              {loading ? "loading…" : "refresh"}
            </button>
          </div>
        }
      >
        <div className="metrics">
          <Metric label="price" value={<span className="mono">{fmtPrice(activePrice)}</span>} />
          <Metric
            label="active bin"
            value={<span className="mono">{data.pool.activeId}</span>}
            hint="The bin the pool is trading in. Bins below it hold only Y, bins above it only X."
          />
          <Metric
            label="bin width here"
            value={
              <span className="mono">
                {(data.ladder.stepBpX100(data.pool.activeId) / 100).toFixed(2)} bps
              </span>
            }
            hint="This ladder's step is not constant: bins widen with price, so the width shown is the one at the active bin."
          />
        </div>

        <div className="stage-head">
          <h3>Ladder</h3>
          <div className="stage-controls">
            <button type="button" className="ghost" onClick={() => setCentre(shownCentre - WINDOW)}>
              ← lower
            </button>
            <button type="button" className="ghost" onClick={() => setCentre(undefined)}>
              centre on active
            </button>
            <button type="button" className="ghost" onClick={() => setCentre(shownCentre + WINDOW)}>
              higher →
            </button>
            {/* Kept out of the three pan controls, because it is not a pan: a band
               that has drifted off the window is exactly the one worth looking
               at, and walking to it a window at a time is several clicks. */}
            {band && (
              <button
                type="button"
                className="ghost"
                onClick={() => setCentre(Math.round((band.lower + band.upper) / 2))}
              >
                centre on my band
              </button>
            )}
          </div>
        </div>

        {/*
          The drag is how a band is stated — for a new position, for a move and
          for a reshape — so it is capped at what a *position* may span rather
          than at what one transaction carries. The planners chunk the rest and
          each form says how many signatures it will cost.
        */}
        <Ladder
          cells={cells}
          activeId={data.pool.activeId}
          band={band}
          // Split into pool / position / fees only while a position is the
          // thing being worked on. Opening a *new* one is a question about the
          // pool, and a wallet that already holds something here would
          // otherwise get two rows of somebody else's decision.
          showPosition={view === "manage" && !!position}
          range={range}
          maxSelectable={MAX_BINS_PER_POSITION}
          onSelectRange={(lower, upper) => setRange({ lower, upper })}
          decimalsX={data.pool.tokenXDecimals}
          decimalsY={data.pool.tokenYDecimals}
          symbolX={data.x.symbol}
          symbolY={data.y.symbol}
        />
      </Panel>

      {/*
        One panel, whose header *is* the picker — a tab strip above a header
        naming the same tab is the word twice and a second bar to look past.
      */}
      {view === "swap" && (
        <SwapPanel
          bundle={data}
          tokens={tokens}
          header={viewTabs}
          onBusyChange={setBusy}
          onDone={afterTx}
          push={push}
        />
      )}

      {view === "new" && (
        <NewPosition
          bundle={data}
          tokens={tokens}
          range={range}
          onRange={setRange}
          header={viewTabs}
          onBusyChange={setBusy}
          onDone={afterTx}
          push={push}
        />
      )}

      {view === "manage" && (
        <ManagePosition
          bundle={data}
          tokens={tokens}
          bins={bins}
          selected={selectedPosition}
          onSelect={setSelectedPosition}
          range={range}
          onRange={setRange}
          header={viewTabs}
          onBusyChange={setBusy}
          onDone={afterTx}
          push={push}
        />
      )}
    </div>
  );
}
