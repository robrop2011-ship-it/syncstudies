import { defineConfig } from 'vitest/config';

/**
 * The integration layer (PLAN.md §15.1).
 *
 * Separate from `vitest.config.ts` because these need real Postgres and real
 * Redis, and `pnpm test` must stay runnable with no services — a unit suite that
 * silently depends on a database is a unit suite that fails on a clean machine.
 *
 * `singleThread` because every file boots a server that binds a port, joins the
 * Redis adapter, and takes leader leases. Running them in parallel would have
 * two harnesses electing each other's leaders and stepping on the same rooms.
 */
export default defineConfig({
  test: {
    include: ['src/__integration__/**/*.test.ts'],
    // A suite that boots a server, migrates nothing and talks to two services
    // needs more than the 5s default before its first assertion.
    testTimeout: 30_000,
    hookTimeout: 40_000,
    poolOptions: { threads: { singleThread: true } },
    fileParallelism: false,
  },
});
