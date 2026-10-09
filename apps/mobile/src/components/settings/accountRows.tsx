// The pieces a Settings → Usage account row is made of, shared by the Claude
// and ChatGPT lists: re-ranking (the order IS priority), the usage refresh, the
// token form, the rank circle, the ⋯ menu, and the usage bars. The accounts
// themselves are shared settings (spec/01 § Settings), changed on the server.

import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { CLAUDE_BACKEND_ID, rateLimitWindowBlocks, type RateLimitWindow } from '@patch/wire';
import { fonts, radii, space, textMin, typography, useTheme } from '../../lib/theme';
import {
  describeDisabledReason,
  formatReadAt,
  formatUtilization,
  OVERAGE_DISABLED_REASON,
  SCOPE_LABEL,
  SCOPE_ORDER,
  type AccountUsage,
  type UsageScope,
} from '../../lib/usage';
import { AnchoredMenu, type AnchoredMenuItem } from '../AnchoredMenu';
import { sendToHost } from './hostSend';
import { Field, Muted, SettingsButton } from './ui';

/**
 * How long a connect/disconnect/add/reorder may wait for that host's
 * `daemon.account` report. The host's work is one local file write, so this
 * is a ceiling.
 */
export const CLAUDE_ACK_TIMEOUT_MS = 5_000;

/** `ids` with the one at `index` moved one place up (-1) or down (+1). */
export function moveAccount(ids: readonly string[], index: number, dir: -1 | 1): string[] {
  const next = [...ids];
  const to = index + dir;
  if (index < 0 || index >= next.length || to < 0 || to >= next.length) return next;
  const [moved] = next.splice(index, 1);
  next.splice(to, 0, moved as string);
  return next;
}

/**
 * "Read this account's usage from Anthropic now." The pending flag clears on
 * the next `daemon.account` report — the host's answer — or after the window.
 */
export function useUsageRefresh(
  daemonId: string,
  accountSeq: number,
  backendId: string = CLAUDE_BACKEND_ID,
): { refresh: () => void; refreshing: boolean } {
  const [pendingSeq, setPendingSeq] = React.useState<number | null>(null);
  React.useEffect(() => {
    if (pendingSeq === null) return;
    if (accountSeq !== pendingSeq) {
      setPendingSeq(null);
      return;
    }
    const timer = setTimeout(() => setPendingSeq(null), CLAUDE_ACK_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [pendingSeq, accountSeq]);
  return {
    refreshing: pendingSeq !== null,
    refresh: () => {
      if (
        sendToHost(
          daemonId,
          { type: 'host.backend_usage_refresh', daemonId, backendId },
          'Refresh usage',
        )
      ) {
        setPendingSeq(accountSeq);
      }
    },
  };
}

/** A token field revealed by Connect / Add account, sending on its own button. */
export function TokenEntry({
  testID,
  placeholder,
  submitLabel,
  onSubmit,
  withLabel = false,
}: {
  testID: string;
  placeholder: string;
  submitLabel: string;
  onSubmit: (token: string, label: string) => void;
  withLabel?: boolean;
}): React.ReactElement {
  const [token, setToken] = React.useState('');
  const [label, setLabel] = React.useState('');
  return (
    <View style={{ marginTop: space.sm, gap: space.sm }}>
      <Field
        testID={`${testID}-token`}
        accessibilityLabel="Claude token"
        value={token}
        onChangeText={setToken}
        placeholder={placeholder}
        secureTextEntry
      />
      {withLabel ? (
        <Field
          testID={`${testID}-label`}
          accessibilityLabel="Account label"
          value={label}
          onChangeText={setLabel}
          placeholder="Label"
        />
      ) : null}
      <SettingsButton
        testID={`${testID}-submit`}
        label={submitLabel}
        onPress={() => onSubmit(token.trim(), label.trim())}
      />
    </View>
  );
}

/** The rank circle: accent-filled on the account the host is using now. */
export function Rank({ n, active }: { n: number; active: boolean }): React.ReactElement {
  const colors = useTheme();
  return (
    <View
      style={{
        width: 22,
        height: 22,
        borderRadius: radii.pill,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: active ? colors.leaf : colors.bgSoft,
      }}
    >
      <Text
        style={{
          fontFamily: fonts.bodyBold,
          fontSize: textMin - 1,
          color: active ? colors.onAccent : colors.ink3,
        }}
      >
        {n}
      </Text>
    </View>
  );
}

/** The ⋯ on an account row and the menu of its actions. */
export function RowMenu({
  testID,
  label,
  items,
  onSelect,
}: {
  testID: string;
  label: string;
  items: AnchoredMenuItem[];
  onSelect: (id: string) => void;
}): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <SettingsButton
        testID={testID}
        label="⋯"
        variant="ghost"
        accessibilityLabel={`${label} actions`}
        onPress={() => setOpen(true)}
      />
      <AnchoredMenu
        visible={open}
        items={items}
        onDismiss={() => setOpen(false)}
        onSelect={onSelect}
      />
    </>
  );
}

