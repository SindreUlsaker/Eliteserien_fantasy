import Fastify, { FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import cors from '@fastify/cors';
import healthRoutes from './routes/health';
import entriesRoutes from './routes/entries';
import { entryHistoryRoutes } from './routes/entryHistory';

const prisma = new PrismaClient();

const server: FastifyInstance = Fastify({
  logger: {
    transport:
      process.env.NODE_ENV === 'development'
        ? {
            target: 'pino-pretty',
            options: {
              translateTime: 'HH:MM:ss Z',
              ignore: 'pid,hostname',
            },
          }
        : undefined,
  },
});

// CORS (tillat web-appen å kalle API-et lokalt)
server.register(cors, {
  origin: ['http://localhost:3000'],
});

// Register routes
server.register(healthRoutes, { prisma });
server.register(entriesRoutes, { prisma });
server.register(entryHistoryRoutes, {});

const start = async () => {
  try {
    const port = Number(process.env.API_PORT) || 3001;
    const host = process.env.API_HOST || '0.0.0.0';

    await server.listen({ port, host });
    server.log.info(`Server listening on http://${host}:${port}`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
};

// Graceful shutdown
const shutdown = async () => {
  server.log.info('Shutting down gracefully...');
  await server.close();
  await prisma.$disconnect();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

start();
