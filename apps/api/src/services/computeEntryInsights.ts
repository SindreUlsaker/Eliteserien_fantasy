// apps/api/src/services/computeEntryInsights.ts
import { PrismaClient } from '@prisma/client';

type NormalizedChipKey = 'wildcard1' | 'wildcard2' | '2capt' | 'frush' | 'rich' | string;

function normalizeChipName(chipName: string, gameweekId: number): NormalizedChipKey {
  if (chipName === 'wildcard') return gameweekId >= 16 ? 'wildcard2' : 'wildcard1';
  return chipName as NormalizedChipKey;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function jitter(ms: number) {
  const delta = ms * 0.25;
  return ms + (Math.random() * 2 - 1) * delta;
}

async function fetchJsonWithRetry<T>(url: string): Promise<T> {
  const maxAttempts = 5;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'eliteserien-api/computeEntryInsights',
        Accept: 'application/json',
      },
    });

    if (res.ok) return (await res.json()) as T;

    const retryable = res.status === 429 || (res.status >= 500 && res.status <= 599);
    const body = await res.text().catch(() => '');

    if (!retryable || attempt === maxAttempts) {
      throw new Error(
        `HTTP ${res.status} ${res.statusText} for ${url}. Body: ${body.slice(0, 250)}`
      );
    }

    const baseDelay = 700 * Math.pow(2, attempt - 1);
    const delayMs = Math.round(jitter(Math.min(baseDelay, 15_000)));
    await sleep(delayMs);
  }

  throw new Error(`Failed after retries: ${url}`);
}

function elementTypeKey(elementType: number): 'gkp' | 'def' | 'mid' | 'fwd' | 'unk' {
  if (elementType === 1) return 'gkp';
  if (elementType === 2) return 'def';
  if (elementType === 3) return 'mid';
  if (elementType === 4) return 'fwd';
  return 'unk';
}

function chipNameForPoints(normalized: string): '2capt' | 'frush' | null {
  const k = normalized.toLowerCase();
  if (
    k === '2capt' ||
    k === '3xc' ||
    k === 'triple_captain' ||
    k === 'triple captain' ||
    k.includes('kaptein')
  )
    return '2capt';
  if (k === 'frush' || k === 'freehit' || k === 'spissrush') return 'frush';
  return null;
}

type CaptainPerf = { gw: number; playerId: number; points: number };

function findBracketForRank(
  rank: number | null | undefined,
  brackets: Array<{ id: number; name: string; rankFrom: number; rankTo: number; active: boolean }>
) {
  if (rank == null) return null;
  const exactMatch = brackets.find((x) => x.active && rank >= x.rankFrom && rank <= x.rankTo);
  if (exactMatch) return exactMatch;
  // For users ranked beyond the highest bracket, use the highest available bracket
  const activeBrackets = brackets.filter((x) => x.active);
  return activeBrackets.length > 0 ? activeBrackets[activeBrackets.length - 1] : null;
}

type PicksResponse = {
  picks: Array<{
    element: number;
    position: number;
    multiplier: number;
    is_captain: boolean;
    is_vice_captain?: boolean;
    element_type: number;
  }>;
};

type EntryHistoryResponse = {
  current: Array<{
    event: number;
    overall_rank?: number | null;
    event_transfers_cost?: number | null;
  }>;
  chips?: Array<{
    name?: string;
    event?: number;
    time?: string;
  }>;
};

