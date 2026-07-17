import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Only the harness tests. The fixtures dir holds *.spec.ts files that are Playwright
    // specs, not vitest tests — they must never be collected here.
    include: ['test/**/*.test.ts'],
    // A real Playwright child run takes several seconds; give each test room.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Run the test FILES one at a time. Most files here spawn several real Playwright
    // child processes (each a browser) in parallel within their own beforeAll; running
    // multiple such files concurrently oversubscribes the CPU and makes page waits time
    // out — a browser-contention flake, not a product bug. Serializing files keeps each
    // heavy suite running alone (as it does in isolation) while the fast unit files cost
    // milliseconds. See project memory: "contended Engines".
    fileParallelism: false,
  },
});
