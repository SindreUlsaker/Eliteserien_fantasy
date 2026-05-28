'use client';

import { useMemo, useState } from 'react';
import { useUser } from './user-context';
import { OverallRankCard } from './overall-rank-card';
import { useEntryInsights } from './hooks/useEntryInsights';
import { useEntryTeam, PlayerPickView } from './hooks/useEntryTeam';

type EntryHit = {
  id: number;
  entryName: string;
  playerName: string;
  lastOverallRank: number | null;
  lastOverallTotal: number | null;
};

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:3001';

function groupByPosition(arr: PlayerPickView[]) {
  return {
    gkp: arr.filter((p) => p.elementType === 'GKP'),
    def: arr.filter((p) => p.elementType === 'DEF'),
    mid: arr.filter((p) => p.elementType === 'MID'),
    fwd: arr.filter((p) => p.elementType === 'FWD'),
  };
}

function capTag(p: PlayerPickView) {
  if (p.isCaptain) return 'C';
  if (p.isViceCaptain) return 'VC';
  if (p.multiplier > 1) return `x${p.multiplier}`;
  return '';
}

function TeamRow({ p }: { p: PlayerPickView }) {
  const tag = capTag(p);

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '64px 1fr 56px',
        gap: 10,
        alignItems: 'center',
        padding: '8px 10px',
        borderRadius: 12,
        border: '1px solid var(--border)',
        background: 'var(--surface-strong)',
      }}
    >
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <div
          title={p.teamName}
          style={{
            fontSize: 12,
            padding: '4px 8px',
            borderRadius: 999,
            border: '1px solid var(--border)',
            background: 'var(--surface)',
            opacity: 0.95,
            width: 54,
            textAlign: 'center',
          }}
        >
          {p.teamShort}
        </div>
      </div>

      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <div
            style={{
              fontWeight: 650,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {p.name}
          </div>
          {tag && (
            <div
              style={{
                fontSize: 11,
                padding: '2px 8px',
                borderRadius: 999,
                border: '1px solid var(--border)',
                background: 'var(--surface)',
                opacity: 0.95,
              }}
              title={p.isCaptain ? 'Captain' : p.isViceCaptain ? 'Vice captain' : 'Multiplier'}
            >
              {tag}
            </div>
          )}
        </div>
        <div style={{ fontSize: 12, opacity: 0.7 }}>
          {p.elementType} · {p.points}p
          {p.multiplier > 1 ? ` (×${p.multiplier} = ${p.points * p.multiplier}p)` : ''}
        </div>
      </div>

      <div style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
        <div style={{ fontWeight: 750 }}>{p.points * p.multiplier}</div>
        <div style={{ fontSize: 12, opacity: 0.7 }}>p</div>
      </div>
    </div>
  );
}

function TeamSection({ title, list }: { title: string; list: PlayerPickView[] }) {
  return (
    <div style={{ marginTop: 14 }}>
      <div style={{ fontSize: 12, opacity: 0.75, letterSpacing: 0.6, textTransform: 'uppercase' }}>
        {title}
      </div>
      <div style={{ marginTop: 8, display: 'grid', gap: 8 }}>
        {list.map((p) => (
          <TeamRow key={`${p.playerId}-${p.position}`} p={p} />
        ))}
      </div>
    </div>
  );
}

