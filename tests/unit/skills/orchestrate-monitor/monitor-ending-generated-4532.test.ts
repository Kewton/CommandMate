/**
 * Issue #4532 (S10 r2) — invariant M3: every combination, GENERATED from the
 * reply-marker data (`.claude/skills/orchestrate-monitor/scripts/reply-markers.tsv`):
 *
 *   (tool, platform, marker) row of the data
 *     × ending   DONE / WAIT / STOP (the return line), IMPL_COMPLETED, a permission prompt
 *     × placement  one-line reply (`<marker> DONE: …`) or its own continuation row
 *     × panel    with or without claude's right-hand diff panel on the rows
 *
 * Each cell runs the real monitor.sh (fake `commandmate` on PATH, the shape of
 * monitor-pane-invariants-4532.test.ts) and the JS readers (wait-verify's
 * returnLineOf / hasCompletionSignal, launch-worker's endingOfAnswer) on the
 * SAME pane. A row added to the data is a new column here with no edit; a tool
 * in the data with no frame below fails the completeness test.
 *
 * The hand-written table of monitor-pane-matrix-4532.test.ts stays as a subset.
 *
 * The permission prompt follows the current design per tool, named in PROMPT_BY:
 * `pane-marker` (the tool's own marker set is put on the pane) or `server` (the
 * server's isPromptWaiting decides; codex has no marker set of its own).
 *
 * @vitest-environment node
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  REAL_SHELL_SUBPROCESS_TIMEOUT_MS,
  assertSubprocessCompleted,
} from '@tests/helpers/real-shell-budget';
import { endingOfAnswer } from '../../../../scripts/orchestrate/launch-worker.mjs';
import { hasCompletionSignal, returnLineOf } from '../../../../scripts/orchestrate/wait-verify.mjs';

const ROOT = process.cwd();
const MONITOR = path.join(ROOT, '.claude/skills/orchestrate-monitor/scripts/monitor.sh');
const DATA = path.join(ROOT, '.claude/skills/orchestrate-monitor/scripts/reply-markers.tsv');
const FIXTURES = path.join(ROOT, 'tests/fixtures');
const OWN = path.join(FIXTURES, 'orchestrate-monitor-4532');

/** The data rows, parsed here (not through either reader). */
const DATA_ROWS = readFileSync(DATA, 'utf8')
  .split('\n')
  .filter((line) => line !== '' && !line.startsWith('#'))
  .map((line) => {
    const [tool, platform, marker] = line.split('\t');
    return { tool, platform, marker };
  });

const ENDINGS = ['DONE', 'WAIT', 'STOP', 'IMPL_COMPLETED', 'PROMPT'] as const;
type Ending = (typeof ENDINGS)[number];
const PLACEMENTS = ['one-line', 'own-row'] as const;
const PANELS = ['panel', 'no-panel'] as const;
type Panel = (typeof PANELS)[number];

