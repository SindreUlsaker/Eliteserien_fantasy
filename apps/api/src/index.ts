import Fastify, { FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import healthRoutes from './routes/health';
import entriesRoutes from './routes/entries';
import { entryHistoryRoutes } from './routes/entryHistory';
import entryInsightsRoutes from './routes/entryInsights';
import entryTeamRoutes from './routes/entryTeam';

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
  // Stol på X-Forwarded-For ett hopp (Vercel/Fly/etc terminerer TLS foran oss),
  // slik at rate-limiteren ser klientens IP og ikke proxy-IP.
  trustProxy: 1,
});

// CORS: les allowlist fra env (komma-separert). Fallback til localhost for
// lokal dev. Eksempel i prod: CORS_ORIGINS=https://eliteserien-fantasy.vercel.app
const corsOrigins = (process.env.CORS_ORIGINS ?? 'http://localhost:3000')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

server.register(cors, {
  origin: corsOrigins,
});

// Rate limiting — globalt tak per IP. /health skippes (uptime-monitorer m.m.).
server.register(rateLimit, {
  max: 60,
  timeWindow: '1 minute',
  skipOnError: false,
  allowList: (req) => req.url.startsWith('/health'),
});

// Register routes
server.register(healthRoutes, { prisma });
server.register(entriesRoutes, { prisma });
server.register(entryHistoryRoutes, {});
server.register(entryInsightsRoutes, { prisma });
server.register(entryTeamRoutes, { prisma });

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
