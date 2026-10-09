// Turns a batch of visual changes into the message a chat receives.
//
// The receiving agent has only this text to go on, so each line names the
// element the way it can find it in source (label = tag, test id / id / class,
// and its own text) and says what Tom did in plain terms. The agent translates
// intent into code; the pixel numbers are evidence, not instructions.

import type { Change, PadRecord } from './store.js';
import type { Screen } from './screens.js';

export function phrase(dx: number, dy: number): string {
  const parts: string[] = [];
  if (dx) parts.push(`${Math.abs(dx)}px ${dx > 0 ? 'right' : 'left'}`);
  if (dy) parts.push(`${Math.abs(dy)}px ${dy > 0 ? 'down' : 'up'}`);
  return parts.join(', ') || 'not at all';
}

const clip = (s: string, n = 200): string => (s.length > n ? `${s.slice(0, n)}…` : s);

export function describeChange(c: Change): string {
  const on = c.target.label + (c.target.context ? ` (in ${c.target.context})` : '');
  const a = c as Record<string, any>;
  switch (c.kind) {
    case 'move':
      return `Moved ${on} ${phrase(a['dx'], a['dy'])}`;
    case 'resize':
      return `Resized ${on} from ${a['fromWidth']}×${a['fromHeight']} to ${a['width']}×${a['height']}px`;
    case 'text':
      return `Changed the text of ${on} from "${clip(a['before'])}" to "${clip(a['after'])}"`;
    case 'delete':
      return `Deleted ${on}`;
    case 'duplicate':
      return `Duplicated ${on} — the copy goes straight after it; later changes may refer to the copy`;
    case 'note':
      return `Note on ${on}: "${clip(a['text'], 1000)}"`;
    case 'draw':
      return `Drew on ${on}${a['over']?.length ? ` (the stroke crosses ${a['over'].join(', ')})` : ''} — see the picture`;
    default:
      throw new Error(`unknown change kind ${String(c.kind)}`);
  }
}

export interface PicturePlan {
  n: number;
  /** Absolute URL the agent can fetch the picture from. */
  url?: string;
  problem?: string;
}

export function batchMessage(opts: {
  pad: PadRecord;
  changes: Change[];
  screens: Screen[];
  pictures: PicturePlan[];
}): string {
  const { pad, changes, screens, pictures } = opts;
  const lines: string[] = [];
  let current: string | undefined;
  changes.forEach((c, i) => {
    if (c.screen !== current) {
      current = c.screen;
      const s = screens.find((x) => x.id === c.screen);
      lines.push(
        s ? `Screen "${s.name}" (${s.path}):` : `Screen "${c.screen}" (no longer in the pad):`,
      );
    }
    const pic = pictures.find((p) => p.n === i + 1);
    lines.push(`${i + 1}. ${describeChange(c)}`);
    lines.push(
      pic?.url ? `   picture: ${pic.url}` : `   no picture: ${pic?.problem ?? 'none was drawn'}`,
    );
    lines.push(`   selector: ${c.target.selector}`);
  });
  return [
    `[Pad] Tom sent ${changes.length} change${changes.length === 1 ? '' : 's'} on "${pad.name}" (pad id: ${pad.id})`,
    '',
    ...lines,
    '',
    'Each picture shows the change on its screen at the size Tom was looking at, marked and numbered. They',
    'show what surrounds each change, which the text cannot.',
    '',
    'Moves, resizes, text edits and deletions are previews Tom made on the Pad. Make each one real in the',
    'source, in the idiom the code already uses. Notes are requests in his own words.',
    '',
    'Open each picture, make the changes in the source, then call patch_pad_update(padId, dir) and patch_pad_reply(padId, text)',
  ].join('\n');
}
