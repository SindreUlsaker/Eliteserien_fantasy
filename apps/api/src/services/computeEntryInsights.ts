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
          // NYTT: hits
          avgUserTransferCost: null,
          avgBaselineTransferCost: null,
          transferCostDiff: null,
          userHitRate: null,
          baselineHitRate: null,
          usedGameweeks: 0,
        },
      },
    };

    await prisma.entryInsights.upsert({
      where: { entryId },
      create: { entryId, computedThroughGameweekId: 0, version: 2, data: empty },
      update: {
        entryId,
        computedThroughGameweekId: 0,
        version: 2,
        data: empty,
        computedAt: new Date(),
      },
    });

    return empty;
  }

  const captainPairs: Array<{ playerId: number; gameweekId: number }> = [];

  for (const gwRow of entryGws) {
    const capPicks = gwRow.picks.filter((p) => p.multiplier > 1);
    for (const p of capPicks) {
      captainPairs.push({ playerId: p.playerId, gameweekId: gwRow.gameweekId });
    }
  }

  const uniquePlayerIds = Array.from(new Set(captainPairs.map((r) => r.playerId)));
  const uniqueGwIds = Array.from(new Set(captainPairs.map((r) => r.gameweekId)));

  const statsRows =
    uniquePlayerIds.length === 0 || uniqueGwIds.length === 0
      ? []
      : await prisma.playerGameweekStats.findMany({
          where: {
            playerId: { in: uniquePlayerIds },
            gameweekId: { in: uniqueGwIds },
          },
          select: { playerId: true, gameweekId: true, totalPoints: true },
        });

  const statsMap = new Map<string, number>();
  for (const r of statsRows) {
    statsMap.set(key(r.playerId, r.gameweekId), r.totalPoints);
  }

  let returns5Plus = 0;
  let usedGameweeks = 0;

  const missingPointsGameweeks = 0;

  let assumedZeroCaptainPlayers = 0;
  let assumedZeroCaptainGameweeks = 0;

  for (const gwRow of entryGws) {
    const capPicks = gwRow.picks.filter((p) => p.multiplier > 1);

    let captainPointsSum = 0;

    if (capPicks.length === 0) {
      assumedZeroCaptainGameweeks += 1;
    } else {
      for (const p of capPicks) {
        const pts = statsMap.get(key(p.playerId, gwRow.gameweekId));
        if (pts == null) {
          assumedZeroCaptainPlayers += 1;
          continue;
        }
        captainPointsSum += pts;
      }
    }

    usedGameweeks += 1;
    if (captainPointsSum >= threshold) returns5Plus += 1;
  }

  const brackets = await prisma.bracket.findMany({
    select: { id: true, rankFrom: true, rankTo: true, active: true },
    orderBy: { rankFrom: 'asc' },
  });

  const byGameweek: Array<{
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

  for (const gwRow of entryGws) {
    const gwId = gwRow.gameweekId;

    // bracket per GW, basert på overallRank
    const bracketId = findBracketIdForRank(gwRow.overallRank, brackets);

    // finn kaptein
    const captainPick =
      gwRow.picks.find((p) => p.isCaptain) ??
      gwRow.picks.filter((p) => p.multiplier > 1).sort((a, b) => b.multiplier - a.multiplier)[0] ??
      null;

    const captainPlayerId = captainPick?.playerId ?? null;

    // baseline fra BracketGameweekStats
    let baselineCaptainEO: number | null = null;
    let baselineTeamEO: number | null = null;

    // hits baseline
    let baselineAvgTransferCost: number | null = null;
    let baselineHitRate: number | null = null;

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
    }

    let userCaptainShare: number | null = null;
    let userTeamEO: number | null = null;

    const userTransferCost =
      typeof gwRow.eventTransfersCost === 'number' ? (gwRow.eventTransfersCost as number) : 0;

    if (bracketId != null) {
      const pickedPlayerIds = gwRow.picks.map((p) => p.playerId);

      // hent EO for alle picks (for teamEO)
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

      // hent captain share for valgt kaptein
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

    byGameweek.push({
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
  }

  const captainShares = byGameweek
    .map((r) => r.userCaptainShare)
    .filter((x): x is number => typeof x === 'number');
  const baselineCapt = byGameweek
    .map((r) => r.baselineCaptainEO)
    .filter((x): x is number => typeof x === 'number');

  const teamEOs = byGameweek
    .map((r) => r.userTeamEO)
    .filter((x): x is number => typeof x === 'number');
  const baselineTeam = byGameweek
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

  // NYTT: hits summary
  const userTransferCosts = byGameweek
    .map((r) => r.userTransferCost)
    .filter((x): x is number => typeof x === 'number');
  const baselineTransferCosts = byGameweek
    .map((r) => r.baselineAvgTransferCost)
    .filter((x): x is number => typeof x === 'number');
  const baselineHitRates = byGameweek
    .map((r) => r.baselineHitRate)
    .filter((x): x is number => typeof x === 'number');

  const avgUserTransferCost = avg(userTransferCosts);
  const avgBaselineTransferCost = avg(baselineTransferCosts);
  const transferCostDiff =
    avgUserTransferCost != null && avgBaselineTransferCost != null
      ? avgUserTransferCost - avgBaselineTransferCost
      : null;

  const userHitRate =
    byGameweek.length === 0
      ? null
      : byGameweek.filter((r) => (r.userTransferCost ?? 0) > 0).length / byGameweek.length;

  const baselineHitRate = avg(baselineHitRates);

  const computedThroughGameweekId = entryGws[entryGws.length - 1]!.gameweekId;

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
    },
    risk: {
      byGameweek,
      summary: {
        avgCaptainShare,
        avgBaselineCaptainEO,
        captainShareDiff,

        avgTeamEO,
        avgBaselineTeamEO,
        teamEODiff,

        // NYTT: hits
        avgUserTransferCost,
        avgBaselineTransferCost,
        transferCostDiff,
        userHitRate,
        baselineHitRate,

        usedGameweeks: byGameweek.length,
      },
    },
  };

  await prisma.entryInsights.upsert({
    where: { entryId },
    create: { entryId, computedThroughGameweekId, version: 2, data },
    update: { entryId, computedThroughGameweekId, version: 2, data, computedAt: new Date() },
  });

  return data;
}
