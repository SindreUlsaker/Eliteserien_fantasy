import { FastifyInstance, FastifyPluginOptions, FastifyReply, FastifyRequest } from 'fastify';
import { PrismaClient } from '@prisma/client';

interface EntriesPluginOptions extends FastifyPluginOptions {
  prisma: PrismaClient;
}

type SearchQuery = {
  q?: string;
  limit?: string;
};

export default async function entriesRoutes(
  fastify: FastifyInstance,
  options: EntriesPluginOptions
) {
  const { prisma } = options;

  fastify.get(
    '/entries/search',
    async (request: FastifyRequest<{ Querystring: SearchQuery }>, reply: FastifyReply) => {
      const rawQ = request.query.q ?? '';
      const q = rawQ.trim();

      if (!q) return reply.send([]);

      // begrens litt så vi ikke får helt absurde inputs
      if (q.length > 100) return reply.send([]);

      const limitRaw = request.query.limit;
      const limitParsed = Number(limitRaw);
      const limit = Number.isFinite(limitParsed) ? Math.min(Math.max(limitParsed, 1), 50) : 25;

      // 1) Hvis input er et tall: prøv entryId først
      if (/^\d+$/.test(q)) {
        const id = Number(q);

        const entry = await prisma.entry.findUnique({
          where: { id },
          select: {
            id: true,
            entryName: true,
            playerName: true,
            lastOverallRank: true,
            lastOverallTotal: true,
          },
        });

        if (entry) return reply.send([entry]);
        // hvis ikke funnet, faller vi videre til navn-søk
      }

      // 2) Eksakt match (case-insensitive) på entryName eller playerName
      const results = await prisma.entry.findMany({
        where: {
          OR: [
            { entryName: { equals: q, mode: 'insensitive' } },
            { playerName: { equals: q, mode: 'insensitive' } },
          ],
        },
        take: limit,
        select: {
          id: true,
          entryName: true,
          playerName: true,
          lastOverallRank: true,
          lastOverallTotal: true,
        },
        orderBy: [{ lastOverallRank: 'asc' }],
      });

      return reply.send(results);
    }
  );
}
