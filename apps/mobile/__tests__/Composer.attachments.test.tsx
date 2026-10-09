// Composer — attachments (spec/15 § Composer — "Attachments (images + files)").
// Attach buttons (camera, image picker, any-file picker), removable thumbnails,
// and upload-on-send. Sending with attachments reacts at once: the composer
// clears and stays usable while lib/sendQueue.ts uploads (the pending message,
// its `Uploading n/m` count and `Not uploaded` Retry/× are pinned end-to-end in
// pendingUpload.integration.test.tsx).
//
// expo-image-picker / expo-document-picker default to a "cancelled" pick
// (see their stubs); each test below overrides the specific call it needs.

import React from 'react';
import { Pressable as RNPressable } from 'react-native';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  findHost,
  findAllHost,
  byLabel,
  byType,
  renderRN,
  update,
  actSync,
  actAsync,
  flush,
} from './testUtils/render';
import { usePresenceStore } from '../src/stores/presenceStore';
import { useVoiceStore } from '../src/stores/voiceStore';
import { useChatStore } from '../src/stores/chatStore';
import { useComposerAttachmentStore } from '../src/stores/composerAttachmentStore';
import { useUiStore } from '../src/stores/uiStore';
import { deliveryTracker } from '../src/lib/deliveryTracker';
import { _resetSendQueue } from '../src/lib/sendQueue';
import { lightColors } from '../src/lib/theme';

const { requestPermSpy, launchLibrarySpy, requestCameraPermSpy, launchCameraSpy } = vi.hoisted(
  () => ({
    requestPermSpy: vi.fn(),
    launchLibrarySpy: vi.fn(),
    requestCameraPermSpy: vi.fn(),
    launchCameraSpy: vi.fn(),
  }),
);
vi.mock('expo-image-picker', () => ({
  MediaTypeOptions: { Images: 'Images' },
  requestMediaLibraryPermissionsAsync: requestPermSpy,
  launchImageLibraryAsync: launchLibrarySpy,
  requestCameraPermissionsAsync: requestCameraPermSpy,
  launchCameraAsync: launchCameraSpy,
}));

const { getDocumentSpy } = vi.hoisted(() => ({ getDocumentSpy: vi.fn() }));
vi.mock('expo-document-picker', () => ({ getDocumentAsync: getDocumentSpy }));

const { uploadAttachmentSpy } = vi.hoisted(() => ({ uploadAttachmentSpy: vi.fn() }));
vi.mock('../src/api/rest', () => ({
  api: {
    skills: vi.fn().mockResolvedValue({ skills: [] }),
    uploadAttachment: uploadAttachmentSpy,
  },
}));

import { Composer } from '../src/components/Composer';

/** Put `count` image attachments in c1's composer, as a picker or paste would. */
function seedImages(count: number): void {
  actSync(() => {
    useComposerAttachmentStore.getState().add(
      'c1',
      Array.from({ length: count }, (_, i) => ({
        key: `seed-${i}`,
        uri: `file:///cache/img-${i}.png`,
        name: `pasted-image-${i}.png`,
        mimeType: 'image/png',
        kind: 'image' as const,
      })),
    );
  });
}

let submitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  usePresenceStore.setState({
    connection: 'connected',
    daemon: 'online',
    accountId: null,
    surfaceId: null,
  });
  useVoiceStore.setState({
    voiceNoteChatId: null,
    voiceNoteState: 'idle',
    voiceNoteMode: 'tap',
    voiceNoteTranscript: '',
  });
  useChatStore.getState()._reset();
  _resetSendQueue();
  useComposerAttachmentStore.getState()._reset();
  useUiStore.setState({ errors: [] });
  submitSpy = vi.spyOn(deliveryTracker, 'submit').mockImplementation(() => {});

  requestPermSpy.mockReset().mockResolvedValue({ granted: true });
  launchLibrarySpy.mockReset().mockResolvedValue({ canceled: true });
  requestCameraPermSpy.mockReset().mockResolvedValue({ granted: true });
  launchCameraSpy.mockReset().mockResolvedValue({ canceled: true });
  getDocumentSpy.mockReset().mockResolvedValue({ canceled: true });
  uploadAttachmentSpy.mockReset();
});

afterEach(() => {
  submitSpy.mockRestore();
});

