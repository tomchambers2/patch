// Shared building blocks for the Settings pages (design/settings-redesign):
// a page is groups of small uppercase labels over rounded bordered cards, and a
// card is rows — a title (and an optional small subtitle) on the left, the
// control on the right. Every page composes these so a control reads the same
// wherever it appears — one button shape, one row, one field, one error line.

import React from 'react';
import { ActivityIndicator, Pressable, Switch, Text, TextInput, View } from 'react-native';
import { fonts, radii, space, textMin, typography, useTheme } from '../../lib/theme';
import { useSettingsStore } from '../../stores/settingsStore';
import type { SettingsResponse } from '../../api/rest';

/**
 * `primary` is the filled accent (one per page, the page's main action);
 * `quiet` the ordinary bordered button; `danger` red text with no border;
 * `ghost` a borderless muted one (the ⋯ on a row).
 */
export type ButtonVariant = 'primary' | 'danger' | 'quiet' | 'ghost';

export function SettingsButton({
  label,
  onPress,
  testID,
  variant = 'primary',
  disabled = false,
  accessibilityLabel,
}: {
  label: string;
  onPress: () => void;
  testID?: string;
  variant?: ButtonVariant;
  disabled?: boolean;
  accessibilityLabel?: string;
}): React.ReactElement {
  const colors = useTheme();
  const bg = variant === 'primary' ? colors.leaf : 'transparent';
  const border = variant === 'primary' ? colors.leaf : variant === 'quiet' ? colors.divider : bg;
  const fg =
    variant === 'primary'
      ? colors.onAccent
      : variant === 'danger'
        ? colors.red
        : variant === 'ghost'
          ? colors.ink3
          : colors.ink2;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        backgroundColor: pressed && variant !== 'primary' ? colors.bgSoft : bg,
        borderWidth: 1,
        borderColor: border,
        paddingVertical: space.xs + 2,
        paddingHorizontal: space.md,
        borderRadius: radii.sm + 2,
        alignSelf: 'flex-start',
        opacity: disabled ? 0.5 : 1,
      })}
    >
      <Text style={{ ...typography.label, fontSize: 14, color: fg }}>{label}</Text>
    </Pressable>
  );
}

/** A row of buttons, wrapped, with a gap. */
export function ButtonRow({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.sm }}>
      {children}
    </View>
  );
}

/** The small uppercase label over a group's card (and over the list's groups). */
export function GroupLabel({
  children,
  testID,
}: {
  children: React.ReactNode;
  testID?: string;
}): React.ReactElement {
  const colors = useTheme();
  return (
    <Text
      testID={testID}
      accessibilityRole="header"
      style={{
        fontFamily: fonts.bodyBold,
        fontSize: textMin,
        lineHeight: 18,
        letterSpacing: 0.8,
        textTransform: 'uppercase',
        color: colors.ink3,
        marginBottom: space.sm,
        marginLeft: 2,
      }}
    >
      {children}
    </Text>
  );
}

/** A green (online) or grey (offline) presence dot. */
export function Dot({ on, testID }: { on: boolean; testID?: string }): React.ReactElement {
  const colors = useTheme();
  return (
    <View
      testID={testID}
      style={{
        width: 8,
        height: 8,
        borderRadius: radii.pill,
        backgroundColor: on ? colors.leaf : colors.inkFaint,
      }}
    />
  );
}

/**
 * One row of a card: title and optional subtitle on the left, `right` (the
 * control) on the right. `stack` puts the control under the title instead, for
 * one too wide to sit beside it (chips, a field). `children` render full width
 * below — an inline form a row's button opened. Pressable when `onPress` is
 * given (a row that opens a page).
 */
