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
 */

import { useCallback } from 'react';
import { useTranslations } from 'next-intl';
import type { CLIToolType } from '@/lib/cli-tools/types';
import type { NavigationKey } from '@/types/terminal-keys';
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

export default PromptAnswerKeys;
