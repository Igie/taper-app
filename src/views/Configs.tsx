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
  feeRateForStep,
  halfLifeForStrength,
  halfLifeForTaper,
  initializeConfigIx,
  Ladder,
  ladderSpan,
  strengthForHalfLife,
  strengthForTaper,
  TAPER_STRENGTH_REF_BINS,
  taperForStrength,
  updateConfigIx,
  validateConfig,
  type BandLimit,
  type ConfigParams,
  type ConfigView,
  type LadderSpan,
  type UpdateConfigParams
} from "taper-amm-sdk";
import { useCluster, useToasts } from "../lib/providers";
import { listConfigs, type Keyed } from "../lib/data";
import { ADMIN_AUTHORITY, PRESETS, presetFor, presetParams } from "../lib/presets";
import { percentOfBps, price as fmtPrice, shortAddress } from "../lib/format";
import { send, TxFailure } from "../lib/tx";
import { useAsync } from "../lib/useAsync";
import { Empty, Field, LoadError, Panel, Slider } from "../components/primitives";
import {
  dynamicFeeIsOn,
  FeeFields,
  FeePreview,
  FeeRate,
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
            // The config's own band is what it trades over; the ladder's is
            // the most it could be widened to. Showing both is the only way
            // "usable band" answers the question a creator is actually asking.
            const span = ladderSpan(c.view.baseWidthQ64, c.view.taperQ64);
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
                      ? `halves every ${Math.round(halfLife).toLocaleString()} bins ` +
                        `(strength ${strengthForTaper(c.view.taperQ64).toFixed(3)})`
                      : "none — uniform, exactly DLMM"}
                  </dd>
                  <dt>band on this config</dt>
                  <dd className="mono">
                    {(c.view.maxBinId - c.view.minBinId + 1).toLocaleString()} bins (
                    {c.view.minBinId.toLocaleString()} to {c.view.maxBinId.toLocaleString()})
                    {(c.view.minBinId > span.minBinId || c.view.maxBinId < span.maxBinId) && (
                      <>
                        {" "}
                        <span className="why">narrowed from what the ladder supports; widenable</span>
                      </>
                    )}
                  </dd>
                  <dt>price span</dt>
                  <dd className="mono">
                    10^{(
                      Math.log10(ladder.price(c.view.maxBinId) / ladder.price(c.view.minBinId))
                    ).toFixed(1)}{" "}
                    ×
                  </dd>
                  <dt>bins per 10× move</dt>
                  <dd className="mono">
                    {Math.round(span.binsPerDecadeAtAnchor).toLocaleString()} at the anchor
                  </dd>
                  <dt>bin width</dt>
                  <dd className="mono">
                    {(ladder.stepBpX100(c.view.minBinId) / 100).toFixed(2)} bps →{" "}
                    {(ladder.stepBpX100(c.view.maxBinId) / 100).toFixed(2)} bps
                  </dd>
                  <dt>price ceiling</dt>
                  <dd className="mono">
                    {Number.isFinite(ladder.priceCeiling()) ? decades(ladder.priceCeiling()) : "none"}
                  </dd>
                  <dt>base fee at anchor</dt>
                  <dd className="mono">
                    <FeeRate rate={feeRateForStep(ladder.stepBpX100(0), c.view, 0)} />
                  </dd>
                  <dt>at peak volatility</dt>
                  <dd className="mono">
                    {dynamicFeeIsOn(c.view) ? (
                      <FeeRate
                        rate={feeRateForStep(
                          ladder.stepBpX100(0),
                          c.view,
                          c.view.maxVolatilityAccumulator
                        )}
                      />
                    ) : (
                      "dynamic fee off"
                    )}
                  </dd>
                  <dt>protocol share</dt>
                  <dd className="mono">
                    {percentOfBps(c.view.protocolShare)} of fees{" "}
                    <span className="alt">{c.view.protocolShare.toLocaleString()} bps</span>
                  </dd>
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
              const span = ladderSpan(params.baseWidthQ64, params.taperQ64);
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
                    <dt>fee at rest</dt>
                    <dd className="mono">
                      <FeeRate rate={feeRateForStep(preset.bps * 100, params, 0)} />
                    </dd>
                    <dt>protocol share</dt>
                    <dd className="mono">
                      {percentOfBps(params.protocolShare)} of fees{" "}
                      <span className="alt">{params.protocolShare.toLocaleString()} bps</span>
                    </dd>
                    <LadderSpanRows span={span} />
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

// ------------------------------------------------------------------ ladder

/**
 * What each of the five band limits means, in the terms a creator can act on.
 *
 * A band's width is the first thing anyone asks about a config and the least
 * self-explanatory, because the number that moves it — the bin step — moves it
 * *inversely* and for two entirely different reasons at the two ends of the
 * step range. Naming the binding limit is what makes the readout actionable
 * rather than merely honest.
 */