async function ensureEntrySeasonTotalsUpToDate(
  prisma: PrismaClient,
  entryId: number,
  computedThroughGw: number
) {
  const BASE_URL = process.env.ESF_BASE_URL ?? 'https://en.fantasy.eliteserien.no';

  const finishedGws = await prisma.gameweek.findMany({
    where: { finished: true, id: { lte: computedThroughGw } },
    orderBy: { id: 'asc' },
    select: { id: true },
  });
  const finishedGwIds = finishedGws.map((g) => g.id);
  if (finishedGwIds.length === 0) return;

  const existing = await prisma.entrySeasonTotals.findUnique({
    where: { entryId },
    select: { lastUpdatedGw: true },
  });

  const lastUpdatedGw = existing?.lastUpdatedGw ?? 0;
  if (lastUpdatedGw >= computedThroughGw) return;

  // Minimal incremental update (samme som før): henter picks for manglende gws og oppdaterer totals.
  // (Du kommer uansett til å kjøre batch-scriptet, så dette brukes mest for “single entry”).
  const missingGwIds = finishedGwIds.filter((gw) => gw > lastUpdatedGw);
  if (missingGwIds.length === 0) return;

  // Points lookup for missing GWs
  const pgs = await prisma.playerGameweekStats.findMany({
    where: { gameweekId: { in: missingGwIds } },
    select: { gameweekId: true, playerId: true, totalPoints: true },
  });
  const pts = new Map<string, number>();
  for (const s of pgs) pts.set(`${s.gameweekId}:${s.playerId}`, s.totalPoints);

  const historyUrl = `${BASE_URL}/api/entry/${entryId}/history/`;
  const history = await fetchJsonWithRetry<EntryHistoryResponse>(historyUrl);

  const costByGw = new Map<number, number>();
  for (const r of history.current ?? []) {
    if (typeof r.event !== 'number') continue;
    const c = typeof r.event_transfers_cost === 'number' ? r.event_transfers_cost : 0;
    costByGw.set(r.event, c);
  }

  const prev = await prisma.entrySeasonTotals.findUnique({
    where: { entryId },
    select: {
      gwCount: true,
      captainPointsTotal: true,
      captainSuccess5PlusCount: true,
      captainTop3Json: true,
      xiGkpPointsTotal: true,
      xiDefPointsTotal: true,
      xiMidPointsTotal: true,
      xiFwdPointsTotal: true,
      xiGkpCountTotal: true,
      xiDefCountTotal: true,
      xiMidCountTotal: true,
      xiFwdCountTotal: true,
      transferCostTotal: true,
      hitCount: true,
      teamEOTotal: true,
      teamEOCount: true,
      captainEOTotal: true,
      captainEOCount: true,
      captainShareTotal: true,
      captainShareCount: true,
    },
  });

  const eoRows = await prisma.effectiveOwnership.findMany({
    where: { gameweekId: { in: missingGwIds } },
    select: { gameweekId: true, playerId: true, eo: true, sampleSize: true, captainCount: true },
  });
  const eoByGw = new Map<
    number,
    Map<number, { eo: number; sampleSize: number; captainCount: number | null }>
  >();
  for (const r of eoRows) {
    let m = eoByGw.get(r.gameweekId);
    if (!m) {
      m = new Map();
      eoByGw.set(r.gameweekId, m);
    }
    m.set(r.playerId, { eo: r.eo, sampleSize: r.sampleSize, captainCount: r.captainCount ?? null });
  }

  const chipsRaw = Array.isArray(history.chips) ? history.chips : [];
  const chipsByGw = new Map<number, string[]>();
  const chipRowsToCreate: Array<{
    entryId: number;
    gameweekId: number;
    chipName: string;
    usedAt?: Date;
  }> = [];
  for (const ch of chipsRaw) {
    const name = typeof ch?.name === 'string' ? ch.name : null;
    const event = typeof ch?.event === 'number' && Number.isFinite(ch.event) ? ch.event : null;
    const time = typeof ch?.time === 'string' ? ch.time : null;
    if (!name || event == null || event > computedThroughGw) continue;
    const chipName = normalizeChipName(name, event);
    if (!chipsByGw.has(event)) chipsByGw.set(event, []);
    chipsByGw.get(event)!.push(chipName);
    if (missingGwIds.includes(event)) {
      chipRowsToCreate.push({
        entryId,
        gameweekId: event,
        chipName,
        usedAt: time ? new Date(time) : undefined,
      });
    }
  }
  if (chipRowsToCreate.length > 0) {
    await prisma.chipUsage.createMany({
      data: chipRowsToCreate.map((r) => ({
        entryId: r.entryId,
        gameweekId: r.gameweekId,
        chipName: r.chipName,
        points: null,
        usedAt: r.usedAt,
      })),
      skipDuplicates: true,
    });
  }

  let gwCount = prev?.gwCount ?? 0;
  let captainPointsTotal = prev?.captainPointsTotal ?? 0;
  let captainSuccess5PlusCount = prev?.captainSuccess5PlusCount ?? 0;

  let xiGkp = prev?.xiGkpPointsTotal ?? 0;
  let xiDef = prev?.xiDefPointsTotal ?? 0;
  let xiMid = prev?.xiMidPointsTotal ?? 0;
  let xiFwd = prev?.xiFwdPointsTotal ?? 0;

  let xiGkpCountTotal = prev?.xiGkpCountTotal ?? 0;
  let xiDefCountTotal = prev?.xiDefCountTotal ?? 0;
  let xiMidCountTotal = prev?.xiMidCountTotal ?? 0;
  let xiFwdCountTotal = prev?.xiFwdCountTotal ?? 0;

  let transferCostTotal = prev?.transferCostTotal ?? 0;
  let hitCount = prev?.hitCount ?? 0;

  let teamEOTotal = prev?.teamEOTotal ?? 0;
  let teamEOCount = prev?.teamEOCount ?? 0;
  let captainEOTotal = prev?.captainEOTotal ?? 0;
  let captainEOCount = prev?.captainEOCount ?? 0;
  let captainShareTotal = prev?.captainShareTotal ?? 0;
  let captainShareCount = prev?.captainShareCount ?? 0;

  let lastSuccessfulGw = lastUpdatedGw;

  const newTopCandidates: CaptainPerf[] = [];

  for (const gw of missingGwIds) {
    const picksUrl = `${BASE_URL}/api/entry/${entryId}/event/${gw}/picks/`;
    const data = await fetchJsonWithRetry<PicksResponse>(picksUrl);
    const picks = Array.isArray(data.picks) ? data.picks : [];

    const eoByPlayer = eoByGw.get(gw) ?? new Map();

    const cap = picks.find((p) => p.is_captain);
    if (cap) {
      const capEO = eoByPlayer.get(cap.element);
      if (capEO) {
        // Hvis flere kapteiner (ved chips), ta gjennomsnittet av deres EO
        const captains = picks.filter((p) => p.is_captain || (p.multiplier ?? 1) > 1);
        let captainEOSum = 0;
        let captainEOValidCount = 0;

        for (const c of captains) {
          const cEO = eoByPlayer.get(c.element);
          if (cEO) {
            captainEOSum += cEO.eo;
            captainEOValidCount += 1;

            if (cEO.captainCount != null && cEO.sampleSize > 0) {
              captainShareTotal += cEO.captainCount / cEO.sampleSize;
              captainShareCount += 1;
            }
          }
        }

        if (captainEOValidCount > 0) {
          captainEOTotal += captainEOSum / captainEOValidCount; // Gjennomsnitt
          captainEOCount += 1;
        }
      }
    }

    let teamEOThisGw = 0;
    let ok = true;
    for (const p of picks) {
      const m = Number.isFinite(p.multiplier) ? p.multiplier : 1;
      if (m <= 0) continue;
      const row = eoByPlayer.get(p.element);
      if (!row) {
        ok = false;
        break;
      }
      teamEOThisGw += row.eo; // Ingen multiplier - bare summen av EO-verdiene
    }
    if (ok) {
      teamEOTotal += teamEOThisGw;
      teamEOCount += 1;
    }

    const chipsUsedThisGw = chipsByGw.get(gw) ?? [];
    for (const chipName of chipsUsedThisGw) {
      const pointsChip = chipNameForPoints(chipName);
      if (!pointsChip) continue;

      let chipPoints: number;
      if (pointsChip === '2capt') {
        const vice = picks.find((p) => p.is_vice_captain);
        const capPts = cap ? (pts.get(`${gw}:${cap.element}`) ?? 0) : 0;
        const vicePts = vice ? (pts.get(`${gw}:${vice.element}`) ?? 0) : 0;
        chipPoints = capPts + vicePts;
      } else {
        const xi = picks.filter((p) => p.position >= 1 && p.position <= 11);
        const forwards = xi.filter((p) => elementTypeKey(p.element_type) === 'fwd');
        chipPoints = forwards.reduce((sum, p) => sum + (pts.get(`${gw}:${p.element}`) ?? 0), 0);
      }

      await prisma.chipUsage.updateMany({
        where: { entryId, gameweekId: gw, chipName },
        data: { points: chipPoints },
      });
    }

    const cost = costByGw.get(gw) ?? 0;
    transferCostTotal += cost;
    if (cost > 0) hitCount += 1;

    const capPicks = picks.filter((p) => p.is_captain || p.multiplier > 1);
    let captainPointsSum = 0;
    for (const p of capPicks) {
      const basePts = pts.get(`${gw}:${p.element}`) ?? 0;
      captainPointsSum += basePts;
      newTopCandidates.push({ gw, playerId: p.element, points: basePts });
    }
    captainPointsTotal += captainPointsSum;
    if (captainPointsSum >= 5) captainSuccess5PlusCount += 1;

    let gkpC = 0;
    let defC = 0;
    let midC = 0;
    let fwdC = 0;

    for (const p of picks) {
      if (p.position > 11) continue;
      const k = elementTypeKey(p.element_type);
      if (k === 'gkp') gkpC += 1;
      else if (k === 'def') defC += 1;
      else if (k === 'mid') midC += 1;
      else if (k === 'fwd') fwdC += 1;

      const basePts = pts.get(`${gw}:${p.element}`) ?? 0;
      if (k === 'gkp') xiGkp += basePts;
      else if (k === 'def') xiDef += basePts;
      else if (k === 'mid') xiMid += basePts;
      else if (k === 'fwd') xiFwd += basePts;
    }

    xiGkpCountTotal += gkpC;
    xiDefCountTotal += defC;
    xiMidCountTotal += midC;
    xiFwdCountTotal += fwdC;

    gwCount += 1;
    lastSuccessfulGw = gw;
  }

  await prisma.entrySeasonTotals.upsert({
    where: { entryId },
    update: {
      lastUpdatedGw: lastSuccessfulGw,
      gwCount,
      captainPointsTotal,
      captainSuccess5PlusCount,
      xiGkpPointsTotal: xiGkp,
      xiDefPointsTotal: xiDef,
      xiMidPointsTotal: xiMid,
      xiFwdPointsTotal: xiFwd,
      xiGkpCountTotal,
      xiDefCountTotal,
      xiMidCountTotal,
      xiFwdCountTotal,
      transferCostTotal,
      hitCount,
      teamEOTotal,
      teamEOCount,
      captainEOTotal,
      captainEOCount,
      captainShareTotal,
      captainShareCount,
    },
    create: {
      entryId,
      lastUpdatedGw: lastSuccessfulGw,
      gwCount,
      captainPointsTotal,
      captainSuccess5PlusCount,
      captainTop3Json: [],
      xiGkpPointsTotal: xiGkp,
      xiDefPointsTotal: xiDef,
      xiMidPointsTotal: xiMid,
      xiFwdPointsTotal: xiFwd,
      xiGkpCountTotal,
      xiDefCountTotal,
      xiMidCountTotal,
      xiFwdCountTotal,
      transferCostTotal,
      hitCount,
      teamEOTotal,
      teamEOCount,
      captainEOTotal,
      captainEOCount,
      captainShareTotal,
      captainShareCount,
    },
  });
}

