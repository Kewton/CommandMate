/** @vitest-environment node */

/**
 * Issue #1628: a Codex worker stopped at an approval prompt must not read as
 * "no human needed".
 *
 * Every fixture here is a verbatim `tmux capture-pane -p -e -S -10000 -E -` of a
 * live codex-cli 0.146.0 session (200x1000 pane, the geometry
 * src/config/tmux-pane-config.ts pins), driven through one real task:
 * "Create a file scripts/greet.sh …, then run: git add scripts/greet.sh".
 * ANSI is preserved; only the trailing pane padding was trimmed. Nothing is
 * hand-written — the reported frame ("• Running git add scripts/greet.sh" /
 * "Would you like to run the following command?" / "› 1. Yes, proceed (y)") is
 * approval-run-command.txt, byte for byte as tmux produced it.
 *
 * What was broken: Codex renders an approval request with the same
 * "Press enter to confirm" footer as a `/model` menu, so the priority-0.8
 * selection-list branch (Issue #622) claimed it first and answered
 * `hasActivePrompt: false`. `isPromptWaiting` is the only blocked-on-a-human
 * signal the current-output payload carries, so `commandmate wait --on-prompt
 * agent` never raised exit 10 for a stopped Codex worker. detectPrompt() itself
 * always parsed these frames correctly, which is why Auto-Yes (a direct
 * detectPrompt caller) answered prompts that `wait` could not see.
 *
 * The picker fixtures are the other half: they are live `/model` frames and must
 * stay `codex_selection_list` so NavigationButtons keep working (Issue #622).
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';

vi.mock('@/lib/db', () => ({ getSessionState: vi.fn(() => null) }));
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({
      getTool: () => ({ isRunning: vi.fn().mockResolvedValue(true) }),
    }),
  },
}));
vi.mock('@/lib/session/cli-session', () => ({ captureSessionOutput: vi.fn() }));
vi.mock('@/lib/polling/auto-yes-manager', () => ({
  getAutoYesState: vi.fn(() => undefined),
  getLastServerResponseTimestamp: vi.fn(() => null),
  isPollerActive: vi.fn(() => true),
  buildCompositeKey: vi.fn(() => 'wt-1:codex'),
}));

import { captureSessionOutput } from '@/lib/session/cli-session';
import { buildCurrentOutput } from '@/lib/session/current-output-builder';
import { detectSessionStatus, SELECTION_LIST_REASONS, STATUS_REASON } from '@/lib/detection/status-detector';
import { detectPrompt } from '@/lib/detection/prompt-detector';
import { buildDetectPromptOptions, stripAnsi, stripBoxDrawing } from '@/lib/detection/cli-patterns';

const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/codex-live-1628/', import.meta.url));

function frame(name: string): string {
  return readFileSync(`${FIXTURE_DIR}${name}.txt`, 'utf8');
}

/** The two approval shapes the run produced: an exec request and a patch request. */
const APPROVAL_FRAMES = [
  ['approval-run-command', 'Would you like to run the following command?'],
  ['approval-apply-patch', 'Would you like to make the following edits?'],
] as const;

describe('Issue #1628: live Codex approval frames are active prompts', () => {
  it.each(APPROVAL_FRAMES)('%s surfaces an active prompt, not a selection list', (name, question) => {
    const raw = frame(name);
    // Guard the fixture itself: if a future edit strips the approval out of the
    // capture, these assertions must fail loudly rather than pass vacuously.
    const plain = stripAnsi(raw);
    expect(plain).toContain(question);
    expect(plain).toContain('Press enter to confirm or esc to cancel');

    const result = detectSessionStatus(raw, 'codex');

    expect(result.status).toBe('waiting');
    expect(result.reason).toBe(STATUS_REASON.PROMPT_DETECTED);
    expect(result.reason).not.toBe(STATUS_REASON.CODEX_SELECTION_LIST);
    expect(result.hasActivePrompt).toBe(true);
    expect(result.promptDetection.promptData?.type).toBe('multiple_choice');
    expect(result.promptDetection.promptData?.options?.length).toBeGreaterThanOrEqual(2);
  });

  it('detectPrompt always saw these frames — the loss was in status-detector only', () => {
    // Documents why Auto-Yes could answer prompts `wait` never heard about:
    // Auto-Yes calls detectPrompt() directly, bypassing the branch that dropped them.
    for (const [name] of APPROVAL_FRAMES) {
      const detection = detectPrompt(
        stripBoxDrawing(stripAnsi(frame(name))),
        buildDetectPromptOptions('codex'),
      );
      expect(detection.isPrompt).toBe(true);
    }
  });
});

