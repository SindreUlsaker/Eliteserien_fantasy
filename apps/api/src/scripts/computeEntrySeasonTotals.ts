// apps/api/src/scripts/computeEntrySeasonTotals.ts
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

type StandingsRow = { rank: number; entry: number };
type StandingsResponse = {
  standings: { has_next: boolean; page: number; results: StandingsRow[] };
};

type PicksResponse = {
  picks: Array<{
    element: number; // playerId
    position: number; // 1-15 inkludert benk
    multiplier: number;
    is_captain: boolean;
    is_vice_captain?: boolean;
    element_type: number;
  }>;
};

type EntryHistoryResponse = {
  current: Array<{
    event: number;
    event_transfers_cost?: number | null;
  }>;
  chips?: Array<{
    name?: string;
    time?: string;
    event?: number;
  }>;
};

type CaptainPerf = { gw: number; playerId: number; points: number };

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function jitter(ms: number) {
  const delta = ms * 0.25;
  return ms + (Math.random() * 2 - 1) * delta;
}

// Global rate limiter: minst X ms mellom requests, delt på tvers av alle workers.
function createGlobalRateLimiter(minIntervalMs: number) {
  let nextAllowed = Date.now();

  return async function waitTurn() {
    if (minIntervalMs <= 0) return;

    const now = Date.now();
    const scheduled = Math.max(now, nextAllowed);
    nextAllowed = scheduled + minIntervalMs;

    const waitMs = scheduled - now;
    if (waitMs > 0) await sleep(waitMs);
  };
}

