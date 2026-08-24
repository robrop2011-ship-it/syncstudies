import { defineConfig } from 'vitest/config';

/**
 * Unit tests for the contract package (PLAN.md §15.1).
 *
 * Everything here is pure: no database, no network, no timers of consequence.
 * That is the point — this package is the one place the client and the server
 * share logic, so its tests have to be fast enough that nobody is tempted to skip
 * them, and deterministic enough that a red run means a real regression.
 *
 * Coverage target for this package is ≥85%. It is not enforced here because the
 * v8 coverage provider is a separate dependency; run it with
 * `pnpm dlx @vitest/coverage-v8` in place when you want the number.
 */
export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.ts'],
    environment: 'node',
    // Explicit imports from 'vitest' rather than globals, so the tsconfig here
    // needs no extra `types` entry and the imports are visible in each file.
    globals: false,
    testTimeout: 5_000,
    restoreMocks: true,
  },
});
