// Document editor (spec/14 § Document editor — Working with the agent):
// "Select a passage → a small popover to ask about or act on just that
// passage; the request goes to the chat with the selection attached." Step 1
// attaches the selection by quoting it into the chat's own composer draft
// (spec/14 § Composer — server-owned, so it's there the moment the user
// switches back to the chat) rather than sending anything itself — the user
// still writes and sends their own question.
import { useComposerDraftStore } from '../stores/composerDraftStore.js';

/** Pure for testability — the DOM-touching part is just reading/writing the store. */
export function withQuotedSelection(existingDraft: string, selectedText: string): string {
  const quote = selectedText
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
  const trimmedExisting = existingDraft.replace(/\s+$/, '');
  return trimmedExisting.length > 0 ? `${trimmedExisting}\n\n${quote}\n\n` : `${quote}\n\n`;
}

export function quoteSelectionIntoComposer(chatId: string, selectedText: string): void {
  const store = useComposerDraftStore.getState();
  const existing = store.drafts[chatId] ?? '';
  store.setDraft(chatId, withQuotedSelection(existing, selectedText));
}
