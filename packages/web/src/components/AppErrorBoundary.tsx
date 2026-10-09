// Catches a render crash in the panes so it reads as an error page instead of
// a blank window. NO FALLBACK: nothing is rendered in the crashed pane's place
// except the failure itself, with the stack kept under Details and the console.
// `resetKey` (the pathname) clears it on navigation so one bad pane does not
// pin the whole app to the error.

import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { ErrorPage } from './ErrorPage.js';

interface Props {
  resetKey: string;
  children: ReactNode;
}
interface State {
  error: Error | null;
  key: string;
}

export class AppErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, key: this.props.resetKey };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return props.resetKey === state.key ? null : { error: null, key: props.resetKey };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('pane crashed', error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;
    return (
      <ErrorPage
        testId="app-error"
        title="Something broke"
        sentence="This screen hit an error. Reload to try again."
        detail={error.stack ?? error.message}
      >
        <button
          type="button"
          className="primary-btn"
          data-testid="app-error-reload"
          onClick={() => window.location.reload()}
        >
          Reload
        </button>
      </ErrorPage>
    );
  }
}
