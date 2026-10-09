// JobBar — shown at the top of a chat a job created, linking to that job
// (spec/14 § Main chat panel — Job bar).
//
// `jobId` is set once at spawn (spec/08 § Action) and never changes, so the bar
// is stable for the life of the chat. Chats no job created have none.

import type { JSX } from 'react';
import { Link } from 'react-router-dom';
import { Zap } from 'lucide-react';
import type { ChatRow } from '../stores/types.js';

export function JobBar({ row }: { row: ChatRow }): JSX.Element | null {
  if (!row.jobId) return null;
  return (
    <div className="archived-banner" data-testid="job-bar" role="status">
      <span className="archived-banner-label">
        <Zap size={14} aria-hidden />
        Run by a job
      </span>
      <Link className="archived-unarchive-btn" data-testid="job-bar-link" to={`/jobs/${row.jobId}`}>
        Open job
      </Link>
    </div>
  );
}
