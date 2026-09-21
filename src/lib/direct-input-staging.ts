/**
 * Staging for the phone's direct-input keyboard (Issue #2799).
 *
 * A phone is mis-tapped as a matter of course, so the keyboard never sends a
 * key when it is pressed: it STAGES it — appends a `DirectInputEvent` to a list
 * the user can read in the confirm row — and the list only leaves on `送信`.
 * Everything that decides what a tap stages and what the list looks like
 * afterwards is here, as pure functions over plain values, so every key ×
 * modifier combination can be enumerated in a unit test without a DOM.
 *
 * Named apart from `src/types/direct-input.ts` on purpose: that module is the
 * vocabulary the server, the CLI and PC share; this one is the phone's staging
 * area on top of it, and nothing outside the phone keyboard imports it.
 *
 * ## The invariant every function here keeps
 *
 * The staged list satisfies `isDirectInputEvent` for every element and never
 * holds more than {@link MAX_DIRECT_INPUT_EVENTS} of them — which is exactly
 * what `POST /direct-input` accepts in ONE request, so one `送信` is one
 * request. What is counted is always the number of EVENTS: characters typed in
 * a row merge into one `text` event (`yes` is N=1), while three `↓` are three
 * `Down` events that the confirm row merely DRAWS as `↓×3` (N=3).
 */

import {
  MAX_DIRECT_INPUT_EVENTS,
  MAX_DIRECT_INPUT_TEXT_LENGTH,
  isDirectInputKey,
  type DirectInputEvent,
  type DirectInputKey,
} from '@/types/direct-input';
import {
  DIRECT_INPUT_SWIPE_UP_THRESHOLD_PX,
  keyChipLabel,
  type DirectInputModifier,
} from '@/config/mobile-keyboard-layout';

// ============================================================================
// Modifiers (§4)
// ============================================================================

/**
 * CTRL or SHIFT, one-shot (applies to the next key only) or locked (applies
 * until tapped again). `null` = no modifier. CTRL and SHIFT are never both on.
 */
export type ModifierState = { readonly modifier: DirectInputModifier; readonly locked: boolean } | null;

/**
 * A tap on CTRL / SHIFT. Tapping the active one turns it off, one-shot or
 * locked alike (Issue #2799 §4 release rule 2); tapping the other switches to
 * it as a one-shot, which is what "never both on" means.
 */
export function tapModifier(state: ModifierState, modifier: DirectInputModifier): ModifierState {
  if (state?.modifier === modifier) return null;
  return { modifier, locked: false };
}

/** A long press on CTRL / SHIFT locks it (and switches away from the other one). */
export function lockModifier(modifier: DirectInputModifier): ModifierState {
  return { modifier, locked: true };
}

/**
 * The modifier after a key was STAGED under it: a one-shot is spent (release
 * rule 1), a lock stays. Only called for a key that actually staged — a key the
 * modifier disables stages nothing and spends nothing, so a mis-tap on a greyed
 * key does not cost the user the CTRL they just armed.
 */
export function modifierAfterStage(state: ModifierState): ModifierState {
  if (state === null || state.locked) return state;
  return null;
}

// ============================================================================
// Key press → event
// ============================================================================

/** What the finger landed on: a special key's vocabulary value, or one character. */
export type KeyPress =
  | { readonly type: 'named'; readonly key: DirectInputKey }
  | { readonly type: 'char'; readonly char: string };

const LOWER_LETTER = /^[a-z]$/;

/**
 * The event a press stages under the current modifier, or `null` when the
 * modifier does not allow that key (it is drawn disabled, and the handler
 * refuses it too).
 *
 * - no modifier: the named key, or the character as `text`;
 * - CTRL: `a`–`z` only, as `C-a` … `C-z`;
 * - SHIFT: `a`–`z` only, as the upper-case character, plus `TAB` as `BTab`.
 */
export function resolveKeyPress(press: KeyPress, state: ModifierState): DirectInputEvent | null {
  if (state === null) {
    return press.type === 'named'
      ? { type: 'key', key: press.key }
      : { type: 'text', text: press.char };
  }

  if (state.modifier === 'ctrl') {
    if (press.type !== 'char' || !LOWER_LETTER.test(press.char)) return null;
    const key = `C-${press.char}`;
    return isDirectInputKey(key) ? { type: 'key', key } : null;
  }

  // SHIFT
  if (press.type === 'named') return press.key === 'Tab' ? { type: 'key', key: 'BTab' } : null;
  return LOWER_LETTER.test(press.char) ? { type: 'text', text: press.char.toUpperCase() } : null;
}

