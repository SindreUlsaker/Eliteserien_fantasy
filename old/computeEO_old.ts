import { PrismaClient } from '@prisma/client';
import { writeFile } from 'node:fs/promises';

const prisma = new PrismaClient();

type StandingsRow = {
  rank: number;
  entry: number; // entryId (bruker)
};

type StandingsResponse = {
  standings: {
    has_next: boolean;
    page: number;
    results: StandingsRow[];
  };
};

type PicksResponse = {
  picks: Array<{
    element: number;
    position: number;
    multiplier: number;
    is_captain: boolean;
    is_vice_captain: boolean;
  }>;
  entry_history?: {
    overall_rank?: number | null;
  };
};

type EntryHistoryResponse = {
  current: Array<{
    event: number;
    event_transfers_cost?: number;
  }>;
  chips?: Array<{
    name?: string;
    time?: string;
    event?: number;
  }>;
};

function getRequiredNumberEnv(key: string): number {
  const raw = process.env[key];
  const n = Number(raw);
  if (!raw || !Number.isFinite(n)) {
    throw new Error(`Missing/invalid env ${key}. Got: ${raw}`);
  }
  return n;
}

function roundTo(n: number, digits = 4) {
  const p = 10 ** digits;
  return Math.round(n * p) / p;
}

function getOptionalNumberEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return n;
}

function getOptionalBooleanEnv(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (!raw) return fallback;
  return raw === '1' || raw.toLowerCase() === 'true' || raw.toLowerCase() === 'yes';
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function jitter(ms: number) {
  const delta = ms * 0.2;
  return ms + (Math.random() * 2 - 1) * delta;
}

async function fetchJsonWithRetry<T>(url: string, init?: RequestInit): Promise<T> {
  const maxAttempts = 5;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(url, init);

    if (res.ok) {
      return (await res.json()) as T;
    }

    const retryable = res.status === 429 || (res.status >= 500 && res.status <= 599);
    const bodyText = await res.text().catch(() => '');

    if (!retryable || attempt === maxAttempts) {
      throw new Error(
        `HTTP ${res.status} (${res.statusText}) for ${url}. Body: ${bodyText.slice(0, 300)}`
      );
    }

    // Enkel exponential backoff + jitter
    const baseDelay = 600 * Math.pow(2, attempt - 1);
    const delayMs = Math.round(jitter(Math.min(baseDelay, 15_000)));

    console.warn(
      `Retrying (${attempt}/${maxAttempts}) ${url} after ${delayMs}ms (HTTP ${res.status})`
    );

    await sleep(delayMs);
  }

  throw new Error(`Failed to fetch ${url}`);
}

async function asyncPool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, idx: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function runOne() {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const idx = nextIndex++;
      if (idx >= items.length) return;
      results[idx] = await worker(items[idx], idx);
    }
  }

  const workers = Array.from({ length: Math.max(1, concurrency) }, () => runOne());
  await Promise.all(workers);
  return results;
}

async function fetchTopEntries(
  baseUrl: string,
  leagueId: number,
  maxRank: number
): Promise<Array<{ entryId: number; rank: number }>> {
  const collected: Array<{ entryId: number; rank: number }> = [];

  let page = 1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const url = `${baseUrl}/api/leagues-classic/${leagueId}/standings/?page_standings=${page}&phase=1`;

    const data = await fetchJsonWithRetry<StandingsResponse>(url, {
      headers: {
        'User-Agent': 'eliteserien-api/computeEO',
        Accept: 'application/json',
      },
    });

    const results = data.standings?.results ?? [];
    if (results.length === 0) break;

    for (const row of results) {
      if (typeof row.rank !== 'number' || typeof row.entry !== 'number') continue;
      if (row.rank <= maxRank) {
        collected.push({ entryId: row.entry, rank: row.rank });
      }
    }

    const lastRankOnPage = results[results.length - 1]?.rank;
    const hasNext = Boolean(data.standings?.has_next);

    console.log(
      `Standings page ${page}: got ${results.length} rows. collected=${collected.length}. has_next=${hasNext}`
    );

    if (!hasNext) break;
    if (typeof lastRankOnPage === 'number' && lastRankOnPage >= maxRank) break;

    page += 1;
  }

  collected.sort((a, b) => a.rank - b.rank);

  const seen = new Set<number>();
  const deduped: Array<{ entryId: number; rank: number }> = [];
  for (const r of collected) {
    if (seen.has(r.entryId)) continue;
    seen.add(r.entryId);
    deduped.push(r);
  }

  console.log(`Collected ${deduped.length} unique entries up to rank ${maxRank}.`);
  return deduped;
}

