/**
 * Loading state for a chain read.
 *
 * Every view here does the same thing: fetch on mount, fetch again when the
 * cluster or an address changes, and re-fetch after a transaction lands. The
 * generation counter is what makes the last of those safe — a slow response
 * from a previous cluster must never overwrite the current one's data.
 */
import { useCallback, useEffect, useRef, useState } from "react";

export type Async<T> = {
  data?: T;
  error?: string;
  loading: boolean;
  reload: () => void;
};

export function useAsync<T>(load: () => Promise<T>, deps: unknown[]): Async<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const generation = useRef(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    const mine = ++generation.current;
    setLoading(true);
    load()
      .then((value) => {
        if (generation.current !== mine) return;
        setData(value);
        setError(undefined);
      })
      .catch((e: unknown) => {
        if (generation.current !== mine) return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (generation.current === mine) setLoading(false);
      });
    // `load` is intentionally not a dependency: callers build it inline, so it
    // is a new function every render and would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  return { data, error, loading, reload };
}
