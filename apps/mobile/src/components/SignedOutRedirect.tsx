// Leave for the pairing screen the moment the server refuses this surface.
//
// The app chose between "chats" and "pair" once, at launch (app/index.tsx). A
// credential refused WHILE the app was open therefore left the user sitting in
// a chat list that could never load anything, behind a banner claiming the app
// was reconnecting — with nothing to tell them the answer was to link the
// device again.
//
// `unauthenticated` is terminal (presenceStore): it is not a link that might
// come back, so unlike `reconnecting` / `offline` there is nothing to wait for.
// Every other state stays put on purpose — navigating away from a chat mid-turn
// because the wifi blinked would be its own bug.

import React from 'react';
import { useRouter } from 'expo-router';
import { usePresenceStore } from '../stores/presenceStore';

export function SignedOutRedirect(): null {
  const connection = usePresenceStore((s) => s.connection);
  const router = useRouter();
  // Once per refusal. The reason can change afterwards (a second frame, a
  // retry) and must not bounce someone who is already scanning a QR code.
  const sent = React.useRef(false);

  React.useEffect(() => {
    if (connection !== 'unauthenticated') {
      if (connection === 'connected') sent.current = false; // a fresh pairing worked
      return;
    }
    if (sent.current) return;
    sent.current = true;
    router.replace('/pair');
  }, [connection, router]);

  return null;
}
