/**
 * Issue #4532 (S10) — invariant N0: the monitor picks up every ending on every
 * tool's pane. The table is Command Code・claude・codex × the three endings the
 * goal can leave (the return line `DONE:` / `WAIT:` / `STOP:`, a permission
 * prompt, the shape-outside `IMPL_COMPLETED`), each on the frame that hid it
 * once:
 *
 *   claude        the diff panel on the right (review r4 P1-B): every row reads
 *                 `<left column><blanks>│ <panel>`, so a reader anchored with `$`
 *                 missed `DONE: … exit 0      │ src/x.ts +12 -3`.
 *   codex         the split canvas (#3946, review r3 P1-A): transcript at the
 *                 top, composer at the bottom, blank rows between — `--json`'s
 *                 windows hold the composer and nothing else.
 *   Command Code  drawn from the top (#4245, #4434): `--json`'s windows are
 *                 blank padding.
 *
 * Each text ending is placed two ways: on its own continuation row of a reply
 * (`  DONE: …`, under the tool's reply marker row `⏺` / `•` / `⠶`), and as a
 * one-line reply that carries the marker itself (`⏺ DONE: …`). Invariant
 * N2 rides along: the panel column quotes return lines below the reply, and the
 * negative rows put `DONE:` mid-sentence and in a quote — none of those is an
 * ending.
 *
 * The real monitor.sh / monitor-lib.sh / classify-state.sh run against a fake
 * `commandmate` on PATH (the shape of monitor-pane-invariants-4532.test.ts):
 * `capture --json` answers a frame whose windows do NOT hold the ending, and
 * `capture --pane` answers the pane. Everything is written under os.tmpdir().
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

const ROOT = process.cwd();
const MONITOR = path.join(ROOT, '.claude/skills/orchestrate-monitor/scripts/monitor.sh');
const FIXTURES = path.join(ROOT, 'tests/fixtures');
const OWN = path.join(FIXTURES, 'orchestrate-monitor-4532');

const TOOLS = ['command-code', 'claude', 'codex'] as const;
type Tool = (typeof TOOLS)[number];

const ENDINGS = ['DONE', 'WAIT', 'STOP', 'PROMPT', 'IMPL_COMPLETED'] as const;
type Ending = (typeof ENDINGS)[number];

/**
 * How a text ending sits in the reply:
 *   own-row   on its own continuation row under the reply's first row (the
 *             return line as the LAST line of a multi-line return);
 *   one-line  the whole reply is the ending, so it carries the tool's reply
 *             marker (`⏺ DONE: …` / `• DONE: …` / `⠶ DONE: …`) — the
 *             normalization strips that marker (lead r1 decision).
 */
const PLACEMENTS = ['own-row', 'one-line'] as const;
type Placement = (typeof PLACEMENTS)[number];

interface ToolFrame {
  /** The pane template: one row carries `@@REPLY@@`. */
  template: string;
  /** The tool's reply marker, with the ANSI its live pane draws around it. */
  marker: string;
  /** A `capture --json` answer whose windows do not show the ending. */
  json: (extra?: Record<string, unknown>) => Record<string, unknown>;
}

