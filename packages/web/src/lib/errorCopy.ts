// Machine-readable failures, said in words.
//
// The server and the host answer codes (`oauth_unavailable`,
// `no_model_catalogue`, `folder_not_found`) and sometimes a paragraph written
// for whoever wrote the host — "machine dev-daemon-1 has never read a model
// catalogue, so it has no last-used model; name a model on the spawn or connect
// the backend credential on that machine". Neither is something a person can
// act on: one names the fault to a program, the other explains the host's
// internals to its author.
//
// So every surface that reports one renders ONE plain sentence saying what to
// do next, and keeps the original code + message as `detail` behind a
// collapsed disclosure. NO FALLBACK: nothing is swallowed or defaulted away —
// the failure state is unchanged and the original text is still on screen, one
// click down, for reporting and debugging.

/**
 * Where the failure happened. The same code can want a different next step
 * depending on what the user was doing, so the copy table carries the
 * exception rather than the call sites diverging.
 */
export type ErrorSite = 'models' | 'spawn';

export interface HumanError {
  /** One plain sentence saying what to do next. Never contains a raw code. */
  sentence: string;
  /** The original code + message, for the details disclosure. '' when there was none. */
  detail: string;
}

interface Copy {
  sentence: string;
  /** Overrides `sentence` when the failure blocked a spawn. */
  onSpawn?: string;
}

// Ordered: the first code found in the failure wins. Matching is by substring
// because the code arrives sometimes as the whole string, sometimes embedded in
// a longer message.
const CODES: ReadonlyArray<readonly [string, Copy]> = [
  [
    'oauth_unavailable',
    { sentence: 'That machine isn’t signed in to Claude. Sign in from Settings → Hosts.' },
  ],
  [
    'unauthenticated',
    { sentence: 'That machine isn’t signed in to Claude. Sign in from Settings → Hosts.' },
  ],
  [
    'account_not_found',
    {
      sentence: 'That Claude account is no longer connected. Pick another in Settings → Hosts.',
    },
  ],
  [
    'no_model_catalogue',
    {
      sentence: 'That machine hasn’t read a model list yet.',
      onSpawn: 'Pick a model before starting the chat.',
    },
  ],
  ['no_machine_chosen', { sentence: 'Choose a machine. The model list comes from it.' }],
  ['unknown_host', { sentence: 'That machine is no longer registered. Pick another one.' }],
  ['folder_not_found', { sentence: 'That folder isn’t on that machine. Pick another project.' }],
  ['chat_not_found', { sentence: 'That chat is gone. Start a new one.' }],
];

// An unrecognised code is never interpolated into the sentence — it goes in the
// details alone, so a person always reads English.
const GENERIC: Record<ErrorSite, string> = {
  models: 'Couldn’t load the model list for that machine. Try again in a moment.',
  spawn: 'Couldn’t start the chat. Try again in a moment.',
};

/**
 * Turn a failure into one sentence plus its keepable detail.
 *
 * `code` is the machine-readable code where the caller has one separately
 * (a `chat.error`'s `errorCode`, a REST body's `error`); `message` is the prose
 * that came with it. Either may be absent.
 */
export function humaniseError(
  failure: { code?: string | undefined; message?: string | undefined },
  site: ErrorSite,
): HumanError {
  const code = (failure.code ?? '').trim();
  const message = (failure.message ?? '').trim();
  const detail =
    code !== '' && message !== '' && code !== message ? `${code}: ${message}` : code || message;
  const haystack = `${code} ${message}`;
  for (const [needle, copy] of CODES) {
    if (haystack.includes(needle)) {
      return { sentence: (site === 'spawn' && copy.onSpawn) || copy.sentence, detail };
    }
  }
  return { sentence: GENERIC[site], detail };
}

/**
 * The sentence for a failed action that has no code table entry — "Archive
 * failed. Try again." — so a toast reads as English and the thrown message
 * travels in the Details disclosure beside it (`pushError`'s third argument).
 */
export function failed(what: string): string {
  return `${what.charAt(0).toUpperCase()}${what.slice(1)} failed. Try again.`;
}
