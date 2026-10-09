// Document editor (spec/14 § Document editor) — plain text, no conversion.
import { useState } from 'react';
import type { JSX } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DocumentEditor } from '../components/DocumentEditor.js';

const SKILL = [
  '---',
  'name: cadence-monitor-agents',
  'description: A long description that prettier has wrapped across',
  '  two lines.',
  '---',
  '',
  '# Title',
  '',
  'A paragraph that was wrapped by prettier at eighty columns, so it',
  'spans two lines in the file.',
  '',
].join('\n');

function area(): HTMLTextAreaElement {
  return screen.getByTestId('document-editor-content') as HTMLTextAreaElement;
}

function props(over: Partial<Parameters<typeof DocumentEditor>[0]> = {}) {
  return {
    docKey: 'a.md',
    value: '',
    onChange: vi.fn(),
    onAsk: vi.fn(),
    onComment: vi.fn(),
    ...over,
  };
}

function select(start: number, end: number): void {
  const el = area();
  el.focus();
  el.setSelectionRange(start, end);
  fireEvent.mouseUp(el, { clientX: 10, clientY: 10 });
}

function Harness({
  initial,
  onChange,
}: {
  initial: string;
  onChange: (v: string) => void;
}): JSX.Element {
  const [v, setV] = useState(initial);
  return (
    <DocumentEditor
      {...props({
        value: v,
        onChange: (n: string) => {
          setV(n);
          onChange(n);
        },
      })}
    />
  );
}

describe('DocumentEditor', () => {
  it('shows the file text verbatim — frontmatter, wrapping, trailing newline', () => {
    render(<DocumentEditor {...props({ value: SKILL })} />);
    expect(area().value).toBe(SKILL);
  });

  it('does not call onChange or alter the text when opened without typing', () => {
    const onChange = vi.fn();
    render(<DocumentEditor {...props({ value: SKILL, onChange })} />);
    expect(onChange).not.toHaveBeenCalled();
    expect(area().value).toBe(SKILL);
  });

  it('reports exactly the typed text, changing nothing else', () => {
    const onChange = vi.fn();
    render(<Harness initial={SKILL} onChange={onChange} />);
    fireEvent.change(area(), { target: { value: SKILL.replace('# Title', '# New title') } });
    expect(onChange).toHaveBeenCalledWith(SKILL.replace('# Title', '# New title'));
    expect(area().value).toBe(SKILL.replace('# Title', '# New title'));
  });

  it('shows late-loaded content for the same document', () => {
    const { rerender } = render(<DocumentEditor {...props({ value: '' })} />);
    rerender(<DocumentEditor {...props({ value: 'Loaded late.\n' })} />);
    expect(area().value).toBe('Loaded late.\n');
  });

  it('shows a different document when docKey changes', () => {
    const { rerender } = render(<DocumentEditor {...props({ value: 'First.\n' })} />);
    rerender(<DocumentEditor {...props({ docKey: 'b.md', value: 'Second.\n' })} />);
    expect(area().value).toBe('Second.\n');
  });

  it('offers to ask about a selection and sends it on click', () => {
    const onAsk = vi.fn();
    render(<DocumentEditor {...props({ value: 'Some selectable text.\n', onAsk })} />);
    select(0, 21);
    fireEvent.click(screen.getByTestId('document-editor-ask'));
    expect(onAsk).toHaveBeenCalledWith('Some selectable text.');
    expect(screen.queryByTestId('document-editor-ask')).not.toBeInTheDocument();
  });

  it('opens a comment form on a selection, and submits anchor + text', () => {
    const onComment = vi.fn();
    render(<DocumentEditor {...props({ value: 'Some selectable text.\n', onComment })} />);
    select(0, 21);
    fireEvent.click(screen.getByTestId('document-editor-comment-button'));
    expect(screen.queryByTestId('document-editor-ask')).not.toBeInTheDocument();
    fireEvent.change(screen.getByTestId('document-editor-comment-input'), {
      target: { value: 'is this the right tone?' },
    });
    fireEvent.click(screen.getByTestId('document-editor-comment-submit'));
    expect(onComment).toHaveBeenCalledWith('Some selectable text.', 'is this the right tone?');
    expect(screen.queryByTestId('document-editor-comment-form')).not.toBeInTheDocument();
  });

  it('cancelling the comment form drops it without calling onComment', () => {
    const onComment = vi.fn();
    render(<DocumentEditor {...props({ value: 'Some selectable text.\n', onComment })} />);
    select(0, 21);
    fireEvent.click(screen.getByTestId('document-editor-comment-button'));
    fireEvent.click(screen.getByTestId('document-editor-comment-cancel'));
    expect(onComment).not.toHaveBeenCalled();
    expect(screen.queryByTestId('document-editor-comment-form')).not.toBeInTheDocument();
  });

  it('offers no popover for a whitespace-only selection', () => {
    render(<DocumentEditor {...props({ value: 'Some selectable text.\n' })} />);
    select(4, 5);
    expect(screen.queryByTestId('document-editor-ask')).not.toBeInTheDocument();
  });

  it('hides the popover once the selection collapses', () => {
    render(<DocumentEditor {...props({ value: 'Some selectable text.\n' })} />);
    select(0, 21);
    expect(screen.getByTestId('document-editor-ask')).toBeInTheDocument();
    select(4, 4);
    expect(screen.queryByTestId('document-editor-ask')).not.toBeInTheDocument();
  });
});
