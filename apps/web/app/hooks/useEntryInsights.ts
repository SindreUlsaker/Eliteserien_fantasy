'use client';

import { useEffect, useState } from 'react';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:3001';

type PosBuckets = { gkp: number; def: number; mid: number; fwd: number };

export type CaptainInsights = {
  threshold: number;
  returns5Plus: number;
  usedGameweeks: number;
  missingPointsGameweeks: number;
  missingCaptainGameweeks: number;
  totalFinishedGameweeksWithPicks: number;

  baseline?: {
    expectedReturns5Plus: number | null;
    avgSuccessRate5Plus: number | null;
    usedGameweeks: number;
    missingGameweeks: number;
  };

  diff?: {
    returns5Plus: number | null;
  };

  topCaptains?: Array<{
    playerId: number;
    playerName: string | null;
    gameweekId: number;
    points: number;
  }>;
};

export type EntryInsightsResponse = {
  entryId: number;
  sync: { synced: number; totalFinished: number };

  current?: {
    gameweekId: number;
    overallRank: number | null;
    bracketId: number | null;
  };

  bracketGameweekStats?: {
    bracketId: number;
    gameweekId: number;
    version: number;
    sampleSize: number | null;
    data: any;
  } | null;

  insights: {
    captain: CaptainInsights;

    risk?: {
      summary?: {
        captainShareDiff: number | null;
        teamEODiff: number | null;
        transferCostDiff: number | null;
        usedGameweeks: number;
      };
    };

    points?: {
      summary?: {
        // captain points
        avgUserCaptainPoints?: number | null;
        avgBaselineCaptainPoints?: number | null;
        captainPointsDiff?: number | null;

        // points by position (XI)
        avgUserByPosition?: PosBuckets | null;
        avgBaselineByPosition?: PosBuckets | null;
        byPositionDiff?: PosBuckets | null;

        // XI composition (avg count per position)
        avgUserXI?: PosBuckets | null;
        avgBaselineXI?: PosBuckets | null;
        xiDiff?: PosBuckets | null;

        usedGameweeks?: number;
      };
    };

    chips?: {
      used?: Record<string, Array<{ gameweekId: number; points?: number | null }>>;
      notUsed?: string[];
      pointsByChip?: Record<string, Array<{ gameweekId: number; points: number | null }>>;
    };
  };
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
