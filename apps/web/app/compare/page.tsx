'use client';

import type { CSSProperties } from 'react';
import { useMemo, useState } from 'react';
import { useUser } from '../user-context';
import { useEntryInsights } from '../hooks/useEntryInsights';

type PosBuckets = { gkp: number; def: number; mid: number; fwd: number };
type Tilt = 'SAFE' | 'NEUTRAL' | 'DIFFERENT' | 'UNKNOWN';

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

function posCaptainOrTeam(
  userValue: number | null,
  baselineValue: number | null,
  maxValue: number
) {
  if (userValue == null || baselineValue == null) return null;

  const minValue = 0;

  // Hold alt innenfor [0, maxValue]
  const u = clamp(userValue, minValue, maxValue);
  const b = clamp(baselineValue, minValue, maxValue);

  // Midten (0.5) = baseline (bracket-snitt)
  // Venstre halvdel: [baseline .. max]  -> [0.5 .. 0.0]
  // Høyre halvdel:   [0 .. baseline]   -> [1.0 .. 0.5]
  if (u >= b) {
    const denom = maxValue - b;
    if (denom <= 1e-9) return 0.5; // baseline ~ max, kan ikke skalere venstresiden
    const t = (u - b) / denom; // 0..1
    return clamp(0.5 - 0.5 * t, 0, 1);
  } else {
    const denom = b - minValue; // = b
    if (denom <= 1e-9) return 0.5; // baseline ~ 0, kan ikke skalere høyresiden
    const t = (b - u) / denom; // 0..1
    return clamp(0.5 + 0.5 * t, 0, 1);
  }
}

function tiltFromPos(pos: number | null): Tilt {
  if (pos == null) return 'UNKNOWN';
  if (pos <= 0.35) return 'SAFE';
  if (pos >= 0.65) return 'DIFFERENT';
  return 'NEUTRAL';
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
      text: 'Du havner oftere på den "annerledes" siden av snittet: mindre populære kapteiner, mer varierte lagvalg og/eller flere hits enn andre i samme bracket.',
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

function fmt(n: number | null | undefined, digits = 2) {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toFixed(digits);
}

function signFmt(n: number | null | undefined, digits = 2) {
  if (n == null || !Number.isFinite(n)) return '—';
  const s = n >= 0 ? '+' : '';
  return `${s}${n.toFixed(digits)}`;
}

function pct(n: number | null | undefined) {
  if (n == null || !Number.isFinite(n)) return '—';
  const v = n * 100;
  const s = Math.abs(v - Math.round(v)) < 1e-9 ? String(Math.round(v)) : v.toFixed(1);
  return `${s}%`;
}

function diffClass(v: number | null | undefined) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v === 0) return 'compare-mini-diff-neutral';
  return v > 0 ? 'compare-mini-diff-pos' : 'compare-mini-diff-neg';
}

function chipTone(v: number | null | undefined) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v === 0) return 'compare-chip-mid';
  return v > 0 ? 'compare-chip-pos' : 'compare-chip-neg';
}

function row(label: string, user: string, base: string, diff: string, diffValue?: number | null) {
  return (
    <div className="compare-mini-row" key={label}>
      <div className="compare-mini-k">{label}</div>
      <div className="compare-mini-v">{user}</div>
      <div className="compare-mini-v muted">{base}</div>
      <div className={`compare-mini-v compare-mini-diff ${diffClass(diffValue)}`}>{diff}</div>
    </div>
  );
}

