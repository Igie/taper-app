/**
 * The fee-schedule half of a config, shared by the create and edit panels.
 *
 * Split out because the two panels differ only in what surrounds these
 * fields: creation also picks the ladder, which is fixed for good once the
 * config exists. Keeping one copy means the hints — the part that actually
 * explains what a number does — cannot drift between them.
 *
 * **Everything here is typed as a percentage of the trade and stored as a
 * factor.** A base factor, a variable fee control and an accumulator ceiling
 * are quantities the program finds convenient and nobody decides a pool in;
 * what a creator actually knows is "half a percent at rest, ten when it is
 * moving, thirty-five bins to get there". The solves live in the SDK
 * (`baseFeeFactorsFor`, `variableFeeControlFor`) because they are pure
 * inverses of the ABI — what stays here is which question to ask. Every field
 * prints the stored number beside it, so a config typed in this form can
 * still be checked against the chain.
 */
import { useState } from "react";
import {
  accumulatorForBins,
  baseFeeFactorsFor,
  binsToFeeCap,
  binsToFeePeak,
  feeRateForStep,
  MAX_FEE_RATE,
  MAX_PROTOCOL_SHARE,
  variableFeeControlFor,
  VOLATILITY_PER_BIN,
  type ConfigParams
} from "taper-amm-sdk";
import { feeBps, feePercent, feePercentValue, percentOfBps, rateFromPercent } from "../lib/format";
import { Field, Segmented } from "./primitives";

/** Exactly the fields `update_config` can move, minus the band. */
export type FeeSchedule = Pick<
  ConfigParams,
  | "baseFactor"
  | "baseFeePowerFactor"
  | "protocolShare"
  | "collectFeeMode"
  | "filterPeriod"
  | "decayPeriod"
  | "reductionFactor"
  | "variableFeeControl"
  | "maxVolatilityAccumulator"
>;

export const FEE_SCHEDULE_KEYS = [
  "baseFactor",
  "baseFeePowerFactor",
  "protocolShare",
  "collectFeeMode",
  "filterPeriod",
  "decayPeriod",
  "reductionFactor",
  "variableFeeControl",
  "maxVolatilityAccumulator"
] as const satisfies readonly (keyof FeeSchedule)[];

export const feeScheduleOf = (config: FeeSchedule): FeeSchedule => ({
  baseFactor: config.baseFactor,
  baseFeePowerFactor: config.baseFeePowerFactor,
  protocolShare: config.protocolShare,
  collectFeeMode: config.collectFeeMode,
  filterPeriod: config.filterPeriod,
  decayPeriod: config.decayPeriod,
  reductionFactor: config.reductionFactor,
  variableFeeControl: config.variableFeeControl,
  maxVolatilityAccumulator: config.maxVolatilityAccumulator
});

/** The dynamic fee needs both halves; either one at zero turns it off. */
export const dynamicFeeIsOn = (schedule: FeeSchedule) =>
  schedule.variableFeeControl > 0 && schedule.maxVolatilityAccumulator > 0;

const bins = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 1 });
const num = (v: number, fallback = 0) => (Number.isFinite(v) ? v : fallback);
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/** Whether a solve landed on what was asked, at a tolerance a form cares about. */
const met = (got: number, want: number) => Math.abs(got - want) <= Math.max(0.0005, want * 0.001);

/**
 * Whether the cap binds early enough to be worth saying so.
 *
 * `binsToFeeCap` answers exactly, and asking for a peak *of* the cap — which
 * is the obvious thing to type — makes the answer the last bin of the window.
 * A flat stretch that short is an artefact of the solve rather than a shape
 * anyone chose, and reporting it prints "it caps after 35 bins, short of the
 * 35 the window allows".
 */
const capsEarly = (toCap: number | undefined, toPeak: number): toCap is number =>
  toCap !== undefined && toCap < toPeak * 0.99;

