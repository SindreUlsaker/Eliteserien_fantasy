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
    async (
      request: FastifyRequest<{
        Params: { entryId: string };
        Querystring: { bracketId?: string };
      }>,
      reply: FastifyReply
    ) => {
      const entryId = toInt(request.params.entryId);
      if (!entryId) return reply.code(400).send({ error: 'Invalid entryId' });

      let bracketIdOverride: number | null = null;
      if (request.query.bracketId !== undefined) {
        const parsed = toInt(request.query.bracketId);
        if (parsed == null) return reply.code(400).send({ error: 'Invalid bracketId' });
        bracketIdOverride = parsed;
      }

      // Henter alltid fersk data fra Eliteserie API + beregner insights.
      // computeEntryInsights vil upserte entry, entrySeasonTotals og entryInsights til DB
      // (kun når bracketId-override IKKE er gitt, slik at det persisterte snapshotet alltid
      // speiler brukerens naturlige bracket).
      try {
        const data = await computeEntryInsights(prisma, entryId, { bracketIdOverride });

        // Cache i 5 min — data oppdateres kun et par ganger i uka
        reply.header('Cache-Control', 'public, max-age=300');

        return reply.send(data);
      } catch (e) {
        if (e instanceof Error && e.message.startsWith('BRACKET_NOT_FOUND:')) {
          return reply.code(404).send({ error: 'Bracket not found' });
        }
        throw e;
      }
    }
  );
}
