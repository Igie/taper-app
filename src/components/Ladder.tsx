/**
 * The bin ladder.
 *
 * One column per bin. Height is the bin's liquidity measured the way the
 * program measures it — `L = P·x + y`, everything in Y — because comparing raw
 * token counts across bins of different price is meaningless. The X part is
 * drawn above the Y part so a glance shows the composition flip at the active
 * bin: pure Y below it, pure X above, mixed only where it trades.
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
import { BINS_PER_ARRAY, binArrayIndex, priceScale } from "@taper/sdk";
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
  /** Checkpointed pending plus the growth not yet credited. */
  pendingFeeX?: bigint;
  pendingFeeY?: bigint;
};

type Props = {
  cells: Cell[];
  activeId: number;
  range?: { lower: number; upper: number };
  onSelectRange?: (lower: number, upper: number) => void;
  maxSelectable?: number;
  decimalsX: number;
  decimalsY: number;
  symbolX: string;
  symbolY: string;
};

/** Liquidity in Y terms, matching `bin_liquidity`. Lamports throughout. */
const liquidityOf = (cell: Cell) => Number(cell.amountX) * cell.price + Number(cell.amountY);

export function Ladder({
  cells,
  activeId,
  range,
  onSelectRange,
  maxSelectable = 70,
  decimalsX,
  decimalsY,
  symbolX,
  symbolY
}: Props) {
  const [hover, setHover] = useState<Cell>();
  const [drag, setDrag] = useState<{ anchor: number; head: number }>();

  const peak = useMemo(() => Math.max(1, ...cells.map(liquidityOf)), [cells]);
  // A lamport price is Y-lamports per X-lamport; a reader wants Y per X.
  const scale = priceScale(decimalsX, decimalsY);

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
        <div className="ladder-bars">
          {cells.map((cell) => {
            const total = liquidityOf(cell);
            const height = total > 0 ? Math.max(2, (total / peak) * 100) : 0;
            const xPart = total > 0 ? (Number(cell.amountX) * cell.price * height) / total : 0;
            const inRange = shown && cell.binId >= shown.lower && cell.binId <= shown.upper;
            const classes = [
              "bin",
              cell.binId === activeId ? "active" : "",
              inRange ? "in-range" : "",
              cell.share && cell.share > 0n ? "mine" : "",
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
                onMouseDown={() => onSelectRange && setDrag({ anchor: cell.binId, head: cell.binId })}
              >
                <div className="bin-stack">
                  <span className="x" style={{ height: `${xPart}%` }} />
                  <span className="y" style={{ height: `${height - xPart}%` }} />
                </div>
              </div>
            );
          })}
        </div>

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
        <span className="key uninit-key">bin array not created</span>
        {onSelectRange && <span className="dim">drag across bins to pick a range (max {maxSelectable})</span>}
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
            {hover.share !== undefined && (
              <>
                <dt>my shares</dt>
                <dd>{hover.share.toString()}</dd>
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
