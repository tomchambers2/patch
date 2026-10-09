// A short briefing on the chat a call is on, put in the fast voice's instructions
// (spec/07 § Keeping voice and text as one conversation). A raw transcript replayed as
// prior turns did not work: a chat with hundreds of short status lines and long technical
// messages came back as "this is just a new chat". The voice needs to know what the chat
// is, how it began and what has just been happening, in a form it reads as background.

/** One piece of the chat, oldest first. A leading `(…)` turn is a header line (title, opening). */
export interface BriefingTurn {
  role: 'user' | 'model';
  text: string;
}

/** The longest any one message is shown for. */
const PER_MESSAGE_CHARS = 450;
/** The most recent exchange the briefing carries, in characters. */
const RECENT_CHARS = 7_000;

const squash = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
};

/** The briefing, or an empty string for a chat with nothing in it yet. */
export function chatBriefing(turns: BriefingTurn[]): string {
  const header = turns.filter((t) => t.text.startsWith('(')).map((t) => t.text);
  const body = turns.filter((t) => !t.text.startsWith('('));
  if (header.length === 0 && body.length === 0) return '';
  const recent: string[] = [];
  let used = 0;
  for (let i = body.length - 1; i >= 0; i--) {
    const t = body[i]!;
    const line = `${t.role === 'user' ? 'User' : 'Agent'}: ${squash(t.text, PER_MESSAGE_CHARS)}`;
    if (used + line.length > RECENT_CHARS) break;
    used += line.length;
    recent.push(line);
  }
  recent.reverse();
  return (
    'BACKGROUND — what this conversation is. The user is on a call about this chat. When they ask ' +
    'what the chat is about, what has been happening or what you were doing, answer from this; it ' +
    'is the real history, not a new chat.\n' +
    [
      ...header,
      ...(recent.length > 0 ? ['Most recent messages, oldest first:', ...recent] : []),
    ].join('\n')
  );
}

/** The voice's instructions with the briefing (if any) after them. */
export function withBriefing(instruction: string, briefing: string): string {
  return briefing === '' ? instruction : `${instruction}\n\n${briefing}`;
}
