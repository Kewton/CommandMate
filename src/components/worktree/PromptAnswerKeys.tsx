'use client';

/**
 * PromptAnswerKeys — answering a dialog with a CHARACTER (Issue #2254).
 *
 * Everything the chat surface could send before this Issue was a direction:
 * arrows to move a highlight, Enter to take it, Esc to leave. That is enough for
 * a selection list, and it is not enough for the two shapes the Issue was raised
 * about — a numbered dialog (`1. Yes, continue` / `2. No, quit`) and a bare
 * `[y/n]` — because on those the answer IS the character. Enter alone takes
 * whatever the CLI happened to highlight, which is how a "no" gets delivered as
 * an approval (Issue #1681).
 *
 * So this toolbar sends `1`–`9`, `y`, `n` and Enter, through the same
 * `/special-keys` route and the same {@link useSpecialKeys} sender every other
 * key strip in this repository uses. There is no free-text field and there will
 * not be one here: `/send`'s `prompt_waiting` guard is deliberately untouched by
 * #2254, and a route that accepted arbitrary text would be a second, unguarded
 * way into a session that has already said it is waiting.
 *
 * ## Why the buttons are always visible
 *
 * No `group-hover` reveal. A hover-revealed control is unreachable on a
 * touchscreen (`@media (hover: none)` never fires the hover), and the phone is
 * where this strip matters most — the terminal surface is not on screen to fall
 * back to.
 *
 * ## Where it is rendered
 *
 * Only inside `ChatDialogCard`'s action row, for the two states where nothing
 * could read the dialog (`unclassified` / `promptUnreadable`). A selection list
 * gets `NavigationButtons` instead, because on those the highlight is real and
 * arrows are the correct verb. The card is directly above these buttons, so the
 * user can see which number they are pressing — that is the whole reason the
 * keys and the frame ship in the same Issue.
 *
 * ## The two selection-list toolbars this file also owns (Issue #2297)
 *
 * {@link SelectionNumberKeys} and {@link SelectionCommitKeys} are NOT this
 * toolbar under another name, and the difference is the point of #2297:
 *
 *  - this one is the fixed `1`–`9` / `y` / `n` pad for a dialog nobody could
 *    read, so it publishes every key it might need and lets the user match them
 *    against the frame;
 *  - `SelectionNumberKeys` renders exactly as many numbers as the dialog is
 *    OFFERING, counted off the frame by `readSelectionListShape()`. A tenth
 *    button on a seven-model picker is a key that does nothing;
 *  - `SelectionCommitKeys` is not a number row at all. It is the two LABELLED
 *    commits claude's `/model` footer offers, and it exists because on that one
 *    screen `Enter` rewrites the user's global default (Issue #1495) — a
 *    distinction no unlabelled key cap can carry.
 *
 * They live here rather than in files of their own because they are the same
 * control: a `useSpecialKeys` sender, a `useKeyPressFeedback` highlight, a 44px
 * tap target, no free text.
 */

