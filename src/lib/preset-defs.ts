/**
 * The ladder presets this deployment publishes.
 *
 * Kept free of `import.meta.env` so the bootstrap script can import it under
 * bun, outside Vite. Who may publish these lives in `presets.ts`, which is
 * browser-only.
 */
import { buildConfig, type ConfigParams } from "@taper/sdk";

export type Preset = {
  index: number;
  name: string;
  /** Bin step at the anchor, in basis points. */
  bps: number;
  /** Bins over which the width halves. `Infinity` is a uniform DLMM ladder. */
  halfLife: number;
  blurb: string;
  overrides?: Partial<ConfigParams>;
};

/**
 * Three shapes, chosen to span the interesting range rather than to be
 * exhaustive.
 *
 * The taper's cost is a price ceiling at `2^(w0/(1-tau))`, so a short
 * half-life buys coarse cheap bins at the price of a low ceiling. `Infinity`
 * is the degenerate case the README calls out: `tau = 1` is exactly DLMM, and
 * it is here so a pool can opt out of the taper entirely.
 */
export const PRESETS: Preset[] = [
  {
    index: 0,
    name: "Uniform",
    bps: 25,
    halfLife: Infinity,
    blurb:
      "Constant 25 bps bins, no taper. This is exactly DLMM's ladder, and the one to pick when a pair trades in a band rather than appreciating."
  },
  {
    index: 1,
    name: "Gentle taper",
    bps: 100,
    halfLife: 4_000,
    blurb:
      "100 bps at the anchor, halving every 4,000 bins. Wide enough to cover a long climb, with bins that tighten slowly as price rises."
  },
  {
    index: 2,
    name: "Launch taper",
    bps: 200,
    halfLife: 1_500,
    blurb:
      "200 bps at the anchor, tightening to about 6 bps at the top of its band. Coarse while a token is cheap — far fewer bins, and far less bin-array rent, to cover a launch range."
  }
];

export const presetParams = (preset: Preset): ConfigParams =>
  buildConfig(preset.index, preset.bps, preset.halfLife, preset.overrides);
