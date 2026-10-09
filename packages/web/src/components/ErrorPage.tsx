// The one full-panel error page: a title, one plain sentence, the original
// text behind a Details disclosure (`ErrorDetail`), and the way out. Unknown
// routes and render crashes both use it so a failure looks the same wherever
// it lands. Styled by `.chat-missing` (the unknown-chat panel).

import type { JSX, ReactNode } from 'react';
import { ErrorDetail } from './ErrorDetail.js';

export function ErrorPage({
  title,
  sentence,
  detail,
  testId,
  children,
}: {
  title: string;
  sentence: string;
  detail: string;
  testId: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <main className="chat-main" data-testid={testId} role="alert">
      <div className="chat-missing">
        <h2 className="chat-missing-title">{title}</h2>
        <p className="chat-missing-note">{sentence}</p>
        <ErrorDetail detail={detail} testId={`${testId}-detail`} />
        <div className="chat-missing-actions">{children}</div>
      </div>
    </main>
  );
}
