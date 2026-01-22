import { FastifyInstance, FastifyPluginOptions, FastifyRequest, FastifyReply } from 'fastify';
import { PrismaClient } from '@prisma/client';

interface HealthPluginOptions extends FastifyPluginOptions {
  prisma: PrismaClient;
}

export default async function healthRoutes(fastify: FastifyInstance, options: HealthPluginOptions) {
  const { prisma } = options;

  fastify.get('/health', async (_request: FastifyRequest, reply: FastifyReply) => {
    let databaseStatus = 'disconnected';

    try {
      // Test database connection
      await prisma.$queryRaw`SELECT 1`;
      databaseStatus = 'connected';
    } catch (error) {
      fastify.log.error({ err: error }, 'Database connection failed');
      databaseStatus = 'error';
    }

    const status = databaseStatus === 'connected' ? 'ok' : 'degraded';

    return reply.status(status === 'ok' ? 200 : 503).send({
      status,
      database: databaseStatus,
      timestamp: new Date().toISOString(),
    });
  });
}