/**
 * A rate against `FEE_PRECISION`, as a percentage with the bps beside it.
 *
 * Percent leads because that is the unit the schedule is now *typed* in, and
 * a summary that led with the other one would be asking the reader to convert
 * back to check what they entered. bps stays, dimmed: it is the unit a fee is
 * quoted in everywhere else in this market, and dropping it would make this
 * app the odd one out.
 */
export function FeeRate({ rate, note }: { rate: number; note?: string }) {
  return (
    <>
      {percentOfBps(feeBps(rate))} <span className="alt">{feeBps(rate).toFixed(2)} bps</span>
      {note && <span className="why">{note}</span>}
    </>
  );
}

/** One `dt`/`dd` pair of a fee readout. */
function FeeRow({ label, rate, note }: { label: string; rate: number; note?: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd className="mono">
        <FeeRate rate={rate} note={note} />
      </dd>
    </>
  );
}

/**
 * A number typed in one unit while the config stores another.
 *
 * The typed value is the state and the stored one is derived, never the other
 * way round: the solve rounds, so re-deriving "1" from the factor it produced
 * can give back 0.9998, and a field that rewrites itself under the cursor is
 * unusable. The stored value is still the authority — when it moves for a
 * reason other than this field's own keystroke (a reset, a different config, a
 * changed anchor step) the typed number is stale and adopts it.
 *
 * The same shape as the taper dial in `Configs`, and for the same reason: hold
 * what the user is choosing, derive what the chain is told.
 */
function useTypedAgainst(stored: number, read: (stored: number) => number) {
  const [state, setState] = useState(() => ({ stored, typed: read(stored) }));
  if (state.stored !== stored) setState({ stored, typed: read(stored) });
  return [
    state.stored === stored ? state.typed : read(stored),
    (typed: number, next: number) => setState({ stored: next, typed })
  ] as const;
}

