// The inline card for an `AskUserQuestion` permission request
// (spec/14 § Main chat panel — Question prompts).
//
// The agent asking the user to choose is NOT an approval. Rendering it as one
// is wrong twice over: it shows the tool's name instead of the question, and
// "Approve" returns no answer at all, so the agent carries on having asked and
// heard nothing. This card renders what was actually asked — the header chip,
// the question, and each option's label with the trade-off the agent wrote
// beneath it — and returns the selections through `approve_with_edits`
// (spec/03 § Answering with content). Cancel is a real deny.
//
// It is also answerable without the mouse, on the roving-tabindex pattern: one
// option per question is in the Tab sequence, so Tab steps question-to-question
// rather than through every option of every question, and ↑/↓ (or ←/→) step
// between the focused question's own options.
//
// Selections made but not yet sent survive a remount, via
// `stores/questionDraftStore.ts`. The card is rebuilt far more often than it
// looks — every chat switch remounts it — and because Send answer is disabled
// until every question has an answer (spec/14), a card that silently emptied
// itself could not be submitted at all.

import type { JSX, KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChatEventEntry } from '../stores/chatStore.js';
import {
  joinAnswer,
  parseAskUserQuestion,
  parseStoredAnswer,
  type AskQuestion,
} from '../lib/askUserQuestion.js';
import { sendChordSpoken } from '../lib/sendChord.js';
import { shortcutLabel } from '../lib/shortcuts.js';
import { isSubmitChord } from '../lib/submitChord.js';
import { useQuestionDraftStore } from '../stores/questionDraftStore.js';

/** The label of the free-text escape hatch Claude Code always offers. */
const OTHER = 'Other';

