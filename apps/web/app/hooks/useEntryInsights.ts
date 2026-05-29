'use client';

import { useEffect, useState } from 'react';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:3001';

type PosBuckets = { gkp: number; def: number; mid: number; fwd: number };

export type EntryInsightsResponse = {
  insights: {
    captain?: {
      threshold?: number;
      returns5Plus?: number;
      usedGameweeks?: number;
      missingPointsGameweeks?: number;
      missingCaptainGameweeks?: number;
      totalFinishedGameweeksWithPicks?: number;

      baseline?: {
        expectedReturns5Plus?: number | null;
        avgSuccessRate5Plus?: number | null;
        usedGameweeks?: number;
        missingGameweeks?: number;
      };

      diff?: {
        returns5Plus?: number | null;
      };

      topCaptains?: Array<{
        rank: number;
        playerId: number;
        playerName: string;
        gw: number;
        gwName?: string | null;
        points: number;
      }>;
    };

    points?: {
      summary?: {
        avgUserCaptainPoints?: number | null;
        avgBaselineCaptainPoints?: number | null;
        captainPointsDiff?: number | null;

        avgUserByPosition?: PosBuckets | null;
        avgBaselineByPosition?: PosBuckets | null;
        byPositionDiff?: PosBuckets | null;

        // Formation composition (avg players in XI)
        avgUserXI?: PosBuckets | null;
        avgBaselineXI?: PosBuckets | null;
        xiDiff?: PosBuckets | null;

        usedGameweeks?: number;
      };
    };

    risk?: {
      summary?: {
        // Captain EO (effective ownership)
        avgUserCaptainEO?: number | null;
        avgBaselineCaptainEO?: number | null;
        captainEODiff?: number | null;

        // Captain share (expert consensus %)
        avgUserCaptainShare?: number | null;
        avgBaselineCaptainShare?: number | null;
        captainShareDiff?: number | null;

        // Team EO
        avgTeamEO?: number | null;
        avgBaselineTeamEO?: number | null;
        teamEODiff?: number | null;

        // Transfer cost + hits
        avgUserTransferCost?: number | null;
        avgBaselineTransferCost?: number | null;
        transferCostDiff?: number | null;

        userHitCount?: number | null;
        baselineHitCount?: number | null;

        usedGameweeks?: number;
      };
    };

    chips?: {
      used?: Record<string, Array<{ gameweekId: number; points?: number | null }>>;
      notUsed?: string[];
      pointsByChip?: Record<string, Array<{ gameweekId: number; points: number | null }>>;

      baseline?: {
        totalUsed: Record<string, number>;
        usedThisGw: Record<string, number>;
        usedThisGwRate: Record<string, number>;
        sampleSize: number | null;
        points?: {
          avg2captPoints: number | null;
          avgFrushPoints: number | null;
          avgPdbusPoints: number | null;
        } | null;
      } | null;
    };
  };

  meta?: {
    computedThroughGw?: number;
    overallRankNow?: number | null;
    bracket?: { id: number; name: string; rankFrom: number; rankTo: number } | null;
    naturalBracket?: { id: number; name: string; rankFrom: number; rankTo: number } | null;
    bracketIsOverride?: boolean;
    availableBrackets?: Array<{ id: number; name: string; rankFrom: number; rankTo: number }>;

    entrySeasonTotals?: {
      lastUpdatedGw: number;
      gwCount: number;
    };

    bracketStats?: {
      bracketId: number;
      computedThroughGameweekId: number;
      version: number;
      sampleSize: number | null;
    } | null;
  };
};

export function useEntryInsights(entryId: number | null, bracketId?: number | null) {
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
        const url = new URL(`${API_BASE}/entries/${entryId}/insights`);
        if (bracketId != null) url.searchParams.set('bracketId', String(bracketId));

        const res = await fetch(url.toString(), {
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
  }, [entryId, bracketId]);

  return { data, loading, error };
}
