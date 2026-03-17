// apps/api/src/scripts/syncEntryInsights.ts
import { PrismaClient } from '@prisma/client';
import { computeEntryInsights } from '../services/computeEntryInsights';

const prisma = new PrismaClient();

function toInt(v: string | undefined): number | null {
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function main() {
  const entryId = toInt(process.env.ENTRY_ID) ?? toInt(process.argv[2]);
  if (!entryId) {
    throw new Error('Missing ENTRY_ID. Use: pnpm --filter api data:sync-entry-insights -- 12345');
  }

  const data = await computeEntryInsights(prisma, entryId);

  console.log(
    `Computed insights for entry ${entryId}. computedThroughGw=${data?.meta?.computedThroughGw ?? '??'}`
  );
  console.log(JSON.stringify(data, null, 2));
}

main()
  .catch((e) => {
    console.error('syncEntryInsights failed:', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
