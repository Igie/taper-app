/**
 * Creating a pool from two mints.
 *
 * Three things have to be right before the transaction is worth sending, and
 * each of them is checked here rather than left to a program error:
 *
 * - **Mint order.** The pool PDA is seeded with both mints, so X must sort
 *   below Y. Entering them the other way round is not an error to report; it
 *   is an ordering to apply.
 * - **Extensions.** `initialize_pool` allowlists mint extensions and rejects
 *   the rest. Screening client side turns a custom error code into a sentence.
 * - **The active bin.** A price is what a person has in mind; a bin id is what
 *   the program takes. The conversion runs through the same ladder the chain
 *   uses, and the result has to sit inside the config's declared band.
 */
import { useEffect, useMemo, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import {
  Ladder,
  binIdForPrice,
  initializePoolIx,
  isNativeMint,
  mintRejection,
  orderMints,
  poolPda,
  priceScale,
  type ConfigView,
  type MintInfo
} from "@taper/sdk";
import { navigate } from "../App";
import { useCluster, useToasts } from "../lib/providers";
import { listConfigs, listWalletTokens, loadMint, type Keyed, type WalletToken } from "../lib/data";
import { presetFor } from "../lib/presets";
import { price as fmtPrice, shortAddress } from "../lib/format";
import { readableError, send, TxFailure } from "../lib/tx";
import { useAsync } from "../lib/useAsync";
import { Empty, LoadError, Panel } from "../components/primitives";
import { TokenPicker } from "../components/TokenPicker";

type Screened = { info?: MintInfo; error?: string; loading: boolean };

function useScreenedMint(address: string): Screened {
  const { connection } = useConnection();
  const [state, setState] = useState<Screened>({ loading: false });

  useEffect(() => {
    const trimmed = address.trim();
    if (!trimmed) return setState({ loading: false });

    let key: PublicKey;
    try {
      key = new PublicKey(trimmed);
    } catch {
      return setState({ loading: false, error: "Not a valid address." });
    }

    let cancelled = false;
    setState({ loading: true });
    loadMint(connection, key)
      .then((info) => !cancelled && setState({ info, loading: false }))
      .catch((e: unknown) => !cancelled && setState({ loading: false, error: readableError(e) }));
    return () => {
      cancelled = true;
    };
  }, [address, connection]);

  return state;
}

function MintCard({ label, state }: { label: string; state: Screened }) {
  if (state.loading) return <p className="hint">Reading {label}…</p>;
  if (state.error) return <p className="error">{state.error}</p>;
  if (!state.info) return null;

  const rejection = mintRejection(state.info);
  const native = isNativeMint(state.info.address);
  return (
    <div className={`mint-card ${rejection ? "bad" : ""}`}>
      <dl>
        {native && (
          <>
            <dt>token</dt>
            <dd className="mono">Wrapped SOL</dd>
          </>
        )}
        <dt>decimals</dt>
        <dd className="mono">{state.info.decimals}</dd>
        <dt>program</dt>
        <dd className="mono">{state.info.flag === 1 ? "Token-2022" : "SPL Token"}</dd>
        {state.info.transferFeeBps > 0 && (
          <>
            <dt>transfer fee</dt>
            <dd className="mono warn">{(state.info.transferFeeBps / 100).toFixed(2)}%</dd>
          </>
        )}
        {state.info.extensions.length > 0 && (
          <>
            <dt>extensions</dt>
            <dd className="mono">{state.info.extensions.length}</dd>
          </>
        )}
      </dl>
      {rejection && <p className="error">{rejection}</p>}
      {native && (
        <p className="hint">
          A pool holds token accounts, so the SOL side of a pair is wrapped SOL. Depositing or trading here
          wraps what the transaction needs and unwraps the rest at the end of it, so what you hold before and
          after is plain SOL.
        </p>
      )}
      {state.info.transferFeeBps > 0 && !rejection && (
        <p className="hint">
          This mint charges a transfer fee, so a deposit credits the pool with less than it sends and a swap
          pays out less than leaves the reserve. The program accounts for both.
        </p>
      )}
    </div>
  );
}

export function CreatePool({ onCreated }: { onCreated: () => void }) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const { cluster } = useCluster();
  const { push } = useToasts();

  const [mintA, setMintA] = useState("");
  const [mintB, setMintB] = useState("");
  const [configAddress, setConfigAddress] = useState<string>();
  const [priceInput, setPriceInput] = useState("1");
  const [busy, setBusy] = useState(false);

  const a = useScreenedMint(mintA);
  const b = useScreenedMint(mintB);

  const configs = useAsync<Keyed<ConfigView>[]>(() => listConfigs(connection), [connection, cluster.endpoint]);

  const owner = wallet.publicKey;
  const held = useAsync<WalletToken[]>(
    () => (owner ? listWalletTokens(connection, owner) : Promise.resolve([])),
    [connection, owner?.toBase58(), cluster.endpoint]
  );

  useEffect(() => {
    if (!configAddress && configs.data?.length) setConfigAddress(configs.data[0].address.toBase58());
  }, [configs.data, configAddress]);

  const chosen = configs.data?.find((c) => c.address.toBase58() === configAddress);

  // Canonical order is not the order they were typed in.
  const ordered = useMemo(() => {
    if (!a.info || !b.info) return undefined;
    if (a.info.address.equals(b.info.address)) return undefined;
    const [x, y] = orderMints(a.info.address, b.info.address);
    const infoX = x.equals(a.info.address) ? a.info : b.info;
    const infoY = y.equals(a.info.address) ? a.info : b.info;
    return { infoX, infoY, swapped: !x.equals(a.info.address) };
  }, [a.info, b.info]);

  const plan = useMemo(() => {
    if (!ordered || !chosen) return undefined;
    const ladder = new Ladder(chosen.view.baseWidthQ64, chosen.view.taperQ64);
    const wanted = Number(priceInput);
    if (!Number.isFinite(wanted) || wanted <= 0) return { error: "Enter a positive starting price." };

    const activeId = binIdForPrice(
      ladder,
      wanted,
      ordered.infoX.decimals,
      ordered.infoY.decimals,
      [chosen.view.minBinId, chosen.view.maxBinId]
    );
    const scale = priceScale(ordered.infoX.decimals, ordered.infoY.decimals);
    const actual = ladder.price(activeId) * scale;
    const pool = poolPda(chosen.address, ordered.infoX.address, ordered.infoY.address);

    if (activeId < chosen.view.minBinId || activeId > chosen.view.maxBinId) {
      return {
        error: `This preset covers ${fmtPrice(ladder.price(chosen.view.minBinId) * scale)} to ${fmtPrice(
          ladder.price(chosen.view.maxBinId) * scale
        )}. Pick a starting price inside that band, or a different preset.`
      };
    }

    return {
      activeId,
      actual,
      pool,
      ceiling: ladder.priceCeiling() * scale,
      stepBps: ladder.stepBpX100(activeId) / 100
    };
  }, [ordered, chosen, priceInput]);

  const [existing, setExisting] = useState<boolean>();
  useEffect(() => {
    if (!plan || "error" in plan || !plan.pool) return setExisting(undefined);
    let cancelled = false;
    connection
      .getAccountInfo(plan.pool)
      .then((account) => !cancelled && setExisting(Boolean(account)))
      .catch(() => !cancelled && setExisting(undefined));
    return () => {
      cancelled = true;
    };
  }, [connection, plan]);

  const blocked =
    !wallet.publicKey ||
    !ordered ||
    !chosen ||
    !plan ||
    "error" in plan ||
    existing === true ||
    Boolean(mintRejection(ordered.infoX)) ||
    Boolean(mintRejection(ordered.infoY));

  async function create() {
    if (!ordered || !chosen || !plan || "error" in plan) return;
    setBusy(true);
    try {
      const tokens = {
        mintX: ordered.infoX.address,
        programX: ordered.infoX.program,
        mintY: ordered.infoY.address,
        programY: ordered.infoY.program
      };
      const signature = await send(
        connection,
        wallet,
        [initializePoolIx(wallet.publicKey!, chosen.address, tokens, plan.activeId)],
        { computeUnits: 300_000 }
      );
      push({
        kind: "ok",
        label: "Pool created",
        detail: `${ordered.infoX.address.toBase58().slice(0, 4)}… / ${ordered.infoY.address
          .toBase58()
          .slice(0, 4)}… at bin ${plan.activeId}`,
        signature
      });
      onCreated();
      navigate(`/pool/${plan.pool.toBase58()}`);
    } catch (error) {
      const failure = error as TxFailure;
      push({ kind: "bad", label: "Pool creation failed", detail: failure.message, logs: failure.logs });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stage-grid">
      <Panel title="Create a pool">
        <TokenPicker
          label="First mint"
          value={mintA}
          onChange={setMintA}
          tokens={held.data}
          loading={held.loading}
          connected={Boolean(owner)}
          taken={mintB.trim()}
        />
        <MintCard label="the first mint" state={a} />

        <TokenPicker
          label="Second mint"
          value={mintB}
          onChange={setMintB}
          tokens={held.data}
          loading={held.loading}
          connected={Boolean(owner)}
          taken={mintA.trim()}
        />
        <MintCard label="the second mint" state={b} />

        {ordered?.swapped && (
          <p className="hint">
            Ordered as <strong>{shortAddress(ordered.infoX.address.toBase58())}</strong> /{" "}
            <strong>{shortAddress(ordered.infoY.address.toBase58())}</strong>. The pool address is derived from
            both mints, so the pair has one canonical order and it is not the order you typed.
          </p>
        )}

        <label className="field wide">
          <span>Starting price (second per first, in whole tokens)</span>
          <input
            className="mono"
            inputMode="decimal"
            value={priceInput}
            onChange={(e) => setPriceInput(e.target.value.replace(/[^\d.eE+-]/g, ""))}
          />
        </label>

        <div className="actions">
          <button type="button" className="primary" disabled={blocked || busy} onClick={create}>
            {busy ? "creating…" : "Create pool"}
          </button>
          {!wallet.publicKey && <span className="hint">Connect a wallet to create a pool.</span>}
          {existing === true && plan && !("error" in plan) && (
            <span className="hint">
              This pair already exists under this preset.{" "}
              <a href={`#/pool/${plan.pool.toBase58()}`}>Open it</a>.
            </span>
          )}
        </div>
      </Panel>

      <Panel title="Preset">
        {configs.loading && <p className="hint">Loading presets…</p>}
        {configs.error && <LoadError error={configs.error} />}
        {!configs.loading && !configs.data?.length && (
          <Empty>
            No presets exist on {cluster.label}. A pool is opened against a config, so one has to be published
            before any pool can be created.
          </Empty>
        )}

        <div className="preset-list">
          {configs.data?.map((c) => {
            const preset = presetFor(c.view.authority, c.view.index);
            const ladder = new Ladder(c.view.baseWidthQ64, c.view.taperQ64);
            const selected = c.address.toBase58() === configAddress;
            return (
              <button
                key={c.address.toBase58()}
                type="button"
                className={`preset ${selected ? "selected" : ""}`}
                onClick={() => setConfigAddress(c.address.toBase58())}
              >
                <header>
                  <strong>{preset?.name ?? `Config #${c.view.index}`}</strong>
                  {!preset && <span className="tag warn-tag">third-party</span>}
                </header>
                <dl>
                  <dt>step at anchor</dt>
                  <dd className="mono">{(ladder.stepBpX100(0) / 100).toFixed(2)} bps</dd>
                  <dt>taper</dt>
                  <dd className="mono">
                    {ladder.tau === 1
                      ? "none (uniform)"
                      : `halves every ${Math.round(-1 / Math.log2(ladder.tau)).toLocaleString()} bins`}
                  </dd>
                  <dt>protocol share</dt>
                  <dd className="mono">{(c.view.protocolShare / 100).toFixed(1)}%</dd>
                  <dt>authority</dt>
                  <dd className="mono">{shortAddress(c.view.authority.toBase58())}</dd>
                </dl>
                {preset && <p className="hint">{preset.blurb}</p>}
                {!preset && (
                  <p className="hint warn">
                    This preset was published by someone else. Its authority collects the protocol share of
                    every fee in pools built on it, and can disable them.
                  </p>
                )}
              </button>
            );
          })}
        </div>
      </Panel>

      <Panel title="What will be created">
        {!plan && <Empty>Enter two mints and pick a preset.</Empty>}
        {plan && "error" in plan && <p className="error">{plan.error}</p>}
        {plan && !("error" in plan) && ordered && (
          <>
            <div className="readout">
              <dt>pool address</dt>
              <dd className="mono">{shortAddress(plan.pool.toBase58(), 8, 8)}</dd>
              <dt>active bin</dt>
              <dd className="mono">{plan.activeId}</dd>
              <dt>price at that bin</dt>
              <dd className="mono">{fmtPrice(plan.actual)}</dd>
              <dt>bin width there</dt>
              <dd className="mono">{plan.stepBps.toFixed(2)} bps</dd>
              <dt>price ceiling</dt>
              <dd className="mono">{Number.isFinite(plan.ceiling) ? fmtPrice(plan.ceiling) : "none"}</dd>
            </div>
            <p className="hint">
              Bins are discrete, so the pool opens at the nearest one rather than exactly at the price you
              asked for. Creating the pool costs rent for the pool account and both reserves; bin arrays are
              rented later, as liquidity reaches them.
            </p>
            {Number.isFinite(plan.ceiling) && (
              <p className="hint">
                A tapered ladder has a maximum expressible price — here {fmtPrice(plan.ceiling)}. Above it
                there are no bins at all, which is the real cost of the taper.
              </p>
            )}
          </>
        )}
      </Panel>
    </div>
  );
}
