/**
 * The shell: cluster, wallet, navigation, and the activity strip.
 *
 * Routing is the URL hash rather than a router dependency. A pool's address is
 * the only thing worth linking to and `#/pool/<address>` says it plainly, which
 * matters more here than nested routes ever would.
 */
import { useCallback, useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { PROGRAM_ID, endpointLabel, explorerAccount, explorerTx } from "@taper/sdk";
import { useCluster, useToasts } from "./lib/providers";
import { readableError } from "./lib/tx";
import { RpcPicker } from "./components/RpcPicker";
import { Boundary } from "./components/primitives";
import { isAdmin } from "./lib/presets";
import { shortAddress } from "./lib/format";
import { Pools } from "./views/Pools";
import { PoolView } from "./views/PoolView";
import { CreatePool } from "./views/CreatePool";
import { Positions } from "./views/Positions";
import { Configs } from "./views/Configs";

type Route =
  | { name: "pools" }
  | { name: "pool"; address: PublicKey }
  | { name: "new" }
  | { name: "positions" }
  | { name: "configs" };

function parseHash(): Route {
  const hash = window.location.hash.replace(/^#\/?/, "");
  const [head, tail] = hash.split("/");
  if (head === "pool" && tail) {
    try {
      return { name: "pool", address: new PublicKey(tail) };
    } catch {
      return { name: "pools" };
    }
  }
  if (head === "new") return { name: "new" };
  if (head === "positions") return { name: "positions" };
  if (head === "configs") return { name: "configs" };
  return { name: "pools" };
}

export const navigate = (path: string) => {
  window.location.hash = path;
};

export function App() {
  const [route, setRoute] = useState<Route>(parseHash);
  const { cluster, setCluster, clusters } = useCluster();
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const { toasts, dismiss } = useToasts();
  const [balance, setBalance] = useState<number>();
  /**
   * Three answers, not two. A read that throws is the endpoint failing; a read
   * that returns nothing is the program missing. Reporting the first as the
   * second sends someone to redeploy a program that is already there.
   */
  const [health, setHealth] = useState<{ state: "checking" | "live" | "missing" | "down"; detail?: string }>({
    state: "checking"
  });

  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setHealth({ state: "checking" });
    connection
      .getAccountInfo(PROGRAM_ID)
      .then(
        (account) => !cancelled && setHealth({ state: account?.executable ? "live" : "missing" })
      )
      .catch(
        (e: unknown) => !cancelled && setHealth({ state: "down", detail: readableError(e) })
      );
    return () => {
      cancelled = true;
    };
  }, [connection]);

  const refreshBalance = useCallback(() => {
    if (!publicKey) return setBalance(undefined);
    connection
      .getBalance(publicKey)
      .then((lamports) => setBalance(lamports / LAMPORTS_PER_SOL))
      .catch(() => setBalance(undefined));
  }, [connection, publicKey]);

  useEffect(refreshBalance, [refreshBalance]);

  const tabs: { id: Route["name"]; label: string; path: string }[] = [
    { id: "pools", label: "Pools", path: "/" },
    { id: "positions", label: "My positions", path: "/positions" },
    { id: "new", label: "Create pool", path: "/new" },
    { id: "configs", label: "Presets", path: "/configs" }
  ];

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <div>
            <strong>Taper</strong>
            <small>tapered bin market maker</small>
          </div>
        </div>

        <nav className="tabs">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={route.name === tab.id || (tab.id === "pools" && route.name === "pool") ? "selected" : ""}
              onClick={() => navigate(tab.path)}
            >
              {tab.label}
            </button>
          ))}
        </nav>

        <div className="topbar-status">
          <select
            className={`cluster-select ${cluster.live ? "live" : ""}`}
            value={cluster.id}
            onChange={(e) => setCluster(e.target.value as typeof cluster.id)}
            title={
              cluster.live
                ? "Mainnet: every transaction here spends real money"
                : "Which chain this app is pointed at"
            }
          >
            {clusters.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>

          <RpcPicker />

          <span
            className={`dot ${health.state === "live" ? "ok" : "off"}`}
            title={health.detail ?? PROGRAM_ID.toBase58()}
          >
            <i />
            {health.state === "checking"
              ? "checking"
              : health.state === "live"
                ? "program live"
                : health.state === "missing"
                  ? "program not found"
                  : "RPC unreachable"}
          </span>

          {balance !== undefined && <span className="chip mono">{balance.toFixed(3)} SOL</span>}
          <WalletMultiButton />
        </div>
      </header>

      {health.state === "missing" && (
        <div className="banner">
          <span>
            No executable at <code>{shortAddress(PROGRAM_ID.toBase58(), 6, 6)}</code> on {cluster.label}. Deploy
            it with <code>scripts\deploy.ps1 -Cluster {cluster.id}</code>, or switch networks.
          </span>
        </div>
      )}

      {health.state === "down" && (
        <div className="banner">
          <span>
            <code>{endpointLabel(cluster.endpoint)}</code> did not answer
            {health.detail ? `: ${health.detail}` : "."} Nothing will load until it does — point the app at
            another RPC with the endpoint chip above.
          </span>
        </div>
      )}

      <main className="stage">
        {/* Keyed on the route, so leaving a view that threw and coming back is a
            fresh mount rather than the same error again. */}
        <Boundary key={route.name === "pool" ? route.address.toBase58() : route.name}>
          {route.name === "pools" && <Pools />}
          {route.name === "pool" && <PoolView address={route.address} onChanged={refreshBalance} />}
          {route.name === "new" && <CreatePool onCreated={refreshBalance} />}
          {route.name === "positions" && <Positions />}
          {route.name === "configs" && <Configs isAdmin={isAdmin(publicKey)} onChanged={refreshBalance} />}
        </Boundary>
      </main>

      <section className="activity">
        <div className="activity-head">
          <strong>Activity</strong>
          <span className="dim">
            {publicKey ? (
              <a href={explorerAccount(cluster, publicKey.toBase58())} target="_blank" rel="noreferrer">
                {shortAddress(publicKey.toBase58(), 6, 6)}
              </a>
            ) : (
              "no wallet connected"
            )}
          </span>
        </div>
        <ul>
          {toasts.length === 0 && <li className="dim">Nothing yet.</li>}
          {toasts.map((toast) => (
            <li key={toast.id} className={toast.kind === "ok" ? "ok" : toast.kind === "bad" ? "bad" : ""}>
              <span className="label">{toast.label}</span>
              {toast.detail && <span className="detail">{toast.detail}</span>}
              {toast.signature && (
                <a href={explorerTx(cluster, toast.signature)} target="_blank" rel="noreferrer">
                  {shortAddress(toast.signature, 6, 6)}
                </a>
              )}
              {toast.logs && toast.logs.length > 0 && (
                <details>
                  <summary>logs</summary>
                  <pre>{toast.logs.join("\n")}</pre>
                </details>
              )}
              <button type="button" className="ghost" onClick={() => dismiss(toast.id)}>
                dismiss
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
