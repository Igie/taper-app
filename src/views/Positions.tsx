/**
 * Every position this wallet holds, across every pool.
 *
 * One `getProgramAccounts` finds them — positions carry their owner at a fixed
 * offset, so the memcmp does the work. Valuing them needs the bins they span,
 * which is why this then loads each pool's arrays: a share is a claim on a
 * bin's reserves, not an amount, and nothing on the position itself says what
 * it is worth.
 */
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import {
  Ladder as LadderMath,
  arrayIndexesFor,
  binArrayIndex,
  binArrayPda,
  parseBin,
  summarise,
  type BinView,
  type ConfigView,
  type PoolView,
  type PositionSummary,
  type PositionView
} from "taper-amm-sdk";
import { navigate } from "../App";
import { useCluster } from "../lib/providers";
import { listPositions, loadConfig, loadPool, loadTokens, type TokenMeta } from "../lib/data";
import { amount as fmtAmount, price as fmtPrice, shortAddress } from "../lib/format";
import { useAsync } from "../lib/useAsync";
import { Empty, LoadError, Panel } from "../components/primitives";

type Row = {
  address: PublicKey;
  position: PositionView;
  poolAddress: PublicKey;
  pool: PoolView;
  config: ConfigView;
  x?: TokenMeta;
  y?: TokenMeta;
  summary: PositionSummary;
  ladder: LadderMath;
  scale: number;
};

export function Positions() {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const { cluster } = useCluster();

  const { data, error, loading, reload } = useAsync<Row[]>(async () => {
    if (!publicKey) return [];
    const positions = await listPositions(connection, publicKey);
    if (!positions.length) return [];

    // Group by pool: every position in a pool shares its config and bins.
    const byPool = new Map<string, { pool: PublicKey; items: typeof positions }>();
    for (const item of positions) {
      const key = item.view.pool.toBase58();
      const entry = byPool.get(key) ?? { pool: item.view.pool, items: [] };
      entry.items.push(item);
      byPool.set(key, entry);
    }

    const rows: Row[] = [];
    for (const { pool: poolAddress, items } of byPool.values()) {
      const pool = await loadPool(connection, poolAddress).catch(() => undefined);
      if (!pool) continue;
      const config = await loadConfig(connection, pool.config);

      // One read per distinct array across every position in this pool.
      const needed = new Set<number>();
      for (const item of items) {
        for (const index of arrayIndexesFor(item.view.lowerBinId, item.view.upperBinId)) needed.add(index);
      }
      const indexes = [...needed];
      const accounts = await connection.getMultipleAccountsInfo(
        indexes.map((index) => binArrayPda(poolAddress, index))
      );
      const arrays = new Map(indexes.map((index, i) => [index, accounts[i]?.data]));

      const bins = new Map<number, BinView>();
      for (const item of items) {
        for (let binId = item.view.lowerBinId; binId <= item.view.upperBinId; binId += 1) {
          if (bins.has(binId)) continue;
          const data = arrays.get(binArrayIndex(binId));
          if (data) bins.set(binId, parseBin(data, binArrayIndex(binId), binId));
        }
      }

      const tokens = await loadTokens(connection, [pool.tokenXMint, pool.tokenYMint]);
      const ladder = new LadderMath(config.baseWidthQ64, config.taperQ64);

      for (const item of items) {
        rows.push({
          address: item.address,
          position: item.view,
          poolAddress,
          pool,
          config,
          x: tokens.get(pool.tokenXMint.toBase58()),
          y: tokens.get(pool.tokenYMint.toBase58()),
          summary: summarise(item.view, bins),
          ladder,
          scale: 10 ** (pool.tokenXDecimals - pool.tokenYDecimals)
        });
      }
    }
    return rows;
  }, [connection, publicKey?.toBase58(), cluster.endpoint]);

  if (!publicKey) {
    return (
      <Panel title="My positions">
        <Empty>Connect a wallet to see your positions.</Empty>
      </Panel>
    );
  }

  return (
    <Panel
      title="My positions"
      aside={
        <button type="button" className="ghost" onClick={reload} disabled={loading}>
          {loading ? "loading…" : "refresh"}
        </button>
      }
    >
      {error && <LoadError error={error} />}
      {!error && !loading && !data?.length && (
        <Empty>No positions on {cluster.label}. Open one from a pool.</Empty>
      )}

      <div className="position-grid">
        {data?.map((row) => (
          <button
            key={row.address.toBase58()}
            type="button"
            className="pool-card"
            onClick={() => navigate(`/pool/${row.poolAddress.toBase58()}`)}
          >
            <header>
              <strong>
                <span className="sym-x">{row.x?.symbol ?? "?"}</span>
                <span className="dim"> / </span>
                <span className="sym-y">{row.y?.symbol ?? "?"}</span>
              </strong>
              <span className="tag">
                bins {row.position.lowerBinId} – {row.position.upperBinId}
              </span>
            </header>
            <dl>
              <dt>price range</dt>
              <dd className="mono">
                {fmtPrice(row.ladder.price(row.position.lowerBinId) * row.scale)} –{" "}
                {fmtPrice(row.ladder.price(row.position.upperBinId) * row.scale)}
              </dd>
              <dt>holdings</dt>
              <dd className="mono">
                <span className="sym-x">{fmtAmount(row.summary.amountX, row.pool.tokenXDecimals, 4)}</span>
                <span className="dim"> · </span>
                <span className="sym-y">{fmtAmount(row.summary.amountY, row.pool.tokenYDecimals, 4)}</span>
              </dd>
              <dt>unclaimed fees</dt>
              <dd className="mono">
                <span className="sym-x">{fmtAmount(row.summary.feeX, row.pool.tokenXDecimals, 4)}</span>
                <span className="dim"> · </span>
                <span className="sym-y">{fmtAmount(row.summary.feeY, row.pool.tokenYDecimals, 4)}</span>
              </dd>
              <dt>in range</dt>
              <dd className="mono">
                {row.pool.activeId >= row.position.lowerBinId && row.pool.activeId <= row.position.upperBinId
                  ? "yes — earning fees"
                  : "no — price has moved out"}
              </dd>
            </dl>
            <footer className="mono dim">{shortAddress(row.address.toBase58(), 6, 6)}</footer>
          </button>
        ))}
      </div>
    </Panel>
  );
}