describe('Composer — image picker (attach photo/image button)', () => {
  it('adds an attachment thumbnail from a picked asset (mimeType + fileName present)', async () => {
    launchLibrarySpy.mockResolvedValue({
      canceled: false,
      assets: [
        { uri: 'file:///a.png', fileName: 'a.png', mimeType: 'image/png', width: 10, height: 10 },
      ],
    });
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    await actAsync(async () => {
      findHost(r.root, byLabel('Attach photo or image')).props['onPress']();
      await flush();
    });
    update(r, <Composer chatId="c1" folder="work" />);
    expect(findHost(r.root, byLabel('Remove a.png'))).toBeTruthy();
  });

  it('falls back to a generated name + image/jpeg mime when the asset omits them', async () => {
    launchLibrarySpy.mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file:///b.bin' }], // no fileName, no mimeType, no dimensions
    });
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    await actAsync(async () => {
      findHost(r.root, byLabel('Attach photo or image')).props['onPress']();
      await flush();
    });
    update(r, <Composer chatId="c1" folder="work" />);
    // Generated name is `image-<ts>.jpg` — just assert SOME remove button
    // for an image-* name shows up (thumbnail present, no throw on missing
    // fields).
    const removeBtn = findAllHost(r.root, byType('Pressable')).find((p) =>
      String(p.props['accessibilityLabel']).startsWith('Remove image-'),
    );
    expect(removeBtn).toBeTruthy();
  });

  it('adds nothing when the picker is cancelled', async () => {
    launchLibrarySpy.mockResolvedValue({ canceled: true });
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    await actAsync(async () => {
      findHost(r.root, byLabel('Attach photo or image')).props['onPress']();
      await flush();
    });
    update(r, <Composer chatId="c1" folder="work" />);
    expect(findAllHost(r.root, byType('Image'))).toHaveLength(0);
  });

  it('a denied permission surfaces a loud error (NO FALLBACK) and adds nothing', async () => {
    requestPermSpy.mockResolvedValue({ granted: false });
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    await actAsync(async () => {
      findHost(r.root, byLabel('Attach photo or image')).props['onPress']();
      await flush();
    });
    const errors = useUiStore.getState().errors.map((e) => e.message);
    expect(errors.some((m) => /attach image failed: photo library permission denied/.test(m))).toBe(
      true,
    );
  });
});

