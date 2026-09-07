/**
 * One pool: the ladder, and everything you can do to it.
 *
 * The window of bins drawn is bounded rather than complete. A config's band
 * can be hundreds of thousands of bins wide and a bin array is 6,792 bytes, so
 * this reads a fixed stretch around the active bin and lets the user pan. What
 * is drawn is always the truth for that stretch — a bin the program has never
 * touched is filled in from the client's own ladder and marked as such.
 */
import { useCallback, useMemo, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import {
  BINS_PER_ARRAY,
  Ladder as LadderMath,
  POOL_DISABLED,
  summarise,
  tokenPairOf,
  type BinView,
  type ConfigView,
  type PoolView as PoolViewData,
  type PositionView
} from "@taper/sdk";
import { useCluster, useToasts } from "../lib/providers";
import { explorerAccount, isEndpointFailure } from "../lib/cluster";
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
import { Empty, LoadError, Metric, Panel } from "../components/primitives";
import { Ladder } from "../components/Ladder";
import { SwapPanel } from "./SwapPanel";
import { LiquidityPanel } from "./LiquidityPanel";
import { PositionPanel } from "./PositionPanel";

/** Bins either side of the active one to read in a single pass. */
const WINDOW = BINS_PER_ARRAY * 3;

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
      scale: 10 ** (pool.tokenXDecimals - pool.tokenYDecimals)
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

  const position = data?.positions.find((p) => p.address.toBase58() === selectedPosition);
  const summary = position ? summarise(position.view, bins) : undefined;

  const cells = useMemo(() => {
    if (!data) return [];
    return data.cells.map((cell) => {
      if (!position || !summary) return cell;
      const holding = summary.bins.find((b) => b.binId === cell.binId);
      return holding
        ? { ...cell, share: holding.share, pendingFeeX: holding.feeX, pendingFeeY: holding.feeY }
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

  return (
    <div className="pool-stage">
      <Panel
        title={`${data.x.symbol} / ${data.y.symbol}`}
        aside={
          <div className="panel-actions">
            {disabled && <span className="tag bad">disabled — withdrawals only</span>}
            <span className="tag">{preset?.name ?? `config #${data.config.index}`}</span>
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
          <Metric label="active bin" value={<span className="mono">{data.pool.activeId}</span>} />
          <Metric
            label="bin width here"
            value={<span className="mono">{(data.ladder.stepBpX100(data.pool.activeId) / 100).toFixed(2)} bps</span>}
          />
          <Metric
            label="volatility"
            value={<span className="mono">{data.pool.volatilityAccumulator.toLocaleString()}</span>}
            tone="dim"
          />
          <Metric
            label={`protocol fees`}
            value={
              <span className="mono">
                {amount(data.pool.protocolFeeX, data.pool.tokenXDecimals, 3)} /{" "}
                {amount(data.pool.protocolFeeY, data.pool.tokenYDecimals, 3)}
              </span>
            }
            tone="dim"
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
          </div>
        </div>

        <Ladder
          cells={cells}
          activeId={data.pool.activeId}
          range={range}
          onSelectRange={(lower, upper) => setRange({ lower, upper })}
          decimalsX={data.pool.tokenXDecimals}
          decimalsY={data.pool.tokenYDecimals}
          symbolX={data.x.symbol}
          symbolY={data.y.symbol}
        />
      </Panel>

      <div className="pool-columns">
        <SwapPanel bundle={data} tokens={tokens} onDone={afterTx} push={push} />
        <LiquidityPanel
          bundle={data}
          tokens={tokens}
          range={range}
          onRange={setRange}
          onDone={afterTx}
          push={push}
        />
      </div>

      <PositionPanel
        bundle={data}
        tokens={tokens}
        bins={bins}
        selected={selectedPosition}
        onSelect={setSelectedPosition}
        onDone={afterTx}
        push={push}
      />

      {data.positions.length === 0 && publicKey && (
        <Empty>You hold no position in this pool yet. Drag across the ladder to pick a range.</Empty>
      )}
    </div>
  );
}
