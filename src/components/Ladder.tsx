/**
 * The bin ladder.
 *
 * One column per bin. Height is the bin's liquidity measured the way the
 * program measures it — `L = P·x + y`, everything in Y — because comparing raw
 * token counts across bins of different price is meaningless. The X part is
 * drawn above the Y part so a glance shows the composition flip at the active
 * bin: pure Y below it, pure X above, mixed only where it trades.
 *
 * **The chart is one pane or three, and it is always the same height.** With
 * no position in view there is a single pane: the pool. Open a position and it
 * splits into *pool*, *position* and *unclaimed fees* — the same window, the
 * same bins, stacked. The panes divide the height the one pane had rather than
 * adding to it, so the panel below does not jump as the split appears.
 *
 * Alignment is structural rather than arithmetic. Every pane is one flex cell
 * per bin with the same 1px gap, and the tints, the active-bin marker and the
 * drag all live on a single overlay laid the same way across all of them — so
 * bin *n* is at the same x in every pane, the active bin is one line through
 * the lot, and nothing drifts over a 400-bin window the way percentage
 * positioning would.
 *
 * **Each pane carries its own scale.** A position is a rounding error beside
 * the pool it sits in and unclaimed fees are a rounding error beside the
 * position, so a shared axis would draw two flat lines. Each pane prints its
 * own peak in the corner, which is what makes the three readable *and* keeps
 * them honestly incomparable.
 *
 * The selected position's band is drawn over the bars as a tint with a hard
 * line at each edge, and again as a labelled rail beneath them. A band is not
 * the same thing as the bins it has liquidity in — an empty bin inside the band
 * is still yours to deposit into, and a band that has drifted away from the
 * active bin is the thing you want to see before you decide to move it. When an
 * edge falls outside the window drawn, the rail says so with an arrow rather
 * than capping at the wrong bin.
 *
 * Bin arrays are drawn as a band underneath, because *that* is what costs rent
 * and what a transaction has to carry. An array that has not been created is
 * hatched: bins inside it can be selected but nothing can be deposited there
 * until it exists.
 *
 * Adapted from the localnet console's chart. The difference that matters is
 * that this one serves arbitrary pairs, so the two sides have their own
 * decimals and the axis is scaled into human units.
 */
import { useMemo, useState } from "react";
import { BINS_PER_ARRAY, binArrayIndex, priceScale } from "taper-amm-sdk";
import { amount as fmtAmount, price as fmtPrice } from "../lib/format";

export type Cell = {
  binId: number;
  /** Lamport price, Y per X. Scaled for display, never for liquidity. */
  price: number;
  stepBpX100: number;
  feeRate: number;
  amountX: bigint;
  amountY: bigint;
  liquiditySupply: bigint;
  /** Non-zero only once the program has touched the bin. */
  derived: boolean;
  arrayIndex: number;
  arrayExists: boolean;
  arrayOccupied: boolean;
  /** This position's shares in the bin, when one is selected. */
  share?: bigint;
  /** This position's cut of the bin's balances — its shares priced out. */
  myAmountX?: bigint;
  myAmountY?: bigint;
  /** Checkpointed pending plus the growth not yet credited. */
  pendingFeeX?: bigint;
  pendingFeeY?: bigint;
};

type Props = {
  cells: Cell[];
  activeId: number;
  range?: { lower: number; upper: number };
  /** The selected position's band. Drawn, never selectable — the drag picks a range. */
  band?: { lower: number; upper: number };
  /**
   * Split the chart into pool / position / unclaimed fees.
   *
   * The caller decides, because "a position is in view" is a question about
   * the page rather than about the data: a wallet that holds a position here
   * is still only looking at the pool while it opens another one.
   */
  showPosition?: boolean;
  onSelectRange?: (lower: number, upper: number) => void;
  /**
   * Bins one drag may span.
   *
   * The selection is what the forms below aim at — a new position's band, a
   * move's target, a reshape's stretch — so this caps a *band*, not a
   * transaction: the planners cut a wide one into steps and say how many. It
   * is only mentioned in the legend when it is tighter than the window drawn,
   * since a cap a drag cannot reach is noise.
   */
  maxSelectable?: number;
  decimalsX: number;
  decimalsY: number;
  symbolX: string;
  symbolY: string;
};

/**
 * One bin's contribution to one pane: the whole bar, and how much of it is X.
 *
 * Both are in Y terms — `P·x + y` and `P·x` — so the split is a share of the
 * bar's own height whatever the pane happens to be measuring.
 */
type Bar = { total: number; xPart: number };