// ============================================================================
// The staged list (§6)
// ============================================================================

/** The confirm row cannot take another event: every staging key is disabled. */
export function isStagedFull(staged: readonly DirectInputEvent[]): boolean {
  return staged.length >= MAX_DIRECT_INPUT_EVENTS;
}

/**
 * Append one event, or return `null` when the list is full.
 *
 * Text typed straight after text joins the last `text` event, up to
 * {@link MAX_DIRECT_INPUT_TEXT_LENGTH}; past that it starts a new one, so the
 * list stays valid for the route. Keys are never merged — `↓` three times is
 * three events, because three is what reaches the pane.
 */
export function stageEvent(
  staged: readonly DirectInputEvent[],
  event: DirectInputEvent,
): DirectInputEvent[] | null {
  if (isStagedFull(staged)) return null;
  const last = staged[staged.length - 1];
  if (
    event.type === 'text' &&
    last?.type === 'text' &&
    last.text.length + event.text.length <= MAX_DIRECT_INPUT_TEXT_LENGTH
  ) {
    return [...staged.slice(0, -1), { type: 'text', text: last.text + event.text }];
  }
  return [...staged, event];
}

/**
 * `取消`: take back the LAST event. A merged `text` loses its last character
 * (and disappears with its only one); a key event goes whole, so `↓×3` becomes
 * `↓×2`.
 */
export function undoLastStaged(staged: readonly DirectInputEvent[]): DirectInputEvent[] {
  const last = staged[staged.length - 1];
  if (last === undefined) return [];
  const rest = staged.slice(0, -1);
  if (last.type === 'text') {
    const codePoints = [...last.text];
    if (codePoints.length > 1) {
      return [...rest, { type: 'text', text: codePoints.slice(0, -1).join('') }];
    }
  }
  return rest;
}

/** One chip in the confirm row. */
export interface StagedChip {
  /** What the chip reads: `ESC`, `^A`, `↓`, or the staged text itself. */
  readonly label: string;
  /** How many identical consecutive key events it stands for (`↓×3` is 3). Always 1 for text. */
  readonly count: number;
  readonly event: DirectInputEvent;
}

/**
 * The staged list as the confirm row draws it: consecutive identical KEY
 * events fold into one chip with a count. Display only — the list itself, and
 * N, are unchanged.
 */
export function toStagedChips(staged: readonly DirectInputEvent[]): StagedChip[] {
  const chips: StagedChip[] = [];
  for (const event of staged) {
    const previous = chips[chips.length - 1];
    if (
      event.type === 'key' &&
      previous?.event.type === 'key' &&
      previous.event.key === event.key
    ) {
      chips[chips.length - 1] = { ...previous, count: previous.count + 1 };
      continue;
    }
    chips.push({
      label: event.type === 'key' ? keyChipLabel(event.key) : event.text,
      count: 1,
      event,
    });
  }
  return chips;
}

// ============================================================================
// Gestures (§7)
// ============================================================================

export interface PointerPoint {
  readonly x: number;
  readonly y: number;
}

export interface KeyRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/**
 * How a release resolves, decided the way Termux decides it — on `ACTION_UP`,
 * from the travel since `pointerdown`:
 *
 * - `swipe`: moved up by the threshold or more AND the key has a swipe-up
 *   action (BS → DEL);
 * - `tap`: otherwise, released inside the key it started on;
 * - `none`: anywhere else. Nothing is staged, and — because the key holds the
 *   pointer capture — nothing under the finger reacts either.
 */
export function resolveRelease(
  start: PointerPoint,
  end: PointerPoint,
  rect: KeyRect,
  hasSwipeUp: boolean,
): 'swipe' | 'tap' | 'none' {
  if (hasSwipeUp && start.y - end.y >= DIRECT_INPUT_SWIPE_UP_THRESHOLD_PX) return 'swipe';
  const inside = end.x >= rect.left && end.x <= rect.right && end.y >= rect.top && end.y <= rect.bottom;
  return inside ? 'tap' : 'none';
}
