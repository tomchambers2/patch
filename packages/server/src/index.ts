// Entry point for the patch-server process.

import { loadConfig } from './config.js';
import { startServer } from './start.js';

startServer(loadConfig()).catch((err: unknown) => {
  console.error('[patch-server] fatal:', err);
  process.exit(1);
});
