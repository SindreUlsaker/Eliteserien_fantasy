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

async function getCurrentGameweekId(prisma: PrismaClient): Promise<number> {
  // "aktiv" GW = første som ikke er finished (hvis finnes)
  const next = await prisma.gameweek.findFirst({
    where: { finished: false },
    orderBy: { id: 'asc' },
    select: { id: true },
  });
  if (next?.id) return next.id;

  // fallback: siste GW i db
  const last = await prisma.gameweek.findFirst({
    orderBy: { id: 'desc' },
    select: { id: true },
  });
  if (!last?.id) throw new Error('No gameweeks in DB');
  return last.id;
}

async function getCurrentOverallRank(
  prisma: PrismaClient,
  entryId: number
): Promise<number | null> {
  const lastFinished = await prisma.entryGameweek.findFirst({
    where: { entryId, gameweek: { finished: true } },
    orderBy: { gameweekId: 'desc' },
    select: { overallRank: true },
  });
  return lastFinished?.overallRank ?? null;
}

async function getBracketIdForRank(
  prisma: PrismaClient,
  rank: number | null
): Promise<number | null> {
  if (rank == null) return null;

  const brackets = await prisma.bracket.findMany({
    where: { active: true },
    orderBy: { rankTo: 'asc' },
    select: { id: true, rankTo: true },
  });

  if (brackets.length === 0) return null;

  // Finn første bracket der rank <= rankTo
  const hit = brackets.find((b) => rank <= b.rankTo);
  if (hit) return hit.id;

  // Hvis rank er utenfor alle brackets: bruk "største" (typisk topp 10000)
  return brackets[brackets.length - 1].id;
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

      // current bracket = basert på siste ferdige GW overall rank
      const currentGwId = await getCurrentGameweekId(prisma);
      const currentRank = await getCurrentOverallRank(prisma, entryId);
      const currentBracketId = await getBracketIdForRank(prisma, currentRank);

      // BracketGameweekStats (hvis finnes)
      // Vi bruker findFirst for å unngå å anta navn på unique constraint i Prisma
      const bracketGameweekStats = currentBracketId
        ? await prisma.bracketGameweekStats.findFirst({
            where: { bracketId: currentBracketId, gameweekId: currentGwId },
            orderBy: { version: 'desc' },
            select: {
              bracketId: true,
              gameweekId: true,
              data: true,
              sampleSize: true,
              version: true,
            },
          })
        : null;

      return reply.send({
        entryId,
        sync,
        insights,
        current: {
          gameweekId: currentGwId,
          overallRank: currentRank,
          bracketId: currentBracketId,
        },
        bracketGameweekStats,
      });
    }
  );
}