// spec/15 § Composer — "Attachments (images + files)": the phone gets a THIRD
// attach control, a one-tap CAMERA button, because on a phone the thing you
// want to send often doesn't exist yet.
describe('Composer — camera (take a photo)', () => {
  it('opens the OS camera on one tap and attaches the captured photo as an image', async () => {
    launchCameraSpy.mockResolvedValue({
      canceled: false,
      assets: [
        {
          uri: 'file:///shot.jpg',
          fileName: 'shot.jpg',
          mimeType: 'image/jpeg',
          width: 40,
          height: 30,
        },
      ],
    });
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    await actAsync(async () => {
      findHost(r.root, byLabel('Take photo')).props['onPress']();
      await flush();
    });
    update(r, <Composer chatId="c1" folder="work" />);
    expect(launchCameraSpy).toHaveBeenCalled();
    expect(findHost(r.root, byLabel('Remove shot.jpg'))).toBeTruthy();
    // An image chip, not a file chip — it renders a thumbnail.
    expect(findAllHost(r.root, byType('Image')).length).toBeGreaterThan(0);
  });

  it('names a capture that comes back without a fileName and still attaches it', async () => {
    launchCameraSpy.mockResolvedValue({ canceled: false, assets: [{ uri: 'file:///raw' }] });
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    await actAsync(async () => {
      findHost(r.root, byLabel('Take photo')).props['onPress']();
      await flush();
    });
    update(r, <Composer chatId="c1" folder="work" />);
    const removeBtn = findAllHost(r.root, byType('Pressable')).find((p) =>
      String(p.props['accessibilityLabel']).startsWith('Remove photo-'),
    );
    expect(removeBtn).toBeTruthy();
  });

  it('adds nothing when the capture is cancelled', async () => {
    launchCameraSpy.mockResolvedValue({ canceled: true });
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    await actAsync(async () => {
      findHost(r.root, byLabel('Take photo')).props['onPress']();
      await flush();
    });
    update(r, <Composer chatId="c1" folder="work" />);
    expect(findAllHost(r.root, byType('Image'))).toHaveLength(0);
    expect(useUiStore.getState().errors).toHaveLength(0);
  });

  it('a denied camera permission surfaces a loud error (NO FALLBACK) and never opens the camera', async () => {
    requestCameraPermSpy.mockResolvedValue({ granted: false });
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    await actAsync(async () => {
      findHost(r.root, byLabel('Take photo')).props['onPress']();
      await flush();
    });
    expect(launchCameraSpy).not.toHaveBeenCalled();
    const errors = useUiStore.getState().errors.map((e) => e.message);
    expect(errors.some((m) => /take photo failed: camera permission denied/.test(m))).toBe(true);
  });

  it('uploads a captured photo through the same image path on send', async () => {
    launchCameraSpy.mockResolvedValue({
      canceled: false,
      assets: [
        {
          uri: 'file:///shot.jpg',
          fileName: 'shot.jpg',
          mimeType: 'image/jpeg',
          width: 40,
          height: 30,
        },
      ],
    });
    uploadAttachmentSpy.mockResolvedValue({
      ok: true,
      ref: { id: 'id-shot', name: 'shot.jpg', mimeType: 'image/jpeg', kind: 'image' },
    });
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    await actAsync(async () => {
      findHost(r.root, byLabel('Take photo')).props['onPress']();
      await flush();
    });
    update(r, <Composer chatId="c1" folder="work" />);
    await actAsync(async () => {
      findHost(r.root, byLabel('Send message')).props['onPress']();
      await flush();
    });
    expect(uploadAttachmentSpy).toHaveBeenCalledTimes(1);
    const refs = submitSpy.mock.calls[0]![3] as Array<{ name: string; kind: string }>;
    expect(refs).toEqual([expect.objectContaining({ name: 'shot.jpg', kind: 'image' })]);
  });

  it('the camera button is disabled with a reason when the host is offline', () => {
    usePresenceStore.setState({ connection: 'connected', daemon: 'offline' });
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    const btn = findAllHost(r.root, byType('Pressable')).find((p) =>
      String(p.props['accessibilityLabel']).startsWith('Take photo unavailable'),
    );
    expect(btn).toBeTruthy();
    expect(btn!.props['disabled']).toBe(true);
  });
});

// spec/15 § Composer — "Attachments (images + files)": on the phone BOTH
// pickers open in multi-select mode and the document picker accepts ANY type
// explicitly, so a file upload is never a one-file-per-tap chore.
describe('Composer — phone file upload: multi-select pickers', () => {
  it('opens the document picker for ANY type in multi-select mode', async () => {
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    await actAsync(async () => {
      findHost(r.root, byLabel('Attach any file')).props['onPress']();
      await flush();
    });
    expect(getDocumentSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: '*/*', multiple: true, copyToCacheDirectory: true }),
    );
  });

  it('attaches EVERY file picked in one document-picker session', async () => {
    getDocumentSpy.mockResolvedValue({
      canceled: false,
      assets: [
        { uri: 'file:///a.pdf', name: 'a.pdf', mimeType: 'application/pdf' },
        { uri: 'file:///b.csv', name: 'b.csv', mimeType: 'text/csv' },
      ],
    });
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    await actAsync(async () => {
      findHost(r.root, byLabel('Attach any file')).props['onPress']();
      await flush();
    });
    update(r, <Composer chatId="c1" folder="work" />);
    expect(findHost(r.root, byLabel('Remove a.pdf'))).toBeTruthy();
    expect(findHost(r.root, byLabel('Remove b.csv'))).toBeTruthy();
  });

  it('opens the image library in multi-select mode', async () => {
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    await actAsync(async () => {
      findHost(r.root, byLabel('Attach photo or image')).props['onPress']();
      await flush();
    });
    expect(launchLibrarySpy).toHaveBeenCalledWith(
      expect.objectContaining({ allowsMultipleSelection: true }),
    );
  });

  it('uploads every picked file on send (each one gets its own ref)', async () => {
    getDocumentSpy.mockResolvedValue({
      canceled: false,
      assets: [
        { uri: 'file:///a.pdf', name: 'a.pdf', mimeType: 'application/pdf' },
        { uri: 'file:///b.csv', name: 'b.csv', mimeType: 'text/csv' },
      ],
    });
    uploadAttachmentSpy.mockImplementation((_chatId: string, f: { name: string }) =>
      Promise.resolve({
        ok: true,
        ref: {
          id: `id-${f.name}`,
          name: f.name,
          mimeType: 'application/octet-stream',
          kind: 'file',
        },
      }),
    );
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    await actAsync(async () => {
      findHost(r.root, byLabel('Attach any file')).props['onPress']();
      await flush();
    });
    update(r, <Composer chatId="c1" folder="work" />);
    await actAsync(async () => {
      findHost(r.root, byLabel('Send message')).props['onPress']();
      await flush();
    });
    expect(uploadAttachmentSpy).toHaveBeenCalledTimes(2);
    const refs = submitSpy.mock.calls[0]![3] as Array<{ name: string }>;
    expect(refs.map((x) => x.name)).toEqual(['a.pdf', 'b.csv']);
  });
});

