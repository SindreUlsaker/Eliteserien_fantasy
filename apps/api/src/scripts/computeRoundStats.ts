import { PrismaClient } from '@prisma/client';
import { writeFile } from 'node:fs/promises';

const prisma = new PrismaClient();

type StandingsRow = {
  rank: number;
  entry: number; // entryId (bruker)
};

type StandingsResponse = {
  standings: {
    has_next: boolean;
    page: number;
    results: StandingsRow[];
  };
};

// Viktig: picks-endpointet inneholder entry_history, vi trenger overall_rank for BRACKET per GW
type PicksResponse = {
  picks: Array<{
    element: number; // playerId (fotballspiller)
    element_type?: number; // 1..4 (kommer fra APIet, jf smoke test)
    position: number;
    multiplier: number;
    is_captain: boolean;
    is_vice_captain: boolean;
  }>;
  entry_history?: {
    overall_rank?: number | null;
    points?: number | null;
    total_points?: number | null;
    event_transfers_cost?: number | null;
  };
};

type ChipUsageRow = {
  chipName: string;
  gameweekId: number;
  points: number | null;
};

function getRequiredNumberEnv(key: string): number {
  const raw = process.env[key];
  const n = Number(raw);
  if (!raw || !Number.isFinite(n)) throw new Error(`Missing/invalid env ${key}. Got: ${raw}`);
  return n;
}

function getOptionalNumberEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function getOptionalBooleanEnv(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (!raw) return fallback;
  return raw === '1' || raw.toLowerCase() === 'true' || raw.toLowerCase() === 'yes';
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function jitter(ms: number) {
  const delta = ms * 0.2;
  return ms + (Math.random() * 2 - 1) * delta;
}

async function fetchJsonWithRetry<T>(url: string, init?: RequestInit): Promise<T> {
  const maxAttempts = 5;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(url, init);

    if (res.ok) return (await res.json()) as T;

    const retryable = res.status === 429 || (res.status >= 500 && res.status <= 599);
    const bodyText = await res.text().catch(() => '');

    if (!retryable || attempt === maxAttempts) {
      throw new Error(
        `HTTP ${res.status} (${res.statusText}) for ${url}. Body: ${bodyText.slice(0, 300)}`
      );
    }

    const baseDelay = 600 * Math.pow(2, attempt - 1);
    const delayMs = Math.round(jitter(Math.min(baseDelay, 15_000)));
    console.warn(
      `Retrying (${attempt}/${maxAttempts}) ${url} after ${delayMs}ms (HTTP ${res.status})`
    );
    await sleep(delayMs);
  }

  throw new Error(`Failed to fetch ${url}`);
}

async function asyncPool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, idx: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function runOne() {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const idx = nextIndex++;
      if (idx >= items.length) return;
      results[idx] = await worker(items[idx], idx);
    }
  }

  const workers = Array.from({ length: Math.max(1, concurrency) }, () => runOne());
  await Promise.all(workers);
  return results;
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

    const data = await fetchJsonWithRetry<StandingsResponse>(url, {
      headers: { 'User-Agent': 'eliteserien-api/computeRoundStats', Accept: 'application/json' },
    });

    const results = data.standings?.results ?? [];
    if (results.length === 0) break;

    for (const row of results) {
      if (typeof row.rank !== 'number' || typeof row.entry !== 'number') continue;
      if (row.rank <= maxRank) collected.push({ entryId: row.entry, rank: row.rank });
    }

    const lastRankOnPage = results[results.length - 1]?.rank;
    const hasNext = Boolean(data.standings?.has_next);

    console.log(
      `Standings page ${page}: got ${results.length} rows. collected=${collected.length}. has_next=${hasNext}`
    );

    if (!hasNext) break;
    if (typeof lastRankOnPage === 'number' && lastRankOnPage >= maxRank) break;

    page += 1;
  }

  collected.sort((a, b) => a.rank - b.rank);

  const seen = new Set<number>();
  const deduped: Array<{ entryId: number; rank: number }> = [];
  for (const r of collected) {
    if (seen.has(r.entryId)) continue;
    seen.add(r.entryId);
    deduped.push(r);
  }

  console.log(`Collected ${deduped.length} unique entries up to rank ${maxRank}.`);
  return deduped;
}

