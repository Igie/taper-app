import type { ReactNode } from "react";
import { isEndpointFailure } from "../lib/cluster";

export function Panel({
  title,
  icon,
  aside,
  children
}: {
  title: string;
  icon?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="panel">
      <header>
        <h2>
          {icon}
          {title}
        </h2>
        {aside}
      </header>
      <div className="panel-body">{children}</div>
    </section>
  );
}

export function Metric({ label, value, tone }: { label: string; value: ReactNode; tone?: "x" | "y" | "dim" }) {
  return (
    <div className={`metric ${tone ?? ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
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
