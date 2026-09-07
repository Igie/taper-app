/**
 * The ladder presets pools are opened against.
 *
 * Every config on chain is listed, whoever published it, because hiding
 * third-party configs would not stop anyone creating pools on them — it would
 * only stop a user recognising one when they land on it. What the list does
 * instead is name the authority, and say plainly what that authority can do.
 *
 * Creation and editing are offered only to this deployment's own admin. That
 * is a UI policy, not a program constraint: `initialize_config` takes any
 * signer, and `update_config` takes the config's own authority, whoever that
 * is.
 */
import { useMemo, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import {
  buildConfig,
  explorerAccount,
  halfLifeForTaper,
  initializeConfigIx,
  Ladder,
  updateConfigIx,
  usableRange,
  validateConfig,
  type ConfigParams,
  type ConfigView,
  type UpdateConfigParams
} from "@taper/sdk";
import { useCluster, useToasts } from "../lib/providers";
import { listConfigs, type Keyed } from "../lib/data";
import { ADMIN_AUTHORITY, PRESETS, presetFor, presetParams } from "../lib/presets";
import { price as fmtPrice, shortAddress } from "../lib/format";
import { send, TxFailure } from "../lib/tx";
import { useAsync } from "../lib/useAsync";
import { Empty, Field, LoadError, Panel, Segmented } from "../components/primitives";
import {
  FeeFields,
  FeePreview,
  FEE_SCHEDULE_KEYS,
  feeScheduleOf,
  type FeeSchedule
} from "../components/ConfigFields";

export function Configs({ isAdmin, onChanged }: { isAdmin: boolean; onChanged: () => void }) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const { cluster } = useCluster();
  const { push } = useToasts();
  const [busy, setBusy] = useState<number>();
  const [editing, setEditing] = useState<string>();

  const { data, error, loading, reload } = useAsync<Keyed<ConfigView>[]>(
    () => listConfigs(connection),
    [connection, cluster.endpoint]
  );

  const mine = (c: Keyed<ConfigView>) =>
    Boolean(ADMIN_AUTHORITY && c.view.authority.equals(ADMIN_AUTHORITY));
  const published = new Set((data ?? []).filter(mine).map((c) => c.view.index));

  async function publish(index: number) {
    const preset = PRESETS.find((p) => p.index === index);
    if (!preset || !wallet.publicKey) return;
    setBusy(index);
    try {
      const params = presetParams(preset);
      const signature = await send(connection, wallet, [initializeConfigIx(wallet.publicKey, params)], {
        computeUnits: 200_000
      });
      push({
        kind: "ok",
        label: `Published "${preset.name}"`,
        detail: `bins ${params.minBinId} to ${params.maxBinId}`,
        signature
      });
      reload();
      onChanged();
    } catch (error) {
      const failure = error as TxFailure;
      push({ kind: "bad", label: "Publishing failed", detail: failure.message, logs: failure.logs });
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <div className="stage-grid">
      <Panel
        title="Presets on chain"
        aside={
          <button type="button" className="ghost" onClick={reload} disabled={loading}>
            {loading ? "loading…" : "refresh"}
          </button>
        }
      >
        {error && <LoadError error={error} />}
        {!error && !loading && !data?.length && (
          <Empty>
            No configs exist on {cluster.label}. Every pool is opened against one, so nothing can be created
            until at least one is published.
          </Empty>
        )}

        <div className="preset-list">
          {data?.map((c) => {
            const key = c.address.toBase58();
            const preset = presetFor(c.view.authority, c.view.index);
            const ladder = new Ladder(c.view.baseWidthQ64, c.view.taperQ64);
            const halfLife = halfLifeForTaper(c.view.taperQ64);
            return (
              <div key={key} className="preset static">
                <header>
                  <strong>{preset?.name ?? `Config #${c.view.index}`}</strong>
                  {mine(c) ? (
                    <span className="tag">official</span>
                  ) : (
                    <span className="tag warn-tag">third-party</span>
                  )}
                </header>
                <dl>
                  <dt>step at anchor</dt>
                  <dd className="mono">{(ladder.stepBpX100(0) / 100).toFixed(2)} bps</dd>
                  <dt>taper</dt>
                  <dd className="mono">
                    {Number.isFinite(halfLife)
                      ? `halves every ${Math.round(halfLife).toLocaleString()} bins`
                      : "none — uniform, exactly DLMM"}
                  </dd>
                  <dt>usable band</dt>
                  <dd className="mono">
                    bins {c.view.minBinId.toLocaleString()} to {c.view.maxBinId.toLocaleString()}
                  </dd>
                  <dt>price ceiling</dt>
                  <dd className="mono">
                    {Number.isFinite(ladder.priceCeiling()) ? fmtPrice(ladder.priceCeiling()) : "none"}
                  </dd>
                  <dt>protocol share</dt>
                  <dd className="mono">{(c.view.protocolShare / 100).toFixed(1)}% of fees</dd>
                  <dt>fee collection</dt>
                  <dd className="mono">{c.view.collectFeeMode === 1 ? "quote only" : "input token"}</dd>
                  <dt>authority</dt>
                  <dd className="mono">
                    <a
                      href={explorerAccount(cluster, c.view.authority.toBase58())}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {shortAddress(c.view.authority.toBase58(), 6, 6)}
                    </a>
                  </dd>
                </dl>
                {preset && <p className="hint">{preset.blurb}</p>}
                {!preset && mine(c) && (
                  <p className="hint">
                    Published by this deployment, outside the three named presets. It behaves like any other
                    config; it simply has no blurb of its own.
                  </p>
                )}
                {!mine(c) && (
                  <p className="hint warn">
                    Published by someone else. That authority takes the protocol share of every fee in pools
                    built on this config, and can disable them.
                  </p>
                )}
                {isAdmin && mine(c) && (
                  <div className="actions">
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => setEditing(editing === key ? undefined : key)}
                    >
                      {editing === key ? "close editor" : "Edit"}
                    </button>
                  </div>
                )}
                {isAdmin && mine(c) && editing === key && (
                  <EditConfig
                    config={c}
                    onDone={() => {
                      reload();
                      onChanged();
                    }}
                  />
                )}
              </div>
            );
          })}
        </div>
      </Panel>

      {isAdmin && (
        <Panel title="Publish a preset">
          <p className="hint">
            You are connected as this deployment's authority. Publishing a config makes it selectable when
            creating a pool, and makes you the recipient of the protocol share of fees in every pool built on
            it.
          </p>
          <div className="preset-list">
            {PRESETS.map((preset) => {
              const params = presetParams(preset);
              const ladder = new Ladder(params.baseWidthQ64, params.taperQ64);
              const exists = published.has(preset.index);
              return (
                <div key={preset.index} className="preset static">
                  <header>
                    <strong>{preset.name}</strong>
                    {exists && <span className="tag">published</span>}
                  </header>
                  <dl>
                    <dt>step at anchor</dt>
                    <dd className="mono">{preset.bps} bps</dd>
                    <dt>usable band</dt>
                    <dd className="mono">
                      {params.minBinId.toLocaleString()} to {params.maxBinId.toLocaleString()}
                    </dd>
                    <dt>price ceiling</dt>
                    <dd className="mono">
                      {Number.isFinite(ladder.priceCeiling()) ? fmtPrice(ladder.priceCeiling()) : "none"}
                    </dd>
                  </dl>
                  <p className="hint">{preset.blurb}</p>
                  <div className="actions">
                    <button
                      type="button"
                      className="primary"
                      disabled={exists || busy !== undefined}
                      onClick={() => publish(preset.index)}
                    >
                      {busy === preset.index ? "publishing…" : exists ? "Already published" : "Publish"}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </Panel>
      )}

      {isAdmin && (
        <CreateConfig
          usedIndexes={published}
          onDone={() => {
            reload();
            onChanged();
          }}
        />
      )}

      {!isAdmin && ADMIN_AUTHORITY && (
        <Panel title="Publishing">
          <p className="hint">
            New presets are published by this deployment's authority,{" "}
            <span className="mono">{shortAddress(ADMIN_AUTHORITY.toBase58(), 6, 6)}</span>. The program itself
            is permissionless here — anyone can create a config with the SDK — but this app only offers it to
            that key, so a pool created through it has an authority you can see.
          </p>
        </Panel>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ create

/**
 * A config from arbitrary parameters, rather than one of the three named
 * presets.
 *
 * The ladder is chosen here and never again: bins cache their price the first
 * time they are touched, so a published config's `w0` and `tau` are permanent.
 * Everything below the ladder can be edited later.
 */
function CreateConfig({ usedIndexes, onDone }: { usedIndexes: Set<number>; onDone: () => void }) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const { push } = useToasts();

  const firstFree = useMemo(() => {
    let i = 0;
    while (usedIndexes.has(i)) i += 1;
    return i;
  }, [usedIndexes]);

  const [index, setIndex] = useState(firstFree);
  const [bps, setBps] = useState(50);
  const [uniform, setUniform] = useState(0);
  const [halfLifeBins, setHalfLifeBins] = useState(4_000);
  const [band, setBand] = useState<{ min: number; max: number }>();
  const [schedule, setSchedule] = useState<FeeSchedule>(() => feeScheduleOf(buildConfig(0, 50, 4_000)));
  const [busy, setBusy] = useState(false);

  const halfLife = uniform ? Infinity : halfLifeBins;

  /**
   * The whole draft, or the reason there isn't one. `buildConfig` throws when
   * the step and taper leave no usable band at all, which is a legitimate
   * answer to a legitimate question, not a crash.
   */
  type Draft =
    | { ok: false; error: string }
    | { ok: true; params: ConfigParams; usableMin: number; usableMax: number; problems: string[] };

  const draft = useMemo<Draft>(() => {
    if (!(bps > 0) || (!uniform && !(halfLifeBins > 0))) {
      return { ok: false, error: "Enter a positive step, and a positive half-life." };
    }
    let base: ConfigParams;
    try {
      base = buildConfig(index, bps, halfLife, schedule);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    const [usableMin, usableMax] = usableRange(base.baseWidthQ64, base.taperQ64);
    const params: ConfigParams = {
      ...base,
      minBinId: band?.min ?? usableMin,
      maxBinId: band?.max ?? usableMax
    };
    return { ok: true, params, usableMin, usableMax, problems: validateConfig(params) };
  }, [index, bps, uniform, halfLifeBins, halfLife, band, schedule]);

  const ladder = draft.ok ? new Ladder(draft.params.baseWidthQ64, draft.params.taperQ64) : undefined;
  const problems = draft.ok ? draft.problems : [];
  const clash = usedIndexes.has(index);

  async function create() {
    if (!draft.ok || !wallet.publicKey) return;
    const { params } = draft;
    setBusy(true);
    try {
      const signature = await send(connection, wallet, [initializeConfigIx(wallet.publicKey, params)], {
        computeUnits: 200_000
      });
      push({
        kind: "ok",
        label: `Published config #${params.index}`,
        detail: `${bps} bps at the anchor, bins ${params.minBinId} to ${params.maxBinId}`,
        signature
      });
      onDone();
    } catch (error) {
      const failure = error as TxFailure;
      push({ kind: "bad", label: "Publishing failed", detail: failure.message, logs: failure.logs });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="Publish a custom config">
      <p className="hint">
        The ladder is fixed at publication and cannot be edited afterwards — bins cache their price the first
        time they are touched, so moving <span className="mono">w0</span> or <span className="mono">τ</span>{" "}
        under a live pool would leave it straddling two ladders. The fee schedule and the band below can be
        changed later.
      </p>

      <div className="form-grid">
        <Field
          label="Index"
          value={index}
          min={0}
          max={65_535}
          onChange={setIndex}
          hint="Per-authority preset index; part of the config address. Yours to number as you like."
        />
        <Field
          label="Step at anchor (bps)"
          value={bps}
          min={0.01}
          max={400}
          step={1}
          onChange={setBps}
          hint="Width of bin 0. Bins widen going down and tighten going up, unless the ladder is uniform."
        />
      </div>

      <div className="field">
        <span>Taper</span>
        <Segmented
          value={uniform}
          onChange={setUniform}
          options={[
            { id: 0, label: "Tapered", hint: "Widths decay geometrically going up the ladder." },
            { id: 1, label: "Uniform (τ = 1)", hint: "A constant bin step: exactly DLMM's ladder, and no price ceiling." }
          ]}
        />
      </div>

      {!uniform && (
        <div className="form-grid">
          <Field
            label="Half-life (bins)"
            value={halfLifeBins}
            min={1}
            onChange={setHalfLifeBins}
            hint="Bins over which the width halves. Shorter buys coarse cheap bins at the cost of a lower price ceiling."
          />
        </div>
      )}

      {clash && (
        <p className="hint warn">
          You already have a config at index {index}. Indexes are part of the address, so this would collide —
          pick another.
        </p>
      )}

      {!draft.ok && <p className="error">{draft.error}</p>}

      {draft.ok && ladder && (
        <>
          <dl className="readout">
            <dt>usable band</dt>
            <dd className="mono">
              {draft.usableMin.toLocaleString()} to {draft.usableMax.toLocaleString()}
            </dd>
            <dt>price ceiling</dt>
            <dd className="mono">
              {Number.isFinite(ladder.priceCeiling()) ? fmtPrice(ladder.priceCeiling()) : "none"}
            </dd>
            <dt>step at band floor</dt>
            <dd className="mono">{(ladder.stepBpX100(draft.params.minBinId) / 100).toFixed(2)} bps</dd>
            <dt>step at band ceiling</dt>
            <dd className="mono">{(ladder.stepBpX100(draft.params.maxBinId) / 100).toFixed(2)} bps</dd>
          </dl>

          <div className="form-grid">
            <Field
              label="Lower bin"
              value={draft.params.minBinId}
              onChange={(v) => setBand({ min: v, max: draft.params.maxBinId })}
              hint="Defaults to the widest band this ladder supports. A narrower band can be widened later; it can never be narrowed."
            />
            <Field
              label="Upper bin"
              value={draft.params.maxBinId}
              onChange={(v) => setBand({ min: draft.params.minBinId, max: v })}
              hint="Defaults to the widest band this ladder supports."
            />
          </div>

          <details className="advanced">
            <summary>Fee schedule</summary>
            <FeeFields value={schedule} onChange={setSchedule} />
            <FeePreview stepBpX100={ladder.stepBpX100(0)} schedule={schedule} />
          </details>
        </>
      )}

      {problems.map((p) => (
        <p key={p} className="error">
          {p}
        </p>
      ))}

      <div className="actions">
        <button
          type="button"
          className="primary"
          disabled={!draft.ok || busy || clash || problems.length > 0}
          onClick={create}
        >
          {busy ? "publishing…" : "Publish config"}
        </button>
        <span className="hint">
          You become this config's authority: the protocol share of every fee in every pool built on it, and
          the power to disable those pools.
        </span>
      </div>
    </Panel>
  );
}

// -------------------------------------------------------------------- edit

/**
 * Edits a config already on chain.
 *
 * Only the fields `update_config` accepts appear here, and only the changed
 * ones are sent: an omitted field is left alone on chain rather than rewritten
 * from a read that may be stale.
 */
function EditConfig({ config, onDone }: { config: Keyed<ConfigView>; onDone: () => void }) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const { push } = useToasts();
  const [schedule, setSchedule] = useState<FeeSchedule>(() => feeScheduleOf(config.view));
  const [band, setBand] = useState({ min: config.view.minBinId, max: config.view.maxBinId });
  const [busy, setBusy] = useState(false);

  const ladder = new Ladder(config.view.baseWidthQ64, config.view.taperQ64);
  const [usableMin, usableMax] = usableRange(config.view.baseWidthQ64, config.view.taperQ64);

  const changed = useMemo(() => {
    const next: UpdateConfigParams = {};
    for (const key of FEE_SCHEDULE_KEYS) {
      if (schedule[key] !== config.view[key]) next[key] = schedule[key];
    }
    if (band.min !== config.view.minBinId) next.minBinId = band.min;
    if (band.max !== config.view.maxBinId) next.maxBinId = band.max;
    return next;
  }, [schedule, band, config.view]);

  const count = Object.keys(changed).length;

  const problems = useMemo(() => {
    const found = validateConfig({ ...config.view, ...schedule, minBinId: band.min, maxBinId: band.max });
    // The band may grow but never shrink: narrowing would leave the dropped
    // bins holding liquidity that can be withdrawn but no longer traded.
    if (band.min > config.view.minBinId || band.max < config.view.maxBinId) {
      found.push(
        `The band may only be widened. It is currently ${config.view.minBinId.toLocaleString()} to ` +
          `${config.view.maxBinId.toLocaleString()}; narrowing would strand any liquidity in the bins it drops.`
      );
    }
    return found;
  }, [config.view, schedule, band]);

  async function apply() {
    if (!wallet.publicKey || count === 0) return;
    setBusy(true);
    try {
      const signature = await send(
        connection,
        wallet,
        [updateConfigIx(wallet.publicKey, config.address, changed)],
        { computeUnits: 200_000 }
      );
      push({
        kind: "ok",
        label: `Updated config #${config.view.index}`,
        detail: `${count} field${count === 1 ? "" : "s"} changed`,
        signature
      });
      onDone();
    } catch (error) {
      const failure = error as TxFailure;
      push({ kind: "bad", label: "Update failed", detail: failure.message, logs: failure.logs });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="config-editor">
      <p className="hint warn">
        A config is shared. Every pool already built on this one reads it live, on every swap, so a change
        here applies to all of them from the next trade onwards — not just to pools created afterwards.
      </p>

      <FeeFields value={schedule} onChange={setSchedule} disabled={busy} />
      <FeePreview stepBpX100={ladder.stepBpX100(0)} schedule={schedule} />

      <div className="form-grid">
        <Field
          label="Lower bin"
          value={band.min}
          max={config.view.minBinId}
          disabled={busy}
          onChange={(v) => setBand({ ...band, min: v })}
          hint={`Widen only. This ladder supports down to ${usableMin.toLocaleString()}.`}
        />
        <Field
          label="Upper bin"
          value={band.max}
          min={config.view.maxBinId}
          disabled={busy}
          onChange={(v) => setBand({ ...band, max: v })}
          hint={`Widen only. This ladder supports up to ${usableMax.toLocaleString()}.`}
        />
      </div>

      <p className="hint">
        The ladder itself — <span className="mono">w0</span> and <span className="mono">τ</span> — is fixed
        for the life of this config and is not editable. Publish a new config to change it; pools stay on the
        one they were opened against.
      </p>

      {problems.map((p) => (
        <p key={p} className="error">
          {p}
        </p>
      ))}

      <div className="actions">
        <button
          type="button"
          className="primary"
          disabled={busy || count === 0 || problems.length > 0}
          onClick={apply}
        >
          {busy ? "updating…" : count === 0 ? "No changes" : `Apply ${count} change${count === 1 ? "" : "s"}`}
        </button>
        <button
          type="button"
          className="ghost"
          disabled={busy || count === 0}
          onClick={() => {
            setSchedule(feeScheduleOf(config.view));
            setBand({ min: config.view.minBinId, max: config.view.maxBinId });
          }}
        >
          Reset
        </button>
      </div>
    </div>
  );
}
