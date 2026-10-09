// LinkPreviewToggle — the small icon next to a message link that expands an
// inline mini-preview of the linked page's title/description/image, so
// reading what a link points at doesn't require leaving the chat
// (spec/14 § Message links).
//
// Only rendered for http(s) links — a relative in-app anchor or a mailto:
// link has nothing for the server to fetch.

import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Eye, ExternalLink } from 'lucide-react';
import { api } from '../api/rest.js';

export function LinkPreviewToggle({ url }: { url: string }): JSX.Element | null {
  const [open, setOpen] = useState(false);
  if (!/^https?:\/\//i.test(url)) return null;
  return (
    <span className="link-preview-wrap">
      <button
        type="button"
        className="link-preview-toggle"
        aria-expanded={open}
        aria-label={open ? 'Hide link preview' : 'Preview link'}
        data-testid="link-preview-toggle"
        onClick={() => setOpen((v) => !v)}
      >
        <Eye size={14} aria-hidden />
      </button>
      {/*
        The desktop shell's link policy (packages/desktop/src/link-policy.ts)
        routes a plain click on a message link into Patch's own in-app browser
        panel, not the OS browser — a `target="_blank"` open is what that
        policy sends to shell.openExternal instead (routeWindowOpen). This
        button exists so getting a link into the real desktop browser doesn't
        require knowing the ctrl/cmd-click escape hatch; on the plain web
        surface it's just an ordinary new-tab open.
      */}
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="link-preview-external"
        aria-label="Open in browser"
        data-testid="link-preview-external"
      >
        <ExternalLink size={14} aria-hidden />
      </a>
      {open ? <LinkPreviewCard url={url} /> : null}
    </span>
  );
}

function LinkPreviewCard({ url }: { url: string }): JSX.Element {
  // A page's OG metadata doesn't change under a live chat session — never
  // refetch the same link twice in one sitting.
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['link-preview', url],
    queryFn: () => api.linkPreview(url),
    staleTime: Infinity,
  });
  // The og:image is a third-party URL — the CSP's img-src ('self'/data:/blob:)
  // blocks a plain `<img src>` pointed at it, so it's fetched with auth
  // through /api/link-preview/image and turned into an object URL (same
  // pattern as EditorRail's binary file preview).
  const { data: imageBlob } = useQuery({
    queryKey: ['link-preview-image', data?.image],
    queryFn: () => api.linkPreviewImage(data!.image!),
    enabled: !!data?.image,
    staleTime: Infinity,
  });
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!imageBlob) {
      setImageUrl(null);
      return;
    }
    const objectUrl = URL.createObjectURL(imageBlob);
    setImageUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [imageBlob]);
  return (
    <span className="link-preview-card" data-testid="link-preview-card">
      {isLoading ? <span className="link-preview-status">Loading preview…</span> : null}
      {isError ? (
        <span className="link-preview-status link-preview-error">
          {error instanceof Error ? error.message : 'Preview failed'}
        </span>
      ) : null}
      {data && !data.title && !data.description && !data.image ? (
        <span className="link-preview-status">No preview available</span>
      ) : null}
      {imageUrl ? <img src={imageUrl} alt="" className="link-preview-image" /> : null}
      {data?.title || data?.description ? (
        <span className="link-preview-text">
          {data.title ? <span className="link-preview-title">{data.title}</span> : null}
          {data.description ? (
            <span className="link-preview-description">{data.description}</span>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}
