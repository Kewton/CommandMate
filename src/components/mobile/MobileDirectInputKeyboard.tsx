'use client';

/**
 * MobileDirectInputKeyboard — the phone's "direct input" (Issue #2799).
 *
 * PC's `DirectInputBar` (#2766) is the last way out of a TUI frame the
 * detection layer cannot read: whatever is typed goes straight to the pane.
 * On a phone it cannot work the same way — the OS keyboard's `keydown` carries
 * `key: "Unidentified"` on some devices, and there is no Esc, no Ctrl and no
 * arrow key on it anyway. So this keyboard is DRAWN by CommandMate and reads no
 * OS keyboard event at all: it is Termux's Extra Keys (two rows of special keys)
 * plus a two-page character panel, laid out in `src/config/mobile-keyboard-layout.ts`.
 *
 * ## Staged, not sent
 *
 * A phone is mis-tapped as a matter of course. A tap here therefore STAGES the
 * key — the confirm row shows it as a chip — and nothing reaches the pane until
 * `送信`, which posts the whole list as ONE request (the list is capped at the
 * route's 32 events). Enter is never added for the user: if the pane should get
 * Enter, ENTER is staged like any other key. The rules for what a tap stages
 * are pure functions in `src/lib/direct-input-staging.ts`.
 *
 * The list lives in this component's memory and nowhere else — no
 * localStorage, no sessionStorage, no URL, no log. It can hold what someone
 * typed into a prompt the detector could not read (a passphrase, an API key),
 * and closing the keyboard, switching instance or leaving the tab discards it
 * by unmounting this component.
 *
 * ## A failed send may have half-arrived
 *
 * The route writes the events to tmux one by one, so a failure does not mean
 * "nothing arrived". The list is kept, an alert says so, and `送信` stays
 * disabled until the user acknowledges (`OK`) or edits the list — so a quick
 * second tap cannot replay the half that already landed. Nothing is resent
 * automatically.
 *
 * ## Taps
 *
 * Keys act on `pointerup`, like Termux on `ACTION_UP`: the key under
 * `pointerdown` captures the pointer, so the finger can drift over the confirm
 * row (BS sits right under it) without pressing anything there. An upward swipe
 * of `DIRECT_INPUT_SWIPE_UP_THRESHOLD_PX` on BS stages DEL; a release
 * outside the key stages nothing. `pointerdown` is `preventDefault()`ed so a
 * tap never moves focus, and the OS keyboard is dismissed on mount (see the
 * effect for why it is there and not in the sheet's handler). A click with
 * `detail === 0` — keyboard or assistive-technology activation, which has no
 * pointer gesture — activates the key directly.
 *
 * ## The #1127 exception
 *
 * Every key is 44px tall, and the confirm row and the special rows (7 columns,
 * ~51px at 360px) meet #1127's 44px on both axes. The character keys do NOT:
 * ten columns at 360px are ~36px wide. That is deliberate — it is the width of
 * the OS keyboard the user's fingers already know, and a mis-tap lands in the
 * confirm row, where it can be read and undone before anything is sent. Keys
 * share their edges (no dead gaps between hit areas); the visible gap is inside
 * each key. Recorded in `docs/design-system.md` as well.
 *
 * Press colour is held until the finger lifts, which is why this does not use
 * `useKeyPressFeedback` (#2176) — its 150ms flash would go dark in the middle
 * of a held, repeating arrow key.
 */

import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { useTranslations } from 'next-intl';
import { X } from 'lucide-react';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { useDirectInput } from '@/hooks/useDirectInput';
import { MAX_DIRECT_INPUT_EVENTS, type DirectInputEvent } from '@/types/direct-input';
import {
  CHAR_PAGES,
  DIRECT_INPUT_LONG_PRESS_MS,
  DIRECT_INPUT_REPEAT_INTERVAL_MS,
  SPECIAL_KEY_ROWS,
  charKeyTestId,
  type CharPageId,
  type CharPanelKeyDef,
  type DirectInputModifier,
  type SpecialKeyDef,
} from '@/config/mobile-keyboard-layout';
import {
  isStagedFull,
  lockModifier,
  modifierAfterStage,
  resolveKeyPress,
  resolveRelease,
  stageEvent,
  tapModifier,
  toStagedChips,
  undoLastStaged,
  type KeyPress,
  type KeyRect,
  type ModifierState,
  type PointerPoint,
} from '@/lib/direct-input-staging';

