// The desktop's node-side test suite (electron main-process code): the
// server-registry gateway runs outside the Angular renderer, so its specs
// need a node environment, not the unit-test builder's jsdom one.
// `npm run test:gateway`; `pnpm test` chains both suites.

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
