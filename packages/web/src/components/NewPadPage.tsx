// NewPadPage — start a Pad from scratch (spec/14 § Pads — Starting a Pad, way
// (c)). A name; "Based on" Blank or an app, then which of that app's real screens
// to start from (a screen is photographed as it looks right now — Patch's own
// are captured live, other apps' are the ones earlier Pads captured); Desktop or
// Phone; the chat that owns it. Create captures, makes the Pad and opens it
// beside its chat.

import { useMemo, useState } from 'react';
import type { JSX } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Monitor, Plus, Smartphone } from 'lucide-react';
import { api, type PadLibraryScreen } from '../api/rest.js';
import { useChatStore } from '../stores/chatStore.js';
import { useLayoutStore, resolvePane } from '../stores/layoutStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { deriveChatTitle } from '../lib/chatTitle.js';
import { openPadBesideChat } from '../lib/openPad.js';
import { PATCH_SCREENS, PHONE_SIZE, DESKTOP_SIZE, captureRoute } from '../lib/padCapture.js';
import { SPECIAL_THREAD_IDS } from '@patch/wire';
import { NavHistoryControls } from './NavHistoryControls.js';
import { usePadsStore } from '../stores/padsStore.js';

const BLANK = '';
const PATCH = 'Patch';

/** The chat a new Pad should default to: the focused tab's, else the latest. */
function defaultChat(chatId: string | undefined): string {
  if (chatId) return chatId;
  const layout = useLayoutStore.getState();
  const pane = resolvePane(layout.root, layout.activePaneId);
  for (const t of [...pane.tabs].reverse()) {
    const d = t.descriptor;
    if ('chatId' in d && d.chatId) return d.chatId;
  }
  return '';
}

