// The meeting-mode analysis pass (see meeting.ts): one cheap one-shot model
// call that reads the new transcript plus what the panel already shows and
// returns the updated Now / Discussed / Actions as JSON. Same shape as
// statusGen.ts, except a failure THROWS: the manager puts it on the panel.

import type { SdkBackend } from './sdkBackend.js';
import type { RunOnAccountWithCredit } from './accountFailover.js';
import { formatMeetingClock } from '@patch/wire';
import { MeetingAnalysis, type AnalyseInput } from './meeting.js';

export const MEETING_MODEL = 'claude-haiku-4-5-20251001';
const MEETING_TIMEOUT_MS = 60_000;

export function buildMeetingPrompt(input: AnalyseInput): string {
  const transcript = input.newLines.map((l) => `[${l.clock} ${l.speaker}] ${l.text}`).join('\n');
  return [
    'You are keeping live notes for a meeting the user is sitting in. "You" is the user (their microphone);',
    '"Them" is everyone else (system audio, speakers not separated). Transcripts are machine-made and can',
    'contain mistakes. Update the notes from the NEW transcript below.',
    '',
    `Meeting time so far: ${formatMeetingClock(input.elapsedMs)}`,
    '',
    'Notes so far (JSON):',
    JSON.stringify({
      now: input.previous.now,
      topics: input.previous.topics.map((t) => ({
        id: t.id,
        title: t.title,
        points: t.points,
        decided: t.decided,
      })),
      actions: input.previous.actions.map((a) => ({ title: a.title, status: a.status })),
    }),
    '',
    'NEW transcript:',
    transcript,
    '',
    'Reply with ONE JSON object and nothing else, with exactly these keys:',
    '{"now":{"headline":"one line on what is being discussed right now","bullets":["max 3 short bullets"],"who":"who has been speaking, or empty"},',
    ' "topics":[{"id":"existing topic id to update, or null for a new topic","title":"short","points":["short key points"],"decided":false,"atSeconds":0}],',
    ' "actions":[{"title":"imperative, specific, e.g. Top up Sam\'s sandbox credit by £50","why":"who said what that prompted it","atSeconds":0}],',
    ` "summary":${input.final ? '{"headline":"one-line outcome","bullets":["decisions, actions and open questions counts and gist"]}' : 'null'}}`,
    '',
    'Rules: only list topics that appear in the transcript; return only topics that are new or changed;',
    'set decided true only when the meeting clearly agreed something; actions are things the user could ask',
    'an assistant to do (look something up, create a ticket, send a message, top up credit) that were implied or',
    'asked for, never ones already in the notes; use [] when there are none. atSeconds is the meeting time in',
    'seconds the topic or action arose, from the transcript clock. Never invent facts.',
  ].join('\n');
}

/** First `{` to last `}` — models wrap JSON in prose or fences despite being told not to. */
export function parseMeetingAnalysis(raw: string): MeetingAnalysis {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start)
    throw new Error(`no JSON object in model reply: ${raw.slice(0, 120)}`);
  return MeetingAnalysis.parse(JSON.parse(raw.slice(start, end + 1)));
}

export function makeMeetingAnalyser(opts: {
  sdkBackend: SdkBackend;
  runOnAccountWithCredit: RunOnAccountWithCredit;
  cwd: string;
}): (input: AnalyseInput) => Promise<MeetingAnalysis> {
  return async function analyse(input) {
    const result = await opts.runOnAccountWithCredit(
      `meeting ${input.chatId}`,
      async (accessToken) => {
        const abortController = new AbortController();
        const timer = setTimeout(() => abortController.abort(), MEETING_TIMEOUT_MS);
        try {
          let finalText = '';
          let deltaText = '';
          for await (const env of opts.sdkBackend.run({
            prompt: buildMeetingPrompt(input),
            cwd: opts.cwd,
            resumeSessionId: undefined,
            abortController,
            oauthAccessToken: accessToken,
            model: MEETING_MODEL,
            permissionMode: 'bypassPermissions',
          })) {
            if (env.type === 'assistant' && env.content) finalText += env.content;
            else if (env.type === 'assistant_delta' && env.content) deltaText += env.content;
            else if (env.type === 'error')
              throw new Error(env.errorMessage ?? 'meeting: SDK error envelope');
          }
          return finalText !== '' ? finalText : deltaText;
        } finally {
          clearTimeout(timer);
        }
      },
    );
    if (result === null || result === undefined)
      throw new Error('no account could run the meeting analysis');
    return parseMeetingAnalysis(result);
  };
}