export function FeeFields({
  value,
  stepBpX100,
  onChange,
  disabled
}: {
  value: FeeSchedule;
  /**
   * The bin width the fees are quoted at — the anchor's, by convention.
   * A fee is a function of the *bin*, not of the pool, so "one percent" has no
   * meaning until a width is named: the factor solved here charges that at the
   * anchor, and the wider bins below it charge more.
   */
  stepBpX100: number;
  onChange: (next: FeeSchedule) => void;
  disabled?: boolean;
}) {
  // A zero accumulator zeroes the variable term outright, so the first of
  // these is the base fee alone and the second is the whole schedule's top.
  const atRest = feeRateForStep(stepBpX100, value, 0);
  const atPeak = feeRateForStep(stepBpX100, value, value.maxVolatilityAccumulator);
  const dynamic = dynamicFeeIsOn(value);

  const [restPct, setRestPct] = useTypedAgainst(atRest, feePercentValue);
  const [peakPct, setPeakPct] = useTypedAgainst(atPeak, feePercentValue);
  const [sharePct, setSharePct] = useTypedAgainst(value.protocolShare, (bps) => bps / 100);
  const [carryPct, setCarryPct] = useTypedAgainst(value.reductionFactor, (bps) => bps / 100);
  const [windowBins, setWindowBins] = useTypedAgainst(value.maxVolatilityAccumulator, (va) =>
    binsToFeePeak({ maxVolatilityAccumulator: va })
  );

  /**
   * Solve the stored factors for a rest/peak pair.
   *
   * Both are re-solved whichever one moved, because the peak is quoted as a
   * *total* while the control only supplies the difference: raising the fee at
   * rest with the control left alone would carry the peak up with it, and the
   * pair the user stated would quietly stop holding.
   */
  const aim = (next: FeeSchedule, rest: number, peak: number) => {
    const withBase = { ...next, ...baseFeeFactorsFor(rateFromPercent(rest), stepBpX100) };
    const baseRate = feeRateForStep(stepBpX100, withBase, 0);
    const out: FeeSchedule = {
      ...withBase,
      variableFeeControl: variableFeeControlFor(
        rateFromPercent(peak),
        baseRate,
        withBase.maxVolatilityAccumulator,
        stepBpX100
      )
    };
    setRestPct(rest, baseRate);
    setPeakPct(peak, feeRateForStep(stepBpX100, out, out.maxVolatilityAccumulator));
    onChange(out);
  };

  const restMet = met(feePercentValue(atRest), restPct);
  // A peak at or under the fee at rest is the off switch, not a miss.
  const peakMet = peakPct <= restPct || met(feePercentValue(atPeak), peakPct);

  return (
    <>
      <div className="form-grid">
        <Field
          label="Fee at rest (%)"
          value={restPct}
          min={0}
          step={0.05}
          disabled={disabled}
          showHint
          readout={`${feeBps(atRest).toFixed(2)} bps`}
          onChange={(v) => aim(value, num(v), peakPct)}
          hint={`What a swap pays when the price has been sitting still. Stored as a base factor of ${value.baseFactor.toLocaleString()}${
            value.baseFeePowerFactor ? ` at ×10^${value.baseFeePowerFactor}` : ""
          }, which the program multiplies by each bin's own width — so this is the fee at the anchor, and the wider bins below it charge more.`}
        />
        <Field
          label="Fee at peak (%)"
          value={peakPct}
          min={0}
          step={0.5}
          disabled={disabled}
          showHint
          readout={dynamic ? `${feeBps(atPeak).toFixed(2)} bps` : "off"}
          onChange={(v) => aim(value, restPct, num(v))}
          hint={`What a swap pays once the price has run the whole volatility window. Stored as a variable fee control of ${value.variableFeeControl.toLocaleString()}. Set it to the fee at rest, or under it, to switch the dynamic fee off.`}
        />
        <Field
          label="Volatility window (bins)"
          value={windowBins}
          min={0}
          step={1}
          disabled={disabled}
          showHint
          readout={`accumulator ${value.maxVolatilityAccumulator.toLocaleString()}`}
          onChange={(v) => {
            const maxVolatilityAccumulator = accumulatorForBins(Math.max(num(v), 0));
            setWindowBins(num(v), maxVolatilityAccumulator);
            aim({ ...value, maxVolatilityAccumulator }, restPct, peakPct);
          }}
          hint={`How far the price must travel from the reference to reach the peak fee. The program counts ${VOLATILITY_PER_BIN.toLocaleString()} per bin crossed and stores that ceiling, so this is the same number divided back out.`}
        />
      </div>

      {!restMet && (
        <p className="hint warn">
          The nearest fee at rest this ladder can charge is {feePercent(atRest)}. The base factor is
          a whole number times the bin&rsquo;s own width, so a {(stepBpX100 / 100).toFixed(2)} bps
          bin cannot express every rate — a finer step at the anchor buys finer fees.
        </p>
      )}
      {!peakMet && (
        <p className="hint warn">
          The fee at peak lands at {feePercent(atPeak)}
          {atPeak >= MAX_FEE_RATE
            ? `: ${percentOfBps(feeBps(MAX_FEE_RATE))} is the program's hard cap on a swap fee.`
            : ", the closest this window and step can reach."}
        </p>
      )}

      <div className="form-grid">
        <Field
          label={`Protocol share (%, max ${MAX_PROTOCOL_SHARE / 100})`}
          value={sharePct}
          min={0}
          max={MAX_PROTOCOL_SHARE / 100}
          step={0.5}
          disabled={disabled}
          showHint
          readout={`${value.protocolShare.toLocaleString()} bps of the fee`}
          onChange={(v) => {
            const bps = clamp(Math.round(num(v) * 100), 0, MAX_PROTOCOL_SHARE);
            setSharePct(num(v), bps);
            onChange({ ...value, protocolShare: bps });
          }}
          hint="The config authority's cut of every trading fee in every pool built on it. The rest goes to the LPs who were in the bin."
        />
        <div className="field">
          <span>Fee collection</span>
          <Segmented
            value={value.collectFeeMode}
            onChange={(v) => !disabled && onChange({ ...value, collectFeeMode: v })}
            options={[
              { id: 0, label: "Input token", hint: "Fee comes out of whichever token enters the swap, so LPs accrue both sides." },
              { id: 1, label: "Quote only", hint: "Fee is always denominated in Y. Launch-friendly when Y is SOL or USDC." }
            ]}
          />
        </div>
      </div>

      <div className="form-grid">
        <Field
          label="Filter period (s)"
          value={value.filterPeriod}
          min={0}
          max={65_535}
          disabled={disabled}
          showHint
          onChange={(v) => onChange({ ...value, filterPeriod: num(v) })}
          hint="Below this gap between swaps the volatility references are held steady, so a burst in one second does not keep resetting them."
        />
        <Field
          label="Decay period (s)"
          value={value.decayPeriod}
          min={0}
          max={65_535}
          disabled={disabled}
          showHint
          onChange={(v) => onChange({ ...value, decayPeriod: num(v) })}
          hint="After this much quiet the volatility references reset to zero. Must be at least the filter period."
        />
        <Field
          label="Carried over after decay (%)"
          value={carryPct}
          min={0}
          max={100}
          step={5}
          disabled={disabled}
          showHint
          readout={`${value.reductionFactor.toLocaleString()} bps`}
          onChange={(v) => {
            const bps = clamp(Math.round(num(v) * 100), 0, 10_000);
            setCarryPct(num(v), bps);
            onChange({ ...value, reductionFactor: bps });
          }}
          hint="How much of the accumulator survives a quiet spell longer than the filter period but shorter than the decay period."
        />
      </div>

      <DynamicFeeNote schedule={value} stepBpX100={stepBpX100} />
    </>
  );
}