function blankJson(tool: Tool, extra: Record<string, unknown> = {}): Record<string, unknown> {
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

const CODEX_COMPOSER = ['› Ask Codex to do anything', '', '  gpt-6-astra default · ~/repo'];

const FRAMES: Record<Tool, ToolFrame> = {
  'command-code': {
    template: readFileSync(path.join(OWN, 'command-code-top-anchored-synthetic.txt'), 'utf8'),
    marker: '\u001b[38;5;147m⠶\u001b[39m ',
    json: (extra) => blankJson('command-code', extra),
  },
  claude: {
    template: readFileSync(path.join(OWN, 'claude-diff-panel-synthetic.txt'), 'utf8'),
    marker: '\u001b[38;5;231m\u001b[49m⏺\u001b[39m ',
    json: (extra) => blankJson('claude', { realtimeSnippet: '❯ \n? for shortcuts', ...extra }),
  },
  codex: {
    template: readFileSync(path.join(OWN, 'codex-split-canvas-synthetic.txt'), 'utf8'),
    marker: '\u001b[2m• \u001b[0m',
    // The last 100 rows of the canvas: the composer and nothing else (#3946).
    json: (extra) =>
      blankJson('codex', {
        realtimeSnippet: [...Array.from({ length: 97 }, () => ''), ...CODEX_COMPOSER].join('\n'),
        ...extra,
      }),
  },
};

/** The pane with the `@@REPLY@@` row replaced by one row per reply line. */
function pane(tool: Tool, reply: string[]): string {
  return FRAMES[tool].template
    .split('\n')
    .flatMap((row) => (row.includes('@@REPLY@@') ? reply.map((line) => row.replace('@@REPLY@@', line)) : [row]))
    .join('\n');
}

/** The reply rows for a text ending placed one way. */
function replyRows(tool: Tool, ending: string, placement: Placement): string[] {
  const marker = FRAMES[tool].marker;
  return placement === 'one-line' ? [`${marker}${ending}`] : [`${marker}実装しました。`, `  ${ending}`];
}

interface TextEnding {
  kind: 'text';
  row: string;
  /** The one report line the monitor prints for it. */
  report: string;
}
interface PromptEnding {
  kind: 'prompt';
}

const DONE_ROW = 'DONE: #4532 abcdef1 verify exit 0';
const ENDING_CASES: Record<Ending, TextEnding | PromptEnding> = {
  DONE: { kind: 'text', row: DONE_ROW, report: `return line DONE — ${DONE_ROW}` },
  WAIT: {
    kind: 'text',
    row: 'WAIT: verify の前に人の判断が要る',
    report: 'return line WAIT — the worker is waiting; WAIT: verify の前に人の判断が要る',
  },
  STOP: {
    kind: 'text',
    row: 'STOP: 前提が変わった',
    report: 'return line STOP — the worker stopped; STOP: 前提が変わった',
  },
  IMPL_COMPLETED: {
    kind: 'text',
    row: 'IMPL_COMPLETED head=abcdef1',
    report: 'SHAPE_OUTSIDE ending — IMPL_COMPLETED head=abcdef1 (not a return line; not completion)',
  },
  PROMPT: { kind: 'prompt' },
};

const CLAUDE_DIALOG = (
  JSON.parse(
    readFileSync(path.join(ROOT, 'tests/unit/skills/orchestrate-monitor/fixtures/prompt-yes-no.json'), 'utf8'),
  ) as { realtimeSnippet: string }
).realtimeSnippet.split('\n');

/**
 * The prompt column: the pane with an open permission dialog, and the `--json`
 * answer next to it. codex has no pane marker of its own; its prompt is the
 * server's isPromptWaiting (the S9 decision, kept).
 */
const PROMPT_CELLS: Record<Tool, { pane: () => string; json: () => Record<string, unknown> }> = {
  'command-code': {
    pane: () => readFileSync(path.join(FIXTURES, 'command-code-live-2250/dialog-shell-command.txt'), 'utf8'),
    json: () => FRAMES['command-code'].json(),
  },
  claude: {
    pane: () => pane('claude', CLAUDE_DIALOG),
    json: () => FRAMES.claude.json(),
  },
  codex: {
    pane: () => readFileSync(path.join(FIXTURES, 'codex-live-2310/dialog-permissions-picker.txt'), 'utf8'),
    json: () => FRAMES.codex.json({ isPromptWaiting: true }),
  },
};

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

/** Run the real loop once: `--json` answers `payload`, `--pane` answers `paneText`. */
function runOnce(payload: Record<string, unknown>, paneText: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'monitor-pane-matrix-4532-'));
  dirs.push(dir);
  const frameFile = path.join(dir, 'payload.json');
  const paneFile = path.join(dir, 'pane.txt');
  const cmShim = path.join(dir, 'fake-cm');
  const tmuxShim = path.join(dir, 'tmux');
  writeFileSync(frameFile, JSON.stringify(payload, null, 2));
  writeFileSync(paneFile, paneText);
  writeFileSync(
    cmShim,
    ['#!/bin/sh', 'case " $* " in', `  *" --pane "*) cat "${paneFile}" ;;`, `  *) cat "${frameFile}" ;;`, 'esac', ''].join(
      '\n',
    ),
  );
  writeFileSync(tmuxShim, '#!/bin/sh\nexit 0\n');
  chmodSync(cmShim, 0o755);
  chmodSync(tmuxShim, 0o755);
  const proc = spawnSync(
    'bash',
    [MONITOR, '--interval', '0', '--idle-threshold', '1', '--max-polls', '1', '--no-auto-approve', 'w1'],
    {
      encoding: 'utf8',
      timeout: REAL_SHELL_SUBPROCESS_TIMEOUT_MS,
      env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}`, CM: cmShim },
    },
  );
  assertSubprocessCompleted(proc, 'monitor-pane-matrix-4532.test.ts');
  expect({ status: proc.status, signal: proc.signal }).toEqual({ status: 0, signal: null });
  return proc.stdout ?? '';
}

/** The report lines naming an ending, with the `monitor[<label>]: ` prefix cut. */
function endingReports(stdout: string): string[] {
  return stdout
    .split('\n')
    .filter((line) => /return line (DONE|WAIT|STOP)|SHAPE_OUTSIDE ending/.test(line))
    .map((line) => line.replace(/^monitor\[[^\]]*\]: /, ''));
}

describe('N0: the table is complete (a missing cell fails here, not silently)', () => {
  it('every tool has a frame and a prompt cell, every ending has a case', () => {
    expect(Object.keys(FRAMES).sort()).toEqual([...TOOLS].sort());
    expect(Object.keys(PROMPT_CELLS).sort()).toEqual([...TOOLS].sort());
    expect(Object.keys(ENDING_CASES).sort()).toEqual([...ENDINGS].sort());
    for (const tool of TOOLS) expect(FRAMES[tool].template.split('\n').filter((r) => r.includes('@@REPLY@@'))).toHaveLength(1);
  });
});

const TEXT_CELLS = TOOLS.flatMap((tool) =>
  ENDINGS.flatMap((ending) => {
    const c = ENDING_CASES[ending];
    if (c.kind !== 'text') return [];
    return PLACEMENTS.map((placement) => [tool, ending, placement, c] as const);
  }),
);

describe('N0: each text ending on each tool frame is reported once, as itself', () => {
  it.each(TEXT_CELLS)('%s × %s (%s)', (tool, _ending, placement, c) => {
    const stdout = runOnce(FRAMES[tool].json(), pane(tool, replyRows(tool, c.row, placement)));
    // Exactly one report, and it is this ending with nothing of the panel in it.
    expect(endingReports(stdout)).toEqual([c.report]);
  });
});

describe('N0: a permission prompt on each tool frame is PROMPT', () => {
  it.each(TOOLS)('%s × PROMPT', (tool) => {
    const stdout = runOnce(PROMPT_CELLS[tool].json(), PROMPT_CELLS[tool].pane());
    expect(stdout).toContain('PROMPT held, no Enter sent');
  });
});

/** N2 — rows that carry `DONE:` but are not an ending, on every tool frame. */
const NOT_ENDINGS: Array<[string, (marker: string) => string[]]> = [
  ['still working (only the claude panel quotes return lines)', (m) => [`${m}まだ作業中です。`]],
  ['DONE: mid-sentence', (m) => [`${m}最後に DONE: #4532 abcdef1 verify exit 0 と書いて終える`]],
  ['DONE: inside a backtick quote', (m) => [`${m}形は次のとおり:`, '  `DONE: #4532 abcdef1 verify exit 0`']],
  ['DONE: inside a boxed quote', (m) => [`${m}形は次のとおり:`, '  │ DONE: #4532 abcdef1 verify exit 0 │']],
  ['the user echo is not a reply marker', () => ['› DONE: #4532 abcdef1 verify exit 0']],
  ['the composer (typed, not sent) is not a reply marker', () => ['❯ DONE: #4532 abcdef1 verify exit 0']],
  ['a marked reply with DONE: mid-sentence', (m) => [`${m}本文の途中の DONE: #4532 abcdef1 verify exit 0 は終わりでない`]],
  ['two markers', () => ['⏺⏺ DONE: #4532 abcdef1 verify exit 0']],
  ['a marker behind a box bar', () => ['│ ⏺ DONE: #4532 abcdef1 verify exit 0']],
];

