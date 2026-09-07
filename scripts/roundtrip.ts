/**
 * Jupiter routability probe: the TVL floor each ladder preset needs.
 *
 *   bun run --cwd app roundtrip
 *   bun run --cwd app roundtrip -- --json
 *
 * Jupiter drops a market from routing unless it passes **one** of two tests,
 * re-evaluated every thirty minutes:
 *
 *   A. a $500 round trip loses less than 30% — `($500 - final USD) / $500`
 *   B. the price impact of a $1,000 buy exceeds that of a $500 buy by less
 *      than 20 percentage points
 *
 * This matters more for Taper than for a uniform ladder. The taper widens bins
 * going down, and the base fee is a fixed multiple of the bin's own width, so
 * the fee rate is a property of *where in the band the pool is trading* rather
 * than of the pool. A round trip pays that rising schedule twice. A config
 * that is perfectly reasonable for LPs can be unroutable, and the only way to
 * find out before launch is to price it.
 *
 * Nothing here touches a cluster: `quoteSwap` is a pure function of pool
 * state, so the whole probe is arithmetic over synthetic states built from the
 * same `PRESETS` that `configs:init` publishes.
 *
 * ## What is assumed, and why
 *
 * Y is a six-decimal dollar stable and X the token being priced against it,
 * also six decimals, so a bin's Q64.64 price is both its lamport price and the
 * dollar price of one X. Active bins are only sampled where that price sits
 * between $0.001 and $1,000: outside that window a real deployment would have
 * chosen different mint decimals, and the dollar arithmetic here would stop
 * describing anything real.
 *
 * Liquidity is placed with `distribute` — the same shape the interface offers
 * — split half in each token at the active bin's price.
 */
import { PublicKey } from "@solana/web3.js";
import {
  Ladder,
  POOL_ENABLED,
  binArrayIndex,
  distribute,
  f64ToQ64,
  preview,
  quoteSwap,
  type BinView,
  type ConfigParams,
  type ConfigView,
  type PoolView,
  type Quote,
  type Shape
} from "@taper/sdk";
import { PRESETS, presetParams, type Preset } from "../src/lib/preset-defs";

const DECIMALS = 6;
const UNIT = 10 ** DECIMALS;
/** Fixed, so a run is reproducible. Any value works: nothing here decays. */
const NOW = 1_800_000_000;

const ROUND_TRIP_USD = 500;
const IMPACT_PROBE_USD = [500, 1_000] as const;
const MAX_ROUND_TRIP_LOSS = 0.3;
const MAX_IMPACT_SPREAD = 0.2;

const json = process.argv.includes("--json");

// ---- synthetic pool state ----

type Market = {
  pool: PoolView;
  config: ConfigView;
  bins: Map<number, BinView>;
  arrays: Set<number>;
  /** Y-lamports per X-lamport at the active bin, which is also X's price. */
  spot: number;
};

type Placement = {
  label: string;
  shape: Shape;
  /** Bins of liquidity either side of the active one. */
  reach: number;
};

function buildMarket(
  params: ConfigParams,
  activeId: number,
  placement: Placement,
  tvlUsd: number
): Market {
  const ladder = new Ladder(params.baseWidthQ64, params.taperQ64);
  const spot = ladder.price(activeId);

  const lower = Math.max(activeId - placement.reach, params.minBinId);
  const upper = Math.min(activeId + placement.reach, params.maxBinId);

  // Half the value in each token, valued at the active bin.
  const totalY = BigInt(Math.round((tvlUsd / 2) * UNIT));
  const totalX = BigInt(Math.round((tvlUsd / 2 / spot) * UNIT));
  const rows = preview(distribute(lower, upper, activeId, placement.shape), totalX, totalY);

  const bins = new Map<number, BinView>();
  const arrays = new Set<number>();
  for (const row of rows) {
    if (row.amountX === 0n && row.amountY === 0n) continue;
    const price = ladder.price(row.binId);
    bins.set(row.binId, {
      binId: row.binId,
      amountX: row.amountX,
      amountY: row.amountY,
      priceQ64: f64ToQ64(price),
      price,
      // The walk never reads the supply or the fee growth; only a position
      // claiming does, and nothing here holds one.
      liquiditySupply: 0n,
      feeXPerShare: 0n,
      feeYPerShare: 0n,
      stepBpX100: ladder.stepBpX100(row.binId),
      derived: true
    });
    arrays.add(binArrayIndex(row.binId));
  }

  const pool: PoolView = {
    config: PublicKey.default,
    tokenXMint: PublicKey.default,
    tokenYMint: PublicKey.default,
    reserveX: PublicKey.default,
    reserveY: PublicKey.default,
    creator: PublicKey.default,
    occupiedArrays: arrays,
    protocolFeeX: 0n,
    protocolFeeY: 0n,
    lastUpdateTimestamp: BigInt(NOW),
    activeId,
    indexReference: activeId,
    volatilityAccumulator: 0,
    volatilityReference: 0,
    status: POOL_ENABLED,
    tokenXFlag: 0,
    tokenYFlag: 0,
    tokenXDecimals: DECIMALS,
    tokenYDecimals: DECIMALS
  };

  return { pool, config: { ...params, authority: PublicKey.default }, bins, arrays, spot };
}