/**
 * Samme mønster som i GAMMEL computeEO:
 * - Brackets kan overlappe (f.eks. Top 100 = 1-100, Top 500 = 1-500 osv)
 * - Entryen teller i ALLE bracketene den matcher.
 */
function bracketsForRank(
  rank: number | null | undefined,
  brackets: Array<{ id: number; rankFrom: number; rankTo: number; name: string }>
) {
  if (rank == null) return [];
  return brackets.filter((b) => rank >= b.rankFrom && rank <= b.rankTo);
}

function normalizeChipName(name: string, chipGw: number) {
  // Split wildcard: <= 15 => wildcard1, >= 16 => wildcard2
  if (name === 'wildcard') return chipGw <= 15 ? 'wildcard1' : 'wildcard2';
  return name;
}

type Counts = {
  sampleSize: number;
  ownedCount: Map<number, number>;
  captainCount: Map<number, number>;

  // Hits-metrikker
  transferCostSum: number; // sum(event_transfers_cost)
  hitEntryCount: number; // count(event_transfers_cost > 0)

  // Chips-metrikker (telles fra entry history)
  chipTotalUsed: Map<string, number>; // totalt brukt i sesongen innen samplet
  chipUsedThisGw: Map<string, number>; // brukt denne runden innen samplet
};

type EntryInfo = { entryId: number; rank: number };

