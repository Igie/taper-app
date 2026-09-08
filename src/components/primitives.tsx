import { Component, type ErrorInfo, type ReactNode } from "react";
import { isEndpointFailure } from "taper-amm-sdk";

/**
 * A titled box, or — when `header` is given — a box whose header *is* a
 * control.
 *
 * The second form exists for the pool page, where three panels became three
 * tabs. A tab strip above a header that names the tab again is the same word
 * twice and a second bar of chrome to look past, so the strip takes the
 * title's place and the panel keeps its `aside` on the right of the same row.
 */
export function Panel({
  title,
  icon,
  header,
  aside,
  children
}: {
  title?: string;
  icon?: ReactNode;
  header?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="panel">
      <header className={header ? "tabbed" : undefined}>
        {header ?? (
          <h2>
            {icon}
            {title}
          </h2>
        )}
        {aside}
      </header>
      <div className="panel-body">{children}</div>
    </section>
  );
}

/**
 * A detail one hover away rather than always on screen.
 *
 * The panels here have more to say than a reader wants at once — which rent a
 * plan pays, why a band needs both sides, what a move keeps. Saying all of it
 * inline turned every panel into an essay, so the rule is: **what changes the
 * next click stays visible, what explains it moves in here.** Focusable as
 * well as hoverable, so the explanation is reachable without a mouse.
 */
export function HoverCard({
  trigger,
  children,
  className
}: {
  trigger: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span className={`hovercard ${className ?? ""}`} tabIndex={0}>
      {trigger}
      <span className="tip" role="tooltip">
        {children}
      </span>
    </span>
  );
}

/** The `i` badge: `HoverCard` with the smallest possible trigger. */
export function Info({ children }: { children: ReactNode }) {
  return (
    <HoverCard className="info" trigger={<i aria-hidden="true">i</i>}>
      {children}
    </HoverCard>
  );
}

export function Metric({
  label,
  value,
  tone,
  hint
}: {
  label: string;
  value: ReactNode;
  tone?: "x" | "y" | "dim";
  hint?: ReactNode;
}) {
  return (
    <div className={`metric ${tone ?? ""}`}>
      <span>
        {label}
        {hint && <Info>{hint}</Info>}
      </span>
      <strong>{value}</strong>
    </div>
  );
}

/**
 * A tab strip.
 *
 * Distinct from `Segmented` on purpose: segmented control picks a *value* the
 * form below will use, a tab picks *which form* is below. They looked the same
 * once and the panel read as two rows of the same question.
 */
export function Tabs<T extends string>({
  value,
  tabs,
  onChange
}: {
  value: T;
  tabs: { id: T; label: string; hint?: string; disabled?: boolean }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="tab-strip" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={tab.id === value}
          title={tab.hint}
          disabled={tab.disabled}
          className={tab.id === value ? "selected" : ""}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

export function Field({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  hint,
  disabled
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <label className="field" title={hint}>
      <span>{label}</span>
      <input
        type="number"
        value={Number.isFinite(value) ? value : ""}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}

/** Amounts are typed in whole tokens; the raw `u64` is derived from decimals. */
export function AmountField({
  label,
  value,
  onChange,
  hint
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
}) {
  return (
    <label className="field" title={hint}>
      <span>{label}</span>
      <input
        inputMode="decimal"
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/[^\d.]/g, ""))}
      />
    </label>
  );
}

export function Segmented<T extends string | number>({
  value,
  options,
  onChange
}: {
  value: T;
  options: { id: T; label: string; hint?: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="segmented">
      {options.map((option) => (
        <button
          key={String(option.id)}
          type="button"
          title={option.hint}
          className={option.id === value ? "selected" : ""}
          onClick={() => onChange(option.id)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Dot({ ok, label, title }: { ok: boolean; label: string; title?: string }) {
  return (
    <span className={`dot ${ok ? "ok" : "off"}`} title={title}>
      <i />
      {label}
    </span>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}

/**
 * A failed read, with the one distinction that matters: whether the chain
 * answered. A throttled endpoint and a cluster with nothing on it produce the
 * same empty screen, and only one of them is fixed by pasting another RPC.
 */
export function LoadError({ error }: { error: string }) {
  return (
    <>
      <p className="error">{error}</p>
      {isEndpointFailure(error) && (
        <p className="hint warn">
          That is the RPC endpoint refusing the request, not the chain answering. Pools and positions are
          read with <code>getProgramAccounts</code>, which public endpoints throttle — point the app at
          another RPC with the endpoint chip in the header.
        </p>
      )}
    </>
  );
}

/**
 * The last line between a bug and a blank page.
 *
 * An error thrown while rendering unmounts the whole tree, and this app is one
 * tree — so a mistake in a panel takes the header, the network picker and the
 * activity log with it, leaving nothing on screen to say what happened or to
 * click to get out. Wrapping the routed view keeps the shell alive and puts the
 * message where it can be read, which is the difference between a bug report
 * and "it went black".
 *
 * Reset is by remount: give it a `key` that changes with the route.
 */
export class Boundary extends Component<{ children: ReactNode }, { error?: Error }> {
  state: { error?: Error } = {};

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Taper: render failed", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <Panel title="This view stopped">
        <p className="error">{this.state.error.message}</p>
        <p className="hint">
          A bug in the interface, not a transaction — anything already signed is on chain and
          unaffected. The browser console has the stack.
        </p>
        <p>
          <button type="button" onClick={() => this.setState({ error: undefined })}>
            Try again
          </button>
        </p>
      </Panel>
    );
  }
}