const swap = (m: Market, amountIn: bigint, swapForY: boolean) =>
  quoteSwap({
    pool: m.pool,
    config: m.config,
    bins: m.bins,
    hasArray: (index) => m.arrays.has(index),
    amountIn,
    swapForY,
    now: NOW
  });

/**
 * Moves the market on by a quote, so the next leg trades against what the
 * previous one left behind.
 *
 * Only inventory moves: the LP share of the fee lands as fee growth and the
 * protocol share on the pool, neither of which the walk reads back.
 */
function apply(m: Market, quote: Quote, swapForY: boolean) {
  for (const fill of quote.fills) {
    const bin = m.bins.get(fill.binId);
    if (!bin) continue;
    if (swapForY) {
      bin.amountX += fill.binIn;
      bin.amountY -= fill.binOut;
    } else {
      bin.amountY += fill.binIn;
      bin.amountX -= fill.binOut;
    }
  }
  Object.assign(m.pool, quote.state);
}

// ---- the two criteria ----

type Trip = {
  /** `($500 - final USD) / $500`. */
  loss: number;
  binsCrossed: number;
  /** The pool could not absorb the buy, or could not give the X back. */
  incomplete: boolean;
};

function roundTrip(params: ConfigParams, activeId: number, placement: Placement, tvl: number): Trip {
  const m = buildMarket(params, activeId, placement, tvl);
  const buy = swap(m, BigInt(Math.round(ROUND_TRIP_USD * UNIT)), false);
  if (buy.amountOut === 0n) return { loss: 1, binsCrossed: buy.binsCrossed, incomplete: true };
  apply(m, buy, false);

  const sell = swap(m, buy.amountOut, true);
  const finalUsd = Number(sell.amountOut) / UNIT;
  return {
    loss: (ROUND_TRIP_USD - finalUsd) / ROUND_TRIP_USD,
    binsCrossed: buy.binsCrossed,
    incomplete: buy.partial || sell.partial
  };
}

/**
 * Execution price over the spot price, minus one.
 *
 * A partial fill is infinite impact, not the good price of the piece that did
 * fill: a router that asked for $1,000 and was handed $300 of it has been told
 * the market is not there, and averaging over the filled part would hide
 * exactly the thinness this test exists to find.
 */
function priceImpact(params: ConfigParams, activeId: number, placement: Placement, tvl: number, usd: number) {
  const m = buildMarket(params, activeId, placement, tvl);
  const q = swap(m, BigInt(Math.round(usd * UNIT)), false);
  if (q.amountOut === 0n || q.partial) return Infinity;
  const executed = Number(q.amountIn) / Number(q.amountOut);
  return executed / m.spot - 1;
}

const impactSpread = (params: ConfigParams, activeId: number, placement: Placement, tvl: number) =>
  priceImpact(params, activeId, placement, tvl, IMPACT_PROBE_USD[1]) -
  priceImpact(params, activeId, placement, tvl, IMPACT_PROBE_USD[0]);

const passesA = (params: ConfigParams, activeId: number, placement: Placement, tvl: number) => {
  const trip = roundTrip(params, activeId, placement, tvl);
  return !trip.incomplete && trip.loss < MAX_ROUND_TRIP_LOSS;
};

