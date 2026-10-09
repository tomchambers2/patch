import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 10_000,
    // I/O-integration suite: some tests wait on real OS filesystem-watch
    // (chokidar) events, whose latency spikes under machine load and can miss an
    // 8s poll deadline. Retry absorbs those transient misses; a real regression
    // still fails all attempts.
    retry: 2,
    coverage: {
      provider: 'v8',
      all: true,
      include: ['src/**/*.ts'],
      exclude: [
        '**/*.d.ts',
        'dist/**',
        'src/scripts/**' /* one-shot operator CLIs, not runtime */,
        'src/index.ts' /* process bootstrap: real listeners/signal handlers, not unit-testable */,
      ],
      thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 },
    },
  },
});
