import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

type BracketSeed = {
  name: string;
  rankFrom: number;
  rankTo: number;
};

const BRACKETS: BracketSeed[] = [
  { name: 'Top 100', rankFrom: 1, rankTo: 100 },
  { name: 'Top 500', rankFrom: 1, rankTo: 500 },
  { name: 'Top 2k', rankFrom: 1, rankTo: 2000 },
  { name: 'Top 5k', rankFrom: 1, rankTo: 5000 },
  { name: 'Top 10k', rankFrom: 1, rankTo: 10000 },
];

async function main() {
  let upserted = 0;

  for (const b of BRACKETS) {
    await prisma.bracket.upsert({
      where: {
        // Prisma lager default navn på composite unique: rankFrom_rankTo
        rankFrom_rankTo: { rankFrom: b.rankFrom, rankTo: b.rankTo },
      },
      update: { name: b.name, active: true },
      create: { name: b.name, rankFrom: b.rankFrom, rankTo: b.rankTo, active: true },
    });

    upserted += 1;
    console.log(`Upserted ${upserted}/${BRACKETS.length}: ${b.name} (${b.rankFrom}-${b.rankTo})`);
  }

  console.log('Done seeding brackets.');
}

main()
  .catch((e) => {
    console.error('seedBrackets failed:', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