const LIMIT_REASON: Record<BandLimit, string> = {
  price: "the Q64.64 price envelope, ±2^60 — about 36 decades, whatever the step",
  "step-too-wide": "bins reach the 400 bps cap; widths grow going down under a taper",
  "step-too-fine": "bins reach the 0.01 bps floor; widths shrink going up under a taper",
  resolution: "adjacent bins would round onto the same Q64.64 price",
  bitmap: "the pool's inline bitmap, which only addresses bins ±35,840"
};

/** A price ratio as a power of ten, since these run from 1e-17 to 1e18. */
const decades = (n: number) =>
  n >= 1e6 || n < 1e-6 ? `10^${Math.log10(n).toFixed(1)}` : fmtPrice(n);

/**
 * The whole of what a ladder addresses: bins, price, and what stops it.
 *
 * Shared by the three places a ladder is shown — a config on chain, a preset
 * about to be published, and a draft being typed — because the question is the
 * same in all three and an answer that differed between them would read as a
 * disagreement rather than as three views.
 *
 * The prices are **ratios**, deliberately unlabelled by token: a config is
 * pair-agnostic, and bin 0 is 1.0 Y-lamport per X-lamport. What a pair's
 * decimals shift is both endpoints together, so `span` — the distance between
 * them — is the number that carries across pairs, and it is the one shown
 * first.
 */
