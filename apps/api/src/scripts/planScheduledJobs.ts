import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const BASE_URL = process.env.ESF_BASE_URL ?? 'https://en.fantasy.eliteserien.no';
const DEADLINE_OFFSET_MINUTES = Number(process.env.JOB_DEADLINE_OFFSET_MINUTES ?? 5);
const FINISHED_CHECK_NEXT_DAY_HOUR_UTC = Number(
  process.env.JOB_FINISHED_CHECK_NEXT_DAY_HOUR_UTC ?? 8
);
const FINISHED_CHECK_NEXT_DAY_MINUTE_UTC = Number(
  process.env.JOB_FINISHED_CHECK_NEXT_DAY_MINUTE_UTC ?? 0
);

type BootstrapEvent = {
  id: number;
  deadline_time: string;
  finished: boolean;
};

type BootstrapResponse = {
  events?: unknown;
};

type FixtureRow = {
  event: number | null;
  kickoff_time: string | null;
};

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function parseIsoOrThrow(value: string, fieldName: string): Date {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid ISO datetime for ${fieldName}: ${value}`);
  }
  return d;
}

function addMinutes(base: Date, minutes: number): Date {
  return new Date(base.getTime() + minutes * 60_000);
}

function nextDayAtUtc(base: Date, hourUtc: number, minuteUtc: number): Date {
  return new Date(
    Date.UTC(
      base.getUTCFullYear(),
      base.getUTCMonth(),
      base.getUTCDate() + 1,
      hourUtc,
      minuteUtc,
      0,
      0
    )
  );
}

async function fetchJson<T>(path: string): Promise<T> {
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'eliteserien-api/planScheduledJobs',
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

function parseEvents(data: BootstrapResponse): BootstrapEvent[] {
  const eventsRaw = data.events;
  if (!Array.isArray(eventsRaw)) {
    throw new Error('bootstrap-static missing events array');
  }

  const out: BootstrapEvent[] = [];

  for (const row of eventsRaw) {
    if (!isObject(row)) continue;

    const id = row.id;
    const deadlineTime = row.deadline_time;
    const finished = row.finished;

    if (typeof id !== 'number') continue;
    if (typeof deadlineTime !== 'string') continue;
    if (typeof finished !== 'boolean') continue;

    out.push({
      id,
      deadline_time: deadlineTime,
      finished,
    });
  }

  if (out.length === 0) {
    throw new Error('No valid events parsed from bootstrap-static');
  }

  return out;
}

function parseFixtures(data: unknown): FixtureRow[] {
  if (!Array.isArray(data)) {
    throw new Error('fixtures endpoint did not return an array');
  }

  const out: FixtureRow[] = [];
  for (const row of data) {
    if (!isObject(row)) continue;

    const event = row.event;
    const kickoffTime = row.kickoff_time;

    out.push({
      event: typeof event === 'number' ? event : null,
      kickoff_time: typeof kickoffTime === 'string' ? kickoffTime : null,
    });
  }

  return out;
}

function getLastKickoffByEvent(fixtures: FixtureRow[]): Map<number, Date> {
  const byEvent = new Map<number, Date>();

  for (const fx of fixtures) {
    if (typeof fx.event !== 'number') continue;
    if (!fx.kickoff_time) continue;

    const kickoff = parseIsoOrThrow(fx.kickoff_time, `fixture kickoff_time event=${fx.event}`);
    const prev = byEvent.get(fx.event);

    if (!prev || kickoff.getTime() > prev.getTime()) {
      byEvent.set(fx.event, kickoff);
    }
  }

  return byEvent;
}

async function upsertScheduledJob(
  gameweekId: number,
  jobType: 'DEADLINE' | 'FINISHED_CHECK',
  targetTime: Date
): Promise<'created' | 'updated' | 'kept'> {
  const existing = await prisma.jobSchedule.findUnique({
    where: { gameweekId_jobType: { gameweekId, jobType } },
    select: { id: true, status: true, targetTime: true },
  });

  if (!existing) {
    await prisma.jobSchedule.create({
      data: {
        gameweekId,
        jobType,
        targetTime,
        status: 'PENDING',
      },
    });
    return 'created';
  }

  if (existing.status === 'DONE' || existing.status === 'RUNNING') {
    return 'kept';
  }

  const sameTarget = existing.targetTime.getTime() === targetTime.getTime();
  if (existing.status === 'PENDING' && sameTarget) {
    return 'kept';
  }

  await prisma.jobSchedule.update({
    where: { id: existing.id },
    data: {
      status: 'PENDING',
      targetTime,
      lastError: null,
      finishedAt: null,
      startedAt: null,
      lockedAt: null,
    },
  });

  return 'updated';
}

async function main() {
  console.log(`Planning jobs from ${BASE_URL}`);

  const [bootstrap, fixturesRaw] = await Promise.all([
    fetchJson<BootstrapResponse>('/api/bootstrap-static/'),
    fetchJson<unknown>('/api/fixtures/'),
  ]);

  const events = parseEvents(bootstrap);
  const fixtures = parseFixtures(fixturesRaw);
  const lastKickoffByEvent = getLastKickoffByEvent(fixtures);

  let created = 0;
  let updated = 0;
  let kept = 0;

  for (const event of events) {
    if (event.finished) {
      continue;
    }

    const deadline = parseIsoOrThrow(event.deadline_time, `deadline_time gw=${event.id}`);
    const deadlineTarget = addMinutes(deadline, DEADLINE_OFFSET_MINUTES);

    const deadlineResult = await upsertScheduledJob(event.id, 'DEADLINE', deadlineTarget);
    if (deadlineResult === 'created') created += 1;
    if (deadlineResult === 'updated') updated += 1;
    if (deadlineResult === 'kept') kept += 1;

    const lastKickoff = lastKickoffByEvent.get(event.id);
    const finishedCheckBase = lastKickoff ?? deadline;
    const finishedCheckTarget = nextDayAtUtc(
      finishedCheckBase,
      FINISHED_CHECK_NEXT_DAY_HOUR_UTC,
      FINISHED_CHECK_NEXT_DAY_MINUTE_UTC
    );

    const finishedResult = await upsertScheduledJob(
      event.id,
      'FINISHED_CHECK',
      finishedCheckTarget
    );
    if (finishedResult === 'created') created += 1;
    if (finishedResult === 'updated') updated += 1;
    if (finishedResult === 'kept') kept += 1;
  }

  console.log(
    `Planner done. events=${events.length}, fixtures=${fixtures.length}, created=${created}, updated=${updated}, kept=${kept}`
  );
}

main()
  .catch((e) => {
    console.error('planScheduledJobs failed:', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
