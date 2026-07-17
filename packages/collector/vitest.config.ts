import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Only the harness tests. The fixtures dir holds *.spec.ts files that are Playwright
    // specs, not vitest tests — they must never be collected here.
    include: ['test/**/*.test.ts'],
    // A real Playwright child run takes several seconds; give each test room.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