/** claude's diff panel as drawn after a row (`<blanks>│ <panel>`). */
const PANEL_SUFFIX = `${' '.repeat(40)}\u001b[38;5;244m│\u001b[39m src/x.ts +12 -3`;
const PANEL_RE = / +\u001b\[38;5;244m│\u001b\[39m .*$/;

const TEXT: Record<Exclude<Ending, 'PROMPT'>, { row: string; report: string; signal: boolean }> = {
  DONE: {
    row: 'DONE: #4532 abcdef1 verify exit 0',
    report: 'return line DONE — DONE: #4532 abcdef1 verify exit 0',
    signal: true,
  },
  WAIT: {
    row: 'WAIT: verify の前に人の判断が要る',
    report: 'return line WAIT — the worker is waiting; WAIT: verify の前に人の判断が要る',
    signal: false,
  },
  STOP: { row: 'STOP: 前提が変わった', report: 'return line STOP — the worker stopped; STOP: 前提が変わった', signal: false },
  IMPL_COMPLETED: {
    row: 'IMPL_COMPLETED head=abcdef1',
    report: 'SHAPE_OUTSIDE ending — IMPL_COMPLETED head=abcdef1 (not a return line; not completion)',
    signal: true,
  },
};
const KIND: Record<Exclude<Ending, 'PROMPT'>, string> = {
  DONE: 'DONE',
  WAIT: 'WAIT',
  STOP: 'STOP',
  IMPL_COMPLETED: 'SHAPE_OUTSIDE',
};

function json(tool: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    isRunning: true,
    cliToolId: tool,
    sessionStatus: 'ready',
    sessionStatusReason: 'input_prompt',
    content: '',
    realtimeSnippet: '   \n  \n',
    thinking: false,
    isPromptWaiting: false,
    promptData: null,
    ...extra,
  };
}

interface Frame {
  /** The pane with one `@@REPLY@@` row, without any panel. */
  template: string;
  /** The ANSI the live pane draws around the marker: `${pre}${marker}${post}`. */
  pre: string;
  post: string;
  /** The `--json` answer: a window that does not show the ending. */
  json: (extra?: Record<string, unknown>) => Record<string, unknown>;
  prompt: 'pane-marker' | 'server';
  /** The dialog pane for the prompt column (rows already carry the marker). */
  dialog: (marker: string, pre: string, post: string) => string;
}

const read = (p: string) => readFileSync(p, 'utf8');
const dePanel = (text: string) =>
  text
    .split('\n')
    .map((row) => row.replace(PANEL_RE, ''))
    .join('\n');
const fill = (template: string, rows: string[]) =>
  template
    .split('\n')
    .flatMap((row) => (row.includes('@@REPLY@@') ? rows.map((r) => row.replace('@@REPLY@@', r)) : [row]))
    .join('\n');

const CLAUDE_DIALOG_ROWS = (
  JSON.parse(read(path.join(ROOT, 'tests/unit/skills/orchestrate-monitor/fixtures/prompt-yes-no.json'))) as {
    realtimeSnippet: string;
  }
).realtimeSnippet
  .split('\n')
  // The fixture's tool row carries the macOS glyph; the generated cell redraws it with this platform's.
  .map((row, i) => (i === 0 ? row.replace(/^\S+ /, '') : row));

const FRAMES: Record<string, Frame> = {
  claude: {
    template: dePanel(read(path.join(OWN, 'claude-diff-panel-synthetic.txt'))),
    pre: '\u001b[38;5;231m\u001b[49m',
    post: '\u001b[39m ',
    json: (extra) => json('claude', { realtimeSnippet: '❯ \n? for shortcuts', ...extra }),
    prompt: 'pane-marker',
    dialog: (m, pre, post) =>
      fill(dePanel(read(path.join(OWN, 'claude-diff-panel-synthetic.txt'))), [
        `${pre}${m}${post}${CLAUDE_DIALOG_ROWS[0]}`,
        ...CLAUDE_DIALOG_ROWS.slice(1),
      ]),
  },
  codex: {
    template: read(path.join(OWN, 'codex-split-canvas-synthetic.txt')),
    pre: '\u001b[2m',
    post: ' \u001b[0m',
    json: (extra) =>
      json('codex', {
        realtimeSnippet: [...Array.from({ length: 97 }, () => ''), '› Ask Codex to do anything', '', '  gpt-6-astra default · ~/repo'].join('\n'),
        ...extra,
      }),
    prompt: 'server',
    dialog: () => read(path.join(FIXTURES, 'codex-live-2310/dialog-permissions-picker.txt')),
  },
  'command-code': {
    template: read(path.join(OWN, 'command-code-top-anchored-synthetic.txt')),
    pre: '\u001b[38;5;147m',
    post: '\u001b[39m ',
    json: (extra) => json('command-code', extra),
    prompt: 'pane-marker',
    dialog: () => read(path.join(FIXTURES, 'command-code-live-2250/dialog-shell-command.txt')),
  },
};

/** The panel on every non-blank row of a pane (claude's is drawn down the whole height). */
function withPanel(pane: string): string {
  return pane
    .split('\n')
    .map((row) => (row.trim() === '' ? row : `${row}${PANEL_SUFFIX}`))
    .join('\n');
}

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function runMonitor(payload: Record<string, unknown>, pane: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'monitor-gen-4532-'));
  dirs.push(dir);
  const frameFile = path.join(dir, 'payload.json');
  const paneFile = path.join(dir, 'pane.txt');
  const cm = path.join(dir, 'fake-cm');
  writeFileSync(frameFile, JSON.stringify(payload, null, 2));
  writeFileSync(paneFile, pane);
  writeFileSync(cm, ['#!/bin/sh', 'case " $* " in', `  *" --pane "*) cat "${paneFile}" ;;`, `  *) cat "${frameFile}" ;;`, 'esac', ''].join('\n'));
  writeFileSync(path.join(dir, 'tmux'), '#!/bin/sh\nexit 0\n');
  chmodSync(cm, 0o755);
  chmodSync(path.join(dir, 'tmux'), 0o755);
  const proc = spawnSync(
    'bash',
    [MONITOR, '--interval', '0', '--idle-threshold', '1', '--max-polls', '1', '--no-auto-approve', 'w1'],
    {
      encoding: 'utf8',
      timeout: REAL_SHELL_SUBPROCESS_TIMEOUT_MS,
      env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}`, CM: cm },
    },
  );
  assertSubprocessCompleted(proc, 'monitor-ending-generated-4532.test.ts');
  expect({ status: proc.status, signal: proc.signal }).toEqual({ status: 0, signal: null });
  return proc.stdout ?? '';
}

const reports = (stdout: string) =>
  stdout
    .split('\n')
    .filter((line) => /return line (DONE|WAIT|STOP)|SHAPE_OUTSIDE ending/.test(line))
    .map((line) => line.replace(/^monitor\[[^\]]*\]: /, ''));

interface Cell {
  name: string;
  tool: string;
  marker: string;
  ending: Ending;
  panel: Panel;
  placement?: (typeof PLACEMENTS)[number];
}

const CELLS: Cell[] = DATA_ROWS.flatMap(({ tool, platform, marker }) =>
  ENDINGS.flatMap((ending) =>
    PANELS.flatMap((panel): Cell[] =>
      ending === 'PROMPT'
        ? [{ name: `${tool}/${platform} ${marker} × PROMPT (${FRAMES[tool]?.prompt}) × ${panel}`, tool, marker, ending, panel }]
        : PLACEMENTS.map((placement) => ({
            name: `${tool}/${platform} ${marker} × ${ending} × ${placement} × ${panel}`,
            tool,
            marker,
            ending,
            panel,
            placement,
          })),
    ),
  ),
);

describe('M3: the generated table is complete', () => {
  it('every tool of the data has a frame, and the count is data rows × (4 endings × 2 placements + prompt) × 2 panels', () => {
    for (const { tool } of DATA_ROWS) expect(Object.keys(FRAMES), `no frame for ${tool}`).toContain(tool);
    expect(CELLS).toHaveLength(DATA_ROWS.length * (4 * PLACEMENTS.length + 1) * PANELS.length);
  });
});

describe('M3: every generated cell — the real monitor and the JS readers on the same pane', () => {
  it.each(CELLS.map((c) => [c.name, c] as const))('%s', (_name, cell) => {
    const frame = FRAMES[cell.tool];
    const marked = `${frame.pre}${cell.marker}${frame.post}`;
    if (cell.ending === 'PROMPT') {
      const dialog = frame.dialog(cell.marker, frame.pre, frame.post);
      const pane = cell.panel === 'panel' ? withPanel(dialog) : dialog;
      const payload = frame.prompt === 'server' ? frame.json({ isPromptWaiting: true }) : frame.json();
      expect(runMonitor(payload, pane)).toContain('PROMPT held, no Enter sent');
      expect(returnLineOf(pane).kind).toBe('none');
      return;
    }
    const t = TEXT[cell.ending];
    const replyRows = cell.placement === 'one-line' ? [`${marked}${t.row}`] : [`${marked}実装しました。`, `  ${t.row}`];
    const filled = fill(frame.template, replyRows);
    const pane = cell.panel === 'panel' ? withPanel(filled) : filled;
    expect(reports(runMonitor(frame.json(), pane))).toEqual([t.report]);
    expect(returnLineOf(pane)).toEqual({ kind: KIND[cell.ending], line: t.row });
    expect(endingOfAnswer({ content: pane })).toEqual({ kind: KIND[cell.ending], line: t.row });
    expect(hasCompletionSignal(pane, { head: 'abcdef1234' })).toBe(t.signal);
  });
});