/**
 * Nested / non-disjoint:
 * - Top 100 = rank <= 100
 * - Top 500 = rank <= 500
 * En entry kan derfor tilhøre flere brackets samtidig.
 */
function bracketIdsForRank(
  rank: number | null | undefined,
  brackets: Array<{ id: number; rankFrom: number; rankTo: number; name: string }>
): number[] {
  if (rank == null) return [];
  // brackets er sortert på rankTo asc
  return brackets.filter((b) => rank <= b.rankTo).map((b) => b.id);
}

// positionId: 1=GKP, 2=DEF, 3=MID, 4=FWD
function posKey(positionId: number): 'gkp' | 'def' | 'mid' | 'fwd' | 'unknown' {
  if (positionId === 1) return 'gkp';
  if (positionId === 2) return 'def';
  if (positionId === 3) return 'mid';
  if (positionId === 4) return 'fwd';
  return 'unknown';
}

type Agg = {
  sampleSize: number;

  // sums (points) per entry (NOTE: ingen multiplier legges til)
  sumGkp: number;
  sumDef: number;
  sumMid: number;
  sumFwd: number;

  // counts i XI (multiplier>0 brukes kun for å avgjøre XI)
  countGkp: number;
  countDef: number;
  countMid: number;
  countFwd: number;

  // captain points (NOTE: ingen 2x, vi tar raw spillerpoeng)
  sumCaptainPoints: number;

  captainSuccess5PlusCount: number;

  // CHIP points (raw poeng, ingen dobling)
  sum2captPoints: number;
  count2capt: number;
  sumFrushPoints: number;
  countFrush: number;
  missingChipPointsLookups: number;

  // coverage / debug
  missingPointsLookups: number;
  missingOverallRank: number;
  skippedNoBracket: number;
};