export function Row({
  title,
  subtitle,
  right,
  leading,
  onPress,
  testID,
  titleTestID,
  subtitleTestID,
  accessibilityLabel,
  stack = false,
  children,
  titleColor,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  right?: React.ReactNode;
  leading?: React.ReactNode;
  onPress?: () => void;
  testID?: string;
  titleTestID?: string;
  subtitleTestID?: string;
  accessibilityLabel?: string;
  stack?: boolean;
  children?: React.ReactNode;
  titleColor?: string;
}): React.ReactElement {
  const colors = useTheme();
  const body = (
    <>
      <View
        style={{
          flexDirection: stack ? 'column' : 'row',
          alignItems: stack ? 'stretch' : 'center',
          gap: stack ? space.sm : space.md,
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, flex: 1 }}>
          {leading}
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text
              testID={titleTestID}
              style={{
                fontFamily: fonts.bodyMedium,
                fontSize: 15,
                lineHeight: 21,
                color: titleColor ?? colors.ink,
              }}
            >
              {title}
            </Text>
            {subtitle !== undefined && subtitle !== null && subtitle !== '' ? (
              <Text testID={subtitleTestID} style={{ ...typography.meta, color: colors.ink3 }}>
                {subtitle}
              </Text>
            ) : null}
          </View>
        </View>
        {right !== undefined && right !== null ? (
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: space.sm,
              ...(stack ? {} : { flexShrink: 0, maxWidth: '62%', justifyContent: 'flex-end' }),
            }}
          >
            {right}
          </View>
        ) : null}
      </View>
      {children}
    </>
  );
  const style = {
    paddingVertical: space.md,
    paddingHorizontal: space.md + 2,
    minHeight: 52,
    justifyContent: 'center' as const,
    borderTopWidth: 1,
    borderColor: colors.lineSoft,
  };
  if (onPress) {
    return (
      <Pressable
        testID={testID}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        onPress={onPress}
        style={({ pressed }) => ({
          ...style,
          backgroundColor: pressed ? colors.bgSoft : colors.paperRaised,
        })}
      >
        {body}
      </Pressable>
    );
  }
  return (
    <View testID={testID} style={{ ...style, backgroundColor: colors.paperRaised }}>
      {body}
    </View>
  );
}

/** The › at the end of a row that opens a page. */
export function Chevron(): React.ReactElement {
  const colors = useTheme();
  return <Text style={{ ...typography.body, color: colors.inkFaint }}>›</Text>;
}

/** The value a row states on its right (`Always on`, a time, a version). */
export function RowValue({
  children,
  testID,
}: {
  children: React.ReactNode;
  testID?: string;
}): React.ReactElement {
  const colors = useTheme();
  return (
    <Text
      testID={testID}
      numberOfLines={1}
      style={{ ...typography.secondary, color: colors.ink3, flexShrink: 1 }}
    >
      {children}
    </Text>
  );
}

/**
 * A labelled value that shows a loading affordance until its value resolves —
 * never a bare "—". A genuinely-unavailable value renders "Unavailable".
 */
export function ValueRow({
  label,
  value,
  loading = false,
  testID,
  subtitle,
}: {
  label: string;
  value: string | null | undefined;
  loading?: boolean;
  testID?: string;
  subtitle?: string;
}): React.ReactElement {
  const colors = useTheme();
  return (
    <Row
      title={label}
      subtitle={subtitle}
      right={
        loading && (value === undefined || value === null) ? (
          <ActivityIndicator size="small" color={colors.ink3} accessibilityLabel="Loading" />
        ) : (
          <RowValue testID={testID}>
            {value != null && value.length > 0 ? value : 'Unavailable'}
          </RowValue>
        )
      }
    />
  );
}

/** A named on/off setting, as a row with a switch. */
export function ToggleRow({
  label,
  value,
  onChange,
  testID,
  disabled = false,
  subtitle,
}: {
  label: string;
  value: boolean;
  onChange: (next: boolean) => void;
  testID: string;
  disabled?: boolean;
  subtitle?: string;
}): React.ReactElement {
  const colors = useTheme();
  return (
    <Row
      title={label}
      subtitle={subtitle}
      right={
        <Switch
          testID={testID}
          accessibilityLabel={label}
          value={value}
          disabled={disabled}
          onValueChange={onChange}
          trackColor={{ false: colors.divider, true: colors.leafSoft }}
          thumbColor={value ? colors.leaf : colors.paper}
        />
      }
    />
  );
}

/**
 * The one bordered text field every page uses. `code` sets it in the mono
 * face — for input that IS code (a JSON document), never for names or paths.
 */
export function Field(
  props: React.ComponentProps<typeof TextInput> & { code?: boolean; multiline?: boolean },
): React.ReactElement {
  const colors = useTheme();
  const { code, style, ...rest } = props;
  return (
    <TextInput
      placeholderTextColor={colors.ink3}
      autoCapitalize="none"
      autoCorrect={false}
      {...rest}
      style={[
        {
          borderWidth: 1,
          borderColor: colors.divider,
          borderRadius: radii.sm + 2,
          paddingHorizontal: space.md,
          paddingVertical: space.xs + 2,
          color: colors.ink,
          backgroundColor: colors.paper,
          fontFamily: fonts.body,
          fontSize: 15,
          ...(code ? typography.code : {}),
        },
        style,
      ]}
    />
  );
}

