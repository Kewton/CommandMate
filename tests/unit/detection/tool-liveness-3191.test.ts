/**
 * Issue #3191 — claude `/exit`ed into a shell prompt of 41+ characters stayed
 * `running`.
 *
 * #2070 gave every added tool the positive `user@host …` line patterns and left
 * claude on the 40-character endings rule alone. A prompt such as
 * `maenokota@MAENOnoMac-Studio uat-repo-wt2 %` (42 characters) is past that
 * gate, so the pane read as claude and the next send timed out in
 * `waitForPrompt`. claude now takes `SHELL_PROMPT_LINE_PATTERNS` too.
 *
 * The half of this file that matters most is the NEGATIVE one, in the same
 * shape as `tool-liveness-2070.test.ts`: a claude screen misread as the shell
 * puts a relaunch into a live pane, so every claude screen fixture in the
 * repository is swept row by row against the patterns.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  judgeToolLiveness,
  findShellPromptTail,
  MAX_SHELL_PROMPT_LENGTH,
  SHELL_PROMPT_LINE_PATTERNS,
} from '@/lib/detection/tool-liveness';
import { stripAnsi } from '@/lib/detection/ansi';
import { resolveLivenessSpec } from '@/lib/cli-tools/liveness-spec';
import { buildClaudeIdleComposerFrame } from '../../fixtures/claude-idle-composer';
import { buildClaudeHelpOverlayFrame } from '../../fixtures/claude-help-overlay';
import { buildClaude1000RowPermissionFrame } from '../../fixtures/claude-1000-row-prompt';
import { CLAUDE_MODEL_OVERLAY_V2_1_218 } from '../../fixtures/claude-model-overlay';

const ROOT = process.cwd();
const claude = resolveLivenessSpec('claude');
/** claude's spec as #2070 left it, for the "nothing else moved" comparisons. */
const claudeBefore = { ...claude, shellPromptPatterns: [] as readonly RegExp[] };

const exitedFrame = fs.readFileSync(
  path.join(ROOT, 'tests/fixtures/tool-liveness-2070/claude-exited-21251.txt'),
  'utf-8'
);

/** The #2070 claude exit frame with its bottom row replaced by `prompt`. */
function withPrompt(prompt: string): string {
  const rows = exitedFrame.trimEnd().split('\n');
  rows[rows.length - 1] = prompt;
  return rows.join('\n') + '\n';
}

/** Pad a `user@host <dir> %` prompt to exactly `length` characters. */
function zshPrompt(length: number): string {
  const head = 'maenokota@MAENOnoMac-Studio ';
  const dir = 'd'.repeat(length - head.length - 2);
  return `${head}${dir} %`;
}

function bashPrompt(length: number): string {
  const head = 'maenokota@MAENOnoMac-Studio:~/';
  const dir = 'd'.repeat(length - head.length - 1);
  return `${head}${dir}$`;
}

describe('[#3191] a claude that fell back to a long shell prompt is unhealthy', () => {
  const measured = [
    'maenokota@MAENOnoMac-Studio uat-repo-wt2 %',
    'maenokota@MAENOnoMac-Studio MyCodeBranchDesk %',
  ];

  it('the measured prompts are past the 40-character gate', () => {
    expect(measured.map((p) => p.length)).toEqual([42, 46]);
    for (const p of measured) expect(p.length).toBeGreaterThan(MAX_SHELL_PROMPT_LENGTH);
  });

  for (const prompt of measured) {
    it(`${prompt.length} chars: ${prompt}`, () => {
      const verdict = judgeToolLiveness(withPrompt(prompt), claude);
      expect(verdict).toEqual({ alive: false, reason: `shell prompt detected: ${prompt}` });
      // ...and #2070's claude spec is exactly what missed it.
      expect(judgeToolLiveness(withPrompt(prompt), claudeBefore)).toEqual({ alive: true });
    });
  }

  for (const length of [41, 42, 46, 80]) {
    it(`zsh prompt of ${length} chars`, () => {
      const prompt = zshPrompt(length);
      expect(prompt).toHaveLength(length);
      expect(judgeToolLiveness(withPrompt(prompt), claude).alive).toBe(false);
    });

    it(`bash prompt of ${length} chars`, () => {
      const prompt = bashPrompt(length);
      expect(prompt).toHaveLength(length);
      expect(judgeToolLiveness(withPrompt(prompt), claude).alive).toBe(false);
    });

    it(`RHEL-style bash prompt of ${length} chars`, () => {
      const prompt = `[maenokota@MAENOnoMac-Studio ${'d'.repeat(length - 31)}]$`;
      expect(prompt).toHaveLength(length);
      expect(judgeToolLiveness(withPrompt(prompt), claude).alive).toBe(false);
    });
  }

  it('a long line that is not `user@host …` is still past the gate (alive)', () => {
    expect(judgeToolLiveness('x'.repeat(60) + ' %', claude)).toEqual({ alive: true });
    expect(judgeToolLiveness('The total for the twelve items listed above comes to $', claude)).toEqual({ alive: true });
  });
});

