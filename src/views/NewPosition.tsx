/**
 * Opening a position: one band, one shape, two amounts.
 *
 * Deliberately the only thing this panel does. Everything you can do to a
 * position that already exists — add, remove, move, claim, close — lives in
 * `ManagePosition`, because mixing the two put "open" and "close all" a
 * button's width apart and made the panel's title a lie half the time.
 *
 * The form itself is shared with `Manage → Add`; see `DepositForm`.
 */
import type { ReactNode } from "react";
import type { TokenPair } from "taper-amm-sdk";
import type { PoolBundle } from "./PoolView";
import type { Toast } from "../lib/providers";
import { DepositForm, type Range } from "../components/DepositForm";
import { Info, Panel } from "../components/primitives";

export function NewPosition({
  bundle,
  tokens,
  range,
  onRange,
  header,
  onBusyChange,
  onDone,
  push
}: {
  bundle: PoolBundle;
  tokens: TokenPair;
  range?: Range;
  onRange: (range: Range) => void;
  /** The pool page's view picker, which stands in for this panel's title. */
  header?: ReactNode;
  /** Raised while a plan is in flight or half-landed; see `DepositForm`. */
  onBusyChange?: (busy: boolean) => void;
  onDone: () => void;
  push: (toast: Omit<Toast, "id">) => void;
}) {
  return (
    <Panel
      title="New position"
      header={header}
      aside={
        <span className="hint">
          drag the ladder to pick a band
          <Info>
            A position covers one contiguous run of bins. Bins below the active one hold{" "}
            {bundle.y.symbol}, bins above it hold {bundle.x.symbol}, and a band spanning the active
            bin needs both. The band can be moved later without closing the position.
          </Info>
        </span>
      }
    >
      <DepositForm
        bundle={bundle}
        tokens={tokens}
        range={range}
        onRange={onRange}
        editableRange
        onBusyChange={onBusyChange}
        onDone={onDone}
        push={push}
      />
    </Panel>
  );
}