const passesB = (params: ConfigParams, activeId: number, placement: Placement, tvl: number) => {
  const spread = impactSpread(params, activeId, placement, tvl);
  return Number.isFinite(spread) && Math.abs(spread) < MAX_IMPACT_SPREAD;
};

const FLOOR_MIN = 100;
const FLOOR_MAX = 1_000_000_000;

/**
 * Smallest TVL at which a criterion holds, by bisection in log space.
 *
 * Both criteria improve monotonically with depth — a deeper pool crosses fewer
 * bins, which is the whole of both numbers — so a bisection lands the boundary
 * rather than a local dip.
 */
function tvlFloor(ok: (tvl: number) => boolean) {
  if (ok(FLOOR_MIN)) return FLOOR_MIN;
  if (!ok(FLOOR_MAX)) return Infinity;
  let lo = FLOOR_MIN;
  let hi = FLOOR_MAX;
  while (hi / lo > 1.02) {
    const mid = Math.sqrt(lo * hi);
    if (ok(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}

// ---- where in the band to sample ----

const MIN_PLAUSIBLE_PRICE = 1e-3;
const MAX_PLAUSIBLE_PRICE = 1e3;

/**
 * The stretch of the band where a six-decimal pair against a dollar quote is
 * a believable market, as `[lowest, highest]` bin ids.
 *
 * `log2Price` is strictly increasing, so both ends bisect.
 */
function plausibleBand(ladder: Ladder, params: ConfigParams): [number, number] {
  const search = (target: number) => {
    let lo = params.minBinId;
    let hi = params.maxBinId;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (ladder.price(mid) < target) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const low = search(MIN_PLAUSIBLE_PRICE);
  const high = search(MAX_PLAUSIBLE_PRICE);
  return [Math.max(low, params.minBinId), Math.min(high, params.maxBinId)];
}

/** Three sample points across the plausible band, low to high. */
function samplePoints(ladder: Ladder, params: ConfigParams) {
  const [low, high] = plausibleBand(ladder, params);
  const at = (f: number) => Math.round(low + (high - low) * f);
  return [
    { name: "low", binId: at(0.15) },
    { name: "mid", binId: at(0.5) },
    { name: "high", binId: at(0.85) }
  ];
}

const PLACEMENTS: Placement[] = [
  { label: "spot  +/-30", shape: "spot", reach: 30 },
  { label: "spot  +/-100", shape: "spot", reach: 100 },
  { label: "curve +/-100", shape: "curve", reach: 100 }
];

// ---- report ----

const usd = (v: number) =>
  !Number.isFinite(v) ? "unreachable" : `$${Math.round(v).toLocaleString("en-US")}`;
const pct = (v: number) => (Number.isFinite(v) ? `${(v * 100).toFixed(2)}%` : "n/a");
const price = (v: number) => (v >= 0.01 && v < 10_000 ? v.toFixed(4) : v.toExponential(2));

type Row = {
  preset: string;
  where: string;
  binId: number;
  binPrice: number;
  stepBps: number;
  placement: string;
  /** Least TVL passing criterion A, and the round-trip loss there. */
  floorA: number;
  lossA: number;
  /** Least TVL passing criterion B, and the impact spread there. */
  floorB: number;
  spreadB: number;
  /** Bins the $500 buy crosses once the market is deep enough for B. */
  binsB: number;
  /** Jupiter routes on either, so this is the one that decides listing. */
  routes: number;
};

const rows: Row[] = [];

for (const p of PRESETS as Preset[]) {
  const params = presetParams(p);
  const ladder = new Ladder(params.baseWidthQ64, params.taperQ64);
  for (const point of samplePoints(ladder, params)) {
    for (const placement of PLACEMENTS) {
      const at = (tvl: number) => [params, point.binId, placement, tvl] as const;
      const floorA = tvlFloor((tvl) => passesA(...at(tvl)));
      const floorB = tvlFloor((tvl) => passesB(...at(tvl)));
      const probeA = Number.isFinite(floorA) ? floorA : FLOOR_MAX;
      const probeB = Number.isFinite(floorB) ? floorB : FLOOR_MAX;
      rows.push({
        preset: p.name,
        where: point.name,
        binId: point.binId,
        binPrice: ladder.price(point.binId),
        stepBps: ladder.stepBpX100(point.binId) / 100,
        placement: placement.label,
        floorA,
        lossA: roundTrip(...at(probeA)).loss,
        floorB,
        spreadB: impactSpread(...at(probeB)),
        binsB: roundTrip(...at(probeB)).binsCrossed,
        routes: Math.min(floorA, floorB)
      });
    }
  }
}

if (json) {
  console.log(JSON.stringify({ criteria: { MAX_ROUND_TRIP_LOSS, MAX_IMPACT_SPREAD }, rows }, null, 2));
  process.exit(0);
}

console.log("Jupiter routing criteria, priced against each published ladder preset.");
console.log(
  `  A  a $${ROUND_TRIP_USD} round trip loses under ${MAX_ROUND_TRIP_LOSS * 100}%\n` +
    `  B  the $${IMPACT_PROBE_USD[1]} buy's price impact exceeds the $${IMPACT_PROBE_USD[0]} buy's by under ` +
    `${MAX_IMPACT_SPREAD * 100} points\n` +
    "  A market routes if it passes either. The floor below is the least TVL that does.\n"
);

const HEAD = [
  ["band".padEnd(5), (r: Row) => r.where.padEnd(5)],
  ["bin".padStart(7), (r: Row) => String(r.binId).padStart(7)],
  ["price".padStart(11), (r: Row) => price(r.binPrice).padStart(11)],
  ["step".padStart(10), (r: Row) => `${r.stepBps.toFixed(2)}bp`.padStart(10)],
  ["liquidity".padStart(15), (r: Row) => r.placement.padStart(15)],
  ["floor A".padStart(11), (r: Row) => usd(r.floorA).padStart(11)],
  ["loss".padStart(8), (r: Row) => pct(r.lossA).padStart(8)],
  ["floor B".padStart(11), (r: Row) => usd(r.floorB).padStart(11)],
  ["spread".padStart(8), (r: Row) => pct(r.spreadB).padStart(8)],
  ["bins".padStart(6), (r: Row) => String(r.binsB).padStart(6)],
  ["routes at".padStart(11), (r: Row) => usd(r.routes).padStart(11)]
] as const;

let current = "";
for (const r of rows) {
  if (r.preset !== current) {
    current = r.preset;
    console.log(`\n${r.preset}`);
    console.log("  " + HEAD.map(([h]) => h).join(" "));
  }
  console.log("  " + HEAD.map(([, cell]) => cell(r)).join(" "));
}

const worstOf = (name: string, pick: (r: Row) => number) =>
  rows.filter((r) => r.preset === name).reduce((a, b) => (pick(b) > pick(a) ? b : a));

console.log("\nWorst case per preset, over every sampled band position and shape:");
console.log(
  `  ${"preset".padEnd(16)}${"listed above".padStart(14)}${"healthy above".padStart(16)}   where the worst case is`
);
for (const p of PRESETS as Preset[]) {
  const listing = worstOf(p.name, (r) => r.routes);
  const healthy = worstOf(p.name, (r) => r.floorB);
  console.log(
    `  ${p.name.padEnd(16)}${usd(listing.routes).padStart(14)}${usd(healthy.floorB).padStart(16)}` +
      `   ${healthy.where} of the band, ${healthy.placement.trim()}`
  );
}

console.log(
  "\nCriterion A is nearly free to pass and is not a depth test: a round trip through\n" +
    "a bin ladder walks back down the same bins it walked up, so the price impact is\n" +
    "recovered and only the fee is paid — twice. Its floor is essentially the point at\n" +
    `which the pool holds a little over $${ROUND_TRIP_USD} of the outbound token within reach.\n` +
    "Criterion B is the real one, and 'healthy above' is the number to launch against."
);

const unreachable = rows.filter((r) => !Number.isFinite(r.routes));
if (unreachable.length > 0) {
  console.log(
    `\n${unreachable.length} of ${rows.length} configurations never route at any TVL up to ${usd(FLOOR_MAX)}.`
  );
  process.exit(1);
}
