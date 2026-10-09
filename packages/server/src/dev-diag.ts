// DEV/TEST-ONLY diagnostic seams for the special-threads (D1) e2e tests.
//
// These routes exist ONLY to make TD1's encoded behaviours exercisable against
// the dev stack where there is no physical voice device to stream real audio.
// They are:
//
//   POST /internal/diag/voice-device/transcript
//       Inject a voice-device transcript into the Speakers thread, tagged with
//       a deviceId (e.g. 'kitchen') — stands in for a physical HA Voice PE unit
//       streaming audio. Mirrors routeVoiceDeviceTranscript().  (D1-6 ingress)
//
//   GET  /internal/diag/speakers/sent
//       Read the SpeakersTtsRecorder's recorded speakers-channel notifies — so
//       a test can assert the Speakers thread's direct reply auto-routed as TTS
//       to the originating device.  (D1-6)
//
// HARD GATE: registerDevDiagRoutes is only ever called from app.ts when
//   process.env.NODE_ENV !== 'production'  AND  a dev seam flag is set.
// Every route additionally requires the X-Patch-Internal-Token header to match
// the server's internalToken, so even in dev these are not openly callable.

import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { SpeakersTtsRecorder } from './notifications/router.js';
import type { DaemonLink } from './daemon-link.js';
import { routeVoiceDeviceTranscript } from './notifications/routes.js';
import type { CronScheduler } from './jobs/cron.js';
import type { CallOrchestrator } from './notifications/call-orchestrator.js';
import type { WsHub } from './ws-hub.js';

export interface SpeakersTtsRecord {
  ts: number;
  chatId: string;
  deviceId?: string;
  message: string;
}

/** In-memory recorder for speakers-channel notifies (dev/test only). */
export class InMemorySpeakersRecorder implements SpeakersTtsRecorder {
  private readonly entries: SpeakersTtsRecord[] = [];
  record(entry: SpeakersTtsRecord): void {
    this.entries.push(entry);
  }
  recorded(): readonly SpeakersTtsRecord[] {
    return this.entries;
  }
}

export interface DevDiagDeps {
  logger: Logger;
  daemonLink: DaemonLink;
  internalToken: string;
  speakersRecorder?: InMemorySpeakersRecorder;
  idGenerator?: () => string;
  /**
   * Call orchestrator — drives the agent-initiated incoming-call path (G5-10).
   * The dev web surface is `kind: web`, which the orchestrator's ringer fanout
   * deliberately excludes (`RINGER_KINDS = {mobile, desktop}`), so the
   * incoming-call diag route below ALSO delivers the ring straight to the web
   * surface via `wsHub` so the `MANAGER IS CALLING` banner is exercisable
   * against the dev stack.
   */
  callOrchestrator?: CallOrchestrator;
  wsHub?: WsHub;
}

const TranscriptBody = z
  .object({
    deviceId: z.string().min(1).max(64),
    transcript: z.string().min(1).max(8192),
  })
  .strict();

const DeviceSessionBody = z
  .object({
    deviceId: z.string().min(1).max(64),
    name: z.string().min(1).max(64),
    active: z.boolean(),
  })
  .strict();

const IncomingCallBody = z
  .object({
    chatId: z.string().min(1).max(128),
    message: z.string().min(1).max(512).optional(),
  })
  .strict();

const PermissionRequestBody = z
  .object({
    chatId: z.string().min(1).max(128),
    tool: z.string().min(1).max(64).optional(),
    description: z.string().min(1).max(512).optional(),
  })
  .strict();

const VoiceInjectBody = z
  .object({
    surfaceId: z.string().min(1).max(128),
    text: z.string().min(1).max(8192),
  })
  .strict();

