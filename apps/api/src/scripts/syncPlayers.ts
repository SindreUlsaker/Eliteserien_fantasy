import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const DEFAULT_BASES = ['https://en.fantasy.eliteserien.no'];

// Liten runtime-typeguard
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

async function fetchBootstrap(base: string) {
  const url = `${base}/api/bootstrap-static/`;

  const res = await fetch(url, {
    headers: {
      // Enkel og tydelig UA for debugging i server-logger om nødvendig
      'User-Agent': 'eliteserien-api/syncPlayers',
      Accept: 'application/json',
    },
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} (${res.statusText}) for ${url}`);
  }

  const data: unknown = await res.json();
  if (!isObject(data)) throw new Error(`bootstrap-static returned non-object JSON from ${url}`);
  return data;
}

type BootstrapElement = {
  id: number;
  first_name: string;
  second_name: string;
  web_name: string;
  team: number;
  element_type: number;
  status: string;
  removed?: boolean;
};

function parseElements(data: Record<string, unknown>): BootstrapElement[] {
  const elements = data['elements'];
  if (!Array.isArray(elements)) throw new Error("bootstrap-static missing 'elements' array");

  // Best-effort parsing: vi tar kun feltene vi faktisk bruker
  const parsed: BootstrapElement[] = [];
  for (const e of elements) {
    if (!isObject(e)) continue;

    const id = e['id'];
    const first_name = e['first_name'];
    const second_name = e['second_name'];
    const web_name = e['web_name'];
    const team = e['team'];
    const element_type = e['element_type'];
    const status = e['status'];

    if (
      typeof id !== 'number' ||
      typeof first_name !== 'string' ||
      typeof second_name !== 'string' ||
      typeof web_name !== 'string' ||
      typeof team !== 'number' ||
      typeof element_type !== 'number' ||
      typeof status !== 'string'
    ) {
      continue;
    }

    parsed.push({
      id,
      first_name,
      second_name,
      web_name,
      team,
      element_type,
      status,
      removed: typeof e['removed'] === 'boolean' ? (e['removed'] as boolean) : undefined,
    });
  }

  if (parsed.length === 0) throw new Error('Parsed 0 players from bootstrap-static (unexpected)');
  return parsed;
}

async function upsertPlayers(players: BootstrapElement[]) {
  const ids = players.map((p) => p.id);

  // Chunk for å unngå altfor store transactions
  const chunkSize = 200;
  let upserts = 0;

  for (let i = 0; i < players.length; i += chunkSize) {
    const chunk = players.slice(i, i + chunkSize);

    await prisma.$transaction(
      chunk.map((p) =>
        prisma.player.upsert({
          where: { id: p.id },
          create: {
            id: p.id,
            firstName: p.first_name,
            secondName: p.second_name,
            webName: p.web_name,
            teamId: p.team,
            positionId: p.element_type,
            status: p.status,
            removed: p.removed ?? false,
          },
          update: {
            firstName: p.first_name,
            secondName: p.second_name,
            webName: p.web_name,
            teamId: p.team,
            positionId: p.element_type,
            status: p.status,
            removed: p.removed ?? false,
          },
        })
      )
    );

    upserts += chunk.length;
    console.log(`Upserted ${upserts}/${players.length} players...`);
  }

  // Marker spillere som ikke lenger finnes i bootstrap-static som removed=true
  const removedRes = await prisma.player.updateMany({
    where: { id: { notIn: ids } },
    data: { removed: true },
  });

  // (Valgfritt men greit) Sørg for at alle som finnes nå er removed=false
  await prisma.player.updateMany({
    where: { id: { in: ids } },
    data: { removed: false },
  });

  return { total: players.length, markedRemoved: removedRes.count };
}

async function main() {
  // Mulighet for override i miljø:
  // ESF_BASE_URL=https://... (for testing)
  const bases = process.env.ESF_BASE_URL ? [process.env.ESF_BASE_URL] : DEFAULT_BASES;

  let bootstrap: Record<string, unknown> | null = null;
  let usedBase: string | null = null;

  for (const base of bases) {
    try {
      bootstrap = await fetchBootstrap(base);
      usedBase = base;
      break;
    } catch (e) {
      console.warn(`Failed base ${base}:`, e);
    }
  }

  if (!bootstrap || !usedBase) {
    throw new Error(`Could not fetch bootstrap-static from any base: ${bases.join(', ')}`);
  }

  console.log(`Fetched bootstrap-static from ${usedBase}`);

  const players = parseElements(bootstrap);
  console.log(`Parsed ${players.length} players`);

  const result = await upsertPlayers(players);
  console.log(`Done. total=${result.total}, markedRemoved=${result.markedRemoved}`);
}

main()
  .catch((e) => {
    console.error('syncPlayers failed:', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
