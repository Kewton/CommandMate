'use client';

/**
 * AgentModeControl — one button and one chip for the agent's permission mode
 * (Issue #2592).
 *
 * Claude Code and five of its peers cycle a permission mode on `shift+tab`
 * (manual / accept edits / plan / auto, and the per-tool variants of those). The
 * TerminalDisplay is read-only, so before this Issue the key was unreachable
 * from a browser on any device: the only way to change the mode was
 * `commandmate attach` on the machine the agent runs on.
 *
 * ## Why the chip is not optional
 *
 * A button on its own would be a blind press. Four of the five declaring tools
 * draw NOTHING in their base mode, and the chat surface hides the terminal
 * footer altogether — so "press it and look at the screen" is not available to
 * the very user this exists for. The chip is what makes the button legible, and
 * it says only what the pane actually said: {@link isReadableAgentMode} is
 * false for `unknown`, and the chip is simply not drawn then. A missing chip is
 * a question the operator can answer by switching to the terminal surface; a
 * confident wrong chip is one they have no reason to ask.
 *
 * ## The gate, and what it is protecting against
 *
 * `shift+tab` does NOT mean "cycle the mode" while a permission dialog is on
 * screen. On claude it is bound to option 2 —
 * `Yes, allow all edits during this session (shift+tab)`
 * (`tests/fixtures/canary/permission-dialog.raw.txt:31`) — and Command Code
 * spells its own the same way. One tap on a dialog is therefore a session-wide
 * grant of every edit, from a button whose cap says "mode".
 *
 * So the control is disabled unless the pane is **at rest**: `sessionStatus`
 * is `ready`, and none of the four "something is on screen" flags is set. The
 * flags come from the same `buildCurrentOutput` fields the dialog card is
 * driven by (#2254 / #2369), so the button and the card can never both believe
 * they own the frame. A disabled button sends nothing — there is no click
 * handler to reach — which is what the component test asserts rather than
 * merely asserting the attribute.
 *
 * ## Why it is one button in an existing row
 *
 * It sits in the composer's action row beside `InterruptButton` and
 * `OpencodeSessionControls`, and adds no row of its own. Vertical space in the
 * pane is already spoken for (#2106 / #2131): every pixel a control takes comes
 * out of `TerminalDisplay`, which is `flex-1 min-h-0` while the composer is
 * `flex-shrink-0`.
 */