describe('[#3191] the 40-and-under verdicts are unchanged', () => {
  const short = [
    'user@host%',
    'host $',
    'user@host:~$',
    'maenokota@MAENOnoMac-Studio uat-repo %',
    'a'.repeat(38) + '$',
    'a'.repeat(39) + '$',
    'Context left until auto-compact: 7%',
    'Some Claude output',
  ];
  for (const line of short) {
    it(`${line.length} chars: ${line}`, () => {
      expect(judgeToolLiveness(line, claude).alive).toBe(
        judgeToolLiveness(line, claudeBefore).alive
      );
    });
  }

  it('the 38-char measured prompt is still caught', () => {
    expect(judgeToolLiveness(withPrompt('maenokota@MAENOnoMac-Studio uat-repo %'), claude).alive)
      .toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Negative control: every claude screen in the repository.
// ---------------------------------------------------------------------------

function walk(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

/** Verbatim claude pane captures (`.txt`). Non-claude captures filed alongside are skipped. */
const CLAUDE_SCREEN_FILES: readonly string[] = [
  ...fs
    .readdirSync(path.join(ROOT, 'tests/fixtures'))
    .filter((n) => n.startsWith('claude-'))
    .map((n) => path.join(ROOT, 'tests/fixtures', n))
    .filter((p) => fs.statSync(p).isDirectory())
    .flatMap(walk),
  ...walk(path.join(ROOT, 'tests/unit/detection/tools/claude/fixtures')),
  path.join(ROOT, 'tests/fixtures/tool-liveness-2070/claude-ready-21251.txt'),
]
  .filter((f) => f.endsWith('.txt'))
  .filter((f) => !path.basename(f).startsWith('codex-'))
  .sort();

/** The `tests/fixtures/claude-*.ts` builders and constants. */
const CLAUDE_SCREEN_BUILDERS: ReadonlyArray<{ name: string; frame: string }> = [
  { name: 'claude-idle-composer.ts', frame: buildClaudeIdleComposerFrame() },
  { name: 'claude-help-overlay.ts', frame: buildClaudeHelpOverlayFrame() },
  { name: 'claude-1000-row-prompt.ts', frame: buildClaude1000RowPermissionFrame() },
  { name: 'claude-model-overlay.ts', frame: CLAUDE_MODEL_OVERLAY_V2_1_218 },
];

const ALL_SCREENS: ReadonlyArray<{ name: string; frame: string }> = [
  ...CLAUDE_SCREEN_FILES.map((f) => ({
    name: path.relative(ROOT, f),
    frame: fs.readFileSync(f, 'utf-8'),
  })),
  ...CLAUDE_SCREEN_BUILDERS,
];

describe('[#3191] no claude screen is read as the shell (陰性対照・全走査)', () => {
  it('the sweep actually found the fixtures', () => {
    // Guards against a path change silently turning the sweep into a no-op.
    expect(CLAUDE_SCREEN_FILES.length).toBeGreaterThanOrEqual(50);
  });

  it('NO row of any claude screen matches a `user@host …` pattern', () => {
    // Stricter than the verdict: not just the bottom row, every row — a
    // composer, transcript, dialog or picker row that matched would be one
    // scroll away from being the bottom row of a frame without the composer.
    const hits: string[] = [];
    for (const { name, frame } of ALL_SCREENS) {
      stripAnsi(frame)
        .split('\n')
        .forEach((row, i) => {
          const line = row.trim();
          if (SHELL_PROMPT_LINE_PATTERNS.some((p) => p.test(line))) {
            hits.push(`${name}:${i + 1}: ${line}`);
          }
        });
    }
    expect(hits).toEqual([]);
  });

  for (const { name, frame } of ALL_SCREENS) {
    it(`${name} is healthy under claude's spec`, () => {
      expect(judgeToolLiveness(frame, claude)).toEqual({ alive: true });
    });

    it(`${name}: the bottom row is not a prompt even with the composer veto removed`, () => {
      // Without `alivePatterns` the verdict comes down to steps 3-7 alone, which
      // is exactly where the new patterns act. They must add no exit.
      const noVeto = { ...claude, alivePatterns: [] };
      expect(findShellPromptTail(stripAnsi(frame), noVeto)?.via).not.toBe('pattern');
      expect(judgeToolLiveness(frame, noVeto)).toEqual(
        judgeToolLiveness(frame, { ...claudeBefore, alivePatterns: [] })
      );
    });
  }
});
