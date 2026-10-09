// stores/composerAttachmentStore.ts — attachments waiting in a composer, per
// draft key, so the share sheet can put files into one (spec/15 § Share into
// Patch).

import { describe, it, expect, beforeEach } from 'vitest';
import {
  NO_ATTACHMENTS,
  attachmentKindForMime,
  newAttachmentKey,
  useComposerAttachmentStore,
} from '../src/stores/composerAttachmentStore';

const att = (key: string) => ({
  key,
  uri: `file:///${key}`,
  name: key,
  mimeType: 'text/plain',
  kind: 'file' as const,
});

beforeEach(() => useComposerAttachmentStore.getState()._reset());

describe('composerAttachmentStore', () => {
  it('keeps each key separate, appends, removes one, clears one', () => {
    const s = useComposerAttachmentStore.getState();
    s.add('c1', [att('a')]);
    s.add('c1', [att('b')]);
    s.add('c2', [att('z')]);
    expect(useComposerAttachmentStore.getState().byKey['c1']?.map((a) => a.key)).toEqual([
      'a',
      'b',
    ]);
    s.remove('c1', 'a');
    expect(useComposerAttachmentStore.getState().byKey['c1']?.map((a) => a.key)).toEqual(['b']);
    s.clear('c1');
    expect(useComposerAttachmentStore.getState().byKey['c1']).toBeUndefined();
    expect(useComposerAttachmentStore.getState().byKey['c2']).toHaveLength(1);
  });

  it('adding nothing changes nothing; removing from an empty key is harmless', () => {
    const before = useComposerAttachmentStore.getState().byKey;
    useComposerAttachmentStore.getState().add('c1', []);
    expect(useComposerAttachmentStore.getState().byKey).toBe(before);
    useComposerAttachmentStore.getState().remove('nope', 'x');
    expect(useComposerAttachmentStore.getState().byKey['nope']).toEqual([]);
  });

  it('the empty list is one stable reference', () => {
    expect(NO_ATTACHMENTS).toEqual([]);
  });

  it('keys are unique; kinds follow the MIME type', () => {
    expect(newAttachmentKey()).not.toBe(newAttachmentKey());
    expect(attachmentKindForMime('IMAGE/PNG')).toBe('image');
    expect(attachmentKindForMime('application/pdf')).toBe('file');
  });
});
