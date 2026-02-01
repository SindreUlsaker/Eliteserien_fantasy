'use client';

import { useEffect, useState } from 'react';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:3001';

type CaptainInsights = {
  threshold: number;
  returns5Plus: number;
  usedGameweeks: number;
  missingPointsGameweeks: number;
  missingCaptainGameweeks: number;
  totalFinishedGameweeksWithPicks: number;
};

type EntryInsightsResponse = {
  entryId: number;
  sync: { synced: number; totalFinished: number };
  insights: { captain: CaptainInsights };
};

export function useEntryInsights(entryId: number | null) {
  const [data, setData] = useState<EntryInsightsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!entryId) {
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }

    const controller = new AbortController();

    async function run() {
      setLoading(true);
      setError(null);

      try {
        const res = await fetch(`${API_BASE}/entries/${entryId}/insights`, {
          signal: controller.signal,
        });

        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const json = (await res.json()) as EntryInsightsResponse;
        setData(json);
      } catch (e) {
        if (e instanceof Error && e.name === 'AbortError') return;
        setError(e instanceof Error ? e.message : 'Ukjent feil');
        setData(null);
      } finally {
        setLoading(false);
      }
    }

    run();

    return () => controller.abort();
  }, [entryId]);

  return { data, loading, error };
}
