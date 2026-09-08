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

/**
 * A dollar amount, across the four orders of magnitude a wallet list spans.
 *
 * Zero is a dash rather than "$0.00" because it is nearly always "no price
 * known" rather than "worth nothing", and the two should not look the same.
 */
export function usd(value: number) {
  if (!Number.isFinite(value) || value === 0) return "—";
  const magnitude = Math.abs(value);
  if (magnitude < 0.01) return "<$0.01";
  if (magnitude >= 1_000_000)
    return `$${value.toLocaleString(undefined, { notation: "compact", maximumFractionDigits: 1 })}`;
  return `$${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

/**
 * A number as something an input field can hold and `Number()` will take back.
 *
 * `price` below is for reading and groups thousands, which makes its output
 * useless as a field value. This keeps significant digits instead of decimal
 * places, because the prices it formats run from 1e-9 to 1e5 and a fixed
 * number of decimals is wrong at both ends.
 */
export function plain(n: number, significant = 8) {
  if (!Number.isFinite(n) || n === 0) return "0";
  const fixed = n.toPrecision(significant);
  // An exponent is left alone: `Number()` reads it back, and writing 1e-9 out
  // in full is a field nobody can check at a glance.
  return fixed.includes("e") ? fixed : fixed.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

export function price(p: number) {
  if (!Number.isFinite(p)) return "∞";
  if (p === 0) return "0";
  if (p >= 1e9 || p < 1e-6) return p.toExponential(4);
  return p.toLocaleString(undefined, { maximumFractionDigits: 8, minimumSignificantDigits: 1 });
}

/**
 * A fee rate against `FEE_PRECISION`, in the bps a trader would recognise.
 *
 * bps is the unit a config is *typed* in — the base factor multiplies a bin
 * width quoted in hundredths of one — so it is the unit that connects a fee
 * back to the field that set it.
 */
export const feeBps = (rate: number) => rate / (FEE_PRECISION / 10_000);

/**
 * A number of bps as a percentage, at the precision that number needs.
 *
 * The range is four orders of magnitude — a 0.01 bps bin under a base factor
 * of 1 against the 10% cap — so a fixed number of decimals is wrong at one end
 * or the other. Trailing zeros are dropped because "25%" and "25.00%" say the
 * same thing and only one of them reads as a rounded figure.
 */
export function percentOfBps(bps: number) {
  if (!Number.isFinite(bps)) return "—";
  const pct = bps / 100;
  if (pct === 0) return "0%";
  if (Math.abs(pct) < 0.0001) return "<0.0001%";
  const digits = Math.abs(pct) >= 1 ? 2 : Math.abs(pct) >= 0.01 ? 3 : 5;
  return `${Number(pct.toFixed(digits))}%`;
}

/** A fee rate against `FEE_PRECISION`, as a percentage of the trade. */
export const feePercent = (rate: number) => percentOfBps(feeBps(rate));

/**
 * The same thing as a plain number, for a field to hold rather than print.
 *
 * Trimmed to six significant figures because the rate is an integer and the
 * division is not: without it a fee of exactly half a percent reaches the box
 * as `0.49999999999999994`, and the box shows it.
 */
export const feePercentValue = (rate: number) => Number(((rate / FEE_PRECISION) * 100).toPrecision(6));

/** The inverse — a typed percentage as a rate against `FEE_PRECISION`. */
export const rateFromPercent = (percent: number) =>
  Math.round(((Number.isFinite(percent) ? percent : 0) / 100) * FEE_PRECISION);

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
