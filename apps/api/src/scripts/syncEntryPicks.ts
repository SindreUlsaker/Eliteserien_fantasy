import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const DEFAULT_BASE = 'https://fantasy.eliteserien.no';

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function toInt(v: string | undefined): number | null {
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

type PicksResponse = {
  picks: Array<{
    element: number;
    position: number;
    multiplier: number;
    is_captain: boolean;
    is_vice_captain: boolean;
    element_type: number;
  }>;
  entry_history?: {
    points?: number;
    total_points?: number;
    overall_rank?: number;
    rank?: number;
    bank?: number;
    value?: number;
    event_transfers?: number;
    event_transfers_cost?: number;
  };
};

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'eliteserien-api/syncEntryPicks',
      Accept: 'application/json',
    },
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} (${res.statusText}) for ${url}`);
  }

  return res.json();
}

function parsePicksResponse(data: unknown): PicksResponse {
  if (!isObject(data)) throw new Error('picks response was not an object');
  const picks = data['picks'];
  if (!Array.isArray(picks)) throw new Error("picks response missing 'picks' array");

  const parsedPicks: PicksResponse['picks'] = [];
  for (const p of picks) {
    if (!isObject(p)) continue;

    const element = p['element'];
    const position = p['position'];
    const multiplier = p['multiplier'];
    const is_captain = p['is_captain'];
    const is_vice_captain = p['is_vice_captain'];
    const element_type = p['element_type'];

    if (
      typeof element !== 'number' ||
      typeof position !== 'number' ||
      typeof multiplier !== 'number' ||
      typeof is_captain !== 'boolean' ||
      typeof is_vice_captain !== 'boolean' ||
      typeof element_type !== 'number'
    ) {
      continue;
    }

    parsedPicks.push({ element, position, multiplier, is_captain, is_vice_captain, element_type });
  }

  if (parsedPicks.length !== 15) {
    throw new Error(`Expected 15 picks, got ${parsedPicks.length}`);
  }

  const entry_history = isObject(data['entry_history'])
    ? (data['entry_history'] as PicksResponse['entry_history'])
    : undefined;

  return { picks: parsedPicks, entry_history };
}

async function ensureEntryExists(entryId: number, base: string) {
  const exists = await prisma.entry.findUnique({ where: { id: entryId }, select: { id: true } });
  if (exists) return;

  // Best effort: prøv å hente entry metadata fra ekstern API
  try {
    const url = `${base}/api/entry/${entryId}/`;
    const raw = await fetchJson(url);
    if (isObject(raw)) {
      const entryName =
        typeof raw['name'] === 'string' ? (raw['name'] as string) : `Entry ${entryId}`;
      const playerName =
        typeof raw['player_first_name'] === 'string' && typeof raw['player_last_name'] === 'string'
          ? `${raw['player_first_name']} ${raw['player_last_name']}`
          : 'Unknown';

      await prisma.entry.create({
        data: {
          id: entryId,
          entryName,
          playerName,
        },
      });
      return;
    }
  } catch {
    // ignore
  }

  // Fallback: lag minimal entry (krever String-felter i schema)
  await prisma.entry.create({
    data: {
      id: entryId,
      entryName: `Entry ${entryId}`,
      playerName: 'Unknown',
    },
  });
}

async function main() {
  const entryId = toInt(process.env.ENTRY_ID) ?? toInt(process.argv[2]);
  if (!entryId)
    throw new Error('Missing ENTRY_ID. Use: ENTRY_ID=123 pnpm --filter api data:sync-entry-picks');

  const base = process.env.ESF_BASE_URL ?? DEFAULT_BASE;

  // Hvilke gameweeks er ferdige?
  const finishedGws = await prisma.gameweek.findMany({
    where: { finished: true },
    select: { id: true },
    orderBy: { id: 'asc' },
  });

  if (finishedGws.length === 0) {
    throw new Error('No finished gameweeks in DB. Run your gameweek sync first.');
  }

  const gwIds = finishedGws.map((g) => g.id);

  // Hvilke gameweeks har vi allrede data for
  const existing = await prisma.entryGameweek.findMany({
    where: { entryId, gameweekId: { in: gwIds } },
    select: { gameweekId: true },
  });
  const existingSet = new Set(existing.map((e) => e.gameweekId));

  const missing = gwIds.filter((gw) => !existingSet.has(gw));

  console.log(
    `Entry ${entryId}: finishedGWs=${gwIds.length}, existing=${existingSet.size}, missing=${missing.length}`
  );

  await ensureEntryExists(entryId, base);

  // Sync missing
  let done = 0;
  for (const gw of missing) {
    const url = `${base}/api/entry/${entryId}/event/${gw}/picks/`;
    const raw = await fetchJson(url);
    const parsed = parsePicksResponse(raw);

    // Valider at ID er i db
    const playerIds = parsed.picks.map((p) => p.element);
    const existingPlayers = await prisma.player.findMany({
      where: { id: { in: playerIds } },
      select: { id: true },
    });
    if (existingPlayers.length !== playerIds.length) {
      throw new Error(
        `Missing players in DB for GW ${gw}. Run player sync first (data:sync-players).`
      );
    }

    await prisma.$transaction(async (tx) => {
      const eg = await tx.entryGameweek.upsert({
        where: { entryId_gameweekId: { entryId, gameweekId: gw } },
        create: {
          entryId,
          gameweekId: gw,
          points: parsed.entry_history?.points ?? null,
          totalPoints: parsed.entry_history?.total_points ?? null,
          overallRank: parsed.entry_history?.overall_rank ?? null,
          rank: parsed.entry_history?.rank ?? null,
          bank: parsed.entry_history?.bank ?? null,
          value: parsed.entry_history?.value ?? null,
          eventTransfers: parsed.entry_history?.event_transfers ?? null,
          eventTransfersCost: parsed.entry_history?.event_transfers_cost ?? null,
        },
        update: {
          points: parsed.entry_history?.points ?? null,
          totalPoints: parsed.entry_history?.total_points ?? null,
          overallRank: parsed.entry_history?.overall_rank ?? null,
          rank: parsed.entry_history?.rank ?? null,
          bank: parsed.entry_history?.bank ?? null,
          value: parsed.entry_history?.value ?? null,
          eventTransfers: parsed.entry_history?.event_transfers ?? null,
          eventTransfersCost: parsed.entry_history?.event_transfers_cost ?? null,
        },
        select: { id: true },
      });

      await tx.entryPick.deleteMany({ where: { entryGameweekId: eg.id } });

      await tx.entryPick.createMany({
        data: parsed.picks.map((p) => ({
          entryGameweekId: eg.id,
          playerId: p.element,
          position: p.position,
          multiplier: p.multiplier,
          isCaptain: p.is_captain,
          isViceCaptain: p.is_vice_captain,
          elementType: p.element_type,
        })),
      });
    });

    done += 1;
    console.log(`Synced GW ${gw} (${done}/${missing.length})`);
  }

  console.log('Done.');
}

main()
  .catch((e) => {
    console.error('syncEntryPicks failed:', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
