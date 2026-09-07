/**
 * Which chain the app is pointed at, and through which endpoint.
 *
 * Devnet is the default and the point of this app; localnet is here because
 * the same code should be exercisable against `localnet/` before it is
 * exercised against a public cluster. The distinction that matters downstream
 * is `hasWebsocket`: the LiteSVM server has no subscription endpoint, so
 * nothing in this app may ever call `confirmTransaction`.
 *
 * The endpoint is a *separate* choice from the cluster, and one a visitor can
 * make for themselves. Browsing pools and positions is `getProgramAccounts`,
 * which the public devnet endpoint throttles hard and some providers refuse
 * outright, so the app that ships with a shared endpoint is the app that
 * breaks first — and no build-time variable helps a user whose page is already
 * loaded. An override is stored per cluster in this browser, and nowhere else:
 * an endpoint with a key in it belongs to the person who pasted it, not to a
 * bundle everyone downloads.
 */
export type ClusterId = "devnet" | "localnet";

export type Cluster = {
  id: ClusterId;
  label: string;
  /** What the app is actually talking to: the override, or `defaultEndpoint`. */
  endpoint: string;
  /** What it would talk to with no override — what this deployment shipped. */
  defaultEndpoint: string;
  /** True when this browser is pointed somewhere other than the default. */
  overridden: boolean;
  hasWebsocket: boolean;
  /** Devnet SOL is free; localnet SOL is free and instant. */
  faucet: boolean;
  explorerSuffix: string;
};

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

const DEVNET: Cluster = {
  id: "devnet",
  label: "Devnet",
  endpoint: envEndpoint(import.meta.env.VITE_DEVNET_RPC as string, "https://api.devnet.solana.com"),
  defaultEndpoint: envEndpoint(import.meta.env.VITE_DEVNET_RPC as string, "https://api.devnet.solana.com"),
  overridden: false,
  hasWebsocket: true,
  faucet: true,
  explorerSuffix: "?cluster=devnet"
};

const LOCALNET: Cluster = {
  id: "localnet",
  label: "Localnet",
  endpoint: envEndpoint(import.meta.env.VITE_LOCALNET_RPC as string, "http://127.0.0.1:8899"),
  defaultEndpoint: envEndpoint(import.meta.env.VITE_LOCALNET_RPC as string, "http://127.0.0.1:8899"),
  overridden: false,
  hasWebsocket: false,
  faucet: true,
  explorerSuffix: "?cluster=custom&customUrl=http%3A%2F%2F127.0.0.1%3A8899"
};

export const CLUSTERS: Cluster[] = [DEVNET, LOCALNET];

const STORE_KEY = "taper.cluster.v1";
const ENDPOINT_KEY = "taper.rpc.v1";

export type Endpoints = Partial<Record<ClusterId, string>>;

/**
 * A URL this app can actually talk to, or a sentence saying why not.
 *
 * Rejecting a WebSocket URL is worth doing here rather than letting web3.js
 * fail later: `wss://` is what a provider's dashboard shows next to the HTTP
 * endpoint, and it is the easy one to copy by mistake.
 */
export function normaliseEndpoint(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Enter an RPC URL.");

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("That is not a URL. It should start with https://");
  }
  if (url.protocol === "ws:" || url.protocol === "wss:") {
    throw new Error("That is the WebSocket endpoint. Use the HTTP one — it usually starts https://");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("An RPC endpoint has to be http:// or https://");
  }
  return url.toString().replace(/\/$/, "");
}

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

/** A cluster as it is actually configured in this browser. */
export function resolveCluster(base: Cluster, endpoints: Endpoints): Cluster {
  const override = endpoints[base.id];
  if (!override || override === base.defaultEndpoint) return base;
  return { ...base, endpoint: override, overridden: true };
}

export function loadCluster(): Cluster {
  const stored = localStorage.getItem(STORE_KEY);
  const found = CLUSTERS.find((c) => c.id === stored);
  return resolveCluster(found ?? DEVNET, loadEndpoints());
}

export function saveCluster(id: ClusterId) {
  localStorage.setItem(STORE_KEY, id);
}

/** The host, for a status chip that has no room for the whole URL. */
export function endpointLabel(endpoint: string) {
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint;
  }
}

/**
 * Whether a failed read is the endpoint's fault rather than the chain's.
 *
 * Worth separating, because the two have opposite fixes and the app cannot
 * tell them apart from the message alone: an empty pool list on a throttled
 * endpoint looks exactly like a cluster with no pools on it.
 */
export function isEndpointFailure(message: string) {
  // The status codes are bounded so an address that happens to contain "429"
  // is not read as a rate limit.
  return /\b(429|403|410|50[234])\b|too many requests|rate.?limit|forbidden|unauthorized|method not (found|supported)|not enabled|excluded from account secondary indexes|failed to fetch|load failed|networkerror|fetch failed|econnrefused|socket hang up|timed? ?out/i.test(
    message
  );
}

export const explorerAccount = (cluster: Cluster, address: string) =>
  `https://explorer.solana.com/address/${address}${cluster.explorerSuffix}`;

export const explorerTx = (cluster: Cluster, signature: string) =>
  `https://explorer.solana.com/tx/${signature}${cluster.explorerSuffix}`;
