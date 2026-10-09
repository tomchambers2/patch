// ChatBars — every bar the chat detail stacks above its transcript (spec/15 §
// Chat detail → Status bars), in web's order (packages/web/src/routes/
// ChatRoute.tsx): the connection banners first, the job bar, then goal, task list,
// reminder, provider-level context, wake, background tasks, artifact bar,
// archived, hidden, snoozed and the host's sign-in state. Each bar gates itself — none renders
// when it has nothing to say — so on an ordinary chat this is empty. One
// component so the screen mounts one thing and the order lives in one place.

import React, { type ReactElement } from 'react';
import type { ChatRow } from '../stores/types';
import { OfflineBanner } from './OfflineBanner';
import { DaemonOfflineBanner } from './DaemonOfflineBanner';
import { WakeBar } from './WakeBar';
import { BackgroundTaskBar } from './BackgroundTaskBar';
import { SnoozedBanner } from './SnoozedBanner';
import { GoalBar } from './chatBars/GoalBar';
import { TaskBar } from './chatBars/TaskBar';
import { ReminderBar } from './chatBars/ReminderBar';
import { ProviderContextBar } from './chatBars/ProviderContextBar';
import { HiddenBar } from './chatBars/HiddenBar';
import { ArchivedBar } from './chatBars/ArchivedBar';
import { ClaudeDisconnectedBar } from './chatBars/ClaudeDisconnectedBar';
import { ArtifactBar } from './chatBars/ArtifactBar';
import { JobBar } from './chatBars/JobBar';

export function ChatBars({
  chatId,
  row,
}: {
  chatId: string;
  row: ChatRow | undefined;
}): ReactElement {
  return (
    <>
      {/* WS-reconnecting and daemon-offline are DISTINCT states, each with its
          own self-gating banner (spec/12 § Daemon-offline UX). */}
      <OfflineBanner />
      <DaemonOfflineBanner />
      {row ? <JobBar row={row} /> : null}
      {row ? <GoalBar row={row} /> : null}
      {row ? <TaskBar row={row} /> : null}
      {row ? <ReminderBar row={row} /> : null}
      <ProviderContextBar chatId={chatId} />
      <WakeBar row={row} />
      <BackgroundTaskBar chatId={chatId} />
      <ArtifactBar chatId={chatId} />
      {row ? <ArchivedBar row={row} /> : null}
      {row ? <HiddenBar row={row} /> : null}
      <SnoozedBanner row={row} />
      {/* Credentials are per host: this speaks only for the machine THIS chat
          runs on. */}
      {row ? <ClaudeDisconnectedBar daemonId={row.daemonId} model={row.model} /> : null}
    </>
  );
}
