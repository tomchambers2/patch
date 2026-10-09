// The disclosure that keeps a humanised failure's original code + message
// (`lib/errorCopy.ts`). Collapsed by default so the sentence above it is what
// is read; open, it shows exactly what the server or host said.

import type { JSX } from 'react';

export function ErrorDetail({
  detail,
  testId,
  onOpen,
}: {
  detail: string;
  testId: string;
  /** Called the first time the user expands it. */
  onOpen?: () => void;
}): JSX.Element | null {
  if (detail === '') return null;
  return (
    <details
      className="error-detail"
      data-testid={testId}
      onToggle={(e) => {
        if ((e.currentTarget as HTMLDetailsElement).open) onOpen?.();
      }}
    >
      <summary>Details</summary>
      <code data-testid={`${testId}-text`}>{detail}</code>
    </details>
  );
}