/**
 * What the volatility numbers add up to, in prose.
 *
 * The form asks for two fees and a distance, which is the whole of what a
 * creator has to decide — but it says nothing about *when* the price counts as
 * moving, and that is what the remaining fields govern. Each has its own hint;
 * this says how they compose, which no single hint can carry. Folded away
 * because it explains rather than changes anything — the rule the rest of the
 * app follows.
 */
export function DynamicFeeNote({
  schedule,
  stepBpX100
}: {
  schedule: FeeSchedule;
  stepBpX100: number;
}) {
  const atRest = feeRateForStep(stepBpX100, schedule, 0);
  const atPeak = feeRateForStep(stepBpX100, schedule, schedule.maxVolatilityAccumulator);
  const dynamic = dynamicFeeIsOn(schedule);
  const toPeak = binsToFeePeak(schedule);
  const toCap = binsToFeeCap(schedule, stepBpX100);
  return (
    <details className="advanced">
      <summary>How the dynamic fee works</summary>
      <p className="hint">
        Every swap pays <strong>base + variable</strong>, capped at{" "}
        {percentOfBps(feeBps(MAX_FEE_RATE))} however the two are set. Both halves key off{" "}
        <em>the bin being crossed</em> rather than off a pool-wide step, because under a taper a bin
        is not a fixed price move: the same trade costs more down the ladder, where bins are wide,
        than up it.
      </p>
      <dl className="readout">
        <dt>base</dt>
        <dd className="mono">
          width × factor × 10^power ÷ 10
          <span className="why">
            fixed per bin — {feePercent(atRest)} at the anchor&rsquo;s{" "}
            {(stepBpX100 / 100).toFixed(2)} bps step
          </span>
        </dd>
        <dt>variable</dt>
        <dd className="mono">
          control × (accumulator × width)² ÷ 1e15
          <span className="why">
            quadratic in both, so distance costs far more than proportionally
          </span>
        </dd>
        <dt>accumulator</dt>
        <dd className="mono">
          {VOLATILITY_PER_BIN.toLocaleString()} per bin moved from the reference
          <span className="why">
            capped at {schedule.maxVolatilityAccumulator.toLocaleString()}, which is the{" "}
            {bins(toPeak)}-bin window
          </span>
        </dd>
      </dl>
      <p className="hint">
        The reference is re-anchored by <em>time</em>, not by trade. Swaps closer together than the
        filter period ({schedule.filterPeriod}s) leave it exactly where it was, so a burst inside one
        second cannot keep resetting it. After a gap longer than the decay period (
        {schedule.decayPeriod}s) it drops to zero and the pool is back to the fee at rest; in
        between, the carry-over keeps {percentOfBps(schedule.reductionFactor)} of the accumulator. So
        the variable fee is a memory of how far the price has travelled recently — not of how much
        volume traded, and not of any external feed.
      </p>
      <p className="hint">
        {dynamic ? (
          <>
            As set: a trade landing at rest pays {feePercent(atRest)}, and one arriving after the
            price has run {bins(toPeak)} bins pays {feePercent(atPeak)}
            {atRest > 0 && <> — {(atPeak / atRest).toFixed(1)}× as much</>}. The climb is slow at
            first and steep near the end, since the term is squared.{" "}
            {capsEarly(toCap, toPeak) ? (
              <>
                It meets the cap after about {bins(toCap)} bins, short of the {bins(toPeak)} the
                window allows — so the last stretch is flat, and what this schedule really says is{" "}
                {feePercent(atRest)} rising to the cap over {bins(toCap)} bins.
              </>
            ) : (
              <>
                Half that distance therefore costs a <em>quarter</em> of the extra, not half.
              </>
            )}
          </>
        ) : (
          <>
            As set, the dynamic fee is <strong>off</strong>: the fee at peak is not above the fee at
            rest, so every trade pays {feePercent(atRest)} whatever the price has been doing, and
            the window, the periods and the carry-over have no effect at all.
          </>
        )}
      </p>
    </details>
  );
}

