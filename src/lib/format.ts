/** Number and address formatting. Nothing here touches the chain. */
import { FEE_PRECISION } from "taper-amm-sdk";

export const shortAddress = (address: string, lead = 4, tail = 4) =>
  address.length <= lead + tail + 1 ? address : `${address.slice(0, lead)}…${address.slice(-tail)}`;

/** A raw token amount as a decimal string. */
export function amount(raw: bigint, decimals: number, maxFractionDigits = 6) {
  const n = Number(raw) / 10 ** decimals;
  if (n === 0) return "0";
  if (Math.abs(n) < 10 ** -maxFractionDigits) return n.toExponential(2);
  return n.toLocaleString(undefined, { maximumFractionDigits: maxFractionDigits });
}

/**
 * A raw amount as a plain decimal string: no separators, no rounding.
 *
 * `amount` is for reading and goes through `toLocaleString`, which groups
 * thousands — so its output is not something `toRaw` will take back. This is
 * the one to put in an input field, and it round-trips exactly.
 */
export function exact(raw: bigint, decimals: number) {
  if (decimals === 0) return raw.toString();
  const negative = raw < 0n;
  const digits = (negative ? -raw : raw).toString().padStart(decimals + 1, "0");
  const fraction = digits.slice(-decimals).replace(/0+$/, "");
  return `${negative ? "-" : ""}${digits.slice(0, -decimals)}${fraction ? `.${fraction}` : ""}`;
}

/** A decimal string back to raw units, without going through `Number`. */
export function toRaw(input: string, decimals: number): bigint {
  const trimmed = input.trim();
  if (!trimmed) return 0n;
  if (!/^\d*\.?\d*$/.test(trimmed)) throw new Error(`"${input}" is not a number`);
  const [whole, fraction = ""] = trimmed.split(".");
  if (fraction.length > decimals) {
    throw new Error(`Too many decimal places: this mint has ${decimals}`);
  }
  return BigInt((whole || "0") + fraction.padEnd(decimals, "0"));
}

export function price(p: number) {
  if (!Number.isFinite(p)) return "∞";
  if (p === 0) return "0";
  if (p >= 1e9 || p < 1e-6) return p.toExponential(4);
  return p.toLocaleString(undefined, { maximumFractionDigits: 8, minimumSignificantDigits: 1 });
}

/** A fee rate against `FEE_PRECISION`, as a percentage. */
export const feePercent = (rate: number) => `${((rate / FEE_PRECISION) * 100).toFixed(4)}%`;

/** A bin's stored width, in basis points. */
export const stepBps = (stepBpX100: number) => stepBpX100 / 100;

export const compactNumber = (n: number) =>
  Math.abs(n) >= 1000 ? n.toLocaleString(undefined, { notation: "compact", maximumFractionDigits: 1 }) : n.toString();

export function timeAgo(unixSeconds: bigint | number) {
  const seconds = Math.floor(Date.now() / 1000) - Number(unixSeconds);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
