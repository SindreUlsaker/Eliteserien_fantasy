import { PrismaClient } from '@prisma/client';

function key(playerId: number, gameweekId: number) {
  return `${playerId}:${gameweekId}`;
}

function avg(nums: number[]) {
  if (nums.length === 0) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function findBracketIdForRank(
  rank: number | null | undefined,
  brackets: Array<{ id: number; rankFrom: number; rankTo: number; active: boolean }>
): number | null {
  if (rank == null) return null;
  const b = brackets.find((x) => x.active && rank >= x.rankFrom && rank <= x.rankTo);
  return b?.id ?? null;
}

function posKey(positionId: number): 'gkp' | 'def' | 'mid' | 'fwd' | 'unknown' {
  if (positionId === 1) return 'gkp';
  if (positionId === 2) return 'def';
  if (positionId === 3) return 'mid';
  if (positionId === 4) return 'fwd';
  return 'unknown';
}

type PosBuckets = { gkp: number; def: number; mid: number; fwd: number };

function emptyBuckets(): PosBuckets {
  return { gkp: 0, def: 0, mid: 0, fwd: 0 };
}

// --- Chips helpers ---
type NormalizedChipKey = 'wildcard1' | 'wildcard2' | '2capt' | 'frush' | 'rich' | string;

function normalizeChipName(chipName: string, gameweekId: number): NormalizedChipKey {
  if (chipName === 'wildcard') return gameweekId >= 16 ? 'wildcard2' : 'wildcard1';
  return chipName as NormalizedChipKey;
}

export async function computeEntryInsights(prisma: PrismaClient, entryId: number) {
  const entryGws = await prisma.entryGameweek.findMany({
    where: { entryId, gameweek: { finished: true } },
    include: { picks: true },
    orderBy: { gameweekId: 'asc' },
  });

  const threshold = 5;

  if (entryGws.length === 0) {
    const empty = {
      captain: {
        threshold,
        returns5Plus: 0,
        usedGameweeks: 0,
        missingPointsGameweeks: 0,
        missingCaptainGameweeks: 0,
        totalFinishedGameweeksWithPicks: 0,
        assumedZeroCaptainPlayers: 0,
        assumedZeroCaptainGameweeks: 0,
      },
      risk: {
        byGameweek: [],
        summary: {
          avgCaptainShare: null,
          avgBaselineCaptainEO: null,
          captainShareDiff: null,
          avgTeamEO: null,
          avgBaselineTeamEO: null,
          teamEODiff: null,
          avgUserTransferCost: null,
          avgBaselineTransferCost: null,
          transferCostDiff: null,
          userHitRate: null,
          baselineHitRate: null,
          usedGameweeks: 0,
        },
      },
      points: {
        byGameweek: [],
        summary: {
          avgUserCaptainPoints: null,
          avgBaselineCaptainPoints: null,
          captainPointsDiff: null,

          avgUserByPosition: null,
          avgBaselineByPosition: null,
          byPositionDiff: null,

          avgUserXI: null,
          avgBaselineXI: null,
          xiDiff: null,

          usedGameweeks: 0,
        },
      },
      chips: {
        used: {},
        notUsed: ['wildcard1', 'wildcard2', '2capt', 'frush', 'rich'],
        pointsByChip: { '2capt': [], frush: [] },
      },
    };

    await prisma.entryInsights.upsert({
      where: { entryId },
      create: { entryId, computedThroughGameweekId: 0, version: 3, data: empty },
      update: {
        entryId,
        computedThroughGameweekId: 0,
        version: 3,
        data: empty,
        computedAt: new Date(),
      },
    });

    return empty;
  }

  // --- Preload: brackets + player position map ---
  const brackets = await prisma.bracket.findMany({
    select: { id: true, rankFrom: true, rankTo: true, active: true },
    orderBy: { rankFrom: 'asc' },
  });

  const players = await prisma.player.findMany({ select: { id: true, positionId: true } });
  const positionByPlayerId = new Map<number, number>();
  for (const p of players) positionByPlayerId.set(p.id, p.positionId);

  const captainPairs: Array<{ playerId: number; gameweekId: number }> = [];
  for (const gwRow of entryGws) {
    const capPicks = gwRow.picks.filter((p) => p.isCaptain === true || p.multiplier > 1);
    for (const p of capPicks)
      captainPairs.push({ playerId: p.playerId, gameweekId: gwRow.gameweekId });
  }

  const uniqueCaptainPlayerIds = Array.from(new Set(captainPairs.map((r) => r.playerId)));
  const uniqueCaptainGwIds = Array.from(new Set(captainPairs.map((r) => r.gameweekId)));

  const captainStatsRows =
    uniqueCaptainPlayerIds.length === 0 || uniqueCaptainGwIds.length === 0
      ? []
      : await prisma.playerGameweekStats.findMany({
          where: {
            playerId: { in: uniqueCaptainPlayerIds },
            gameweekId: { in: uniqueCaptainGwIds },
          },
          select: { playerId: true, gameweekId: true, totalPoints: true },
        });

  const statsMap = new Map<string, number>();
  for (const r of captainStatsRows) statsMap.set(key(r.playerId, r.gameweekId), r.totalPoints);

  let returns5Plus = 0;
  let usedGameweeks = 0;

  let baselineExpectedReturns5Plus = 0; // summerer bracketens successRate5Plus per GW
  let baselineReturnsUsedGameweeks = 0; // antall GWs der baseline finnes
  let baselineReturnsMissingGameweeks = 0; // antall GWs der baseline mangler

  const missingPointsGameweeks = 0;

  let assumedZeroCaptainPlayers = 0;
  let assumedZeroCaptainGameweeks = 0;

  const topCandidates: Array<{ playerId: number; gameweekId: number; points: number }> = [];

  for (const gwRow of entryGws) {
    const capPicks = gwRow.picks.filter((p) => p.isCaptain === true || p.multiplier > 1);

    let captainPointsSum = 0;

    if (capPicks.length === 0) {
      assumedZeroCaptainGameweeks += 1;
    } else {
      for (const p of capPicks) {
        const pts = statsMap.get(key(p.playerId, gwRow.gameweekId));
        if (pts == null) {
          assumedZeroCaptainPlayers += 1;
          // treat missing as 0
          continue;
        }
        captainPointsSum += pts;
      }
    }

    usedGameweeks += 1;
    if (captainPointsSum >= threshold) returns5Plus += 1;
  }

  // Multiplier kun for å finne 11-er, ikke kaptein
  const pointsPairs: Array<{ playerId: number; gameweekId: number }> = [];

  for (const gwRow of entryGws) {
    const gwId = gwRow.gameweekId;

    // 11-er
    for (const p of gwRow.picks) {
      if (p.multiplier > 0) pointsPairs.push({ playerId: p.playerId, gameweekId: gwId });
    }

    // captain: samme metode
    const captainPick =
      gwRow.picks.find((p) => p.isCaptain) ??
      gwRow.picks.filter((p) => p.multiplier > 1).sort((a, b) => b.multiplier - a.multiplier)[0] ??
      null;

    if (captainPick) pointsPairs.push({ playerId: captainPick.playerId, gameweekId: gwId });
  }

  const uniquePointPlayerIds = Array.from(new Set(pointsPairs.map((r) => r.playerId)));
  const uniquePointGwIds = Array.from(new Set(pointsPairs.map((r) => r.gameweekId)));

  const pointRows =
    uniquePointPlayerIds.length === 0 || uniquePointGwIds.length === 0
      ? []
      : await prisma.playerGameweekStats.findMany({
          where: {
            playerId: { in: uniquePointPlayerIds },
            gameweekId: { in: uniquePointGwIds },
          },
          select: { playerId: true, gameweekId: true, totalPoints: true },
        });

  const pointsMap = new Map<string, number>();
  for (const r of pointRows) pointsMap.set(key(r.playerId, r.gameweekId), r.totalPoints);

  const riskByGameweek: Array<{
    gameweekId: number;
    bracketId: number | null;
    overallRank: number | null;
    captainPlayerId: number | null;

    userCaptainShare: number | null;
    baselineCaptainEO: number | null;

    userTeamEO: number | null;
    baselineTeamEO: number | null;

    userTransferCost: number | null;
    baselineAvgTransferCost: number | null;
    baselineHitRate: number | null;

    missing: {
      bracket: boolean;
      baseline: boolean;
      captainEO: boolean;
      teamEO: boolean;
      hits: boolean;
    };
  }> = [];

  const pointsByGameweek: Array<{
    gameweekId: number;
    bracketId: number | null;

    user: {
      captainPoints: number | null;
      byPosition: PosBuckets | null;
      xi: PosBuckets | null;
    };

    baseline: {
      captainPoints: number | null;
      byPosition: PosBuckets | null;
      xi: PosBuckets | null;
    };

    missing: {
      bracket: boolean;
      baseline: boolean;
      userPoints: boolean;
      userCaptainPoints: boolean;
    };
  }> = [];

  for (const gwRow of entryGws) {
    const gwId = gwRow.gameweekId;

    const bracketId = findBracketIdForRank(gwRow.overallRank, brackets);

    // finn kaptein
    const captainPick =
      gwRow.picks.find((p) => p.isCaptain) ??
      gwRow.picks.filter((p) => p.multiplier > 1).sort((a, b) => b.multiplier - a.multiplier)[0] ??
      null;

    const captainPlayerId = captainPick?.playerId ?? null;

    let baselineCaptainEO: number | null = null;
    let baselineTeamEO: number | null = null;

    let baselineAvgTransferCost: number | null = null;
    let baselineHitRate: number | null = null;

    let baselineCaptainPoints: number | null = null;
    let baselineByPosition: PosBuckets | null = null;
    let baselineXI: PosBuckets | null = null;

    if (bracketId != null) {
      const bgs = await prisma.bracketGameweekStats.findFirst({
        where: { gameweekId: gwId, bracketId, version: 1 },
        select: { data: true },
      });

      const d = bgs?.data as any;

      baselineCaptainEO =
        typeof d?.risk?.avgCaptainEO === 'number' ? (d.risk.avgCaptainEO as number) : null;
      baselineTeamEO = typeof d?.risk?.avgTeamEO === 'number' ? (d.risk.avgTeamEO as number) : null;

      baselineAvgTransferCost =
        typeof d?.risk?.avgTransferCost === 'number' ? (d.risk.avgTransferCost as number) : null;
      baselineHitRate = typeof d?.risk?.hitRate === 'number' ? (d.risk.hitRate as number) : null;

      baselineCaptainPoints =
        typeof d?.points?.captain?.avgCaptainPoints === 'number'
          ? (d.points.captain.avgCaptainPoints as number)
          : null;

      const baselineCaptainSuccessRate5Plus =
        typeof d?.points?.captain?.successRate5Plus === 'number'
          ? (d.points.captain.successRate5Plus as number)
          : null;

      if (baselineCaptainSuccessRate5Plus != null) {
        baselineExpectedReturns5Plus += baselineCaptainSuccessRate5Plus;
        baselineReturnsUsedGameweeks += 1;
      } else {
        baselineReturnsMissingGameweeks += 1;
      }

      const bp = d?.points?.byPosition;
      if (bp && typeof bp === 'object') {
        const gkp = typeof bp.gkp === 'number' ? (bp.gkp as number) : 0;
        const def = typeof bp.def === 'number' ? (bp.def as number) : 0;
        const mid = typeof bp.mid === 'number' ? (bp.mid as number) : 0;
        const fwd = typeof bp.fwd === 'number' ? (bp.fwd as number) : 0;
        baselineByPosition = { gkp, def, mid, fwd };
      } else {
        baselineByPosition = null;
      }

      const xi = d?.points?.avgXI;
      if (xi && typeof xi === 'object') {
        const gkp = typeof xi.gkp === 'number' ? (xi.gkp as number) : 0;
        const def = typeof xi.def === 'number' ? (xi.def as number) : 0;
        const mid = typeof xi.mid === 'number' ? (xi.mid as number) : 0;
        const fwd = typeof xi.fwd === 'number' ? (xi.fwd as number) : 0;
        baselineXI = { gkp, def, mid, fwd };
      } else {
        baselineXI = null;
      }
    } else {
      // No bracket => baseline unavailable for this GW
      baselineReturnsMissingGameweeks += 1;
    }

    // user risk metrics
    let userCaptainShare: number | null = null;
    let userTeamEO: number | null = null;

    const userTransferCost =
      typeof gwRow.eventTransfersCost === 'number' ? (gwRow.eventTransfersCost as number) : 0;

    if (bracketId != null) {
      const pickedPlayerIds = gwRow.picks.map((p) => p.playerId);

      const eoRows = await prisma.effectiveOwnership.findMany({
        where: {
          gameweekId: gwId,
          bracketId,
          playerId: { in: pickedPlayerIds },
        },
        select: { playerId: true, eo: true },
      });

      const eoMap = new Map<number, number>();
      for (const r of eoRows) eoMap.set(r.playerId, r.eo);

      let sum = 0;
      let haveAny = false;
      for (const pid of pickedPlayerIds) {
        const eo = eoMap.get(pid);
        if (eo == null) continue;
        sum += eo;
        haveAny = true;
      }
      userTeamEO = haveAny ? sum : null;

      if (captainPlayerId != null) {
        const cap = await prisma.effectiveOwnership.findUnique({
          where: {
            gameweekId_bracketId_playerId: {
              gameweekId: gwId,
              bracketId,
              playerId: captainPlayerId,
            },
          },
          select: { captainCount: true, sampleSize: true },
        });

        if (cap && cap.sampleSize > 0 && typeof cap.captainCount === 'number') {
          userCaptainShare = cap.captainCount / cap.sampleSize;
        }
      }
    }

    riskByGameweek.push({
      gameweekId: gwId,
      bracketId,
      overallRank: gwRow.overallRank ?? null,
      captainPlayerId,

      userCaptainShare,
      baselineCaptainEO,

      userTeamEO,
      baselineTeamEO,

      userTransferCost,
      baselineAvgTransferCost,
      baselineHitRate,

      missing: {
        bracket: bracketId == null,
        baseline:
          bracketId != null &&
          (baselineCaptainEO == null ||
            baselineTeamEO == null ||
            baselineAvgTransferCost == null ||
            baselineHitRate == null),
        captainEO: bracketId != null && captainPlayerId != null && userCaptainShare == null,
        teamEO: bracketId != null && userTeamEO == null,
        hits: bracketId != null && (baselineAvgTransferCost == null || baselineHitRate == null),
      },
    });

    // Antar 0 poeng for manglende spillerpoeng
    let missingAnyUserPoints = false;

    let userCaptainPoints: number | null = null;
    // capPicks: use explicit isCaptain if present, otherwise fallback multiplier>1
    const capPicksForUser = gwRow.picks.filter((p) => p.isCaptain === true || p.multiplier > 1);
    if (capPicksForUser.length === 0) {
      userCaptainPoints = null;
    } else {
      let capSum = 0;
      let bestPlayerId: number | null = null;
      let bestPoints = -1;
      for (const p of capPicksForUser) {
        const pts = pointsMap.get(key(p.playerId, gwId));
        const val = pts == null ? 0 : pts;
        if (pts == null) missingAnyUserPoints = true;
        capSum += val;
        if (val > bestPoints) {
          bestPoints = val;
          bestPlayerId = p.playerId;
        }
      }

      userCaptainPoints = capSum;

      if (bestPlayerId != null) {
        topCandidates.push({ playerId: bestPlayerId, gameweekId: gwId, points: bestPoints });
      }
    }

    const userByPos = emptyBuckets();
    const userXI = emptyBuckets();

    // XI
    const xiPicks = gwRow.picks.filter((p) => p.multiplier > 0);
    for (const p of xiPicks) {
      const posId = positionByPlayerId.get(p.playerId) ?? -1;
      const k = posKey(posId);
      if (k === 'unknown') continue;

      userXI[k] += 1;

      const pts = pointsMap.get(key(p.playerId, gwId));
      if (pts == null) {
        missingAnyUserPoints = true;
        // assumed 0
      } else {
        userByPos[k] += pts;
      }
    }

    pointsByGameweek.push({
      gameweekId: gwId,
      bracketId,

      user: {
        captainPoints: userCaptainPoints,
        byPosition: userByPos,
        xi: userXI,
      },

      baseline: {
        captainPoints: baselineCaptainPoints,
        byPosition: baselineByPosition,
        xi: baselineXI,
      },

      missing: {
        bracket: bracketId == null,
        baseline:
          bracketId != null &&
          (baselineCaptainPoints == null || baselineByPosition == null || baselineXI == null),
        userPoints: missingAnyUserPoints,
        userCaptainPoints:
          captainPlayerId != null && userCaptainPoints === 0 && missingAnyUserPoints,
      },
    });
  }

  //Risk summaries
  const captainShares = riskByGameweek
    .map((r) => r.userCaptainShare)
    .filter((x): x is number => typeof x === 'number');
  const baselineCapt = riskByGameweek
    .map((r) => r.baselineCaptainEO)
    .filter((x): x is number => typeof x === 'number');

  const teamEOs = riskByGameweek
    .map((r) => r.userTeamEO)
    .filter((x): x is number => typeof x === 'number');
  const baselineTeam = riskByGameweek
    .map((r) => r.baselineTeamEO)
    .filter((x): x is number => typeof x === 'number');

  const avgCaptainShare = avg(captainShares);
  const avgBaselineCaptainEO = avg(baselineCapt);
  const captainShareDiff =
    avgCaptainShare != null && avgBaselineCaptainEO != null
      ? avgCaptainShare - avgBaselineCaptainEO
      : null;

  const avgTeamEO = avg(teamEOs);
  const avgBaselineTeamEO = avg(baselineTeam);
  const teamEODiff =
    avgTeamEO != null && avgBaselineTeamEO != null ? avgTeamEO - avgBaselineTeamEO : null;

  const userTransferCosts = riskByGameweek
    .map((r) => r.userTransferCost)
    .filter((x): x is number => typeof x === 'number');
  const baselineTransferCosts = riskByGameweek
    .map((r) => r.baselineAvgTransferCost)
    .filter((x): x is number => typeof x === 'number');
  const baselineHitRates = riskByGameweek
    .map((r) => r.baselineHitRate)
    .filter((x): x is number => typeof x === 'number');

  const avgUserTransferCost = avg(userTransferCosts);
  const avgBaselineTransferCost = avg(baselineTransferCosts);
  const transferCostDiff =
    avgUserTransferCost != null && avgBaselineTransferCost != null
      ? avgUserTransferCost - avgBaselineTransferCost
      : null;

  const userHitRate =
    riskByGameweek.length === 0
      ? null
      : riskByGameweek.filter((r) => (r.userTransferCost ?? 0) > 0).length / riskByGameweek.length;

  const baselineHitRate = avg(baselineHitRates);

  //Points summaries
  const userCapPts = pointsByGameweek
    .map((r) => r.user.captainPoints)
    .filter((x): x is number => typeof x === 'number');

  const baseCapPts = pointsByGameweek
    .map((r) => r.baseline.captainPoints)
    .filter((x): x is number => typeof x === 'number');

  const avgUserCaptainPoints = avg(userCapPts);
  const avgBaselineCaptainPoints = avg(baseCapPts);
  const captainPointsDiff =
    avgUserCaptainPoints != null && avgBaselineCaptainPoints != null
      ? avgUserCaptainPoints - avgBaselineCaptainPoints
      : null;

  function bucketAvg(items: PosBuckets[]) {
    if (items.length === 0) return null;
    const sum = emptyBuckets();
    for (const b of items) {
      sum.gkp += b.gkp;
      sum.def += b.def;
      sum.mid += b.mid;
      sum.fwd += b.fwd;
    }
    return {
      gkp: sum.gkp / items.length,
      def: sum.def / items.length,
      mid: sum.mid / items.length,
      fwd: sum.fwd / items.length,
    };
  }

  function bucketDiff(a: PosBuckets | null, b: PosBuckets | null) {
    if (!a || !b) return null;
    return { gkp: a.gkp - b.gkp, def: a.def - b.def, mid: a.mid - b.mid, fwd: a.fwd - b.fwd };
  }

  const userByPosList = pointsByGameweek
    .map((r) => r.user.byPosition)
    .filter((x): x is PosBuckets => x != null);
  const baseByPosList = pointsByGameweek
    .map((r) => r.baseline.byPosition)
    .filter((x): x is PosBuckets => x != null);

  const userXIList = pointsByGameweek
    .map((r) => r.user.xi)
    .filter((x): x is PosBuckets => x != null);
  const baseXIList = pointsByGameweek
    .map((r) => r.baseline.xi)
    .filter((x): x is PosBuckets => x != null);

  const avgUserByPosition = bucketAvg(userByPosList);
  const avgBaselineByPosition = bucketAvg(baseByPosList);
  const byPositionDiff = bucketDiff(avgUserByPosition, avgBaselineByPosition);

  const avgUserXI = bucketAvg(userXIList);
  const avgBaselineXI = bucketAvg(baseXIList);
  const xiDiff = bucketDiff(avgUserXI, avgBaselineXI);

  const computedThroughGameweekId = entryGws[entryGws.length - 1]!.gameweekId;

  const avgSuccessRate5Plus =
    baselineReturnsUsedGameweeks > 0
      ? baselineExpectedReturns5Plus / baselineReturnsUsedGameweeks
      : null;
  const returns5PlusDiff =
    baselineReturnsUsedGameweeks > 0 ? returns5Plus - baselineExpectedReturns5Plus : null;
  const expectedReturns5Plus =
    baselineReturnsUsedGameweeks > 0 ? baselineExpectedReturns5Plus : null;

  // Top 3 captains (best captain pick per GW)
  const topCandidatesSorted = topCandidates.sort((a, b) => b.points - a.points);
  const top3 = topCandidatesSorted.slice(0, 3);
  const topPlayerIds = Array.from(new Set(top3.map((t) => t.playerId)));
  const topPlayers =
    topPlayerIds.length === 0
      ? []
      : await prisma.player.findMany({
          where: { id: { in: topPlayerIds } },
          select: { id: true, webName: true },
        });
  const nameById = new Map<number, string>();
  for (const p of topPlayers) nameById.set(p.id, p.webName);
  const topCaptains = top3.map((t) => ({
    playerId: t.playerId,
    playerName: nameById.get(t.playerId) ?? null,
    gameweekId: t.gameweekId,
    points: t.points,
  }));

  // --- CHIPS (API pipeline) ---
  // Hent chip usage fra Eliteserien sitt /history API (ikke fra DB)
  const baseUrl = (process.env.ELITESERIEN_BASE_URL ?? 'https://en.fantasy.eliteserien.no').replace(
    /\/+$/,
    ''
  );

  type HistoryChipRow = { name?: unknown; event?: unknown; time?: unknown };

  async function fetchJson<T>(url: string): Promise<T> {
    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'esf-api/entry-insights',
      },
    });

    if (!res.ok) {
      throw new Error(`fetch failed ${res.status} for ${url}`);
    }

    // Node/undici håndterer gzip automatisk
    return (await res.json()) as T;
  }

  async function getPlayerPointsCached(playerId: number, gwId: number): Promise<number> {
    const k = key(playerId, gwId);
    const cached = pointsMap.get(k);
    if (typeof cached === 'number') return cached;

    const row = await prisma.playerGameweekStats.findUnique({
      where: { playerId_gameweekId: { playerId, gameweekId: gwId } },
      select: { totalPoints: true },
    });

    const pts = row?.totalPoints ?? 0;
    pointsMap.set(k, pts);
    return pts;
  }

  // 1) Hent chips fra history
  let historyChips: HistoryChipRow[] = [];
  try {
    const hist = await fetchJson<{ chips?: unknown }>(`${baseUrl}/api/entry/${entryId}/history/`);
    historyChips = Array.isArray(hist?.chips) ? (hist.chips as HistoryChipRow[]) : [];
  } catch {
    historyChips = [];
  }

  // known keys (inkl wildcard1/2)
  const knownChipKeys = new Set<string>(['wildcard1', 'wildcard2', '2capt', 'frush', 'rich']);

  const chipsUsed: Record<string, Array<{ gameweekId: number; points?: number }>> = {};
  const usedGws2capt = new Set<number>();
  const usedGwsFrush = new Set<number>();

  for (const r of historyChips) {
    const rawName = typeof r?.name === 'string' ? r.name : '';
    const gwId = typeof r?.event === 'number' ? r.event : Number(r?.event);

    if (!Number.isFinite(gwId) || gwId <= 0) continue;
    if (gwId > computedThroughGameweekId) continue;

    const chipKey = normalizeChipName(rawName, gwId);
    knownChipKeys.add(chipKey);

    if (!chipsUsed[chipKey]) chipsUsed[chipKey] = [];
    chipsUsed[chipKey].push({ gameweekId: gwId });

    if (chipKey === '2capt') usedGws2capt.add(gwId);
    if (chipKey === 'frush') usedGwsFrush.add(gwId);
  }

  // 2) Beregn points for chips som trenger det ved å bruke picks-endpoint
  const pointsByChip: {
    '2capt': Array<{ gameweekId: number; points: number }>;
    frush: Array<{ gameweekId: number; points: number }>;
  } = { '2capt': [], frush: [] };

  // 2capt: cap + vice (vanlige points, ingen dobling)
  for (const gwId of Array.from(usedGws2capt).sort((a, b) => a - b)) {
    try {
      const picksJson = await fetchJson<{ picks?: unknown }>(
        `${baseUrl}/api/entry/${entryId}/event/${gwId}/picks/`
      );
      const picks = Array.isArray(picksJson?.picks) ? (picksJson.picks as any[]) : [];

      const cap = picks.find((p) => p?.is_captain === true) ?? null;
      const vice = picks.find((p) => p?.is_vice_captain === true) ?? null;

      const capId = cap ? Number(cap.element) : null;
      const viceId = vice ? Number(vice.element) : null;

      const capPts =
        capId != null && Number.isFinite(capId) ? await getPlayerPointsCached(capId, gwId) : 0;
      const vicePts =
        viceId != null && Number.isFinite(viceId) ? await getPlayerPointsCached(viceId, gwId) : 0;

      const sum = capPts + vicePts;

      pointsByChip['2capt'].push({ gameweekId: gwId, points: sum });

      const rec = chipsUsed['2capt']?.find((x) => x.gameweekId === gwId);
      if (rec) rec.points = sum;
    } catch {
      // ignorer hvis API ikke svarer / entry mangler picks
    }
  }

  // frush: alle forwards i start-XI (pos 1-11) -> sum vanlige points
  for (const gwId of Array.from(usedGwsFrush).sort((a, b) => a - b)) {
    try {
      const picksJson = await fetchJson<{ picks?: unknown }>(
        `${baseUrl}/api/entry/${entryId}/event/${gwId}/picks/`
      );
      const picks = Array.isArray(picksJson?.picks) ? (picksJson.picks as any[]) : [];

      const xi = picks.filter((p) => Number(p?.position) >= 1 && Number(p?.position) <= 11);

      const forwards = xi.filter((p) => {
        // picks-endpoint har element_type (jf smoke test)
        const et = Number(p?.element_type);
        if (Number.isFinite(et)) return et === 4;

        // fallback til DB (shouldn't normally happen)
        const pid = Number(p?.element);
        const posId = positionByPlayerId.get(pid) ?? -1;
        return posId === 4;
      });

      let sum = 0;
      for (const p of forwards) {
        const pid = Number(p?.element);
        if (!Number.isFinite(pid)) continue;
        sum += await getPlayerPointsCached(pid, gwId);
      }

      pointsByChip.frush.push({ gameweekId: gwId, points: sum });

      const rec = chipsUsed.frush?.find((x) => x.gameweekId === gwId);
      if (rec) rec.points = sum;
    } catch {
      // ignorer hvis API ikke svarer / entry mangler picks
    }
  }

  const notUsed = Array.from(knownChipKeys).filter(
    (k) => !chipsUsed[k] || chipsUsed[k].length === 0
  );

  const chips = {
    used: chipsUsed,
    notUsed,
    pointsByChip,
  };

  const data = {
    captain: {
      threshold,
      returns5Plus,
      usedGameweeks,
      missingPointsGameweeks,
      missingCaptainGameweeks: 0,
      totalFinishedGameweeksWithPicks: entryGws.length,
      assumedZeroCaptainPlayers,
      assumedZeroCaptainGameweeks,
      baseline: {
        expectedReturns5Plus: expectedReturns5Plus,
        avgSuccessRate5Plus: avgSuccessRate5Plus,
        usedGameweeks: baselineReturnsUsedGameweeks,
        missingGameweeks: baselineReturnsMissingGameweeks,
      },
      diff: {
        returns5Plus: returns5PlusDiff,
      },
      topCaptains,
    },
    risk: {
      byGameweek: riskByGameweek,
      summary: {
        avgCaptainShare,
        avgBaselineCaptainEO,
        captainShareDiff,

        avgTeamEO,
        avgBaselineTeamEO,
        teamEODiff,

        avgUserTransferCost,
        avgBaselineTransferCost,
        transferCostDiff,
        userHitRate,
        baselineHitRate,

        usedGameweeks: riskByGameweek.length,
      },
    },
    points: {
      byGameweek: pointsByGameweek,
      summary: {
        avgUserCaptainPoints,
        avgBaselineCaptainPoints,
        captainPointsDiff,

        avgUserByPosition,
        avgBaselineByPosition,
        byPositionDiff,

        avgUserXI,
        avgBaselineXI,
        xiDiff,

        usedGameweeks: pointsByGameweek.length,
      },
    },
    chips,
  };

  await prisma.entryInsights.upsert({
    where: { entryId },
    create: { entryId, computedThroughGameweekId, version: 3, data },
    update: { entryId, computedThroughGameweekId, version: 3, data, computedAt: new Date() },
  });

  return data;
}
