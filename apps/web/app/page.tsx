'use client';

import { useEffect, useMemo, useState } from 'react';

type EntryHit = {
  id: number;
  entryName: string;
  playerName: string;
  lastOverallRank: number | null;
  lastOverallTotal: number | null;
};

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:3001';

export default function HomePage() {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<EntryHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [selected, setSelected] = useState<EntryHit | null>(null);

  // last selected entryId from localStorage
  useEffect(() => {
    try {
      const raw = localStorage.getItem('entryId');
      if (!raw) return;
      const id = Number(raw);
      if (!Number.isFinite(id)) return;

      // vi kan “hydrate” selected ved å søke på ID (endpoint returnerer [entry] eller [])
      (async () => {
        const res = await fetch(`${API_BASE}/entries/search?q=${encodeURIComponent(String(id))}`);
        if (!res.ok) return;
        const data = (await res.json()) as EntryHit[];
        if (Array.isArray(data) && data.length > 0) setSelected(data[0]);
      })().catch(() => {});
    } catch {
      // ignore
    }
  }, []);

  const canSearch = useMemo(() => query.trim().length > 0, [query]);

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
    setSelected(entry);
    setHits([]);
    setQuery('');
    setError(null);

    try {
      localStorage.setItem('entryId', String(entry.id));
    } catch {
      // ignore
    }
  }

  function logout() {
    setSelected(null);
    try {
      localStorage.removeItem('entryId');
    } catch {
      // ignore
    }
  }

  return (
    <main
      style={{ maxWidth: 900, margin: '0 auto', padding: 24, fontFamily: 'system-ui, sans-serif' }}
    >
      <h1 style={{ fontSize: 28, marginBottom: 12 }}>Eliteserien Fantasy</h1>

      {selected ? (
        <section
          style={{ border: '1px solid #ddd', borderRadius: 10, padding: 16, marginBottom: 20 }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              gap: 12,
              alignItems: 'center',
            }}
          >
            <div>
              <div style={{ fontSize: 18, fontWeight: 600 }}>
                {selected.entryName}{' '}
                <span style={{ fontWeight: 400, color: '#666' }}>({selected.id})</span>
              </div>
              <div style={{ color: '#444' }}>{selected.playerName}</div>
              <div style={{ color: '#666', marginTop: 6 }}>
                {selected.lastOverallRank
                  ? `Sist kjente overall-rank: ${selected.lastOverallRank}`
                  : 'Ingen rank-data'}
              </div>
            </div>

            <button
              onClick={logout}
              style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #ccc' }}
            >
              Bytt lag
            </button>
          </div>
        </section>
      ) : (
        <section
          style={{ border: '1px solid #ddd', borderRadius: 10, padding: 16, marginBottom: 20 }}
        >
          <h2 style={{ fontSize: 18, marginTop: 0 }}>Finn laget ditt</h2>
          <p style={{ marginTop: 6, color: '#555' }}>
            Søk med <b>ID</b>, <b>lagnavn</b> eller <b>fullt navn</b>. Trefflisten vises selv om det
            bare er ett treff.
          </p>

          <div style={{ display: 'flex', gap: 8 }}>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="F.eks. 20287, FC Urzaiz, Jørgen Rui"
              style={{
                flex: 1,
                padding: '10px 12px',
                borderRadius: 8,
                border: '1px solid #ccc',
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') runSearch();
              }}
            />
            <button
              onClick={runSearch}
              disabled={!canSearch || loading}
              style={{
                padding: '10px 12px',
                borderRadius: 8,
                border: '1px solid #ccc',
                opacity: !canSearch || loading ? 0.6 : 1,
              }}
            >
              {loading ? 'Søker...' : 'Søk'}
            </button>
          </div>

          {error && <div style={{ marginTop: 10, color: 'crimson' }}>Feil: {error}</div>}

          {hits.length > 0 && (
            <div style={{ marginTop: 14 }}>
              <div style={{ color: '#666', marginBottom: 8 }}>Treff: {hits.length}</div>
              <div style={{ border: '1px solid #eee', borderRadius: 10, overflow: 'hidden' }}>
                {hits.map((h) => (
                  <button
                    key={h.id}
                    onClick={() => chooseEntry(h)}
                    style={{
                      display: 'block',
                      width: '100%',
                      textAlign: 'left',
                      padding: 12,
                      border: 'none',
                      borderBottom: '1px solid #eee',
                      background: 'white',
                      cursor: 'pointer',
                    }}
                  >
                    <div style={{ fontWeight: 600 }}>
                      {h.entryName} <span style={{ fontWeight: 400, color: '#666' }}>({h.id})</span>
                    </div>
                    <div style={{ color: '#444' }}>{h.playerName}</div>
                    <div style={{ color: '#666', marginTop: 4 }}>
                      {h.lastOverallRank ? `Rank: ${h.lastOverallRank}` : 'Rank: —'}
                      {h.lastOverallTotal ? ` · Poeng: ${h.lastOverallTotal}` : ''}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {hits.length === 0 && !loading && query.trim() && !error && (
            <div style={{ marginTop: 12, color: '#666' }}>Ingen treff.</div>
          )}
        </section>
      )}

      <section style={{ color: '#666' }}>
        <div style={{ marginBottom: 6 }}>
          API-base: <code>{API_BASE}</code>
        </div>
        <div style={{ fontSize: 13 }}>
          (Tips: sett <code>NEXT_PUBLIC_API_BASE</code> i <code>apps/web/.env.local</code> hvis du
          vil endre dette.)
        </div>
      </section>
    </main>
  );
}
