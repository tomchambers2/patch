// Regenerate the macOS menu-bar (tray) template icons from the shared brand
// "p" mark. Run with `pnpm gen:tray`. The committed PNGs under build/ must
// always equal this output — src/tray-icon.test.ts enforces it.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderTrayTemplate, encodeGrayAlphaPng } from '../src/tray-icon';

const buildDir = join(__dirname, '..', 'build');

for (const [file, size] of [
  ['trayIconTemplate.png', 16],
  ['trayIconTemplate@2x.png', 32],
] as const) {
  const out = join(buildDir, file);
  writeFileSync(out, encodeGrayAlphaPng(renderTrayTemplate(size)));
  console.log(`wrote ${out} (${size}×${size})`);
}
