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

type PicksResponse = {
  picks: Array<{
    element: number; // playerId (fotballspiller)
    position: number;
    multiplier: number;
    is_captain: boolean;
    is_vice_captain: boolean;
  }>;
};

function getRequiredNumberEnv(key: string): number {
  const raw = process.env[key];
  const n = Number(raw);
  if (!raw || !Number.isFinite(n)) {
    throw new Error(`Missing/invalid env ${key}. Got: ${raw}`);
  }
  return n;
}

function getOptionalNumberEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return n;
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

    if (res.ok) {
      return (await res.json()) as T;
    }

    const retryable = res.status === 429 || (res.status >= 500 && res.status <= 599);
    const bodyText = await res.text().catch(() => '');

    if (!retryable || attempt === maxAttempts) {
      throw new Error(
        `HTTP ${res.status} (${res.statusText}) for ${url}. Body: ${bodyText.slice(0, 300)}`
      );
    }

    // Enkel exponential backoff + jitter
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
      headers: {
        'User-Agent': 'eliteserien-api/computeEO',
        Accept: 'application/json',
      },
    });

    const results = data.standings?.results ?? [];
    if (results.length === 0) break;

    for (const row of results) {
      if (typeof row.rank !== 'number' || typeof row.entry !== 'number') continue;
      if (row.rank <= maxRank) {
        collected.push({ entryId: row.entry, rank: row.rank });
      }
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

function bracketsForRank(
  rank: number,
  brackets: Array<{ id: number; rankFrom: number; rankTo: number; name: string }>
) {
  return brackets.filter((b) => rank >= b.rankFrom && rank <= b.rankTo);
}

type Counts = {
  sampleSize: number;
  ownedCount: Map<number, number>;
  captainCount: Map<number, number>;
};

type EntryInfo = { entryId: number; rank: number };

async function main() {
  const gwRaw = process.argv[2];
  const gw = Number(gwRaw);
  if (!gwRaw || !Number.isFinite(gw) || gw <= 0) {
    throw new Error(`Usage: computeEO <gameweek>. Example: pnpm --filter api compute:eo -- 30`);
  }

  const BASE_URL = process.env.ESF_BASE_URL ?? 'https://en.fantasy.eliteserien.no';
  const OVERALL_LEAGUE_ID = getRequiredNumberEnv('OVERALL_LEAGUE_ID');
  const MAX_OVERALL_RANK = getOptionalNumberEnv('MAX_OVERALL_RANK', 10_000);

  // Kan endres om man får rate-limit problemer (lavere concurrency, høyere delay)
  const concurrency = getOptionalNumberEnv('EO_CONCURRENCY', 4);
  const requestDelayMs = getOptionalNumberEnv('EO_REQUEST_DELAY_MS', 75);

  const doFinalRetryPass = getOptionalBooleanEnv('EO_FINAL_RETRY_PASS', true);
  const finalRetryConcurrency = getOptionalNumberEnv('EO_FINAL_RETRY_CONCURRENCY', 1);
  const finalRetryDelayMs = getOptionalNumberEnv('EO_FINAL_RETRY_DELAY_MS', 250);

  console.log(
    `computeEO starting: gw=${gw}, base=${BASE_URL}, league=${OVERALL_LEAGUE_ID}, maxRank=${MAX_OVERALL_RANK}, concurrency=${concurrency}, requestDelayMs=${requestDelayMs}`
  );

  const gwExists = await prisma.gameweek.findUnique({ where: { id: gw } });
  if (!gwExists) {
    throw new Error(`Gameweek ${gw} not found in DB. Run syncGameweeks first.`);
  }

  const brackets = await prisma.bracket.findMany({
    where: { active: true },
    select: { id: true, name: true, rankFrom: true, rankTo: true },
    orderBy: [{ rankTo: 'asc' }],
  });

  if (brackets.length === 0) {
    throw new Error(`No active brackets in DB. Run seedBrackets first.`);
  }

  console.log(
    `Loaded ${brackets.length} active brackets: ${brackets.map((b) => b.name).join(', ')}`
  );

  const entries = await fetchTopEntries(BASE_URL, OVERALL_LEAGUE_ID, MAX_OVERALL_RANK);

  const byBracket = new Map<number, Counts>();
  for (const b of brackets) {
    byBracket.set(b.id, {
      sampleSize: 0,
      ownedCount: new Map(),
      captainCount: new Map(),
    });
  }

  const failures: Array<{ entryId: number; rank: number; error: string }> = [];

  async function processEntry(entry: EntryInfo, perRequestDelay: number) {
    const memberBrackets = bracketsForRank(entry.rank, brackets);
    if (memberBrackets.length === 0) return;

    if (perRequestDelay > 0) await sleep(perRequestDelay);

    const url = `${BASE_URL}/api/entry/${entry.entryId}/event/${gw}/picks/`;
    const data = await fetchJsonWithRetry<PicksResponse>(url, {
      headers: {
        'User-Agent': 'eliteserien-api/computeEO',
        Accept: 'application/json',
      },
    });

    const picks = Array.isArray(data.picks) ? data.picks : [];

    for (const b of memberBrackets) {
      byBracket.get(b.id)!.sampleSize += 1;
    }

    for (const p of picks) {
      const playerId = p.element;
      if (typeof playerId !== 'number') continue;

      for (const b of memberBrackets) {
        const owned = byBracket.get(b.id)!.ownedCount;
        owned.set(playerId, (owned.get(playerId) ?? 0) + 1);

        if (p.is_captain === true) {
          const caps = byBracket.get(b.id)!.captainCount;
          caps.set(playerId, (caps.get(playerId) ?? 0) + 1);
        }
      }
    }
  }

  let processedOk = 0;
  let skipped = 0;

  await asyncPool(entries, concurrency, async (entry, idx) => {
    try {
      await processEntry(entry, requestDelayMs);
      processedOk += 1;
    } catch (e) {
      skipped += 1;
      failures.push({
        entryId: entry.entryId,
        rank: entry.rank,
        error: e instanceof Error ? e.message : String(e),
      });
    }

    const done = processedOk + skipped;
    if (done % 200 === 0 || idx === entries.length - 1) {
      console.log(
        `Processed ${done}/${entries.length} entries... ok=${processedOk}, skipped=${skipped}`
      );
    }
  });

  // Retry-pass på slutten for de som feilet (lav concurrency + litt ekstra delay)
  if (doFinalRetryPass && failures.length > 0) {
    console.log(`Final retry pass: attempting ${failures.length} skipped entries...`);
    const retrySet = failures.map((f) => ({ entryId: f.entryId, rank: f.rank }));
    failures.length = 0;

    let retryOk = 0;
    let retrySkipped = 0;

    await asyncPool(retrySet, finalRetryConcurrency, async (entry, idx) => {
      try {
        await processEntry(entry, finalRetryDelayMs);
        retryOk += 1;
      } catch (e) {
        retrySkipped += 1;
        failures.push({
          entryId: entry.entryId,
          rank: entry.rank,
          error: e instanceof Error ? e.message : String(e),
        });
      }

      const done = retryOk + retrySkipped;
      if (done % 50 === 0 || idx === retrySet.length - 1) {
        console.log(
          `Retry pass progress ${done}/${retrySet.length}... ok=${retryOk}, stillFailed=${retrySkipped}`
        );
      }
    });

    console.log(`Final retry pass done. recovered=${retryOk}, stillFailed=${failures.length}`);
  }

  if (failures.length > 0) {
    const file = `computeEO_failed_gw${gw}.json`;
    await writeFile(file, JSON.stringify(failures, null, 2), 'utf-8');
    console.warn(`Some entries still failed after retries. Wrote ${failures.length} to ${file}`);
  }

  console.log('Finished fetching picks. Writing aggregates to DB...');

  const upsertChunkSize = 500;

  for (const b of brackets) {
    const agg = byBracket.get(b.id)!;
    const sampleSize = agg.sampleSize;

    if (sampleSize === 0) {
      console.warn(`Bracket ${b.name} has sampleSize=0. Skipping.`);
      continue;
    }

    const playerIds = new Set<number>();
    for (const k of agg.ownedCount.keys()) playerIds.add(k);
    for (const k of agg.captainCount.keys()) playerIds.add(k);

    const all = Array.from(playerIds);

    console.log(`Bracket ${b.name}: sampleSize=${sampleSize}, players=${all.length}`);

    for (let i = 0; i < all.length; i += upsertChunkSize) {
      const chunk = all.slice(i, i + upsertChunkSize);

      await prisma.$transaction(
        chunk.map((playerId) => {
          const ownedCount = agg.ownedCount.get(playerId) ?? 0;
          const captainCount = agg.captainCount.get(playerId) ?? 0;
          const eo = (ownedCount + captainCount) / sampleSize;

          return prisma.effectiveOwnership.upsert({
            where: {
              gameweekId_bracketId_playerId: {
                gameweekId: gw,
                bracketId: b.id,
                playerId,
              },
            },
            create: {
              gameweekId: gw,
              bracketId: b.id,
              playerId,
              eo,
              sampleSize,
              ownedCount,
              captainCount,
            },
            update: {
              eo,
              sampleSize,
              ownedCount,
              captainCount,
              computedAt: new Date(),
            },
          });
        })
      );

      console.log(
        `Upserted ${Math.min(i + upsertChunkSize, all.length)}/${all.length} rows for bracket ${b.name}...`
      );
    }
  }

  console.log('computeEO done.');
}

main()
  .catch((e) => {
    console.error('computeEO failed:', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
