// Items 4 / 8 / 10 — user-facing label copy.

import { describe, it, expect } from 'vitest';
import {
  CHATS_SEARCH_MORE,
  CHATS_SEARCH_PLACEHOLDER,
  CHATS_SEARCHING,
  chatSearchFailed,
  LINKED_DEVICES_TITLE,
  deriveChatTitle,
  friendlyDeviceName,
  isGeneratedId,
} from '../src/lib/labels';

// Build a chat-list row for deriveChatTitle. Only `name`/`folder` are
// meaningful to the derivation; `chatId`/`preview` are carried for shape parity.
function row(over: Partial<Parameters<typeof deriveChatTitle>[0]> = {}) {
  return {
    name: null,
    chatId: 'chat-x',
    folder: '/home/tom/projects/portfolio',
    preview: null,
    ...over,
  };
}

describe('chats search label (item 4)', () => {
  it('starts with the plain "Search chats" wording', () => {
    expect(CHATS_SEARCH_PLACEHOLDER).toMatch(/^Search chats/);
  });
  it('does not surface the "(AI)" implementation detail', () => {
    expect(CHATS_SEARCH_PLACEHOLDER).not.toMatch(/\(ai\)/i);
  });
});

describe('chats server search copy (spec/03 § Chat search)', () => {
  it("uses web's words for the pending line and the next-page row", () => {
    expect(CHATS_SEARCHING).toBe('Searching…');
    expect(CHATS_SEARCH_MORE).toBe('More results');
  });
  it('names a failed search and carries its message', () => {
    expect(chatSearchFailed('internal: boom')).toBe('Search failed: internal: boom');
  });
});

describe('devices section (item 8)', () => {
  it('carries web\'s own name, "Linked devices" (spec/14 § Hosts & devices)', () => {
    expect(LINKED_DEVICES_TITLE).toBe('Linked devices');
  });
  // Section explainer copy was removed (spec/15 § Settings tab: section headers
  // stand alone, no descriptive subtitle lines), so there is no explainer
  // constant to assert here anymore.
});

// Chat title (spec/04 § Name): the AI-generated `name`; until it lands, the
// folder basename, then "New chat". It must never surface a raw generated id
// and never the first user message. Regression guard for the mobile
// `deriveChatTitle` in labels.ts (matches the web variant).
const ULID = '01KVBD4HJF0N90DYVTDWEBH7FP';

describe('isGeneratedId', () => {
  it('treats ULIDs, chat_ and thread_ ids as generated', () => {
    expect(isGeneratedId(ULID)).toBe(true);
    expect(isGeneratedId('  ' + ULID + '  ')).toBe(true); // trimmed
    expect(isGeneratedId('chat_abc123')).toBe(true);
    expect(isGeneratedId('thread_manager')).toBe(true);
  });
  it('treats real human text as NOT generated', () => {
    expect(isGeneratedId('Bus route planning')).toBe(false);
    expect(isGeneratedId('portfolio')).toBe(false);
    // 25 chars — one short of a ULID — is not a generated id.
    expect(isGeneratedId('0123456789ABCDEFGHJKMNPQR')).toBe(false);
  });
});

describe('deriveChatTitle (mobile — AI name, then "New chat")', () => {
  it('uses a real human name when present (name wins)', () => {
    expect(deriveChatTitle(row({ name: 'Bus route planning' }))).toBe('Bus route planning');
    // Name wins over the folder.
    expect(deriveChatTitle(row({ name: 'Real name', folder: '/x/folder' }))).toBe('Real name');
  });

  it('NEVER returns a generated id as the name — it is unnamed', () => {
    // A ULID / chat_ / thread_ "name" is internal, so it is ignored.
    expect(deriveChatTitle(row({ name: ULID }))).toBe('New chat');
    expect(deriveChatTitle(row({ name: 'chat_01234' }))).toBe('New chat');
    expect(deriveChatTitle(row({ name: 'thread_manager' }))).toBe('New chat');
    expect(deriveChatTitle(row({ name: ULID }))).not.toBe(ULID);
  });

  it('reads "New chat" rather than the folder when there is no name', () => {
    // spec/15: the folder "would collide for two chats in one folder".
    expect(deriveChatTitle(row({ name: null, folder: '/home/tom/projects/bed-planner' }))).toBe(
      'New chat',
    );
  });

  it('never uses the first user message or preview snippet as the title', () => {
    // The preview is a separate secondary line (badge.ts), not a title source.
    expect(deriveChatTitle(row({ name: null, preview: 'add a dark mode toggle' }))).toBe(
      'New chat',
    );
  });

  it('falls through to "New chat" when there is no name and no usable folder', () => {
    expect(deriveChatTitle(row({ name: null, folder: '' }))).toBe('New chat');
    expect(deriveChatTitle(row({ name: null, folder: '/' }))).toBe('New chat');
    // A folder basename that is itself a generated id is not a title either.
    expect(deriveChatTitle(row({ name: null, folder: `/x/${ULID}` }))).toBe('New chat');
    expect(deriveChatTitle(row({ name: null, folder: '' }))).not.toBe(ULID);
  });
});

describe('friendlyDeviceName', () => {
  it('maps "mobile" to "Phone"', () => {
    expect(friendlyDeviceName('mobile')).toBe('Phone');
  });

  it('never doubles the kind — a "mobile" label on a "mobile" surface is just "Phone"', () => {
    expect(friendlyDeviceName('mobile', 'mobile')).toBe('Phone');
    expect(friendlyDeviceName('mobile', 'MOBILE')).toBe('Phone'); // case-insensitive
    expect(friendlyDeviceName('mobile', '  mobile  ')).toBe('Phone'); // trimmed
    expect(friendlyDeviceName('mobile', 'mobile')).not.toBe('mobile · mobile');
  });

  it('passes a genuine custom label through unchanged', () => {
    expect(friendlyDeviceName('mobile', "Tom's Pixel")).toBe("Tom's Pixel");
    expect(friendlyDeviceName('desktop', 'Studio Mac')).toBe('Studio Mac');
  });

  it('maps the other known kinds and falls back to "Device" for unknown kinds', () => {
    expect(friendlyDeviceName('tablet')).toBe('Tablet');
    expect(friendlyDeviceName('desktop')).toBe('Desktop');
    expect(friendlyDeviceName('web')).toBe('Web');
    expect(friendlyDeviceName('cli')).toBe('Terminal');
    expect(friendlyDeviceName('voice-device')).toBe('Voice device');
    expect(friendlyDeviceName('something-new')).toBe('Device');
  });
});
