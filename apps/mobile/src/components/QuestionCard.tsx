// The inline card for an `AskUserQuestion` permission request (spec/15 §
// Chat detail; mirrors `packages/web/src/components/QuestionCard.tsx` —
// deliberately duplicated rather than shared, same convention as
// `toolsCatalog.ts`).
//
// The agent asking the user to choose is NOT an approval. Rendering it as one
// is wrong twice over: it shows the tool's name instead of the question, and
// "Approve" returns no answer at all, so the agent carries on having asked and
// heard nothing. This card renders what was actually asked — the header chip,
// the question, and each option's label with the trade-off the agent wrote
// beneath it — and returns the selections through `approve_with_edits`
// (spec/03 § Answering with content). Cancel is a real deny.

import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import type { ChatEventEntry } from '../stores/chatStore';
import {
  joinAnswer,
  parseAskUserQuestion,
  parseStoredAnswer,
  type AskQuestion,
} from '../lib/askUserQuestion';
import { fonts, radii, space, typography, useTheme } from '../lib/theme';

/** The label of the free-text escape hatch Claude Code always offers. */
const OTHER = 'Other';

/**
 * How often the countdown ring redraws (mirrors web's `QuestionCard.tsx`).
 * Four times a second reads as movement rather than a ticking clock.
 */
const COUNTDOWN_TICK_MS = 250;

/** The ring's geometry, in the SVG's own user units. */
const RING_RADIUS = 9;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/**
 * The question's remaining time, as a ring that empties (spec/14 § Main chat
 * panel — Question prompts; ported from `packages/web/src/components/
 * QuestionCard.tsx`'s `QuestionCountdown`, same geometry and semantics).
 *
 * Counts down to the HOST's absolute deadline (`expiry.at`), not to a clock
 * started on mount — a chat opened partway through the window draws a ring
 * already partly gone rather than a fresh full one. Reaching zero does not
 * resolve the card; only the host does that, so the ring just stops.
 */
function QuestionCountdown({
  expiry,
  now,
}: {
  expiry: { at: number; windowMs: number };
  now(): number;
}): React.JSX.Element {
  const colors = useTheme();
  const [remainingMs, setRemainingMs] = useState(() => Math.max(0, expiry.at - now()));

  useEffect(() => {
    setRemainingMs(Math.max(0, expiry.at - now()));
    if (expiry.at - now() <= 0) return;
    const id = setInterval(() => {
      const left = Math.max(0, expiry.at - now());
      setRemainingMs(left);
      if (left === 0) clearInterval(id);
    }, COUNTDOWN_TICK_MS);
    return () => clearInterval(id);
  }, [expiry.at, expiry.windowMs, now]);

  const fraction = Math.min(1, Math.max(0, remainingMs / expiry.windowMs));
  // Rounded UP so the last whole second on screen is a second the user still
  // has: `floor` would show 0 for the final 999ms of a window not yet run out.
  const secondsLeft = Math.ceil(remainingMs / 1000);
  const expired = remainingMs === 0;

  return (
    <View
      testID="question-countdown"
      accessibilityLabel={
        expired
          ? 'question expired'
          : `${secondsLeft} ${secondsLeft === 1 ? 'second' : 'seconds'} left to answer`
      }
      style={{
        position: 'absolute',
        top: 10,
        right: 10,
        width: 24,
        height: 24,
      }}
    >
      <Svg width={24} height={24} viewBox="0 0 24 24" style={{ transform: [{ rotate: '-90deg' }] }}>
        <Circle
          testID="question-countdown-track"
          cx={12}
          cy={12}
          r={RING_RADIUS}
          fill="none"
          stroke={colors.divider}
          strokeWidth={3}
        />
        <Circle
          testID="question-countdown-fill"
          cx={12}
          cy={12}
          r={RING_RADIUS}
          fill="none"
          stroke={expired ? colors.divider : colors.amber}
          strokeWidth={3}
          strokeLinecap="round"
          strokeDasharray={RING_CIRCUMFERENCE}
          strokeDashoffset={RING_CIRCUMFERENCE * (1 - fraction)}
        />
      </Svg>
    </View>
  );
}