function LadderSpanRows({ span, detailed }: { span: LadderSpan; detailed?: boolean }) {
  const uniform = !Number.isFinite(span.priceCeiling);
  return (
    <>
      <dt>usable band</dt>
      <dd className="mono">
        {span.bins.toLocaleString()} bins ({span.minBinId.toLocaleString()} to{" "}
        {span.maxBinId.toLocaleString()})
      </dd>
      <dt>price span</dt>
      <dd className="mono">
        10^{span.decades.toFixed(1)} ×{detailed && <> — {decades(span.minPrice)} to {decades(span.maxPrice)}</>}
      </dd>
      <dt>bins per 10× move</dt>
      <dd className="mono">{Math.round(span.binsPerDecadeAtAnchor).toLocaleString()} at the anchor</dd>
      <dt>bin width</dt>
      <dd className="mono">
        {(span.widestStepBpX100 / 100).toFixed(2)} bps at the floor →{" "}
        {(span.narrowestStepBpX100 / 100).toFixed(2)} bps at the top
      </dd>
      <dt>price ceiling</dt>
      <dd className="mono">{uniform ? "none — uniform" : decades(span.priceCeiling)}</dd>
      {detailed && (
        <>
          <dt>band floor set by</dt>
          <dd className="mono">
            <span className="why">{LIMIT_REASON[span.floorLimit]}</span>
          </dd>
          <dt>band top set by</dt>
          <dd className="mono">
            <span className="why">{LIMIT_REASON[span.ceilingLimit]}</span>
          </dd>
          <dt>bin arrays to cover it</dt>
          <dd className="mono">{span.binArrays.toLocaleString()} × 6,792 B of rent, if every bin were used</dd>
        </>
      )}
    </>
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
  /**
   * The taper is one number, and the dial and the half-life box both write it.
   *
   * Keeping `strength` as the state rather than a half-life is what makes
   * "uniform" a position on the dial instead of a mode beside it: strength 0
   * is τ = 1 exactly, so a pool opted out of the taper is the same
   * `MAX_TAPER_Q64` the DLMM-equivalence guards check for. Storing the
   * half-life instead would need `Infinity` in a number input.
   */
  const [strength, setStrength] = useState(() => strengthForHalfLife(4_000));
  const [band, setBand] = useState<{ min: number; max: number }>();
  const [schedule, setSchedule] = useState<FeeSchedule>(() => feeScheduleOf(buildConfig(0, 50, 4_000)));
  const [busy, setBusy] = useState(false);

  const halfLife = halfLifeForStrength(strength);
  const uniform = strength <= 0;
  /**
   * Both controls clamp to the dial's own ends, so neither can put the other
   * out of range. A typed half-life below the reference is the only way that
   * could happen, and silently accepting it would leave the slider pinned at
   * an end while the ladder kept moving underneath it.
   */
  const setTaper = (next: number) =>
    setStrength(Number.isFinite(next) ? Math.min(Math.max(next, 0), 1) : 0);

  /**
   * The whole draft, or the reason there isn't one. `buildConfig` throws when
   * the step and taper leave no usable band at all, which is a legitimate
   * answer to a legitimate question, not a crash.
   */
  type Draft =
    | { ok: false; error: string }
    | { ok: true; params: ConfigParams; span: LadderSpan; problems: string[] };

  const draft = useMemo<Draft>(() => {
    if (!(bps > 0)) {
      return { ok: false, error: "Enter a positive step at the anchor." };
    }
    let base: ConfigParams;
    try {
      base = buildConfig(index, bps, halfLife, schedule);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    const span = ladderSpan(base.baseWidthQ64, base.taperQ64);
    const params: ConfigParams = {
      ...base,
      minBinId: band?.min ?? span.minBinId,
      maxBinId: band?.max ?? span.maxBinId
    };
    return { ok: true, params, span, problems: validateConfig(params) };
  }, [index, bps, halfLife, band, schedule]);

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
          showHint
          hint="Per-authority preset index; part of the config address. Yours to number as you like."
        />
        <Field
          label="Step at anchor (bps)"
          value={bps}
          min={0.01}
          max={400}
          step={1}
          onChange={setBps}
          showHint
          hint="How much price one bin covers at bin 0 (price 1.0). It is the resolution the ladder trades in, and it also anchors the fee: the base fee is a whole-number multiple of this width, so changing it moves the fee at rest in the schedule below."
        />
      </div>

      <Slider
        label="Taper"
        value={strength}
        min={0}
        max={1}
        step={0.005}
        onChange={setTaper}
        readout={
          uniform
            ? "off — uniform, exactly DLMM"
            : `halves every ${Math.round(halfLife).toLocaleString()} bins`
        }
        ends={["uniform (τ = 1)", "tightest"]}
        hint="How fast a bin's width decays going up the ladder. At zero every bin is the same width and the ladder is DLMM's; turning it up makes bins coarse where the token is cheap and fine where it is expensive — paid for with a price ceiling, since the widths then form a convergent series."
      />

      <div className="form-grid">
        <Field
          label="Half-life (bins)"
          value={uniform ? 0 : Math.round(halfLife)}
          min={0}
          onChange={(v) => setTaper(strengthForHalfLife(v))}
          showHint
          hint={`The dial written the other way round: bins over which a bin's width halves. 0 means uniform — it never halves — and ${TAPER_STRENGTH_REF_BINS} is the tightest the dial goes.`}
        />
        <Field
          label="τ (read-only)"
          value={Number((Number(taperForStrength(strength)) / 2 ** 64).toFixed(8))}
          step={0.00000001}
          disabled
          onChange={() => {}}
          showHint
          hint="What the config actually stores, alongside w0. Both are fixed at publication."
        />
      </div>

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
            <LadderSpanRows span={draft.span} detailed />
          </dl>
          <p className="hint">
            The band is the widest run of bins whose arithmetic stays sound, and it is quoted in{" "}
            <em>bins</em> while every limit that sets it is a limit on <em>price</em>. So a coarser step
            always buys fewer bins over the same amount of price — halving the step roughly doubles the bin
            count and leaves the span where it was. Prices here are ratios of Y-lamports to X-lamports; a
            pair's decimals slide both ends together and leave the span alone.
          </p>

          <div className="form-grid">
            <Field
              label="Lower bin"
              value={draft.params.minBinId}
              onChange={(v) => setBand({ min: v, max: draft.params.maxBinId })}
              showHint
              hint="Defaults to the widest band this ladder supports. A narrower band can be widened later; it can never be narrowed, because the dropped bins would keep their liquidity and never trade again."
            />
            <Field
              label="Upper bin"
              value={draft.params.maxBinId}
              onChange={(v) => setBand({ min: draft.params.minBinId, max: v })}
              showHint
              hint="Defaults to the widest band this ladder supports. Narrowing costs nothing but choice — bin arrays are rented as they are touched, not up front."
            />
          </div>

          <details className="advanced">
            <summary>Fee schedule</summary>
            <FeeFields value={schedule} stepBpX100={ladder.stepBpX100(0)} onChange={setSchedule} />
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
  const span = ladderSpan(config.view.baseWidthQ64, config.view.taperQ64);
  const [usableMin, usableMax] = [span.minBinId, span.maxBinId];

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

      <FeeFields
        value={schedule}
        stepBpX100={ladder.stepBpX100(0)}
        onChange={setSchedule}
        disabled={busy}
      />
      <FeePreview stepBpX100={ladder.stepBpX100(0)} schedule={schedule} />

      <div className="form-grid">
        <Field
          label="Lower bin"
          value={band.min}
          max={config.view.minBinId}
          disabled={busy}
          showHint
          onChange={(v) => setBand({ ...band, min: v })}
          hint={`Widen only. This ladder supports down to ${usableMin.toLocaleString()}, where ${LIMIT_REASON[span.floorLimit]} stops it.`}
        />
        <Field
          label="Upper bin"
          value={band.max}
          min={config.view.maxBinId}
          disabled={busy}
          showHint
          onChange={(v) => setBand({ ...band, max: v })}
          hint={`Widen only. This ladder supports up to ${usableMax.toLocaleString()}, where ${LIMIT_REASON[span.ceilingLimit]} stops it.`}
        />
      </div>

      <dl className="readout">
        <LadderSpanRows span={span} detailed />
      </dl>
      <p className="hint">
        The band above is what this config trades over today; the rows here are the most the ladder could
        ever be widened to. Widening is free and reversible in one direction only — a bin dropped from the
        band keeps its liquidity and is still withdrawable, but no swap crosses it again, which is why the
        program refuses to narrow.
      </p>

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
