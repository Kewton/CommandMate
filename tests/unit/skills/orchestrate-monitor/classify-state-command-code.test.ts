import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Issue #4245 — the monitor read every Command Code worker as idle.
 *
 * Command Code renders inline in a 200x1000 pane and is top-anchored, so
 * `realtimeSnippet` (the last 100 rows) is blank padding until the transcript
 * fills the pane, and the Claude path found no marker in it. Measured on the
 * 15 existing live frames: all came out IDLE. Command Code's own words are the
 * Claude ones, so the fix is the window (classify-state.sh picks it from
 * `cliToolId`). Every frame here is an existing capture; nothing is recorded.
 *
 * Not covered, no measurement: a retry backoff and a rate-limit banner (no
 * capture exists), and the unnumbered Plan review screen (left to the server's
 * isPromptWaiting, as for agy).
 */

const CLASSIFY = path.join(
  process.cwd(),
  '.claude/skills/orchestrate-monitor/scripts/classify-state.sh',
);
const FIXTURES = path.join(process.cwd(), 'tests/fixtures');
const PANE_ROWS = 1000;

function frame(rel: string): string {
  return readFileSync(path.join(FIXTURES, rel), 'utf8');
}

type Window = 'whole' | 'scrolled';

function payload(rows: string[], window: Window, cliToolId: string): Record<string, unknown> {
  let lines = rows;
  let content: string;
  if (window === 'scrolled') {
    let last = rows.length - 1;
    while (last >= 0 && rows[last].replace(/\u001b\[[0-9;]*[a-zA-Z]/g, '').trim() === '') last--;
    const history = Array.from({ length: PANE_ROWS }, (_, i) => `  scrolled history row ${i}`);
    lines = [...history, ...rows.slice(0, last + 1), ''];
    content = '';
  } else {
    content = lines.join('\n');
  }
  return {
    isRunning: true,
    cliToolId,
    sessionStatus: 'ready',
    sessionStatusReason: 'input_prompt',
    content,
    realtimeSnippet: lines.slice(-100).join('\n'),
    thinking: false,
    isPromptWaiting: false,
    promptData: null,
  };
}

let tmpDir = '';
let seq = 0;

beforeAll(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'ml-cc-test-'));
});

afterAll(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

function classify(p: Record<string, unknown>): string {
  seq += 1;
  const file = path.join(tmpDir, `poll-${seq}.json`);
  writeFileSync(file, JSON.stringify(p, null, 2));
  return execFileSync('bash', [CLASSIFY, '--json', file], { encoding: 'utf8' }).trim();
}

const rowsOf = (rel: string): string[] => frame(rel).split('\n');

const GENERATING = [
  'command-code-live-2250/turn-thinking.txt',
  'command-code-live-2250/turn-thinking-1490.txt',
  'command-code-live-2250/turn-shell-running-1490.txt',
];
const PROMPTS = [
  'command-code-live-2250/dialog-create-file.txt',
  'command-code-live-2250/dialog-shell-command.txt',
  'command-code-live-2250/dialog-shell-1490.txt',
  'command-code-live-2250/dialog-kill-task-1490.txt',
];
const IDLE = [
  'command-code-live-2250/boot-idle.txt',
  'command-code-live-2250/boot-idle-1490.txt',
  'command-code-live-2250/turn-done-1490.txt',
  'command-code-live-2250/turn-tool-write.txt',
  'command-code-live-2250/idle-after-interrupt-1490.txt',
];

describe('classify-state.sh — Command Code panes (#4245)', () => {
  for (const window of ['whole', 'scrolled'] as Window[]) {
    describe(`window: ${window}`, () => {
      it.each(GENERATING)('GENERATING: %s', (rel) => {
        expect(classify(payload(rowsOf(rel), window, 'command-code'))).toBe('GENERATING');
      });
      it.each(PROMPTS)('PROMPT: %s', (rel) => {
        expect(classify(payload(rowsOf(rel), window, 'command-code'))).toBe('PROMPT');
      });
      it.each(IDLE)('IDLE: %s', (rel) => {
        expect(classify(payload(rowsOf(rel), window, 'command-code'))).toBe('IDLE');
      });
    });
  }

  it('a stale status row far above the live frame does not pin a finished worker', () => {
    const stale = Array.from({ length: 60 }, () => 'esc to interrupt • 9s • ↓ 3');
    const done = rowsOf('command-code-live-2250/turn-done-1490.txt').filter((r) => r.trim() !== '');
    const filler = Array.from({ length: 40 }, (_, i) => `  transcript row ${i}`);
    const rows = [...stale, ...filler, ...done];
    while (rows.length < PANE_ROWS) rows.push('');
    expect(classify(payload(rows, 'whole', 'command-code'))).toBe('IDLE');
  });

  describe('negative controls: the Claude reading is unchanged', () => {
    it.each([...GENERATING, ...PROMPTS])('claude still reads the blank window as IDLE: %s', (rel) => {
      expect(classify(payload(rowsOf(rel), 'whole', 'claude'))).toBe('IDLE');
    });

    it('a Claude pane with the markers in the snippet is unaffected', () => {
      const rows = ['working', 'esc to interrupt • 3s'];
      expect(classify(payload(rows, 'whole', 'claude'))).toBe('GENERATING');
    });

    it('an Antigravity pane never takes the Command Code window', () => {
      const p = payload(rowsOf('command-code-live-2250/turn-thinking.txt'), 'whole', 'antigravity');
      expect(classify(p)).toBe(classify({ ...p, cliToolId: 'antigravity' }));
      expect(classify(p)).not.toBe('GENERATING');
    });
  });
});
