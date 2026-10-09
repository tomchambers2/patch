import { defineConfig } from 'vitest/config';

// Root vitest config with project-per-package layout. Most packages run
// node:test today (pin-sharp dependency footprint); only @patch/web uses
// vitest directly. As more packages adopt vitest in later groups, add them
// to the projects list below — single source of truth.
export default defineConfig({
  test: {
    projects: ['packages/web/vitest.config.ts'],
  },
});
