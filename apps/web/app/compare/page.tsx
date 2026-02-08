'use client';

import { useEffect, useMemo, useState } from 'react';
import { useUser } from '../user-context';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:3001';

type InsightsResponse = {
  entryId: number;
  insights: {
    risk?: {
      summary?: {
        captainShareDiff: number | null;
        teamEODiff: number | null;

        transferCostDiff: number | null;

        usedGameweeks: number;
      };
    };
  };
};

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

function posCaptainOrTeam(diff: number | null, span: number) {
  // Venstre = tryggere, høyre = mer annerledes.
  if (diff == null) return null;
  const normalized = diff / span; // -1..1-ish
  const p = 0.5 - normalized * 0.5;
  return clamp(p, 0, 1);
}

function posHits(diff: number | null, span: number) {
  // Venstre = tryggere (færre hits), høyre = mer annerledes (flere hits).
  if (diff == null) return null;
  const normalized = diff / span;
  const p = 0.5 + normalized * 0.5;
  return clamp(p, 0, 1);
}

type Tilt = 'SAFE' | 'NEUTRAL' | 'DIFFERENT' | 'UNKNOWN';

function tiltFromPos(pos: number | null) {
  if (pos == null) return 'UNKNOWN' as const;
  if (pos <= 0.35) return 'SAFE' as const;
  if (pos >= 0.65) return 'DIFFERENT' as const;
  return 'NEUTRAL' as const;
}

function overallComment(tilts: { captain: Tilt; team: Tilt; hits: Tilt }) {
  const vals = [tilts.captain, tilts.team, tilts.hits];
  const known = vals.filter((x) => x !== 'UNKNOWN');

  if (known.length < 2) {
    return {
      title: 'Ikke nok data ennå',
      text: 'Vi trenger flere ferdige runder med oppdaterte bracket-tall før vi kan gi en stabil spillestil-profil.',
      tone: 'muted' as const,
    };
  }

  const safeCount = known.filter((x) => x === 'SAFE').length;
  const diffCount = known.filter((x) => x === 'DIFFERENT').length;

  if (safeCount >= 2 && diffCount === 0) {
    return {
      title: 'Går ofte for tryggere valg',
      text: 'Du ligger oftere på den trygge siden av snittet: populære kapteiner, mer standard lagvalg og/eller færre hits enn andre i samme bracket.',
      tone: 'pos' as const,
    };
  }

  if (diffCount >= 2 && safeCount === 0) {
    return {
      title: 'Lener mot mer annerledes valg',
      text: 'Du havner oftere på den “annerledes” siden av snittet: mindre populære kapteiner, mer varierte lagvalg og/eller flere hits enn andre i samme bracket.',
      tone: 'neg' as const,
    };
  }

  if (diffCount >= 1 && safeCount >= 1) {
    return {
      title: 'Blandet profil',
      text: 'På noen områder tar du mer annerledes valg enn snittet, men kompenserer med tryggere valg andre steder.',
      tone: 'mid' as const,
    };
  }

  return {
    title: 'Nær snittet',
    text: 'Totalt sett ligger du ofte nær gjennomsnittet i din bracket på kaptein, lag-EO og hits.',
    tone: 'mid' as const,
  };
}

