// spec/14 § Message links — clicking the toggle icon fetches and renders the
// linked page's title/description/image inline; a failed fetch surfaces an
// error rather than silently showing nothing.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LinkPreviewToggle } from '../components/LinkPreview.js';
import { api } from '../api/rest.js';
import { ApiError } from '../api/rest.js';

vi.mock('../api/rest.js', async () => {
  const actual = await vi.importActual<typeof import('../api/rest.js')>('../api/rest.js');
  return {
    ...actual,
    api: { linkPreview: vi.fn(), linkPreviewImage: vi.fn() },
  };
});

function renderToggle(url: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <LinkPreviewToggle url={url} />
    </QueryClientProvider>,
  );
}

let createObjectURLSpy: ReturnType<typeof vi.fn>;
let revokeObjectURLSpy: ReturnType<typeof vi.fn>;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('LinkPreviewToggle', () => {
  it('is collapsed by default — no fetch until clicked', () => {
    renderToggle('https://example.com/');
    expect(api.linkPreview).not.toHaveBeenCalled();
    expect(screen.queryByTestId('link-preview-card')).toBeNull();
  });

  it("fetches and renders the preview on click, fetching the image through the auth'd proxy", async () => {
    createObjectURLSpy = vi.fn(() => 'blob:mock-url');
    revokeObjectURLSpy = vi.fn();
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: createObjectURLSpy,
      revokeObjectURL: revokeObjectURLSpy,
    });
    vi.mocked(api.linkPreview).mockResolvedValue({
      url: 'https://example.com/article',
      title: 'Example Title',
      description: 'An example description',
      image: 'https://example.com/thumb.png',
    });
    const fakeBlob = new Blob(['x'], { type: 'image/png' });
    vi.mocked(api.linkPreviewImage).mockResolvedValue(fakeBlob);
    const { container } = renderToggle('https://example.com/article');

    fireEvent.click(screen.getByRole('button', { name: /preview link/i }));

    expect(api.linkPreview).toHaveBeenCalledWith('https://example.com/article');
    await waitFor(() => expect(screen.getByText('Example Title')).toBeTruthy());
    expect(screen.getByText('An example description')).toBeTruthy();
    await waitFor(() =>
      expect(api.linkPreviewImage).toHaveBeenCalledWith('https://example.com/thumb.png'),
    );
    await waitFor(() => {
      const img = container.querySelector('img.link-preview-image') as HTMLImageElement;
      expect(img.src).toBe('blob:mock-url');
    });
  });

  it('clicking again collapses the card', async () => {
    vi.mocked(api.linkPreview).mockResolvedValue({
      url: 'https://example.com/',
      title: 'T',
    });
    renderToggle('https://example.com/');
    const btn = screen.getByRole('button', { name: /preview link/i });
    fireEvent.click(btn);
    await waitFor(() => expect(screen.getByTestId('link-preview-card')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /hide link preview/i }));
    expect(screen.queryByTestId('link-preview-card')).toBeNull();
  });

  it('shows the error rather than a silent empty card when the fetch fails', async () => {
    vi.mocked(api.linkPreview).mockRejectedValue(new ApiError(502, 'fetch_failed', null));
    renderToggle('https://example.com/broken');

    fireEvent.click(screen.getByRole('button', { name: /preview link/i }));

    await waitFor(() => expect(screen.getByText('fetch_failed')).toBeTruthy());
  });

  it('renders an "open in browser" link to the right of the preview toggle, pointed at the real URL', () => {
    renderToggle('https://example.com/article');
    const link = screen.getByTestId('link-preview-external') as HTMLAnchorElement;
    expect(link.href).toBe('https://example.com/article');
    expect(link.target).toBe('_blank');
    expect(link.rel).toContain('noopener');
  });

  // Todoist: "patch open in browser is not copying over the query string" —
  // the desktop panel's half was fixed in the shell; this is the message
  // link's own open-in-browser icon.
  it('"open in browser" keeps the query string and fragment', () => {
    renderToggle('https://example.com/app/chats/c1?sidebar=hidden&seq=4#m4');
    const link = screen.getByTestId('link-preview-external') as HTMLAnchorElement;
    expect(link.href).toBe('https://example.com/app/chats/c1?sidebar=hidden&seq=4#m4');
  });
});
