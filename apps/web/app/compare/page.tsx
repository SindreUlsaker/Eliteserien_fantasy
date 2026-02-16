'use client';

import type { CSSProperties } from 'react';
import { useMemo, useState } from 'react';
import { useUser } from '../user-context';
import { useEntryInsights } from '../hooks/useEntryInsights';

type Tilt = 'SAFE' | 'NEUTRAL' | 'DIFFERENT' | 'UNKNOWN';

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

function posCaptainOrTeam(diff: number | null, span: number) {
  if (diff == null) return null;
  const normalized = diff / span;
  const p = 0.5 - normalized * 0.5;
  return clamp(p, 0, 1);
}

function posHits(diff: number | null, span: number) {
  if (diff == null) return null;
  const normalized = diff / span;
  const p = 0.5 + normalized * 0.5;
  return clamp(p, 0, 1);
}

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

function fmt(n: number | null | undefined, digits = 2) {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toFixed(digits);
}

function signFmt(n: number | null | undefined, digits = 2) {
  if (n == null || !Number.isFinite(n)) return '—';
  const s = n >= 0 ? '+' : '';
  return `${s}${n.toFixed(digits)}`;
}

type PosBuckets = { gkp: number; def: number; mid: number; fwd: number };

function diffClass(v: number | null | undefined) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v === 0) return 'compare-mini-diff-neutral';
  return v > 0 ? 'compare-mini-diff-pos' : 'compare-mini-diff-neg';
}

function chipTone(v: number | null | undefined) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v === 0) return 'compare-chip-mid';
  return v > 0 ? 'compare-chip-pos' : 'compare-chip-neg';
}

