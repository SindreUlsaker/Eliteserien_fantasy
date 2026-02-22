import { FastifyInstance, FastifyPluginOptions, FastifyReply, FastifyRequest } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { computeEntryInsights } from '../services/computeEntryInsights';

interface EntryInsightsPluginOptions extends FastifyPluginOptions {
  prisma: PrismaClient;
}

function toInt(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
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

      // hvis entry ikke finnes i DB, så lar vi computeEntryInsights sørge for upsert.

      const data = await computeEntryInsights(prisma, entryId);

      // Cache litt
      reply.header('Cache-Control', 'public, max-age=30');

      return reply.send(data);
    }
  );
}
