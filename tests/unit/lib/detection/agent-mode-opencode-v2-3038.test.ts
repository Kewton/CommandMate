/**
 * OpenCode V2's Build ⇄ Plan agent, read off live 2.0.18 frames and gated like
 * every other mode button (Issue #3038).
 *
 * The frames are in `tests/fixtures/opencode-v2-agent-mode-3038/` (see its
 * README): the home screen and a session, each in Build and in Plan, plus the
 * dialogs that replace or cover the composer. The gate half reuses #2984's and
 * #2971's dialog captures, because those are the screens where `shift+tab`
 * must not leave the browser.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { detectAgentMode } from '@/lib/detection/agent-mode';
import { resolveAgentModeSpec } from '@/lib/cli-tools/agent-mode-spec';
import { stripAnsi } from '@/lib/detection/ansi';
import { normalizeFrame } from '@/lib/detection/tools/frame';
import { getToolStatusDetector } from '@/lib/detection/tools/registry';
import { SELECTION_LIST_REASONS } from '@/lib/detection/status-detector';
import { isUnclassifiedFrame } from '@/lib/session/status-evidence';
import { canCycleAgentMode } from '@/components/worktree/AgentModeControl';
import { AGENT_MODE_UNKNOWN, type AgentMode } from '@/types/cli-tool-contracts';

const FIXTURES = path.join(process.cwd(), 'tests/fixtures');

function frame(rel: string): string {
  return fs.readFileSync(path.join(FIXTURES, rel), 'utf8');
}

const DIR = 'opencode-v2-agent-mode-3038';

describe('[#3038] detectAgentMode reads the agent row under the composer', () => {
  it.each<[string, AgentMode]>([
    [`${DIR}/home-build.txt`, 'build'],
    [`${DIR}/home-plan.txt`, 'plan'],
    [`${DIR}/session-build.txt`, 'build'],
    [`${DIR}/session-plan.txt`, 'plan'],
    // The palette is an overlay; the composer and its agent row stay drawn.
    [`${DIR}/session-palette.txt`, 'build'],
    // Earlier captures (#2934 / #2945): idle, running and after an approval.
    ['opencode-v2-live-2934/boot-idle.txt', 'build'],
    ['opencode-v2-live-2934/turn-running.txt', 'build'],
    ['opencode-v2-live-2934/turn-done.txt', 'build'],
    ['opencode-v2-live-2945/turn-done-after-approval.txt', 'build'],
  ])('%s reads as %s', (name, mode) => {
    expect(detectAgentMode('opencode-v2', frame(name))).toBe(mode);
  });

  it.each([
    // A question dialog replaces the composer: no agent row, so no verdict.
    `${DIR}/session-question.txt`,
    'opencode-v2-dialogs-2984/permission.txt',
    'opencode-v2-dialogs-2984/question.txt',
  ])('%s reads as unknown (the composer is replaced)', (name) => {
    expect(detectAgentMode('opencode-v2', frame(name))).toBe(AGENT_MODE_UNKNOWN);
  });

  it('does not read the completion row a finished turn leaves (negative control)', () => {
    // `session-build.txt` cut right after `     Build · <model> · 4.9s · …`:
    // the row names the agent that ANSWERED, not the one selected now.
    const text = frame(`${DIR}/completion-row-only.txt`);
    const last = stripAnsi(text).trimEnd().split('\n').pop() ?? '';
    expect(last).toMatch(/^\s+Build · .* · [\d.]+s · /);
    expect(detectAgentMode('opencode-v2', text)).toBe(AGENT_MODE_UNKNOWN);
  });

  it('does not read a user message in the same `┃` gutter that merely says Build/Plan', () => {
    // The user's own text is drawn as `┃  <text>`, like the agent row. What
    // keeps it out is the window: it sits above the composer.
    const lines = frame(`${DIR}/session-plan.txt`).split('\n');
    const at = lines.findIndex((l) => stripAnsi(l).includes('Reply with exactly'));
    expect(at).toBeGreaterThan(0);
    lines[at] = '  ┃  Build · pretend this is the agent row';
    expect(detectAgentMode('opencode-v2', lines.join('\n'))).toBe('plan');
  });

  it('keeps the window at the measured depth (home: 4th row from the bottom)', () => {
    expect(resolveAgentModeSpec('opencode-v2')!.tailRows).toBe(4);
  });

  it('leaves v1 opencode undeclared', () => {
    expect(resolveAgentModeSpec('opencode')).toBeNull();
    expect(detectAgentMode('opencode', frame(`${DIR}/home-build.txt`))).toBe(AGENT_MODE_UNKNOWN);
  });
});

/**
 * The flags `buildCurrentOutput` derives from the fallback detector's verdict,
 * restated here from the same predicates it uses (`SELECTION_LIST_REASONS`,
 * `isUnclassifiedFrame`), then handed to the control's own gate.
 */
function gateFor(rel: string): { status: string; reason: string; open: boolean } {
  const verdict = getToolStatusDetector('opencode-v2').detect(normalizeFrame(frame(rel)));
  const open = canCycleAgentMode({
    sessionStatus: verdict.status,
    isPromptWaiting: verdict.hasActivePrompt,
    isSelectionListActive:
      verdict.status === 'waiting' && SELECTION_LIST_REASONS.has(verdict.reason),
    isDismissablePanelActive: false,
    isUnclassifiedActive: isUnclassifiedFrame(verdict.status, verdict.reason),
  });
  return { status: verdict.status, reason: verdict.reason, open };
}

describe('[#3038] the existing gate holds on OpenCode V2 screens', () => {
  it.each([
    `${DIR}/home-build.txt`,
    `${DIR}/home-plan.txt`,
    `${DIR}/session-build.txt`,
    `${DIR}/session-plan.txt`,
  ])('opens on %s (ready, nothing on screen)', (name) => {
    expect(gateFor(name)).toMatchObject({ status: 'ready', open: true });
  });

  it.each([
    // approval
    'opencode-v2-dialogs-2984/permission.txt',
    'opencode-v2-dialogs-2984/permission-after-digit.txt',
    // question
    'opencode-v2-dialogs-2984/question.txt',
    `${DIR}/session-question.txt`,
    // the Commands palette and the other pickers
    'opencode-v2-dialogs-2984/commands.txt',
    `${DIR}/session-palette.txt`,
    'opencode-v2-live-2971/select-agent.txt',
    'opencode-v2-live-2971/select-model.txt',
    // a running turn
    'opencode-v2-live-2934/turn-running.txt',
  ])('stays shut on %s', (name) => {
    const gate = gateFor(name);
    expect(gate.open, `${gate.status}/${gate.reason}`).toBe(false);
  });
});
