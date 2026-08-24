import { defineConfig } from 'vitest/config';

/**
 * Unit tests for the auth package (PLAN.md §15.1, Phase 2 testing notes).
 *
 * No database: `packages/auth/src/session.ts` imports the Prisma client, so the
 * session suite stubs `@syncstudy/db` at the module boundary and exercises only
 * the framework-free helpers. Everything else here is pure or hashing.
 *
 * testTimeout is 20 s on purpose. argon2id is configured at the OWASP 2024
 * baseline (19 MiB, t=2) and each hash costs tens of milliseconds; a suite that
 * hashes a dozen times can drift past the 5 s default on a loaded CI runner. The
 * correct response is a longer timeout, never weaker parameters — the parameters
 * are the security property under test.
 */
export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.ts'],
    environment: 'node',
    globals: false,
    testTimeout: 20_000,
    hookTimeout: 20_000,
    restoreMocks: true,
  },
});