describe('Composer — document picker (attach any file button)', () => {
  it('adds a file-kind attachment for a non-image mime type', async () => {
    getDocumentSpy.mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file:///doc.pdf', name: 'doc.pdf', mimeType: 'application/pdf' }],
    });
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    await actAsync(async () => {
      findHost(r.root, byLabel('Attach any file')).props['onPress']();
      await flush();
    });
    update(r, <Composer chatId="c1" folder="work" />);
    expect(findHost(r.root, byLabel('Remove doc.pdf'))).toBeTruthy();
    // File-kind attachments render the FileText glyph, not an Image.
    expect(findAllHost(r.root, byType('Icon')).some((i) => i.props['name'] === 'FileText')).toBe(
      true,
    );
  });

  it('kindForMime classifies an image/* document pick as image (kind branch)', async () => {
    getDocumentSpy.mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file:///scan.png', name: 'scan.png', mimeType: 'image/png' }],
    });
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    await actAsync(async () => {
      findHost(r.root, byLabel('Attach any file')).props['onPress']();
      await flush();
    });
    update(r, <Composer chatId="c1" folder="work" />);
    expect(findAllHost(r.root, byType('Image'))).toHaveLength(1);
  });

  it('falls back to application/octet-stream when the document has no mimeType', async () => {
    getDocumentSpy.mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file:///mystery', name: 'mystery' }],
    });
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    await actAsync(async () => {
      findHost(r.root, byLabel('Attach any file')).props['onPress']();
      await flush();
    });
    update(r, <Composer chatId="c1" folder="work" />);
    // application/octet-stream is not an image/* mime, so kindForMime → 'file'.
    expect(findHost(r.root, byLabel('Remove mystery'))).toBeTruthy();
    expect(findAllHost(r.root, byType('Image'))).toHaveLength(0);
  });

  it('adds nothing when the file picker is cancelled', async () => {
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    await actAsync(async () => {
      findHost(r.root, byLabel('Attach any file')).props['onPress']();
      await flush();
    });
    update(r, <Composer chatId="c1" folder="work" />);
    expect(findAllHost(r.root, byType('Icon')).some((i) => i.props['name'] === 'FileText')).toBe(
      false,
    );
  });

  it('a picker failure surfaces a loud error (NO FALLBACK)', async () => {
    getDocumentSpy.mockRejectedValue(new Error('picker crashed'));
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    await actAsync(async () => {
      findHost(r.root, byLabel('Attach any file')).props['onPress']();
      await flush();
    });
    const errors = useUiStore.getState().errors.map((e) => e.message);
    expect(errors.some((m) => /attach file failed: picker crashed/.test(m))).toBe(true);
  });
});

