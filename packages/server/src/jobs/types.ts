// Server-side re-export of the canonical Job + JobsInterface types.
//
// Per group 10 BLOCKER B.8: the canonical schema lives in `@patch/wire/jobs`
// so the host's `RemoteJobsStore` and the server share one source of
// truth. Server code keeps importing from `./types.js` for stability.

export {
  CronTrigger,
  WebhookScheme,
  WebhookTrigger,
  TodoistTrigger,
  RecurrenceTrigger,
  JobTrigger,
  SpawnAction,
  MessageAction,
  JobAction,
  Job,
  JobWithCounts,
  JobListEntry,
  JobLatestRun,
  JobRunStatus,
  JobCreateBody,
  JobPatchBody,
  Queueing,
  jobFires,
  jobInertReason,
  DEFAULT_JOB_AUTONOMY_PROMPT,
  jobAutonomyPrompt,
} from '@patch/wire/jobs';

export type { JobsInterface, AsyncJobsInterface, JobsChangeEvent } from '@patch/wire/jobs';
