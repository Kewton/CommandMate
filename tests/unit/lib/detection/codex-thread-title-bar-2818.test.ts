/**
 * Issue #2818 — codex 0.154+'s status bar with a thread title is a boundary.
 *
 * ## The defect
 *
 * Once the first turn has named the thread, codex draws the bar as
 * `model · /path · <thread title>` (and Plan mode adds a right-aligned badge).
 * `CODEX_STATUS_BAR_PATTERN` wants the path last, so the codex detector found no
 * bar on those frames and fell to branch D, which reads the 15-row tail for a
 * thinking indicator. On an idle frame that tail still holds the finished
 * turn's `• Ran …` record, and the session read `running` — #2808's
 * `idle-after-declined-approval.txt`, and here a turn that simply ran one
 * command and answered.
 *
 * ## The fix, and why it is the boundary rather than branch D's gate
 *
 * `findCodexFooterBoundary` now also accepts `CODEX_TRAILED_STATUS_BAR_PATTERN`,
 * so a titled frame is windowed exactly like an untitled one — branch 2.7
 * reads the rows above the composer, and 0.8 / 0.85 / the #1160 guard cut the
 * content at the same row. The Issue's other option — keep the boundary and
 * only stop branch D from firing under a titled bar — reads the three probe
 * frames and the fixture tree the same way (checked by hand for #2818), but it
 * leaves titled frames on the no-bar path of every other reader, and the title
 * then still moves a verdict: appended to #1890's multi-line residual composer
 * (untitled: `running`), it would read `ready`. With the boundary, a title
 * moves no verdict on any measured frame — the property the last blocks below
 * pin.
 *
 * What a titled bar gives up: branch D used to read the whole 15-row tail, so
 * with a title it happened to see `• Working` above a steered message
 * (`codex-live-2310/steer-queued-running.txt`) and in #2400's just-submitted
 * frame. Those frames now read what they read untitled (`ready`), a gap of
 * branch 2.7's that predates the title and is left to its own Issue.
 *
 * ## What these tests are read off
 *
 * `tests/fixtures/codex-thread-title-probe/` — three frames from one codex-cli
 * 0.155.1 session on a private tmux socket at 200x1000, anonymised by two
 * same-length substitutions (README there). RAW, like the other codex fixtures.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { detectSessionStatus } from '@/lib/detection/status-detector';
import {
  CODEX_PROMPT_PATTERN,
  CODEX_STATUS_BAR_PATTERN,
  CODEX_THINKING_PATTERN,
  CODEX_TRAILED_STATUS_BAR_PATTERN,
  stripAnsi,
} from '@/lib/detection/cli-patterns';
import { STATUS_REASON } from '@/lib/detection/status-reason';
import { findCodexBottomGlyphRow } from '@/lib/detection/tools/codex/cli-patterns';
import { codexStatusDetector } from '@/lib/detection/tools/codex/detect';
import { normalizeFrame } from '@/lib/detection/tools/frame';
import type { PromptDetectionResult } from '@/lib/detection/types';

const REPO_ROOT = join(__dirname, '../../../..');
const PROBE_DIR = 'tests/fixtures/codex-thread-title-probe';

const readRel = (path: string): string => readFileSync(join(REPO_ROOT, path), 'utf-8');
const probe = (name: string): string => readRel(`${PROBE_DIR}/${name}.txt`);

/** The three frames, with the rows the tests below lean on (0-based). */
const PROBE = {
  'running-in-command': { bar: 28, composer: 26, working: 23, ran: -1 },
  'running-after-command': { bar: 31, composer: 29, working: 26, ran: 23 },
  'idle-after-command': { bar: 33, composer: 31, working: -1, ran: 23 },
} as const;

type ProbeName = keyof typeof PROBE;
const PROBE_NAMES = Object.keys(PROBE) as ProbeName[];

/** What step 1 hands `afterThinking` when the frame holds no prompt. */
const NO_PROMPT: PromptDetectionResult = { isPrompt: false, cleanContent: '' };

const verdictOf = (frame: string): string => {
  const result = detectSessionStatus(frame, 'codex');
  return `${result.status}/${result.reason}/${result.hasActivePrompt}`;
};

/** Cut a stripped bar row back to `model · /path`, the shape #1150's pattern reads. */
function withoutTrailer(row: string): string {
  const head = /^\s*\S[^·]*·\s*~?\/\S*/.exec(row);
  if (!head) throw new Error(`not a codex bar: ${row}`);
  return head[0];
}

/**
 * Index of the bottom-most row within the last 10 non-blank rows that only the
 * trailed pattern accepts, or -1. The same 10-row reach as the detector.
 */
