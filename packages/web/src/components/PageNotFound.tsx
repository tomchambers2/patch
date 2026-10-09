// The route for any path no pane claims (`AppShell` `*`).

import type { JSX } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ErrorPage } from './ErrorPage.js';

export function PageNotFound(): JSX.Element {
  const { pathname } = useLocation();
  return (
    <ErrorPage
      testId="page-not-found"
      title="Page not found"
      sentence="That address doesn’t lead anywhere in Patch."
      detail={pathname}
    >
      <Link to="/" className="primary-btn" data-testid="page-not-found-home">
        Back to Manager
      </Link>
    </ErrorPage>
  );
}
