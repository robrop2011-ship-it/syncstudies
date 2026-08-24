import { PrismaClient } from '@prisma/client';

export * from '@prisma/client';

/**
 * Single Prisma instance per process.
 *
 * Next.js dev reloads modules on every edit; without the global cache you leak a
 * connection pool per reload and exhaust Postgres within a few minutes.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