export default function ComparePage() {
  const { selectedEntry, entryId, isLoading } = useUser();

  const [data, setData] = useState<InsightsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [styleHelpOpen, setStyleHelpOpen] = useState(false);

  useEffect(() => {
    if (!entryId) {
      setData(null);
      return;
    }

    let alive = true;

    async function run() {
      setLoading(true);
      setError(null);

      try {
        const res = await fetch(`${API_BASE}/entries/${entryId}/insights`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as InsightsResponse;
        if (alive) setData(json);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : 'Ukjent feil');
      } finally {
        if (alive) setLoading(false);
      }
    }

    run();

    return () => {
      alive = false;
    };
  }, [entryId]);

  const summary = data?.insights?.risk?.summary ?? null;

  // “span” bestemmer hvor fort markøren flytter seg utover. Vi starter konservativt.
  const captainPos = useMemo(
    () => posCaptainOrTeam(summary?.captainShareDiff ?? null, 0.12),
    [summary]
  );
  const teamPos = useMemo(() => posCaptainOrTeam(summary?.teamEODiff ?? null, 1.2), [summary]);
  const hitsPos = useMemo(() => posHits(summary?.transferCostDiff ?? null, 1.0), [summary]);

  const tilts = useMemo(
    () => ({
      captain: tiltFromPos(captainPos),
      team: tiltFromPos(teamPos),
      hits: tiltFromPos(hitsPos),
    }),
    [captainPos, teamPos, hitsPos]
  );

  const comment = useMemo(() => overallComment(tilts), [tilts]);

  const explainer = useMemo(() => {
    if (!summary) return null;
    const used = summary.usedGameweeks ?? 0;

    return [
      'Spillestil bygger på tre ting per ferdige runde, alltid sammenlignet mot andre i samme bracket (samme rank-område):',
      '',
      '• Kaptein: hvor populær kapteinen din er i bracketen (midten = snittet).',
      '• Lag: hvor “vanlig” laget ditt er basert på samlet EO (midten = snittet).',
      '• Hits: hvor ofte/ mye du tar hits (midten = snittet).',
      '',
      'Venstre side betyr at du oftere er tryggere enn snittet. Høyre side betyr at du oftere gjør mer annerledes valg enn snittet.',
      '',
      `Beregnet over ${used} ferdige gameweeks.`,
    ].join('\n');
  }, [summary]);

  return (
    <main className="container">
      <header className="page-header">
        <h1 className="page-title">Sammenlign</h1>
      </header>

      {!isLoading && !selectedEntry && (
        <section className="card card-pad">
          <div className="compare-empty-title">Ingen valgt entry</div>
          <div className="muted">
            Gå til forsiden og velg laget ditt først, så kan vi hente innsikt automatisk.
          </div>
        </section>
      )}

      {selectedEntry && (
        <section className="compare-grid">
          {/* Kolonne 1: Kaptein (placeholder) */}
          <section className="card card-pad compare-col">
            <div className="compare-section-head">
              <h2 className="section-title">Kaptein</h2>
            </div>
            <div className="muted">(Kommer) Kaptein-poeng vs andre.</div>
          </section>

          {/* Kolonne 2: Lagdel (placeholder) */}
          <section className="card card-pad compare-col">
            <div className="compare-section-head">
              <h2 className="section-title">Lagdel</h2>
            </div>
            <div className="muted">(Kommer) Poeng per lagdel vs andre.</div>
          </section>

          {/* Kolonne 3: Spillestil */}
          <section className="card card-pad compare-col">
            <div className="compare-section-head">
              <div className="compare-title-row">
                <h2 className="section-title">Spillestil</h2>

                <div className="compare-help">
                  <button
                    type="button"
                    className="compare-help-btn"
                    aria-label="Hvordan regnes dette ut?"
                    aria-expanded={styleHelpOpen}
                    onClick={() => setStyleHelpOpen((v) => !v)}
                  >
                    ?
                  </button>

                  {styleHelpOpen && (
                    <div className="compare-help-popover" role="dialog" aria-label="Forklaring">
                      <div className="compare-help-text">{explainer ?? 'Ingen data ennå.'}</div>
                    </div>
                  )}
                </div>
              </div>

              <div className="muted compare-subtitle">
                Sammenlignet med andre i samme bracket per runde
              </div>
            </div>

            {loading && <div className="muted">Laster…</div>}
            {error && <div className="error">Feil: {error}</div>}

            {!loading && !error && !summary && (
              <div className="muted">
                Ingen data ennå. (Sjekk at BracketGameweekStats og EntryInsights er oppdatert.)
              </div>
            )}

            {summary && (
              <>
                <section className={`compare-style-summary compare-bullet-${comment.tone}`}>
                  <div className="compare-style-title">{comment.title}</div>
                  <div className="compare-style-text">{comment.text}</div>
                </section>

                <div className="compare-scales">
                  <div className="compare-scale">
                    <div className="compare-scale-head">
                      <div className="compare-scale-title">Kaptein</div>
                    </div>

                    <div
                      className="compare-scale-track compare-scale-track-captain"
                      style={
                        captainPos == null
                          ? undefined
                          : ({ ['--pos' as any]: `${captainPos * 100}%` } as React.CSSProperties)
                      }
                      aria-label="Kaptein-skala"
                    >
                      <div className="compare-scale-mid" />
                      {captainPos != null && <div className="compare-scale-pin" />}
                    </div>

                    <div className="compare-scale-labels muted">
                      <span>Veldig trygg</span>
                      <span>Mer annerledes</span>
                    </div>
                  </div>

                  <div className="compare-scale">
                    <div className="compare-scale-head">
                      <div className="compare-scale-title">Lagvalg (EO)</div>
                    </div>

                    <div
                      className="compare-scale-track compare-scale-track-team"
                      style={
                        teamPos == null
                          ? undefined
                          : ({ ['--pos' as any]: `${teamPos * 100}%` } as React.CSSProperties)
                      }
                      aria-label="Lagvalg-skala"
                    >
                      <div className="compare-scale-mid" />
                      {teamPos != null && <div className="compare-scale-pin" />}
                    </div>

                    <div className="compare-scale-labels muted">
                      <span>Mer standard</span>
                      <span>Mer variert</span>
                    </div>
                  </div>

                  <div className="compare-scale">
                    <div className="compare-scale-head">
                      <div className="compare-scale-title">Hits</div>
                    </div>

                    <div
                      className="compare-scale-track compare-scale-track-hits"
                      style={
                        hitsPos == null
                          ? undefined
                          : ({ ['--pos' as any]: `${hitsPos * 100}%` } as React.CSSProperties)
                      }
                      aria-label="Hits-skala"
                    >
                      <div className="compare-scale-mid" />
                      {hitsPos != null && <div className="compare-scale-pin" />}
                    </div>

                    <div className="compare-scale-labels muted">
                      <span>Færre hits</span>
                      <span>Flere hits</span>
                    </div>
                  </div>
                </div>
              </>
            )}
          </section>
        </section>
      )}
    </main>
  );
}
