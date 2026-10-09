// Host terminal (spec/15 § Host files and terminal, spec/02 § Terminal
// sessions — PTY sessions).
//
// An interactive shell on ONE host, with no chat involved: run a command, look
// around, fix something. It is a real pseudo-terminal on the host, drawn by a
// real terminal emulator (xterm.js in a WebView, `terminalPage.ts`), so the
// prompt, echo, colour, Tab completion and full-screen programs all work as
// they do at a desk. The key bar above the keyboard supplies the keys a phone
// keyboard lacks (`terminalKeys.ts`).
//
// Without a `folder` the screen first asks where to start: Home or one of the
// host's project folders. The session lives as long as the screen: leaving
// closes the shell on the host.
//
// NO FALLBACK: a host that cannot open a terminal, a host too old to open a
// PTY, a link that is down — each ends the session with the reason on screen
// and a Restart, never a terminal that silently does nothing.

import React from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { useLocalSearchParams } from 'expo-router';
import { getRandomBytes } from 'expo-crypto';
import { RotateCcw } from 'lucide-react-native';
import { folderName } from '@patch/wire';
import { api } from '../../../src/api/rest';
import { getWs } from '../../../src/api/ws';
import { HostToolHeader } from '../../../src/components/HostToolHeader';
import { PlacesList } from '../../../src/components/HostPlaces';
import { startFolders } from '../../../src/lib/hostFiles';
import { useGoBack } from '../../../src/lib/goBack';
import { KEY_BAR, applyCtrl, keySequence, type BarKey } from '../../../src/lib/terminalKeys';
import { buildTerminalPage, pageCall, parsePageMessage } from '../../../src/lib/terminalPage';
import { useFolderStore } from '../../../src/stores/folderStore';
import { usePresenceStore } from '../../../src/stores/presenceStore';
import { undrawn, useTerminalStore } from '../../../src/stores/terminalStore';
import { useUiStore } from '../../../src/stores/uiStore';
import { fonts, radii, space, textMin, useTheme } from '../../../src/lib/theme';

