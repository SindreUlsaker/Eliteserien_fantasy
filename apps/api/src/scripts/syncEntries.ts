import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

type StandingsRow = {
  entry: number;
  entry_name: string;
  player_name: string;
  rank: number;
  total: number;
};

type StandingsResponse = {
  standings: {
    has_next: boolean;
    page: number;
    results: StandingsRow[];
  };
  league?: { id: number };
};

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

function getRequiredNumberEnv(key: string): number {
  const raw = process.env[key];
  const n = Number(raw);
  if (!raw || !Number.isFinite(n)) {
    throw new Error(`Missing/invalid env ${key}. Got: ${raw}`);
  }
  return n;
}

async function main() {
  const BASE_URL = process.env.ESF_BASE_URL ?? 'https://en.fantasy.eliteserien.no';
  const OVERALL_LEAGUE_ID = getRequiredNumberEnv('OVERALL_LEAGUE_ID');

  const pageDelayMs = Number(process.env.ENTRY_SYNC_PAGE_DELAY_MS ?? '100'); // liten pause per page
  const upsertChunkSize = Number(process.env.ENTRY_SYNC_CHUNK_SIZE ?? '500');

  console.log(`syncEntries starting: base=${BASE_URL}, league=${OVERALL_LEAGUE_ID}`);

  let page = 1;
  let totalUpserted = 0;

  for (;;) {
    const url = `${BASE_URL}/api/leagues-classic/${OVERALL_LEAGUE_ID}/standings/?page_standings=${page}&phase=1`;

    const data = await fetchJsonWithRetry<StandingsResponse>(url, {
      headers: {
        'User-Agent': 'eliteserien-api/syncEntries',
        Accept: 'application/json',
      },
    });

    const rows = data.standings?.results ?? [];
    const hasNext = Boolean(data.standings?.has_next);

    if (rows.length === 0) {
      console.log(`Page ${page}: 0 rows. Stopping.`);
      break;
    }

    // upsert i chunks for å unngå enorme transactions
    for (let i = 0; i < rows.length; i += upsertChunkSize) {
      const chunk = rows.slice(i, i + upsertChunkSize);

      await prisma.$transaction(
        chunk.map((r) =>
          prisma.entry.upsert({
            where: { id: r.entry },
            create: {
              id: r.entry,
              entryName: r.entry_name,
              playerName: r.player_name,
              lastOverallRank: r.rank,
              lastOverallTotal: r.total,
              sourceLeagueId: OVERALL_LEAGUE_ID,
            },
            update: {
              entryName: r.entry_name,
              playerName: r.player_name,
              lastOverallRank: r.rank,
              lastOverallTotal: r.total,
              sourceLeagueId: OVERALL_LEAGUE_ID,
            },
          })
        )
      );

      totalUpserted += chunk.length;
    }

    console.log(
      `Page ${page}: rows=${rows.length}, totalUpserted=${totalUpserted}, has_next=${hasNext}`
    );

    if (!hasNext) break;

    page += 1;
    if (pageDelayMs > 0) await sleep(pageDelayMs);
  }

  console.log(`syncEntries done. totalUpserted=${totalUpserted}`);
}

main()
  .catch((e) => {
    console.error('syncEntries failed:', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