describe('N2: a DONE: that is not at the head of a row is not an ending', () => {
  const cells = TOOLS.flatMap((tool) => NOT_ENDINGS.map(([name, rows]) => [tool, name, rows] as const));
  it.each(cells)('%s: %s', (tool, _name, rows) => {
    const stdout = runOnce(FRAMES[tool].json(), pane(tool, rows(FRAMES[tool].marker)));
    expect(endingReports(stdout)).toEqual([]);
  });
});

describe('review r4 P3-G: codex has no pane marker, so Claude words on its pane are not a prompt', () => {
  it('codex quoting a Claude dialog in its reply, isPromptWaiting false: not PROMPT', () => {
    const quoted = ['• Claude のダイアログはこう描かれる:', '  Do you want to proceed?', '  ❯ 1. Yes', '  2. No'];
    const stdout = runOnce(FRAMES.codex.json(), pane('codex', quoted));
    expect(stdout).not.toContain('PROMPT held');
  });

  it('positive control: the same rows on a claude pane are PROMPT (the marker is claude\'s)', () => {
    const quoted = ['⏺ Bash(rm -rf build/)', '', 'Do you want to proceed?', '❯ 1. Yes', '  2. No'];
    expect(runOnce(FRAMES.claude.json(), pane('claude', quoted))).toContain('PROMPT held, no Enter sent');
  });
});