function pct(n: number | null) {
  if (n == null || !Number.isFinite(n)) return '—';
  const v = n * 100;
  // 0 desimaler hvis det er "pent", ellers 1 desimal
  const s = Math.abs(v - Math.round(v)) < 1e-9 ? String(Math.round(v)) : v.toFixed(1);
  return `${s}%`;
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

/**
 * Formasjon som stolpediagram:
 * - grupper: DEF, MID, FWD
 * - to stolper tett: Du + Bracket
 * - mellomrom mellom gruppene
 * - vi dropper GKP (1.0 uansett)
 */
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

    // skaler mot max i datasettet så stolpene blir “relative” og lesbare
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
                      style={{ height: `${uh}%` }}
                    />
                  </div>
                </div>

                <div className="compare-formation-bar">
                  <div className="compare-formation-bar-val">{fmt(r.b, 1)}</div>
                  <div className="compare-formation-bar-track">
                    <div
                      className="compare-formation-bar-fill compare-formation-bar-fill-bracket"
                      style={{ height: `${bh}%` }}
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

  const [styleHelpOpen, setStyleHelpOpen] = useState(false);
  const [bracketHelpOpen, setBracketHelpOpen] = useState(false);

  const riskSummary = data?.insights?.risk?.summary ?? null;
  const pointsSummary = data?.insights?.points?.summary ?? null;
  const captainSummary = data?.insights?.captain ?? null;

  const chipInsights = data?.insights?.chips ?? null;
  const bracketStats = data?.bracketGameweekStats?.data ?? null;

  const bracketSampleSize: number | null =
    typeof bracketStats?.points?.coverage?.sampleSize === 'number'
      ? bracketStats.points.coverage.sampleSize
      : null;

  const captainPos = useMemo(
    () => posCaptainOrTeam(riskSummary?.captainShareDiff ?? null, 0.12),
    [riskSummary]
  );
  const teamPos = useMemo(
    () => posCaptainOrTeam(riskSummary?.teamEODiff ?? null, 1.2),
    [riskSummary]
  );
  const hitsPos = useMemo(() => posHits(riskSummary?.transferCostDiff ?? null, 1.0), [riskSummary]);

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
    if (!riskSummary) return null;
    const used = riskSummary.usedGameweeks ?? 0;

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
  }, [riskSummary]);

  const bracketExplainer = useMemo(() => {
    return [
      'Hva betyr bracket?',
      '',
      'Når du blir sammenlignet med andre lag, sammenlignes du kun med lag som ligger i samme rank-område som deg.',
      '',
      'Bracketene jeg bruker:',
      '• topp 100',
      '• topp 500',
      '• topp 2000',
      '• topp 5000',
      '• topp 10000',
      '',
      'Eksempel:',
      'Hvis du var overall 7000 etter GW1, blir du i den runden sammenlignet mot “topp 10000”.',
      'Hvis du i GW2 gikk opp til 4000, blir du i den runden sammenlignet mot “topp 5000”.',
      '',
      'Du blir altså sammenlignet med lag som var i samme bracket som deg i den aktuelle runden, ikke nødvendigvis de samme lagene i hver runde.',
      '',
      'Unntaket her er chips delen hvor du blir sammenlignet med de som for øyeblikket er i samme bracket som deg. Altså basert på nåværende rank, ikke rank i den aktuelle runden.',
      '',
      'Om du i noen runder er utenfor topp 10000 sammenlignes du fortsatt med topp 10000 (tar veldig lang tid å hente samtlige 50000+ lag)',
      '',
    ].join('\n');
  }, []);

  const captainPointsCard = useMemo(() => {
    if (!pointsSummary) return null;

    const diff = pointsSummary.captainPointsDiff ?? null;
    const baseAvg = pointsSummary.avgBaselineCaptainPoints ?? null;

    return (
      <>
        <div className="compare-kpis">
          {/* Kapteinpoeng */}
          <div className="compare-kpi">
            <div className="compare-kpi-label">Kapteinpoeng</div>
            <div className="compare-kpi-value-row">
              <div className="compare-kpi-value">{fmt(pointsSummary.avgUserCaptainPoints, 2)}</div>
              <span className={`compare-chip ${chipTone(diff)}`}>
                <span className="compare-chip-strong">{signFmt(diff, 2)}</span>
              </span>
            </div>
            <div className="compare-kpi-sub">Snitt per runde.</div>
          </div>

          <div className="compare-kpi">
            <div className="compare-kpi-label">Bracket-snitt</div>
            <div className="compare-kpi-value-row">
              <div className="compare-kpi-value">{baseAvg == null ? '—' : baseAvg.toFixed(2)}</div>
            </div>
            <div className="compare-kpi-sub">Snitt i din bracket per runde.</div>
          </div>
        </div>
      </>
    );
  }, [pointsSummary]);

  const captainSuccessCard = useMemo(() => {
    if (!captainSummary) return null;

    const threshold = captainSummary.threshold ?? 5;
    const user = captainSummary.returns5Plus ?? null;

    const baseAvg = captainSummary.baseline?.expectedReturns5Plus ?? null;
    const diff = captainSummary.diff?.returns5Plus ?? null;

    const used = captainSummary.baseline?.usedGameweeks ?? captainSummary.usedGameweeks ?? null;
    const userRate = used && typeof user === 'number' ? user / used : null;
    const barW = userRate != null ? `${clamp(userRate, 0, 1) * 100}%` : '0%';

    return (
      <>
        <div className="compare-kpis">
          <div className="compare-kpi">
            <div className="compare-kpi-label">Kapteinsuksess</div>
            <div className="compare-kpi-value-row">
              <div className="compare-kpi-value">{user == null ? '—' : String(user)}</div>
              <span className={`compare-chip ${chipTone(diff)}`}>
                <span className="compare-chip-strong">{diff == null ? '—' : signFmt(diff, 2)}</span>
              </span>
            </div>
            <div className="compare-kpi-sub">
              Antall runder der kaptein ga <b>≥ {threshold}p</b>.
            </div>

            {userRate != null && (
              <div className="compare-progress" aria-label="Kapteinsuksess-rate">
                <div
                  className="compare-progress-fill"
                  style={{ ['--w' as any]: barW } as CSSProperties}
                />
              </div>
            )}
          </div>

          <div className="compare-kpi">
            <div className="compare-kpi-label">Bracket-snitt</div>
            <div className="compare-kpi-value-row">
              <div className="compare-kpi-value">{baseAvg == null ? '—' : baseAvg.toFixed(2)}</div>
            </div>
            <div className="compare-kpi-sub">Snitt i din bracket per runde.</div>
          </div>
        </div>
      </>
    );
  }, [captainSummary]);

  const topCaptainsCard = useMemo(() => {
    if (!captainSummary) return null;

    const top = captainSummary.topCaptains ?? [];
    if (top.length === 0) return null;

    return (
      <>
        <div className="compare-subsection-title compare-subsection-spaced">
          Dine topp 3 kapteiner
        </div>

        <div className="compare-mini-grid compare-mini-grid-tight">
          {top.map((x: any, idx: number) => (
            <div className="compare-topitem" key={`${x.playerId}-${x.gameweekId}`}>
              <div className="compare-topitem-rank muted">#{idx + 1}</div>

              <div className="compare-topitem-main">
                <div className="compare-topitem-name">{x.playerName ?? `Player ${x.playerId}`}</div>
                <div className="compare-topitem-sub muted">GW {x.gameweekId}</div>
              </div>

              <div className="compare-topitem-points">{x.points}</div>
            </div>
          ))}
        </div>
      </>
    );
  }, [captainSummary]);

  const lagdelCard = useMemo(() => {
    if (!pointsSummary) return null;

    const u = pointsSummary.avgUserByPosition;
    const b = pointsSummary.avgBaselineByPosition;
    const d = pointsSummary.byPositionDiff;

    const uxi = pointsSummary.avgUserXI;
    const bxi = pointsSummary.avgBaselineXI;

    const bucket = (x: PosBuckets | null | undefined, k: keyof PosBuckets) =>
      x ? fmt(x[k], 2) : '—';
    const bucketDiff = (x: PosBuckets | null | undefined, k: keyof PosBuckets) =>
      x ? signFmt(x[k], 2) : '—';
    const bucketDiffVal = (x: PosBuckets | null | undefined, k: keyof PosBuckets) =>
      x && Number.isFinite(x[k]) ? x[k] : null;

    return (
      <>
        <div className="compare-subsection-title">Snittpoeng per lagdel</div>

        <div className="compare-mini-grid">
          <div className="compare-mini-head">
            <div>Lagdel</div>
            <div className="compare-mini-v">Du</div>
            <div className="compare-mini-v">Bracket</div>
            <div className="compare-mini-v">Diff</div>
          </div>

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
        </div>

        <div className="compare-subsection-title compare-subsection-spaced">
          Antall spillere per lagdel (snitt)
        </div>

        <FormationBars
          user={uxi}
          bracket={bxi}
          ariaLabel="Formasjon sammenligning (Du vs Bracket)"
        />
      </>
    );
  }, [pointsSummary]);

  const CHIP_DEFS = useMemo(
    () =>
      [
        { key: 'rich', label: 'Rik onkel' },
        { key: '2capt', label: 'To kapteiner' },
        { key: 'frush', label: 'Spissrush' },
        { key: 'wildcard1', label: 'Wildcard 1' },
        { key: 'wildcard2', label: 'Wildcard 2' },
      ] as const,
    []
  );

  const CHIP_POINTS_DEFS = useMemo(
    () =>
      [
        { key: '2capt', label: '2x Kaptein' },
        { key: 'frush', label: 'Free Rush' },
      ] as const,
    []
  );

  function userUsedChip(key: string) {
    const arr = (chipInsights as any)?.used?.[key];
    return Array.isArray(arr) && arr.length > 0;
  }

  function userChipPointsLabel(key: string) {
    if (!userUsedChip(key)) return '-';

    const arr = (chipInsights as any)?.pointsByChip?.[key];
    if (!Array.isArray(arr) || arr.length === 0) return '—';

    const p = arr[0]?.points;
    if (typeof p !== 'number' || !Number.isFinite(p)) return '—';
    return String(p);
  }

  function userChipPointsNumberOrNull(key: string) {
    const s = userChipPointsLabel(key);
    if (s === '-' || s === '—') return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }

  // Bracket stats: totalUsed har wildcard samlet som "wildcard" (ikke wildcard1/2)
  function bracketTotalUsed(key: string): number | null {
    const total = bracketStats?.chips?.totalUsed;
    if (!total) return null;

    // Ny struktur (wildcard1/wildcard2)
    const direct = (total as any)[key];
    if (typeof direct === 'number') return direct;

    // Backward compatibility: gammel struktur (wildcard samlet)
    if (key === 'wildcard1' || key === 'wildcard2') {
      const legacy = (total as any).wildcard;
      return typeof legacy === 'number' ? legacy : null;
    }

    return null;
  }

  function bracketUsedRate(key: string): number | null {
    const used = bracketTotalUsed(key);
    if (used == null || bracketSampleSize == null || bracketSampleSize <= 0) return null;
    return used / bracketSampleSize;
  }

  function bracketAvgPoints(key: string): number | null {
    const pts = bracketStats?.chips?.points;
    if (!pts) return null;

    if (key === '2capt') return typeof pts.avg2captPoints === 'number' ? pts.avg2captPoints : null;
    if (key === 'frush') return typeof pts.avgFrushPoints === 'number' ? pts.avgFrushPoints : null;

    // rich + wildcard har ikke avg-points i stats-eksemplet ditt
    return null;
  }

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
          <section className="card card-pad compare-col">
            <div className="compare-section-head">
              <h2 className="section-title">Kaptein</h2>
              <div className="muted compare-subtitle">
                Poeng og suksess sammenlignet med bracket-snitt
              </div>
            </div>

            {loading && <div className="muted">Laster…</div>}
            {error && <div className="error">Feil: {error}</div>}

            {!loading && !error && !pointsSummary && !captainSummary && (
              <div className="muted">Ingen data ennå. (Sjekk at EntryInsights er oppdatert.)</div>
            )}

            {!loading && !error && pointsSummary && captainPointsCard}
            {!loading && !error && captainSummary && captainSuccessCard}
            {!loading && !error && captainSummary && topCaptainsCard}
          </section>

          <section className="card card-pad compare-col">
            <div className="compare-section-head">
              <h2 className="section-title">Lagdel</h2>
              <div className="muted compare-subtitle">
                Hvilke lagdeler som drar deg opp/ned + formasjon
              </div>
            </div>

            {loading && <div className="muted">Laster…</div>}
            {error && <div className="error">Feil: {error}</div>}

            {!loading && !error && !pointsSummary && (
              <div className="muted">Ingen data ennå. (Sjekk at EntryInsights er oppdatert.)</div>
            )}

            {!loading && !error && pointsSummary && lagdelCard}
          </section>

          <section className="card card-pad compare-col">
            <div className="compare-section-head">
              <h2 className="section-title">Chips</h2>
              <div className="muted compare-subtitle">
                Poeng fra chips sammenlignet med de som for øyeblikket er i samme bracket som deg
              </div>
            </div>

            {loading && <div className="muted">Laster…</div>}
            {error && <div className="error">Feil: {error}</div>}

            {!loading && !error && (
              <>
                {!bracketStats && (
                  <div className="muted">
                    Ingen bracket-stats funnet for denne runden ennå. (Sjekk at BracketGameweekStats
                    er bygd.)
                  </div>
                )}

                {bracketStats && (
                  <>
                    <div className="compare-subsection-title">Chip-bruk i din bracket</div>

                    <div className="compare-chip-usage">
                      <div className="compare-chip-usage-head">
                        <div>Chip</div>
                        <div className="compare-chip-num">Brukt</div>
                        <div className="compare-chip-num">Rate</div>
                      </div>

                      {CHIP_DEFS.map((c) => {
                        const used = bracketTotalUsed(c.key);
                        const rate = bracketUsedRate(c.key);
                        const barW = rate != null ? `${clamp(rate, 0, 1) * 100}%` : '0%';

                        return (
                          <div className="compare-chip-usage-row" key={c.key}>
                            <div className="compare-chip-label">{c.label}</div>

                            <div className="compare-chip-num">
                              {used == null ? '—' : String(used)}
                            </div>
                            <div className="compare-chip-num">{rate == null ? '—' : pct(rate)}</div>

                            <div className="compare-chip-bar" aria-hidden="true">
                              <div
                                className="compare-chip-bar-fill"
                                style={{ ['--w' as any]: barW } as CSSProperties}
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

                      {CHIP_POINTS_DEFS.map((c) => {
                        const userLabel = userChipPointsLabel(c.key);
                        const u = userChipPointsNumberOrNull(c.key);
                        const b = bracketAvgPoints(c.key);
                        const diff = u != null && b != null ? u - b : null;

                        return (
                          <div className="compare-chip-points-row" key={c.key}>
                            <div className="compare-chip-label">{c.label}</div>

                            <div className="compare-chip-num">{userLabel}</div>
                            <div className="compare-chip-num muted">
                              {b == null ? '—' : b.toFixed(2)}
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
                  </>
                )}
              </>
            )}
          </section>

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

            {!loading && !error && !riskSummary && (
              <div className="muted">
                Ingen data ennå. (Sjekk at BracketGameweekStats og EntryInsights er oppdatert.)
              </div>
            )}

            {riskSummary && (
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
                          : ({ ['--pos' as any]: `${captainPos * 100}%` } as CSSProperties)
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
                          : ({ ['--pos' as any]: `${teamPos * 100}%` } as CSSProperties)
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
                          : ({ ['--pos' as any]: `${hitsPos * 100}%` } as CSSProperties)
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
