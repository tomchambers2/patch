import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';
import { PairingScreen } from '../components/PairingScreen.js';
import { clearCredential, loadCredential } from '../lib/credential.js';

function b64url(o: unknown): string {
  return btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function jwt(payload: Record<string, unknown>): string {
  return `${b64url({ alg: 'EdDSA' })}.${b64url(payload)}.sig`;
}

afterEach(() => {
  cleanup();
  clearCredential();
});

describe('PairingScreen', () => {
  it('disables submit until text is entered', () => {
    render(<PairingScreen onPaired={() => {}} />);
    const submit = screen.getByTestId('pairing-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByTestId('pairing-input'), { target: { value: '  ' } });
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByTestId('pairing-input'), { target: { value: 'abc' } });
    expect(submit.disabled).toBe(false);
  });

  it('shows an error for a malformed token and does not call onPaired', () => {
    const onPaired = vi.fn();
    render(<PairingScreen onPaired={onPaired} />);
    fireEvent.change(screen.getByTestId('pairing-input'), { target: { value: 'not-a-jwt' } });
    fireEvent.click(screen.getByTestId('pairing-submit'));
    expect(screen.getByTestId('pairing-error')).toBeTruthy();
    expect(screen.getByText(/doesn.t look like a credential token/)).toBeTruthy();
    expect(onPaired).not.toHaveBeenCalled();
    expect(loadCredential()).toBeNull();
  });

  it('clears the error once the user edits the input again', () => {
    render(<PairingScreen onPaired={() => {}} />);
    fireEvent.change(screen.getByTestId('pairing-input'), { target: { value: 'not-a-jwt' } });
    fireEvent.click(screen.getByTestId('pairing-submit'));
    expect(screen.getByTestId('pairing-error')).toBeTruthy();
    fireEvent.change(screen.getByTestId('pairing-input'), { target: { value: 'not-a-jwt2' } });
    expect(screen.queryByTestId('pairing-error')).toBeNull();
  });

  it('saves a well-formed credential and calls onPaired', () => {
    const onPaired = vi.fn();
    const token = jwt({ surface_id: 'web-1' });
    render(<PairingScreen onPaired={onPaired} />);
    fireEvent.change(screen.getByTestId('pairing-input'), { target: { value: `  ${token}  ` } });
    fireEvent.click(screen.getByTestId('pairing-submit'));
    expect(onPaired).toHaveBeenCalledTimes(1);
    expect(loadCredential()).toBe(token);
    expect(screen.queryByTestId('pairing-error')).toBeNull();
  });
  // spec/14 § Keyboard shortcuts — `⌘↵` commits the field. Pasting a token and
  // reaching for the mouse is the wrong shape for a paste-and-go screen.
  it('⌘↵ in the paste box signs in, exactly as Continue does', () => {
    const onPaired = vi.fn();
    render(<PairingScreen onPaired={onPaired} />);
    const token = jwt({ surface_id: 'web-2' });
    fireEvent.change(screen.getByTestId('pairing-input'), { target: { value: token } });
    fireEvent.keyDown(screen.getByTestId('pairing-input'), { key: 'Enter', metaKey: true });
    expect(onPaired).toHaveBeenCalledTimes(1);
    expect(loadCredential()).toBe(token);
  });

  it('⌘↵ on a malformed token reports it rather than signing in', () => {
    const onPaired = vi.fn();
    render(<PairingScreen onPaired={onPaired} />);
    fireEvent.change(screen.getByTestId('pairing-input'), { target: { value: 'not-a-jwt' } });
    fireEvent.keyDown(screen.getByTestId('pairing-input'), { key: 'Enter', metaKey: true });
    expect(screen.getByTestId('pairing-error')).toBeTruthy();
    expect(onPaired).not.toHaveBeenCalled();
    expect(loadCredential()).toBeNull();
  });

  it('⌘↵ on an empty box does nothing — Continue is disabled there too', () => {
    const onPaired = vi.fn();
    render(<PairingScreen onPaired={onPaired} />);
    fireEvent.keyDown(screen.getByTestId('pairing-input'), { key: 'Enter', metaKey: true });
    expect(onPaired).not.toHaveBeenCalled();
    expect(screen.queryByTestId('pairing-error')).toBeNull();
  });

  it('bare ↵ inserts a newline instead of signing in', () => {
    const onPaired = vi.fn();
    render(<PairingScreen onPaired={onPaired} />);
    fireEvent.change(screen.getByTestId('pairing-input'), {
      target: { value: jwt({ surface_id: 'web-3' }) },
    });
    fireEvent.keyDown(screen.getByTestId('pairing-input'), { key: 'Enter' });
    expect(onPaired).not.toHaveBeenCalled();
  });

  it('Continue names the chord that presses it', () => {
    render(<PairingScreen onPaired={() => {}} />);
    expect(screen.getByTestId('pairing-submit').getAttribute('title')).toBe('Ctrl+Enter');
  });
});
