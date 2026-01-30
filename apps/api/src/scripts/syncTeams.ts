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
      'User-Agent': 'eliteserien-api/syncTeams',
      Accept: 'application/json',
    },
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} (${res.statusText}) for ${url}`);
  }

  const data: unknown = await res.json();
  if (!isObject(data)) {
    throw new Error(`bootstrap-static returned non-object JSON from ${url}`);
  }
  return data;
}

type BootstrapTeam = {
  id: number;
  name: string;
  short_name: string;
};

function parseTeams(data: Record<string, unknown>): BootstrapTeam[] {
  const teams = data['teams'];
  if (!Array.isArray(teams)) throw new Error("bootstrap-static missing 'teams' array");

  const parsed: BootstrapTeam[] = [];

  for (const t of teams) {
    if (!isObject(t)) continue;

    const id = t['id'];
    const name = t['name'];
    const short_name = t['short_name'];

    if (typeof id !== 'number' || typeof name !== 'string' || typeof short_name !== 'string') {
      continue;
    }

    parsed.push({ id, name, short_name });
  }

  if (parsed.length === 0) throw new Error('Parsed 0 teams from bootstrap-static (unexpected)');
  return parsed;
}

async function upsertTeams(teams: BootstrapTeam[]) {
  // Team-lista er liten, vi kan trygt gjøre én transaction
  await prisma.$transaction(
    teams.map((t) =>
      prisma.team.upsert({
        where: { id: t.id },
        create: {
          id: t.id,
          name: t.name,
          shortName: t.short_name,
        },
        update: {
          name: t.name,
          shortName: t.short_name,
        },
      })
    )
  );

  return teams.length;
}

async function main() {
  console.log(`Fetching bootstrap-static from ${BASE} ...`);
  const boot = await fetchBootstrap();

  const teams = parseTeams(boot);
  console.log(`Parsed ${teams.length} teams`);

  const count = await upsertTeams(teams);
  console.log(`Done. Upserted ${count} teams.`);
}

main()
  .catch((e) => {
    console.error('syncTeams failed:', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
