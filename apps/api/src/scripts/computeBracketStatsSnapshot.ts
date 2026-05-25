// apps/api/src/scripts/computeBracketStatsSnapshot.ts
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

type StandingsRow = { rank: number; entry: number };
type StandingsResponse = {
  standings: { has_next: boolean; page: number; results: StandingsRow[] };
};

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'eliteserien-api/computeBracketStatsSnapshot',
      Accept: 'application/json',
    },
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}. Body: ${txt.slice(0, 200)}`);
  }

  return (await res.json()) as T;
}

async function fetchTopEntries(
  baseUrl: string,
  leagueId: number,
  maxRank: number
): Promise<Array<{ entryId: number; rank: number }>> {
  const collected: Array<{ entryId: number; rank: number }> = [];
  let page = 1;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const url = `${baseUrl}/api/leagues-classic/${leagueId}/standings/?page_standings=${page}&phase=1`;
    const data = await fetchJson<StandingsResponse>(url);

    const results = data.standings?.results ?? [];
    if (results.length === 0) break;

    for (const row of results) {
      if (typeof row.rank !== 'number' || typeof row.entry !== 'number') continue;
      if (row.rank <= maxRank) collected.push({ entryId: row.entry, rank: row.rank });
    }

    const lastRankOnPage = results[results.length - 1]?.rank;
    const hasNext = Boolean(data.standings?.has_next);

    console.log(
      `Standings page ${page}: rows=${results.length}, collected=${collected.length}, has_next=${hasNext}`
    );

    if (!hasNext) break;
    if (typeof lastRankOnPage === 'number' && lastRankOnPage >= maxRank) break;

    page += 1;
    await sleep(150);
  }

  collected.sort((a, b) => a.rank - b.rank);

  const seen = new Set<number>();
  const deduped: Array<{ entryId: number; rank: number }> = [];
  for (const r of collected) {
    if (seen.has(r.entryId)) continue;
    seen.add(r.entryId);
    deduped.push(r);
  }
  return deduped;
}

function chipKey(name: string) {
  return name.toLowerCase();
}

function canonicalChipKey(k: string): string {
  const low = k.toLowerCase();
  if (
    low === '2capt' ||
    low === '3xc' ||
    low === 'triple_captain' ||
    low === 'triple captain' ||
    low.includes('kaptein')
  )
    return '2capt';
  if (low === 'frush' || low === 'freehit' || low === 'spissrush') return 'frush';
  if (low === 'rich' || low === 'rik onkel' || low === 'rich_uncle') return 'rich';
  if (low === 'wildcard') return 'wildcard1';
  if (low === 'pdbus' || low === 'parker bussen' || low === 'parker_bussen') return 'pdbus';
  return k;
}

function chipForPoints(chipName: string): '2capt' | 'frush' | 'pdbus' | null {
  const k = chipKey(chipName);
  if (k === '2capt' || k === '3xc' || k === 'triple_captain' || k.includes('kaptein'))
    return '2capt';
  if (k === 'frush' || k === 'freehit' || k === 'spissrush') return 'frush';
  if (k === 'pdbus' || k === 'parker bussen' || k === 'parker_bussen') return 'pdbus';
  return null;
}

async function main() {
  const BASE_URL = process.env.ESF_BASE_URL ?? 'https://en.fantasy.eliteserien.no';
  const OVERALL_LEAGUE_ID = Number(process.env.OVERALL_LEAGUE_ID);
  if (!Number.isFinite(OVERALL_LEAGUE_ID) || OVERALL_LEAGUE_ID <= 0) {
    throw new Error('Missing/invalid env OVERALL_LEAGUE_ID');
  }

  const argGw = process.argv[2];
  const gwArg = argGw ? Number(argGw) : NaN;

  const computedThroughGw =
    Number.isFinite(gwArg) && gwArg > 0
      ? gwArg
      : await (async () => {
          const lastFinished = await prisma.gameweek.findFirst({
            where: { finished: true },
            orderBy: { id: 'desc' },
            select: { id: true },
          });
          if (!lastFinished) throw new Error('No finished gameweeks in DB.');
          return lastFinished.id;
        })();

  console.log(`computeBracketStatsSnapshot: computedThroughGw=${computedThroughGw}`);

  const brackets = await prisma.bracket.findMany({
    where: { active: true },
    orderBy: { rankFrom: 'asc' },
  });
  if (brackets.length === 0) throw new Error('No brackets found. Run db:seed:brackets.');

  // Fetch peers NOW (top 10k)
  const maxRank = 10000;
  console.log(`Fetching standings up to rank ${maxRank}...`);
  const peers = await fetchTopEntries(BASE_URL, OVERALL_LEAGUE_ID, maxRank);

  const bracketToEntryIds = new Map<number, number[]>();
  for (const b of brackets) bracketToEntryIds.set(b.id, []);

  for (const p of peers) {
    const b = brackets.find((x) => p.rank >= x.rankFrom && p.rank <= x.rankTo);
    if (!b) continue;
    bracketToEntryIds.get(b.id)!.push(p.entryId);
  }

  console.log(
    `Standings fetched. peers=${peers.length}. ` +
      brackets.map((b) => `${b.name}:${bracketToEntryIds.get(b.id)!.length}`).join(' ')
  );

  async function computeChipStats(entryIds: number[]) {
    if (entryIds.length === 0) {
      return {
        totalUsed: {},
        usedThisGw: {},
        usedThisGwRate: {},
        points: { avg2captPoints: null, avgFrushPoints: null, avgPdbusPoints: null },
      };
    }

    const chips = await prisma.chipUsage.findMany({
      where: { entryId: { in: entryIds }, gameweekId: { lte: computedThroughGw } },
      select: { entryId: true, gameweekId: true, chipName: true, points: true },
    });

    const totalByChip = new Map<string, Set<number>>();
    const thisGwByChip = new Map<string, Set<number>>();
    let sum2capt = 0;
    let count2capt = 0;
    let sumFrush = 0;
    let countFrush = 0;
    let sumPdbus = 0;
    let countPdbus = 0;

    for (const c of chips) {
      const k = chipKey(c.chipName);
      if (!totalByChip.has(k)) totalByChip.set(k, new Set());
      totalByChip.get(k)!.add(c.entryId);

      if (c.gameweekId === computedThroughGw) {
        if (!thisGwByChip.has(k)) thisGwByChip.set(k, new Set());
        thisGwByChip.get(k)!.add(c.entryId);
      }

      const pointsChip = chipForPoints(c.chipName);
      if (pointsChip && typeof c.points === 'number' && Number.isFinite(c.points)) {
        if (pointsChip === '2capt') {
          sum2capt += c.points;
          count2capt += 1;
        } else if (pointsChip === 'frush') {
          sumFrush += c.points;
          countFrush += 1;
        } else {
          sumPdbus += c.points;
          countPdbus += 1;
        }
      }
    }

    const totalUsed: Record<string, number> = {};
    const usedThisGw: Record<string, number> = {};
    const usedThisGwRate: Record<string, number> = {};

    for (const [k, set] of totalByChip.entries()) {
      const canon = canonicalChipKey(k);
      totalUsed[canon] = Math.max(totalUsed[canon] ?? 0, set.size);
    }
    for (const [k, set] of thisGwByChip.entries()) {
      const canon = canonicalChipKey(k);
      usedThisGw[canon] = Math.max(usedThisGw[canon] ?? 0, set.size);
    }
    for (const k of Object.keys(usedThisGw)) usedThisGwRate[k] = usedThisGw[k] / entryIds.length;

    const points = {
      avg2captPoints: count2capt > 0 ? sum2capt / count2capt : null,
      avgFrushPoints: countFrush > 0 ? sumFrush / countFrush : null,
      avgPdbusPoints: countPdbus > 0 ? sumPdbus / countPdbus : null,
    };

    return { totalUsed, usedThisGw, usedThisGwRate, points };
  }

  for (const bracket of brackets) {
    const entryIds = bracketToEntryIds.get(bracket.id) ?? [];
    if (entryIds.length === 0) {
      console.log(`Bracket ${bracket.name}: no entries, skipping`);
      continue;
    }

    // Load totals for cohort
    const totals = await prisma.entrySeasonTotals.findMany({
      where: { entryId: { in: entryIds } },
      select: {
        entryId: true,
        lastUpdatedGw: true,
        gwCount: true,

        captainPointsTotal: true,
        captainSuccess5PlusCount: true,

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

    const haveTotals = totals.length;
    const upToDate = totals.filter((t) => (t.lastUpdatedGw ?? 0) >= computedThroughGw).length;

    const sumGwCount = totals.reduce((a, t) => a + (t.gwCount ?? 0), 0);

    const sumCapPts = totals.reduce((a, t) => a + (t.captainPointsTotal ?? 0), 0);
    const sumCapSuccess = totals.reduce((a, t) => a + (t.captainSuccess5PlusCount ?? 0), 0);

    const sumGkpPts = totals.reduce((a, t) => a + (t.xiGkpPointsTotal ?? 0), 0);
    const sumDefPts = totals.reduce((a, t) => a + (t.xiDefPointsTotal ?? 0), 0);
    const sumMidPts = totals.reduce((a, t) => a + (t.xiMidPointsTotal ?? 0), 0);
    const sumFwdPts = totals.reduce((a, t) => a + (t.xiFwdPointsTotal ?? 0), 0);

    const sumGkpC = totals.reduce((a, t) => a + (t.xiGkpCountTotal ?? 0), 0);
    const sumDefC = totals.reduce((a, t) => a + (t.xiDefCountTotal ?? 0), 0);
    const sumMidC = totals.reduce((a, t) => a + (t.xiMidCountTotal ?? 0), 0);
    const sumFwdC = totals.reduce((a, t) => a + (t.xiFwdCountTotal ?? 0), 0);

    const sumTransferCost = totals.reduce((a, t) => a + (t.transferCostTotal ?? 0), 0);
    const sumHitCount = totals.reduce((a, t) => a + (t.hitCount ?? 0), 0);

    // EO sums
    const sumTeamEOTotal = totals.reduce((a, t) => a + (t.teamEOTotal ?? 0), 0);
    const sumTeamEOCount = totals.reduce((a, t) => a + (t.teamEOCount ?? 0), 0);

    const sumCaptainEOTotal = totals.reduce((a, t) => a + (t.captainEOTotal ?? 0), 0);
    const sumCaptainEOCount = totals.reduce((a, t) => a + (t.captainEOCount ?? 0), 0);

    const sumCaptainShareTotal = totals.reduce((a, t) => a + (t.captainShareTotal ?? 0), 0);
    const sumCaptainShareCount = totals.reduce((a, t) => a + (t.captainShareCount ?? 0), 0);

    // Averages per GW
    const avgCaptainPoints = sumGwCount > 0 ? sumCapPts / sumGwCount : 0;
    const successRate5Plus = sumGwCount > 0 ? sumCapSuccess / sumGwCount : 0;

    const avgXI = {
      gkp: sumGwCount > 0 ? sumGkpPts / sumGwCount : 0,
      def: sumGwCount > 0 ? sumDefPts / sumGwCount : 0,
      mid: sumGwCount > 0 ? sumMidPts / sumGwCount : 0,
      fwd: sumGwCount > 0 ? sumFwdPts / sumGwCount : 0,
    };

    // Formation composition (avg players in starting XI per pos)
    const xi = {
      gkp: sumGwCount > 0 ? sumGkpC / sumGwCount : 0,
      def: sumGwCount > 0 ? sumDefC / sumGwCount : 0,
      mid: sumGwCount > 0 ? sumMidC / sumGwCount : 0,
      fwd: sumGwCount > 0 ? sumFwdC / sumGwCount : 0,
    };

    const byPosition = avgXI;

    const hitRate = sumGwCount > 0 ? sumHitCount / sumGwCount : 0;
    const avgTransferCost = sumGwCount > 0 ? sumTransferCost / sumGwCount : 0;

    const avgTeamEO = sumTeamEOCount > 0 ? sumTeamEOTotal / sumTeamEOCount : null;
    const avgCaptainEO = sumCaptainEOCount > 0 ? sumCaptainEOTotal / sumCaptainEOCount : null;
    const avgCaptainShare =
      sumCaptainShareCount > 0 ? sumCaptainShareTotal / sumCaptainShareCount : null;

    const chipsResult = await computeChipStats(entryIds);
    const chips = {
      totalUsed: chipsResult.totalUsed,
      usedThisGw: chipsResult.usedThisGw,
      usedThisGwRate: chipsResult.usedThisGwRate,
      points: chipsResult.points,
    };

    const data = {
      points: {
        xi,
        captain: {
          avgCaptainPoints,
          successRate5Plus,
        },
        byPosition,
        avgXI,
        coverage: {
          sampleSize: entryIds.length,
          haveTotals,
          upToDate,
          upToDateRate: entryIds.length > 0 ? upToDate / entryIds.length : 0,
          sumGwCount,
        },
      },
      risk: {
        hitRate,
        avgTransferCost,
        avgTeamEO,
        avgCaptainEO,
        avgCaptainShare,
        coverage: {
          sampleSize: entryIds.length,
          teamEOCount: sumTeamEOCount,
          captainEOCount: sumCaptainEOCount,
          captainShareCount: sumCaptainShareCount,
        },
      },
      chips,
      meta: {
        computedThroughGw,
        eoDefinition: 'template_top1000_per_gw',
        bracketDefinition: 'overall_rank_now_disjoint_intervals',
      },
    };

    await prisma.bracketStats.upsert({
      where: { bracketId: bracket.id },
      update: {
        computedThroughGameweekId: computedThroughGw,
        version: 2,
        sampleSize: entryIds.length,
        data,
        computedAt: new Date(),
      },
      create: {
        bracketId: bracket.id,
        computedThroughGameweekId: computedThroughGw,
        version: 2,
        sampleSize: entryIds.length,
        data,
      },
    });

    console.log(
      `Upserted BracketStats ${bracket.name}: haveTotals=${haveTotals}/${entryIds.length} upToDate=${upToDate}`
    );
  }

  console.log('Done computeBracketStatsSnapshot.');
}

main()
  .then(async () => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
