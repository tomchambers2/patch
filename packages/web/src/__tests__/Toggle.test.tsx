// Toggle — the canonical boolean control (spec/14 § Controls). A real switch
// over a hidden accessible checkbox; the label is a STATIC noun, never flipping
// between "Enabled"/"Disabled".

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Toggle } from '../components/Toggle.js';

describe('Toggle', () => {
  it('renders a static label and reflects the checked state on the switch', () => {
    const { rerender } = render(
      <Toggle checked={false} onChange={() => {}} label="Enabled" testid="t1" />,
    );
    const input = screen.getByTestId('t1') as HTMLInputElement;
    expect(input).not.toBeChecked();
    expect(screen.getByText('Enabled')).toBeInTheDocument();
    // The label does NOT flip to "Disabled" when off — the switch shows state.
    rerender(<Toggle checked onChange={() => {}} label="Enabled" testid="t1" />);
    expect(screen.getByTestId('t1')).toBeChecked();
    expect(screen.getByText('Enabled')).toBeInTheDocument();
    expect(screen.queryByText('Disabled')).toBeNull();
  });

  it('fires onChange with the next boolean when clicked', () => {
    const onChange = vi.fn();
    render(<Toggle checked={false} onChange={onChange} label="Enabled" testid="t2" />);
    fireEvent.click(screen.getByTestId('t2'));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('exposes the switch role for accessibility', () => {
    render(<Toggle checked onChange={() => {}} testid="t3" />);
    expect(screen.getByTestId('t3')).toHaveAttribute('role', 'switch');
  });
});