/**
 * What the schedule actually costs a trader, at rest and at full volatility.
 *
 * Quoted at one bin's step because that is where the fee is decided: the width
 * is stored per bin, so there is no single pool-wide answer. The middle row is
 * not decoration — a schedule read at its two ends looks linear, and this one
 * is not.
 */
export function FeePreview({ stepBpX100, schedule }: { stepBpX100: number; schedule: FeeSchedule }) {
  const atRest = feeRateForStep(stepBpX100, schedule, 0);
  const halfway = feeRateForStep(
    stepBpX100,
    schedule,
    Math.floor(schedule.maxVolatilityAccumulator / 2)
  );
  const atPeak = feeRateForStep(stepBpX100, schedule, schedule.maxVolatilityAccumulator);
  const dynamic = dynamicFeeIsOn(schedule);
  const toPeak = binsToFeePeak(schedule);
  const toCap = binsToFeeCap(schedule, stepBpX100);
  return (
    <dl className="readout">
      <FeeRow label="fee at rest" rate={atRest} note="base fee alone" />
      {dynamic ? (
        <>
          <FeeRow
            label={`after ${bins(toPeak / 2)} bins moved`}
            rate={halfway}
            // True only where the climb is the whole story. Once the cap binds
            // the peak is no longer four times this one's extra, and the note
            // would be arithmetic the rows themselves disprove.
            note={
              capsEarly(toCap, toPeak) ? undefined : "a quarter of the extra: the term is squared"
            }
          />
          <FeeRow
            label={`at peak (${bins(toPeak)} bins moved)`}
            rate={atPeak}
            note={
              capsEarly(toCap, toPeak)
                ? `at the cap from ${bins(toCap)} bins on — flat past there`
                : undefined
            }
          />
        </>
      ) : (
        <>
          <dt>dynamic fee</dt>
          <dd className="mono">
            off
            <span className="why">the fee at peak is not above the fee at rest</span>
          </dd>
        </>
      )}
      <dt>of which protocol</dt>
      <dd className="mono">
        {percentOfBps(schedule.protocolShare)} of the fee{" "}
        <span className="alt">{schedule.protocolShare.toLocaleString()} bps</span>
      </dd>
    </dl>
  );
}
