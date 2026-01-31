import type { FastifyInstance } from 'fastify';

type RemoteEntryHistory = {
  current?: Array<{
    event: number; // gw
    overall_rank: number | null;
    points?: number;
    total_points?: number;
  }>;
  chips?: Array<{
    name: string;
    time: string;
    event: number;
  }>;
  past?: unknown[];
};

type RankPoint = {
  gw: number;
  overallRank: number;
};
type ChipPlay = {
  gw: number;
  name: string;
  time: string;
};

export async function entryHistoryRoutes(app: FastifyInstance) {
  app.get<{ Params: { entryId: string } }>('/entries/:entryId/overall-rank', async (req, reply) => {
    const entryId = Number(req.params.entryId);
    if (!Number.isFinite(entryId) || entryId <= 0) {
      return reply.code(400).send({ error: 'Invalid entryId' });
    }

    const base = process.env.ESF_BASE_URL ?? 'https://en.fantasy.eliteserien.no';
    const upstreamUrl = `${base}/api/entry/${entryId}/history/`;

    const res = await fetch(upstreamUrl, {
      headers: {
        'user-agent': 'eliteserien-fantasy-api/1.0',
        accept: 'application/json',
      },
    });

    if (!res.ok) {
      return reply.code(502).send({
        error: 'Upstream error',
        upstreamStatus: res.status,
        upstreamUrl,
      });
    }

    const data = (await res.json()) as RemoteEntryHistory;

    const points: RankPoint[] = (data.current ?? [])
      .filter((row) => typeof row?.event === 'number' && typeof row?.overall_rank === 'number')
      .map((row) => ({
        gw: row.event,
        overallRank: row.overall_rank as number,
      }))
      .sort((a, b) => a.gw - b.gw);

    const chips: ChipPlay[] = (data.chips ?? [])
      .filter(
        (c) =>
          typeof c?.event === 'number' && typeof c?.name === 'string' && typeof c?.time === 'string'
      )
      .map((c) => ({
        gw: c.event,
        name: c.name,
        time: c.time,
      }))
      .sort((a, b) => a.gw - b.gw);

    reply.header('Cache-Control', 'public, max-age=60');

    return reply.send({
      entryId,
      points,
      chips,
    });
  });
}
