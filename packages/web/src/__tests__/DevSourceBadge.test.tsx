import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { DevSourceBadge } from '../components/DevSourceBadge.js';

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe('DevSourceBadge', () => {
  it('renders the host + origin when running under DEV', () => {
    // Under vitest, import.meta.env.DEV is true by default.
    render(<DevSourceBadge />);
    const el = screen.getByTestId('dev-source-badge');
    expect(el.textContent).toContain(window.location.host);
    expect(el.title).toContain(window.location.origin);
  });

  it('renders nothing outside of DEV (production bundle)', () => {
    vi.stubEnv('DEV', false);
    const { container } = render(<DevSourceBadge />);
    expect(container.firstChild).toBeNull();
  });
});