async function main() {
  const gwRaw = process.argv[2];
  const gw = Number(gwRaw);
  if (!gwRaw || !Number.isFinite(gw) || gw <= 0) {
    throw new Error(`Usage: computeEO <gameweek>. Example: pnpm --filter api compute:eo -- 30`);
  }

  const BASE_URL = process.env.ESF_BASE_URL ?? 'https://en.fantasy.eliteserien.no';
  const OVERALL_LEAGUE_ID = getRequiredNumberEnv('OVERALL_LEAGUE_ID');
  const MAX_OVERALL_RANK = getOptionalNumberEnv('MAX_OVERALL_RANK', 10_000);

  // Kan endres om man får rate-limit problemer (lavere concurrency, høyere delay)
  const concurrency = getOptionalNumberEnv('EO_CONCURRENCY', 4);
  const requestDelayMs = getOptionalNumberEnv('EO_REQUEST_DELAY_MS', 75);

  const doFinalRetryPass = getOptionalBooleanEnv('EO_FINAL_RETRY_PASS', true);
  const finalRetryConcurrency = getOptionalNumberEnv('EO_FINAL_RETRY_CONCURRENCY', 1);
  const finalRetryDelayMs = getOptionalNumberEnv('EO_FINAL_RETRY_DELAY_MS', 250);

  console.log(
    `computeEO starting: gw=${gw}, base=${BASE_URL}, league=${OVERALL_LEAGUE_ID}, maxRank=${MAX_OVERALL_RANK}, concurrency=${concurrency}, requestDelayMs=${requestDelayMs}`
  );

  const gwExists = await prisma.gameweek.findUnique({ where: { id: gw } });
  if (!gwExists) {
    throw new Error(`Gameweek ${gw} not found in DB. Run syncGameweeks first.`);
  }

  const brackets = await prisma.bracket.findMany({
    where: { active: true },
    select: { id: true, name: true, rankFrom: true, rankTo: true },
    orderBy: [{ rankTo: 'asc' }], // viktig: gjør at "beste bracket" blir først
  });

  if (brackets.length === 0) {
    throw new Error(`No active brackets in DB. Run seedBrackets first.`);
  }

  console.log(
    `Loaded ${brackets.length} active brackets: ${brackets.map((b) => b.name).join(', ')}`
  );

  const entries = await fetchTopEntries(BASE_URL, OVERALL_LEAGUE_ID, MAX_OVERALL_RANK);

  const byBracket = new Map<number, Counts>();
  for (const b of brackets) {
    byBracket.set(b.id, {
      sampleSize: 0,
      ownedCount: new Map(),
      captainCount: new Map(),
      transferCostSum: 0,
      hitEntryCount: 0,
      chipTotalUsed: new Map(),
      chipUsedThisGw: new Map(),
    });
  }

  const failures: Array<{ entryId: number; rank: number; error: string }> = [];

  async function fetchEntryHistory(
    entryId: number,
    perRequestDelay: number
  ): Promise<{
    transferCost: number;
    chips: Array<{ name: string; event: number; time: string | null }>;
  }> {
    if (perRequestDelay > 0) await sleep(perRequestDelay);

    const url = `${BASE_URL}/api/entry/${entryId}/history/`;
    const data = await fetchJsonWithRetry<EntryHistoryResponse>(url, {
      headers: {
        'User-Agent': 'eliteserien-api/computeEO',
        Accept: 'application/json',
      },
    });

    const row = Array.isArray(data.current) ? data.current.find((r) => r.event === gw) : undefined;
    const v = row?.event_transfers_cost;
    const transferCost = typeof v === 'number' && Number.isFinite(v) ? v : 0;

    const chipsRaw = Array.isArray(data.chips) ? data.chips : [];
    const chips = chipsRaw
      .map((c) => {
        const name = typeof c?.name === 'string' ? c.name : null;
        const event = typeof c?.event === 'number' && Number.isFinite(c.event) ? c.event : null;
        const time = typeof c?.time === 'string' ? c.time : null;
        if (!name || event == null) return null;
        return { name, event, time };
      })
      .filter((x): x is { name: string; event: number; time: string | null } => x != null);

    return { transferCost, chips };
  }

  async function processEntry(entry: EntryInfo, perRequestDelay: number) {
    if (perRequestDelay > 0) await sleep(perRequestDelay);

    const picksUrl = `${BASE_URL}/api/entry/${entry.entryId}/event/${gw}/picks/`;
    const picksData = await fetchJsonWithRetry<PicksResponse>(picksUrl, {
      headers: {
        'User-Agent': 'eliteserien-api/computeEO',
        Accept: 'application/json',
      },
    });

    const picks = Array.isArray(picksData.picks) ? picksData.picks : [];

    // Bracket basert på overall_rank i DENNE GW (samme som du ønsket for sammenligningssiden)
    const overallRankThisGw =
      typeof picksData.entry_history?.overall_rank === 'number' &&
      Number.isFinite(picksData.entry_history.overall_rank)
        ? picksData.entry_history.overall_rank
        : null;

    // ✅ IKKE-disjunkt: entryen teller i ALLE bracketene den matcher (samme mønster som gammel fil)
    const memberBrackets = bracketsForRank(overallRankThisGw, brackets);
    if (memberBrackets.length === 0) return;

    // For ChipUsage (én rad per entry/gw/chip): velg "primær-bracket" = beste (lavest rankTo)
    const primaryBracketId = memberBrackets[0]!.id;

    const { transferCost, chips } = await fetchEntryHistory(entry.entryId, perRequestDelay);

    // Oppdater sampleSize + hits per bracket
    for (const b of memberBrackets) {
      const agg = byBracket.get(b.id)!;
      agg.sampleSize += 1;

      agg.transferCostSum += transferCost;
      if (transferCost > 0) agg.hitEntryCount += 1;
    }

    // Oppdater owned/captain counts per bracket
    for (const p of picks) {
      const playerId = p.element;
      if (typeof playerId !== 'number') continue;

      for (const b of memberBrackets) {
        const agg = byBracket.get(b.id)!;

        agg.ownedCount.set(playerId, (agg.ownedCount.get(playerId) ?? 0) + 1);

        if (p.is_captain === true) {
          agg.captainCount.set(playerId, (agg.captainCount.get(playerId) ?? 0) + 1);
        }
      }
    }

    // Chips: tell totals + denne runden per bracket (cumulative),
    // og upsert ChipUsage (kun én gang per chip brukt i denne GW)
    if (chips.length > 0) {
      for (const ch of chips) {
        const chipGw = ch.event;
        const chipKey = normalizeChipName(ch.name, chipGw);
        // totals: entryen teller i alle memberBrackets
        for (const b of memberBrackets) {
          const agg = byBracket.get(b.id)!;
          agg.chipTotalUsed.set(chipKey, (agg.chipTotalUsed.get(chipKey) ?? 0) + 1);

          if (ch.event === gw) {
            agg.chipUsedThisGw.set(chipKey, (agg.chipUsedThisGw.get(chipKey) ?? 0) + 1);
          }
        }

        if (typeof chipGw === 'number' && Number.isFinite(chipGw)) {
          const usedAt = ch.time ? new Date(ch.time) : null;

          try {
            const exists = await prisma.chipUsage.findUnique({
              where: {
                entryId_gameweekId_chipName: {
                  entryId: entry.entryId,
                  gameweekId: chipGw,
                  chipName: chipKey,
                },
              },
              select: { entryId: true },
            });

            if (!exists) {
              await prisma.chipUsage.create({
                data: {
                  entryId: entry.entryId,
                  gameweekId: chipGw,
                  bracketId: primaryBracketId, // (som før) bracket basert på rank i denne GW
                  chipName: chipKey,
                  points: null, // NULL = ikke beregnet enda
                  usedAt: usedAt ?? undefined,
                },
              });
            }
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.warn(
              `WARN: failed inserting ChipUsage entry=${entry.entryId} gw=${chipGw} chip=${chipKey}: ${msg}`
            );
          }
        }
      }
    }
  }

  let processedOk = 0;
  let skipped = 0;

  await asyncPool(entries, concurrency, async (entry, idx) => {
    try {
      await processEntry(entry, requestDelayMs);
      processedOk += 1;
    } catch (e) {
      skipped += 1;
      failures.push({
        entryId: entry.entryId,
        rank: entry.rank,
        error: e instanceof Error ? e.message : String(e),
      });
    }

    const done = processedOk + skipped;
    if (done % 200 === 0 || idx === entries.length - 1) {
      console.log(
        `Processed ${done}/${entries.length} entries... ok=${processedOk}, skipped=${skipped}`
      );
    }
  });

  // Retry-pass på slutten for de som feilet (lav concurrency + litt ekstra delay)
  if (doFinalRetryPass && failures.length > 0) {
    console.log(`Final retry pass: attempting ${failures.length} skipped entries...`);
    const retrySet = failures.map((f) => ({ entryId: f.entryId, rank: f.rank }));
    failures.length = 0;

    let retryOk = 0;
    let retrySkipped = 0;

    await asyncPool(retrySet, finalRetryConcurrency, async (entry, idx) => {
      try {
        await processEntry(entry, finalRetryDelayMs);
        retryOk += 1;
      } catch (e) {
        retrySkipped += 1;
        failures.push({
          entryId: entry.entryId,
          rank: entry.rank,
          error: e instanceof Error ? e.message : String(e),
        });
      }

      const done = retryOk + retrySkipped;
      if (done % 50 === 0 || idx === retrySet.length - 1) {
        console.log(
          `Retry pass progress ${done}/${retrySet.length}... ok=${retryOk}, stillFailed=${retrySkipped}`
        );
      }
    });

    console.log(`Final retry pass done. recovered=${retryOk}, stillFailed=${failures.length}`);
  }

  if (failures.length > 0) {
    const file = `computeEO_failed_gw${gw}.json`;
    await writeFile(file, JSON.stringify(failures, null, 2), 'utf-8');
    console.warn(`Some entries still failed after retries. Wrote ${failures.length} to ${file}`);
  }

  console.log('Finished fetching picks. Writing aggregates to DB...');

  const upsertChunkSize = 500;

  for (const b of brackets) {
    const agg = byBracket.get(b.id)!;
    const sampleSize = agg.sampleSize;

    if (sampleSize === 0) {
      console.warn(`Bracket ${b.name} has sampleSize=0. Skipping.`);
      continue;
    }

    const playerIds = new Set<number>();
    for (const k of agg.ownedCount.keys()) playerIds.add(k);
    for (const k of agg.captainCount.keys()) playerIds.add(k);

    const all = Array.from(playerIds);

    console.log(`Bracket ${b.name}: sampleSize=${sampleSize}, players=${all.length}`);

    // --- Baseline stats for spillestil (lagres i BracketGameweekStats) ---
    let avgCaptainEO: number | null = null;
    let avgTeamEO: number | null = null;

    // avgCaptainEO = Σ (p^2), p = captainCount/sampleSize
    {
      let sumCapSq = 0;
      let hasCap = false;

      for (const cnt of agg.captainCount.values()) {
        const p = cnt / sampleSize;
        sumCapSq += p * p;
        hasCap = true;
      }

      avgCaptainEO = hasCap ? sumCapSq : null;
    }

    // avgTeamEO = Σ (eo^2), eo = (ownedCount + captainCount) / sampleSize
    {
      let sumEoSq = 0;

      for (const playerId of all) {
        const ownedCount = agg.ownedCount.get(playerId) ?? 0;
        const captainCount = agg.captainCount.get(playerId) ?? 0;
        const eo = (ownedCount + captainCount) / sampleSize;
        sumEoSq += eo * eo;
      }

      avgTeamEO = sumEoSq;
    }

    const avgTransferCost = agg.transferCostSum / sampleSize;
    const hitRate = agg.hitEntryCount / sampleSize;

    const existing = await prisma.bracketGameweekStats.findUnique({
      where: {
        gameweekId_bracketId_version: {
          gameweekId: gw,
          bracketId: b.id,
          version: 1,
        },
      },
      select: { data: true },
    });

    const prevData = (existing?.data ?? {}) as Record<string, unknown>;

    const risk = {
      avgCaptainEO: avgCaptainEO == null ? null : roundTo(avgCaptainEO, 4),
      avgTeamEO: avgTeamEO == null ? null : roundTo(avgTeamEO, 4),
      avgTransferCost: roundTo(avgTransferCost, 4),
      hitRate: roundTo(hitRate, 4),
    };

    // Chips: totals (season) og denne runden, per chip
    const totalUsed: Record<string, number> = {};
    for (const [chipName, cnt] of agg.chipTotalUsed.entries()) totalUsed[chipName] = cnt;

    const usedThisGw: Record<string, number> = {};
    const usedThisGwRate: Record<string, number> = {};
    for (const [chipName, cnt] of agg.chipUsedThisGw.entries()) {
      usedThisGw[chipName] = cnt;
      usedThisGwRate[chipName] = roundTo(cnt / sampleSize, 4);
    }

    const chips = {
      totalUsed,
      usedThisGw,
      usedThisGwRate,
    };

    const nextData = { ...prevData, risk, chips };

    await prisma.bracketGameweekStats.upsert({
      where: {
        gameweekId_bracketId_version: {
          gameweekId: gw,
          bracketId: b.id,
          version: 1,
        },
      },
      create: {
        gameweekId: gw,
        bracketId: b.id,
        version: 1,
        sampleSize,
        data: nextData,
      },
      update: {
        sampleSize,
        data: nextData,
        computedAt: new Date(),
      },
    });

    for (let i = 0; i < all.length; i += upsertChunkSize) {
      const chunk = all.slice(i, i + upsertChunkSize);

      await prisma.$transaction(
        chunk.map((playerId) => {
          const ownedCount = agg.ownedCount.get(playerId) ?? 0;
          const captainCount = agg.captainCount.get(playerId) ?? 0;
          const eo = (ownedCount + captainCount) / sampleSize;

          return prisma.effectiveOwnership.upsert({
            where: {
              gameweekId_bracketId_playerId: {
                gameweekId: gw,
                bracketId: b.id,
                playerId,
              },
            },
            create: {
              gameweekId: gw,
              bracketId: b.id,
              playerId,
              eo,
              sampleSize,
              ownedCount,
              captainCount,
            },
            update: {
              eo,
              sampleSize,
              ownedCount,
              captainCount,
              computedAt: new Date(),
            },
          });
        })
      );

      console.log(
        `Upserted ${Math.min(i + upsertChunkSize, all.length)}/${all.length} rows for bracket ${b.name}...`
      );
    }
  }

  console.log('computeEO done.');
}

main()
  .catch((e) => {
    console.error('computeEO failed:', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
