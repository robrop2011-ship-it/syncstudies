/**
 * Development seed. Creates two accounts and one room so `pnpm dev` has
 * something to look at immediately.
 *
 * Both users have the password `studytogether1`.
 */
import { PrismaClient } from '@prisma/client';
import { uuidv7, generateRoomCode } from '@syncstudy/shared';
import { hashPassword } from '@syncstudy/auth';

const prisma = new PrismaClient();

async function main() {
  const password = await hashPassword('studytogether1');

  const priya = await prisma.user.upsert({
    where: { handle: 'priya' },
    update: {},
    create: {
      id: uuidv7(),
      handle: 'priya',
      displayName: 'Priya',
      passwordHash: password,
      school: 'State University',
      settings: { create: {} },
    },
  });

  const sam = await prisma.user.upsert({
    where: { handle: 'sam' },
    update: {},
    create: {
      id: uuidv7(),
      handle: 'sam',
      displayName: 'Sam',
      passwordHash: password,
      settings: { create: {} },
    },
  });

  const existing = await prisma.room.findFirst({ where: { hostId: priya.id } });
  if (!existing) {
    const room = await prisma.room.create({
      data: {
        id: uuidv7(),
        code: generateRoomCode(),
        name: 'Organic Chem — Ch. 7',
        topic: 'Alkene reactions',
        hostId: priya.id,
        participants: {
          create: [
            { userId: priya.id, role: 'host' },
            { userId: sam.id, role: 'member' },
          ],
        },
        videoState: { create: {} },
        notes: { create: {} },
      },
    });
    console.log(`seeded room ${room.name} → code ${room.code}`);
  }

  console.log('seed complete. login: priya / studytogether1');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
