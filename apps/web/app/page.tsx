'use client';

import { useState } from 'react';
import { useUser } from './user-context';
import { OverallRankCard } from './overall-rank-card';
import { useEntryInsights } from './hooks/useEntryInsights';

type EntryHit = {
  id: number;
  entryName: string;
  playerName: string;
  lastOverallRank: number | null;
  lastOverallTotal: number | null;
};

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:3001';

export default function HomePage() {
  const { selectedEntry, setSelectedEntry, isLoading } = useUser();
  const {
    data: insightsData,
    loading: insightsLoading,
    error: insightsError,
  } = useEntryInsights(selectedEntry?.id ?? null);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<EntryHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  // FIL: apps/web/app/page.tsx (endring - kun UI/struktur, logikk beholdes)
  return (
    <main className="container">
      <header className="page-header">
        <h1 className="page-title">Eliteserien Fantasy</h1>
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

          {/* “Dashboard grid”: graf + stats */}
          <section className="dashboard">
            <div className="dashboard-main card">
              <div className="card-pad">
                <OverallRankCard entryId={selectedEntry.id} apiBase={API_BASE} />
              </div>
            </div>

            <div className="dashboard-stats">
              <div className="stat card">
                <div className="card-pad">
                  <div className="stat-label">Kaptein</div>
                  <div className="stat-value">
                    Returns (≥ 5 poeng):{' '}
                    <span className="stat-strong">
                      {insightsData?.insights?.captain
                        ? `${insightsData.insights.captain.returns5Plus}/${insightsData.insights.captain.usedGameweeks}`
                        : '—'}
                    </span>
                  </div>
                  {insightsLoading && <div className="muted">Laster…</div>}
                  {insightsError && <div className="error">Feil: {insightsError}</div>}
                </div>
              </div>

              {/* Placeholder-kort: fyller du med 2–3 nøkkelstats senere */}
              <div className="stat card">
                <div className="card-pad">
                  <div className="stat-label">Beste GW</div>
                  <div className="stat-value">—</div>
                </div>
              </div>

              <div className="stat card">
                <div className="card-pad">
                  <div className="stat-label">Verste GW</div>
                  <div className="stat-value">—</div>
                </div>
              </div>

              <div className="stat card">
                <div className="card-pad">
                  <div className="stat-label">Stabilitet</div>
                  <div className="stat-value">—</div>
                </div>
              </div>
            </div>
          </section>
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
              placeholder="F.eks. 20287, FC Urzaiz, Jørgen Rui"
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