/** A label above a field or control, inside a row's inline form. */
export function FieldLabel({ children }: { children: React.ReactNode }): React.ReactElement {
  const colors = useTheme();
  return (
    <Text
      style={{
        ...typography.meta,
        color: colors.ink3,
        marginTop: space.sm,
        marginBottom: space.xs,
      }}
    >
      {children}
    </Text>
  );
}

/** Secondary, muted text — a state line, never an explainer. */
export function Muted({
  children,
  testID,
}: {
  children: React.ReactNode;
  testID?: string;
}): React.ReactElement {
  const colors = useTheme();
  return (
    <Text testID={testID} style={{ ...typography.meta, color: colors.ink3 }}>
      {children}
    </Text>
  );
}

/** A failure, said in the error colour, with an optional Retry. */
export function ErrorLine({
  message,
  testID,
  onRetry,
}: {
  message: string;
  testID?: string;
  onRetry?: () => void;
}): React.ReactElement {
  const colors = useTheme();
  return (
    <View style={{ marginVertical: space.xs }}>
      <Text testID={testID} accessibilityRole="alert" style={{ color: colors.red }}>
        {message}
      </Text>
      {onRetry ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Retry"
          onPress={onRetry}
          style={{ marginTop: space.xs, alignSelf: 'flex-start' }}
        >
          <Text style={{ ...typography.label, color: colors.leaf }}>Retry</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** A single choice from a short list, as wrapping pills. */
export function Chips<T extends string>({
  options,
  selected,
  onSelect,
  testIDPrefix,
  labelPrefix,
  labelOf = (o) => o,
  disabled = false,
}: {
  /** What a chip reads as; the value itself when omitted. */
  labelOf?: (value: T) => string;
  options: readonly T[];
  selected: T;
  onSelect: (value: T) => void;
  testIDPrefix: string;
  labelPrefix: string;
  disabled?: boolean;
}): React.ReactElement {
  const colors = useTheme();
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.xs }}>
      {options.map((o) => {
        const on = o === selected;
        return (
          <Pressable
            key={o}
            testID={`${testIDPrefix}-${o}`}
            accessibilityRole="button"
            accessibilityLabel={`${labelPrefix} ${labelOf(o)}`}
            accessibilityState={{ selected: on, disabled }}
            disabled={disabled}
            onPress={() => onSelect(o)}
            style={{
              paddingHorizontal: space.md - 2,
              paddingVertical: 3,
              borderRadius: radii.pill,
              borderWidth: 1,
              borderColor: on ? colors.leaf : colors.divider,
              backgroundColor: on ? colors.accentTint : 'transparent',
              opacity: disabled ? 0.5 : 1,
            }}
          >
            <Text
              style={{
                ...typography.meta,
                fontFamily: on ? fonts.bodyMedium : fonts.body,
                color: on ? colors.leafSoft : colors.ink3,
              }}
            >
              {labelOf(o)}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * Draws its children from the `/api/settings` payload once it has loaded; until
 * then a spinner, and on a failed load the failure itself with a Retry. Never a
 * stand-in set of values presented as the account's (NO FALLBACK).
 */
export function WithSettings({
  testID,
  children,
}: {
  testID: string;
  children: (data: SettingsResponse) => React.ReactNode;
}): React.ReactElement {
  const colors = useTheme();
  const data = useSettingsStore((s) => s.data);
  const error = useSettingsStore((s) => s.error);
  if (data) return <>{children(data)}</>;
  if (error) {
    return (
      <View style={{ padding: space.md }}>
        <ErrorLine
          testID={`${testID}-error`}
          message={`Couldn’t load settings: ${error}`}
          onRetry={() => void useSettingsStore.getState().load()}
        />
      </View>
    );
  }
  return (
    <View style={{ padding: space.md }}>
      <ActivityIndicator
        testID={`${testID}-loading`}
        size="small"
        color={colors.ink3}
        accessibilityLabel="Loading"
      />
    </View>
  );
}
