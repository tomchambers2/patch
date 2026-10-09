import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // I/O-integration suite (spawns real sidecars, boots UDS/WSS). Transient
    // timing misses under machine load retry rather than fail the whole run; a
    // real regression still fails every attempt.
    retry: 2,
    coverage: {
      provider: 'v8',
      all: true,
      include: ['src/**/*.ts'],
      exclude: [
        '**/*.d.ts',
        'dist/**',
        // CLI entrypoint: process-bootstrap script launched as a child
        // process by the Claude Code SDK. Its own body is argv-branching +
        // process.exit(), and it delegates all real logic to mcp.ts (which
        // is fully unit tested).
        'src/bin/**',
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
