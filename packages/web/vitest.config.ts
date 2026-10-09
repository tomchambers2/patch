import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { readBuildInfo, buildInfoDefines } from './build-info';

export default defineConfig({
  plugins: [react()],
  // Same `__PATCH_*__` literals the real build injects, so src/lib/buildInfo.ts
  // resolves under test instead of throwing ReferenceError.
  define: buildInfoDefines(readBuildInfo()),
  test: {
    name: '@patch/web',
    environment: 'jsdom',
    globals: false,
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/__tests__/setup.ts'],
    // A few real-timer `waitFor` UI tests (e.g. AppShell's ⌘N route-mount +
    // rAF-deferred focus) settle slowly when the worker is starved under
    // full-suite parallel load, flaking intermittently even though the behaviour
    // is correct. Retry on failure so load — not logic — never decides the
    // result; a genuinely broken test still fails every attempt.
    retry: 2,
    // Room for the widened `asyncUtilTimeout` (src/__tests__/setup.ts) to play
    // out: a test with two slow-path `waitFor`s must fail on its own assertion,
    // not be cut off by the 5s default and reported as a timeout instead.
    testTimeout: 10_000,
    coverage: {
      provider: 'v8',
      all: true,
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        '**/*.d.ts',
        '**/__tests__/**',
        'src/main.tsx',
        'src/dev-harness.tsx',
        'src/vite-env.d.ts',
      ],
      thresholds: {
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      },
    },
  },
});
