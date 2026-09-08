/**
 * The fee-schedule half of a config, shared by the create and edit panels.
 *
 * Split out because the two panels differ only in what surrounds these
 * fields: creation also picks the ladder, which is fixed for good once the
 * config exists. Keeping one copy means the hints — the part that actually
 * explains what a number does — cannot drift between them.
 */
import { FEE_PRECISION, feeRateForStep, MAX_PROTOCOL_SHARE, type ConfigParams } from "taper-amm-sdk";
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

/** A fee rate against `FEE_PRECISION`, in the bps a trader would recognise. */
export const rateAsBps = (rate: number) => rate / (FEE_PRECISION / 10_000);

export function FeeFields({
  value,
  onChange,
  disabled
}: {
  value: FeeSchedule;
  onChange: (next: FeeSchedule) => void;
  disabled?: boolean;
}) {
  const set = <K extends keyof FeeSchedule>(key: K, v: FeeSchedule[K]) =>
    onChange({ ...value, [key]: v });

  return (
    <>
      <div className="form-grid">
        <Field
          label="Base factor"
          value={value.baseFactor}
          min={1}
          max={65_535}
          disabled={disabled}
          onChange={(v) => set("baseFactor", v)}
          hint="Multiplies each bin's own width to give its base fee. Under a taper the fee is per bin, not per pool."
        />
        <Field
          label="Fee power factor"
          value={value.baseFeePowerFactor}
          min={0}
          max={10}
          disabled={disabled}
          onChange={(v) => set("baseFeePowerFactor", v)}
          hint="An extra power of ten on the base fee, for steps too fine to express with the factor alone."
        />
        <Field
          label={`Protocol share (bps, max ${MAX_PROTOCOL_SHARE})`}
          value={value.protocolShare}
          min={0}
          max={MAX_PROTOCOL_SHARE}
          disabled={disabled}
          onChange={(v) => set("protocolShare", v)}
          hint="The config authority's cut of the trading fee, in bps of the fee. The rest goes to LPs."
        />
      </div>

      <div className="field">
        <span>Fee collection</span>
        <Segmented
          value={value.collectFeeMode}
          onChange={(v) => !disabled && set("collectFeeMode", v)}
          options={[
            { id: 0, label: "Input token", hint: "Fee comes out of whichever token enters the swap, so LPs accrue both sides." },
            { id: 1, label: "Quote only", hint: "Fee is always denominated in Y. Launch-friendly when Y is SOL or USDC." }
          ]}
        />
      </div>

      <div className="form-grid">
        <Field
          label="Filter period (s)"
          value={value.filterPeriod}
          min={0}
          max={65_535}
          disabled={disabled}
          onChange={(v) => set("filterPeriod", v)}
          hint="Below this gap between swaps the volatility references are held steady, so a burst in one second does not keep resetting them."
        />
        <Field
          label="Decay period (s)"
          value={value.decayPeriod}
          min={0}
          max={65_535}
          disabled={disabled}
          onChange={(v) => set("decayPeriod", v)}
          hint="After this much quiet the volatility references reset to zero. Must be at least the filter period."
        />
        <Field
          label="Reduction factor (bps)"
          value={value.reductionFactor}
          min={0}
          max={10_000}
          disabled={disabled}
          onChange={(v) => set("reductionFactor", v)}
          hint="How much of the accumulator survives a decay window, in bps."
        />
        <Field
          label="Variable fee control"
          value={value.variableFeeControl}
          min={0}
          disabled={disabled}
          onChange={(v) => set("variableFeeControl", v)}
          hint="Scales the squared-volatility term. Zero switches the variable fee off entirely."
        />
        <Field
          label="Max volatility accumulator"
          value={value.maxVolatilityAccumulator}
          min={0}
          disabled={disabled}
          onChange={(v) => set("maxVolatilityAccumulator", v)}
          hint="Ceiling on the accumulator, and so on the variable fee. Must be non-zero whenever the control is."
        />
      </div>
    </>
  );
}

/**
 * What the schedule actually costs a trader, at rest and at full volatility.
 *
 * Quoted at one bin's step because that is where the fee is decided: the
 * width is stored per bin, so there is no single pool-wide answer.
 */
export function FeePreview({ stepBpX100, schedule }: { stepBpX100: number; schedule: FeeSchedule }) {
  const atRest = feeRateForStep(stepBpX100, schedule, 0);
  const atPeak = feeRateForStep(stepBpX100, schedule, schedule.maxVolatilityAccumulator);
  return (
    <dl className="readout">
      <dt>fee at rest</dt>
      <dd className="mono">{rateAsBps(atRest).toFixed(2)} bps</dd>
      <dt>fee at peak volatility</dt>
      <dd className="mono">
        {rateAsBps(atPeak).toFixed(2)} bps
        {atPeak === atRest && schedule.variableFeeControl === 0 ? " — variable fee off" : ""}
      </dd>
      <dt>of which protocol</dt>
      <dd className="mono">{(schedule.protocolShare / 100).toFixed(1)}%</dd>
    </dl>
  );
}