describe('Issue #622 non-regression: live /model pickers stay selection lists', () => {
  it.each([
    ['model-picker-step1', 'Select Model'],
    ['model-picker-step2', 'Select Model and Effort'],
  ])('%s stays a navigable list', (name, title) => {
    const raw = frame(name);
    const plain = stripAnsi(raw);
    expect(plain).toContain(title);
    expect(plain).toContain('Press enter to confirm or esc to go back');

    const result = detectSessionStatus(raw, 'codex');

    expect(result.status).toBe('waiting');
    expect(result.reason).toBe(STATUS_REASON.CODEX_SELECTION_LIST);
    expect(result.hasActivePrompt).toBe(false);
  });
});

describe('Issue #1628: the rest of the same live run keeps its old verdicts', () => {
  it('reports running while Codex works', () => {
    const result = detectSessionStatus(frame('working'), 'codex');
    expect(result.status).toBe('running');
    expect(result.hasActivePrompt).toBe(false);
  });

  it('reports ready once the turn is finished', () => {
    const result = detectSessionStatus(frame('idle-ready'), 'codex');
    expect(result.status).toBe('ready');
    expect(result.reason).toBe(STATUS_REASON.INPUT_PROMPT);
    expect(result.hasActivePrompt).toBe(false);
  });
});

/**
 * Issue #1628, paired paths. Of the non-alternate-screen tools, only Codex and
 * antigravity have a branch that answers `hasActivePrompt: false` for a frame the
 * agent is blocked on. Codex's is fixed above. Antigravity's is deliberate —
 * #997 widened ANTIGRAVITY_SELECTION_LIST_PATTERN to cover the permission menu so
 * NavigationButtons render for its arrow-key UI — so the same hole is closed on
 * the `wait` side instead (isSelectionListActive ⇒ exit 10), leaving the UI alone.
 * gemini and vibe-local have no selection-list branch at all: their prompts reach
 * priority 1 and surface as prompt_detected.
 */
describe('Issue #1628: the antigravity permission menu is the paired blocked state', () => {
  // Verbatim agy pane text from the Issue #997 fixture (tests/unit/prompt-detector.test.ts).
  const AGY_PERMISSION_MENU = [
    '  Requesting permission for:',
    '     git status',
    'Do you want to proceed?',
    '> 1. Yes',
    "  2. Yes, and always allow in this conversation for commands that start with 'git status'",
    "  3. Yes, and always allow for commands that start with 'git status' (Persist to settings.json)",
    '  4. No',
    '  ↑/↓ Navigate · tab Amend · ctrl+g edit/expand command · ctrl+r Review',
    'esc to cancel                                                          Gemini 3.5 Flash (Medium)',
  ].join('\n');

  it('is a selection list, not an active prompt — which is why `wait` reads that field', () => {
    const result = detectSessionStatus(AGY_PERMISSION_MENU, 'antigravity');

    expect(result.status).toBe('waiting');
    expect(result.reason).toBe(STATUS_REASON.ANTIGRAVITY_SELECTION_LIST);
    // Intentionally false (Issue #997 keeps NavigationButtons); `wait` covers it
    // through isSelectionListActive instead. See wait.test.ts.
    expect(result.hasActivePrompt).toBe(false);
    expect(SELECTION_LIST_REASONS.has(result.reason)).toBe(true);
  });
});

describe('Issue #1628: the payload `wait` polls', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('publishes isPromptWaiting + promptData for a live approval frame', async () => {
    vi.mocked(captureSessionOutput).mockResolvedValue(frame('approval-run-command'));

    const payload = await buildCurrentOutput({} as Database.Database, 'wt-1', 'codex');

    // These three fields are exactly what src/cli/commands/wait.ts branches on.
    expect(payload.isRunning).toBe(true);
    expect(payload.isPromptWaiting).toBe(true);
    expect(payload.promptData).not.toBeNull();
    // Never `ready`: that is the value that would make `wait` print "Completed".
    expect(payload.sessionStatus).toBe('waiting');
    expect(payload.sessionStatus).not.toBe('ready');
  });

  it('still publishes a /model picker as a selection list, not a prompt', async () => {
    vi.mocked(captureSessionOutput).mockResolvedValue(frame('model-picker-step2'));

    const payload = await buildCurrentOutput({} as Database.Database, 'wt-1', 'codex');

    expect(payload.isPromptWaiting).toBe(false);
    expect(payload.isSelectionListActive).toBe(true);
    expect(payload.sessionStatus).not.toBe('ready');
  });
});
