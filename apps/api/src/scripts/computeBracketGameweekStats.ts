import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

type Args = {
  gameweekId: number;
  version: number;
  dryRun: boolean;
};

function parseArgs(argv: string[]): Args {
  // Support:
  //   --gameweek 3
  //   --gameweek=3
  //   --version 1
  //   --dry-run
  const args: Record<string, string | boolean> = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (a.startsWith('--')) {
      const [k, v] = a.split('=', 2);
      const key = k.replace(/^--/, '');
      if (v !== undefined) {
        args[key] = v;
      } else {
        const next = argv[i + 1];
        if (next && !next.startsWith('--')) {
          args[key] = next;
          i++;
        } else {
          args[key] = true;
        }
      }
    }
  }

  const gameweekRaw = args['gameweek'] ?? args['gw'];
  if (typeof gameweekRaw !== 'string') {
    throw new Error('Missing --gameweek <id> (or --gw <id>)');
  }

  const gameweekId = Number(gameweekRaw);
  if (!Number.isInteger(gameweekId) || gameweekId <= 0) {
    throw new Error(`Invalid --gameweek value: ${gameweekRaw}`);
  }

  const versionRaw = args['version'];
  const version = typeof versionRaw === 'string' ? Number(versionRaw) : 1;
  if (!Number.isInteger(version) || version <= 0) {
    throw new Error(`Invalid --version value: ${String(versionRaw)}`);
  }

  const dryRun = args['dry-run'] === true || args['dryRun'] === true;

  return { gameweekId, version, dryRun };
}

type Agg = {
  sampleSize: number;
  sumCaptainShareSq: number;
  hasCaptainData: boolean;
  sumEoSq: number;
};

async function main() {
  const { gameweekId, version, dryRun } = parseArgs(process.argv);

  console.log(
    `Computing BracketGameweekStats for gameweek=${gameweekId}, version=${version}, dryRun=${dryRun}`
  );

  // Hent alle EffectiveOwnership-rader for gameweekId, med de feltene vi trenger for å aggregere.
  const rows = await prisma.effectiveOwnership.findMany({
    where: { gameweekId },
    select: {
      bracketId: true,
      eo: true,
      captainCount: true,
      sampleSize: true,
    },
  });

  if (rows.length === 0) {
    console.log(`No EffectiveOwnership rows found for gameweek=${gameweekId}. Nothing to do.`);
    return;
  }

  // group by bracketId
  const byBracket = new Map<number, Agg>();

  for (const r of rows) {
    const bracketId = r.bracketId;
    let agg = byBracket.get(bracketId);
    if (!agg) {
      agg = {
        sampleSize: r.sampleSize,
        sumCaptainShareSq: 0,
        hasCaptainData: false,
        sumEoSq: 0,
      };
      byBracket.set(bracketId, agg);
    }

    // avgTeamEO baseline: Σ eo^2
    const eo = r.eo ?? 0;
    agg.sumEoSq += eo * eo;

    // avgCaptainEO baseline: Σ (captainShare^2), captainShare = captainCount/sampleSize
    if (typeof r.captainCount === 'number' && r.sampleSize > 0) {
      const p = r.captainCount / r.sampleSize;
      agg.sumCaptainShareSq += p * p;
      agg.hasCaptainData = true;
    }
  }

  const toInsert = Array.from(byBracket.entries()).map(([bracketId, agg]) => {
    const avgTeamEO = agg.sumEoSq;

    const avgCaptainEO = agg.hasCaptainData ? agg.sumCaptainShareSq : null;

    const data = {
      risk: {
        avgCaptainEO,
        avgTeamEO,
      },
    };

    return {
      gameweekId,
      bracketId,
      version,
      sampleSize: agg.sampleSize,
      data,
    };
  });

  console.log(`Computed stats for ${toInsert.length} brackets.`);
  console.log(
    `Example (first):`,
    JSON.stringify(
      {
        bracketId: toInsert[0]?.bracketId,
        sampleSize: toInsert[0]?.sampleSize,
        data: toInsert[0]?.data,
      },
      null,
      2
    )
  );

  if (dryRun) {
    console.log('Dry-run enabled; not writing to DB.');
    return;
  }

  await prisma.$transaction([
    prisma.bracketGameweekStats.deleteMany({
      where: { gameweekId, version },
    }),
    prisma.bracketGameweekStats.createMany({
      data: toInsert,
    }),
  ]);

  console.log(
    `Done. Upsert-like refresh completed for gameweek=${gameweekId}, version=${version} (${toInsert.length} rows).`
  );
}

main()
  .catch((e) => {
    console.error('computeBracketGameweekStats failed:', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
