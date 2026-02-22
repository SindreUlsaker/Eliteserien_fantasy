// apps/api/src/scripts/seedBrackets.ts
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Disjunkte bracket-intervaler (inkluderende grenser)
const BRACKETS: Array<{ name: string; rankFrom: number; rankTo: number }> = [
  { name: '1-100', rankFrom: 1, rankTo: 100 },
  { name: '101-500', rankFrom: 101, rankTo: 500 },
  { name: '501-1000', rankFrom: 501, rankTo: 1000 },
  { name: '1001-2000', rankFrom: 1001, rankTo: 2000 },
  { name: '2001-3000', rankFrom: 2001, rankTo: 3000 },
  { name: '3001-5000', rankFrom: 3001, rankTo: 5000 },
  { name: '5001-7000', rankFrom: 5001, rankTo: 7000 },
  { name: '7001-10000', rankFrom: 7001, rankTo: 10000 },
];

async function main() {
  // Siden appen ikke er live: enklest å wipe og re-seed rent.
  // Dette gjør scriptet idempotent: samme resultat uansett hvor mange ganger du kjører.
  await prisma.bracket.deleteMany();

  await prisma.bracket.createMany({
    data: BRACKETS.map((b) => ({
      name: b.name,
      rankFrom: b.rankFrom,
      rankTo: b.rankTo,
      active: true,
    })),
  });

  const count = await prisma.bracket.count();
  console.log(`Seeded brackets: ${count}`);
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