export interface MobileDirectInputKeyboardProps {
  worktreeId: string;
  cliToolId: CLIToolType;
  /** Agent instance to send to; the primary instance when omitted. */
  instanceId?: string;
  /** Re-poll the pane once a send has landed. */
  onKeysSent?: () => void;
  /** Leave the mode. Reached from `閉じる` only. */
  onClose: () => void;
}

/** What a key does, independent of how it is drawn. */
type KeyAction =
  | {
      readonly kind: 'press';
      readonly press: KeyPress;
      /** What an upward swipe stages instead (BS → DEL). */
      readonly swipe?: KeyPress;
      readonly repeats: boolean;
    }
  | { readonly kind: 'modifier'; readonly modifier: DirectInputModifier }
  | { readonly kind: 'page'; readonly target: CharPageId };

/** One finger on one key, from `pointerdown` to `pointerup` / `pointercancel`. */
interface Gesture {
  readonly pointerId: number;
  readonly action: KeyAction;
  readonly start: PointerPoint;
  readonly rect: KeyRect;
  /** The long press fired (a lock, or a repeat started): the release does nothing more. */
  longPressed: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  interval: ReturnType<typeof setInterval> | null;
}

interface EnablementInputs {
  readonly sending: boolean;
  readonly staged: readonly DirectInputEvent[];
  readonly modifier: ModifierState;
}

/**
 * Whether a key can be pressed right now. The render (for `aria-disabled`) and
 * the handlers (which refuse a disabled key — `aria-disabled` alone does not
 * stop a press, the hole #2592's `AgentModeControl` had to close) read this
 * one function.
 */
function isActionEnabled(action: KeyAction, { sending, staged, modifier }: EnablementInputs): boolean {
  if (sending) return false;
  switch (action.kind) {
    case 'press':
      return !isStagedFull(staged) && resolveKeyPress(action.press, modifier) !== null;
    case 'page':
      // A modifier needs the letters on screen; see `applyModifier`.
      return modifier === null;
    case 'modifier':
      return true;
  }
}

function stopTimers(gesture: Gesture): void {
  if (gesture.timer !== null) clearTimeout(gesture.timer);
  if (gesture.interval !== null) clearInterval(gesture.interval);
  gesture.timer = null;
  gesture.interval = null;
}

/** Android Chrome only: iOS Safari has no `navigator.vibrate`, and there it does nothing. */
function vibrate(): void {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      navigator.vibrate(10);
    }
  } catch {
    // Vibration is a nicety; a browser that refuses it changes nothing else.
  }
}

/** Callout / tap-highlight suppression (§7.4). Inherited by every key. */
const ROOT_STYLE: CSSProperties = {
  WebkitTouchCallout: 'none',
  WebkitTapHighlightColor: 'transparent',
  WebkitUserSelect: 'none',
};

const COL_SPAN_CLASS: Readonly<Record<number, string>> = {
  1: 'col-span-1',
  2: 'col-span-2',
  4: 'col-span-4',
};

/** The key's hit area: the whole grid cell, 44px tall, no gap to its neighbours. */
const KEY_BUTTON_CLASS =
  'relative flex h-11 min-w-0 items-stretch p-0.5 touch-manipulation select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring';

/** A confirm-row button: 44px on both axes (#1127). */
const ROW_BUTTON_CLASS =
  'flex h-11 min-w-[44px] shrink-0 items-center justify-center px-2 text-xs font-medium touch-manipulation select-none transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring aria-disabled:opacity-40';

type FaceTone = 'normal' | 'pressed' | 'oneShot' | 'locked';