// pickImage/pickDocument's onPress bodies re-check `if (disabled || uploading)
// return;` even though the surrounding Pressable's own `disabled` prop
// already withholds onPress at that same condition (belt-and-braces, see the
// identical pattern + comment on the mic guard in Composer.core.test.tsx).
// Reached the same way: the RAW handler off the COMPOSITE Pressable, bypassing
// Pressable's own disabled-gating.
describe('Composer — attach handler internal disabled guards (defensive, normally unreachable via UI)', () => {
  it("the camera button's guard bails without requesting permission / opening the camera", () => {
    usePresenceStore.setState({
      connection: 'connected',
      daemon: 'offline',
      accountId: null,
      surfaceId: null,
    });
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    const btn = r.root
      .findAllByType(RNPressable)
      .find(
        (p) =>
          p.props['accessibilityLabel'] ===
          'Take photo unavailable — Host offline — paused until your Hetzner box reconnects.',
      );
    (btn!.props['onPress'] as () => void)();
    expect(requestCameraPermSpy).not.toHaveBeenCalled();
    expect(launchCameraSpy).not.toHaveBeenCalled();
  });

  it("the image button's guard bails without requesting permission / opening the picker", () => {
    usePresenceStore.setState({
      connection: 'connected',
      daemon: 'offline',
      accountId: null,
      surfaceId: null,
    });
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    const btn = r.root
      .findAllByType(RNPressable)
      .find(
        (p) =>
          p.props['accessibilityLabel'] ===
          'Attach unavailable — Host offline — paused until your Hetzner box reconnects.',
      );
    (btn!.props['onPress'] as () => void)();
    expect(requestPermSpy).not.toHaveBeenCalled();
  });

  it("the file button's guard bails without opening the document picker", () => {
    usePresenceStore.setState({
      connection: 'connected',
      daemon: 'offline',
      accountId: null,
      surfaceId: null,
    });
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    const btns = r.root
      .findAllByType(RNPressable)
      .filter(
        (p) =>
          p.props['accessibilityLabel'] ===
          'Attach unavailable — Host offline — paused until your Hetzner box reconnects.',
      );
    // Both attach buttons share the label; the file button is the second one.
    (btns[1]!.props['onPress'] as () => void)();
    expect(getDocumentSpy).not.toHaveBeenCalled();
  });
});

describe('Composer — removing an attachment', () => {
  it('the X button removes just that attachment', async () => {
    launchLibrarySpy.mockResolvedValue({
      canceled: false,
      assets: [
        { uri: 'file:///a.png', fileName: 'a.png', mimeType: 'image/png', width: 5, height: 5 },
      ],
    });
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    await actAsync(async () => {
      findHost(r.root, byLabel('Attach photo or image')).props['onPress']();
      await flush();
    });
    update(r, <Composer chatId="c1" folder="work" />);
    findHost(r.root, byLabel('Remove a.png')).props['onPress']();
    update(r, <Composer chatId="c1" folder="work" />);
    expect(findAllHost(r.root, byType('Image'))).toHaveLength(0);
  });
});

