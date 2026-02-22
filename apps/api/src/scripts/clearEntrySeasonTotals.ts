import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const args = process.argv.slice(2);

  // Bruk:
  //   tsx .../clearEntrySeasonTotals.ts --all
  //   tsx .../clearEntrySeasonTotals.ts --entryId 20910

  const allFlag = args.indexOf('--all');
  const entryIdFlag = args.indexOf('--entryId');

  if (entryIdFlag !== -1) {
    const entryId = Number(args[entryIdFlag + 1]);
    if (!Number.isFinite(entryId)) {
      console.log('Ugyldig --entryId <num>');
      return;
    }

    const deleted = await prisma.entrySeasonTotals.deleteMany({ where: { entryId } });
    console.log('deleted EntrySeasonTotals rows', { entryId, count: deleted.count });
    return;
  }

  if (allFlag !== -1) {
    const deleted = await prisma.entrySeasonTotals.deleteMany();
    console.log('deleted EntrySeasonTotals rows', { count: deleted.count });
    return;
  }

  console.log('Bruk enten --all eller --entryId <num>');
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