export function registerDevDiagRoutes(app: FastifyInstance, deps: DevDiagDeps): void {
  deps.logger.warn(
    {},
    'DEV/TEST diagnostic routes mounted at /internal/diag/* — MUST NOT appear in production',
  );

  // DEV-ONLY CORS for the diag seams. The e2e harness sometimes needs to fire a
  // diag call from inside the web page (e.g. to time a mid-TTS barge-in to the
  // millisecond, which a separate out-of-page round-trip is too slow to hit).
  // Scoped to `/internal/diag/*`, behind the same off-production gate as the
  // routes themselves, and still requiring the internal-token header — so this
  // opens nothing a token-less caller could use. Never reachable in production.
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/internal/diag/')) return;
    const origin = req.headers.origin;
    if (typeof origin === 'string') reply.header('access-control-allow-origin', origin);
    reply.header('access-control-allow-headers', 'content-type, x-patch-internal-token');
    reply.header('access-control-allow-methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') {
      return reply.code(204).send();
    }
  });

  const auth = (token: unknown): boolean =>
    typeof token === 'string' && token.length > 0 && token === deps.internalToken;

  app.post('/internal/diag/voice-device/transcript', async (req, reply) => {
    if (!auth(req.headers['x-patch-internal-token'])) {
      return reply.code(401).send({ error: 'bad internal token' });
    }
    const parsed = TranscriptBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid body', issues: parsed.error.issues });
    }
    routeVoiceDeviceTranscript({
      deviceId: parsed.data.deviceId,
      transcript: parsed.data.transcript,
      daemonLink: deps.daemonLink,
      ...(deps.idGenerator ? { idGenerator: deps.idGenerator } : {}),
    });
    deps.logger.info(
      { deviceId: parsed.data.deviceId, len: parsed.data.transcript.length },
      'dev-diag: injected voice-device transcript into speakers thread',
    );
    return reply.code(202).send({ ok: true });
  });

  // POST /internal/diag/voice-device/session { deviceId, name, active }
  //   Simulate a physical voice device opening (active:true) or closing
  //   (active:false) an audio session on the host. Injects the same
  //   account-scoped `device.session` wire event the real host emits
  //   (packages/daemon audio server `onDeviceSession`), so the server fans it
  //   out to surfaces and the web Speakers row shows the "🎙 <name>" pill
  //   (spec/14 ## Sidebar). Mock-stack stand-in for a real HA Voice PE unit.
  app.post('/internal/diag/voice-device/session', async (req, reply) => {
    if (!auth(req.headers['x-patch-internal-token'])) {
      return reply.code(401).send({ error: 'bad internal token' });
    }
    const parsed = DeviceSessionBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid body', issues: parsed.error.issues });
    }
    deps.daemonLink.injectDaemonEvent({
      type: 'device.session',
      deviceId: parsed.data.deviceId,
      name: parsed.data.name,
      active: parsed.data.active,
    });
    deps.logger.info(
      { deviceId: parsed.data.deviceId, name: parsed.data.name, active: parsed.data.active },
      'dev-diag: injected device.session event',
    );
    return reply.code(202).send({ ok: true });
  });

  // POST /internal/diag/incoming-call { chatId, message? }
  //   Simulate an agent-initiated voice call (patch_call / chat.call_request,
  //   spec/07 ## Agent-initiated voice, spec/14 ## Manager incoming-call UX).
  //   Drives the REAL CallOrchestrator (so Accept resolves the in-memory call
  //   state, declines/timeouts behave, and the winner/timeout fanout fires),
  //   then ALSO delivers the resulting `chat.call_request` ring straight to the
  //   web surface — which the orchestrator's RINGER_KINDS fanout deliberately
  //   excludes (web "doesn't ring"), but which is the surface the dev stack runs
  //   on. Mock-stack stand-in for a Manager thread invoking its patch_call tool.
  app.post('/internal/diag/incoming-call', async (req, reply) => {
    if (!auth(req.headers['x-patch-internal-token'])) {
      return reply.code(401).send({ error: 'bad internal token' });
    }
    const parsed = IncomingCallBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid body', issues: parsed.error.issues });
    }
    if (!deps.callOrchestrator || !deps.wsHub) {
      return reply.code(503).send({ error: 'call orchestrator / ws hub not configured' });
    }
    const callId = await deps.callOrchestrator.startCall({
      type: 'patch.call',
      chatId: parsed.data.chatId,
      ...(parsed.data.message !== undefined ? { message: parsed.data.message } : {}),
    });
    // Deliver the ring to the web surface (excluded from RINGER_KINDS), reusing
    // the orchestrator-minted callId so a subsequent Accept/Dismiss resolves the
    // same in-memory call entry.
    deps.wsHub.sendToKind('web', {
      type: 'chat.call_request',
      callId,
      chatId: parsed.data.chatId,
      ...(parsed.data.message !== undefined ? { message: parsed.data.message } : {}),
    });
    deps.logger.info(
      { callId, chatId: parsed.data.chatId },
      'dev-diag: started agent-initiated incoming call + delivered ring to web',
    );
    return reply.code(202).send({ ok: true, callId });
  });

  // POST /internal/diag/permission-request { chatId, tool?, description? }
  //   Synthesise a mid-voice permission request on `chatId` (spec/07
  //   ## Permission prompts during voice). Forwarded to the host, which emits
  //   a real `chat.permission_request` + flips the chat to awaiting-permission.
  //   The surface then shows the voice permission banner (tap Approve/Deny) AND
  //   a spoken yes/no can resolve it via the open audio session's STT path.
  app.post('/internal/diag/permission-request', async (req, reply) => {
    if (!auth(req.headers['x-patch-internal-token'])) {
      return reply.code(401).send({ error: 'bad internal token' });
    }
    const parsed = PermissionRequestBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid body', issues: parsed.error.issues });
    }
    deps.daemonLink.send('dev-diag', {
      type: 'patch.diag.inject_permission',
      chatId: parsed.data.chatId,
      tool: parsed.data.tool ?? 'Bash',
      description: parsed.data.description ?? 'Run a command — approve?',
    });
    deps.logger.info(
      { chatId: parsed.data.chatId },
      'dev-diag: injected mid-voice permission request',
    );
    return reply.code(202).send({ ok: true });
  });

  // POST /internal/diag/voice-inject { surfaceId, text }
  //   Inject a transcribed utterance into the open voice session for
  //   `surfaceId`, exactly as the host's Whisper path would on
  //   end-of-utterance (spec/07). Routes to the session's CURRENT focus chat
  //   (focus-follow proof), drives a real SDK turn whose reply streams back as
  //   Kokoro TTS (barge-in setup), and resolves a pending permission when the
  //   word is yes/no. STT is mock in this stack, so this is the only way to
  //   feed a meaningful utterance into a live app voice session.
  app.post('/internal/diag/voice-inject', async (req, reply) => {
    if (!auth(req.headers['x-patch-internal-token'])) {
      return reply.code(401).send({ error: 'bad internal token' });
    }
    const parsed = VoiceInjectBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid body', issues: parsed.error.issues });
    }
    deps.daemonLink.send(parsed.data.surfaceId, {
      type: 'patch.diag.voice_inject',
      surfaceId: parsed.data.surfaceId,
      text: parsed.data.text,
    });
    deps.logger.info(
      { surfaceId: parsed.data.surfaceId, len: parsed.data.text.length },
      'dev-diag: injected utterance into open voice session',
    );
    return reply.code(202).send({ ok: true });
  });

  app.get('/internal/diag/speakers/sent', async (req, reply) => {
    if (!auth(req.headers['x-patch-internal-token'])) {
      return reply.code(401).send({ error: 'bad internal token' });
    }
    if (!deps.speakersRecorder) {
      return reply.code(503).send({ error: 'speakers recorder not configured' });
    }
    return reply.code(200).send({ sent: deps.speakersRecorder.recorded() });
  });
}

