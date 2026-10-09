// QR pairing screen. Scans a QR shown on an existing linked surface
// (CLI / web / desktop). The QR encodes the canonical `patch-pair://` URI
// (spec/05-surfaces.md § Canonical QR payload) — NOT JSON — which says WHERE the
// server is: its address, or the relay it is reached through. The app has no
// server built in; the code is how it learns of one, and the route it names is
// kept once pairing has worked. We generate this device's Ed25519 keypair locally (getOrCreateDeviceKeypair)
// and POST the nonce + the real device public key to /api/auth/pair/complete;
// the server returns a JWT we persist via MMKV. The private key never leaves
// the device.
//
// For tests / dev, also accepts a `?credential=<jwt>` deep link via
// expo-linking (handled in bootstrap.ts on first launch).
//
// NO FALLBACK: any error from pairComplete is surfaced to the user. We
// don't accept arbitrary opaque tokens.

import React from 'react';
import { Alert, Pressable, Text, TextInput, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useRouter } from 'expo-router';
import { api } from '../src/api/rest';
import { bootstrap, teardown } from '../src/lib/bootstrap';
import { useUiStore } from '../src/stores/uiStore';
import { saveCredential } from '../src/lib/credential';
import { getOrCreateDeviceKeypair } from '../src/lib/deviceKey';
import { parsePairingUri } from '@patch/wire';
import { clearRoute, getRoute, setRoute } from '../src/config';
import { usePresenceStore } from '../src/stores/presenceStore';
import { fixed, fonts, radii, space, useTheme } from '../src/lib/theme';

export default function Pair(): React.ReactElement {
  const [perm, requestPerm] = useCameraPermissions();
  const colors = useTheme();
  // Why the server refused us, when it did. Null on an ordinary first pairing.
  const authRejected = usePresenceStore((s) => s.authRejected);
  const [scanned, setScanned] = React.useState(false);
  const [pasted, setPasted] = React.useState('');
  const router = useRouter();

  const onScan = async (raw: string): Promise<void> => {
    if (scanned) return;
    setScanned(true);
    try {
      // The QR carries the pairing nonce in a `patch-pair://` URI. The new
      // surface generates its OWN device keypair locally (spec/10-auth.md §
      // Surface linking) and sends only the public key — the private seed never
      // leaves the device.
      const code = parsePairingUri(raw);
      const { publicKey: devicePublicKey } = getOrCreateDeviceKeypair();
      // Aim at the server the code names for the pairing call itself, and put
      // the old aim back if it does not work out.
      const before = getRoute();
      setRoute(
        code.relay
          ? { kind: 'relay', relay: code.relay }
          : { kind: 'direct', url: code.server as string },
      );
      try {
        const res = await api.pairComplete({
          nonce: code.nonce,
          devicePublicKey,
          clientType: 'surface-mobile',
        });
        saveCredential(res.credential);
      } catch (e) {
        if (before) setRoute(before);
        else clearRoute();
        throw e;
      }
      teardown();
      useUiStore.getState().setDiagnosticsOpen(false);
      useUiStore.getState().closeDiagnosticsBlocking();
      void bootstrap().catch((e: Error) =>
        useUiStore.getState().pushError(`Connection setup failed: ${e.message}`),
      );
      router.replace('/(tabs)/chats');
    } catch (e) {
      Alert.alert('Pairing failed', (e as Error).message);
      setScanned(false);
    }
  };

  // A code can be pasted instead of scanned: a phone with no camera access, or
  // whose server printed the code in a terminal, still gets in.
  const pasteCode = (
    <View style={{ flexDirection: 'row', gap: space.sm, marginTop: space.md }}>
      <TextInput
        testID="pair-code-input"
        value={pasted}
        onChangeText={setPasted}
        placeholder="patch-pair://…"
        placeholderTextColor={colors.ink}
        autoCapitalize="none"
        autoCorrect={false}
        style={{
          flex: 1,
          color: colors.ink,
          backgroundColor: colors.paper,
          borderRadius: radii.md,
          paddingHorizontal: space.md,
          paddingVertical: space.sm,
        }}
      />
      <Pressable
        testID="pair-code-submit"
        onPress={() => {
          void onScan(pasted.trim());
        }}
        style={{
          backgroundColor: colors.leaf,
          paddingHorizontal: space.lg,
          justifyContent: 'center',
          borderRadius: radii.md,
        }}
      >
        <Text style={{ color: colors.onAccent, fontFamily: fonts.bodyMedium }}>Pair</Text>
      </Pressable>
    </View>
  );

  if (!perm) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.paper }} testID="pair-permission-loading" />
    );
  }
  if (!perm.granted) {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: colors.paper,
          alignItems: 'center',
          justifyContent: 'center',
          padding: space.xl,
        }}
      >
        <Text style={{ color: colors.ink, fontSize: 18, marginBottom: space.lg }}>
          Camera permission needed
        </Text>
        <Pressable
          onPress={() => {
            void requestPerm();
          }}
          style={{
            backgroundColor: colors.leaf,
            paddingHorizontal: space.lg,
            paddingVertical: space.md,
            borderRadius: radii.md,
          }}
        >
          <Text style={{ color: colors.onAccent, fontFamily: fonts.bodyMedium }}>
            Grant camera access
          </Text>
        </Pressable>
        <View style={{ alignSelf: 'stretch' }}>{pasteCode}</View>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: fixed.camera }}>
      <CameraView
        style={{ flex: 1 }}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={(r) => {
          void onScan(r.data);
        }}
      />
      <View
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          padding: space.xl,
          backgroundColor: colors.shade,
        }}
      >
        {authRejected ? (
          // The server REFUSED the credential this device held (spec/10
          // § Surface). Arriving at a QR scanner with no explanation reads as
          // the app losing its place; saying what happened makes "link this
          // device again" an instruction rather than a guess.
          <Text
            testID="pair-signed-out"
            style={{ color: colors.amber, fontFamily: fonts.bodyBold, marginBottom: space.sm }}
          >
            This device was signed out ({authRejected}). Link it again to carry on.
          </Text>
        ) : null}
        <Text style={{ color: fixed.onShade, fontFamily: fonts.bodyBold, fontSize: 18 }}>
          Pair this device
        </Text>
        <Text style={{ color: fixed.onShade2, marginTop: 4 }}>
          On a linked surface open Settings → Link a device (or run `patch pair`), then point the
          camera at the QR code.
        </Text>
        {pasteCode}
      </View>
    </View>
  );
}
