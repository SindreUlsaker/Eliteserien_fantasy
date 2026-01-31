'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

type RankPoint = { gw: number; overallRank: number };

type ChipPlay = {
  gw: number;
  name: string;
  time: string;
};

type Props = {
  entryId: number;
  apiBase: string;
};

type ApiResponse = {
  entryId: number;
  points: RankPoint[];
  chips: ChipPlay[];
};

function formatInt(n: number) {
  return n.toLocaleString('no-NO');
}

function deltaLabel(delta: number) {
  // Negativ delta = bedre rank (lavere tall)
  if (delta === 0) return '0';
  return delta > 0 ? `+${formatInt(delta)}` : `-${formatInt(Math.abs(delta))}`;
}

function chipLabel(name: string) {
  switch (name) {
    case '2capt':
      return 'To kapteiner';
    case 'wildcard':
      return 'Wildcard';
    case 'frush':
      return 'Spissrush';
    case 'rich':
      return 'Rik onkel';
    default:
      return name;
  }
}

function chipColor(name: string) {
  // Bevisst "punchy" – ser bra ut på mørk glass-card
  switch (name) {
    case '2capt':
      return '#B57BFF'; // lilla
    case 'wildcard':
      return '#55D6FF'; // cyan
    case 'frush':
      return '#5CFFB1'; // grønn
    case 'rich':
      return '#FFC857'; // gull
    default:
      return '#FFFFFF';
  }
}

