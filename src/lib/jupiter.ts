/**
 * Token metadata from Jupiter: a symbol, an icon, and what a balance is worth.
 *
 * The chain answers "what is this mint" — decimals, program, extensions — and
 * nothing else. It has no ticker for an SPL mint, no logo and no price, so a
 * wallet's holdings read as forty truncated addresses unless something else
 * names them. Jupiter's token search is that something: one request answers
 * for a hundred mints at once.
 *
 * Three things shape this file.
 *
 * **It is mainnet only.** Jupiter indexes mainnet, so every devnet or localnet
 * mint is a miss — and a miss costs a request and then a retry. `covers` is
 * the gate, and everywhere else degrades to what the chain said: the on-chain
 * symbol if the mint carries one, a truncated address if it does not. A devnet
 * token has no honest USD price anyway, and inventing one from a mainnet
 * namesake would be worse than leaving the column blank.
 *
 * **`lite-api.jup.ag` needs no key and reflects the caller's origin**, so the
 * browser can talk to it directly with nothing baked into the bundle. What it
 * does not send is any rate-limit header at all, so the pace has to be
 * self-imposed rather than read off a response — hence `slot()` below. Its
 * `cache-control: max-age=10` is the real floor on how fresh an answer can be,
 * which is why `FRESH_MS` is not smaller.
 *
 * **Nothing here fetches on a timer.** The picker asks once when it opens, the
 * cache answers for the next half minute, and a mint Jupiter did not recognise
 * is not asked about again for five. That is the whole of the limiter's job:
 * the requests that need throttling are the ones a re-render would otherwise
 * make.
 */
import type { ClusterId } from "./cluster";

const SEARCH_URL = "https://lite-api.jup.ag/tokens/v2/search";

/** What one row of the search response is worth keeping. */
export type JupToken = {
  mint: string;
  symbol: string;
  name: string;
  icon?: string;
  decimals: number;
  /** Which token program owns the mint, as a base58 address. */
  tokenProgram: string;
  /** 0 when Jupiter has no price, which is not the same as a price of zero. */
  usdPrice: number;
  /** Jupiter's own list membership, not a claim about the token. */
  verified: boolean;
  tags: string[];
  /** Pool depth across every venue, in USD. Undefined when unreported. */
  liquidity?: number;
};

/**
 * Whether Jupiter knows anything about the mints on this network.
 *
 * The one place a cluster reaches this file. Callers use it to decide whether
 * to ask at all, and to say why a list has no prices in it.
 */
export const covers = (cluster: ClusterId) => cluster === "mainnet-beta";

// ------------------------------------------------------------------- pacing

/**
 * One request at a time, at most one every `MIN_GAP_MS`, at most
 * `MAX_PER_WINDOW` in any minute — and nothing at all while a 429 stands.
 *
 * Deliberately a single serial gate rather than a queue with priorities: this
 * app makes two kinds of Jupiter request, a batch when the picker opens and a
 * search while someone types, and both are one user's one action. Ordering
 * them is enough; ranking them would be machinery with nothing to rank.
 */
const MIN_GAP_MS = 1_100;
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 30;
/** No `Retry-After` is ever sent, so a 429 costs a fixed, self-chosen pause. */
const BACKOFF_MS = 20_000;

let chain: Promise<unknown> = Promise.resolve();
let blockedUntil = 0;
const stamps: number[] = [];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function slot<T>(run: () => Promise<T>): Promise<T> {
  const mine = chain.then(async () => {
    const now = Date.now();
    // Trim the window before counting it, or a quiet minute never expires.
    while (stamps.length && stamps[0] <= now - WINDOW_MS) stamps.shift();
    let waitUntil = Math.max(blockedUntil, (stamps[stamps.length - 1] ?? 0) + MIN_GAP_MS);
    if (stamps.length >= MAX_PER_WINDOW) waitUntil = Math.max(waitUntil, stamps[0] + WINDOW_MS);
    if (waitUntil > now) await sleep(waitUntil - now);
    stamps.push(Date.now());
    return run();
  });
  // The chain must survive a failed link, so it carries the settled promise
  // rather than the rejected one — otherwise one network error stops the app
  // making any further request for the life of the page.
  chain = mine.catch(() => undefined);
  return mine;
}

// -------------------------------------------------------------------- cache

/** How long a fetched row answers without asking again. */
const FRESH_MS = 30_000;
/** How long a mint Jupiter did not recognise stays unasked about. */
const MISSING_MS = 300_000;
const MAX_CACHED = 600;
const MAX_MISSING = 2_000;
/** The search endpoint's own limit on a comma-separated query. */
const BATCH = 100;

const cache = new Map<string, { token: JupToken; at: number }>();
const missing = new Map<string, number>();

