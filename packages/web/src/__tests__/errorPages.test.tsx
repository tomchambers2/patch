import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PageNotFound } from '../components/PageNotFound.js';
import { AppErrorBoundary } from '../components/AppErrorBoundary.js';
import { failed } from '../lib/errorCopy.js';

afterEach(cleanup);

describe('PageNotFound', () => {
  it('says the page is missing in a sentence, keeps the path under Details, and links home', () => {
    render(
      <MemoryRouter initialEntries={['/nope/at/all']}>
        <PageNotFound />
      </MemoryRouter>,
    );
    expect(screen.getByRole('alert').textContent).toContain('Page not found');
    expect(screen.getByTestId('page-not-found-detail-text').textContent).toBe('/nope/at/all');
    expect(screen.getByTestId('page-not-found-home').getAttribute('href')).toBe('/');
  });
});

describe('AppErrorBoundary', () => {
  function Boom(): never {
    throw new Error('kaboom');
  }

  it('shows the error page with the stack in Details instead of a blank pane', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <AppErrorBoundary resetKey="/a">
        <Boom />
      </AppErrorBoundary>,
    );
    expect(screen.getByTestId('app-error').textContent).toContain('Something broke');
    expect(screen.getByTestId('app-error-detail-text').textContent).toContain('kaboom');
    expect(screen.getByTestId('app-error-reload')).toBeTruthy();
  });

  it('clears when the route changes', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { rerender } = render(
      <AppErrorBoundary resetKey="/a">
        <Boom />
      </AppErrorBoundary>,
    );
    rerender(
      <AppErrorBoundary resetKey="/b">
        <p>fine</p>
      </AppErrorBoundary>,
    );
    expect(screen.getByText('fine')).toBeTruthy();
  });
});

describe('failed', () => {
  it('writes a capitalised sentence with no raw message in it', () => {
    expect(failed('archive')).toBe('Archive failed. Try again.');
  });
});
