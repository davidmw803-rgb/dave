'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

interface PollState<T> {
  data: T;
  refreshing: boolean;
  error: string | null;
  refresh: () => void;
}

export function usePoll<T>(
  url: string,
  initial: T,
  intervalMs = 30_000
): PollState<T> {
  const [data, setData] = useState<T>(initial);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await fetch(url, { cache: 'no-store', credentials: 'include' });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const json = (await res.json()) as T;
      if (mounted.current) {
        setData(json);
        setError(null);
      }
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mounted.current) setRefreshing(false);
    }
  }, [url]);

  useEffect(() => {
    mounted.current = true;
    const id = setInterval(refresh, intervalMs);
    return () => {
      mounted.current = false;
      clearInterval(id);
    };
  }, [refresh, intervalMs]);

  return { data, refreshing, error, refresh };
}
