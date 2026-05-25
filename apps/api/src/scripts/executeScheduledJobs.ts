import { spawn } from 'node:child_process';

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const BASE_URL = process.env.ESF_BASE_URL ?? 'https://en.fantasy.eliteserien.no';
const JOB_BATCH_SIZE = Number(process.env.JOB_EXECUTOR_BATCH_SIZE ?? 5);
const ROUND_CHECK_RETRY_MINUTES = Number(process.env.ROUND_CHECK_RETRY_MINUTES ?? 60);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function addMinutes(base: Date, minutes: number): Date {
  return new Date(base.getTime() + minutes * 60_000);
}

function pnpmBin() {
  return 'pnpm';
}

function runPnpmScript(script: string, args: string[] = []): Promise<void> {
  return new Promise((resolve, reject) => {
    const fullArgs = ['run', script, ...args];

    console.log(`Running: pnpm ${fullArgs.join(' ')}`);

    const child = spawn(pnpmBin(), fullArgs, {
      cwd: process.cwd(),
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });

    child.on('error', (err) => {
      reject(err);
    });

    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Command failed (exit ${code}): pnpm ${fullArgs.join(' ')}`));
    });
  });
}

async function fetchJson<T>(path: string): Promise<T> {
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'eliteserien-api/executeScheduledJobs',
      Accept: 'application/json',
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `HTTP ${res.status} (${res.statusText}) for ${url}. Body: ${body.slice(0, 300)}`
    );
  }

  return (await res.json()) as T;
}

async function isRoundClosed(gameweekId: number): Promise<boolean> {
  const bootstrap = await fetchJson<{ events?: unknown }>('/api/bootstrap-static/');
  const events = bootstrap.events;

  let eventFinished = false;
  if (Array.isArray(events)) {
    const row = events.find((e) => isObject(e) && e.id === gameweekId);
    if (isObject(row) && typeof row.finished === 'boolean') {
      eventFinished = row.finished;
    }
  }

  const fixtures = await fetchJson<unknown>(`/api/fixtures/?event=${gameweekId}`);
  if (!Array.isArray(fixtures)) {
    return eventFinished;
  }

  const fixtureRows = fixtures.filter(isObject);
  const allFinished = fixtureRows.length > 0 && fixtureRows.every((fx) => fx.finished === true);

  return eventFinished || allFinished;
}

async function runDeadlineFlow(gameweekId: number): Promise<void> {
  await runPnpmScript('data:sync-gameweeks');
  await runPnpmScript('sync:entries');
  await runPnpmScript('compute:template-eo', [String(gameweekId)]);
}

async function runFinishedFlow(gameweekId: number): Promise<void> {
  await runPnpmScript('data:sync-gameweeks');

  const closed = await isRoundClosed(gameweekId);
  if (!closed) {
    throw new Error('ROUND_NOT_CLOSED_YET');
  }

  await runPnpmScript('sync:entries');
  await runPnpmScript('data:sync-player-gw-stats');
  await runPnpmScript('compute:entry-season-totals', [String(gameweekId)]);
  await runPnpmScript('compute:bracket-stats-snapshot', [String(gameweekId)]);
}

async function processJob(jobId: number) {
  const lockResult = await prisma.jobSchedule.updateMany({
    where: {
      id: jobId,
      status: 'PENDING',
    },
    data: {
      status: 'RUNNING',
      lockedAt: new Date(),
      startedAt: new Date(),
      attempts: { increment: 1 },
      lastError: null,
    },
  });

  if (lockResult.count !== 1) {
    console.log(`Skipping job ${jobId}: could not acquire lock`);
    return;
  }

  const job = await prisma.jobSchedule.findUnique({
    where: { id: jobId },
    select: {
      id: true,
      gameweekId: true,
      jobType: true,
    },
  });

  if (!job) {
    return;
  }

  try {
    console.log(`Executing job id=${job.id} type=${job.jobType} gw=${job.gameweekId}`);

    if (job.jobType === 'DEADLINE') {
      await runDeadlineFlow(job.gameweekId);
    } else {
      await runFinishedFlow(job.gameweekId);
    }

    await prisma.jobSchedule.update({
      where: { id: job.id },
      data: {
        status: 'DONE',
        finishedAt: new Date(),
        lockedAt: null,
        lastError: null,
      },
    });

    console.log(`Job completed id=${job.id}`);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);

    if (message === 'ROUND_NOT_CLOSED_YET' && job.jobType === 'FINISHED_CHECK') {
      const retryTime = addMinutes(new Date(), ROUND_CHECK_RETRY_MINUTES);

      await prisma.jobSchedule.update({
        where: { id: job.id },
        data: {
          status: 'PENDING',
          targetTime: retryTime,
          lockedAt: null,
          startedAt: null,
          finishedAt: null,
          lastError: `Round not closed yet. Retry at ${retryTime.toISOString()}`,
        },
      });

      console.log(`Job postponed id=${job.id} retryAt=${retryTime.toISOString()}`);
      return;
    }

    await prisma.jobSchedule.update({
      where: { id: job.id },
      data: {
        status: 'FAILED',
        finishedAt: new Date(),
        lockedAt: null,
        lastError: message.slice(0, 1000),
      },
    });

    console.error(`Job failed id=${job.id}: ${message}`);
  }
}

async function main() {
  const dueJobs = await prisma.jobSchedule.findMany({
    where: {
      status: 'PENDING',
      targetTime: { lte: new Date() },
    },
    orderBy: [{ targetTime: 'asc' }, { id: 'asc' }],
    take: JOB_BATCH_SIZE,
    select: { id: true },
  });

  if (dueJobs.length === 0) {
    console.log('No due jobs.');
    return;
  }

  console.log(`Found ${dueJobs.length} due jobs`);

  for (const job of dueJobs) {
    await processJob(job.id);
  }
}

main()
  .catch((e) => {
    console.error('executeScheduledJobs failed:', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