function trailedBarRow(lines: readonly string[]): number {
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === '') end--;
  for (let i = end - 1; i >= Math.max(0, end - 10); i--) {
    if (CODEX_STATUS_BAR_PATTERN.test(lines[i])) return -1;
    if (CODEX_TRAILED_STATUS_BAR_PATTERN.test(lines[i])) return i;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// The fixtures are the measurement. If this fails, nothing below means anything.
// ---------------------------------------------------------------------------

describe('[#2818] the probe frames still carry what was measured', () => {
  it.each(PROBE_NAMES)('%s: raw, 0.155.1, 200x1000, titled bar', name => {
    const frame = probe(name);
    expect(frame).toContain('\x1b[');
    expect(stripAnsi(frame)).toContain('OpenAI Codex (v0.155.1)');
    // 1000 visible rows plus the trailing newline, as `capture-pane -p` writes them.
    expect(frame.split('\n')).toHaveLength(1001);
    const rows = stripAnsi(frame).split('\n');
    const { bar, composer, working, ran } = PROBE[name];
    expect(rows[bar]).toMatch(/^ {2}gpt-5\.6-terra low · \/private\/var\/folders\/xx\/x{30}\/T\/codexbar-probe-XXXXXX\/repo · Reply OK$/);
    expect(rows.slice(bar + 1).every(row => row.trim() === '')).toBe(true);
    expect(findCodexBottomGlyphRow(frame)).toEqual({ kind: 'composer', row: composer });
    expect(rows[composer]).toBe('› Ask Codex to do anything');
    if (working >= 0) expect(rows[working]).toMatch(/^• Working \(\d+s • esc to interrupt\)/);
    if (ran >= 0) expect(rows[ran]).toBe('• Ran sleep 30');
  });

  it('the idle frame closed the turn with a one-word answer below the `• Ran` record', () => {
    const rows = stripAnsi(probe('idle-after-command')).split('\n');
    expect(rows.slice(23, 29)).toEqual([
      '• Ran sleep 30',
      '  └ (no output)',
      '',
      '• finished',
      '',
      '  done 6:57 PM',
    ]);
    expect(rows.join('\n')).not.toMatch(/esc to interrupt/);
  });
});

// ---------------------------------------------------------------------------
// The verdicts.
// ---------------------------------------------------------------------------

describe('[#2818] a titled bar is read like an untitled one', () => {
  it.each([
    ['running-in-command', 'running', STATUS_REASON.THINKING_INDICATOR],
    ['running-after-command', 'running', STATUS_REASON.THINKING_INDICATOR],
    ['idle-after-command', 'ready', STATUS_REASON.INPUT_PROMPT],
  ] as const)('%s → %s / %s (raw and stripped)', (name, status, reason) => {
    for (const frame of [probe(name), stripAnsi(probe(name))]) {
      const result = detectSessionStatus(frame, 'codex');
      expect(result.status).toBe(status);
      expect(result.reason).toBe(reason);
      expect(result.hasActivePrompt).toBe(false);
    }
  });

  it("#2808's declined-approval frame reads `ready` too", () => {
    const frame = readRel('tests/fixtures/codex-dialogs-0155/idle-after-declined-approval.txt');
    expect(verdictOf(frame)).toBe('ready/input_prompt/false');
    expect(verdictOf(stripAnsi(frame))).toBe('ready/input_prompt/false');
  });

  it('only the trailed pattern accepts the probe bar', () => {
    const bar = stripAnsi(probe('idle-after-command')).split('\n')[PROBE['idle-after-command'].bar];
    expect(CODEX_STATUS_BAR_PATTERN.test(bar)).toBe(false);
    expect(CODEX_TRAILED_STATUS_BAR_PATTERN.test(bar)).toBe(true);
    expect(CODEX_STATUS_BAR_PATTERN.test(withoutTrailer(bar))).toBe(true);
  });

  it.each(PROBE_NAMES)('%s: taking the title off the bar does not move the verdict', name => {
    const rows = stripAnsi(probe(name)).split('\n');
    const titled = verdictOf(rows.join('\n'));
    rows[PROBE[name].bar] = withoutTrailer(rows[PROBE[name].bar]);
    expect(verdictOf(rows.join('\n'))).toBe(titled);
  });
});

// ---------------------------------------------------------------------------
// Which branch reads them.
// ---------------------------------------------------------------------------

describe('[#2818] the codex branch reads the titled frames through the bar', () => {
  it.each([
    ['running-in-command', 'running', STATUS_REASON.THINKING_INDICATOR],
    ['running-after-command', 'running', STATUS_REASON.THINKING_INDICATOR],
    ['idle-after-command', 'ready', STATUS_REASON.INPUT_PROMPT],
  ] as const)('%s: branch 2.7 alone answers %s', (name, status, reason) => {
    // Called directly, so the shared thinking step cannot answer first. None of
    // the three frames holds a prompt, which is what the chain would pass.
    const verdict = codexStatusDetector.afterThinking?.(normalizeFrame(probe(name)), NO_PROMPT);
    expect(verdict?.status).toBe(status);
    expect(verdict?.reason).toBe(reason);
  });

  it('the running frames are also caught by the shared 5-row step, once blank rows are compacted', () => {
    // `• Working` sits two blank rows above the composer; the frame
    // normaliser folds each run of blanks to one, which puts it fifth from the
    // bottom. So these frames confirm the new boundary does not turn a live
    // turn `ready`; branch 2.7's own reading of them is pinned above.
    for (const name of ['running-in-command', 'running-after-command'] as const) {
      expect(CODEX_THINKING_PATTERN.test(normalizeFrame(probe(name)).thinkingLines), name).toBe(true);
    }
  });

  it('the idle frame keeps its `• Ran` inside the 15-row tail branch D used to read', () => {
    const frame = normalizeFrame(probe('idle-after-command'));
    expect(CODEX_THINKING_PATTERN.test(frame.lastLines)).toBe(true);
    expect(CODEX_THINKING_PATTERN.test(frame.thinkingLines)).toBe(false);
    expect(CODEX_PROMPT_PATTERN.test(frame.lastLines)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A title moves no verdict — on untitled frames measured before 0.154, too.
// ---------------------------------------------------------------------------

describe('[#2818] appending a thread title to a measured untitled bar moves no verdict', () => {
  /**
   * Mutation, not measurement: real frames from 0.146.0 – 0.153.4 whose bar
   * ends in the path, with ` · Some thread title` appended to that one row.
   * Before #2818 five of these eight moved (the three idle ones and #2400's
   * just-submitted frame to `running`, #1890's multi-line residual to `ready`,
   * the steered one to `running`); now none does. The verdicts are the untitled
   * ones, known gaps included (`steer-queued-running` and
   * `turn-submitted-no-status` read `ready`; see the header).
   */
  const MEASURED: ReadonlyArray<readonly [string, string]> = [
    ['tests/fixtures/codex-live-2310/turn-running.txt', 'running/thinking_indicator/false'],
    ['tests/fixtures/codex-live-2310/steer-queued-running.txt', 'ready/input_prompt/false'],
    ['tests/fixtures/codex-live-2310/turn-submitted-no-status.txt', 'ready/input_prompt/false'],
    ['tests/unit/lib/detection/fixtures/codex-live-1628/working.txt', 'running/thinking_indicator/false'],
    ['tests/unit/lib/detection/fixtures/codex-live-1628/idle-ready.txt', 'ready/input_prompt/false'],
    ['tests/unit/lib/detection/fixtures/codex-live-1671/turn-running-command.txt', 'running/thinking_indicator/false'],
    ['tests/unit/lib/detection/fixtures/codex-live-1671/turn-complete-short-message.txt', 'ready/input_prompt/false'],
    ['tests/unit/lib/detection/fixtures/codex-live-1890/composer-residual-multiline.txt', 'running/thinking_indicator/false'],
  ];

  it.each(MEASURED)('%s → %s with or without a title', (path, verdict) => {
    const rows = stripAnsi(readRel(path)).split('\n');
    const bar = rows.findLastIndex(row => CODEX_STATUS_BAR_PATTERN.test(row));
    expect(bar).toBeGreaterThanOrEqual(0);
    expect(verdictOf(rows.join('\n'))).toBe(verdict);
    rows[bar] = `${rows[bar].trimEnd()} · Some thread title`;
    expect(CODEX_STATUS_BAR_PATTERN.test(rows[bar])).toBe(false);
    expect(CODEX_TRAILED_STATUS_BAR_PATTERN.test(rows[bar])).toBe(true);
    expect(verdictOf(rows.join('\n'))).toBe(verdict);
  });
});

// ---------------------------------------------------------------------------
// Every titled-bar frame in the tree.
// ---------------------------------------------------------------------------

describe('[#2818] the titled-bar frames already in the tree', () => {
  /**
   * `[path, verdict]` for every raw fixture whose last 10 non-blank rows carry
   * a bar only the trailed pattern accepts. Recorded before and after the
   * change: only the two idle frames with a `• Ran` in the tail moved
   * (`running/thinking_indicator` → `ready/input_prompt`); every other one
   * already read `ready` through the shared composer check and now reads the
   * same through branch 2.7's.
   */
  const CORPUS: ReadonlyArray<readonly [string, string]> = [
    ['tests/fixtures/agent-mode-2592/codex-default-thread-title.txt', 'ready/input_prompt/false'],
    ['tests/fixtures/agent-mode-2592/codex-plan-no-thread-title.txt', 'ready/input_prompt/false'],
    ['tests/fixtures/agent-mode-2592/codex-plan.txt', 'ready/input_prompt/false'],
    ['tests/fixtures/codex-dialogs-0155/idle-after-declined-approval.txt', 'ready/input_prompt/false'],
    ['tests/fixtures/codex-idle-composer-0155/idle-after-turn.txt', 'ready/input_prompt/false'],
    ['tests/fixtures/codex-thread-title-probe/idle-after-command.txt', 'ready/input_prompt/false'],
    ['tests/fixtures/codex-thread-title-probe/running-after-command.txt', 'running/thinking_indicator/false'],
    ['tests/fixtures/codex-thread-title-probe/running-in-command.txt', 'running/thinking_indicator/false'],
    ['tests/fixtures/long-body-2464/codex-idle.capture', 'ready/input_prompt/false'],
    ['tests/fixtures/long-body-2464/codex-pasted-content.capture', 'ready/input_prompt/false'],
    ['tests/fixtures/tui-frame-footer-2776/codex-0.155.1-idle-after-turn.txt', 'ready/input_prompt/false'],
    ['tests/fixtures/tui-frame-footer-2776/codex-0.155.1-idle-quoted-footers.txt', 'ready/input_prompt/false'],
    ['tests/unit/lib/detection/fixtures/codex-live-1671/reported-session-tail.txt', 'ready/input_prompt/false'],
  ];

  it.each(CORPUS)('%s → %s', (path, verdict) => {
    // A renamed or deleted fixture must fail here, not silently shrink the list.
    expect(existsSync(join(REPO_ROOT, path))).toBe(true);
    const frame = readRel(path);
    expect(trailedBarRow(stripAnsi(frame).split('\n'))).toBeGreaterThanOrEqual(0);
    expect(verdictOf(frame)).toBe(verdict);
    expect(verdictOf(stripAnsi(frame))).toBe(verdict);
  });

  /** Every `.txt` / `.capture` under a `fixtures` directory of `tests/`. */
  function rawFixtures(): string[] {
    const found: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(txt|capture)$/.test(entry) && /\/fixtures\//.test(path)) found.push(path);
      }
    };
    walk(join(REPO_ROOT, 'tests'));
    return found;
  }

  it('the title never moves a verdict, on any titled-bar frame the scan finds', () => {
    const titled = rawFixtures().flatMap(path => {
      const rows = stripAnsi(readFileSync(path, 'utf-8')).split('\n');
      const bar = trailedBarRow(rows);
      return bar < 0 ? [] : [{ path: relative(REPO_ROOT, path), rows, bar }];
    });
    // The scan must at least find the frames pinned above.
    expect(titled.map(t => t.path)).toEqual(expect.arrayContaining(CORPUS.map(([path]) => path)));
    for (const { path, rows, bar } of titled) {
      const before = verdictOf(rows.join('\n'));
      const untitled = [...rows];
      untitled[bar] = withoutTrailer(rows[bar]);
      expect(verdictOf(untitled.join('\n')), path).toBe(before);
    }
  });
});

// ---------------------------------------------------------------------------
// The pattern itself.
// ---------------------------------------------------------------------------

describe('[#2818] CODEX_TRAILED_STATUS_BAR_PATTERN', () => {
  it.each([
    '  gpt-5.6-terra low · /private/var/folders/xx/repo · Reply OK',
    '  gpt-6-astra xhigh · ~/uat3-20260916/sandbox-repo · Reply with one word',
    '  gpt-6-astra medium · ~/uat3-20260916/sandbox-repo                    Plan mode (shift+tab to cycle)',
  ])('accepts %j', row => {
    expect(CODEX_TRAILED_STATUS_BAR_PATTERN.test(row)).toBe(true);
  });

  it.each([
    // The untitled bar is the other pattern's.
    '  gpt-5.6-terra low · /private/var/folders/xx/repo',
    // codex's in-flight row: its first `·` is followed by a count, not a path.
    '• Working (16s • esc to interrupt) · 1 background terminal running · /ps to view · /stop to close',
    // A path followed by one space and prose is not a bar.
    '  gpt-6 high · ~/repo then some prose',
    // Transcript rows the thinking pattern reads.
    '• Ran sleep 30',
    '  └ (no output)',
    '› Ask Codex to do anything',
  ])('declines %j', row => {
    expect(CODEX_TRAILED_STATUS_BAR_PATTERN.test(row)).toBe(false);
  });

  it('is stateless (no /g) and single-line (no /m)', () => {
    expect(CODEX_TRAILED_STATUS_BAR_PATTERN.global).toBe(false);
    expect(CODEX_TRAILED_STATUS_BAR_PATTERN.multiline).toBe(false);
  });
});
