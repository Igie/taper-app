/**
 * The ladder presets this deployment publishes, and who may publish them.
 *
 * `initialize_config` is permissionless on chain — anyone can create a config
 * at `[b"config", authority, index]`. That is a deliberate property of the
 * program, but it is a sharp edge for a user: a config's authority collects
 * the protocol's share of every fee in every pool built on it, and can disable
 * those pools. So this app *shows* every config it finds and *offers to
 * create* one only to the deployment's own authority.
 *
 * The gate is presentational. It is not a security boundary and is not
 * pretending to be one — anyone can call `initializeConfigIx` from the SDK.
 * What it buys is that a user clicking through this app ends up in a pool
 * whose authority is named on screen.
 */
import { PublicKey } from "@solana/web3.js";
import { configPda } from "taper-amm-sdk";
import { PRESETS, type Preset } from "./preset-defs";

export { PRESETS, presetParams, type Preset } from "./preset-defs";

/**
 * The authority whose configs this deployment treats as its own.
 *
 * Set `VITE_TAPER_ADMIN` at build time. Unset, the app still works: it just
 * labels nothing as official and never offers config creation.
 */
export const ADMIN_AUTHORITY = (() => {
  const raw = import.meta.env.VITE_TAPER_ADMIN as string | undefined;
  if (!raw) return undefined;
  try {
    return new PublicKey(raw);
  } catch {
    console.warn(`VITE_TAPER_ADMIN is not a valid address: ${raw}`);
    return undefined;
  }
})();

export const isAdmin = (key: PublicKey | null | undefined) =>
  Boolean(key && ADMIN_AUTHORITY && key.equals(ADMIN_AUTHORITY));

/** Where a preset lives, once the admin has published it. */
export const presetAddress = (preset: Preset) =>
  ADMIN_AUTHORITY ? configPda(ADMIN_AUTHORITY, preset.index) : undefined;

/** The preset a config account corresponds to, if it is one of ours. */
export function presetFor(authority: PublicKey, index: number) {
  if (!ADMIN_AUTHORITY || !authority.equals(ADMIN_AUTHORITY)) return undefined;
  return PRESETS.find((p) => p.index === index);
}
