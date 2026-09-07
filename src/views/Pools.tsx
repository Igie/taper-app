/**
 * Every pool the program holds.
 *
 * There is no indexer, so this is one `getProgramAccounts` filtered by
 * `dataSize` plus one `getMultipleAccounts` for the mints and reserves. That
 * is two round trips for the whole list, which is fine at devnet scale and
 * would not be at mainnet scale — the honest limit of an app with no backend.
 */
import { useMemo, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { Ladder, POOL_DISABLED } from "@taper/sdk";
import { navigate } from "../App";
import { useCluster } from "../lib/providers";
import { listConfigs, listPools, loadTokens, type Keyed, type TokenMeta } from "../lib/data";
import { presetFor } from "../lib/presets";
import { amount, price as fmtPrice, shortAddress } from "../lib/format";
import { useAsync } from "../lib/useAsync";
import { Empty, LoadError, Panel } from "../components/primitives";
import type { ConfigView, PoolView } from "@taper/sdk";

type Row = {
  address: PublicKey;
  pool: PoolView;
  config?: ConfigView;
  x?: TokenMeta;
  y?: TokenMeta;
  reserveX: bigint;
  reserveY: bigint;
  /** Human price at the active bin, Y per X. */
  activePrice: number;
};

export function Pools() {
  const { connection } = useConnection();
  const { cluster } = useCluster();
  const [query, setQuery] = useState("");

  const { data, error, loading, reload } = useAsync<Row[]>(async () => {
    const [pools, configs] = await Promise.all([listPools(connection), listConfigs(connection)]);
    if (!pools.length) return [];

    const byAddress = new Map(configs.map((c: Keyed<ConfigView>) => [c.address.toBase58(), c.view]));
    const tokens = await loadTokens(
      connection,
      pools.flatMap((p) => [p.view.tokenXMint, p.view.tokenYMint])
    );

    // Reserves are plain token accounts, so their balances come in one batch
    // rather than one `getTokenAccountBalance` per pool.
    const reserves = await connection.getMultipleAccountsInfo(
      pools.flatMap((p) => [p.view.reserveX, p.view.reserveY])
    );
    const balanceOf = (i: number) => {
      const account = reserves[i];
      // A token account's amount is a u64 at offset 64, in both token programs.
      return account && account.data.length >= 72
        ? new DataView(account.data.buffer, account.data.byteOffset + 64, 8).getBigUint64(0, true)
        : 0n;
    };

    return pools.map((p, i) => {
      const config = byAddress.get(p.view.config.toBase58());
      const x = tokens.get(p.view.tokenXMint.toBase58());
      const y = tokens.get(p.view.tokenYMint.toBase58());
      const ladder = config ? new Ladder(config.baseWidthQ64, config.taperQ64) : undefined;
      const lamportPrice = ladder ? ladder.price(p.view.activeId) : 0;
      return {
        address: p.address,
        pool: p.view,
        config,
        x,
        y,
        reserveX: balanceOf(i * 2),
        reserveY: balanceOf(i * 2 + 1),
        activePrice: lamportPrice * 10 ** (p.view.tokenXDecimals - p.view.tokenYDecimals)
      };
    });
  }, [connection, cluster.endpoint]);

  const rows = useMemo(() => {
    if (!data) return [];
    const needle = query.trim().toLowerCase();
    if (!needle) return data;
    return data.filter((row) =>
      [
        row.address.toBase58(),
        row.pool.tokenXMint.toBase58(),
        row.pool.tokenYMint.toBase58(),
        row.x?.symbol ?? "",
        row.y?.symbol ?? "",
        row.x?.name ?? "",
        row.y?.name ?? ""
      ]
        .join(" ")
        .toLowerCase()
        .includes(needle)
    );
  }, [data, query]);

  return (
    <Panel
      title="Pools"
      aside={
        <div className="panel-actions">
          <input
            className="search"
            placeholder="filter by symbol or address"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button type="button" className="ghost" onClick={reload} disabled={loading}>
            {loading ? "loading…" : "refresh"}
          </button>
          <button type="button" className="primary" onClick={() => navigate("/new")}>
            Create pool
          </button>
        </div>
      }
    >
      {error && <LoadError error={error} />}
      {!error && !loading && rows.length === 0 && (
        <Empty>
          {data?.length
            ? "No pool matches that filter."
            : `No pools on ${cluster.label} yet. Create the first one.`}
        </Empty>
      )}

      {rows.length > 0 && (
        <div className="pool-grid">
          {rows.map((row) => {
            const preset = row.config ? presetFor(row.config.authority, row.config.index) : undefined;
            const disabled = row.pool.status === POOL_DISABLED;
            return (
              <button
                key={row.address.toBase58()}
                type="button"
                className={`pool-card ${disabled ? "disabled" : ""}`}
                onClick={() => navigate(`/pool/${row.address.toBase58()}`)}
              >
                <header>
                  <strong>
                    <span className="sym-x">{row.x?.symbol ?? "?"}</span>
                    <span className="dim"> / </span>
                    <span className="sym-y">{row.y?.symbol ?? "?"}</span>
                  </strong>
                  {disabled && <span className="tag bad">disabled</span>}
                  {preset && <span className="tag">{preset.name}</span>}
                  {!preset && <span className="tag warn-tag">third-party preset</span>}
                </header>

                <dl>
                  <dt>price</dt>
                  <dd className="mono">{fmtPrice(row.activePrice)}</dd>
                  <dt>active bin</dt>
                  <dd className="mono">{row.pool.activeId}</dd>
                  <dt>reserves</dt>
                  <dd className="mono">
                    <span className="sym-x">{amount(row.reserveX, row.pool.tokenXDecimals, 3)}</span>
                    <span className="dim"> · </span>
                    <span className="sym-y">{amount(row.reserveY, row.pool.tokenYDecimals, 3)}</span>
                  </dd>
                  <dt>bin arrays</dt>
                  <dd className="mono">{row.pool.occupiedArrays.size} with liquidity</dd>
                </dl>

                <footer className="mono dim">{shortAddress(row.address.toBase58(), 6, 6)}</footer>
              </button>
            );
          })}
        </div>
      )}
    </Panel>
  );
}
