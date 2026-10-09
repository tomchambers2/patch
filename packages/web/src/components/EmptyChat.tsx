// Empty-chat graphic (spec/14 § Main chat panel — empty state). An on-brand
// illustration: the patch chat-bubble mark (the three activity dots) with a
// small leaf sprout, in the leaf-green accent, over just a warm title. The old
// "Type your first message below…" hint is dropped — it wasn't useful (spec/14
// § Empty states). Used for both a brand-new chat and an existing chat with no
// messages yet.

import type { JSX } from 'react';

export function EmptyChat({ title = 'No messages yet' }: { title?: string }): JSX.Element {
  return (
    <div className="empty-chat" data-testid="empty-chat">
      <svg
        className="empty-chat-art"
        viewBox="0 0 240 180"
        fill="none"
        role="img"
        aria-label="An empty chat"
        xmlns="http://www.w3.org/2000/svg"
      >
        {/* speech bubble + tail as ONE continuous shape (H4): a rounded-rect
            body whose bottom edge dips down into the bottom-left tail, so the
            outline is a single unbroken stroke where bubble meets tail. */}
        <path
          d="M60 40 H180 A26 26 0 0 1 206 66 V110 A26 26 0 0 1 180 136 H104 L74 162 L74 136 H60 A26 26 0 0 1 34 110 V66 A26 26 0 0 1 60 40 Z"
          className="empty-chat-bubble"
          strokeWidth="3"
          strokeLinejoin="round"
        />
        {/* three activity dots (the patch mark) */}
        <circle cx="94" cy="88" r="8" className="empty-chat-dot" />
        <circle cx="120" cy="88" r="8" className="empty-chat-dot" />
        <circle cx="146" cy="88" r="8" className="empty-chat-dot" />
        {/* leaf sprout growing out of the top */}
        <path d="M158 18 c1 -9 7 -15 15 -16 c-2 9 -8 15 -15 16 z" className="empty-chat-leaf" />
        <path
          d="M150 40 c1 -9 4 -16 8 -22"
          className="empty-chat-stem"
          strokeWidth="2.5"
          fill="none"
          strokeLinecap="round"
        />
      </svg>
      <h2 className="empty-chat-title">{title}</h2>
    </div>
  );
}
