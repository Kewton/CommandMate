/**
 * Command Code's permission dialog through the `detectDialog` seam (Issue #2574).
 *
 * The rule exists to say one thing `sendPromptAnswer` needs: this dialog takes a
 * typed number, and the number commits it without an Enter. So this file pins
 * the verdict on every permission frame in the repository, on both spellings a
 * caller hands over, and pins `null` on every other Command Code screen —
 * `AskUserQuestion`, the `/model` picker, idle and running turns — because a
 * `permission` verdict on any of those would drop an Enter that screen needs.
 *
 * ## Non-vacuity
 *
 * Every mutation starts from a frame that the positive control in the same test
 * reads as `permission`, and changes one thing the module docblock names as
 * load-bearing: the footer's position, its wording, the permissions tail, the
 * cursor glyph, the row between options and footer.
 *
 * ## The 1.53.1 rows
 *
 * The dialog was measured live on 1.53.1 for this Issue, but
 * `fixtures.test.ts` pins `command-code-live-2250/` to the frames already in it,
 * so the rows are written out below rather than committed as a capture — the
 * same precedent `dismissable-panel-2369.test.ts` states. They are the capture's
 * last content rows with ANSI removed; the transcript above them is dropped.
 *
 * @vitest-environment node
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripAnsi, stripBoxDrawing } from '@/lib/detection/cli-patterns';
import { detectSessionStatus, STATUS_REASON } from '@/lib/detection/status-detector';
import { normalizeFrame } from '@/lib/detection/tools/frame';
import { getToolStatusDetector } from '@/lib/detection/tools/registry';
import {
  COMMAND_CODE_PERMISSION_FOOTER_PATTERN,
  detectCommandCodePermissionDialog,
} from '@/lib/detection/tools/command-code/permission';

const FIXTURES = path.resolve(__dirname, '../../../../fixtures');
const LIVE_DIR = path.join(FIXTURES, 'command-code-live-2250');

const read = (dir: string, name: string): string => fs.readFileSync(path.join(dir, name), 'utf8');

const detector = getToolStatusDetector('command-code');
const dialogOf = (text: string) => detector.detectDialog(normalizeFrame(text));

/** What the Auto-Yes poller holds: `captureAndCleanOutput`'s spelling. */
const asAutoYesSees = (raw: string): string => stripBoxDrawing(stripAnsi(raw));

/** ANSI removed and the tmux padding below the last content row trimmed. */
function contentOf(raw: string): string {
  return stripAnsi(raw).replace(/\s+$/, '');
}

const SHELL_OPTIONS = (command: string) => [
  'Yes',
  `Yes, don't ask again for \`${command}\` commands in this project`,
  'No, tell Command Code what to do differently',
];

const PERMISSION_FRAMES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['dialog-create-file.txt', ['Yes', 'Yes, allow all edits this session [shift+tab]', 'No, tell Command Code what to do differently']],
  ['dialog-shell-command.txt', SHELL_OPTIONS('sleep')],
  ['dialog-shell-1490.txt', SHELL_OPTIONS('sleep')],
  ['dialog-kill-task-1490.txt', SHELL_OPTIONS('kill')],
];

/** The 1.53.1 dialog's last rows, as measured for this Issue (see the docblock). */
const PERMISSION_1_53_1 = [
  '❯ Use the shell tool to run exactly this command and nothing else: touch uat-a.txt',
  '✻ Thought for 1 second [ctrl+o to expand]',
  '',
  '─'.repeat(200),
  '',
  'Execute Shell Command',
  'Command Code needs to execute touch uat-a.txt.',
  '',
  'Press [ctrl+e] to explain this command',
  '',
  '❯ 1. Yes',
  "  2. Yes, don't ask again for `touch` commands in this project",
  '  3. No, tell Command Code what to do differently',
  '',
  '↑/↓ navigate · enter select · ctrl+e explain · Run cmd --yolo to bypass all permissions (Docs ↗)',
].join('\n');

/** The composer Command Code paints back once the dialog is gone. */
const COMPOSER_ROWS = ['─'.repeat(200), '❯ Ask your question...', '─'.repeat(200), '  ? for shortcuts · taste on'];

describe('[#2574] the rule is declared', () => {
  it('gives command-code dialog rules', () => {
    expect(detector.hasDialogRules).toBe(true);
  });
});