function newSessionId(): string {
  return `term-${Array.from(getRandomBytes(8), (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export default function HostTerminal(): React.ReactElement {
  const colors = useTheme();
  const params = useLocalSearchParams<{ daemonId: string; folder?: string; command?: string }>();
  const daemonId = params.daemonId;
  const goBack = useGoBack(`/hosts/${daemonId}`);
  const hostName = usePresenceStore((s) => s.hosts[daemonId]?.host?.hostName ?? daemonId);
  const hostFolders = useFolderStore((s) => s.byHost[daemonId]);

  const [folder, setFolder] = React.useState<string | null>(params.folder ?? null);
  const [homeError, setHomeError] = React.useState<string | null>(null);
  const [resolvingHome, setResolvingHome] = React.useState(false);

  // Home is the host's to say — ask for it the way the Files screen learns it.
  const pick = async (path: string | null): Promise<void> => {
    if (path !== null) {
      setFolder(path);
      return;
    }
    setResolvingHome(true);
    setHomeError(null);
    try {
      setFolder((await api.hostFilesList(daemonId)).path);
    } catch (e) {
      setHomeError((e as Error).message);
    } finally {
      setResolvingHome(false);
    }
  };

  if (folder === null) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.paper }}>
        <HostToolHeader title="Terminal" hostName={hostName} onBack={goBack} />
        <Text
          style={{
            color: colors.ink3,
            fontSize: textMin,
            paddingHorizontal: space.lg,
            paddingTop: space.md,
            paddingBottom: space.xs,
          }}
        >
          Start in
        </Text>
        <PlacesList
          folders={startFolders(hostFolders?.roots ?? [], hostFolders?.recent ?? [])}
          onPick={(p) => void pick(p)}
          disabled={resolvingHome}
        />
        {homeError !== null ? (
          <Text testID="terminal-home-error" style={{ color: colors.red, padding: space.lg }}>
            {homeError}
          </Text>
        ) : null}
      </View>
    );
  }

  return (
    <TerminalSession
      daemonId={daemonId}
      hostName={hostName}
      folder={folder}
      command={params.command}
      onBack={goBack}
    />
  );
}

function TerminalSession({
  daemonId,
  hostName,
  folder,
  command,
  onBack,
}: {
  daemonId: string;
  hostName: string;
  folder: string;
  /** Typed into the shell once, the moment it is live (e.g. a task's `tail -f`). */
  command?: string;
  onBack: () => void;
}): React.ReactElement {
  const colors = useTheme();
  const [sessionId, setSessionId] = React.useState(newSessionId);
  const session = useTerminalStore((s) => s.sessions[sessionId]);
  const webRef = React.useRef<WebView>(null);
  /** How many output chunks the page has been given (counted like `outputTotal`). */
  const drawn = React.useRef(0);
  /** The page's current size in cells, as it last reported it. */
  const size = React.useRef<{ cols: number; rows: number } | null>(null);
  /** The page has loaded and measured itself — the shell can be opened. */
  const [pageReady, setPageReady] = React.useState(false);
  const appCursor = React.useRef(false);
  const [ctrl, setCtrl] = React.useState(false);

  const page = React.useMemo(
    () =>
      buildTerminalPage(
        {
          background: colors.paper,
          foreground: colors.ink,
          cursor: colors.leaf,
          selection: colors.accentSoft,
        },
        textMin,
      ),
    [colors],
  );

  const inject = (js: string): void => {
    webRef.current?.injectJavaScript(js);
  };

  // Open the shell once the page has measured itself — a PTY is born with a
  // window size, and a wrong one garbles the first screen of a full-screen
  // program.
  React.useEffect(() => {
    const pty = size.current;
    if (!pageReady || pty === null) return;
    drawn.current = 0;
    useTerminalStore.getState().start(sessionId, daemonId, folder);
    try {
      getWs().send({ type: 'patch.terminal.open', sessionId, daemonId, folder, pty });
    } catch (e) {
      useTerminalStore
        .getState()
        .fail(sessionId, `Could not reach the server: ${(e as Error).message}`);
    }
    return () => {
      getWs().safeSend({ type: 'patch.terminal.close', sessionId });
      useTerminalStore.getState().remove(sessionId);
    };
  }, [pageReady, sessionId, daemonId, folder]);

  // A pipe shell opened by a host too old for a PTY: refuse it, and close it
  // rather than leave it idling on the host.
  const wrongKind = session?.wrongKind === true;
  React.useEffect(() => {
    if (wrongKind) getWs().safeSend({ type: 'patch.terminal.close', sessionId });
  }, [wrongKind, sessionId]);

  // Stream new output into the page as it arrives.
  const drawNew = (): void => {
    const s = useTerminalStore.getState().sessions[sessionId];
    if (!s) return;
    const data = undrawn(s, drawn.current);
    drawn.current = s.outputTotal;
    if (data !== '') inject(pageCall('write', data));
  };
  const outputTotal = session?.outputTotal;
  React.useEffect(() => {
    if (outputTotal !== undefined && pageReady) drawNew();
    // drawNew reads the store directly; outputTotal is what says there is more.
  }, [outputTotal, pageReady]);

  const live = session?.status === 'live';

  const sendInput = (data: string): void => {
    if (!live || data === '') return;
    try {
      getWs().send({ type: 'patch.terminal.input', sessionId, data });
    } catch (e) {
      useUiStore.getState().pushError(`terminal: ${(e as Error).message}`);
    }
  };

  const commandSent = React.useRef(false);
  React.useEffect(() => {
    if (!live || command === undefined || commandSent.current) return;
    commandSent.current = true;
    sendInput(`${command}\r`);
    // sendInput closes over `live`, which this effect already depends on.
  }, [live, command]);

  const onMessage = (event: WebViewMessageEvent): void => {
    let msg;
    try {
      msg = parsePageMessage(event.nativeEvent.data);
    } catch (e) {
      useUiStore.getState().pushError((e as Error).message);
      return;
    }
    switch (msg.type) {
      case 'ready':
        // Also a RE-load (the theme changed, the WebView was rebuilt): the new
        // page is blank, so it is given the whole retained scrollback, and the
        // shell is told the new page's size.
        size.current = { cols: msg.cols, rows: msg.rows };
        drawn.current = 0;
        if (pageReady) {
          drawNew();
          if (live) getWs().safeSend({ type: 'patch.terminal.resize', sessionId, ...size.current });
        } else {
          setPageReady(true);
        }
        inject(pageCall('focus'));
        return;
      case 'data':
        if (ctrl) {
          setCtrl(false);
          sendInput(applyCtrl(msg.data));
        } else {
          sendInput(msg.data);
        }
        return;
      case 'resize':
        size.current = { cols: msg.cols, rows: msg.rows };
        if (live) getWs().safeSend({ type: 'patch.terminal.resize', sessionId, ...size.current });
        return;
      case 'modes':
        appCursor.current = msg.appCursor;
        return;
      case 'error':
        useUiStore.getState().pushError(`terminal page: ${msg.message}`);
        return;
    }
  };

  const pressKey = (key: BarKey): void => {
    if (key === 'ctrl') {
      setCtrl((c) => !c);
      return;
    }
    sendInput(keySequence(key, { appCursor: appCursor.current, ctrl }));
    setCtrl(false);
    inject(pageCall('focus'));
  };

  const restart = (): void => {
    inject(pageCall('reset'));
    setCtrl(false);
    setSessionId(newSessionId());
  };

  const cwd = session?.cwd ?? folder;
  const status = session?.status ?? 'starting';

  return (
    <View style={{ flex: 1, backgroundColor: colors.paper }}>
      <HostToolHeader
        title="Terminal"
        hostName={`${hostName} · ${cwd === '/' ? '/' : folderName(cwd)}`}
        onBack={onBack}
        right={
          status === 'ended' || status === 'error' ? (
            <Pressable
              testID="terminal-restart"
              accessibilityRole="button"
              accessibilityLabel="Restart"
              onPress={restart}
              style={{ padding: space.sm }}
            >
              <RotateCcw size={20} color={colors.leaf} />
            </Pressable>
          ) : null
        }
      />
      {status !== 'live' ? (
        <View
          testID="terminal-status"
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            paddingHorizontal: space.lg,
            paddingVertical: space.sm,
            backgroundColor: status === 'starting' ? colors.bgSoft : colors.waitingTint,
          }}
        >
          {status === 'starting' ? <ActivityIndicator size="small" color={colors.leaf} /> : null}
          <Text
            testID="terminal-status-text"
            style={{
              color: status === 'error' ? colors.red : colors.ink2,
              fontSize: textMin,
              marginLeft: status === 'starting' ? space.sm : 0,
              flex: 1,
            }}
          >
            {status === 'starting' ? 'Starting…' : session?.message}
          </Text>
        </View>
      ) : null}
      <WebView
        ref={webRef}
        testID="terminal-webview"
        source={{ html: page }}
        originWhitelist={['*']}
        onMessage={onMessage}
        javaScriptEnabled
        keyboardDisplayRequiresUserAction={false}
        hideKeyboardAccessoryView
        overScrollMode="never"
        setSupportMultipleWindows={false}
        style={{ flex: 1, backgroundColor: colors.paper }}
      />
      <View
        testID="terminal-keybar"
        style={{
          flexDirection: 'row',
          borderTopWidth: 1,
          borderColor: colors.divider,
          backgroundColor: colors.paperRaised,
          paddingVertical: space.xs,
          paddingHorizontal: space.xs,
        }}
      >
        {KEY_BAR.map((k) => {
          const armed = k.key === 'ctrl' && ctrl;
          return (
            <Pressable
              key={k.key}
              testID={`terminal-key-${k.key}`}
              accessibilityRole="button"
              accessibilityLabel={k.accessibilityLabel}
              accessibilityState={k.key === 'ctrl' ? { selected: armed } : undefined}
              onPress={() => pressKey(k.key)}
              style={({ pressed }) => ({
                flex: 1,
                alignItems: 'center',
                paddingVertical: space.sm,
                marginHorizontal: 2,
                borderRadius: radii.sm,
                backgroundColor: armed ? colors.leaf : pressed ? colors.accentTint : colors.paper,
              })}
            >
              <Text
                style={{
                  color: armed ? colors.onAccent : colors.ink,
                  fontFamily: fonts.mono,
                  fontSize: textMin,
                }}
              >
                {k.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
