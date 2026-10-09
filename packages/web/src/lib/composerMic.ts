// The dictate chord (⌘⇧D unless rebound — lib/dictateChord.ts) dictates into
// the composer of the chat on screen — the same gesture as its mic button: grey
// live words in the box, the chord again keeps them, send sends them. Only
// where no transcribe-mode composer is mounted (no chat open, the new-chat
// screen) does the chord fall back to a voice note. Each such
// composer registers its mic here so AppShell can reach it.

export interface ComposerMic {
  down(): void;
  up(): void;
}

const mics = new Map<string, ComposerMic>();

/** Register a composer's mic for `chatId`; returns the unregister. */
export function registerComposerMic(chatId: string, mic: ComposerMic): () => void {
  mics.set(chatId, mic);
  return () => {
    if (mics.get(chatId) === mic) mics.delete(chatId);
  };
}

export function composerMicFor(chatId: string): ComposerMic | undefined {
  return mics.get(chatId);
}

// The composer a chord press went to, so its release goes to the same one.
let hotkeyMic: ComposerMic | null = null;

/** Dictate chord pressed with `chatId` open. False when no composer took it (→ voice note). */
export function composerHotkeyDown(chatId: string): boolean {
  hotkeyMic = mics.get(chatId) ?? null;
  hotkeyMic?.down();
  return hotkeyMic !== null;
}

/** Dictate chord released. False when the press was not a composer's (→ voice note). */
export function composerHotkeyUp(): boolean {
  const mic = hotkeyMic;
  hotkeyMic = null;
  mic?.up();
  return mic !== null;
}