function remember(token: JupToken) {
  // Re-inserting refreshes insertion order, so the trim below evicts the
  // least recently seen rather than the least recently fetched.
  cache.delete(token.mint);
  cache.set(token.mint, { token, at: Date.now() });
  missing.delete(token.mint);
  while (cache.size > MAX_CACHED) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function markMissing(mint: string) {
  missing.set(mint, Date.now());
  const cutoff = Date.now() - MISSING_MS;
  for (const [key, at] of missing) if (at <= cutoff) missing.delete(key);
  while (missing.size > MAX_MISSING) {
    const oldest = missing.keys().next().value;
    if (oldest === undefined) break;
    missing.delete(oldest);
  }
}

/** Whatever is already known, with no request and no waiting. */
export function cached(mints: string[]): Map<string, JupToken> {
  const out = new Map<string, JupToken>();
  const now = Date.now();
  for (const mint of mints) {
    const entry = cache.get(mint);
    if (entry && now - entry.at < FRESH_MS) out.set(mint, entry.token);
  }
  return out;
}

// ------------------------------------------------------------------ parsing

function parse(raw: Record<string, unknown>): JupToken | undefined {
  const mint = typeof raw.id === "string" ? raw.id : undefined;
  if (!mint) return undefined;
  const symbol = typeof raw.symbol === "string" && raw.symbol.trim() ? raw.symbol.trim() : undefined;
  const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : undefined;
  return {
    mint,
    // A row with no symbol is still worth keeping for its price and icon, so
    // the address stands in rather than the row being dropped.
    symbol: symbol ?? `${mint.slice(0, 4)}…`,
    name: name ?? symbol ?? mint,
    icon: typeof raw.icon === "string" ? raw.icon : undefined,
    decimals: typeof raw.decimals === "number" ? raw.decimals : 0,
    tokenProgram: typeof raw.tokenProgram === "string" ? raw.tokenProgram : "",
    usdPrice: typeof raw.usdPrice === "number" && Number.isFinite(raw.usdPrice) ? raw.usdPrice : 0,
    verified: raw.isVerified === true,
    tags: Array.isArray(raw.tags) ? raw.tags.filter((t): t is string => typeof t === "string") : [],
    liquidity: typeof raw.liquidity === "number" ? raw.liquidity : undefined
  };
}

const TIMEOUT_MS = 10_000;

/** One trip to the search endpoint. Answers with [] rather than throwing. */
async function fetchSearch(query: string, signal?: AbortSignal): Promise<JupToken[]> {
  if (signal?.aborted) return [];
  return slot(async () => {
    // Checked again inside the slot, and not only for tidiness: a caller that
    // gave up while this was queued behind the minimum gap would otherwise
    // spend a request on an answer nothing is waiting for. `addEventListener`
    // alone does not cover it — a signal already aborted never fires again.
    if (signal?.aborted) return [];
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    signal?.addEventListener("abort", onAbort);
    const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(`${SEARCH_URL}?query=${encodeURIComponent(query)}`, {
        signal: abort.signal
      });
      if (response.status === 429) {
        blockedUntil = Date.now() + BACKOFF_MS;
        return [];
      }
      if (!response.ok) return [];
      const payload: unknown = await response.json();
      const rows: unknown[] = Array.isArray(payload) ? payload : [];
      const tokens: JupToken[] = [];
      for (const row of rows) {
        const token = row && typeof row === "object" ? parse(row as Record<string, unknown>) : undefined;
        if (token) {
          remember(token);
          tokens.push(token);
        }
      }
      return tokens;
    } catch {
      // A drop, a timeout or an abort. None of them says anything about the
      // mints asked for, so nothing is marked missing here — that is done only
      // for a request that actually answered.
      return [];
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  });
}

// ----------------------------------------------------------------- batching

let queued = new Set<string>();
let flush: Promise<void> | null = null;

/**
 * Metadata for a list of mints, batched across every caller in the same tick.
 *
 * Two panels asking about the same wallet in one render is one request, which
 * is the point: a caller does not have to know what anything else on the page
 * is doing. What comes back is only what Jupiter recognised — an absent mint
 * is not an error, it is a mint with no listing.
 */
export async function metadataFor(mints: string[]): Promise<Map<string, JupToken>> {
  const unique = [...new Set(mints.filter(Boolean))];
  if (!unique.length) return new Map();

  const now = Date.now();
  const wanted = unique.filter((mint) => {
    const entry = cache.get(mint);
    if (entry && now - entry.at < FRESH_MS) return false;
    const at = missing.get(mint);
    return !(at && now - at < MISSING_MS);
  });

  if (wanted.length) {
    for (const mint of wanted) queued.add(mint);
    if (!flush) {
      flush = new Promise<void>((resolve) => {
        setTimeout(() => {
          const batch = [...queued];
          queued = new Set();
          flush = null;
          void (async () => {
            for (let i = 0; i < batch.length; i += BATCH) {
              const chunk = batch.slice(i, i + BATCH);
              const found = new Set((await fetchSearch(chunk.join(","))).map((t) => t.mint));
              for (const mint of chunk) if (!found.has(mint)) markMissing(mint);
            }
            resolve();
          })();
        }, 0);
      });
    }
    await flush;
  }

  const out = new Map<string, JupToken>();
  for (const mint of unique) {
    const entry = cache.get(mint);
    if (entry) out.set(mint, entry.token);
  }
  return out;
}

/**
 * Free-text search across Jupiter's whole list — a symbol, a name, or the mint
 * address of a token this wallet has never held.
 *
 * Not cached by query, only by the mints it returns: a search is a keystroke,
 * and the answer to a prefix is not the answer to the next one. `signal` is
 * what keeps a fast typist to one request; the limiter only paces what is left.
 */
export async function searchTokens(query: string, signal?: AbortSignal): Promise<JupToken[]> {
  const trimmed = query.trim();
  if (trimmed.length < 2) return [];
  return fetchSearch(trimmed, signal);
}