describe('review r4 P3-H: a --pane read that fails again after recovering is announced again', () => {
  it('fail, read, fail: two WARNs (one per failure episode)', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'monitor-pane-warn-4532-'));
    dirs.push(dir);
    const frameFile = path.join(dir, 'payload.json');
    const counter = path.join(dir, 'pane-calls');
    const cmShim = path.join(dir, 'fake-cm');
    writeFileSync(frameFile, JSON.stringify(blankJson('codex'), null, 2));
    writeFileSync(counter, '0');
    // The 1st and 3rd `--pane` reads fail; the 2nd answers a pane.
    writeFileSync(
      cmShim,
      [
        '#!/bin/sh',
        'case " $* " in',
        '  *" --pane "*)',
        `    n=$(($(cat "${counter}") + 1)); echo "$n" > "${counter}"`,
        '    [ "$n" = 2 ] || exit 1',
        "    printf 'working\\n' ;;",
        `  *) cat "${frameFile}" ;;`,
        'esac',
        '',
      ].join('\n'),
    );
    writeFileSync(path.join(dir, 'tmux'), '#!/bin/sh\nexit 0\n');
    chmodSync(cmShim, 0o755);
    chmodSync(path.join(dir, 'tmux'), 0o755);
    const proc = spawnSync(
      'bash',
      [MONITOR, '--interval', '0', '--idle-threshold', '5', '--max-polls', '3', '--no-auto-approve', 'w1'],
      {
        encoding: 'utf8',
        timeout: REAL_SHELL_SUBPROCESS_TIMEOUT_MS,
        env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}`, CM: cmShim },
      },
    );
    assertSubprocessCompleted(proc, 'monitor-pane-matrix-4532.test.ts');
    expect(readFileSync(counter, 'utf8').trim()).toBe('3');
    const warns = (proc.stdout ?? '').split('\n').filter((line) => line.includes('WARN capture --pane failed'));
    expect(warns).toHaveLength(2);
  });
});
