/**
 * App-wide providers: the chain, the wallet, and the toast strip.
 *
 * The cluster is switchable at runtime, so the endpoint is state rather than a
 * constant — `ConnectionProvider` is rebuilt when it changes, which drops
 * every cached account with it. That is the behaviour you want: a devnet pool
 * address means nothing on localnet.
 *
 * The endpoint is switchable on its own for the same reason and with the same
 * mechanism: a visitor whose page is already loaded cannot be helped by a
 * build-time variable, and the endpoint this deployment ships is the one that
 * gets throttled first. `setEndpoint` is keyed by cluster, so pointing devnet
 * at a private RPC does not also point localnet at it.
 *
 * No wallet adapters are listed explicitly. Every current wallet registers
 * itself through the Wallet Standard, so an empty list finds them all and
 * avoids shipping a bundle of adapters for wallets nobody here uses.
 */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { normaliseEndpoint } from "taper-amm-sdk";
import {
  CLUSTERS,
  loadCluster,
  loadEndpoints,
  resolveCluster,
  saveCluster,
  saveEndpoints,
  type Cluster,
  type ClusterId,
  type Endpoints
} from "./cluster";

type ClusterContextValue = {
  cluster: Cluster;
  setCluster: (id: ClusterId) => void;
  /**
   * Points the current cluster at another RPC, or back at the default with
   * `undefined`. Throws with a readable sentence if the URL is not one.
   */
  setEndpoint: (url?: string) => void;
  clusters: Cluster[];
};

const ClusterContext = createContext<ClusterContextValue | undefined>(undefined);

export function useCluster() {
  const value = useContext(ClusterContext);
  if (!value) throw new Error("useCluster outside a provider");
  return value;
}

// ------------------------------------------------------------------ toasts

export type Toast = {
  id: number;
  kind: "ok" | "bad" | "info";
  label: string;
  detail?: string;
  logs?: string[];
  signature?: string;
};

type ToastContextValue = {
  toasts: Toast[];
  push: (toast: Omit<Toast, "id">) => void;
  dismiss: (id: number) => void;
};

const ToastContext = createContext<ToastContextValue | undefined>(undefined);

export function useToasts() {
  const value = useContext(ToastContext);
  if (!value) throw new Error("useToasts outside a provider");
  return value;
}

let nextToastId = 1;

export function Providers({ children }: { children: ReactNode }) {
  const [endpoints, setEndpoints] = useState<Endpoints>(() => loadEndpoints());
  const [cluster, setClusterState] = useState<Cluster>(() => loadCluster());
  const [toasts, setToasts] = useState<Toast[]>([]);

  const setCluster = useCallback(
    (id: ClusterId) => {
      const next = CLUSTERS.find((c) => c.id === id);
      if (!next) return;
      saveCluster(id);
      setClusterState(resolveCluster(next, endpoints));
    },
    [endpoints]
  );

  const setEndpoint = useCallback(
    (url?: string) => {
      // Normalising before storing means a bad URL never reaches the
      // connection, and the caller gets the sentence to show.
      const next: Endpoints = { ...endpoints };
      if (url === undefined) delete next[cluster.id];
      else next[cluster.id] = normaliseEndpoint(url);
      setEndpoints(next);
      saveEndpoints(next);
      const base = CLUSTERS.find((c) => c.id === cluster.id);
      if (base) setClusterState(resolveCluster(base, next));
    },
    [cluster.id, endpoints]
  );

  const push = useCallback((toast: Omit<Toast, "id">) => {
    const id = nextToastId++;
    // Newest first: the strip is read from the top and a long run of
    // successes should never push the failure you care about off screen.
    setToasts((current) => [{ ...toast, id }, ...current].slice(0, 40));
  }, []);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((t) => t.id !== id));
  }, []);

  const clusterValue = useMemo(
    () => ({
      cluster,
      setCluster,
      setEndpoint,
      clusters: CLUSTERS.map((c) => resolveCluster(c, endpoints))
    }),
    [cluster, setCluster, setEndpoint, endpoints]
  );
  const toastValue = useMemo(() => ({ toasts, push, dismiss }), [toasts, push, dismiss]);

  return (
    <ClusterContext.Provider value={clusterValue}>
      <ToastContext.Provider value={toastValue}>
        <ConnectionProvider key={cluster.endpoint} endpoint={cluster.endpoint} config={{ commitment: "confirmed" }}>
          <WalletProvider wallets={[]} autoConnect>
            <WalletModalProvider>{children}</WalletModalProvider>
          </WalletProvider>
        </ConnectionProvider>
      </ToastContext.Provider>
    </ClusterContext.Provider>
  );
}