describe('Composer — upload-on-send', () => {
  function pastedImage(_r: ReturnType<typeof renderRN>): void {
    seedImages(1);
  }

  it('uploads the (image) attachment, appends the local echo with refs, submits, and clears the composer', async () => {
    uploadAttachmentSpy.mockResolvedValue({
      ok: true,
      ref: {
        id: 'att1',
        name: 'pasted-image-1.png',
        mimeType: 'image/png',
        kind: 'image',
        url: '/x',
      },
    });
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    pastedImage(r);
    findHost(r.root, byType('TextInput')).props['onChangeText']('check this out');
    update(r, <Composer chatId="c1" folder="work" />);

    await actAsync(async () => {
      findHost(r.root, byLabel('Send message')).props['onPress']();
      await flush();
    });

    expect(uploadAttachmentSpy).toHaveBeenCalledTimes(1);
    expect(submitSpy).toHaveBeenCalledTimes(1);
    const [chatId, text, , refs] = submitSpy.mock.calls[0] as [string, string, string, unknown[]];
    expect(chatId).toBe('c1');
    expect(text).toBe('check this out');
    expect(refs).toEqual([
      { id: 'att1', name: 'pasted-image-1.png', mimeType: 'image/png', kind: 'image' },
    ]);
    expect(useChatStore.getState().timelines['c1']?.[0]?.attachments).toHaveLength(1);

    update(r, <Composer chatId="c1" folder="work" />);
    expect(findHost(r.root, byType('TextInput')).props['value']).toBe('');
    expect(findAllHost(r.root, byType('Image'))).toHaveLength(0); // attachments cleared
  });

  it('uploads a FILE-kind attachment without downscaling (else branch)', async () => {
    getDocumentSpy.mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file:///doc.pdf', name: 'doc.pdf', mimeType: 'application/pdf' }],
    });
    uploadAttachmentSpy.mockResolvedValue({
      ok: true,
      ref: { id: 'att2', name: 'doc.pdf', mimeType: 'application/pdf', kind: 'file', url: '/y' },
    });
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    await actAsync(async () => {
      findHost(r.root, byLabel('Attach any file')).props['onPress']();
      await flush();
    });
    update(r, <Composer chatId="c1" folder="work" />);

    await actAsync(async () => {
      findHost(r.root, byLabel('Send message')).props['onPress']();
      await flush();
    });
    expect(uploadAttachmentSpy).toHaveBeenCalledWith('c1', {
      uri: 'file:///doc.pdf',
      name: 'doc.pdf',
      mimeType: 'application/pdf',
    });
    expect(submitSpy).toHaveBeenCalledTimes(1);
  });

  it('a failed upload surfaces a loud error and leaves the message in the stream marked failed (NO FALLBACK)', async () => {
    uploadAttachmentSpy.mockRejectedValue(new Error('server 500'));
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    pastedImage(r);
    findHost(r.root, byType('TextInput')).props['onChangeText']('please send');
    update(r, <Composer chatId="c1" folder="work" />);

    await actAsync(async () => {
      findHost(r.root, byLabel('Send message')).props['onPress']();
      await flush();
    });

    expect(submitSpy).not.toHaveBeenCalled();
    const errors = useUiStore.getState().errors.map((e) => e.message);
    expect(errors.some((m) => /attachment upload failed: server 500/.test(m))).toBe(true);
    // Nothing is dropped: the message — text and files — is in the stream,
    // marked Not uploaded, for Retry or ×.
    const entry = useChatStore.getState().timelines['c1']?.[0];
    expect(entry?.content).toBe('please send');
    expect(entry?.localAttachments?.map((a) => a.name)).toEqual(['pasted-image-0.png']);
    expect(entry?.upload).toEqual({ done: 0, total: 1, failed: true });
  });

  it('the composer clears at once and stays usable while an upload is still in flight', async () => {
    uploadAttachmentSpy.mockReturnValue(new Promise(() => {}));
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    pastedImage(r);
    findHost(r.root, byType('TextInput')).props['onChangeText']('slow send');
    update(r, <Composer chatId="c1" folder="work" />);
    await actAsync(async () => {
      findHost(r.root, byLabel('Send message')).props['onPress']();
      await flush();
    });
    update(r, <Composer chatId="c1" folder="work" />);

    // Cleared: no text, no chips — and no spinner holding the button.
    expect(findHost(r.root, byType('TextInput')).props['value']).toBe('');
    expect(findHost(r.root, byType('TextInput')).props['editable']).toBe(true);
    expect(findAllHost(r.root, byType('Image'))).toHaveLength(0);
    expect(findAllHost(r.root, byType('ActivityIndicator'))).toHaveLength(0);
    // The attach buttons stay live for the next message.
    expect(findHost(r.root, byLabel('Attach photo or image')).props['disabled']).toBe(false);

    findHost(r.root, byType('TextInput')).props['onChangeText']('next one');
    update(r, <Composer chatId="c1" folder="work" />);
    const send = findHost(r.root, byLabel('Send message'));
    expect(send.props['disabled']).toBe(false);
    expect(send.props['style'].backgroundColor).toBe(lightColors.leaf);
  });
});

describe('Composer — long text paste becomes a document', () => {
  it('a single change that inserts a long block attaches it as Pasted text.md and leaves the draft as it was', async () => {
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    const input = () => findHost(r.root, byType('TextInput'));
    actSync(() => input().props['onChangeText']('before '));
    const long = 'pasted line\n'.repeat(1000);
    await actAsync(async () => {
      input().props['onChangeText']('before ' + long);
      await flush();
    });
    update(r, <Composer chatId="c1" folder="work" />);
    expect(
      findHost(r.root, byLabel('Remove Pasted – pasted line pasted line pasted line.md')),
    ).toBeTruthy();
    expect(input().props['value']).toBe('before ');
    const [att] = useComposerAttachmentStore.getState().byKey['c1'] ?? [];
    expect(att?.mimeType).toBe('text/markdown');
  });

  it('typing a short run of text attaches nothing', async () => {
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    await actAsync(async () => {
      findHost(r.root, byType('TextInput')).props['onChangeText']('hello there');
      await flush();
    });
    expect(useComposerAttachmentStore.getState().byKey['c1'] ?? []).toHaveLength(0);
  });
});
