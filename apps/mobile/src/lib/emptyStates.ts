// Canonical empty-state copy (spec/15 § Empty states). Every empty surface
// uses ONE pattern — an icon + an upright title + one line of plain-sentence
// helper text (never bare, parenthesised, or bracketed). Centralised here so
// the copy is a single source of truth and its plainness is unit-testable.

export interface EmptyStateCopy {
  title: string;
  body: string;
}

export const EMPTY_STATES = {
  chat: {
    title: 'No messages yet',
    body: 'Type below to start the conversation.',
  },
  // The read-only mirror thread (Speakers) has no composer, so the
  // empty state must NOT invite typing (spec/15 § Chat detail — read-only
  // mirrors). Plain sentence, no "type below" line.
  mirror: {
    title: 'Nothing here yet',
    body: 'Messages appear here as they arrive.',
  },
  chats: {
    title: 'No chats yet',
    body: 'Tap + to start one.',
  },
  jobs: {
    title: 'No jobs yet',
    body: 'Ask Manager to create one, or add one here.',
  },
  devices: {
    title: 'No other devices',
    body: 'Link another device to see it here.',
  },
  secrets: {
    title: 'No secrets yet',
    body: 'Add one here, or set them from the CLI.',
  },
  chatSearch: {
    title: 'No matches',
    body: 'Try a different description of the chat you want.',
  },
  jobSearch: {
    title: 'No matches',
    body: 'Try a different description of the job you want.',
  },
  channels: {
    title: 'No channels yet',
    body: 'Speakers appears here once connected.',
  },
  // The Manager chat's Chats tab (spec/15 § Voice tab (Manager)) with no active chat.
  managerChats: {
    title: 'Nothing running',
    body: 'Active chats appear here, the ones waiting on you first.',
  },
  snoozed: {
    title: 'Nothing snoozed',
    body: 'Snoozed chats wait here until their wake time.',
  },
  // The Batch view with no batch running (spec/15 § Batch view) — names the
  // way in rather than leaving a bare screen with no route out of it.
  batch: {
    title: 'Nothing batched',
    body: 'Press Batch to start one.',
  },
  // The Chats tab's needs-attention filter with nothing left in the queue.
  attentionEmpty: {
    title: 'Nothing needs attention',
    body: "You're all caught up.",
  },
  // A host directory with nothing in it (spec/15 § Host files and terminal).
  folder: {
    title: 'Empty folder',
    body: 'There is nothing in this folder.',
  },
} as const satisfies Record<string, EmptyStateCopy>;