const FACE_TONE_CLASS: Readonly<Record<FaceTone, string>> = {
  normal: 'border-border bg-surface text-foreground',
  pressed: 'border-accent-500 bg-accent-500/30 text-foreground',
  oneShot: 'border-accent-500 bg-accent-500/20 text-accent-600 dark:text-accent-400',
  locked: 'border-accent-600 bg-accent-600 text-white underline underline-offset-2',
};

export function MobileDirectInputKeyboard({
  worktreeId,
  cliToolId,
  instanceId,
  onKeysSent,
  onClose,
}: MobileDirectInputKeyboardProps) {
  const t = useTranslations('worktree');
  const charPanelId = useId();
  const { sendAndWait, isSending } = useDirectInput(worktreeId, cliToolId, instanceId, onKeysSent);

  // State for the render, mirrored in refs for the handlers and the repeat
  // timer: a held arrow key fires every 80ms from a closure created at
  // `pointerdown`, and it has to see the list as it is NOW to stop at 32.
  const [staged, setStaged] = useState<DirectInputEvent[]>([]);
  const stagedRef = useRef<DirectInputEvent[]>([]);
  const [modifier, setModifier] = useState<ModifierState>(null);
  const modifierRef = useRef<ModifierState>(null);
  const sendingRef = useRef(false);
  const [charsOpen, setCharsOpen] = useState(false);
  const [page, setPage] = useState<CharPageId>('alpha');
  /** The last send failed and the user has not acknowledged it or edited the list since. */
  const [failed, setFailed] = useState(false);
  const [pressedKey, setPressedKey] = useState<string | null>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const mountedRef = useRef(true);
  const chipsRef = useRef<HTMLUListElement>(null);

  // §7.5: dismiss the OS keyboard. In a MOUNT effect rather than in the sheet
  // row's handler, and the order is the point: the actions sheet's focus trap
  // restores focus to whatever held it before the sheet opened — the composer
  // textarea, on iOS, which does not move focus for a button tap — in its own
  // effect cleanup (`useFocusTrap`). The sheet closes and this mounts in the
  // same commit, React runs every effect cleanup of a commit before any new
  // effect, so this blur is guaranteed to come after that restore. A blur in
  // the handler would run first and lose to it.
  useEffect(() => {
    mountedRef.current = true;
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
    return () => {
      mountedRef.current = false;
      const gesture = gestureRef.current;
      if (gesture !== null) stopTimers(gesture);
      gestureRef.current = null;
    };
  }, []);

  // The end of a gesture whose key never saw it. A key removed mid-press (the
  // character panel folded by another finger) loses its pointer capture, and
  // the release then lands on whatever is under the finger instead of on the
  // key's own handler — which would leave the gesture open and every later
  // `pointerdown` refused as "a second finger". React's root listener runs
  // before this window one, so an ordinary release is resolved (and the
  // gesture cleared) first, and this only ever sweeps up an orphan.
  useEffect(() => {
    const sweep = (e: PointerEvent): void => {
      const gesture = gestureRef.current;
      if (gesture === null || gesture.pointerId !== e.pointerId) return;
      stopTimers(gesture);
      gestureRef.current = null;
      setPressedKey(null);
    };
    window.addEventListener('pointerup', sweep);
    window.addEventListener('pointercancel', sweep);
    return () => {
      window.removeEventListener('pointerup', sweep);
      window.removeEventListener('pointercancel', sweep);
    };
  }, []);

  // Keep the newest chip in view.
  useEffect(() => {
    const list = chipsRef.current;
    if (list) list.scrollLeft = list.scrollWidth;
  }, [staged]);

  const full = isStagedFull(staged);
  const chips = toStagedChips(staged);
  const count = staged.length;
  const enablementNow = (): EnablementInputs => ({
    sending: sendingRef.current,
    staged: stagedRef.current,
    modifier: modifierRef.current,
  });
  const enablementRender: EnablementInputs = { sending: isSending, staged, modifier };

  function commitStaged(next: DirectInputEvent[]): void {
    stagedRef.current = next;
    setStaged(next);
    // Editing the list is one of the two ways out of the failed state (§6).
    setFailed(false);
  }

  /**
   * Arm, lock or release CTRL / SHIFT. Arming either one opens the character
   * panel on the LETTERS page: both modifiers only apply to letters (and SHIFT
   * to TAB), and a symbols page under CTRL would be a screen whose only
   * pressable key is CTRL itself.
   */
  function applyModifier(next: ModifierState): void {
    modifierRef.current = next;
    setModifier(next);
    if (next !== null) {
      setCharsOpen(true);
      setPage('alpha');
    }
  }

  /** Stage one press under the current modifier. `false` when refused (disabled, full, sending). */
  function stagePress(press: KeyPress): boolean {
    if (sendingRef.current) return false;
    const event = resolveKeyPress(press, modifierRef.current);
    if (event === null) return false;
    const next = stageEvent(stagedRef.current, event);
    if (next === null) return false;
    commitStaged(next);
    const after = modifierAfterStage(modifierRef.current);
    if (after !== modifierRef.current) applyModifier(after);
    return true;
  }

  function activate(action: KeyAction, swiped: boolean): void {
    if (!isActionEnabled(action, enablementNow())) return;
    switch (action.kind) {
      case 'press':
        stagePress(swiped && action.swipe ? action.swipe : action.press);
        return;
      case 'modifier':
        applyModifier(tapModifier(modifierRef.current, action.modifier));
        return;
      case 'page':
        setPage(action.target);
        return;
    }
  }

  function endGesture(gesture: Gesture): void {
    stopTimers(gesture);
    gestureRef.current = null;
    setPressedKey(null);
  }

  function keyHandlers(keyId: string, action: KeyAction) {
    return {
      onPointerDown(e: ReactPointerEvent<HTMLButtonElement>) {
        // Never move focus (§7.5): nothing on this keyboard is an input, and a
        // focused one elsewhere would bring the OS keyboard back.
        e.preventDefault();
        if (e.button !== 0) return; // a secondary mouse button
        if (gestureRef.current !== null) return; // a second finger
        if (!isActionEnabled(action, enablementNow())) return;
        const el = e.currentTarget;
        try {
          el.setPointerCapture?.(e.pointerId);
        } catch {
          // A synthetic pointer (tests) has nothing to capture.
        }
        const r = el.getBoundingClientRect();
        const gesture: Gesture = {
          pointerId: e.pointerId,
          action,
          start: { x: e.clientX, y: e.clientY },
          rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
          longPressed: false,
          timer: null,
          interval: null,
        };
        gestureRef.current = gesture;
        setPressedKey(keyId);
        vibrate();

        if (action.kind === 'modifier') {
          gesture.timer = setTimeout(() => {
            gesture.timer = null;
            gesture.longPressed = true;
            applyModifier(lockModifier(action.modifier));
          }, DIRECT_INPUT_LONG_PRESS_MS);
        } else if (action.kind === 'press' && action.repeats) {
          gesture.timer = setTimeout(() => {
            gesture.timer = null;
            gesture.longPressed = true;
            if (!stagePress(action.press)) return;
            // Stops by itself at 32 (or when a send starts): `stagePress`
            // refuses, and the interval is cleared on the spot.
            gesture.interval = setInterval(() => {
              if (!stagePress(action.press)) stopTimers(gesture);
            }, DIRECT_INPUT_REPEAT_INTERVAL_MS);
          }, DIRECT_INPUT_LONG_PRESS_MS);
        }
      },
      onPointerUp(e: ReactPointerEvent<HTMLButtonElement>) {
        const gesture = gestureRef.current;
        if (gesture === null || gesture.pointerId !== e.pointerId) return;
        endGesture(gesture);
        if (gesture.longPressed) return;
        const hasSwipe = gesture.action.kind === 'press' && gesture.action.swipe !== undefined;
        const outcome = resolveRelease(gesture.start, { x: e.clientX, y: e.clientY }, gesture.rect, hasSwipe);
        if (outcome === 'none') return;
        activate(gesture.action, outcome === 'swipe');
      },
      onPointerCancel(e: ReactPointerEvent<HTMLButtonElement>) {
        const gesture = gestureRef.current;
        if (gesture === null || gesture.pointerId !== e.pointerId) return;
        endGesture(gesture);
      },
      onClick(e: ReactMouseEvent<HTMLButtonElement>) {
        // A pointer tap was resolved on `pointerup`. `detail === 0` is a click
        // with no pointer behind it — Enter / Space on a focused key, or a
        // screen reader's activation — and has no gesture to resolve.
        if (e.detail !== 0) return;
        activate(action, false);
      },
    };
  }

  function faceTone(keyId: string, action: KeyAction): FaceTone {
    if (action.kind === 'modifier' && modifier?.modifier === action.modifier) {
      return modifier.locked ? 'locked' : 'oneShot';
    }
    return pressedKey === keyId ? 'pressed' : 'normal';
  }

  function renderKey(options: {
    keyId: string;
    testId: string;
    action: KeyAction;
    label: string;
    ariaLabel?: string;
    spanClass: string;
    faceClass?: string;
    hint?: string;
  }): ReactNode {
    const { keyId, testId, action, label, ariaLabel, spanClass, faceClass = '', hint } = options;
    const enabled = isActionEnabled(action, enablementRender);
    const tone = faceTone(keyId, action);
    return (
      <button
        key={keyId}
        type="button"
        data-testid={testId}
        aria-label={ariaLabel}
        aria-disabled={enabled ? undefined : true}
        aria-pressed={action.kind === 'modifier' ? modifier?.modifier === action.modifier : undefined}
        data-modifier-state={
          action.kind === 'modifier'
            ? modifier?.modifier === action.modifier
              ? modifier.locked
                ? 'locked'
                : 'one-shot'
              : 'off'
            : undefined
        }
        className={`${KEY_BUTTON_CLASS} ${spanClass}`}
        {...keyHandlers(keyId, action)}
      >
        <span
          aria-hidden={ariaLabel !== undefined ? true : undefined}
          className={`relative flex flex-1 items-center justify-center rounded-md border ${FACE_TONE_CLASS[tone]} ${
            enabled ? '' : 'opacity-40'
          } ${faceClass}`}
        >
          {label}
          {hint ? (
            <span aria-hidden="true" className="absolute right-1 top-0.5 text-[9px] leading-none text-muted-foreground">
              {hint}
            </span>
          ) : null}
        </span>
        {pressedKey === keyId ? (
          // The enlarged bubble, shown while the finger is down.
          <span
            aria-hidden="true"
            data-testid="direct-key-bubble"
            className="pointer-events-none absolute bottom-full left-1/2 z-40 mb-1 -translate-x-1/2 whitespace-nowrap rounded-md border border-border bg-surface px-3 py-1.5 font-mono text-xl text-foreground shadow-lg"
          >
            {label}
          </span>
        ) : null}
      </button>
    );
  }

  function renderSpecialKey(def: SpecialKeyDef): ReactNode {
    const ariaLabel = t(`directInputKeyboard.keys.${def.id}`);
    if (def.kind === 'modifier') {
      return renderKey({
        keyId: def.id,
        testId: `direct-key-${def.id}`,
        action: { kind: 'modifier', modifier: def.id },
        label: def.label,
        ariaLabel,
        spanClass: 'col-span-1',
        faceClass: 'text-xs font-semibold',
      });
    }
    return renderKey({
      keyId: def.id,
      testId: `direct-key-${def.id}`,
      action: {
        kind: 'press',
        press: { type: 'named', key: def.key },
        swipe: def.swipeUp ? { type: 'named', key: def.swipeUp.key } : undefined,
        repeats: def.repeats,
      },
      label: def.label,
      ariaLabel,
      spanClass: 'col-span-1',
      faceClass: 'text-xs font-semibold',
      hint: def.swipeUp?.label,
    });
  }

  const shiftOn = modifier?.modifier === 'shift';

  function renderCharKey(def: CharPanelKeyDef): ReactNode {
    const spanClass = COL_SPAN_CLASS[def.span] ?? 'col-span-1';
    if (def.kind === 'page') {
      return renderKey({
        keyId: `page-${def.target}`,
        testId: 'direct-key-page',
        action: { kind: 'page', target: def.target },
        label: def.label,
        ariaLabel: t(def.target === 'symbol' ? 'directInputKeyboard.keys.toSymbols' : 'directInputKeyboard.keys.toAlpha'),
        spanClass,
        faceClass: 'text-xs font-semibold',
      });
    }
    const isSpace = def.char === ' ';
    const label = isSpace ? '␣' : shiftOn && /^[a-z]$/.test(def.char) ? def.char.toUpperCase() : def.char;
    return renderKey({
      keyId: `char-${def.char}`,
      testId: charKeyTestId(def.char),
      action: { kind: 'press', press: { type: 'char', char: def.char }, repeats: false },
      label,
      ariaLabel: isSpace ? t('directInputKeyboard.keys.space') : undefined,
      spanClass,
      faceClass: 'font-mono text-sm',
    });
  }

  async function handleSend(): Promise<void> {
    if (sendingRef.current || failed || stagedRef.current.length === 0) return;
    sendingRef.current = true;
    // A held key's repeat would otherwise try to append mid-flight; `stagePress`
    // refuses while sending, but the finger's gesture is over either way.
    const gesture = gestureRef.current;
    if (gesture !== null) endGesture(gesture);
    const ok = await sendAndWait(stagedRef.current);
    sendingRef.current = false;
    if (!mountedRef.current) return;
    if (ok) {
      // Nothing could change the list while the request was open, so what
      // succeeded is exactly what is on screen.
      stagedRef.current = [];
      setStaged([]);
    } else {
      setFailed(true);
    }
  }

  function handleUndo(): void {
    if (sendingRef.current || stagedRef.current.length === 0) return;
    commitStaged(undoLastStaged(stagedRef.current));
  }

  function handleClear(): void {
    if (sendingRef.current || stagedRef.current.length === 0) return;
    commitStaged([]);
  }

  const canEdit = !isSending && count > 0;
  const canSend = canEdit && !failed;

  return (
    <div
      role="group"
      aria-label={t('directInputKeyboard.groupLabel')}
      data-testid="mobile-direct-input-keyboard"
      data-modifier={modifier === null ? 'none' : `${modifier.modifier}${modifier.locked ? '-locked' : ''}`}
      className="select-none bg-surface-2 text-foreground"
      style={ROOT_STYLE}
    >
      {/* Notices sit ABOVE the confirm row and add height only while shown
          (§2). Not toasts: a toast would land on top of this keyboard. The
          live-region containers stay mounted (empty = 0px) so the text is
          announced when it appears. */}
      <div role="status">
        {full ? (
          <p data-testid="direct-input-full" className="bg-warning-subtle px-3 py-1.5 text-xs text-warning-foreground">
            {t('directInputKeyboard.full', { max: MAX_DIRECT_INPUT_EVENTS })}
          </p>
        ) : null}
      </div>
      <div role="alert">
        {failed ? (
          <div
            data-testid="direct-input-failed"
            className="flex items-center gap-2 bg-danger-subtle pl-3 text-xs text-danger-foreground"
          >
            <p className="flex-1 py-1.5">{t('directInputKeyboard.sendFailed')}</p>
            <button
              type="button"
              data-testid="direct-input-failed-ok"
              onClick={() => setFailed(false)}
              className={`${ROW_BUTTON_CLASS} text-danger-foreground`}
            >
              {t('directInputKeyboard.acknowledge')}
            </button>
          </div>
        ) : null}
      </div>

      {/* The confirm row: list operations only. Nothing here stages a key or
          spends a modifier (§4). */}
      <div
        role="group"
        aria-label={t('directInputKeyboard.confirmRowLabel')}
        aria-busy={isSending ? true : undefined}
        data-testid="direct-input-confirm-row"
        className="flex h-11 items-stretch bg-surface"
      >
        <button
          type="button"
          data-testid="direct-input-toggle-chars"
          aria-expanded={charsOpen}
          aria-controls={charsOpen ? charPanelId : undefined}
          aria-label={t(charsOpen ? 'directInputKeyboard.hideChars' : 'directInputKeyboard.showChars')}
          onClick={() => setCharsOpen((open) => !open)}
          className={`${ROW_BUTTON_CLASS} ${
            charsOpen ? 'text-accent-600 dark:text-accent-400' : 'text-muted-foreground'
          }`}
        >
          ABC
        </button>
        <div className="flex min-w-0 flex-1 items-center">
          <ul
            ref={chipsRef}
            aria-label={t('directInputKeyboard.stagedLabel')}
            data-testid="direct-input-chips"
            className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto px-1 scrollbar-hide"
          >
            {chips.map((chip, index) => {
              const text = chip.event.type === 'text' ? chip.label.replace(/ /g, '␣') : chip.label;
              const shown = chip.count > 1 ? `${text}×${chip.count}` : text;
              return (
                <li
                  key={index}
                  data-testid="direct-input-chip"
                  aria-label={
                    chip.count > 1
                      ? t('directInputKeyboard.chipRepeat', { key: text, count: chip.count })
                      : undefined
                  }
                  className="shrink-0 whitespace-nowrap rounded border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-xs text-foreground"
                >
                  {shown}
                </li>
              );
            })}
          </ul>
          <button
            type="button"
            data-testid="direct-input-clear"
            aria-label={t('directInputKeyboard.clearAll')}
            aria-disabled={canEdit ? undefined : true}
            onClick={handleClear}
            className={`${ROW_BUTTON_CLASS} text-muted-foreground`}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        <button
          type="button"
          data-testid="direct-input-undo"
          aria-label={t('directInputKeyboard.undoAria')}
          aria-disabled={canEdit ? undefined : true}
          onClick={handleUndo}
          className={`${ROW_BUTTON_CLASS} text-foreground`}
        >
          {t('directInputKeyboard.undo')}
        </button>
        <button
          type="button"
          data-testid="direct-input-send"
          aria-label={t('directInputKeyboard.sendAria', { count })}
          aria-disabled={canSend ? undefined : true}
          onClick={() => void handleSend()}
          className={`${ROW_BUTTON_CLASS} bg-accent-600 text-white`}
        >
          {t('directInputKeyboard.send', { count })}
        </button>
        <button
          type="button"
          data-testid="direct-input-close"
          aria-label={t('directInputKeyboard.closeAria')}
          onClick={onClose}
          className={`${ROW_BUTTON_CLASS} text-muted-foreground`}
        >
          {t('directInputKeyboard.close')}
        </button>
        {/* The count, announced politely — the chips themselves are not a
            live region, or every tap would read the whole list back (§10). */}
        <span className="sr-only" aria-live="polite" data-testid="direct-input-count">
          {t('directInputKeyboard.stagedCount', { count })}
        </span>
      </div>

      <div
        role="group"
        aria-label={t('directInputKeyboard.specialKeysLabel')}
        data-testid="direct-input-special-keys"
      >
        {SPECIAL_KEY_ROWS.map((row, rowIndex) => (
          <div key={rowIndex} className="grid grid-cols-7">
            {row.map(renderSpecialKey)}
          </div>
        ))}
      </div>

      {charsOpen ? (
        <div
          id={charPanelId}
          role="group"
          aria-label={t('directInputKeyboard.charKeysLabel')}
          data-testid="direct-input-char-panel"
          data-page={page}
        >
          {CHAR_PAGES[page].map((row, rowIndex) => (
            <div key={`${page}-${rowIndex}`} className="grid grid-cols-10">
              {row.map(renderCharKey)}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export default MobileDirectInputKeyboard;