const bar = (x: bigint | undefined, y: bigint | undefined, price: number): Bar => {
  const xPart = Number(x ?? 0n) * price;
  return { total: xPart + Number(y ?? 0n), xPart };
};

const peakOf = (bars: Bar[]) => bars.reduce((max, b) => (b.total > max ? b.total : max), 0);

/**
 * A pane's peak, in Y terms, or nothing when there is none to state.
 *
 * These are `Number`s carried up from `u128` balances, so overflowing to
 * infinity is remote but possible — and `BigInt(Infinity)` throws, which would
 * take the whole chart down over a caption.
 */
const peakLabel = (peak: number, decimals: number) =>
  peak > 0 && Number.isFinite(peak) ? fmtAmount(BigInt(Math.round(peak)), decimals, 3) : undefined;

/**
 * One pane's bars.
 *
 * Purely presentational and `pointer-events: none`: the hit targets, the
 * hover, the drag and every tint are on the overlay spanning all the panes,
 * which is what keeps a bin one column through the whole chart.
 */
function Bars({ bars, peak, mine }: { bars: Bar[]; peak: number; mine?: boolean[] }) {
  const scale = Math.max(peak, 1);
  return (
    <div className="ladder-bars" aria-hidden="true">
      {bars.map((b, i) => {
        const height = b.total > 0 ? Math.max(2, (b.total / scale) * 100) : 0;
        const xPart = b.total > 0 ? (b.xPart * height) / b.total : 0;
        return (
          <div className={mine?.[i] ? "bar mine" : "bar"} key={i}>
            <div className="bin-stack">
              <span className="x" style={{ height: `${xPart}%` }} />
              <span className="y" style={{ height: `${height - xPart}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function Ladder({
  cells,
  activeId,
  band,
  range,
  showPosition = false,
  onSelectRange,
  maxSelectable = 70,
  decimalsX,
  decimalsY,
  symbolX,
  symbolY
}: Props) {
  const [hover, setHover] = useState<Cell>();
  const [drag, setDrag] = useState<{ anchor: number; head: number }>();

  // A lamport price is Y-lamports per X-lamport; a reader wants Y per X.
  const scale = priceScale(decimalsX, decimalsY);

  const series = useMemo(
    () => ({
      pool: cells.map((c) => bar(c.amountX, c.amountY, c.price)),
      mine: cells.map((c) => bar(c.myAmountX, c.myAmountY, c.price)),
      fees: cells.map((c) => bar(c.pendingFeeX, c.pendingFeeY, c.price))
    }),
    [cells]
  );
  const held = useMemo(() => cells.map((c) => !!c.share && c.share > 0n), [cells]);

  // While dragging, the preview range wins over the committed one.
  const shown = drag
    ? { lower: Math.min(drag.anchor, drag.head), upper: Math.max(drag.anchor, drag.head) }
    : range;

  const commit = () => {
    if (!drag || !onSelectRange) return setDrag(undefined);
    const lower = Math.min(drag.anchor, drag.head);
    const upper = Math.min(Math.max(drag.anchor, drag.head), lower + maxSelectable - 1);
    onSelectRange(lower, upper);
    setDrag(undefined);
  };

  // Array boundaries, for the band under the chart.
  const groups = useMemo(() => {
    const out: { index: number; span: number; exists: boolean; occupied: boolean }[] = [];
    for (const cell of cells) {
      const last = out[out.length - 1];
      if (last && last.index === cell.arrayIndex) last.span += 1;
      else
        out.push({
          index: cell.arrayIndex,
          span: 1,
          exists: cell.arrayExists,
          occupied: cell.arrayOccupied
        });
    }
    return out;
  }, [cells]);

  if (!cells.length) {
    return <div className="ladder empty-ladder">Nothing to draw yet.</div>;
  }

  // The window is one contiguous run, so an edge is either in it or off one
  // side. Which matters: capping the rail at the first drawn bin would draw a
  // band that ends where the fetch did.
  const windowLower = cells[0].binId;
  const windowUpper = cells[cells.length - 1].binId;
  const bandShown =
    band && band.upper >= windowLower && band.lower <= windowUpper
      ? {
          lower: Math.max(band.lower, windowLower),
          upper: Math.min(band.upper, windowUpper),
          lowerCapped: band.lower >= windowLower,
          upperCapped: band.upper <= windowUpper
        }
      : undefined;

  /*
   * The panes, and the share of the fixed height each takes.
   *
   * The weights are flex-grow inside a container of a fixed height, so the
   * three divide exactly what the one pane had. The pool keeps the most
   * because it is the shape the other two are read against, and fees the least
   * because what is read there is *which* bins earned rather than how much.
   */
  const panes = showPosition
    ? [
        { id: "pool", label: "pool", grow: 44, bars: series.pool, empty: "nothing in this window" },
        {
          id: "mine",
          label: "position",
          grow: 34,
          bars: series.mine,
          empty: "no liquidity in this window"
        },
        {
          id: "fees",
          label: "unclaimed fees",
          grow: 22,
          bars: series.fees,
          empty: "nothing unclaimed here"
        }
      ]
    : [
        {
          id: "pool",
          label: "pool",
          grow: 100,
          bars: series.pool,
          empty: "nothing in this window"
        }
      ];

  return (
    <div
      className="ladder"
      // Committing on leave as well as on release means a drag that ends off
      // the chart still lands, instead of stranding the selection.
      onMouseLeave={() => {
        setHover(undefined);
        commit();
      }}
      onMouseUp={commit}
    >
      {/* Bins run low to high left to right, so the price does too. */}
      <div className="ladder-scale">
        <span>{fmtPrice(cells[0].price * scale)}</span>
        <span className="dim">
          price ({symbolY} per {symbolX})
        </span>
        <span>{fmtPrice(cells[cells.length - 1].price * scale)}</span>
      </div>

      <div className="ladder-body">
        <div className={showPosition ? "ladder-panes split" : "ladder-panes"}>
          {panes.map((pane) => {
            const peak = peakOf(pane.bars);
            const label = peakLabel(peak, decimalsY);
            return (
              <div key={pane.id} className={`ladder-pane ${pane.id}`} style={{ flexGrow: pane.grow }}>
                <Bars
                  bars={pane.bars}
                  peak={peak}
                  // Worth outlining only while the position has no pane of its
                  // own; under one drawing the same bins it is the same fact
                  // twice, in the noisier of the two ways.
                  mine={showPosition ? undefined : held}
                />
                {showPosition && (
                  <div className="pane-tag" aria-hidden="true">
                    <span className="pane-name">{pane.label}</span>
                    {label ? (
                      <span className="pane-peak">
                        peak {label} {symbolY}
                      </span>
                    ) : (
                      <span className="pane-peak none">{pane.empty}</span>
                    )}
                  </div>
                )}
              </div>
            );
          })}

          {/*
            Every bin-wide mark — the hit target, the hover, the drag preview,
            the band tint, the uncreated-array hatch and the active-bin line —
            on one layer over the panes, laid out exactly as they are. So each
            runs the full height of the chart however many panes there are, and
            a bin stays one column through all of them.
          */}
          <div className="ladder-hit">
            {cells.map((cell) => {
              const inRange = shown && cell.binId >= shown.lower && cell.binId <= shown.upper;
              const inBand =
                bandShown && cell.binId >= bandShown.lower && cell.binId <= bandShown.upper;
              const classes = [
                "bin",
                cell.binId === activeId ? "active" : "",
                inRange ? "in-range" : "",
                inBand ? "in-band" : "",
                inBand && bandShown.lowerCapped && cell.binId === bandShown.lower ? "band-lower" : "",
                inBand && bandShown.upperCapped && cell.binId === bandShown.upper ? "band-upper" : "",
                cell.arrayExists ? "" : "uninit",
                hover?.binId === cell.binId ? "hover" : ""
              ]
                .filter(Boolean)
                .join(" ");

              return (
                <div
                  key={cell.binId}
                  className={classes}
                  onMouseEnter={() => {
                    setHover(cell);
                    if (drag) setDrag({ ...drag, head: cell.binId });
                  }}
                  onMouseDown={() =>
                    onSelectRange && setDrag({ anchor: cell.binId, head: cell.binId })
                  }
                />
              );
            })}
          </div>
        </div>

        {/*
          One cell per bin, laid out exactly as the bars are, so the rail lines
          up with them without any pixel arithmetic — the bars carry a 1px gap
          each, which percentage positioning over a 400-bin window would drift
          badly against.
        */}
        {bandShown && (
          <div className="ladder-band" aria-hidden="true">
            {cells.map((cell) => {
              const inBand = cell.binId >= bandShown.lower && cell.binId <= bandShown.upper;
              const isLower = inBand && cell.binId === bandShown.lower;
              const isUpper = inBand && cell.binId === bandShown.upper;
              return (
                <div key={cell.binId} className={inBand ? "band-cell on" : "band-cell"}>
                  {/* Caps and labels are their own spans so a one-bin band, which
                      is both edges at once, still draws both. */}
                  {isLower && bandShown.lowerCapped && <span className="band-cap lo" />}
                  {isUpper && bandShown.upperCapped && <span className="band-cap hi" />}
                  {isLower && (
                    <span className="band-label lo">
                      {bandShown.lowerCapped ? band!.lower : `← ${band!.lower}`}
                    </span>
                  )}
                  {isUpper && (
                    <span className="band-label hi">
                      {bandShown.upperCapped ? band!.upper : `${band!.upper} →`}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <div className="ladder-arrays">
          {groups.map((group, i) => (
            <div
              key={`${group.index}-${i}`}
              className={`array ${group.exists ? "" : "uninit"} ${group.occupied ? "occupied" : ""}`}
              style={{ flexGrow: group.span }}
              title={
                group.exists
                  ? `bin array ${group.index} — created${group.occupied ? ", holds liquidity" : ", empty"}`
                  : `bin array ${group.index} — not created; deposits here need it initialized first`
              }
            >
              <span>{group.index}</span>
            </div>
          ))}
        </div>
      </div>

      <footer className="ladder-legend">
        <span className="key x">{symbolX}</span>
        <span className="key y">{symbolY}</span>
        <span className="key active-key">active bin {activeId}</span>
        {band && (
          <span className="key band-key">
            your band {band.lower} – {band.upper}
            {!bandShown && <span className="dim"> — off this window</span>}
          </span>
        )}
        <span className="key uninit-key">bin array not created</span>
        {showPosition && <span className="dim">each row has its own scale</span>}
        {onSelectRange && (
          <span className="dim">
            drag across bins to pick a range
            {maxSelectable < cells.length && ` (max ${maxSelectable})`}
          </span>
        )}
      </footer>

      {hover && (
        <div className="bin-tip">
          <strong>bin {hover.binId}</strong>
          <dl>
            <dt>price</dt>
            <dd>{fmtPrice(hover.price * scale)}</dd>
            <dt>step</dt>
            <dd>{(hover.stepBpX100 / 100).toFixed(2)} bps</dd>
            <dt>swap fee</dt>
            <dd>{((hover.feeRate / 1e9) * 100).toFixed(4)}%</dd>
            <dt>{symbolX}</dt>
            <dd>{fmtAmount(hover.amountX, decimalsX)}</dd>
            <dt>{symbolY}</dt>
            <dd>{fmtAmount(hover.amountY, decimalsY)}</dd>
            <dt>supply</dt>
            <dd>{hover.liquiditySupply.toString()}</dd>
            <dt>array</dt>
            <dd>
              {hover.arrayIndex} · {hover.arrayExists ? (hover.arrayOccupied ? "live" : "empty") : "not created"}
            </dd>
            {band && (
              <>
                <dt>your band</dt>
                <dd>
                  {hover.binId < band.lower
                    ? `${band.lower - hover.binId} bin${band.lower - hover.binId === 1 ? "" : "s"} below the band`
                    : hover.binId > band.upper
                      ? `${hover.binId - band.upper} bin${hover.binId - band.upper === 1 ? "" : "s"} above the band`
                      : `inside — bin ${hover.binId - band.lower + 1} of ${band.upper - band.lower + 1}`}
                </dd>
              </>
            )}
            {hover.share !== undefined && (
              <>
                <dt>my shares</dt>
                <dd>{hover.share.toString()}</dd>
                <dt>my liquidity</dt>
                <dd>
                  {fmtAmount(hover.myAmountX ?? 0n, decimalsX)} /{" "}
                  {fmtAmount(hover.myAmountY ?? 0n, decimalsY)}
                </dd>
                <dt>claimable</dt>
                <dd>
                  {fmtAmount(hover.pendingFeeX ?? 0n, decimalsX)} / {fmtAmount(hover.pendingFeeY ?? 0n, decimalsY)}
                </dd>
              </>
            )}
            {!hover.derived && (
              <>
                <dt>state</dt>
                <dd className="dim">never touched — price shown is the client's own derivation</dd>
              </>
            )}
          </dl>
        </div>
      )}
    </div>
  );
}

/** Bin-array indexes a range spans, and whether each one exists yet. */
export function arraysForRange(lower: number, upper: number, existing: Set<number>) {
  const lo = binArrayIndex(lower);
  const hi = binArrayIndex(upper);
  return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i).map((index) => ({
    index,
    exists: existing.has(index),
    lower: index * BINS_PER_ARRAY,
    upper: index * BINS_PER_ARRAY + BINS_PER_ARRAY - 1
  }));
}
