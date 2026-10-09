// Server-side re-export of the canonical Hook + HooksInterface types, same
// split jobs use (`../jobs/types.ts`): the canonical schema lives in
// `@patch/wire/hooks`, server code imports from `./types.js` for stability.

export {
  HookWhen,
  SUPPORTED_HOOK_WHENS,
  HookKind,
  HookScript,
  HookPrompt,
  HookGate,
  Hook,
  HookCreateBody,
  HookPatchBody,
  HookDecision,
  HookCheckOutcome,
  HookRunResult,
  HookCheckRequestBody,
  HookCheckResponse,
  DEFAULT_HOOK_TIMEOUT_MS,
  MAX_HOOK_TIMEOUT_MS,
  aggregateHookDecision,
  hookGateMatches,
} from '@patch/wire/hooks';
export type { HooksInterface, HooksChangeEvent, HookCheckContext } from '@patch/wire/hooks';
