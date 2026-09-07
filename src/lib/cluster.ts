/**
 * Which chain this browser is pointed at, and through which endpoint.
 *
 * The networks themselves — their ids, labels, default endpoints, whether they
 * have a WebSocket, and where Solana Explorer looks — live in `@taper/sdk`,
 * because they are not this app's opinion: a script, the localnet console and
 * any third-party client need the same three answers. What is left here is the
 * part that only makes sense in a browser, and it is exactly two things.
 *
 * **The endpoint this deployment ships with** comes from `VITE_*_RPC`, so a
 * build can point at a private RPC without the SDK knowing anything about
 * Vite.
 *
 * **The endpoint a visitor chooses for themselves** is stored per network in
 * `localStorage`. Browsing pools and positions is `getProgramAccounts`, which
 * public endpoints throttle hard and some providers refuse outright, so the
 * app that ships with one shared endpoint is the app that breaks first — and
 * no build-time variable helps a user whose page is already loaded. An
 * endpoint with a key in it belongs to the person who pasted it, not to a
 * bundle everyone downloads, so it is kept here and sent nowhere else.
 */
import { NETWORKS, networkFor, normaliseEndpoint, withEndpoint, type NetworkId, type ResolvedNetwork } from "@taper/sdk";

export type ClusterId = NetworkId;
export type Cluster = ResolvedNetwork;

/**
 * The endpoint this deployment ships with, made absolute.
 *
 * `VITE_DEVNET_RPC` is a path rather than a URL when the dev server is
 * proxying the endpoint (see vite.config.ts, and the preflight it works
 * around). web3.js rejects anything that does not start `http`, so a path is
 * resolved against the page it was served from — the port the dev server
 * settled on is not knowable at build time.
 */
function envEndpoint(value: string | undefined, fallback: string): string {
  const raw = (value ?? "").trim() || fallback;
  if (raw.startsWith("/") && typeof window !== "undefined") {
    const absolute = new URL(raw, window.location.origin).toString();
    return absolute.endsWith("/") ? absolute.slice(0, -1) : absolute;
  }
  return raw;
}

const ENV_RPC: Record<ClusterId, string | undefined> = {
  "mainnet-beta": import.meta.env.VITE_MAINNET_RPC as string | undefined,
  devnet: import.meta.env.VITE_DEVNET_RPC as string | undefined,
  localnet: import.meta.env.VITE_LOCALNET_RPC as string | undefined
};

/**
 * Which networks this build offers, in the order the picker lists them.
 *
 * Mainnet is hidden unless the deployment names an endpoint for it. That is
 * not a security decision — the program is the same address on every network
 * and anyone may point their own browser anywhere — it is an honesty one: the
 * public mainnet endpoint refuses `getProgramAccounts` at this app's usage, so
 * offering mainnet without an endpoint offers a page that cannot list a pool.
 */
const bases = NETWORKS.filter((n) => n.id !== "mainnet-beta" || Boolean(ENV_RPC["mainnet-beta"]?.trim())).map(
  (n) => ({ ...n, defaultEndpoint: envEndpoint(ENV_RPC[n.id], n.defaultEndpoint) })
);

export const CLUSTERS: Cluster[] = bases.map((n) => withEndpoint(n));

const DEFAULT_CLUSTER: ClusterId = CLUSTERS.some((c) => c.id === "devnet") ? "devnet" : CLUSTERS[0].id;

const STORE_KEY = "taper.cluster.v1";
const ENDPOINT_KEY = "taper.rpc.v1";

export type Endpoints = Partial<Record<ClusterId, string>>;

export function loadEndpoints(): Endpoints {
  try {
    const stored = JSON.parse(localStorage.getItem(ENDPOINT_KEY) ?? "{}") as Endpoints;
    const out: Endpoints = {};
    // Anything unparseable is dropped rather than carried: a bad value here
    // breaks every read in the app, and the default always works.
    for (const cluster of CLUSTERS) {
      const value = stored[cluster.id];
      if (typeof value === "string" && value) out[cluster.id] = normaliseEndpoint(value);
    }
    return out;
  } catch {
    return {};
  }
}

export function saveEndpoints(endpoints: Endpoints) {
  try {
    localStorage.setItem(ENDPOINT_KEY, JSON.stringify(endpoints));
  } catch {
    // A browser with storage disabled still gets the override for this session.
  }
}

/** A network as it is actually configured in this browser. */
export function resolveCluster(base: Cluster, endpoints: Endpoints): Cluster {
  return withEndpoint(base, endpoints[base.id]);
}

export function loadCluster(): Cluster {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(STORE_KEY);
  } catch {
    // Storage disabled; the default is as good an answer as any.
  }
  const found = CLUSTERS.find((c) => c.id === stored) ?? CLUSTERS.find((c) => c.id === DEFAULT_CLUSTER);
  return resolveCluster(found ?? CLUSTERS[0], loadEndpoints());
}

export function saveCluster(id: ClusterId) {
  try {
    localStorage.setItem(STORE_KEY, id);
  } catch {
    // As above.
  }
}

/** Present so a caller can name a network it has not selected. */
export const clusterFor = networkFor;