export default function HomePage() {
  const { selectedEntry, setSelectedEntry, isLoading } = useUser();

  // Prefetch insights så /compare er snappere når brukeren navigerer dit.
  // Returverdien brukes ikke her — Cache-Control: max-age=30 på API-svaret
  // gjør at /compare-mounten serveres fra browser-cachen.
  useEntryInsights(selectedEntry?.id ?? null);

  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<EntryHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // modal state for “team in gw”
  const [teamOpen, setTeamOpen] = useState(false);
  const [selectedGw, setSelectedGw] = useState<number | null>(null);

  const {
    data: teamData,
    loading: teamLoading,
    error: teamError,
  } = useEntryTeam(selectedEntry?.id ?? null, selectedGw, teamOpen);

  const xiGroups = useMemo(() => {
    if (!teamData?.team?.xi) return null;
    return groupByPosition(teamData.team.xi);
  }, [teamData]);

  const benchGroups = useMemo(() => {
    if (!teamData?.team?.bench) return null;
    return groupByPosition(teamData.team.bench);
  }, [teamData]);

  if (isLoading) {
    return (
      <main
        style={{
          maxWidth: 900,
          margin: '0 auto',
          padding: 24,
          fontFamily: 'system-ui, sans-serif',
        }}
      >
        <h1 style={{ fontSize: 28, marginBottom: 12 }}>Eliteserien Fantasy</h1>
        <section
          style={{ border: '1px solid #ddd', borderRadius: 10, padding: 16, marginBottom: 20 }}
        >
          Laster bruker…
        </section>
      </main>
    );
  }

  const canSearch = query.trim().length > 0;

  async function runSearch() {
    const q = query.trim();
    if (!q) return;

    setLoading(true);
    setError(null);
    setHits([]);

    try {
      const res = await fetch(`${API_BASE}/entries/search?q=${encodeURIComponent(q)}&limit=25`);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = (await res.json()) as EntryHit[];
      setHits(Array.isArray(data) ? data : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ukjent feil');
    } finally {
      setLoading(false);
    }
  }

  function chooseEntry(entry: EntryHit) {
    setSelectedEntry(entry);
    setHits([]);
    setQuery('');
    setError(null);
  }

  function logout() {
    setSelectedEntry(null);
  }

  function openTeamForGw(gw: number) {
    setSelectedGw(gw);
    setTeamOpen(true);
  }

  function closeTeam() {
    setTeamOpen(false);
  }

  return (
    <main className="container">
      <header className="page-header">
        <h1 className="page-title">Oversikt</h1>
      </header>

      {selectedEntry ? (
        <>
          <section className="card card-pad">
            <div className="entry-header">
              <div className="entry-meta">
                <div className="entry-title">
                  {selectedEntry.entryName} <span className="muted">({selectedEntry.id})</span>
                </div>
                <div className="entry-subtitle">{selectedEntry.playerName}</div>
                <div className="entry-rank muted">
                  {selectedEntry.lastOverallRank
                    ? `Overall-rank: ${selectedEntry.lastOverallRank}`
                    : 'Ingen rank-data'}
                </div>
              </div>

              <button onClick={logout} className="btn btn-ghost">
                Bytt lag
              </button>
            </div>
          </section>

          {/* “Dashboard grid”: graf */}
          <section className="dashboard">
            <div className="dashboard-main card">
              <div className="card-pad">
                <OverallRankCard
                  entryId={selectedEntry.id}
                  apiBase={API_BASE}
                  onSelectGw={openTeamForGw}
                />
              </div>
            </div>
          </section>

          {/* NEW: Modal */}
          {teamOpen && (
            <div
              onClick={closeTeam}
              style={{
                position: 'fixed',
                inset: 0,
                background: 'rgba(0,0,0,0.55)',
                zIndex: 50,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: 16,
              }}
            >
              <div
                onClick={(e) => e.stopPropagation()}
                style={{
                  width: 'min(980px, 100%)',
                  maxHeight: 'min(88vh, 900px)',
                  overflow: 'auto',
                  borderRadius: 16,
                  border: '1px solid var(--border)',
                  background: 'var(--surface)',
                  color: 'var(--text)',
                  boxShadow: '0 20px 60px rgba(0,0,0,0.45)',
                  padding: 16,
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
                        opacity: 0.75,
                        letterSpacing: 0.6,
                        textTransform: 'uppercase',
                      }}
                    >
                      Lag i runden
                    </div>
                    <div style={{ fontSize: 20, fontWeight: 800, marginTop: 3 }}>
                      {selectedGw ? `GW ${selectedGw}` : '—'}
                    </div>
                    {teamData?.meta?.missingPointsCount ? (
                      <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>
                        Mangler stats for {teamData.meta.missingPointsCount} spillere (viser 0p for
                        dem).
                      </div>
                    ) : null}
                  </div>

                  <button onClick={closeTeam} className="btn btn-ghost">
                    Lukk
                  </button>
                </div>

                <div style={{ marginTop: 12 }}>
                  {teamLoading && <div className="muted">Laster lag…</div>}
                  {teamError && <div className="error">Feil: {teamError}</div>}

                  {!teamLoading && !teamError && teamData && xiGroups && benchGroups && (
                    <>
                      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 10 }}>
                        <div
                          style={{
                            padding: '10px 12px',
                            borderRadius: 12,
                            border: '1px solid var(--border)',
                            background: 'var(--surface-strong)',
                            minWidth: 160,
                          }}
                        >
                          <div style={{ fontSize: 12, opacity: 0.75 }}>XI-poeng</div>
                          <div style={{ fontSize: 18, fontWeight: 800, marginTop: 2 }}>
                            {teamData.team.totals?.totalPointsFromStats ?? '—'}
                          </div>
                        </div>

                        <div
                          style={{
                            padding: '10px 12px',
                            borderRadius: 12,
                            border: '1px solid var(--border)',
                            background: 'var(--surface-strong)',
                            minWidth: 220,
                          }}
                        >
                          <div style={{ fontSize: 12, opacity: 0.75 }}>Entry-history</div>
                          <div style={{ fontSize: 12, opacity: 0.9, marginTop: 4 }}>
                            GW points: {teamData.entryHistory?.points ?? '—'} · Overall-rank:{' '}
                            {teamData.entryHistory?.overallRank ?? '—'}
                          </div>
                        </div>
                      </div>

                      <TeamSection title="XI · GKP" list={xiGroups.gkp} />
                      <TeamSection title="XI · DEF" list={xiGroups.def} />
                      <TeamSection title="XI · MID" list={xiGroups.mid} />
                      <TeamSection title="XI · FWD" list={xiGroups.fwd} />

                      <div
                        style={{
                          marginTop: 18,
                          paddingTop: 12,
                          borderTop: '1px solid var(--border)',
                        }}
                      >
                        <div
                          style={{
                            fontSize: 12,
                            opacity: 0.75,
                            letterSpacing: 0.6,
                            textTransform: 'uppercase',
                          }}
                        >
                          Bench
                        </div>
                        <div style={{ marginTop: 8, display: 'grid', gap: 8 }}>
                          {teamData.team.bench.map((p) => (
                            <TeamRow key={`${p.playerId}-${p.position}`} p={p} />
                          ))}
                        </div>
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>
          )}
        </>
      ) : (
        <section className="card card-pad">
          <h2 className="section-title">Finn laget ditt</h2>
          <p className="muted">
            Søk med <b>ID</b>, <b>lagnavn</b> eller <b>fullt navn</b>.
          </p>

          <div className="search-row">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="F.eks. Sindre Ulsaker"
              className="input"
              onKeyDown={(e) => {
                if (e.key === 'Enter') runSearch();
              }}
            />
            <button
              onClick={runSearch}
              disabled={!canSearch || loading}
              className="btn btn-primary"
            >
              {loading ? 'Søker...' : 'Søk'}
            </button>
          </div>

          {error && <div className="error">Feil: {error}</div>}

          {hits.length > 0 && (
            <div className="hits">
              <div className="muted">Treff: {hits.length}</div>
              <div className="list card">
                {hits.map((h) => (
                  <button key={h.id} onClick={() => chooseEntry(h)} className="list-row">
                    <div className="list-title">
                      {h.entryName} <span className="muted">({h.id})</span>
                    </div>
                    <div className="list-subtitle">{h.playerName}</div>
                    <div className="muted">
                      {h.lastOverallRank ? `Rank: ${h.lastOverallRank}` : 'Rank: —'}
                      {h.lastOverallTotal ? ` · Poeng: ${h.lastOverallTotal}` : ''}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}
        </section>
      )}
    </main>
  );
}
