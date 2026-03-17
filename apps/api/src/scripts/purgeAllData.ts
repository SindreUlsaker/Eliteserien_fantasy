import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

function hasConfirmFlag(): boolean {
  return process.argv.includes('--yes-i-know-this-deletes-everything');
}

function hasConfirmEnv(): boolean {
  return process.env.CONFIRM_SEASON_PURGE === 'YES';
}

async function main() {
  const confirmed = hasConfirmFlag() || hasConfirmEnv();

  if (!confirmed) {
    console.error('Refusing to run without explicit confirmation.');
    console.error('Use either:');
    console.error('  1) --yes-i-know-this-deletes-everything');
    console.error('  2) CONFIRM_SEASON_PURGE=YES');
    process.exitCode = 1;
    return;
  }

  console.log('Purging all application data tables...');

  // Truncate in one statement to handle FK dependencies efficiently.
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "EntryPick",
      "EntryGameweek",
      "EntryInsights",
      "EntrySeasonTotals",
      "ChipUsage",
      "EffectiveOwnership",
      "PlayerGameweekStats",
      "BracketStats",
      "JobSchedule",
      "Entry",
      "Player",
      "Team",
      "Gameweek",
      "Bracket"
    RESTART IDENTITY CASCADE;
  `);

  console.log('Done. All application data has been removed.');
}

main()
  .catch((e) => {
    console.error('purgeAllData failed:', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