// ---- DEV/TEST diagnostic seam for TD2 (triggers & jobs) --------------------
//
// A cron trigger only fires when the wall-clock matches its 5-field UTC
// expression — up to a minute of dead wait against the live mock stack. This
// route lets the TD2 e2e checks fire a cron job's action SYNCHRONOUSLY, exactly
// as the real CronScheduler tick would (same filter eval, same dispatch, same
// run-log append). It is NOT a backdoor around the trigger machinery: it routes
// through CronScheduler.fireForTesting, which re-resolves the live job, runs the
// stored JSONata filter, dispatches the action, and appends the run row. The
// {firedAt} payload is the genuine cron payload (spec/08 line 48).
//
// Webhook / todoist triggers need NO such seam — they are real inbound
// HTTP and are exercised directly via POST /api/webhooks/... with real
// signatures. Offline buffering (D2-12) is driven via the host control-UDS
// /internal/diag/drop-link. So this is the single server-side seam TD2 adds.
//
// HARD GATE: only mounted off-production AND when PATCH_JOBS_DIAG=1; every route
// also requires the X-Patch-Internal-Token header. Never reachable in prod.

export interface JobsDiagDeps {
  logger: Logger;
  cronScheduler: CronScheduler;
  internalToken: string;
}

const FireCronBody = z
  .object({
    jobId: z.string().min(1).max(64),
  })
  .strict();

export function registerJobsDiagRoutes(app: FastifyInstance, deps: JobsDiagDeps): void {
  deps.logger.warn(
    {},
    'DEV/TEST jobs-diag route mounted at /internal/diag/jobs/fire-cron — MUST NOT appear in production',
  );

  const auth = (token: unknown): boolean =>
    typeof token === 'string' && token.length > 0 && token === deps.internalToken;

  // POST /internal/diag/jobs/fire-cron { jobId } — fire a cron job's action now,
  // through the real scheduler path. Returns { fired: true } on success, 404 if
  // the job doesn't exist. The caller then inspects /data/runs/<jobId>.jsonl and
  // the spawned/messaged chat to assert the behaviour.
  app.post('/internal/diag/jobs/fire-cron', async (req, reply) => {
    if (!auth(req.headers['x-patch-internal-token'])) {
      return reply.code(401).send({ error: 'bad internal token' });
    }
    const parsed = FireCronBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid body', issues: parsed.error.issues });
    }
    try {
      await deps.cronScheduler.fireForTesting(parsed.data.jobId);
    } catch (err) {
      const message = (err as Error).message;
      if (message.includes('no such job')) {
        return reply.code(404).send({ error: 'no such job', jobId: parsed.data.jobId });
      }
      return reply.code(500).send({ error: message });
    }
    deps.logger.info({ jobId: parsed.data.jobId }, 'dev-diag: fired cron job synchronously');
    return reply.code(202).send({ fired: true, jobId: parsed.data.jobId });
  });
}