function OptionIndicator({
  multiSelect,
  on,
  accent,
  divider,
}: {
  multiSelect: boolean;
  on: boolean;
  accent: string;
  divider: string;
}): React.JSX.Element {
  const size = 18;
  return (
    <View
      testID="question-indicator"
      style={{
        width: size,
        height: size,
        borderRadius: multiSelect ? 4 : size / 2,
        borderWidth: 2,
        borderColor: on ? accent : divider,
        backgroundColor: on ? accent : 'transparent',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    />
  );
}

export function QuestionCard({
  entry,
  onAnswer,
  onCancel,
}: {
  entry: ChatEventEntry;
  onAnswer(requestId: string, answers: Record<string, string>): void;
  onCancel(requestId: string): void;
}): React.JSX.Element {
  const colors = useTheme();
  const questions = useMemo(() => parseAskUserQuestion(entry.toolArgs), [entry.toolArgs]);

  if (questions === null) {
    // NO FALLBACK: an unreadable question is not silently downgraded to an
    // approve/deny — that is how an unanswered question reaches the agent as
    // an answer. Say so, and leave Cancel as the only honest way out.
    return (
      <View
        testID="question-card"
        style={{
          backgroundColor: colors.paperRaised,
          borderWidth: 1,
          borderColor: colors.red,
          borderRadius: radii.lg,
          padding: space.md,
          marginBottom: space.sm,
          position: 'relative',
        }}
      >
        {entry.permissionExpiry && !entry.permissionResolved ? (
          <QuestionCountdown expiry={entry.permissionExpiry} now={Date.now} />
        ) : null}
        <Text testID="question-parse-error" style={{ color: colors.red }}>
          The agent asked a question this app could not read. Cancel it and ask the agent to try
          again.
        </Text>
        <QuestionFooter entry={entry} onCancel={onCancel} colors={colors} />
      </View>
    );
  }

  return (
    <QuestionForm entry={entry} questions={questions} onAnswer={onAnswer} onCancel={onCancel} />
  );
}

function QuestionFooter({
  entry,
  onCancel,
  colors,
  submit,
}: {
  entry: ChatEventEntry;
  onCancel(requestId: string): void;
  colors: ReturnType<typeof useTheme>;
  submit?: { disabled: boolean; onPress(): void };
}): React.JSX.Element | null {
  const resolved = entry.permissionResolved;
  if (resolved) {
    return (
      <Text
        testID="permission-outcome"
        style={{ ...typography.meta, color: colors.ink3, marginTop: space.sm }}
      >
        {resolved === 'approve' ? 'Answered' : 'Cancelled'}
      </Text>
    );
  }
  if (!entry.requestId) return null;
  const requestId = entry.requestId;
  return (
    <View style={{ flexDirection: 'row', gap: space.sm, marginTop: space.sm }}>
      {submit ? (
        <Pressable
          testID="question-submit"
          disabled={submit.disabled}
          onPress={submit.onPress}
          style={{
            flex: 1,
            backgroundColor: submit.disabled ? colors.divider : colors.leaf,
            borderRadius: radii.md,
            paddingVertical: space.md,
            alignItems: 'center',
          }}
        >
          <Text style={{ ...typography.label, color: colors.onAccent }}>Send answer</Text>
        </Pressable>
      ) : null}
      <Pressable
        testID="question-cancel"
        onPress={() => onCancel(requestId)}
        style={{
          flex: submit ? undefined : 1,
          paddingVertical: space.md,
          paddingHorizontal: space.md,
          borderRadius: radii.md,
          borderWidth: 1,
          borderColor: colors.divider,
          alignItems: 'center',
        }}
      >
        <Text style={{ ...typography.label, color: colors.ink }}>Cancel</Text>
      </Pressable>
    </View>
  );
}

function QuestionForm({
  entry,
  questions,
  onAnswer,
  onCancel,
}: {
  entry: ChatEventEntry;
  questions: AskQuestion[];
  onAnswer(requestId: string, answers: Record<string, string>): void;
  onCancel(requestId: string): void;
}): React.JSX.Element {
  const colors = useTheme();
  const resolved = entry.permissionResolved;
  const requestId = entry.requestId;
  // Selected option labels per question, and the free-text `Other` answer.
  // `otherOn` is separate from the text so an empty `Other` still counts as
  // chosen-but-unanswered, which is what keeps Submit disabled.
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [otherOn, setOtherOn] = useState<Record<string, boolean>>({});
  const [otherText, setOtherText] = useState<Record<string, string>>({});

  // A resolved card redraws from `entry.permissionAnswers` — the store's
  // durable record of what was picked — rather than from `picked`/`otherOn`/
  // `otherText` above, which live only in this component instance and are
  // gone the moment it remounts (mirrors web's `QuestionCard.tsx`).
  const storedAnswers = entry.permissionAnswers;
  const resolvedDisplay = useMemo(() => {
    if (!storedAnswers) return null;
    const p: Record<string, string[]> = {};
    const o: Record<string, boolean> = {};
    const t: Record<string, string> = {};
    for (const q of questions) {
      const answer = storedAnswers[q.question];
      if (answer === undefined) continue;
      const parsed = parseStoredAnswer(answer, q.options, q.multiSelect);
      p[q.question] = parsed.picked;
      if (parsed.other !== null) {
        o[q.question] = true;
        t[q.question] = parsed.other;
      }
    }
    return { picked: p, otherOn: o, otherText: t };
  }, [storedAnswers, questions]);

  function answerFor(question: string): string {
    const labels = picked[question] ?? [];
    const free = otherOn[question] ? (otherText[question] ?? '').trim() : '';
    const multi = questions.find((q) => q.question === question)?.multiSelect === true;
    if (otherOn[question] && free.length === 0 && !multi) return OTHER;
    return joinAnswer(free.length > 0 ? [...labels, free] : labels);
  }

  const complete = questions.every((q) => answerFor(q.question).length > 0);

  function toggle(question: string, label: string, multiSelect: boolean): void {
    setPicked((prev) => {
      const current = prev[question] ?? [];
      if (!multiSelect) {
        return { ...prev, [question]: current.includes(label) ? [] : [label] };
      }
      return {
        ...prev,
        [question]: current.includes(label)
          ? current.filter((l) => l !== label)
          : [...current, label],
      };
    });
    // A single-select question has exactly one answer, so picking an option
    // puts the free-text escape hatch away rather than quietly appending to it.
    if (!multiSelect) setOtherOn((prev) => ({ ...prev, [question]: false }));
  }

  function toggleOther(question: string, multiSelect: boolean): void {
    setOtherOn((prev) => {
      const next = prev[question] !== true;
      if (next && !multiSelect) setPicked((p) => ({ ...p, [question]: [] }));
      return { ...prev, [question]: next };
    });
  }

  function submit(): void {
    if (!requestId || !complete) return;
    const answers: Record<string, string> = {};
    for (const q of questions) answers[q.question] = answerFor(q.question);
    onAnswer(requestId, answers);
  }

  return (
    <View
      testID="question-card"
      style={{
        backgroundColor: resolved ? colors.bgSoft : colors.waitingTint,
        borderWidth: 1,
        borderColor: resolved ? colors.lineSoft : colors.amber,
        borderRadius: radii.lg,
        padding: space.md,
        marginBottom: space.sm,
        position: 'relative',
      }}
    >
      {entry.permissionExpiry && !resolved ? (
        <QuestionCountdown expiry={entry.permissionExpiry} now={Date.now} />
      ) : null}
      {questions.map((q) => {
        const selected = resolved
          ? (resolvedDisplay?.picked[q.question] ?? [])
          : (picked[q.question] ?? []);
        const otherActive = resolved
          ? resolvedDisplay?.otherOn[q.question] === true
          : otherOn[q.question] === true;
        const resolvedOtherText = resolved ? resolvedDisplay?.otherText[q.question] : undefined;
        return (
          <View testID="question-block" key={q.question} style={{ marginBottom: space.md }}>
            <Text
              style={{
                ...typography.meta,
                fontFamily: fonts.bodyBold,
                color: resolved ? colors.ink3 : colors.ink2,
                marginBottom: 2,
              }}
            >
              {q.header}
            </Text>
            <Text
              style={{
                ...typography.body,
                color: resolved ? colors.ink2 : colors.ink,
                marginBottom: space.sm,
              }}
            >
              {q.question}
            </Text>
            <View style={{ gap: space.xs }}>
              {q.options.map((o) => {
                const on = selected.includes(o.label);
                return (
                  <Pressable
                    key={o.label}
                    testID="question-option"
                    accessibilityRole={q.multiSelect ? 'checkbox' : 'radio'}
                    accessibilityState={{ checked: on, disabled: resolved !== undefined }}
                    disabled={resolved !== undefined}
                    onPress={() => toggle(q.question, o.label, q.multiSelect)}
                    style={{
                      flexDirection: 'row',
                      alignItems: 'flex-start',
                      gap: space.sm,
                      padding: space.sm,
                      borderRadius: radii.md,
                      borderWidth: 1,
                      borderColor: on ? colors.leaf : colors.divider,
                      backgroundColor: colors.paperRaised,
                    }}
                  >
                    <View style={{ marginTop: 2 }}>
                      <OptionIndicator
                        multiSelect={q.multiSelect}
                        on={on}
                        accent={colors.leaf}
                        divider={colors.divider}
                      />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={{ ...typography.label, color: colors.ink }}>{o.label}</Text>
                      {o.description ? (
                        <Text style={{ ...typography.meta, color: colors.ink3, marginTop: 2 }}>
                          {o.description}
                        </Text>
                      ) : null}
                    </View>
                  </Pressable>
                );
              })}
              <Pressable
                testID="question-other"
                accessibilityRole={q.multiSelect ? 'checkbox' : 'radio'}
                accessibilityState={{ checked: otherActive, disabled: resolved !== undefined }}
                disabled={resolved !== undefined}
                onPress={() => toggleOther(q.question, q.multiSelect)}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: space.sm,
                  padding: space.sm,
                  borderRadius: radii.md,
                  borderWidth: 1,
                  borderColor: otherActive ? colors.leaf : colors.divider,
                  backgroundColor: colors.paperRaised,
                }}
              >
                <OptionIndicator
                  multiSelect={q.multiSelect}
                  on={otherActive}
                  accent={colors.leaf}
                  divider={colors.divider}
                />
                <Text style={{ ...typography.label, color: colors.ink }}>{OTHER}</Text>
              </Pressable>
            </View>
            {otherActive && !resolved ? (
              <TextInput
                testID="question-other-input"
                accessibilityLabel={`Other answer for ${q.question}`}
                multiline
                autoFocus
                value={otherText[q.question] ?? ''}
                onChangeText={(text) => setOtherText((prev) => ({ ...prev, [q.question]: text }))}
                style={{
                  ...typography.body,
                  color: colors.ink,
                  borderWidth: 1,
                  borderColor: colors.divider,
                  borderRadius: radii.md,
                  padding: space.sm,
                  marginTop: space.sm,
                  minHeight: 40,
                }}
              />
            ) : null}
            {resolved && otherActive ? (
              // Read-only counterpart to the TextInput above, for a resolved
              // card's free-text answer — the live input only mounts while
              // the card is still answerable.
              <Text
                testID="question-other-answer"
                style={{
                  ...typography.body,
                  color: colors.ink2,
                  borderWidth: 1,
                  borderColor: colors.lineSoft,
                  borderRadius: radii.md,
                  padding: space.sm,
                  marginTop: space.sm,
                }}
              >
                {resolvedOtherText}
              </Text>
            ) : null}
          </View>
        );
      })}
      <QuestionFooter
        entry={entry}
        onCancel={onCancel}
        colors={colors}
        submit={{ disabled: !complete, onPress: submit }}
      />
    </View>
  );
}
