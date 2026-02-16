'use client';

import { useEffect, useState } from 'react';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:3001';

export type PlayerPickView = {
  position: number;
  playerId: number;
  name: string;
  teamId: number;
  teamShort: string;
  teamName: string;
  elementType: 'GKP' | 'DEF' | 'MID' | 'FWD';
  multiplier: number;
  isCaptain: boolean;
  isViceCaptain: boolean;
  points: number;

  stats?: {
    fixtureCount: number;
    minutes: number;
    goalsScored: number;
    assists: number;
    cleanSheets: number;
    goalsConceded: number;
    yellowCards: number;
    redCards: number;
    saves: number;
    bonus: number;
  };
};

export type EntryTeamResponse = {
  entryId: number;
  gw: number;
  sync?: { didSync: boolean };

  entryHistory?: {
    points: number | null;
    totalPoints: number | null;
    overallRank: number | null;
    rank: number | null;
    bank: number | null;
    value: number | null;
    eventTransfers: number | null;
    eventTransfersCost: number | null;
  };

  team: {
    xi: Array<PlayerPickView>;
    bench: Array<PlayerPickView>;
    totals?: { totalPointsFromStats: number };
  };

  meta?: {
    pointsSource?: string;
    missingPointsCount?: number;
  };
};

export function useEntryTeam(entryId: number | null, gw: number | null, enabled: boolean) {
  const [data, setData] = useState<EntryTeamResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || !entryId || !gw) {
      setData(null);
      setLoading(false);
      setError(null);
      return;
    }

    const controller = new AbortController();

    async function run() {
      setLoading(true);
      setError(null);

      try {
        const res = await fetch(`${API_BASE}/entries/${entryId}/team/${gw}`, {
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const json = (await res.json()) as EntryTeamResponse;
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
  }, [entryId, gw, enabled]);

  return { data, loading, error };
}