import { useCallback, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import type { CLIToolType } from '@/lib/cli-tools/types';
import {
  SESSION_SCOPE_KEY,
  type NavigationKey,
  type TerminalKey,
} from '@/types/terminal-keys';
import { MAX_OPTION_NUMBER } from '@/lib/detection/selection-shape';
import { useSpecialKeys } from '@/hooks/useSpecialKeys';
import { useKeyPressFeedback } from '@/hooks/useKeyPressFeedback';

export interface PromptAnswerKeysProps {
  worktreeId: string;
  cliToolId: CLIToolType;
  /** Issue #869: agent instance to target (defaults to the primary when omitted). */
  instanceId?: string;
  /** Trigger an immediate terminal refresh after the key is sent. */
  onKeysSent?: () => void;
}

interface AnswerKeyDef {
  key: NavigationKey;
  /** Key cap shown inside the button — never translated. */
  label: string;
  /** Physical key name, used verbatim as the accessible name. */
  ariaLabel: string;
}

/* eslint-disable no-restricted-syntax -- i18n(#1271): these literals are physical
   key notation — the key cap is the character that goes on the wire ('1', 'y',
   '↵') and the aria label names that same physical key ("Send 1" / "Send y").
   They are identical in every locale and are not translatable prose. The two
   prose strings this toolbar shows (its caption and its toolbar label) are
   resolved through t() at render time below. */

/**
 * The option numbers, in the order every numbered dialog measured for this Issue
 * prints them.
 *
 * Nine because that is where a single keystroke stops: `10` is two characters
 * and would need chord handling the route's per-key delivery does not have. No
 * dialog in `tests/fixtures/` offers more than seven options.
 */
const NUMBER_KEYS: ReadonlyArray<AnswerKeyDef> = [
  { key: '1', label: '1', ariaLabel: 'Send 1' },
  { key: '2', label: '2', ariaLabel: 'Send 2' },
  { key: '3', label: '3', ariaLabel: 'Send 3' },
  { key: '4', label: '4', ariaLabel: 'Send 4' },
  { key: '5', label: '5', ariaLabel: 'Send 5' },
  { key: '6', label: '6', ariaLabel: 'Send 6' },
  { key: '7', label: '7', ariaLabel: 'Send 7' },
  { key: '8', label: '8', ariaLabel: 'Send 8' },
  { key: '9', label: '9', ariaLabel: 'Send 9' },
];

/** The two letters a bare `[y/n]` accepts, plus the key that commits. */
const VERDICT_KEYS: ReadonlyArray<AnswerKeyDef> = [
  { key: 'y', label: 'y', ariaLabel: 'Send y' },
  { key: 'n', label: 'n', ariaLabel: 'Send n' },
  { key: 'Enter', label: '↵', ariaLabel: 'Send Enter' },
];

/* eslint-enable no-restricted-syntax */

/** Every key this toolbar can send, in render order. Exported for the unit suite. */
export const PROMPT_ANSWER_KEYS: ReadonlyArray<NavigationKey> = [
  ...NUMBER_KEYS.map((k) => k.key),
  ...VERDICT_KEYS.map((k) => k.key),
];

export function PromptAnswerKeys({
  worktreeId,
  cliToolId,
  instanceId,
  onKeysSent,
}: PromptAnswerKeysProps) {
  const t = useTranslations('worktree');
  // Issue #2176: the highlight timer is owned by the hook (ref-held id, cleared
  // on the next press and on unmount) rather than fired and forgotten, which
  // matters here for the same reason it matters in the escape hatch — answering
  // the dialog is what unmounts the toolbar that answered it.
  const { activeKey, markPressed } = useKeyPressFeedback();
  const send = useSpecialKeys(worktreeId, cliToolId, instanceId, onKeysSent);

  const handleClick = useCallback(
    (key: NavigationKey) => {
      markPressed(key);
      send([key]);
    },
    [markPressed, send],
  );

  return (
    <div
      data-testid="prompt-answer-keys"
      role="toolbar"
      aria-label={t('promptAnswerKeys.toolbarLabel')}
      className="flex flex-wrap items-center gap-1.5 rounded-lg bg-muted px-2 py-1.5"
    >
      <span className="text-xs text-muted-foreground">{t('promptAnswerKeys.caption')}</span>
      {[...NUMBER_KEYS, ...VERDICT_KEYS].map(({ key, label, ariaLabel }) => (
        <button
          key={key}
          type="button"
          data-testid={`prompt-answer-key-${key}`}
          aria-label={ariaLabel}
          onClick={() => handleClick(key)}
          // Issue #1127: >=44px tap target. Always visible (never hover-revealed)
          // — see the docblock.
          className={`min-h-[44px] min-w-[44px] rounded-md border border-border px-3 py-2 text-sm font-medium transition-colors duration-75 touch-manipulation focus:outline-none focus:ring-2 focus:ring-ring ${
            activeKey === key
              ? 'border-accent-500 bg-accent-500 text-white scale-95'
              : 'bg-surface hover:bg-muted active:bg-muted dark:bg-surface-2'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

// ===========================================================================
// Issue #2297: the two toolbars a SELECTION LIST gets
// ===========================================================================

/** Props every key strip in this file takes. */
export interface SelectionKeysProps {
  worktreeId: string;
  cliToolId: CLIToolType;
  /** Issue #869: agent instance to target (defaults to the primary when omitted). */
  instanceId?: string;
  /** Trigger an immediate terminal refresh after the key is sent. */
  onKeysSent?: () => void;
}

export interface SelectionNumberKeysProps extends SelectionKeysProps {
  /**
   * How many options the dialog is offering, from
   * `readSelectionListShape(frame).optionCount`.
   *
   * Clamped into `[1, MAX_OPTION_NUMBER]` and rendered as nothing at all below
   * 1, so a caller that has not measured the frame gets the pre-#2297 surface
   * (arrows only) rather than a row of keys that do nothing.
   */
  optionCount: number;
}

/**
 * `1`…`N` for a numbered selection list (Issue #2297).
 *
 * The saving is real and not cosmetic: codex's `/model` picker offers seven
 * models and the only way to reach the seventh was six taps on ▼ followed by
 * Enter, each one a round trip through `/special-keys` and a 5-second capture
 * cache. One tap replaces the walk.
 *
 * **Where it is NOT drawn** is the measured half of this control — see
 * `shouldOfferOptionNumbers()`. A number key is not a cursor move on every
 * screen: on claude's `/model` it commits AND rewrites `~/.claude/settings.json`
 * in one press (probed live on 2.1.260), and on copilot's `/model` and Command
 * Code's picker it is typed into a search box. Both are refused there, in the
 * detection layer, so this component never has to know which tool it is under.
 */
export function SelectionNumberKeys({
  worktreeId,
  cliToolId,
  instanceId,
  onKeysSent,
  optionCount,
}: SelectionNumberKeysProps) {
  const t = useTranslations('worktree');
  const { activeKey, markPressed } = useKeyPressFeedback();
  const send = useSpecialKeys(worktreeId, cliToolId, instanceId, onKeysSent);

  const keys = useMemo(() => {
    const count = Math.min(Math.trunc(optionCount), MAX_OPTION_NUMBER);
    if (!Number.isFinite(count) || count < 1) return [];
    return NUMBER_KEYS.slice(0, count);
  }, [optionCount]);

  const handleClick = useCallback(
    (key: NavigationKey) => {
      markPressed(key);
      send([key]);
    },
    [markPressed, send],
  );

  if (keys.length === 0) return null;

  return (
    <div
      data-testid="selection-number-keys"
      data-option-count={String(keys.length)}
      role="toolbar"
      aria-label={t('selectionKeys.numbersToolbarLabel')}
      className="flex flex-wrap items-center gap-1.5 rounded-lg bg-muted px-2 py-1.5"
    >
      <span className="text-xs text-muted-foreground">{t('selectionKeys.numbersCaption')}</span>
      {keys.map(({ key, label, ariaLabel }) => (
        <button
          key={key}
          type="button"
          data-testid={`selection-number-key-${key}`}
          aria-label={ariaLabel}
          onClick={() => handleClick(key)}
          className={`min-h-[44px] min-w-[44px] rounded-md border border-border px-3 py-2 text-sm font-medium transition-colors duration-75 touch-manipulation focus:outline-none focus:ring-2 focus:ring-ring ${
            activeKey === key
              ? 'border-accent-500 bg-accent-500 text-white scale-95'
              : 'bg-surface hover:bg-muted active:bg-muted dark:bg-surface-2'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export interface SelectionCommitKeysProps extends SelectionKeysProps {
  /**
   * Whether the frame's footer says `Enter` writes a default rather than merely
   * confirming (`readSelectionListShape(frame).commitsDefaultOnEnter`).
   *
   * Only the WORDING depends on it. Both buttons are drawn either way, because a
   * screen that offers a session scope at all has, by definition, a second
   * meaning for `Enter` worth naming.
   */
  commitsDefaultOnEnter: boolean;
}

/**
 * "This session only" (`s`) beside "Set as default" (`Enter`) — Issue #2297.
 *
 * The failure this replaces: claude's `/model` overlay footer reads
 * `Enter to set as default · s to use this session only · Esc to cancel`, and
 * the chat surface published `Enter` and not `s`. Every model change made from
 * chat therefore rewrote `model` in `~/.claude/settings.json` (Issue #1495) —
 * for every future session, from a button whose cap said `↵`.
 *
 * Two buttons rather than one toggle, and PROSE labels rather than key caps,
 * because the thing the user has to tell apart is not which key is sent but what
 * it does. The key notation rides along in the accessible name and the tooltip,
 * where it costs no width.
 *
 * The session button is FIRST and carries the accent, which is the one piece of
 * opinion in this component: it is the non-destructive half, and the destructive
 * half already has a footer telling the user it is the default.
 */
export function SelectionCommitKeys({
  worktreeId,
  cliToolId,
  instanceId,
  onKeysSent,
  commitsDefaultOnEnter,
}: SelectionCommitKeysProps) {
  const t = useTranslations('worktree');
  const { activeKey, markPressed } = useKeyPressFeedback();
  const send = useSpecialKeys(worktreeId, cliToolId, instanceId, onKeysSent);

  // `TerminalKey`, not `NavigationKey`: `s` is declared by the claude family
  // alone (`CLAUDE_NAVIGATION_KEY_VALUES`) and is deliberately outside the
  // shared pad, so the narrower type would not admit it.
  const handleClick = useCallback(
    (key: TerminalKey) => {
      markPressed(key);
      send([key]);
    },
    [markPressed, send],
  );

  return (
    <div
      data-testid="selection-commit-keys"
      role="toolbar"
      aria-label={t('selectionKeys.commitToolbarLabel')}
      className="flex flex-wrap items-center gap-1.5 rounded-lg bg-muted px-2 py-1.5"
    >
      <button
        type="button"
        data-testid="selection-commit-session"
        aria-label={t('selectionKeys.sessionOnlyAria')}
        title={t('selectionKeys.sessionOnlyAria')}
        onClick={() => handleClick(SESSION_SCOPE_KEY)}
        className={`min-h-[44px] rounded-md border px-3 py-2 text-sm font-medium transition-colors duration-75 touch-manipulation focus:outline-none focus:ring-2 focus:ring-ring ${
          activeKey === SESSION_SCOPE_KEY
            ? 'border-accent-500 bg-accent-500 text-white scale-95'
            : 'border-accent-500 bg-surface text-accent-600 hover:bg-muted active:bg-muted dark:bg-surface-2 dark:text-accent-400'
        }`}
      >
        {t('selectionKeys.sessionOnly')}
      </button>
      <button
        type="button"
        data-testid="selection-commit-default"
        aria-label={t('selectionKeys.setDefaultAria')}
        title={t('selectionKeys.setDefaultAria')}
        onClick={() => handleClick('Enter')}
        className={`min-h-[44px] rounded-md border border-border px-3 py-2 text-sm font-medium transition-colors duration-75 touch-manipulation focus:outline-none focus:ring-2 focus:ring-ring ${
          activeKey === 'Enter'
            ? 'border-accent-500 bg-accent-500 text-white scale-95'
            : 'bg-surface hover:bg-muted active:bg-muted dark:bg-surface-2'
        }`}
      >
        {t('selectionKeys.setDefault')}
      </button>
      {commitsDefaultOnEnter ? (
        <p
          data-testid="selection-commit-warning"
          className="w-full text-xs text-muted-foreground"
        >
          {t('selectionKeys.defaultWarning')}
        </p>
      ) : null}
    </div>
  );
}

export default PromptAnswerKeys;
