// tsc does not copy the Pad editor's static files (editor.html/js/css, the
// in-page annotate script); put them beside the compiled routes.
import { cpSync } from 'node:fs';
cpSync(new URL('../src/pads/public', import.meta.url), new URL('../dist/pads/public', import.meta.url), {
  recursive: true,
});
