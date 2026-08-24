import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

/**
 * Unit tests for the pure helpers behind the route handlers.
 *
 * Deliberately narrow: no jsdom, no React, no database. These cover functions
 * with inputs and outputs — which is why they were pulled out of the handlers in
 * the first place. Component and end-to-end coverage is Playwright's job
 * (PLAN.md §15.4), not this runner's.
 */
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: 'node',
    include: ['{app,lib,components}/**/__tests__/**/*.test.ts'],
  },
});