export function NewPadPage({ chatId }: { chatId?: string | undefined }): JSX.Element {
  const qc = useQueryClient();
  const chats = useChatStore((s) => s.chats);
  const pushError = useUiStore((s) => s.pushError);
  const { data: library } = useQuery({
    queryKey: ['pad-library'],
    queryFn: () => api.padLibrary(),
  });

  const chatOptions = useMemo(
    () =>
      Object.values(chats)
        .filter(
          (c) =>
            c.status !== 'archived' &&
            !(Object.values(SPECIAL_THREAD_IDS) as string[]).includes(c.chatId),
        )
        .sort((a, b) => b.lastUpdated - a.lastUpdated),
    [chats],
  );

  const [name, setName] = useState('');
  const [basedOn, setBasedOn] = useState<string>(BLANK);
  const [live, setLive] = useState<Set<string>>(new Set());
  const [lib, setLib] = useState<Set<string>>(new Set());
  const [device, setDevice] = useState<'desktop' | 'phone'>('desktop');
  const [owner, setOwner] = useState(() => defaultChat(chatId));
  const [busy, setBusy] = useState<string | null>(null);

  const apps = useMemo(() => {
    const names = new Set<string>([PATCH, ...(library?.apps.map((a) => a.app) ?? [])]);
    return [...names];
  }, [library]);
  const libScreens: PadLibraryScreen[] =
    library?.apps.find((a) => a.app === basedOn)?.screens ?? [];

  const toggle = (set: Set<string>, setter: (s: Set<string>) => void, key: string): void => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setter(next);
  };

  const canCreate = name.trim() !== '' && owner !== '' && busy === null;

  async function create(): Promise<void> {
    try {
      const screens: { name: string; html: string; width: number }[] = [];
      for (const id of live) {
        const s = PATCH_SCREENS.find((x) => x.id === id);
        if (!s) continue;
        setBusy(`Capturing ${s.name}…`);
        const size = device === 'phone' ? PHONE_SIZE : DESKTOP_SIZE;
        screens.push({ name: s.name, html: await captureRoute(s.path, size), width: size.width });
      }
      setBusy('Creating…');
      const from = [...lib].map((k) => {
        const [padId, screenId] = k.split('\u0000') as [string, string];
        return { padId, screenId };
      });
      const pad = await api.createPad({
        name: name.trim(),
        ...(basedOn !== BLANK ? { app: basedOn } : {}),
        device,
        chatId: owner,
        ...(screens.length ? { screens } : {}),
        ...(from.length ? { from } : {}),
      });
      void usePadsStore.getState().refresh();
      void qc.invalidateQueries({ queryKey: ['pad-library'] });
      const layout = useLayoutStore.getState();
      const me = layout.findTab({ kind: 'page', page: 'new-pad', ...(chatId ? { chatId } : {}) });
      if (me) layout.closeTab(me.pane.id, me.tab.id);
      openPadBesideChat(pad.id, pad.chatId);
    } catch (e) {
      pushError('Could not create the pad.', undefined, (e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className="pads-new-route" data-testid="new-pad-route">
      <header className="route-head">
        <div className="route-head-title">
          <NavHistoryControls />
          <h1 className="display">New Pad</h1>
        </div>
      </header>
      <div className="pads-form">
        <input
          className="pads-input"
          data-testid="new-pad-name"
          placeholder="Name"
          aria-label="Pad name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <div className="pads-label">Based on</div>
        <div className="pads-apps" role="radiogroup" aria-label="Based on">
          <button
            type="button"
            role="radio"
            aria-checked={basedOn === BLANK}
            className={`pads-app blank${basedOn === BLANK ? ' on' : ''}`}
            data-testid="new-pad-based-blank"
            onClick={() => {
              setBasedOn(BLANK);
              setLive(new Set());
              setLib(new Set());
            }}
          >
            <span className="pads-app-ic">
              <Plus size={18} aria-hidden />
            </span>
            Blank
          </button>
          {apps.map((a) => (
            <button
              key={a}
              type="button"
              role="radio"
              aria-checked={basedOn === a}
              className={`pads-app${basedOn === a ? ' on' : ''}`}
              data-testid={`new-pad-based-${a}`}
              onClick={() => {
                setBasedOn(a);
                setLive(new Set());
                setLib(new Set());
              }}
            >
              <span className="pads-app-ic">{a.charAt(0)}</span>
              {a}
            </button>
          ))}
        </div>
        {basedOn === PATCH ? (
          <>
            <div className="pads-label">Screens as they look now</div>
            <div className="pads-shots" data-testid="new-pad-live">
              {PATCH_SCREENS.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  aria-pressed={live.has(s.id)}
                  className={`pads-shot${live.has(s.id) ? ' on' : ''}`}
                  data-testid={`new-pad-live-${s.id}`}
                  onClick={() => toggle(live, setLive, s.id)}
                >
                  <span className="pads-shot-img pads-shot-live">{s.name}</span>
                </button>
              ))}
            </div>
          </>
        ) : null}
        {basedOn !== BLANK && libScreens.length > 0 ? (
          <>
            <div className="pads-label">Earlier captures</div>
            <div className="pads-shots" data-testid="new-pad-library">
              {libScreens.map((s) => {
                const key = `${s.padId}\u0000${s.screenId}`;
                return (
                  <button
                    key={key}
                    type="button"
                    aria-pressed={lib.has(key)}
                    className={`pads-shot${lib.has(key) ? ' on' : ''}`}
                    data-testid={`new-pad-lib-${s.padId}-${s.screenId}`}
                    onClick={() => toggle(lib, setLib, key)}
                  >
                    <span className="pads-shot-img">
                      {s.thumbUrl ? <img src={s.thumbUrl} alt="" /> : null}
                    </span>
                    <span className="pads-shot-name">{s.name}</span>
                  </button>
                );
              })}
            </div>
          </>
        ) : null}
        <div className="pads-row">
          <div className="pads-seg" role="radiogroup" aria-label="Device">
            <button
              type="button"
              role="radio"
              aria-checked={device === 'desktop'}
              className={device === 'desktop' ? 'on' : ''}
              data-testid="new-pad-desktop"
              title="Desktop"
              onClick={() => setDevice('desktop')}
            >
              <Monitor size={16} aria-hidden />
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={device === 'phone'}
              className={device === 'phone' ? 'on' : ''}
              data-testid="new-pad-phone"
              title="Phone"
              onClick={() => setDevice('phone')}
            >
              <Smartphone size={16} aria-hidden />
            </button>
          </div>
          <span className="pads-flex" />
          <select
            className="jobs-control"
            data-testid="new-pad-chat"
            aria-label="Owning chat"
            value={owner}
            onChange={(e) => setOwner(e.target.value)}
          >
            {owner === '' ? <option value="">Choose a chat</option> : null}
            {chatOptions.map((c) => (
              <option key={c.chatId} value={c.chatId}>
                {deriveChatTitle(c.name)}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="pads-create"
            data-testid="new-pad-create"
            disabled={!canCreate}
            onClick={() => void create()}
          >
            {busy ?? 'Create'}
          </button>
        </div>
      </div>
    </main>
  );
}
