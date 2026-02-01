import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const BASE_URL = process.env.ESF_BASE_URL ?? 'https://fantasy.eliteserien.no';

const CONCURRENCY = 5; // antall parallelle fetches
const BASE_DELAY_MS = 120; // liten pause mellom requests per worker
const JITTER_MS = 180; // tilfeldig tillegg for å unngå synkronisering
const MAX_RETRIES = 6;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function jitter(ms: number) {
  return Math.floor(Math.random() * ms);
}

async function fetchJsonWithRetry(url: string): Promise<unknown> {
  let attempt = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    attempt += 1;

    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'eliteserien-api/syncPlayerGameweekStats',
          Accept: 'application/json',
        },
      });

      if (res.ok) return res.json();

      // Rate limit / midlertidige feil
      if ((res.status === 429 || res.status >= 500) && attempt <= MAX_RETRIES) {
        const retryAfterHeader = res.headers.get('retry-after');
        const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : NaN;

        // exponential backoff + jitter
        const backoffMs = Math.min(8000, 300 * 2 ** (attempt - 1)) + jitter(400);
        const waitMs =
          Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
            ? retryAfterSeconds * 1000
            : backoffMs;

        await sleep(waitMs);
        continue;
      }

      // Ikke-retrybare feil
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} for ${url}. Body: ${body.slice(0, 200)}`);
    } catch (e) {
      // Nettverksfeil: retry litt
      if (attempt <= MAX_RETRIES) {
        const backoffMs = Math.min(8000, 300 * 2 ** (attempt - 1)) + jitter(400);
        await sleep(backoffMs);
        continue;
      }
      throw e;
    }
  }
}

type HistoryRow = {
  round: number;
  total_points: number;
  minutes: number;
  goals_scored: number;
  assists: number;
  clean_sheets: number;
  goals_conceded: number;
  yellow_cards: number;
  red_cards: number;
  saves: number;
  bonus: number;
};

interface PlayerSummaryResponse {
  history: HistoryRow[];
}

function isFiniteNumber(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

function isHistoryRow(r: unknown): r is HistoryRow {
  if (!r || typeof r !== 'object') return false;
  const obj = r as Record<string, unknown>;
  return (
    isFiniteNumber(obj.round) &&
    isFiniteNumber(obj.total_points) &&
    isFiniteNumber(obj.minutes) &&
    isFiniteNumber(obj.goals_scored) &&
    isFiniteNumber(obj.assists) &&
    isFiniteNumber(obj.clean_sheets) &&
    isFiniteNumber(obj.goals_conceded) &&
    isFiniteNumber(obj.yellow_cards) &&
    isFiniteNumber(obj.red_cards) &&
    isFiniteNumber(obj.saves) &&
    isFiniteNumber(obj.bonus)
  );
}

async function syncOnePlayer(playerId: number, finishedSet: Set<number>) {
  const url = `${BASE_URL}/api/element-summary/${playerId}/`;
  const summary = (await fetchJsonWithRetry(url)) as PlayerSummaryResponse;

  const history = Array.isArray(summary?.history) ? summary.history : [];

  // aggregate per GW (dobbelrunder => sum)
  const agg = new Map<
    number,
    {
      fixtureCount: number;
      totalPoints: number;
      minutes: number;
      goalsScored: number;
      assists: number;
      cleanSheets: number;
      goalsConceded: number;
      yellowCards: number;
      redCards: number;
      saves: number;
      bonus: number;
    }
  >();

  for (const r of history) {
    if (!isHistoryRow(r)) continue;
    const gw = r.round;
    if (!finishedSet.has(gw)) continue;

    const prev = agg.get(gw) ?? {
      fixtureCount: 0,
      totalPoints: 0,
      minutes: 0,
      goalsScored: 0,
      assists: 0,
      cleanSheets: 0,
      goalsConceded: 0,
      yellowCards: 0,
      redCards: 0,
      saves: 0,
      bonus: 0,
    };

    prev.fixtureCount += 1;
    prev.totalPoints += r.total_points;
    prev.minutes += r.minutes;
    prev.goalsScored += r.goals_scored;
    prev.assists += r.assists;
    prev.cleanSheets += r.clean_sheets;
    prev.goalsConceded += r.goals_conceded;
    prev.yellowCards += r.yellow_cards;
    prev.redCards += r.red_cards;
    prev.saves += r.saves;
    prev.bonus += r.bonus;

    agg.set(gw, prev);
  }

  const entries = Array.from(agg.entries());
  if (entries.length === 0) return;

  // Upsert alle GW-rader for spilleren i én transaction
  await prisma.$transaction(async (tx) => {
    for (const [gameweekId, s] of entries) {
      await tx.playerGameweekStats.upsert({
        where: { playerId_gameweekId: { playerId, gameweekId } },
        create: {
          playerId,
          gameweekId,
          fixtureCount: s.fixtureCount,
          totalPoints: s.totalPoints,
          minutes: s.minutes,
          goalsScored: s.goalsScored,
          assists: s.assists,
          cleanSheets: s.cleanSheets,
          goalsConceded: s.goalsConceded,
          yellowCards: s.yellowCards,
          redCards: s.redCards,
          saves: s.saves,
          bonus: s.bonus,
        },
        update: {
          fixtureCount: s.fixtureCount,
          totalPoints: s.totalPoints,
          minutes: s.minutes,
          goalsScored: s.goalsScored,
          assists: s.assists,
          cleanSheets: s.cleanSheets,
          goalsConceded: s.goalsConceded,
          yellowCards: s.yellowCards,
          redCards: s.redCards,
          saves: s.saves,
          bonus: s.bonus,
        },
      });
    }
  });
}

async function main() {
  const finishedGws = await prisma.gameweek.findMany({
    where: { finished: true },
    select: { id: true },
    orderBy: { id: 'asc' },
  });
  const finishedSet = new Set(finishedGws.map((g) => g.id));

  if (finishedSet.size === 0) {
    throw new Error('No finished gameweeks in DB. Sync gameweeks first.');
  }

  const players = await prisma.player.findMany({
    select: { id: true },
    orderBy: { id: 'asc' },
  });

  console.log(
    `Syncing PlayerGameweekStats: players=${players.length}, finishedGWs=${finishedSet.size}, concurrency=${CONCURRENCY}`
  );

  let idx = 0;
  let done = 0;

  const workers = Array.from({ length: CONCURRENCY }, async () => {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const i = idx++;
      if (i >= players.length) break;

      const playerId = players[i]!.id;

      try {
        await syncOnePlayer(playerId, finishedSet);
      } catch (e) {
        console.error(`Failed playerId=${playerId}:`, e);
      }

      done += 1;

      // liten pause for å unngå å overbelaste API-et
      await sleep(BASE_DELAY_MS + jitter(JITTER_MS));

      if (done % 50 === 0) {
        console.log(`Progress: ${done}/${players.length}`);
      }
    }
  });

  await Promise.all(workers);

  console.log('Done.');
}

main()
  .catch((e) => {
    console.error('syncPlayerGameweekStats failed:', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
