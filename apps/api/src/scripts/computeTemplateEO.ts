// apps/api/src/scripts/computeTemplateEO.ts
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

type StandingsRow = {
  rank: number;
  entry: number; // entryId
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
    element: number;
    position: number;
    multiplier: number; // 0..?
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
        'User-Agent': 'eliteserien-api/computeTemplateEO',
        Accept: 'application/json',
      },
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

  // dedupe (kan skje hvis samme entry er i både overall og en subleague)
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

type EntryInfo = { entryId: number; rank: number };

async function main() {
  const gwRaw = process.argv[2];
  const gw = Number(gwRaw);
  if (!gwRaw || !Number.isFinite(gw) || gw <= 0) {
    throw new Error(
      `Usage: computeTemplateEO <gameweek>. Example: pnpm --filter api compute:template-eo 3`
    );
  }

  const BASE_URL = process.env.ESF_BASE_URL ?? 'https://en.fantasy.eliteserien.no';
  const OVERALL_LEAGUE_ID = getRequiredNumberEnv('OVERALL_LEAGUE_ID');

  // Template-size: default 1000
  const TEMPLATE_RANK = getOptionalNumberEnv('TEMPLATE_RANK', 1000);

  // Tuning
  const concurrency = getOptionalNumberEnv('EO_CONCURRENCY', 4);
  const requestDelayMs = getOptionalNumberEnv('EO_REQUEST_DELAY_MS', 75);

  const doFinalRetryPass = getOptionalBooleanEnv('EO_FINAL_RETRY_PASS', true);
  const finalRetryConcurrency = getOptionalNumberEnv('EO_FINAL_RETRY_CONCURRENCY', 1);
  const finalRetryDelayMs = getOptionalNumberEnv('EO_FINAL_RETRY_DELAY_MS', 250);

  console.log(
    `computeTemplateEO starting: gw=${gw}, base=${BASE_URL}, league=${OVERALL_LEAGUE_ID}, templateRank=${TEMPLATE_RANK}, concurrency=${concurrency}, requestDelayMs=${requestDelayMs}`
  );

  const gwExists = await prisma.gameweek.findUnique({ where: { id: gw } });
  if (!gwExists) {
    throw new Error(`Gameweek ${gw} not found in DB. Run data:sync-gameweeks first.`);
  }

  const entries = await fetchTopEntries(BASE_URL, OVERALL_LEAGUE_ID, TEMPLATE_RANK);

  // counts
  const ownedCount = new Map<number, number>(); // base ownership (1 per squad pick)
  const extraCount = new Map<number, number>(); // "effective" ekstra (multiplier-1)
  let okCount = 0;

  const failures: Array<{ entryId: number; rank: number; error: string }> = [];

  async function processEntry(entry: EntryInfo, perRequestDelay: number) {
    try {
      if (perRequestDelay > 0) await sleep(perRequestDelay);

      const url = `${BASE_URL}/api/entry/${entry.entryId}/event/${gw}/picks/`;
      const data = await fetchJsonWithRetry<PicksResponse>(url, {
        headers: {
          'User-Agent': 'eliteserien-api/computeTemplateEO',
          Accept: 'application/json',
        },
      });

      const picks = Array.isArray(data.picks) ? data.picks : [];
      if (picks.length === 0) return;

      okCount += 1;

      for (const p of picks) {
        const playerId = p.element;
        if (typeof playerId !== 'number') continue;

        // base ownership: alle 15 teller
        ownedCount.set(playerId, (ownedCount.get(playerId) ?? 0) + 1);

        // multiplier ved kaptein og chip og lignende.
        const m =
          typeof p.multiplier === 'number' && Number.isFinite(p.multiplier) ? p.multiplier : 1;
        const extra = Math.max(0, Math.floor(m) - 1);
        if (extra > 0) {
          extraCount.set(playerId, (extraCount.get(playerId) ?? 0) + extra);
        }
      }
    } catch (e) {
      failures.push({
        entryId: entry.entryId,
        rank: entry.rank,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  await asyncPool(entries, concurrency, async (e, idx) => {
    await processEntry(e, requestDelayMs);
    if ((idx + 1) % 100 === 0) {
      console.log(
        `Processed ${idx + 1}/${entries.length}. ok=${okCount}, failed=${failures.length}`
      );
    }
  });

  // Final retry pass med lav concurrency for 429/500-type issues
  if (doFinalRetryPass && failures.length > 0) {
    console.log(`Final retry pass for ${failures.length} failed entries...`);
    const toRetry = failures.splice(0, failures.length);

    await asyncPool(toRetry, finalRetryConcurrency, async (f, idx) => {
      try {
        await processEntry({ entryId: f.entryId, rank: f.rank }, finalRetryDelayMs);
      } catch (e) {
        failures.push({
          entryId: f.entryId,
          rank: f.rank,
          error: e instanceof Error ? e.message : String(e),
        });
      }
      if ((idx + 1) % 25 === 0) {
        console.log(
          `Final retry progress ${idx + 1}/${toRetry.length}. ok=${okCount}, failed=${failures.length}`
        );
      }
    });
  }

  const sampleSize = okCount;
  if (sampleSize === 0) throw new Error(`No successful entries processed. Aborting.`);

  console.log(`Done fetching picks. sampleSize=${sampleSize}. uniquePlayers=${ownedCount.size}`);

  // Build rows
  const rows: Array<{
    gameweekId: number;
    playerId: number;
    eo: number;
    sampleSize: number;
    ownedCount: number;
    captainCount: number;
  }> = [];

  for (const [playerId, owned] of ownedCount.entries()) {
    const extra = extraCount.get(playerId) ?? 0;

    // EO = (owned + extra) / sampleSize
    const eo = (owned + extra) / sampleSize;

    rows.push({
      gameweekId: gw,
      playerId,
      eo,
      sampleSize,
      ownedCount: owned,
      captainCount: extra,
    });
  }

  // Replace rows for this gw
  await prisma.$transaction(async (tx) => {
    await tx.effectiveOwnership.deleteMany({ where: { gameweekId: gw } });

    // chunk insert (Postgres + Prisma)
    const chunkSize = 1000;
    for (let i = 0; i < rows.length; i += chunkSize) {
      const chunk = rows.slice(i, i + chunkSize);
      await tx.effectiveOwnership.createMany({ data: chunk });
    }
  });

  console.log(
    `Upserted EffectiveOwnership for gw=${gw}. rows=${rows.length}. sampleSize=${sampleSize}`
  );

  if (failures.length > 0) {
    console.warn(`Failures (${failures.length}) - showing first 10:`);
    for (const f of failures.slice(0, 10)) {
      console.warn(`  rank=${f.rank} entry=${f.entryId} err=${f.error}`);
    }
  }
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