export function OverallRankCard({ entryId, apiBase }: Props) {
  const [points, setPoints] = useState<RankPoint[]>([]);
  const [chips, setChips] = useState<ChipPlay[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;

    async function load() {
      setLoading(true);
      setError(null);

      try {
        const res = await fetch(`${apiBase}/entries/${entryId}/overall-rank`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const data = (await res.json()) as ApiResponse;

        const rows = Array.isArray(data.points) ? data.points : [];
        const chipRows = Array.isArray(data.chips) ? data.chips : [];

        if (isMounted) {
          setPoints(rows);
          setChips(chipRows);
        }
      } catch (e) {
        if (isMounted) {
          setError(e instanceof Error ? e.message : 'Ukjent feil');
          setPoints([]);
          setChips([]);
        }
      } finally {
        if (isMounted) setLoading(false);
      }
    }

    load();
    return () => {
      isMounted = false;
    };
  }, [entryId, apiBase]);

  const chipByGw = useMemo(() => {
    const m = new Map<number, ChipPlay[]>();
    for (const c of chips) {
      const arr = m.get(c.gw) ?? [];
      arr.push(c);
      m.set(c.gw, arr);
    }
    return m;
  }, [chips]);

  const summary = useMemo(() => {
    if (points.length === 0) return null;

    const sorted = [...points].sort((a, b) => a.gw - b.gw);
    const last = sorted[sorted.length - 1];
    const prev = sorted.length >= 2 ? sorted[sorted.length - 2] : null;

    const bestPoint = sorted.reduce(
      (acc, p) => (p.overallRank < acc.overallRank ? p : acc),
      sorted[0]
    );
    const worstPoint = sorted.reduce(
      (acc, p) => (p.overallRank > acc.overallRank ? p : acc),
      sorted[0]
    );

    const best = bestPoint.overallRank;
    const worst = worstPoint.overallRank;

    const delta = prev ? prev.overallRank - last.overallRank : null;

    return { last, prev, best, worst, delta, bestPoint, worstPoint };
  }, [points]);

  const chipLegend = useMemo(() => {
    // Vis bare chips som faktisk finnes for denne entryen (ryddig)
    const names = Array.from(new Set(chips.map((c) => c.name)));
    return names;
  }, [chips]);

  return (
    <section
      style={{
        border: '1px solid rgba(255,255,255,0.10)',
        borderRadius: 16,
        padding: 18,
        background:
          'linear-gradient(180deg, rgba(255,255,255,0.06) 0%, rgba(255,255,255,0.02) 100%)',
        boxShadow: '0 10px 30px rgba(0,0,0,0.25)',
        backdropFilter: 'blur(10px)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 12,
        }}
      >
        <div>
          <div
            style={{
              fontSize: 12,
              letterSpacing: 0.6,
              textTransform: 'uppercase',
              opacity: 0.75,
            }}
          >
            Overall rank
          </div>
          <div style={{ fontSize: 20, fontWeight: 700, marginTop: 4 }}>
            {summary ? formatInt(summary.last.overallRank) : '—'}
          </div>
          <div style={{ fontSize: 12, opacity: 0.75, marginTop: 2 }}>
            {summary ? `Sist oppdatert: GW ${summary.last.gw}` : 'Ingen data'}
          </div>
        </div>

        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 12, opacity: 0.75, marginTop: 2 }}>
            {summary?.prev ? `Fra GW ${summary.prev.gw} → ${summary.last.gw}` : 'Trenger 2 runder'}
          </div>
          <div style={{ fontSize: 18, fontWeight: 700, marginTop: 4 }}>
            {summary?.delta == null ? '—' : deltaLabel(summary.delta)}
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 12, marginTop: 14, flexWrap: 'wrap' }}>
        <div
          style={{
            padding: '10px 12px',
            borderRadius: 12,
            border: '1px solid rgba(255,255,255,0.10)',
            background: 'rgba(0,0,0,0.15)',
            minWidth: 140,
          }}
        >
          <div style={{ fontSize: 12, opacity: 0.75 }}>Beste</div>
          <div style={{ fontSize: 16, fontWeight: 700 }}>
            {summary ? `${formatInt(summary.best)} (GW ${summary.bestPoint.gw})` : '—'}
          </div>
        </div>

        <div
          style={{
            padding: '10px 12px',
            borderRadius: 12,
            border: '1px solid rgba(255,255,255,0.10)',
            background: 'rgba(0,0,0,0.15)',
            minWidth: 140,
          }}
        >
          <div style={{ fontSize: 12, opacity: 0.75 }}>Verste</div>
          <div style={{ fontSize: 16, fontWeight: 700 }}>
            {summary ? `${formatInt(summary.worst)} (GW ${summary.worstPoint.gw})` : '—'}
          </div>
        </div>
      </div>

      {chipLegend.length > 0 && (
        <div style={{ marginTop: 12, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {chipLegend.map((name) => (
            <div
              key={name}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '6px 10px',
                borderRadius: 999,
                border: '1px solid rgba(255,255,255,0.10)',
                background: 'rgba(0,0,0,0.12)',
                fontSize: 12,
                opacity: 0.9,
              }}
              title={chipLabel(name)}
            >
              <span
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: 999,
                  background: chipColor(name),
                  boxShadow: `0 0 0 3px rgba(255,255,255,0.06)`,
                }}
              />
              <span>{chipLabel(name)}</span>
            </div>
          ))}
        </div>
      )}

      <div style={{ height: 260, marginTop: 14 }}>
        {loading && <div style={{ opacity: 0.8 }}>Laster historikk…</div>}
        {error && <div style={{ color: 'salmon' }}>Feil: {error}</div>}

        {!loading && !error && points.length > 0 && (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={points} margin={{ top: 10, right: 12, bottom: 6, left: 4 }}>
              <CartesianGrid strokeDasharray="3 3" opacity={0.25} />
              <XAxis
                dataKey="gw"
                tickLine={false}
                axisLine={false}
                tick={{ opacity: 0.8, fontSize: 12 }}
              />
              <YAxis
                dataKey="overallRank"
                reversed
                scale="log"
                domain={['dataMin', 'dataMax']}
                tickLine={false}
                axisLine={false}
                tick={{ opacity: 0.8, fontSize: 12 }}
                width={62}
              />

              <Tooltip
                formatter={(value) => formatInt(Number(value))}
                labelFormatter={(label) => {
                  const gw = Number(label);
                  const chipNames = chipByGw.get(gw)?.map((c) => chipLabel(c.name)) ?? [];
                  return chipNames.length > 0
                    ? `GW ${gw} · Chip: ${chipNames.join(', ')}`
                    : `GW ${gw}`;
                }}
                contentStyle={{
                  background: 'rgba(10,10,10,0.92)',
                  border: '1px solid rgba(255,255,255,0.12)',
                  borderRadius: 12,
                  boxShadow: '0 10px 30px rgba(0,0,0,0.25)',
                }}
                itemStyle={{ color: 'white' }}
                labelStyle={{ color: 'rgba(255,255,255,0.75)' }}
              />

              <Line
                type="monotone"
                dataKey="overallRank"
                stroke="currentColor"
                strokeWidth={2.5}
                // render prikk kun når chip brukt i denne GW
                dot={(props: any) => {
                  const { cx, cy, payload } = props;
                  const gw = payload?.gw;
                  if (typeof gw !== 'number') return null;

                  const chipPlays = chipByGw.get(gw);
                  if (!chipPlays || chipPlays.length === 0) return null;

                  const primary = chipPlays[0];
                  const fill = chipColor(primary.name);

                  return (
                    <circle
                      cx={cx}
                      cy={cy}
                      r={4.5}
                      fill={fill}
                      stroke="rgba(0,0,0,0.55)"
                      strokeWidth={1.5}
                    />
                  );
                }}
                activeDot={{ r: 5 }}
              />
            </LineChart>
          </ResponsiveContainer>
        )}

        {!loading && !error && points.length === 0 && (
          <div style={{ opacity: 0.8 }}>Ingen historikk tilgjengelig.</div>
        )}
      </div>
    </section>
  );
}