async function fetchJsonWithRetry<T>(
  url: string,
  opts: { waitTurn: () => Promise<void>; maxAttempts: number }
): Promise<T> {
  const { waitTurn, maxAttempts } = opts;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await waitTurn();

    const res = await fetch(url, {
      headers: {
        'User-Agent': 'eliteserien-api/computeEntrySeasonTotals',
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
    const delayMs = Math.round(jitter(Math.min(baseDelay, 20_000)));

    console.warn(`Retry ${attempt}/${maxAttempts} after ${delayMs}ms: ${url} (HTTP ${res.status})`);
    await sleep(delayMs);
  }

  throw new Error(`Failed after retries: ${url}`);
}

function elementTypeKey(elementType: number) {
  if (elementType === 1) return 'gkp';
  if (elementType === 2) return 'def';
  if (elementType === 3) return 'mid';
  if (elementType === 4) return 'fwd';
  return 'unk';
}

function normalizeChipName(name: string, chipGw: number) {
  const raw = name.toLowerCase();
  if (raw === 'wildcard') return chipGw <= 15 ? 'wildcard1' : 'wildcard2';
  return raw;
}

/** Maps API chip name to our 2capt/frush/pdbus keys for point computation. */
function chipNameForPoints(normalized: string): '2capt' | 'frush' | 'pdbus' | null {
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
  if (k === 'pdbus' || k === 'parker bussen' || k === 'parker_bussen') return 'pdbus';
  return null;
}

function parseTop3Json(v: unknown): CaptainPerf[] {
  if (!Array.isArray(v)) return [];
  const out: CaptainPerf[] = [];
  for (const x of v) {
    const gw = (x as any)?.gw;
    const playerId = (x as any)?.playerId;
    const points = (x as any)?.points;
    if (typeof gw === 'number' && typeof playerId === 'number' && typeof points === 'number') {
      out.push({ gw, playerId, points });
    }
  }
  return out;
}

function mergeTop3(existing: CaptainPerf[], add: CaptainPerf[]): CaptainPerf[] {
  const merged = [...existing, ...add];

  // dedupe same gw (hvis rerun). Vi lar “best points” vinne per gw.
  merged.sort((a, b) => b.points - a.points || a.gw - b.gw);
  return merged.slice(0, 3);
}

async function fetchTopEntries(
  baseUrl: string,
  leagueId: number,
  maxRank: number,
  opts: { waitTurn: () => Promise<void>; maxAttempts: number }
): Promise<Array<{ entryId: number; rank: number }>> {
  const out: Array<{ entryId: number; rank: number }> = [];
  let page = 1;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const url = `${baseUrl}/api/leagues-classic/${leagueId}/standings/?page_standings=${page}&phase=1`;
    const data = await fetchJsonWithRetry<StandingsResponse>(url, opts);

    const results = data.standings?.results ?? [];
    if (results.length === 0) break;

    for (const r of results) {
      if (typeof r.rank !== 'number' || typeof r.entry !== 'number') continue;
      if (r.rank <= maxRank) out.push({ entryId: r.entry, rank: r.rank });
    }

    const hasNext = Boolean(data.standings?.has_next);
    const lastRank = results[results.length - 1]?.rank;

    console.log(
      `Standings page ${page}: rows=${results.length} collected=${out.length} has_next=${hasNext}`
    );

    if (!hasNext) break;
    if (typeof lastRank === 'number' && lastRank >= maxRank) break;

    page += 1;
  }

  out.sort((a, b) => a.rank - b.rank);

  const seen = new Set<number>();
  const deduped: Array<{ entryId: number; rank: number }> = [];
  for (const x of out) {
    if (seen.has(x.entryId)) continue;
    seen.add(x.entryId);
    deduped.push(x);
  }

  return deduped;
}

async function main() {
  const BASE_URL = process.env.ESF_BASE_URL ?? 'https://en.fantasy.eliteserien.no';
  const OVERALL_LEAGUE_ID = Number(process.env.OVERALL_LEAGUE_ID);
  if (!Number.isFinite(OVERALL_LEAGUE_ID) || OVERALL_LEAGUE_ID <= 0) {
    throw new Error('Missing/invalid env OVERALL_LEAGUE_ID');
  }

  const maxRank = Number(process.env.SEASON_TOTALS_MAX_RANK ?? 10000);
  const concurrency = Number(process.env.SEASON_TOTALS_CONCURRENCY ?? 6);
  const minIntervalMs = Number(process.env.SEASON_TOTALS_MIN_INTERVAL_MS ?? 60);
  const maxAttempts = Number(process.env.SEASON_TOTALS_MAX_ATTEMPTS ?? 5);

  // CHIPS_ONLY: kun history -> ChipUsage (ingen picks/totals)
  const chipsOnly =
    (process.env.CHIPS_ONLY ?? '').toLowerCase() === '1' ||
    (process.env.CHIPS_ONLY ?? '').toLowerCase() === 'true' ||
    (process.env.CHIPS_ONLY ?? '').toLowerCase() === 'yes';

  const waitTurn = createGlobalRateLimiter(minIntervalMs);
  const fetchOpts = { waitTurn, maxAttempts };

  // computedThroughGw: arg eller siste finished GW
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
          if (!lastFinished)
            throw new Error('No finished gameweeks in DB. Run data:sync-gameweeks.');
          return lastFinished.id;
        })();

  const finishedGws = await prisma.gameweek.findMany({
    where: { finished: true, id: { lte: computedThroughGw } },
    orderBy: { id: 'asc' },
    select: { id: true },
  });
  const finishedGwIds = finishedGws.map((g) => g.id);
  if (finishedGwIds.length === 0) throw new Error('No finished gameweeks <= computedThroughGw');

  console.log(
    `computeEntrySeasonTotals: computedThroughGw=${computedThroughGw} finishedGwCount=${finishedGwIds.length} maxRank=${maxRank} concurrency=${concurrency} minIntervalMs=${minIntervalMs} chipsOnly=${chipsOnly}`
  );

  // Only needed when not chipsOnly
  const pts = new Map<string, number>();
  const eoByGwAndPlayer = new Map<
    number,
    Map<number, { eo: number; sampleSize: number; captainCount: number | null }>
  >();

  if (!chipsOnly) {
    const pgs = await prisma.playerGameweekStats.findMany({
      where: { gameweekId: { lte: computedThroughGw } },
      select: { gameweekId: true, playerId: true, totalPoints: true },
    });
    for (const s of pgs) pts.set(`${s.gameweekId}:${s.playerId}`, s.totalPoints);
    console.log(`Loaded PlayerGameweekStats rows=${pgs.length}`);

    const eoRows = await prisma.effectiveOwnership.findMany({
      where: { gameweekId: { in: finishedGwIds } },
      select: { gameweekId: true, playerId: true, eo: true, sampleSize: true, captainCount: true },
    });
    for (const r of eoRows) {
      let m = eoByGwAndPlayer.get(r.gameweekId);
      if (!m) {
        m = new Map();
        eoByGwAndPlayer.set(r.gameweekId, m);
      }
      m.set(r.playerId, {
        eo: r.eo,
        sampleSize: r.sampleSize,
        captainCount: r.captainCount ?? null,
      });
    }
    console.log(`Loaded EffectiveOwnership rows=${eoRows.length} for ${finishedGwIds.length} GWs`);
  }

  console.log(`Fetching standings up to rank ${maxRank}...`);
  const peers = await fetchTopEntries(BASE_URL, OVERALL_LEAGUE_ID, maxRank, fetchOpts);
  console.log(`Peers fetched: ${peers.length}`);

  let updated = 0;
  let upToDate = 0;
  let failed = 0;
  let chipsInserted = 0;

  let nextIdx = 0;

  async function worker(workerId: number) {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const idx = nextIdx++;
      if (idx >= peers.length) return;

      const entryId = peers[idx].entryId;

      try {
        const existing = chipsOnly
          ? null
          : await prisma.entrySeasonTotals.findUnique({
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

        const lastUpdatedGw = existing?.lastUpdatedGw ?? 0;

        if (!chipsOnly && lastUpdatedGw >= computedThroughGw) {
          upToDate += 1;
          if ((idx + 1) % 500 === 0) {
            console.log(
              `Progress ${idx + 1}/${peers.length}: upToDate=${upToDate} updated=${updated} failed=${failed} chipsInserted=${chipsInserted}`
            );
          }
          continue;
        }

        // Entry history once (transfer costs + chips)
        const historyUrl = `${BASE_URL}/api/entry/${entryId}/history/`;
        const history = await fetchJsonWithRetry<EntryHistoryResponse>(historyUrl, fetchOpts);

        const chipsRaw = Array.isArray(history.chips) ? history.chips : [];
        const chipsByGw = new Map<number, string[]>();
        const chipRows: Array<{
          entryId: number;
          gameweekId: number;
          chipName: string;
          usedAt?: Date;
        }> = [];

        for (const ch of chipsRaw) {
          const name = typeof ch?.name === 'string' ? ch.name : null;
          const event =
            typeof ch?.event === 'number' && Number.isFinite(ch.event) ? ch.event : null;
          const time = typeof ch?.time === 'string' ? ch.time : null;

          if (!name || event == null) continue;
          if (event > computedThroughGw) continue;

          const chipName = normalizeChipName(name, event);
          if (!chipsByGw.has(event)) chipsByGw.set(event, []);
          chipsByGw.get(event)!.push(chipName);

          if (!chipsOnly && event <= lastUpdatedGw) continue;

          const usedAt = time ? new Date(time) : undefined;
          chipRows.push({ entryId, gameweekId: event, chipName, usedAt });
        }

        if (chipRows.length > 0) {
          const res = await prisma.chipUsage.createMany({
            data: chipRows.map((r) => ({
              entryId: r.entryId,
              gameweekId: r.gameweekId,
              chipName: r.chipName,
              points: null,
              usedAt: r.usedAt,
            })),
            skipDuplicates: true,
          });
          chipsInserted += res.count ?? 0;
        }

        if (chipsOnly) {
          if ((idx + 1) % 500 === 0) {
            console.log(
              `Progress ${idx + 1}/${peers.length}: chipsOnly ok. failed=${failed} chipsInserted=${chipsInserted} (worker=${workerId})`
            );
          }
          continue;
        }

        // Missing finished GWs for this entry
        const missingGwIds = finishedGwIds.filter((gw) => gw > lastUpdatedGw);
        if (missingGwIds.length === 0) {
          upToDate += 1;
          continue;
        }

        // transfers cost per GW
        const costByGw = new Map<number, number>();
        for (const r of history.current ?? []) {
          if (typeof r.event !== 'number') continue;
          const c = typeof r.event_transfers_cost === 'number' ? r.event_transfers_cost : 0;
          costByGw.set(r.event, c);
        }

        // Start from existing totals
        let gwCount = existing?.gwCount ?? 0;

        let captainPointsTotal = existing?.captainPointsTotal ?? 0;
        let captainSuccess5PlusCount = existing?.captainSuccess5PlusCount ?? 0;
        const existingTop3 = parseTop3Json(existing?.captainTop3Json);
        const newTopCandidates: CaptainPerf[] = [];

        let xiGkp = existing?.xiGkpPointsTotal ?? 0;
        let xiDef = existing?.xiDefPointsTotal ?? 0;
        let xiMid = existing?.xiMidPointsTotal ?? 0;
        let xiFwd = existing?.xiFwdPointsTotal ?? 0;

        let xiGkpCountTotal = existing?.xiGkpCountTotal ?? 0;
        let xiDefCountTotal = existing?.xiDefCountTotal ?? 0;
        let xiMidCountTotal = existing?.xiMidCountTotal ?? 0;
        let xiFwdCountTotal = existing?.xiFwdCountTotal ?? 0;

        let teamEOTotal = existing?.teamEOTotal ?? 0;
        let teamEOCount = existing?.teamEOCount ?? 0;

        let captainEOTotal = existing?.captainEOTotal ?? 0;
        let captainEOCount = existing?.captainEOCount ?? 0;

        let captainShareTotal = existing?.captainShareTotal ?? 0;
        let captainShareCount = existing?.captainShareCount ?? 0;

        let transferCostTotal = existing?.transferCostTotal ?? 0;
        let hitCount = existing?.hitCount ?? 0;

        let lastSuccessfulGw = lastUpdatedGw;

        for (const gw of missingGwIds) {
          const picksUrl = `${BASE_URL}/api/entry/${entryId}/event/${gw}/picks/`;
          const data = await fetchJsonWithRetry<PicksResponse>(picksUrl, fetchOpts);
          const picks = Array.isArray(data.picks) ? data.picks : [];

          {
            const eoByPlayer = eoByGwAndPlayer.get(gw) ?? new Map();

            // captainEO + captainShare
            // Finne alle kapteiner (ved chips kan det være flere)
            const captains = picks.filter((p) => p.is_captain || (p.multiplier ?? 1) > 1);
            if (captains.length > 0) {
              let captainEOSum = 0;
              let captainEOValidCount = 0;

              for (const cap of captains) {
                const capEO = eoByPlayer.get(cap.element);
                if (capEO) {
                  captainEOSum += capEO.eo;
                  captainEOValidCount += 1;

                  if (capEO.captainCount != null && capEO.sampleSize > 0) {
                    captainShareTotal += capEO.captainCount / capEO.sampleSize;
                    captainShareCount += 1;
                  }
                }
              }

              if (captainEOValidCount > 0) {
                captainEOTotal += captainEOSum / captainEOValidCount; // Gjennomsnitt
                captainEOCount += 1;
              }
            }

            // teamEO
            let teamEOThisGw = 0;
            let ok = true;

            for (const p of picks) {
              const m = Number.isFinite(p.multiplier) ? p.multiplier : 1;
              if (m <= 0) continue; // benk -> 0

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
          }

          // Chip points (2capt, frush) – update ChipUsage.points
          const chipsUsedThisGw = chipsByGw.get(gw) ?? [];
          for (const chipName of chipsUsedThisGw) {
            const pointsChip = chipNameForPoints(chipName);
            if (!pointsChip) continue;

            let chipPoints: number;
            if (pointsChip === '2capt') {
              const cap = picks.find((p) => p.is_captain);
              const vice = picks.find((p) => p.is_vice_captain);
              const capPts = cap ? (pts.get(`${gw}:${cap.element}`) ?? 0) : 0;
              const vicePts = vice ? (pts.get(`${gw}:${vice.element}`) ?? 0) : 0;
              chipPoints = capPts + vicePts;
            } else if (pointsChip === 'frush') {
              const xi = picks.filter((p) => p.position >= 1 && p.position <= 11);
              const forwards = xi.filter((p) => elementTypeKey(p.element_type) === 'fwd');
              chipPoints = forwards.reduce(
                (sum, p) => sum + (pts.get(`${gw}:${p.element}`) ?? 0),
                0
              );
            } else {
              const xi = picks.filter((p) => p.position >= 1 && p.position <= 11);
              const defenders = xi.filter((p) => elementTypeKey(p.element_type) === 'def');
              chipPoints = defenders.reduce(
                (sum, p) => sum + (pts.get(`${gw}:${p.element}`) ?? 0),
                0
              );
            }

            await prisma.chipUsage.updateMany({
              where: { entryId, gameweekId: gw, chipName },
              data: { points: chipPoints },
            });
          }

          // transfers cost (hits)
          const cost = costByGw.get(gw) ?? 0;
          transferCostTotal += cost;
          if (cost > 0) hitCount += 1;

          // Captain points: BASE poeng (ikke doblet). Ved 2capt/spissrush: flere kapteiner per GW.
          const capPicks = picks.filter((p) => p.is_captain || p.multiplier > 1);
          let captainPointsSum = 0;
          for (const p of capPicks) {
            const basePts = pts.get(`${gw}:${p.element}`) ?? 0;
            captainPointsSum += basePts;
            newTopCandidates.push({ gw, playerId: p.element, points: basePts });
          }
          captainPointsTotal += captainPointsSum;
          if (captainPointsSum >= 5) captainSuccess5PlusCount += 1;

          // Formation counts (starting XI)
          let gkpC = 0;
          let defC = 0;
          let midC = 0;
          let fwdC = 0;

          // Starting XI points by position: BASE poeng (ikke kaptein-dobling)
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

        const captainTop3Json = mergeTop3(existingTop3, newTopCandidates);

        await prisma.entrySeasonTotals.upsert({
          where: { entryId },
          update: {
            lastUpdatedGw: lastSuccessfulGw,
            gwCount,

            captainPointsTotal,
            captainSuccess5PlusCount,
            captainTop3Json,

            xiGkpPointsTotal: xiGkp,
            xiDefPointsTotal: xiDef,
            xiMidPointsTotal: xiMid,
            xiFwdPointsTotal: xiFwd,

            xiGkpCountTotal,
            xiDefCountTotal,
            xiMidCountTotal,
            xiFwdCountTotal,

            teamEOTotal,
            teamEOCount,
            captainEOTotal,
            captainEOCount,
            captainShareTotal,
            captainShareCount,

            transferCostTotal,
            hitCount,
          },
          create: {
            entryId,
            lastUpdatedGw: lastSuccessfulGw,
            gwCount,

            captainPointsTotal,
            captainSuccess5PlusCount,
            captainTop3Json,

            xiGkpPointsTotal: xiGkp,
            xiDefPointsTotal: xiDef,
            xiMidPointsTotal: xiMid,
            xiFwdPointsTotal: xiFwd,

            teamEOTotal,
            teamEOCount,
            captainEOTotal,
            captainEOCount,
            captainShareTotal,
            captainShareCount,

            xiGkpCountTotal,
            xiDefCountTotal,
            xiMidCountTotal,
            xiFwdCountTotal,

            transferCostTotal,
            hitCount,
          },
        });

        updated += 1;

        if ((idx + 1) % 100 === 0) {
          console.log(
            `Progress ${idx + 1}/${peers.length}: updated=${updated} upToDate=${upToDate} failed=${failed} chipsInserted=${chipsInserted} (worker=${workerId})`
          );
        }
      } catch (e) {
        failed += 1;
        console.warn(
          `Entry ${entryId} failed: ${e instanceof Error ? e.message : String(e)} (worker=${workerId})`
        );
      }
    }
  }

  const workers = Array.from({ length: Math.max(1, concurrency) }, (_, i) => worker(i + 1));
  await Promise.all(workers);

  console.log(
    `Done computeEntrySeasonTotals. updated=${updated}, upToDate=${upToDate}, failed=${failed}, chipsInserted=${chipsInserted}, chipsOnly=${chipsOnly}`
  );
}

main()
  .then(async () => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
