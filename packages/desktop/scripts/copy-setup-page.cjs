// The first-run page is a static file the shell loads straight off disk; it rides
// in dist/ beside main.js (electron-builder packs dist/**).
const { copyFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
copyFileSync(join(root, 'src/setup/setup.html'), join(root, 'dist/setup.html'));
