import { PrismaClient } from '@prisma/client';

function key(playerId: number, gameweekId: number) {
  return `${playerId}:${gameweekId}`;
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
    };

    await prisma.entryInsights.upsert({
      where: { entryId },
      create: { entryId, computedThroughGameweekId: 0, version: 1, data: empty },
      update: {
        entryId,
        computedThroughGameweekId: 0,
        version: 1,
        data: empty,
        computedAt: new Date(),
      },
    });

    return empty;
  }

  // hent alle kaptein/vice-kaptein picks
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

  // Beregn en kaptein-score per GW:
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
  };

  await prisma.entryInsights.upsert({
    where: { entryId },
    create: { entryId, computedThroughGameweekId, version: 1, data },
    update: { entryId, computedThroughGameweekId, version: 1, data, computedAt: new Date() },
  });

  return data;
}