describe('[#2574] every permission frame is a numbered dialog a digit commits', () => {
  it.each(PERMISSION_FRAMES)('%s, as captured', (name, options) => {
    expect(dialogOf(read(LIVE_DIR, name))).toEqual({
      kind: 'permission',
      options,
      answerMode: 'numbered',
      submitMode: 'answer_only',
    });
  });

  it.each(PERMISSION_FRAMES)('%s, as the Auto-Yes poller holds it', (name, options) => {
    // `stripBoxDrawing` blanks the rule row above the dialog. Nothing in the rule
    // reads it, so the verdict must not move.
    expect(dialogOf(asAutoYesSees(read(LIVE_DIR, name)))).toEqual({
      kind: 'permission',
      options,
      answerMode: 'numbered',
      submitMode: 'answer_only',
    });
  });

  it('the 1.53.1 rows read the same', () => {
    expect(dialogOf(PERMISSION_1_53_1)).toEqual({
      kind: 'permission',
      options: SHELL_OPTIONS('touch'),
      answerMode: 'numbered',
      submitMode: 'answer_only',
    });
  });

  it.each(PERMISSION_FRAMES)('%s still publishes the same status verdict', (name) => {
    // The rule is a seam for the sender, not a status branch: what `/current-output`
    // publishes for the dialog is the shared parser's, as before.
    const status = detectSessionStatus(read(LIVE_DIR, name), 'command-code');
    expect(status.reason).toBe(STATUS_REASON.PROMPT_DETECTED);
    expect(status.hasActivePrompt).toBe(true);
  });
});

describe('[#2574] every other Command Code screen is not a permission dialog', () => {
  const nonDialogLive = fs
    .readdirSync(LIVE_DIR)
    .filter((name) => name.endsWith('.txt') && !PERMISSION_FRAMES.some(([dialog]) => dialog === name));

  it('the sweep covers the non-dialog live frames', () => {
    // Guards the sweep itself: an empty directory listing would pass every row below.
    expect(nonDialogLive.length).toBeGreaterThanOrEqual(9);
  });

  it.each(nonDialogLive)('command-code-live-2250/%s', (name) => {
    const raw = read(LIVE_DIR, name);
    expect(dialogOf(raw)).toBeNull();
    expect(dialogOf(asAutoYesSees(raw))).toBeNull();
  });

  const questionFrames = ['command-code-askuserquestion-2521', 'command-code-askuserquestion-2522'].flatMap((dir) =>
    fs
      .readdirSync(path.join(FIXTURES, dir))
      .filter((name) => name.endsWith('.txt'))
      .map((name) => [dir, name] as const),
  );

  it.each(questionFrames)('%s/%s (AskUserQuestion draws no footer)', (dir, name) => {
    const raw = read(path.join(FIXTURES, dir), name);
    expect(dialogOf(raw)).toBeNull();
    expect(dialogOf(asAutoYesSees(raw))).toBeNull();
  });

  const pickerFrames = fs
    .readdirSync(path.join(FIXTURES, 'chat-dialog-card-2254'))
    .filter((name) => name.startsWith('command-code-') && name.endsWith('.txt'));

  it('the sweep covers the AskUserQuestion and picker captures', () => {
    expect(questionFrames.length).toBeGreaterThanOrEqual(10);
    expect(pickerFrames.length).toBeGreaterThanOrEqual(5);
  });

  it.each(pickerFrames)('chat-dialog-card-2254/%s (the `/model` picker)', (name) => {
    expect(dialogOf(read(path.join(FIXTURES, 'chat-dialog-card-2254'), name))).toBeNull();
  });
});

describe('[#2574] mutations: each load-bearing condition, removed once', () => {
  const base = contentOf(read(LIVE_DIR, 'dialog-shell-1490.txt'));
  const rows = base.split('\n');
  const footerIndex = rows.length - 1;
  const cursorIndex = rows.findIndex((row) => row.startsWith('❯ 1. Yes'));

  it('positive control: the trimmed, ANSI-free base still reads as the dialog', () => {
    expect(COMMAND_CODE_PERMISSION_FOOTER_PATTERN.test(rows[footerIndex])).toBe(true);
    expect(cursorIndex).toBeGreaterThan(0);
    expect(detectCommandCodePermissionDialog(normalizeFrame(base))?.kind).toBe('permission');
  });

  it('answered: the composer painted back under the same rows', () => {
    // Also the shape of an agent reply that QUOTES the dialog: Command Code draws
    // its composer under every transcript, so the hint bar is not the last row.
    expect(dialogOf([base, '', ...COMPOSER_ROWS].join('\n'))).toBeNull();
  });

  it("the `/model` picker's footer wording", () => {
    const mutated = [...rows];
    mutated[footerIndex] = 'type to search · ↑/↓ navigate · enter to select · esc to cancel';
    expect(dialogOf(mutated.join('\n'))).toBeNull();
  });

  it('a hint bar without the permissions tail', () => {
    const mutated = [...rows];
    mutated[footerIndex] = '↑/↓ navigate · enter select · ctrl+e explain';
    expect(dialogOf(mutated.join('\n'))).toBeNull();
  });

  it('no `❯` on the options', () => {
    const mutated = [...rows];
    mutated[cursorIndex] = mutated[cursorIndex].replace('❯', ' ');
    expect(dialogOf(mutated.join('\n'))).toBeNull();
  });

  it('a second row between the options and the hint bar', () => {
    const mutated = [...rows];
    mutated.splice(footerIndex, 0, 'Esc to cancel');
    expect(dialogOf(mutated.join('\n'))).toBeNull();
  });
});