/** Rank-order menu items for the account at `index` of `count`. */
export function moveItems(
  testIDPrefix: string,
  index: number,
  count: number,
  moving: boolean,
): AnchoredMenuItem[] {
  const items: AnchoredMenuItem[] = [];
  if (index > 0) {
    items.push({ id: 'up', label: 'Move up', testID: `${testIDPrefix}-up`, disabled: moving });
  }
  if (index < count - 1) {
    items.push({
      id: 'down',
      label: 'Move down',
      testID: `${testIDPrefix}-down`,
      disabled: moving,
    });
  }
  return items;
}

/**
 * One usage window: label, a bar, the figure. The same `rejected` means two
 * things — on the 5-hour or week, work has stopped; on Extra usage, the add-on
 * was never bought — so Extra usage reads as "off", not blocked. When it
 * resets is left off on the phone, as the design does.
 */
export function UsageLine({
  scope,
  win,
  testID,
}: {
  scope: UsageScope;
  win: RateLimitWindow | undefined;
  testID: string;
}): React.ReactElement | null {
  const colors = useTheme();
  if (!win) return null;
  const blocked = rateLimitWindowBlocks(scope, win);
  const off = scope === 'overage' && win.status === 'rejected';
  const warn = !blocked && !off && (win.utilization ?? 0) >= 0.8;
  const fill = blocked ? colors.red : warn ? colors.amber : off ? colors.ink3 : colors.leaf;
  const pct = Math.min(100, Math.round((win.utilization ?? 0) * 100));
  const reason =
    win.disabledReason !== undefined && win.disabledReason !== OVERAGE_DISABLED_REASON
      ? describeDisabledReason(win.disabledReason)
      : null;
  return (
    <View testID={testID} style={{ marginTop: space.xs }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        <Text style={{ ...typography.meta, color: colors.ink3, width: 76 }}>
          {SCOPE_LABEL[scope]}
        </Text>
        <View
          style={{
            flex: 1,
            height: 5,
            borderRadius: 3,
            backgroundColor: colors.bgSoft,
            overflow: 'hidden',
          }}
        >
          <View style={{ width: `${off ? 0 : pct}%`, height: 5, backgroundColor: fill }} />
        </View>
        <Text
          style={{
            ...typography.meta,
            color: blocked ? colors.red : colors.ink3,
            minWidth: 40,
            textAlign: 'right',
          }}
        >
          {off ? 'off' : formatUtilization(win)}
          {blocked ? ' · blocked' : ''}
        </Text>
      </View>
      {reason ? <Muted>{reason}</Muted> : null}
    </View>
  );
}

/** Everything known about one account's limits, and when it was read. */
export function UsageBars({
  usage,
  testID,
  refreshing,
  onRefresh,
  scopes = SCOPE_ORDER,
}: {
  usage: AccountUsage | undefined;
  testID: string;
  refreshing: boolean;
  /** Present on a row with no ⋯ to put Refresh in (the legacy single account). */
  onRefresh?: () => void;
  scopes?: readonly UsageScope[];
}): React.ReactElement {
  const colors = useTheme();
  const readAt = formatReadAt(usage?.at);
  return (
    <View testID={testID} style={{ marginTop: space.xs }}>
      {usage === undefined ? (
        <Muted testID={`${testID}-empty`}>Usage not read yet</Muted>
      ) : (
        scopes.map((scope) => (
          <UsageLine key={scope} scope={scope} win={usage[scope]} testID={`${testID}-${scope}`} />
        ))
      )}
      <View
        style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: space.xs }}
      >
        {refreshing ? (
          <Muted testID={`${testID}-reading`}>Reading…</Muted>
        ) : readAt ? (
          <Muted>{readAt}</Muted>
        ) : null}
        {onRefresh ? (
          <Pressable
            testID={`${testID}-refresh`}
            accessibilityRole="button"
            accessibilityLabel="Refresh usage"
            disabled={refreshing}
            onPress={onRefresh}
          >
            <Text style={{ ...typography.meta, color: colors.leaf }}>Refresh</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}
