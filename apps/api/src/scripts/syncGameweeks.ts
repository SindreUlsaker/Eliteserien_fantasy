import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const BASE = process.env.ESF_BASE_URL ?? 'https://en.fantasy.eliteserien.no';

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

async function fetchBootstrap() {
  const url = `${BASE}/api/bootstrap-static/`;

  const res = await fetch(url, {
    headers: {
      'User-Agent': 'eliteserien-api/syncGameweeks',
      Accept: 'application/json',
    },
  });

  if (!res.ok) throw new Error(`HTTP ${res.status} (${res.statusText}) for ${url}`);

  const data: unknown = await res.json();
  if (!isObject(data)) throw new Error(`bootstrap-static returned non-object JSON from ${url}`);
  return data;
}

type BootstrapEvent = {
  id: number;
  name: string;
  deadline_time: string;
  release_time: string | null;
  finished: boolean;
  data_checked: boolean;
};

function parseEvents(data: Record<string, unknown>): BootstrapEvent[] {
  const events = data['events'];
  if (!Array.isArray(events)) throw new Error("bootstrap-static missing 'events' array");

  const parsed: BootstrapEvent[] = [];

  for (const e of events) {
    if (!isObject(e)) continue;

    const id = e['id'];
    const name = e['name'];
    const deadline_time = e['deadline_time'];
    const release_time = e['release_time'];
    const finished = e['finished'];
    const data_checked = e['data_checked'];

    if (
      typeof id !== 'number' ||
      typeof name !== 'string' ||
      typeof deadline_time !== 'string' ||
      typeof finished !== 'boolean' ||
      typeof data_checked !== 'boolean'
    ) {
      continue;
    }

    parsed.push({
      id,
      name,
      deadline_time,
      release_time: typeof release_time === 'string' ? release_time : null,
      finished,
      data_checked,
    });
  }

  if (parsed.length === 0) throw new Error('Parsed 0 gameweeks from bootstrap-static (unexpected)');
  return parsed;
}

function parseDateOrThrow(iso: string, field: string, gwId: number): Date {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid ISO datetime for ${field} in gw=${gwId}: ${iso}`);
  }
  return d;
}

async function upsertGameweeks(gameweeks: BootstrapEvent[]) {
  // Det er få gameweeks, så én transaction er fint
  await prisma.$transaction(
    gameweeks.map((gw) =>
      prisma.gameweek.upsert({
        where: { id: gw.id },
        create: {
          id: gw.id,
          name: gw.name,
          deadlineTime: parseDateOrThrow(gw.deadline_time, 'deadline_time', gw.id),
          releaseTime: gw.release_time
            ? parseDateOrThrow(gw.release_time, 'release_time', gw.id)
            : null,
          finished: gw.finished,
          dataChecked: gw.data_checked,
        },
        update: {
          name: gw.name,
          deadlineTime: parseDateOrThrow(gw.deadline_time, 'deadline_time', gw.id),
          releaseTime: gw.release_time
            ? parseDateOrThrow(gw.release_time, 'release_time', gw.id)
            : null,
          finished: gw.finished,
          dataChecked: gw.data_checked,
        },
      })
    )
  );

  return gameweeks.length;
}

async function main() {
  console.log(`Fetching bootstrap-static from ${BASE} ...`);
  const boot = await fetchBootstrap();

  const gameweeks = parseEvents(boot);
  console.log(`Parsed ${gameweeks.length} gameweeks`);

  const count = await upsertGameweeks(gameweeks);
  console.log(`Done. Upserted ${count} gameweeks.`);
}

main()
  .catch((e) => {
    console.error('syncGameweeks failed:', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