function FormationBars({
  user,
  bracket,
  ariaLabel,
}: {
  user: PosBuckets | null | undefined;
  bracket: PosBuckets | null | undefined;
  ariaLabel: string;
}) {
  const items = useMemo(() => {
    const uDef = user?.def ?? 0;
    const uMid = user?.mid ?? 0;
    const uFwd = user?.fwd ?? 0;
    const bDef = bracket?.def ?? 0;
    const bMid = bracket?.mid ?? 0;
    const bFwd = bracket?.fwd ?? 0;
    const rows = [
      { key: 'DEF', u: uDef, b: bDef },
      { key: 'MID', u: uMid, b: bMid },
      { key: 'FWD', u: uFwd, b: bFwd },
    ];
    const maxVal = Math.max(
      1,
      ...rows.flatMap((r) => [r.u, r.b].filter((x) => Number.isFinite(x)))
    );
    return { rows, maxVal };
  }, [user, bracket]);

  return (
    <div className="compare-formation-bars" role="img" aria-label={ariaLabel}>
      <div className="compare-formation-bars-legend">
        <div className="compare-formation-legend-item">
          <span className="compare-formation-legend-swatch compare-formation-legend-swatch-user" />
          <span>Du</span>
        </div>
        <div className="compare-formation-legend-item">
          <span className="compare-formation-legend-swatch compare-formation-legend-swatch-bracket" />
          <span>Bracket</span>
        </div>
      </div>
      <div className="compare-formation-bars-grid" aria-hidden="true">
        {items.rows.map((r) => {
          const uh = clamp((r.u / items.maxVal) * 100, 0, 100);
          const bh = clamp((r.b / items.maxVal) * 100, 0, 100);
          return (
            <div className="compare-formation-group" key={r.key}>
              <div className="compare-formation-group-label">{r.key}</div>
              <div className="compare-formation-pair">
                <div className="compare-formation-bar">
                  <div className="compare-formation-bar-val">{fmt(r.u, 1)}</div>
                  <div className="compare-formation-bar-track">
                    <div
                      className="compare-formation-bar-fill compare-formation-bar-fill-user"
                      style={{ height: `${uh}%` } as CSSProperties}
                    />
                  </div>
                </div>
                <div className="compare-formation-bar">
                  <div className="compare-formation-bar-val">{fmt(r.b, 1)}</div>
                  <div className="compare-formation-bar-track">
                    <div
                      className="compare-formation-bar-fill compare-formation-bar-fill-bracket"
                      style={{ height: `${bh}%` } as CSSProperties}
                    />
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function ComparePage() {
  const { selectedEntry, entryId, isLoading } = useUser();
  const { data, loading, error } = useEntryInsights(entryId ?? null);

  const [bracketHelpOpen, setBracketHelpOpen] = useState(false);

  const captain = data?.insights?.captain ?? null;
  const pointsSummary = data?.insights?.points?.summary ?? null;
  const riskSummary = data?.insights?.risk?.summary ?? null;
  const chips = data?.insights?.chips ?? null;

  const meta = data?.meta ?? null;
  const bracketMeta = meta?.bracket ?? null;

  const bracketExplainer = useMemo(() => {
    return [
      'Hva betyr bracket?',
      '',
      'Du blir sammenlignet med andre lag som ligger i samme rank-intervall som deg akkurat nå (etter siste ferdige runde).',
      '',
      'Bracketene vi bruker (disjunkte intervaller):',
      '• 1–100',
      '• 101–500',
      '• 501–1000',
      '• 1001–2000',
      '• 2001–3000',
      '• 3001–5000',
      '• 5001–7000',
      '• 7001–10000',
      '',
      '“Bracket-snitt” i kortene er season-to-date snitt for lagene som ligger i samme bracket som deg nå.',
      '',
    ].join('\n');
  }, []);

  return (
    <main className="container container-wide">
      <header className="page-header">
        <div className="compare-page-title-row">
          <h1 className="page-title">Sammenlign</h1>

          <div className="compare-help">
            <button
              type="button"
              className="compare-help-btn"
              aria-label="Hva betyr bracket?"
              aria-expanded={bracketHelpOpen}
              onClick={() => setBracketHelpOpen((v) => !v)}
            >
              ?
            </button>

            {bracketHelpOpen && (
              <div className="compare-help-popover" role="dialog" aria-label="Forklaring">
                <div className="compare-help-text">{bracketExplainer}</div>
              </div>
            )}
          </div>
        </div>

        {bracketMeta && (
          <div className="muted" style={{ marginTop: 6 }}>
            Du sammenlignes med bracket: <b>{bracketMeta.name}</b>
            {meta?.overallRankNow != null ? (
              <>
                {' '}
                · Overall rank: <b>{meta.overallRankNow}</b>
              </>
            ) : null}
          </div>
        )}
      </header>

      {!isLoading && !selectedEntry && (
        <section className="card card-pad">
          <div className="compare-empty-title">Ingen valgt entry</div>
          <div className="muted">Gå til forsiden og velg laget ditt først.</div>
        </section>
      )}

      {selectedEntry && (
        <section className="compare-grid">
          {/* Kaptein */}
          <section className="card card-pad compare-col">
            <div className="compare-section-head">
              <h2 className="section-title">Kaptein</h2>
              <div className="muted compare-subtitle">Snittpoeng og suksess vs bracket-snitt</div>
            </div>

            {loading && <div className="muted">Laster…</div>}
            {error && <div className="error">Feil: {error}</div>}

            {!loading && !error && !pointsSummary && (
              <div className="muted">Ingen data ennå. (Sjekk at EntryInsights er oppdatert.)</div>
            )}

            {!loading && !error && pointsSummary && (
              <>
                <div className="compare-kpis">
                  <div className="compare-kpi">
                    <div className="compare-kpi-label">Kapteinpoeng</div>
                    <div className="compare-kpi-value-row">
                      <div className="compare-kpi-value">
                        {fmt(pointsSummary.avgUserCaptainPoints, 2)}
                      </div>
                      <span
                        className={`compare-chip ${diffClass(pointsSummary.captainPointsDiff)}`}
                      >
                        <span className="compare-chip-strong">
                          {signFmt(pointsSummary.captainPointsDiff, 2)}
                        </span>
                      </span>
                    </div>
                    <div className="compare-kpi-sub">Snitt per runde (season-to-date).</div>
                  </div>

                  <div className="compare-kpi">
                    <div className="compare-kpi-label">Bracket-snitt</div>
                    <div className="compare-kpi-value-row">
                      <div className="compare-kpi-value">
                        {fmt(pointsSummary.avgBaselineCaptainPoints, 2)}
                      </div>
                    </div>
                    <div className="compare-kpi-sub">Snitt for lag i samme bracket nå.</div>
                  </div>
                </div>

                {/* Kapteinsuksess */}
                {captain && (
                  <div style={{ marginTop: 14 }}>
                    <div className="compare-subsection-title">Kapteinsuksess</div>

                    <div className="compare-mini-grid">
                      <div className="compare-mini-head">
                        <div>Måling</div>
                        <div className="compare-mini-v">Du</div>
                        <div className="compare-mini-v">Bracket</div>
                        <div className="compare-mini-v">Diff</div>
                      </div>

                      {row(
                        `Kaptein ≥ ${captain.threshold ?? 5}p`,
                        String(captain.returns5Plus ?? 0),
                        captain.baseline?.expectedReturns5Plus == null
                          ? '—'
                          : fmt(captain.baseline.expectedReturns5Plus, 1),
                        captain.diff?.returns5Plus == null
                          ? '—'
                          : signFmt(captain.diff.returns5Plus, 1),
                        captain.diff?.returns5Plus ?? null
                      )}

                      {row(
                        'Suksessrate',
                        captain.usedGameweeks && captain.usedGameweeks > 0
                          ? pct((captain.returns5Plus ?? 0) / captain.usedGameweeks)
                          : '—',
                        captain.baseline?.avgSuccessRate5Plus == null
                          ? '—'
                          : pct(captain.baseline.avgSuccessRate5Plus),
                        captain.baseline?.avgSuccessRate5Plus == null || !captain.usedGameweeks
                          ? '—'
                          : signFmt(
                              ((captain.returns5Plus ?? 0) / captain.usedGameweeks -
                                (captain.baseline.avgSuccessRate5Plus ?? 0)) *
                                100,
                              1
                            ) + '%',
                        null
                      )}
                    </div>
                  </div>
                )}

                {/* Topp 3 kapteiner */}
                {captain?.topCaptains && captain.topCaptains.length > 0 && (
                  <div className="compare-subsection-spaced" style={{ marginTop: 14 }}>
                    <div className="compare-subsection-title">Dine topp 3 kapteiner</div>
                    <div className="compare-mini-grid compare-mini-grid-tight">
                      {captain.topCaptains.map((x, idx) => (
                        <div className="compare-topitem" key={`${x.playerId}-${x.gw}-${idx}`}>
                          <div className="compare-topitem-rank muted">#{x.rank}</div>
                          <div className="compare-topitem-main">
                            <div className="compare-topitem-name">{x.playerName}</div>
                            <div className="compare-topitem-sub muted">GW {x.gw}</div>
                          </div>
                          <div className="compare-topitem-points">{fmt(x.points, 0)}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </section>

          {/* Lagdel (poeng) + Formasjon */}
          <section className="card card-pad compare-col">
            <div className="compare-section-head">
              <h2 className="section-title">Lagdel</h2>
              <div className="muted compare-subtitle">Snittpoeng per lagdel + formasjon</div>
            </div>

            {loading && <div className="muted">Laster…</div>}
            {error && <div className="error">Feil: {error}</div>}

            {!loading && !error && !pointsSummary && (
              <div className="muted">Ingen data ennå. (Sjekk at EntryInsights er oppdatert.)</div>
            )}

            {!loading && !error && pointsSummary && (
              <>
                <div className="compare-subsection-title">Snittpoeng per lagdel</div>

                <div className="compare-mini-grid">
                  <div className="compare-mini-head">
                    <div>Lagdel</div>
                    <div className="compare-mini-v">Du</div>
                    <div className="compare-mini-v">Bracket</div>
                    <div className="compare-mini-v">Diff</div>
                  </div>

                  {(() => {
                    const u = pointsSummary.avgUserByPosition;
                    const b = pointsSummary.avgBaselineByPosition;
                    const d = pointsSummary.byPositionDiff;

                    const bucket = (x: PosBuckets | null | undefined, k: keyof PosBuckets) =>
                      x ? fmt(x[k], 2) : '—';
                    const bucketDiff = (x: PosBuckets | null | undefined, k: keyof PosBuckets) =>
                      x ? signFmt(x[k], 2) : '—';
                    const bucketDiffVal = (
                      x: PosBuckets | null | undefined,
                      k: keyof PosBuckets
                    ) => (x && Number.isFinite(x[k]) ? x[k] : null);

                    return (
                      <>
                        {row(
                          'GKP',
                          bucket(u, 'gkp'),
                          bucket(b, 'gkp'),
                          bucketDiff(d, 'gkp'),
                          bucketDiffVal(d, 'gkp')
                        )}
                        {row(
                          'DEF',
                          bucket(u, 'def'),
                          bucket(b, 'def'),
                          bucketDiff(d, 'def'),
                          bucketDiffVal(d, 'def')
                        )}
                        {row(
                          'MID',
                          bucket(u, 'mid'),
                          bucket(b, 'mid'),
                          bucketDiff(d, 'mid'),
                          bucketDiffVal(d, 'mid')
                        )}
                        {row(
                          'FWD',
                          bucket(u, 'fwd'),
                          bucket(b, 'fwd'),
                          bucketDiff(d, 'fwd'),
                          bucketDiffVal(d, 'fwd')
                        )}
                      </>
                    );
                  })()}
                </div>

                {/* Formasjon */}
                <div className="compare-subsection-spaced" style={{ marginTop: 14 }}>
                  <div className="compare-subsection-title">Antall spillere per lagdel (snitt)</div>
                  <FormationBars
                    user={pointsSummary.avgUserXI}
                    bracket={pointsSummary.avgBaselineXI}
                    ariaLabel="Formasjon sammenligning (Du vs Bracket)"
                  />
                  <div className="muted compare-formation-note" style={{ marginTop: 8 }}>
                    Dette er snitt antall spillere i startelleveren per runde (season-to-date).
                  </div>
                </div>
              </>
            )}
          </section>

          {/* Chips */}
          <section className="card card-pad compare-col">
            <div className="compare-section-head">
              <h2 className="section-title">Chips</h2>
              <div className="muted compare-subtitle">Chip-bruk i din bracket (season-to-date)</div>
            </div>

            {loading && <div className="muted">Laster…</div>}
            {error && <div className="error">Feil: {error}</div>}

            {!loading && !error && !chips?.baseline && (
              <div className="muted">
                Ingen baseline chip-data funnet. Sjekk at computeBracketStatsSnapshot og
                computeEntryInsights er kjørt.
              </div>
            )}

            {!loading && !error && chips?.baseline && (
              <>
                <div className="compare-subsection-title">Chip-bruk i din bracket</div>
                <div className="compare-chip-usage">
                  <div className="compare-chip-usage-head">
                    <div>Chip</div>
                    <div className="compare-chip-num">Brukt</div>
                    <div className="compare-chip-num">Rate</div>
                  </div>
                  {[
                    { key: 'rich', label: 'Rik onkel' },
                    { key: '2capt', label: 'To kapteiner' },
                    { key: 'frush', label: 'Spissrush' },
                    { key: 'wildcard1', label: 'Wildcard 1' },
                    { key: 'wildcard2', label: 'Wildcard 2' },
                  ].map((d) => {
                    const total = chips.baseline?.totalUsed ?? {};
                    const sample = chips.baseline?.sampleSize ?? null;
                    const used =
                      typeof (total as Record<string, number>)[d.key] === 'number'
                        ? (total as Record<string, number>)[d.key]
                        : null;
                    const rate =
                      used != null && sample != null && sample > 0 ? used / sample : null;
                    const barW = rate != null ? `${clamp(rate, 0, 1) * 100}%` : '0%';
                    return (
                      <div className="compare-chip-usage-row" key={d.key}>
                        <div className="compare-chip-label">{d.label}</div>
                        <div className="compare-chip-num">{used == null ? '—' : String(used)}</div>
                        <div className="compare-chip-num">{rate == null ? '—' : pct(rate)}</div>
                        <div className="compare-chip-bar" aria-hidden="true">
                          <div
                            className="compare-chip-bar-fill"
                            style={{ ['--w' as string]: barW } as CSSProperties}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div className="compare-subsection-title compare-subsection-spaced">
                  Poeng per chip
                </div>
                <div className="compare-chip-points">
                  <div className="compare-chip-points-head">
                    <div>Chip</div>
                    <div className="compare-chip-num">Du</div>
                    <div className="compare-chip-num">Bracket</div>
                    <div className="compare-chip-num">Diff</div>
                  </div>
                  {[
                    { key: '2capt', label: '2x Kaptein' },
                    { key: 'frush', label: 'Free Rush' },
                  ].map((d) => {
                    const arr = chips.pointsByChip?.[d.key] ?? chips.used?.[d.key];
                    const userPts =
                      Array.isArray(arr) && arr.length > 0 && typeof arr[0]?.points === 'number'
                        ? arr[0].points
                        : null;
                    const bracketPts =
                      d.key === '2capt'
                        ? (chips.baseline?.points?.avg2captPoints ?? null)
                        : (chips.baseline?.points?.avgFrushPoints ?? null);
                    const diff =
                      userPts != null && bracketPts != null ? userPts - bracketPts : null;
                    return (
                      <div className="compare-chip-points-row" key={d.key}>
                        <div className="compare-chip-label">{d.label}</div>
                        <div className="compare-chip-num">
                          {userPts == null ? '—' : fmt(userPts, 0)}
                        </div>
                        <div className="compare-chip-num muted">
                          {bracketPts == null ? '—' : fmt(bracketPts, 2)}
                        </div>
                        <div className="compare-chip-num">
                          <span className={`compare-chip ${chipTone(diff)}`}>
                            <span className="compare-chip-strong">
                              {diff == null ? '—' : signFmt(diff, 2)}
                            </span>
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="muted" style={{ marginTop: 10 }}>
                  Baseline sample size:{' '}
                  {chips.baseline.sampleSize == null ? '—' : String(chips.baseline.sampleSize)}
                </div>
              </>
            )}
          </section>

          {/* Spillestil */}
          <section className="card card-pad compare-col">
            <div className="compare-section-head">
              <h2 className="section-title">Spillestil</h2>
              <div className="muted compare-subtitle">
                Sammenlignet med andre i samme bracket per runde
              </div>
            </div>

            {loading && <div className="muted">Laster…</div>}
            {error && <div className="error">Feil: {error}</div>}

            {!loading && !error && !riskSummary && (
              <div className="muted">Ingen data ennå. (Sjekk at EntryInsights er oppdatert.)</div>
            )}

            {!loading && !error && riskSummary && (
              <>
                {(() => {
                  const captainPos = posCaptainOrTeam(
                    riskSummary.avgUserCaptainEO ?? null,
                    riskSummary.avgBaselineCaptainEO ?? null,
                    2.0
                  );
                  const teamPos = posCaptainOrTeam(
                    riskSummary.avgTeamEO ?? null,
                    riskSummary.avgBaselineTeamEO ?? null,
                    10.0
                  );
                  const userHits = riskSummary.userHitCount ?? null;
                  const baseHits = riskSummary.baselineHitCount;
                  let hitsPos: number | null = null;
                  if (userHits != null && baseHits != null) {
                    if (userHits <= baseHits) {
                      // Venstre side: 0 hits (helt venstre) til baseHits (midten)
                      const t = baseHits > 0 ? userHits / baseHits : 0;
                      hitsPos = 0.5 * t;
                    } else {
                      // Høyre side: baseHits (midten) til max(2, 2*baseHits) (helt høyre)
                      const maxHits = Math.max(2, 2 * baseHits);
                      const t = (userHits - baseHits) / (maxHits - baseHits);
                      hitsPos = 0.5 + 0.5 * Math.min(t, 1);
                    }
                  }
                  const tilts = {
                    captain: tiltFromPos(captainPos),
                    team: tiltFromPos(teamPos),
                    hits: tiltFromPos(hitsPos),
                  };
                  const comment = overallComment(tilts);
                  return (
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
                                : ({ ['--pos' as string]: `${captainPos * 100}%` } as CSSProperties)
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
                                : ({ ['--pos' as string]: `${teamPos * 100}%` } as CSSProperties)
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
                                : ({ ['--pos' as string]: `${hitsPos * 100}%` } as CSSProperties)
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

                      <div className="compare-kpis" style={{ marginTop: 14 }}>
                        <div className="compare-kpi">
                          <div className="compare-kpi-label">Hits</div>
                          <div className="compare-kpi-value-row">
                            <div className="compare-kpi-value">
                              {riskSummary.userHitCount == null
                                ? '—'
                                : Math.round(riskSummary.userHitCount)}
                            </div>
                          </div>
                          <div className="compare-kpi-sub">Antall hits (season-to-date).</div>
                        </div>
                        <div className="compare-kpi">
                          <div className="compare-kpi-label">Bracket-snitt</div>
                          <div className="compare-kpi-value-row">
                            <div className="compare-kpi-value">
                              {riskSummary.baselineHitCount == null
                                ? '—'
                                : fmt(riskSummary.baselineHitCount, 1)}
                            </div>
                          </div>
                          <div className="compare-kpi-sub">Snitt antall hits i din bracket.</div>
                        </div>
                      </div>
                    </>
                  );
                })()}
              </>
            )}
          </section>
        </section>
      )}
    </main>
  );
}
