// useGoBack — a page's own Back control steps back through the history the
// user took, and goes to the page's parent only when there is nothing earlier
// (spec/14 § Layout — desktop). Driven through a real MemoryRouter and asserted
// on where the router ends up.

import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { useGoBack } from '../lib/useGoBack.js';

function Page(): React.JSX.Element {
  const goBack = useGoBack('/parent');
  return (
    <button type="button" onClick={goBack}>
      back
    </button>
  );
}

function Where(): React.JSX.Element {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

function renderAt(entry: string): void {
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Where />
      <Routes>
        <Route path="/page" element={<Page />} />
        <Route
          path="/origin"
          element={
            <Link to="/page" data-testid="open">
              open
            </Link>
          }
        />
        <Route path="/parent" element={<p>parent</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(cleanup);

describe('useGoBack', () => {
  it('returns to the page the user came from, not the parent', () => {
    renderAt('/origin');
    fireEvent.click(screen.getByTestId('open'));
    expect(screen.getByTestId('where')).toHaveTextContent('/page');

    fireEvent.click(screen.getByText('back'));

    expect(screen.getByTestId('where')).toHaveTextContent(/^\/origin$/);
  });

  it('goes to the parent when the page was the first thing opened', () => {
    renderAt('/page');

    fireEvent.click(screen.getByText('back'));

    expect(screen.getByTestId('where')).toHaveTextContent(/^\/parent$/);
  });
});