/** The keys that move the cursor within one question's options. */
const OPTION_NAV_KEYS = new Set(['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'Home', 'End']);

/**
 * How often the countdown ring redraws. Four times a second reads as movement
 * rather than as a clock ticking, which is what "slowly going down" asks for,
 * and it is cheap: the card is one element and the tick only ever changes a
 * number and a dash offset.
 */
const COUNTDOWN_TICK_MS = 250;

/** The ring's geometry, in the SVG's own user units. */
const RING_RADIUS = 9;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/**
 * The question's remaining time, as a ring that empties (spec/14 § Main chat
 * panel — Question prompts; Tom, App Updates: "patch should show a 1 minute
 * timer on a question, slowly going down, a circle pie chart thing. so the
 * user knows when it expires").
 *
 * It counts down to the HOST's deadline, handed over on the request, not to
 * a clock this card started when it mounted: the chat may have been opened
 * halfway through the window, or the request replayed to a surface that
 * reconnected, and in both cases a fresh full ring would promise time that has
 * already gone. `windowMs` is what the ring is a fraction OF, so a card opened
 * late is drawn already part-depleted rather than full.
 *
 * Reaching zero does NOT resolve the card. Only the host resolves a request,
 * and the client inventing a resolution off its own clock is exactly the kind
 * of fallback that would show "Cancelled" for a question that was in fact
 * answered a moment later. At zero the ring is empty, says so, and stops.
 *
 * `role="timer"` rather than a live region: a value changing four times a
 * second announced continuously is unusable, and `timer` is the role whose
 * whole point is an accessible name carrying the remaining time for a reader
 * that asks for it. The ring is not focusable and sits outside
 * `.question-options`, so the card's roving tabindex is untouched.
 */
function QuestionCountdown({
  expiry,
  now,
}: {
  expiry: { at: number; windowMs: number };
  now(): number;
}): JSX.Element {
  const [remainingMs, setRemainingMs] = useState(() => Math.max(0, expiry.at - now()));

  useEffect(() => {
    setRemainingMs(Math.max(0, expiry.at - now()));
    // An elapsed countdown has nothing left to animate; leaving an interval
    // running on it would redraw the same empty ring forever.
    if (expiry.at - now() <= 0) return;
    const id = setInterval(() => {
      const left = Math.max(0, expiry.at - now());
      setRemainingMs(left);
      if (left === 0) clearInterval(id);
    }, COUNTDOWN_TICK_MS);
    return () => clearInterval(id);
  }, [expiry.at, expiry.windowMs, now]);

  const fraction = Math.min(1, Math.max(0, remainingMs / expiry.windowMs));
  // Rounded UP, so the last whole second on screen is a second the user still
  // has: a `floor` would show "0 seconds left" for the final 999ms of a window
  // that has not run out.
  const secondsLeft = Math.ceil(remainingMs / 1000);

  return (
    <span
      className="question-countdown"
      data-testid="question-countdown"
      data-seconds-left={secondsLeft}
      data-expired={remainingMs === 0 ? 'true' : 'false'}
      role="timer"
      aria-label={
        remainingMs === 0
          ? 'question expired'
          : `${secondsLeft} ${secondsLeft === 1 ? 'second' : 'seconds'} left to answer`
      }
    >
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <circle className="question-countdown-track" cx="12" cy="12" r={RING_RADIUS} />
        <circle
          className="question-countdown-fill"
          cx="12"
          cy="12"
          r={RING_RADIUS}
          strokeDasharray={RING_CIRCUMFERENCE}
          strokeDashoffset={RING_CIRCUMFERENCE * (1 - fraction)}
        />
      </svg>
    </span>
  );
}

/**
 * The wordless answer to "how many of these may I pick?" (Tom, App Updates:
 * "patch multi select for questions is not clear").
 *
 * A `multiSelect` question used to render identically to a single-select one —
 * same outlined rows, the difference carried entirely by `role` and by what
 * clicking a second option did. Screen-reader users were told; sighted users
 * picked one and moved on. A square-with-a-tick versus a circle-with-a-dot is
 * the universal signal for many versus one, and it costs no explanatory prose
 * (CLAUDE.md: text only for titles).
 *
 * It is `aria-hidden` DECORATION. The accessible state is already on the button
 * — `role="checkbox"`/`"radio"` plus `aria-checked` — and a second copy here
 * would say "checked" twice into the accessible name. The shapes are drawn in
 * CSS from the palette tokens so they invert with the theme; `data-indicator`
 * and `data-checked` are what the tests read.
 */
function OptionIndicator({ multiSelect, on }: { multiSelect: boolean; on: boolean }): JSX.Element {
  return (
    <span
      className={`question-indicator question-indicator-${multiSelect ? 'check' : 'radio'}`}
      data-testid="question-indicator"
      data-indicator={multiSelect ? 'checkbox' : 'radio'}
      data-checked={on ? 'true' : 'false'}
      aria-hidden="true"
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
}): JSX.Element {
  const questions = useMemo(() => parseAskUserQuestion(entry.toolArgs), [entry.toolArgs]);
  if (questions === null) {
    // NO FALLBACK: an unreadable question is not silently downgraded to an
    // approve/deny — that is how an unanswered question reaches the agent as
    // an answer. Say so, and leave Cancel as the only honest way out.
    return (
      <div className="permission question-card question-card-broken" data-testid="question-card">
        {/* Unreadable, but still on the daemon's clock — the one thing this
            card CAN honestly say about a question it cannot render is how long
            is left to cancel it. */}
        {entry.permissionExpiry && !entry.permissionResolved ? (
          <QuestionCountdown expiry={entry.permissionExpiry} now={Date.now} />
        ) : null}
        <p role="alert" data-testid="question-parse-error">
          The agent asked a question this app could not read. Cancel it and ask the agent to try
          again.
        </p>
        <Footer entry={entry} onCancel={onCancel} />
      </div>
    );
  }
  return (
    <QuestionForm entry={entry} questions={questions} onAnswer={onAnswer} onCancel={onCancel} />
  );
}

/** Cancel + the settled outcome — the parts both card states share. */
function Footer({
  entry,
  onCancel,
  submit,
}: {
  entry: ChatEventEntry;
  onCancel(requestId: string): void;
  submit?: { disabled: boolean; onClick(): void };
}): JSX.Element | null {
  const resolved = entry.permissionResolved;
  if (resolved) {
    return (
      <p className="permission-outcome" data-testid="permission-outcome">
        {resolved === 'approve' ? 'Answered' : 'Cancelled'}
      </p>
    );
  }
  if (!entry.requestId) return null;
  const requestId = entry.requestId;
  return (
    <div className="permission-buttons">
      {submit ? (
        /* The button STATES the send chord (Tom, App Updates: "patch show CMD +
           enter (or windows version) on the answer question button, since enter
           is newline"). The `Other` box above it is the one field in the app
           where `↵` inserts a newline instead of sending, and nothing on screen
           said which key did send — so a long answer was typed into a box whose
           way out had to be guessed.

           The chord is read from the BROWSER, never from a host's `platform`:
           the machine the agent runs on is routinely not the machine being
           typed on, and `⌘` names a key a Windows keyboard does not have.

           Glyphs are decoration here, `aria-hidden` like `OptionIndicator`, and
           the keys are said in words in the accessible name instead — "⌘↵" read
           aloud is noise, and the button still has to be findable as Send
           answer. */
        <button
          type="button"
          className="question-submit"
          data-testid="question-submit"
          aria-label={`Send answer, ${sendChordSpoken()}`}
          disabled={submit.disabled}
          onClick={submit.onClick}
        >
          Send answer
          <span className="btn-chord" data-testid="question-submit-chord" aria-hidden="true">
            {shortcutLabel('⌘↵')}
          </span>
        </button>
      ) : null}
      <button type="button" data-testid="question-cancel" onClick={() => onCancel(requestId)}>
        Cancel
      </button>
    </div>
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
}): JSX.Element {
  const resolved = entry.permissionResolved;
  const requestId = entry.requestId;
  // Selected option labels per question, and the free-text `Other` answer.
  // `otherOn` is separate from the text so an empty `Other` still counts as
  // chosen-but-unanswered, which is what keeps Submit disabled.
  //
  // SEEDED FROM THE DRAFT STORE, not from empty. This component instance is
  // torn down and rebuilt constantly — switching chats and back, a reload, the
  // timeline row's key shifting — and an open card that came back blank left
  // Send answer disabled with the agent still waiting (see
  // `stores/questionDraftStore.ts`). Read once, at mount: the draft only ever
  // changes from this card's own clicks, so subscribing would re-render it on
  // its own writes for nothing.
  const [picked, setPicked] = useState<Record<string, string[]>>(
    () => (requestId ? useQuestionDraftStore.getState().get(requestId)?.picked : undefined) ?? {},
  );
  const [otherOn, setOtherOn] = useState<Record<string, boolean>>(
    () => (requestId ? useQuestionDraftStore.getState().get(requestId)?.otherOn : undefined) ?? {},
  );
  const [otherText, setOtherText] = useState<Record<string, string>>(
    () =>
      (requestId ? useQuestionDraftStore.getState().get(requestId)?.otherText : undefined) ?? {},
  );
  // Which option in each question currently holds the roving tabindex
  // (spec/14 § Main chat panel — Question prompts). Keyed by question text, and
  // absent means the first option, so an untouched card needs no seeding.
  const [activeOption, setActiveOption] = useState<Record<string, number>>({});
  const cardRef = useRef<HTMLDivElement>(null);

  // A resolved card redraws from `entry.permissionAnswers` — the store's
  // durable record of what was picked — rather than from `picked`/`otherOn`/
  // `otherText` above, which live only in this component instance and are
  // gone the moment it remounts (switching chats and back, a reload, the
  // host echoing a resolution this surface didn't originate). Without this,
  // an answered card shows every option blank instead of what was actually
  // sent (spec/14 § Main chat panel — Question prompts).
  const storedAnswers = entry.permissionAnswers;
  const resolvedDisplay = useMemo(() => {
    if (!storedAnswers) return null;
    const picked: Record<string, string[]> = {};
    const otherOn: Record<string, boolean> = {};
    const otherText: Record<string, string> = {};
    for (const q of questions) {
      const answer = storedAnswers[q.question];
      if (answer === undefined) continue;
      const parsed = parseStoredAnswer(answer, q.options, q.multiSelect);
      picked[q.question] = parsed.picked;
      if (parsed.other !== null) {
        otherOn[q.question] = true;
        otherText[q.question] = parsed.other;
      }
    }
    return { picked, otherOn, otherText };
  }, [storedAnswers, questions]);

  useEffect(() => {
    if (resolved || !requestId) return;
    // Land ON the first option rather than on the card, so ↑/↓ answer the
    // question immediately instead of needing a Tab first. The card itself is
    // only the fallback for a shape with no option buttons at all.
    const first = cardRef.current?.querySelector<HTMLButtonElement>('button.question-option');
    (first ?? cardRef.current)?.focus();
  }, [resolved, requestId]);

  // Write every change through, so the NEXT mount of this card starts where
  // this one left off. Only while it is still answerable: a resolved card's
  // selections come from `permissionAnswers` below, which is the durable
  // record, and re-saving them here would keep a spent draft alive.
  useEffect(() => {
    if (!requestId || resolved) return;
    useQuestionDraftStore.getState().set(requestId, { picked, otherOn, otherText });
  }, [requestId, resolved, picked, otherOn, otherText]);

  // Answered, cancelled, or expired — the draft has done its job. Covers the
  // resolutions this surface did NOT originate too (another surface answered
  // it, the daemon timed it out), which never pass through `submit` below.
  useEffect(() => {
    if (requestId && resolved) useQuestionDraftStore.getState().clear(requestId);
  }, [requestId, resolved]);

  /**
   * ONE option per question sits in the Tab sequence, so Tab steps
   * question-to-question instead of walking every option of every question.
   */
  function optionTabIndex(question: string, index: number): number {
    return (activeOption[question] ?? 0) === index ? 0 : -1;
  }

  /** Whatever put the cursor on an option — click, Tab, arrow — becomes that
      question's Tab stop, so Tab returns to where the question was left. */
  function rememberFocus(question: string, index: number): void {
    setActiveOption((prev) => (prev[question] === index ? prev : { ...prev, [question]: index }));
  }

  /**
   * Arrow/Home/End inside one question's options. Moving the cursor does NOT
   * choose: `Other` is one of the options the arrows land on, and choosing it
   * opens the free-text box and takes the cursor, so a select-as-you-move
   * radiogroup would end the journey the first time it passed over `Other`.
   * `↵`/`Space` on the focused option is what chooses, as it does on any button.
   */
  function onOptionsKeyDown(e: ReactKeyboardEvent<HTMLDivElement>, question: string): void {
    // ⌘↑/⌘↓ step the sidebar's chat rows — a chord is never option navigation.
    if (!OPTION_NAV_KEYS.has(e.key) || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    const options = Array.from(
      e.currentTarget.querySelectorAll<HTMLButtonElement>('button.question-option'),
    );
    const from = options.indexOf(document.activeElement as HTMLButtonElement);
    if (from < 0) return;
    e.preventDefault();
    const last = options.length - 1;
    const forward = e.key === 'ArrowDown' || e.key === 'ArrowRight';
    // The options are a vertical list, but ←/→ move too: the card is one of the
    // few places a keyboard user arrives at without knowing which axis it drew.
    const next =
      e.key === 'Home'
        ? 0
        : e.key === 'End'
          ? last
          : forward
            ? (from + 1) % options.length
            : (from + last) % options.length;
    rememberFocus(question, next);
    options[next]?.focus();
  }

  function answerFor(question: string): string {
    const labels = picked[question] ?? [];
    const free = otherOn[question] ? (otherText[question] ?? '').trim() : '';
    // Single-select: `Other` is an option like any other, so choosing it with no
    // comment is a complete answer — it sends the label itself.
    if (otherOn[question] && free.length === 0 && !multiOf(question)) return OTHER;
    return joinAnswer(free.length > 0 ? [...labels, free] : labels);
  }

  function multiOf(question: string): boolean {
    return questions.find((q) => q.question === question)?.multiSelect === true;
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
    // A single-select question has one answer: picking an option puts `Other`
    // away, as picking `Other` puts the option away.
    if (!multiSelect) setOtherOn((prev) => ({ ...prev, [question]: false }));
  }

  function toggleOther(question: string, multiSelect: boolean): void {
    // Single-select: `Other` is another radio (Tom, App Updates: "patch other
    // should be another radio button... select option 1, then other and it
    // deselects anything else"), so turning it on clears the pick; the text
    // is an optional comment. Multi-select: an addition that toggles on its own.
    if (!multiSelect && otherOn[question] !== true) setPicked((p) => ({ ...p, [question]: [] }));
    setOtherOn((prev) => ({ ...prev, [question]: prev[question] !== true }));
  }

  function submit(): void {
    if (!requestId || !complete) return;
    const answers: Record<string, string> = {};
    for (const q of questions) answers[q.question] = answerFor(q.question);
    // Dropped as the answer goes out, not left to the resolution effect above:
    // the send is the moment the draft is spent, and a surface that never sees
    // its own resolution echo must not keep it.
    useQuestionDraftStore.getState().clear(requestId);
    onAnswer(requestId, answers);
  }

  return (
    <div
      ref={cardRef}
      className={`permission question-card${resolved ? ` resolved resolved-${resolved}` : ''}`}
      data-testid="question-card"
      data-resolved={resolved ?? undefined}
      tabIndex={-1}
      role="group"
      aria-label="question from the agent"
    >
      {/* Only while it is still open. An answered card's remaining time is not
          a fact about anything, and a resolved card that kept ticking would
          read as still wanting an answer. */}
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
          <div className="question-block" data-testid="question-block" key={q.question}>
            <span className="question-header">{q.header}</span>
            <p className="question-text">{q.question}</p>
            <div
              className="question-options"
              role={q.multiSelect ? 'group' : 'radiogroup'}
              aria-label={q.question}
              onKeyDown={(e) => onOptionsKeyDown(e, q.question)}
            >
              {q.options.map((o, i) => {
                const on = selected.includes(o.label);
                return (
                  <button
                    type="button"
                    key={o.label}
                    className={`question-option${on ? ' selected' : ''}`}
                    data-testid="question-option"
                    data-label={o.label}
                    data-selected={on ? 'true' : 'false'}
                    role={q.multiSelect ? 'checkbox' : 'radio'}
                    aria-checked={on}
                    disabled={resolved !== undefined}
                    tabIndex={optionTabIndex(q.question, i)}
                    onFocus={() => rememberFocus(q.question, i)}
                    onClick={() => toggle(q.question, o.label, q.multiSelect)}
                  >
                    <OptionIndicator multiSelect={q.multiSelect} on={on} />
                    <span className="question-option-body">
                      <span className="question-option-label">{o.label}</span>
                      {o.description ? (
                        <span className="question-option-desc">{o.description}</span>
                      ) : null}
                    </span>
                  </button>
                );
              })}
              <button
                type="button"
                className={`question-option question-other${otherActive ? ' selected' : ''}`}
                data-testid="question-other"
                data-selected={otherActive ? 'true' : 'false'}
                role={q.multiSelect ? 'checkbox' : 'radio'}
                aria-checked={otherActive}
                disabled={resolved !== undefined}
                tabIndex={optionTabIndex(q.question, q.options.length)}
                onFocus={() => rememberFocus(q.question, q.options.length)}
                onClick={() => toggleOther(q.question, q.multiSelect)}
              >
                <OptionIndicator multiSelect={q.multiSelect} on={otherActive} />
                <span className="question-option-body">
                  <span className="question-option-label">{OTHER}</span>
                </span>
              </button>
            </div>
            {otherActive && !resolved ? (
              /* A TEXTAREA, not an input: this is the one box in the app where a
                 longer free-text answer gets typed, and a single-line input
                 cannot hold a newline at all (Tom, App Updates: "patch other
                 input box, does nothing on enter. should add a new line.
                 shift/cmd enter should send it"). `rows={1}` + CSS
                 `field-sizing: content` keep it the height of the input it
                 replaced until there is something to grow for.

                 `autoFocus` because the click that reveals the box is the click
                 that starts typing in it — otherwise choosing `Other` costs two
                 clicks (Tom, App Updates: "when answering a qusetion, clicking
                 other must focus input"). This box is mounted BY that click and
                 unmounted when `Other` is turned off or the card resolves, so
                 mount-time focus is exactly the one transition that should take
                 the cursor: turning `Other` off, typing, and a card settling all
                 leave focus where it was. */
              <textarea
                className="question-other-input"
                data-testid="question-other-input"
                aria-label={`Other answer for ${q.question}`}
                rows={1}
                autoFocus
                value={otherText[q.question] ?? ''}
                onChange={(e) =>
                  setOtherText((prev) => ({ ...prev, [q.question]: e.target.value }))
                }
                onKeyDown={(e) => {
                  // The DELIBERATE INVERSE of the composer's mapping (spec/14
                  // § Main chat panel — Question prompts): here `↵` and `⇧↵`
                  // both fall through to the browser and insert a newline, and
                  // only `⌘↵` / `Ctrl↵` sends. A long answer is the normal case
                  // in this box, so the cheap key is the newline. IME
                  // composition is never hijacked.
                  if (!isSubmitChord(e)) return; // newline
                  // `⌘↵` is the send key, so it never leaves a stray newline
                  // behind either — prevented whether or not it can send.
                  e.preventDefault();
                  // `submit()` is guarded on the same `complete` as the Send
                  // answer button, so the shortcut cannot do what the button is
                  // disabled from doing: submit a half-answered card.
                  submit();
                }}
              />
            ) : null}
            {resolved && otherActive ? (
              // The live textarea above only mounts while the card is
              // answerable; once resolved the free-text answer is read-only,
              // so it is drawn as plain text instead — the resolved
              // counterpart to the textarea, reading the same stored answer
              // `resolvedDisplay` parsed out.
              <p className="question-other-answer" data-testid="question-other-answer">
                {resolvedOtherText}
              </p>
            ) : null}
          </div>
        );
      })}
      <Footer entry={entry} onCancel={onCancel} submit={{ disabled: !complete, onClick: submit }} />
    </div>
  );
}
