/**
 * Pointing the app at a different RPC.
 *
 * The chip in the topbar names the host the app is talking to, because "which
 * endpoint" is the first question worth asking when the pool list is empty or
 * slow, and it is otherwise invisible. Opening it gives a field: paste an
 * endpoint, and this browser uses it for this cluster from the next read on.
 *
 * Nothing here leaves the browser. An endpoint with an API key in it is the
 * user's own, so it is stored in `localStorage` and never sent anywhere but to
 * the RPC itself — which is the whole reason this is a runtime setting and not
 * another `VITE_` variable baked into the bundle everyone downloads.
 */
import { useEffect, useRef, useState } from "react";
import { endpointLabel } from "taper-amm-sdk";
import { useCluster } from "../lib/providers";

export function RpcPicker() {
  const { cluster, setEndpoint } = useCluster();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(cluster.endpoint);
  const [error, setError] = useState<string>();
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setDraft(cluster.endpoint);
    setError(undefined);
  }, [cluster.endpoint]);

  // Click-away, so the panel behaves like the menu it looks like.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  function apply(url?: string) {
    try {
      setEndpoint(url);
      setError(undefined);
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="rpc-picker" ref={box}>
      <button
        type="button"
        className={`chip rpc-chip ${cluster.overridden ? "custom" : ""}`}
        onClick={() => setOpen((v) => !v)}
        title={cluster.endpoint}
      >
        {endpointLabel(cluster.endpoint)}
        {cluster.overridden && <span className="tag">yours</span>}
      </button>

      {open && (
        <div className="rpc-panel">
          <label className="field wide">
            <span>{cluster.label} RPC endpoint</span>
            <input
              className="mono"
              placeholder="https://…"
              value={draft}
              spellCheck={false}
              autoFocus
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") apply(draft);
                if (e.key === "Escape") setOpen(false);
              }}
            />
          </label>

          {error && <p className="error">{error}</p>}

          <p className="hint">
            Browsing pools and positions is <code>getProgramAccounts</code>, which public endpoints throttle
            and some providers refuse outright. If the list is empty or slow, that is usually what happened —
            paste your own endpoint here. It is kept in this browser only.
          </p>

          <div className="actions">
            <button type="button" className="primary" onClick={() => apply(draft)}>
              Use this endpoint
            </button>
            {cluster.overridden && (
              <button type="button" className="ghost" onClick={() => apply(undefined)}>
                Back to default
              </button>
            )}
          </div>

          {cluster.overridden && (
            <p className="hint dim mono">default: {endpointLabel(cluster.defaultEndpoint)}</p>
          )}
        </div>
      )}
    </div>
  );
}
