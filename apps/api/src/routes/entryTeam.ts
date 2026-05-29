import { FastifyInstance, FastifyPluginOptions, FastifyReply, FastifyRequest } from 'fastify';
import { PrismaClient } from '@prisma/client';

interface EntryTeamPluginOptions extends FastifyPluginOptions {
  prisma: PrismaClient;
}

interface Pick {
  element: number;
  position: number;
  multiplier: number;
  is_captain: boolean;
  is_vice_captain: boolean;
  element_type: number;
}

interface EntryHistory {
  points: number | null;
  total_points: number | null;
  overall_rank: number | null;
  rank: number | null;
  bank: number | null;
  value: number | null;
  event_transfers: number | null;
  event_transfers_cost: number | null;
}

interface PicksResponse {
  picks: Pick[];
  entry_history: EntryHistory;
}

function toInt(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'eliteserien-api/entryTeam', Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

function parsePicksResponse(data: unknown): PicksResponse {
  if (!data || typeof data !== 'object') throw new Error('Invalid picks response');

  const asRecord = data as Record<string, unknown>;
  const rawPicks = asRecord.picks;
  if (!Array.isArray(rawPicks)) throw new Error('Invalid picks response: missing picks array');

  function parsePick(p: unknown): Pick {
    if (typeof p !== 'object' || p === null) throw new Error('Invalid pick');
    const obj = p as Record<string, unknown>;

    const element = toInt(obj.element);
    const position = toInt(obj.position);
    const multiplier = toInt(obj.multiplier);
    const is_captain = typeof obj.is_captain === 'boolean' ? obj.is_captain : false;
    const is_vice_captain = typeof obj.is_vice_captain === 'boolean' ? obj.is_vice_captain : false;
    const element_type = toInt(obj.element_type);

    if (element === null || position === null || multiplier === null || element_type === null) {
      throw new Error('Invalid pick values');
    }

    return {
      element,
      position,
      multiplier,
      is_captain,
      is_vice_captain,
      element_type,
    };
  }

  const picks = rawPicks.map(parsePick);
  if (picks.length !== 15) throw new Error(`Expected 15 picks, got ${picks.length}`);

  const ehRaw = asRecord.entry_history;
  const eh = typeof ehRaw === 'object' && ehRaw !== null ? (ehRaw as Record<string, unknown>) : {};

  return {
    picks,
    entry_history: {
      points: toInt(eh.points ?? null),
      total_points: toInt(eh.total_points ?? null),
      overall_rank: toInt(eh.overall_rank ?? null),
      rank: toInt(eh.rank ?? null),
      bank: toInt(eh.bank ?? null),
      value: toInt(eh.value ?? null),
      event_transfers: toInt(eh.event_transfers ?? null),
      event_transfers_cost: toInt(eh.event_transfers_cost ?? null),
    },
  };
}

function positionLabel(positionId: number): 'GKP' | 'DEF' | 'MID' | 'FWD' {
  if (positionId === 1) return 'GKP';
  if (positionId === 2) return 'DEF';
  if (positionId === 3) return 'MID';
  return 'FWD';
}

/**
 * Sørger for at vi har EntryGameweek + EntryPick i DB for (entryId, gw).
 * Samme pattern som syncMissingEntryPicks, bare for én gw.
 */
async function syncEntryPicksForGw(prisma: PrismaClient, entryId: number, gw: number) {
  const baseUrl = process.env.ESF_BASE_URL ?? 'https://fantasy.eliteserien.no';

  const raw = await fetchJson(`${baseUrl}/api/entry/${entryId}/event/${gw}/picks/`);
  const parsed = parsePicksResponse(raw);

  // FK check: spillerne må finnes i DB
  const playerIds = parsed.picks.map((p) => p.element);
  const dbPlayers = await prisma.player.findMany({
    where: { id: { in: playerIds } },
    select: { id: true },
  });
  if (dbPlayers.length !== playerIds.length) {
    throw new Error(`Missing players in DB for GW ${gw}. Run data:sync-players first.`);
  }

  await prisma.$transaction(async (tx) => {
    const eg = await tx.entryGameweek.upsert({
      where: { entryId_gameweekId: { entryId, gameweekId: gw } },
      create: {
        entryId,
        gameweekId: gw,
        points: parsed.entry_history.points,
        totalPoints: parsed.entry_history.total_points,
        overallRank: parsed.entry_history.overall_rank,
        rank: parsed.entry_history.rank,
        bank: parsed.entry_history.bank,
        value: parsed.entry_history.value,
        eventTransfers: parsed.entry_history.event_transfers,
        eventTransfersCost: parsed.entry_history.event_transfers_cost,
      },
      update: {
        points: parsed.entry_history.points,
        totalPoints: parsed.entry_history.total_points,
        overallRank: parsed.entry_history.overall_rank,
        rank: parsed.entry_history.rank,
        bank: parsed.entry_history.bank,
        value: parsed.entry_history.value,
        eventTransfers: parsed.entry_history.event_transfers,
        eventTransfersCost: parsed.entry_history.event_transfers_cost,
      },
      select: { id: true },
    });

    // Replace picks (idempotent)
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

  return { synced: true };
}

export default async function entryTeamRoutes(
  fastify: FastifyInstance,
  options: EntryTeamPluginOptions
) {
  const { prisma } = options;

  fastify.get(
    '/entries/:entryId/team/:gw',
    async (
      request: FastifyRequest<{ Params: { entryId: string; gw: string } }>,
      reply: FastifyReply
    ) => {
      const entryId = toInt(request.params.entryId);
      const gw = toInt(request.params.gw);

      if (!entryId) return reply.code(400).send({ error: 'Invalid entryId' });
      if (!gw) return reply.code(400).send({ error: 'Invalid gw' });

      const entry = await prisma.entry.findUnique({ where: { id: entryId }, select: { id: true } });
      if (!entry) return reply.code(404).send({ error: 'Entry not found in DB' });

      // Sjekk om vi allerede har picks i DB. Hvis ikke: sync for denne gw.
      const existing = await prisma.entryGameweek.findUnique({
        where: { entryId_gameweekId: { entryId, gameweekId: gw } },
        select: { id: true },
      });

      let didSync = false;
      if (!existing) {
        await syncEntryPicksForGw(prisma, entryId, gw);
        didSync = true;
      }

      // Hent picks + player + team
      const eg = await prisma.entryGameweek.findUnique({
        where: { entryId_gameweekId: { entryId, gameweekId: gw } },
        select: {
          gameweekId: true,
          points: true,
          totalPoints: true,
          overallRank: true,
          rank: true,
          bank: true,
          value: true,
          eventTransfers: true,
          eventTransfersCost: true,
          gameweek: { select: { name: true } },
          picks: {
            orderBy: { position: 'asc' },
            select: {
              playerId: true,
              position: true,
              multiplier: true,
              isCaptain: true,
              isViceCaptain: true,
              player: {
                select: {
                  id: true,
                  webName: true,
                  firstName: true,
                  secondName: true,
                  positionId: true,
                  team: { select: { id: true, shortName: true, name: true } },
                },
              },
            },
          },
        },
      });

      if (!eg) return reply.code(404).send({ error: 'Missing entry gameweek after sync' });

      const playerIds = eg.picks.map((p) => p.playerId);

      // Hent stats for disse spillerne i denne gw (kan mangle hvis dere ikke har syncet playerStats)
      const statsRows = await prisma.playerGameweekStats.findMany({
        where: { gameweekId: gw, playerId: { in: playerIds } },
        select: {
          playerId: true,
          gameweekId: true,
          fixtureCount: true,
          totalPoints: true,
          minutes: true,
          goalsScored: true,
          assists: true,
          cleanSheets: true,
          goalsConceded: true,
          yellowCards: true,
          redCards: true,
          saves: true,
          bonus: true,
        },
      });

      const statsByPlayer = new Map<number, (typeof statsRows)[number]>();
      for (const r of statsRows) statsByPlayer.set(r.playerId, r);

      let missingPointsCount = 0;

      const mapped = eg.picks.map((p) => {
        const s = statsByPlayer.get(p.playerId);
        const points = s ? s.totalPoints : 0;
        if (!s) missingPointsCount += 1;

        return {
          position: p.position,
          playerId: p.player.id,
          name: p.player.webName || `${p.player.firstName} ${p.player.secondName}`.trim(),
          teamId: p.player.team.id,
          teamShort: p.player.team.shortName,
          teamName: p.player.team.name,
          elementType: positionLabel(p.player.positionId),
          multiplier: p.multiplier,
          isCaptain: p.isCaptain,
          isViceCaptain: p.isViceCaptain,

          points,
          // nice-to-have: detaljer for “trykk på spiller”
          stats: {
            fixtureCount: s?.fixtureCount ?? 0,
            minutes: s?.minutes ?? 0,
            goalsScored: s?.goalsScored ?? 0,
            assists: s?.assists ?? 0,
            cleanSheets: s?.cleanSheets ?? 0,
            goalsConceded: s?.goalsConceded ?? 0,
            yellowCards: s?.yellowCards ?? 0,
            redCards: s?.redCards ?? 0,
            saves: s?.saves ?? 0,
            bonus: s?.bonus ?? 0,
          },
        };
      });

      const xi = mapped.filter((p) => p.position >= 1 && p.position <= 11);
      const bench = mapped.filter((p) => p.position >= 12 && p.position <= 15);

      // Totalpoeng for XI basert på vår points (fra PlayerGameweekStats) * multiplier
      const totalPointsFromStats = xi.reduce((sum, p) => sum + p.points * p.multiplier, 0);

      return reply.send({
        entryId,
        gw: eg.gameweekId,
        gwName: eg.gameweek?.name ?? null,
        sync: { didSync },
        entryHistory: {
          points: eg.points,
          totalPoints: eg.totalPoints,
          overallRank: eg.overallRank,
          rank: eg.rank,
          bank: eg.bank,
          value: eg.value,
          eventTransfers: eg.eventTransfers,
          eventTransfersCost: eg.eventTransfersCost,
        },
        team: {
          xi,
          bench,
          totals: {
            totalPointsFromStats,
          },
        },
        meta: {
          pointsSource: 'playerGameweekStats',
          missingPointsCount,
        },
      });
    }
  );
}