import React, { memo, useCallback, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { AGENT_MODE_TOOL_IDS, isReadableAgentMode } from '@/lib/detection/agent-mode';
import { useSpecialKeys } from '@/hooks/useSpecialKeys';
import { useKeyPressFeedback } from '@/hooks/useKeyPressFeedback';

/**
 * The key this control sends.
 *
 * Every declaring tool's `AgentModeSpec.key` is `BTab`, and
 * `tests/unit/lib/cli-tools/agent-mode-declaration-2592.test.ts` pins that
 * against the real registry — including the halves the browser cannot check for
 * itself: that the tool's own `navigationKeys()` publishes it (or the route
 * answers 400, #2046) and that the transport can deliver it (or the route
 * throws mid-send, #2032).
 *
 * Written here as a constant rather than plumbed through a prop because the
 * browser has no access to `ICLITool`; the pin is what keeps the constant and
 * the declarations from drifting.
 */
const MODE_CYCLE_KEY = 'BTab';

export interface AgentModeControlProps {
  worktreeId: string;
  cliToolId: CLIToolType;
  /** Issue #869: agent instance to target (defaults to primary when omitted). */
  instanceId?: string;
  /**
   * The mode the pane last read off the frame, or `'unknown'`.
   *
   * `PaneTerminalState.agentMode`, derived from the frame on both delivery paths
   * (see that field). `'unknown'` hides the chip and leaves the button alone —
   * not being able to READ the mode is not a reason to refuse to CHANGE it, and
   * codex spends its whole default mode in exactly that state.
   */
  agentMode: string;
  /**
   * The merged status verdict for this pane (`SessionStatus`).
   *
   * Only `'ready'` enables the button. `'running'` is a turn in flight,
   * `'waiting'` is something on screen wanting an answer, `'idle'` is no live
   * session at all — and `''` is "no frame has landed yet", which must not be
   * mistaken for any of them.
   */
  sessionStatus: string;
  /** A wait is on screen (`prompt.visible`). */
  isPromptWaiting: boolean;
  /** A selection list / picker is on screen. */
  isSelectionListActive: boolean;
  /** A dismiss-only overlay is on screen (#2369). */
  isDismissablePanelActive: boolean;
  /** The frame is on screen and nobody could classify it (#1017). */
  isUnclassifiedActive: boolean;
  /** Trigger an immediate terminal refresh once tmux has processed the key. */
  onKeysSent?: () => void;
}

/**
 * Whether the mode key may be sent at this pane right now.
 *
 * Exported so the gate is one expression with one name, testable on its own and
 * quotable from a surface that needs to decide whether to render at all. Every
 * term is a REFUSAL: the default answer is no, and each flag can only take the
 * button away.
 */
export function canCycleAgentMode(state: {
  sessionStatus: string;
  isPromptWaiting: boolean;
  isSelectionListActive: boolean;
  isDismissablePanelActive: boolean;
  isUnclassifiedActive: boolean;
}): boolean {
  return (
    state.sessionStatus === 'ready' &&
    !state.isPromptWaiting &&
    !state.isSelectionListActive &&
    !state.isDismissablePanelActive &&
    !state.isUnclassifiedActive
  );
}

/** Whether this tool has a mode to cycle at all. */
export function toolHasAgentMode(cliToolId: string | undefined): boolean {
  return !!cliToolId && (AGENT_MODE_TOOL_IDS as readonly string[]).includes(cliToolId);
}

export const AgentModeControl = memo(function AgentModeControl({
  worktreeId,
  cliToolId,
  instanceId,
  agentMode,
  sessionStatus,
  isPromptWaiting,
  isSelectionListActive,
  isDismissablePanelActive,
  isUnclassifiedActive,
  onKeysSent,
}: AgentModeControlProps) {
  const t = useTranslations('worktree');
  const { activeKey, markPressed } = useKeyPressFeedback();
  const send = useSpecialKeys(worktreeId, cliToolId, instanceId, onKeysSent);

  const enabled = useMemo(
    () =>
      canCycleAgentMode({
        sessionStatus,
        isPromptWaiting,
        isSelectionListActive,
        isDismissablePanelActive,
        isUnclassifiedActive,
      }),
    [
      sessionStatus,
      isPromptWaiting,
      isSelectionListActive,
      isDismissablePanelActive,
      isUnclassifiedActive,
    ],
  );

  const handleClick = useCallback(() => {
    // Belt as well as braces. `disabled` already stops the click, but this
    // function is the only thing between a button and a key that means "allow
    // every edit this session" on a dialog — see the module docblock.
    if (!enabled) return;
    markPressed(MODE_CYCLE_KEY);
    send([MODE_CYCLE_KEY]);
  }, [enabled, markPressed, send]);

  if (!toolHasAgentMode(cliToolId)) return null;

  const readable = isReadableAgentMode(agentMode);
  // `codexModelCoupled` is the only note any tool declares (#2592 §4): codex's
  // modes move the model tier and reasoning effort with them, so a press of this
  // button changes more than the mode and the user has to be told before they
  // press it rather than after.
  const note = cliToolId === 'codex' ? t('agentMode.noteCodexModelCoupled') : null;
  const modeLabel = readable ? t(`agentMode.mode.${agentMode}`) : null;

  return (
    <div className="flex items-center gap-1 flex-shrink-0" data-testid="agent-mode-control">
      <button
        type="button"
        onClick={handleClick}
        disabled={!enabled}
        className={`flex-shrink-0 px-2 py-1 rounded-full border text-xs font-medium transition-colors
          disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent
          ${activeKey === MODE_CYCLE_KEY
            ? 'border-accent-500 bg-accent-500 text-white'
            : 'border-border text-muted-foreground hover:text-accent-600 hover:border-accent-400 dark:hover:text-accent-400'
          }`}
        aria-label={
          readable
            ? t('agentMode.cycleFromAria', { mode: modeLabel as string })
            : t('agentMode.cycleAria')
        }
        title={note ?? undefined}
        data-testid="agent-mode-cycle-button"
        data-agent-mode={agentMode}
        data-enabled={String(enabled)}
      >
        {/* Issue #1271: the key notation is physical-key notation and is
            identical in every locale, so it is deliberately not translated. The
            words around it are. */}
        <span className="flex items-center gap-1">
          <span>{t('agentMode.label')}</span>
          {/* eslint-disable-next-line no-restricted-syntax -- i18n(#1271): key notation */}
          <span className="opacity-60">shift+tab</span>
        </span>
      </button>
      {readable ? (
        <span
          className="flex-shrink-0 px-2 py-1 rounded-full bg-muted text-xs text-muted-foreground"
          data-testid="agent-mode-chip"
          data-agent-mode={agentMode}
        >
          {modeLabel}
        </span>
      ) : null}
    </div>
  );
});

export default AgentModeControl;
