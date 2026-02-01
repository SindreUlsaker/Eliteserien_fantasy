import { FastifyInstance, FastifyPluginOptions, FastifyReply, FastifyRequest } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { computeEntryInsights } from '../services/computeEntryInsights';

interface EntryInsightsPluginOptions extends FastifyPluginOptions {
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
    headers: { 'User-Agent': 'eliteserien-api/entryInsights', Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

function parsePicksResponse(data: unknown): PicksResponse {
  if (
    !data ||
    typeof data !== 'object' ||
    !('picks' in data) ||
    !Array.isArray((data as any).picks)
  )
    throw new Error('Invalid picks response');

  const picks = (data as any).picks.map((p: unknown) => {
    if (typeof p !== 'object' || p === null) throw new Error('Invalid pick');
    const pick = p as any;
    return {
      element: pick.element,
      position: pick.position,
      multiplier: pick.multiplier,
      is_captain: pick.is_captain,
      is_vice_captain: pick.is_vice_captain,
      element_type: pick.element_type,
    };
  });

  if (picks.length !== 15) throw new Error(`Expected 15 picks, got ${picks.length}`);

  const eh = (data as any).entry_history ?? {};
  return {
    picks,
    entry_history: {
      points: eh.points ?? null,
      total_points: eh.total_points ?? null,
      overall_rank: eh.overall_rank ?? null,
      rank: eh.rank ?? null,
      bank: eh.bank ?? null,
      value: eh.value ?? null,
      event_transfers: eh.event_transfers ?? null,
      event_transfers_cost: eh.event_transfers_cost ?? null,
    },
  };
}

async function syncMissingEntryPicks(prisma: PrismaClient, entryId: number) {
  const baseUrl = process.env.ESF_BASE_URL ?? 'https://fantasy.eliteserien.no';

  // only finished gameweeks (stable)
  const finishedGws = await prisma.gameweek.findMany({
    where: { finished: true },
    select: { id: true },
    orderBy: { id: 'asc' },
  });

  const gwIds = finishedGws.map((g) => g.id);
  if (gwIds.length === 0) {
    throw new Error('No finished gameweeks in DB. Sync gameweeks first.');
  }

  const existing = await prisma.entryGameweek.findMany({
    where: { entryId, gameweekId: { in: gwIds } },
    select: { gameweekId: true },
  });

  const have = new Set(existing.map((r) => r.gameweekId));
  const missing = gwIds.filter((gw) => !have.has(gw));

  if (missing.length === 0) {
    return { synced: 0, totalFinished: gwIds.length };
  }

  for (const gw of missing) {
    const raw = await fetchJson(`${baseUrl}/api/entry/${entryId}/event/${gw}/picks/`);
    const parsed = parsePicksResponse(raw);

    // FK check: må finnes i db også
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

      // replace picks (idempotent)
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
  }

  return { synced: missing.length, totalFinished: gwIds.length };
}

export default async function entryInsightsRoutes(
  fastify: FastifyInstance,
  options: EntryInsightsPluginOptions
) {
  const { prisma } = options;

  fastify.get(
    '/entries/:entryId/insights',
    async (request: FastifyRequest<{ Params: { entryId: string } }>, reply: FastifyReply) => {
      const entryId = toInt(request.params.entryId);
      if (!entryId) return reply.code(400).send({ error: 'Invalid entryId' });

      const entry = await prisma.entry.findUnique({ where: { id: entryId }, select: { id: true } });
      if (!entry) return reply.code(404).send({ error: 'Entry not found in DB' });

      const sync = await syncMissingEntryPicks(prisma, entryId);

      const insights = await computeEntryInsights(prisma, entryId);

      return reply.send({
        entryId,
        sync,
        insights,
      });
    }
  );
}
