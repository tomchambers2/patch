// What a job's first user-turn is prefaced with unless the job overrides it
// (spec/08 § Autonomy prompt). Its own file, like sweep-prompt.ts, so the
// shared settings (events.ts) and the job types (jobs.ts) can both name it
// without importing each other.

/**
 * Every job fires unattended — there is nobody at the keyboard to answer a
 * question a chat stops to ask — so this is the DEFAULT value of the account's
 * `jobAutonomyPrompt` setting, not a suggestion.
 */
export const DEFAULT_JOB_AUTONOMY_PROMPT =
  "You are running autonomously, don't stop to ask the user questions";