async function main() {
  const gwRaw = process.argv[2];
  const gw = Number(gwRaw);
  if (!gwRaw || !Number.isFinite(gw) || gw <= 0) {
    throw new Error(
      `Usage: computeRoundStats <gameweek>. Example: pnpm --filter api compute:round-stats -- 30`
    );
  }

  const BASE_URL = process.env.ESF_BASE_URL ?? 'https://en.fantasy.eliteserien.no';
  const OVERALL_LEAGUE_ID = getRequiredNumberEnv('OVERALL_LEAGUE_ID');
  const MAX_OVERALL_RANK = getOptionalNumberEnv('MAX_OVERALL_RANK', 10_000);

  const concurrency = getOptionalNumberEnv('ROUND_STATS_CONCURRENCY', 4);
  const requestDelayMs = getOptionalNumberEnv('ROUND_STATS_REQUEST_DELAY_MS', 75);

  const doFinalRetryPass = getOptionalBooleanEnv('ROUND_STATS_FINAL_RETRY_PASS', true);
  const finalRetryConcurrency = getOptionalNumberEnv('ROUND_STATS_FINAL_RETRY_CONCURRENCY', 1);
  const finalRetryDelayMs = getOptionalNumberEnv('ROUND_STATS_FINAL_RETRY_DELAY_MS', 250);

  console.log(
    `computeRoundStats starting: gw=${gw}, base=${BASE_URL}, league=${OVERALL_LEAGUE_ID}, maxRank=${MAX_OVERALL_RANK}, concurrency=${concurrency}, requestDelayMs=${requestDelayMs}`
  );

  const gwRow = await prisma.gameweek.findUnique({ where: { id: gw } });
  if (!gwRow) throw new Error(`Gameweek ${gw} not found in DB. Run syncGameweeks first.`);
  if (!gwRow.finished) {
    throw new Error(
      `Gameweek ${gw} is not finished (finished=false). Run this after the round is finished.`
    );
  }

  const brackets = await prisma.bracket.findMany({
    where: { active: true },
    select: { id: true, name: true, rankFrom: true, rankTo: true },
    orderBy: [{ rankTo: 'asc' }],
  });
  if (brackets.length === 0) throw new Error(`No active brackets in DB. Run seedBrackets first.`);

  // PlayerId -> positionId (for lagdel)
  const players = await prisma.player.findMany({ select: { id: true, positionId: true } });
  const positionByPlayerId = new Map<number, number>();
  for (const p of players) positionByPlayerId.set(p.id, p.positionId);

  // Poengkilde: EGEN DB (PlayerGameweekStats) for DENNE GW
  const statsRows = await prisma.playerGameweekStats.findMany({
    where: { gameweekId: gw },
    select: { playerId: true, totalPoints: true },
  });

  const pointsByPlayerId = new Map<number, number>();
  for (const r of statsRows) {
    pointsByPlayerId.set(r.playerId, r.totalPoints);
  }

  if (pointsByPlayerId.size === 0) {
    throw new Error(
      `No PlayerGameweekStats rows found for gw=${gw}. Ensure you have populated PlayerGameweekStats before running computeRoundStats.`
    );
  }

  // CHIP points trenger andre gameweeks -> cache per (gw, player)
  const pointsCache = new Map<string, number>();
  const pointsKey = (playerId: number, gameweekId: number) => `${gameweekId}:${playerId}`;

  async function getPlayerPoints(playerId: number, gameweekId: number): Promise<number> {
    // rask path: current gw map
    if (gameweekId === gw) {
      return pointsByPlayerId.get(playerId) ?? 0;
    }

    const k = pointsKey(playerId, gameweekId);
    const cached = pointsCache.get(k);
    if (cached != null) return cached;

    const row = await prisma.playerGameweekStats.findUnique({
      where: { playerId_gameweekId: { playerId, gameweekId } },
      select: { totalPoints: true },
    });

    const pts = row?.totalPoints ?? 0;
    pointsCache.set(k, pts);
    return pts;
  }

  // Sample: top N entries
  const entries = await fetchTopEntries(BASE_URL, OVERALL_LEAGUE_ID, MAX_OVERALL_RANK);

  const byBracket = new Map<number, Agg>();
  for (const b of brackets) {
    byBracket.set(b.id, {
      sampleSize: 0,
      sumGkp: 0,
      sumDef: 0,
      sumMid: 0,
      sumFwd: 0,
      countGkp: 0,
      countDef: 0,
      countMid: 0,
      countFwd: 0,
      sumCaptainPoints: 0,
      missingPointsLookups: 0,
      missingOverallRank: 0,
      skippedNoBracket: 0,
      captainSuccess5PlusCount: 0,

      sum2captPoints: 0,
      count2capt: 0,
      sumFrushPoints: 0,
      countFrush: 0,
      missingChipPointsLookups: 0,
    });
  }

  const failures: Array<{ entryId: number; rank: number; error: string }> = [];

  async function computeAndPersistChipPoints(opts: {
    entryId: number;
    chipName: '2capt' | 'frush';
    chipGameweekId: number;
  }): Promise<number> {
    const { entryId, chipName, chipGameweekId } = opts;

    // vi gjør ett ekstra delay her for å være litt snille med APIet
    if (requestDelayMs > 0) await sleep(Math.round(requestDelayMs / 2));

    const picksUrl = `${BASE_URL}/api/entry/${entryId}/event/${chipGameweekId}/picks/`;
    const picksData = await fetchJsonWithRetry<PicksResponse>(picksUrl, {
      headers: { 'User-Agent': 'eliteserien-api/computeRoundStats', Accept: 'application/json' },
    });

    const picks = Array.isArray(picksData.picks) ? picksData.picks : [];

    if (chipName === '2capt') {
      const cap = picks.find((p) => p.is_captain === true) ?? null;
      const vice = picks.find((p) => p.is_vice_captain === true) ?? null;

      const capId = cap ? Number(cap.element) : null;
      const viceId = vice ? Number(vice.element) : null;

      const capPts =
        capId != null && Number.isFinite(capId) ? await getPlayerPoints(capId, chipGameweekId) : 0;
      const vicePts =
        viceId != null && Number.isFinite(viceId)
          ? await getPlayerPoints(viceId, chipGameweekId)
          : 0;

      const pts = capPts + vicePts;

      await prisma.chipUsage.updateMany({
        where: { entryId, chipName, gameweekId: chipGameweekId },
        data: { points: pts },
      });

      return pts;
    }

    // frush: sum poeng for ALLE forwards i start-XI (pos 1..11), ingen multiplier/dobling
    const xi = picks.filter((p) => Number(p.position) >= 1 && Number(p.position) <= 11);

    const forwards = xi.filter((p) => {
      const et = typeof p.element_type === 'number' ? p.element_type : null;
      if (et != null) return et === 4;

      const posId = positionByPlayerId.get(p.element) ?? -1;
      return posId === 4;
    });

    let sum = 0;
    for (const p of forwards) {
      const pid = Number(p.element);
      if (!Number.isFinite(pid)) continue;
      sum += await getPlayerPoints(pid, chipGameweekId);
    }

    await prisma.chipUsage.updateMany({
      where: { entryId, chipName, gameweekId: chipGameweekId },
      data: { points: sum },
    });

    return sum;
  }

  async function processEntry(entryId: number, perRequestDelay: number) {
    if (perRequestDelay > 0) await sleep(perRequestDelay);

    const picksUrl = `${BASE_URL}/api/entry/${entryId}/event/${gw}/picks/`;
    const picksData = await fetchJsonWithRetry<PicksResponse>(picksUrl, {
      headers: { 'User-Agent': 'eliteserien-api/computeRoundStats', Accept: 'application/json' },
    });

    const picks = Array.isArray(picksData.picks) ? picksData.picks : [];

    // bracket basert på overall_rank for DENNE GW (ikke league standings rank)
    const overallRankThisGw =
      typeof picksData.entry_history?.overall_rank === 'number' &&
      Number.isFinite(picksData.entry_history.overall_rank)
        ? picksData.entry_history.overall_rank
        : null;

    const memberBracketIds = bracketIdsForRank(overallRankThisGw, brackets);

    if (overallRankThisGw == null || memberBracketIds.length === 0) {
      // Uten rank i denne GW kan vi ikke plassere entry korrekt => vi skipper den helt
      for (const b of brackets) {
        const agg = byBracket.get(b.id)!;
        if (overallRankThisGw == null) agg.missingOverallRank += 1;
        agg.skippedNoBracket += 1;
      }
      return;
    }

    const CAPTAIN_SUCCESS_THRESHOLD = 5;

    // ---- Regn ut entry-bidrag ÉN gang ----

    // Captain points: RAW points (ingen multiplier)
    let capSum = 0;
    {
      const capPicks = picks.filter((p) => p.is_captain === true);
      for (const cp of capPicks) {
        const pts = pointsByPlayerId.get(cp.element);
        capSum += pts ?? 0;
      }
    }

    // Lagdel points + avgXI:
    // - multiplier brukes KUN for å avgjøre om spilleren er i XI (multiplier > 0)
    // - ingen multiplier i poeng
    let missingPointsLookupsThisEntry = 0;

    let sumGkp = 0,
      sumDef = 0,
      sumMid = 0,
      sumFwd = 0;
    let countGkp = 0,
      countDef = 0,
      countMid = 0,
      countFwd = 0;

    for (const pick of picks) {
      const mult = pick.multiplier ?? 0;
      if (mult <= 0) continue; // bench

      const playerId = pick.element;
      const pts = pointsByPlayerId.get(playerId);
      if (pts == null) missingPointsLookupsThisEntry += 1;

      const positionId = positionByPlayerId.get(playerId) ?? -1;
      const k = posKey(positionId);

      const add = pts ?? 0;

      if (k === 'gkp') {
        sumGkp += add;
        countGkp += 1;
      } else if (k === 'def') {
        sumDef += add;
        countDef += 1;
      } else if (k === 'mid') {
        sumMid += add;
        countMid += 1;
      } else if (k === 'fwd') {
        sumFwd += add;
        countFwd += 1;
      }
    }

    // ---- Legg entry-bidrag på alle member brackets (nested) ----
    for (const bid of memberBracketIds) {
      const agg = byBracket.get(bid);
      if (!agg) continue;

      agg.sampleSize += 1;

      agg.sumCaptainPoints += capSum;
      if (capSum >= CAPTAIN_SUCCESS_THRESHOLD) {
        agg.captainSuccess5PlusCount += 1;
      }

      agg.missingPointsLookups += missingPointsLookupsThisEntry;

      agg.sumGkp += sumGkp;
      agg.countGkp += countGkp;
      agg.sumDef += sumDef;
      agg.countDef += countDef;
      agg.sumMid += sumMid;
      agg.countMid += countMid;
      agg.sumFwd += sumFwd;
      agg.countFwd += countFwd;
    }

    // --- CHIP points (2capt + frush) ---
    // Vi slår opp i ChipUsage. Hvis chip finnes og points==NULL, så beregner vi og oppdaterer raden.
    // Vi bruker chipName nøyaktig som ønsket: "2capt" og "frush".
    const chipRows = await prisma.chipUsage.findMany({
      where: {
        entryId,
        chipName: { in: ['2capt', 'frush'] },
        // vi kan ignorere chips brukt i framtidige runder
        gameweekId: { lte: gw },
      },
      select: { chipName: true, gameweekId: true, points: true },
      orderBy: { gameweekId: 'asc' },
    });

    for (const row of chipRows as ChipUsageRow[]) {
      const chipName =
        row.chipName === '2capt' ? '2capt' : row.chipName === 'frush' ? 'frush' : null;
      if (!chipName) continue;

      const chipGw = row.gameweekId;
      let pts = row.points;

      if (pts == null) {
        try {
          pts = await computeAndPersistChipPoints({
            entryId,
            chipName,
            chipGameweekId: chipGw,
          });
        } catch {
          // hvis vi ikke klarer å hente picks/points, så teller vi det som "missing" for coverage
          for (const bid of memberBracketIds) {
            const agg = byBracket.get(bid);
            if (agg) agg.missingChipPointsLookups += 1;
          }
          continue;
        }
      }

      // running totals -> på ALLE member brackets
      for (const bid of memberBracketIds) {
        const agg = byBracket.get(bid);
        if (!agg) continue;

        if (chipName === '2capt') {
          agg.sum2captPoints += pts;
          agg.count2capt += 1;
        } else {
          agg.sumFrushPoints += pts;
          agg.countFrush += 1;
        }
      }
    }
  }

  let processedOk = 0;
  let skipped = 0;

  await asyncPool(entries, concurrency, async (e, idx) => {
    try {
      await processEntry(e.entryId, requestDelayMs);
      processedOk += 1;
    } catch (err) {
      skipped += 1;
      failures.push({
        entryId: e.entryId,
        rank: e.rank,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const done = processedOk + skipped;
    if (done % 200 === 0 || idx === entries.length - 1) {
      console.log(
        `Processed ${done}/${entries.length} entries... ok=${processedOk}, skipped=${skipped}`
      );
    }
  });

  if (doFinalRetryPass && failures.length > 0) {
    console.log(`Final retry pass: attempting ${failures.length} skipped entries...`);
    const retrySet = failures.map((f) => ({ entryId: f.entryId, rank: f.rank }));
    failures.length = 0;

    let retryOk = 0;
    let retrySkipped = 0;

    await asyncPool(retrySet, finalRetryConcurrency, async (e, idx) => {
      try {
        await processEntry(e.entryId, finalRetryDelayMs);
        retryOk += 1;
      } catch (err) {
        retrySkipped += 1;
        failures.push({
          entryId: e.entryId,
          rank: e.rank,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      const done = retryOk + retrySkipped;
      if (done % 50 === 0 || idx === retrySet.length - 1) {
        console.log(
          `Retry pass ${done}/${retrySet.length}... ok=${retryOk}, stillFailed=${retrySkipped}`
        );
      }
    });

    console.log(`Final retry pass done. recovered=${retryOk}, stillFailed=${failures.length}`);
  }

  if (failures.length > 0) {
    const file = `computeRoundStats_failed_gw${gw}.json`;
    await writeFile(file, JSON.stringify(failures, null, 2), 'utf-8');
    console.warn(`Some entries still failed. Wrote ${failures.length} to ${file}`);
  }

  console.log('Finished fetching picks. Writing bracket aggregates to DB...');

  for (const b of brackets) {
    const agg = byBracket.get(b.id)!;
    const computedSampleSize = agg.sampleSize;

    if (computedSampleSize === 0) {
      console.warn(`Bracket ${b.name} has sampleSize=0. Skipping.`);
      continue;
    }

    const avgPerEntry = (x: number) => x / computedSampleSize;

    const points = {
      avgXI: {
        gkp: avgPerEntry(agg.countGkp),
        def: avgPerEntry(agg.countDef),
        mid: avgPerEntry(agg.countMid),
        fwd: avgPerEntry(agg.countFwd),
      },
      captain: {
        avgCaptainPoints: avgPerEntry(agg.sumCaptainPoints),
        successRate5Plus: agg.captainSuccess5PlusCount / computedSampleSize,
      },
      byPosition: {
        gkp: avgPerEntry(agg.sumGkp),
        def: avgPerEntry(agg.sumDef),
        mid: avgPerEntry(agg.sumMid),
        fwd: avgPerEntry(agg.sumFwd),
      },
      coverage: {
        missingPointsLookups: agg.missingPointsLookups,
        missingOverallRank: agg.missingOverallRank,
        skippedNoBracket: agg.skippedNoBracket,
        missingChipPointsLookups: agg.missingChipPointsLookups,
        // vi vil at UI skal bruke "riktig" sampleSize (ikke disjoint),
        // og vi vil ikke at computeRoundStats skal ødelegge sampleSize skrevet av computeEO.
        sampleSize: computedSampleSize,
      },
    };

    // Chips: vi legger inn avg-poeng per chip blant de som faktisk har brukt chippen
    const chipPoints = {
      avg2captPoints: agg.count2capt > 0 ? agg.sum2captPoints / agg.count2capt : null,
      avgFrushPoints: agg.countFrush > 0 ? agg.sumFrushPoints / agg.countFrush : null,
      used2captCount: agg.count2capt,
      usedFrushCount: agg.countFrush,
    };

    const existing = await prisma.bracketGameweekStats.findUnique({
      where: {
        gameweekId_bracketId_version: {
          gameweekId: gw,
          bracketId: b.id,
          version: 1,
        },
      },
      select: { data: true, sampleSize: true },
    });

    const prevData = (existing?.data ?? {}) as Record<string, any>;
    const prevChips = (prevData.chips ?? {}) as Record<string, any>;

    // Ikke overskriv chip-usage counts fra EO-scriptet (totalUsed/usedThisGw/usedThisGwRate)
    const nextData = {
      ...prevData,
      points,
      chips: {
        ...prevChips,
        points: chipPoints,
      },
    };

    const persistedSampleSize = Math.max(existing?.sampleSize ?? 0, computedSampleSize);

    await prisma.bracketGameweekStats.upsert({
      where: {
        gameweekId_bracketId_version: {
          gameweekId: gw,
          bracketId: b.id,
          version: 1,
        },
      },
      create: {
        gameweekId: gw,
        bracketId: b.id,
        version: 1,
        sampleSize: persistedSampleSize,
        data: nextData,
      },
      update: {
        sampleSize: persistedSampleSize,
        data: nextData,
        computedAt: new Date(),
      },
    });

    console.log(
      `Upserted BracketGameweekStats(points+chipPoints) for ${b.name}: sampleSize=${persistedSampleSize} (computed=${computedSampleSize}, existing=${existing?.sampleSize ?? 'null'}), 2captUsed=${agg.count2capt}, frushUsed=${agg.countFrush}`
    );
  }

  console.log('computeRoundStats done.');
}

main()
  .catch((e) => {
    console.error('computeRoundStats failed:', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
