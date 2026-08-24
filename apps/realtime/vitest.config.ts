import { defineConfig } from 'vitest/config';

/**
 * Unit tests only — these must run with no Postgres and no Redis, so CI and a
 * laptop with nothing booted behave identically. Anything that needs a live
 * dependency belongs in the integration suite (PLAN.md §15.1).
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts'],
    passWithNoTests: false,
  },
});