export async function computeEntryInsights(prisma: PrismaClient, entryId: number) {
  const lastFinished = await prisma.gameweek.findFirst({
    where: { finished: true },
    orderBy: { id: 'desc' },
    select: { id: true },
  });
  const computedThroughGw = lastFinished?.id ?? 0;

  if (computedThroughGw > 0) {
    await prisma.entry.upsert({
      where: { id: entryId },
      update: {},
      create: { id: entryId, entryName: `Entry ${entryId}`, playerName: `Entry ${entryId}` },
    });

    await ensureEntrySeasonTotalsUpToDate(prisma, entryId, computedThroughGw);
  }

  // --- User totals
  const totals = await prisma.entrySeasonTotals.findUnique({
    where: { entryId },
    select: {
      lastUpdatedGw: true,
      gwCount: true,

      captainPointsTotal: true,
      captainSuccess5PlusCount: true,
      captainTop3Json: true,

      xiGkpPointsTotal: true,
      xiDefPointsTotal: true,
      xiMidPointsTotal: true,
      xiFwdPointsTotal: true,

      xiGkpCountTotal: true,
      xiDefCountTotal: true,
      xiMidCountTotal: true,
      xiFwdCountTotal: true,

      transferCostTotal: true,
      hitCount: true,

      teamEOTotal: true,
      teamEOCount: true,
      captainEOTotal: true,
      captainEOCount: true,
      captainShareTotal: true,
      captainShareCount: true,
    },
  });

  const gwCount = totals?.gwCount ?? 0;

  const userAvgCaptainPoints = gwCount > 0 ? (totals?.captainPointsTotal ?? 0) / gwCount : null;
  const userReturns5Plus = totals?.captainSuccess5PlusCount ?? 0;

  const userAvgByPos =
    gwCount > 0
      ? {
          gkp: (totals?.xiGkpPointsTotal ?? 0) / gwCount,
          def: (totals?.xiDefPointsTotal ?? 0) / gwCount,
          mid: (totals?.xiMidPointsTotal ?? 0) / gwCount,
          fwd: (totals?.xiFwdPointsTotal ?? 0) / gwCount,
        }
      : null;

  const userAvgXI =
    gwCount > 0
      ? {
          gkp: (totals?.xiGkpCountTotal ?? 0) / gwCount,
          def: (totals?.xiDefCountTotal ?? 0) / gwCount,
          mid: (totals?.xiMidCountTotal ?? 0) / gwCount,
          fwd: (totals?.xiFwdCountTotal ?? 0) / gwCount,
        }
      : null;

  const userAvgTransferCost = gwCount > 0 ? (totals?.transferCostTotal ?? 0) / gwCount : null;

  // --- overallRank now (at computedThroughGw)
  const BASE_URL = process.env.ESF_BASE_URL ?? 'https://en.fantasy.eliteserien.no';
  let overallRankNow: number | null = null;

  if (computedThroughGw > 0) {
    const historyUrl = `${BASE_URL}/api/entry/${entryId}/history/`;
    const history = await fetchJsonWithRetry<EntryHistoryResponse>(historyUrl);
    const row = (history.current ?? []).find((r) => r.event === computedThroughGw);
    const r = row?.overall_rank;
    overallRankNow = typeof r === 'number' ? r : null;
  }

  const brackets = await prisma.bracket.findMany({
    select: { id: true, name: true, rankFrom: true, rankTo: true, active: true },
    orderBy: { rankFrom: 'asc' },
  });
  const bracket = findBracketForRank(overallRankNow, brackets);

  const bracketStats = bracket
    ? await prisma.bracketStats.findUnique({
        where: { bracketId: bracket.id },
        select: {
          bracketId: true,
          computedThroughGameweekId: true,
          version: true,
          sampleSize: true,
          data: true,
        },
      })
    : null;

  const baseline = (bracketStats?.data ?? null) as any;

  const baselineAvgCaptainPoints =
    baseline?.points?.captain?.avgCaptainPoints != null
      ? Number(baseline.points.captain.avgCaptainPoints)
      : null;

  const baselineSuccessRate5Plus =
    baseline?.points?.captain?.successRate5Plus != null
      ? Number(baseline.points.captain.successRate5Plus)
      : null;

  const baselineAvgByPos =
    baseline?.points?.byPosition != null
      ? {
          gkp: Number(baseline.points.byPosition.gkp ?? 0),
          def: Number(baseline.points.byPosition.def ?? 0),
          mid: Number(baseline.points.byPosition.mid ?? 0),
          fwd: Number(baseline.points.byPosition.fwd ?? 0),
        }
      : null;

  const baselineAvgXI =
    baseline?.points?.xi != null
      ? {
          gkp: Number(baseline.points.xi.gkp ?? 0),
          def: Number(baseline.points.xi.def ?? 0),
          mid: Number(baseline.points.xi.mid ?? 0),
          fwd: Number(baseline.points.xi.fwd ?? 0),
        }
      : null;

  const baselineHitRate = baseline?.risk?.hitRate != null ? Number(baseline.risk.hitRate) : null;
  const baselineAvgTransferCost =
    baseline?.risk?.avgTransferCost != null ? Number(baseline.risk.avgTransferCost) : null;

  // Hit counts (for slider and UI)
  const userHitCount = totals?.hitCount ?? 0;
  const baselineHitCount = baselineHitRate != null ? baselineHitRate * gwCount : null;

  const baselineAvgTeamEO =
    baseline?.risk?.avgTeamEO != null ? Number(baseline.risk.avgTeamEO) : null;
  const baselineAvgCaptainEO =
    baseline?.risk?.avgCaptainEO != null ? Number(baseline.risk.avgCaptainEO) : null;
  const baselineAvgCaptainShare =
    baseline?.risk?.avgCaptainShare != null ? Number(baseline.risk.avgCaptainShare) : null;

  const teamEOCount = totals?.teamEOCount ?? 0;
  const captainEOCount = totals?.captainEOCount ?? 0;
  const captainShareCount = totals?.captainShareCount ?? 0;
  const userAvgTeamEO = teamEOCount > 0 ? (totals?.teamEOTotal ?? 0) / teamEOCount : null;
  const userAvgCaptainEO =
    captainEOCount > 0 ? (totals?.captainEOTotal ?? 0) / captainEOCount : null;
  const userAvgCaptainShare =
    captainShareCount > 0 ? (totals?.captainShareTotal ?? 0) / captainShareCount : null;

  // Chips baseline (fra BracketStats snapshot)
  const baselineChips = baseline?.chips ?? null;
  const baselineCoverage = baseline?.points?.coverage ?? baseline?.coverage ?? null;

  // --- Top 3 captains (user) -> med navn
  const top3Raw = Array.isArray(totals?.captainTop3Json) ? (totals?.captainTop3Json as any[]) : [];
  const top3 = top3Raw
    .map((x) => ({
      gw: typeof x?.gw === 'number' ? x.gw : null,
      playerId: typeof x?.playerId === 'number' ? x.playerId : null,
      points: typeof x?.points === 'number' ? x.points : null,
    }))
    .filter((x) => x.gw != null && x.playerId != null && x.points != null) as Array<{
    gw: number;
    playerId: number;
    points: number;
  }>;

  const playerIds = Array.from(new Set(top3.map((x) => x.playerId)));
  const players =
    playerIds.length > 0
      ? await prisma.player.findMany({
          where: { id: { in: playerIds } },
          select: { id: true, webName: true },
        })
      : [];

  const nameById = new Map<number, string>();
  for (const p of players) nameById.set(p.id, p.webName);

  const topCaptains = top3.map((x, i) => ({
    rank: i + 1,
    playerId: x.playerId,
    playerName: nameById.get(x.playerId) ?? `#${x.playerId}`,
    gw: x.gw,
    points: x.points,
  }));

  // --- User chips
  const chipRows = await prisma.chipUsage.findMany({
    where: { entryId, gameweekId: { lte: computedThroughGw } },
    select: { gameweekId: true, chipName: true, points: true },
    orderBy: { gameweekId: 'asc' },
  });

  const used: Record<string, Array<{ gameweekId: number; points?: number | null }>> = {};
  for (const c of chipRows) {
    const k = normalizeChipName(c.chipName, c.gameweekId);
    if (!used[k]) used[k] = [];
    used[k].push({ gameweekId: c.gameweekId, points: c.points ?? null });
  }

  const knownChips: NormalizedChipKey[] = ['wildcard1', 'wildcard2', '2capt', 'frush', 'rich'];
  const notUsed = knownChips.filter((k) => !used[k] || used[k].length === 0);

  const pointsByChip: Record<string, Array<{ gameweekId: number; points: number | null }>> = {};
  for (const k of Object.keys(used)) {
    const arr = used[k].map((x) => ({ gameweekId: x.gameweekId, points: x.points ?? null }));
    const canonical = chipNameForPoints(k);
    const key = canonical ?? k;
    pointsByChip[key] = [...(pointsByChip[key] ?? []), ...arr];
  }

  // --- Build insights object (old-style inside insights)
  const threshold = 5;

  const expectedReturns5Plus =
    baselineSuccessRate5Plus != null && gwCount > 0 ? baselineSuccessRate5Plus * gwCount : null;

  const returns5PlusDiff =
    expectedReturns5Plus != null ? userReturns5Plus - expectedReturns5Plus : null;

  const captain = {
    threshold,
    returns5Plus: userReturns5Plus,
    usedGameweeks: gwCount,
    missingPointsGameweeks: 0,
    missingCaptainGameweeks: 0,
    totalFinishedGameweeksWithPicks: gwCount,
    assumedZeroCaptainPlayers: 0,
    assumedZeroCaptainGameweeks: 0,
    baseline: {
      expectedReturns5Plus,
      avgSuccessRate5Plus: baselineSuccessRate5Plus,
      usedGameweeks: gwCount,
      missingGameweeks: 0,
    },
    diff: {
      returns5Plus: returns5PlusDiff,
    },
    topCaptains,
  };

  const pointsSummary = {
    avgUserCaptainPoints: userAvgCaptainPoints,
    avgBaselineCaptainPoints: baselineAvgCaptainPoints,
    captainPointsDiff:
      userAvgCaptainPoints != null && baselineAvgCaptainPoints != null
        ? userAvgCaptainPoints - baselineAvgCaptainPoints
        : null,

    avgUserByPosition: userAvgByPos,
    avgBaselineByPosition: baselineAvgByPos,
    byPositionDiff:
      userAvgByPos != null && baselineAvgByPos != null
        ? {
            gkp: userAvgByPos.gkp - baselineAvgByPos.gkp,
            def: userAvgByPos.def - baselineAvgByPos.def,
            mid: userAvgByPos.mid - baselineAvgByPos.mid,
            fwd: userAvgByPos.fwd - baselineAvgByPos.fwd,
          }
        : null,

    avgUserXI: userAvgXI,
    avgBaselineXI: baselineAvgXI,
    xiDiff:
      userAvgXI != null && baselineAvgXI != null
        ? {
            gkp: userAvgXI.gkp - baselineAvgXI.gkp,
            def: userAvgXI.def - baselineAvgXI.def,
            mid: userAvgXI.mid - baselineAvgXI.mid,
            fwd: userAvgXI.fwd - baselineAvgXI.fwd,
          }
        : null,

    usedGameweeks: gwCount,
  };

  const riskSummary = {
    avgUserCaptainEO: userAvgCaptainEO,
    avgBaselineCaptainEO: baselineAvgCaptainEO,
    captainEODiff:
      userAvgCaptainEO != null && baselineAvgCaptainEO != null
        ? userAvgCaptainEO - baselineAvgCaptainEO
        : null,

    avgUserCaptainShare: userAvgCaptainShare,
    avgBaselineCaptainShare: baselineAvgCaptainShare,
    captainShareDiff:
      userAvgCaptainShare != null && baselineAvgCaptainShare != null
        ? userAvgCaptainShare - baselineAvgCaptainShare
        : null,

    avgTeamEO: userAvgTeamEO,
    avgBaselineTeamEO: baselineAvgTeamEO,
    teamEODiff:
      userAvgTeamEO != null && baselineAvgTeamEO != null ? userAvgTeamEO - baselineAvgTeamEO : null,

    avgUserTransferCost: userAvgTransferCost,
    avgBaselineTransferCost: baselineAvgTransferCost,
    transferCostDiff:
      userAvgTransferCost != null && baselineAvgTransferCost != null
        ? userAvgTransferCost - baselineAvgTransferCost
        : null,

    userHitCount,
    baselineHitCount,

    usedGameweeks: gwCount,
  };

  const chips = {
    used,
    notUsed,
    pointsByChip,
    baseline: baselineChips
      ? {
          totalUsed: baselineChips.totalUsed ?? {},
          usedThisGw: baselineChips.usedThisGw ?? {},
          usedThisGwRate: baselineChips.usedThisGwRate ?? {},
          sampleSize:
            typeof baselineCoverage?.sampleSize === 'number'
              ? baselineCoverage.sampleSize
              : (bracketStats?.sampleSize ?? null),
          points: baselineChips.points ?? null,
        }
      : null,
  };

  const insights = {
    captain,
    risk: { byGameweek: [], summary: riskSummary },
    points: { byGameweek: [], summary: pointsSummary },
    chips,
  };

  const data = {
    insights,
    meta: {
      computedThroughGw,
      overallRankNow,
      bracket: bracket
        ? { id: bracket.id, name: bracket.name, rankFrom: bracket.rankFrom, rankTo: bracket.rankTo }
        : null,
      entrySeasonTotals: {
        lastUpdatedGw: totals?.lastUpdatedGw ?? 0,
        gwCount,
      },
      bracketStats: bracketStats
        ? {
            bracketId: bracketStats.bracketId,
            computedThroughGameweekId: bracketStats.computedThroughGameweekId,
            version: bracketStats.version,
            sampleSize: bracketStats.sampleSize,
          }
        : null,
    },
  };

  await prisma.entryInsights.upsert({
    where: { entryId },
    create: { entryId, computedThroughGameweekId: computedThroughGw, version: 6, data },
    update: {
      computedThroughGameweekId: computedThroughGw,
      version: 6,
      data,
      computedAt: new Date(),
    },
  });

  return data;
}
