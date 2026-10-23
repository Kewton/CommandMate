/**
 * Issue #3569: the gates and the composer target line moved out of
 * `TerminalSplitPaneContent` into `terminal-split-pane-content/`. These pin
 * the moved expressions to the answers the inline ones gave.
 */

import { describe, it, expect } from 'vitest';
import {
  shouldShowEscapeHatch,
  shouldShowNav,
  shouldShowPromptPanel,
} from '@/components/worktree/terminal-split-pane-content/pane-gates';
import { buildComposerTarget } from '@/components/worktree/terminal-split-pane-content/composer-target';

const yesNo = {
  type: 'yes_no' as const,
  question: 'Continue?',
  options: ['yes', 'no'] as ['yes', 'no'],
  status: 'pending' as const,
};

describe('shouldShowPromptPanel', () => {
  // Issue #3821: the server says Auto-Yes is answering this prompt — the one
  // decision under which the panel may stay hidden.
  const base = {
    visible: true,
    isStarting: false,
    autoYesEnabled: false,
    data: yesNo,
    answerable: true,
    autoYesDecision: { state: 'answering' as const },
  };

  it('shows a visible prompt with Auto-Yes off', () => {
    expect(shouldShowPromptPanel(base)).toBe(true);
  });

  it('hides it when not visible, or while the agent is launching', () => {
    expect(shouldShowPromptPanel({ ...base, visible: false })).toBe(false);
    expect(shouldShowPromptPanel({ ...base, isStarting: true })).toBe(false);
  });

  it('hides an answerable yes/no under Auto-Yes, but shows an unreadable screen (#3397)', () => {
    expect(shouldShowPromptPanel({ ...base, autoYesEnabled: true })).toBe(false);
    expect(shouldShowPromptPanel({ ...base, autoYesEnabled: true, answerable: false })).toBe(true);
  });
});

describe('shouldShowNav', () => {
  it('needs a selection list on the terminal surface, not launching', () => {
    expect(shouldShowNav({ isSelectionListFrame: true, isChatSurface: false, isStarting: false })).toBe(true);
    expect(shouldShowNav({ isSelectionListFrame: false, isChatSurface: false, isStarting: false })).toBe(false);
    expect(shouldShowNav({ isSelectionListFrame: true, isChatSurface: true, isStarting: false })).toBe(false);
    expect(shouldShowNav({ isSelectionListFrame: true, isChatSurface: false, isStarting: true })).toBe(false);
  });
});

describe('shouldShowEscapeHatch', () => {
  const base = {
    isUnclassifiedActive: true,
    isSelectionListFrame: false,
    promptVisible: false,
    isChatSurface: false,
    isStarting: false,
  };

  it('shows only for an unclassified frame with nothing else driving it', () => {
    expect(shouldShowEscapeHatch(base)).toBe(true);
    expect(shouldShowEscapeHatch({ ...base, isUnclassifiedActive: false })).toBe(false);
    expect(shouldShowEscapeHatch({ ...base, isSelectionListFrame: true })).toBe(false);
    expect(shouldShowEscapeHatch({ ...base, promptVisible: true })).toBe(false);
    expect(shouldShowEscapeHatch({ ...base, isChatSurface: true })).toBe(false);
    expect(shouldShowEscapeHatch({ ...base, isStarting: true })).toBe(false);
  });
});

describe('buildComposerTarget', () => {
  const t = (key: string, values?: Record<string, string>) => `${key}:${JSON.stringify(values ?? {})}`;

  it('names the alias and the trimmed branch', () => {
    expect(buildComposerTarget(t, { cliTool: 'codex', alias: 'Codex 2' }, 'codex', '  feature/x ')).toEqual({
      text: 'terminal.composerTarget:{"agent":"Codex 2","branch":"feature/x"}',
      aria: 'terminal.composerTargetLabel:{"agent":"Codex 2","branch":"feature/x"}',
    });
  });

  it('falls back to the tool when no instance, and drops a blank branch', () => {
    const noInstance = buildComposerTarget(t, undefined, 'claude', '   ');
    expect(noInstance.text).toMatch(/^terminal\.composerTargetNoBranch:/);
    expect(noInstance.aria).toMatch(/^terminal\.composerTargetLabelNoBranch:/);
    expect(buildComposerTarget(t, null, 'claude', null).text).toBe(noInstance.text);
  });
});
