/**
 * Issue #2070 — "the session is there, the TOOL is not", over REAL frames.
 *
 * The rule is a conjunction (`judgeToolLiveness`): none of the tool's own alive
 * patterns matches the bottom of the frame, AND the last content row positively
 * reads as a shell prompt. Both halves are pinned here against panes captured
 * live on 2026-08-31 at the production 200x1000 geometry — see
 * `tests/fixtures/tool-liveness-2070/README.md` for how.
 *
 * The acceptance condition this file exists for is the NEGATIVE one: a TUI that
 * draws `❯` or `>` in its composer must never be read as a shell. So every
 * "the tool is up" frame is run against EVERY tool's spec, not just its own.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  judgeToolLiveness,
  findFatalPattern,
  MAX_SHELL_PROMPT_LENGTH,
  SHELL_PROMPT_ENDINGS,
} from '@/lib/detection/tool-liveness';
import { STATUS_REASON } from '@/lib/detection/status-reason';
import { EXITED_STATUS_REASON } from '@/types/sidebar';
import { resolveLivenessSpec } from '@/lib/cli-tools/liveness-spec';
import { CLI_TOOL_IDS, type CLIToolType } from '@/lib/cli-tools/types';

const FIXTURES = path.join(process.cwd(), 'tests/fixtures/tool-liveness-2070');
const frame = (name: string): string =>
  fs.readFileSync(path.join(FIXTURES, `${name}.txt`), 'utf-8');

/** Panes the tool still owns. None of these may EVER be read as a shell. */
const ALIVE_FRAMES: ReadonlyArray<{ tool: CLIToolType; file: string; what: string }> = [
  { tool: 'claude', file: 'claude-ready-21251', what: 'claude 2.1.251 idle composer (❯)' },
  { tool: 'codex', file: 'codex-ready-01491', what: 'codex 0.149.1 idle composer (›)' },
  { tool: 'codex', file: 'codex-trust-dialog-01491', what: 'codex 0.149.1 trust dialog' },
  { tool: 'copilot', file: 'copilot-ready-1080', what: 'copilot 1.0.80 idle composer (❯)' },
  { tool: 'opencode', file: 'opencode-ready-11823', what: 'opencode 1.18.23 home composer' },
  { tool: 'gemini', file: 'gemini-dialog-0551', what: 'gemini 0.55.1 sign-in dialog' },
];

/** Panes the tool has left behind — a bare zsh prompt on the last row. */
const EXITED_FRAMES: ReadonlyArray<{ tool: CLIToolType; file: string }> = [
  { tool: 'claude', file: 'claude-exited-21251' },
  { tool: 'codex', file: 'codex-exited-01491' },
  { tool: 'copilot', file: 'copilot-exited-1080' },
  { tool: 'opencode', file: 'opencode-exited-11823' },
  { tool: 'gemini', file: 'gemini-exited-0551' },
];

describe('[#2070] judgeToolLiveness over live frames', () => {
  describe('a pane the tool still owns is never called exited', () => {
    for (const { tool, file, what } of ALIVE_FRAMES) {
      it(`${what} is alive under its own spec`, () => {
        expect(judgeToolLiveness(frame(file), resolveLivenessSpec(tool))).toEqual({ alive: true });
      });
    }

    // The acceptance condition, stated as the cross product: `❯` / `>` / `›`
    // composers belong to claude, copilot, gemini and codex, and every one of
    // those glyphs is ALSO something a shell prompt theme draws. A spec that
    // read one as "the shell" would relaunch a tool into its own live pane.
    for (const { file, what } of ALIVE_FRAMES) {
      for (const tool of CLI_TOOL_IDS) {
        it(`${what} is not read as a shell by the ${tool} spec`, () => {
          expect(judgeToolLiveness(frame(file), resolveLivenessSpec(tool)).alive).toBe(true);
        });
      }
    }
  });

  describe('a pane that fell back to the shell is caught', () => {
    for (const { tool, file } of EXITED_FRAMES) {
      it(`${tool}: ${file}`, () => {
        const verdict = judgeToolLiveness(frame(file), resolveLivenessSpec(tool));
        expect(verdict.alive).toBe(false);
        expect(verdict.alive === false && verdict.reason).toMatch(/shell prompt/);
      });
    }
  });
});

describe('[#2070] the two fields that make the codex verdict possible', () => {
  // Neither of these is decoration, and a green test that did not check them
  // would pass with the rule silently reverted to claude's.
  const codexExited = frame('codex-exited-01491');
  const codexSpec = resolveLivenessSpec('codex');

  it('WOULD be missed if the alive check read the whole frame, not a tail window', () => {
    // codex 0.149.1 leaves `› 1. Yes, continue` from its trust dialog roughly a
    // thousand rows above the shell prompt. A whole-frame `^›` test finds it and
    // reports a dead session as alive — forever.
    expect(judgeToolLiveness(codexExited, { ...codexSpec, aliveTailLines: null })).toEqual({
      alive: true,
    });
  });

  it('WOULD be missed by the length gate alone — the prompt is exactly 40 chars', () => {
    const lastRow = codexExited
      .trim()
      .split('\n')
      .filter((l) => l.trim() !== '')
      .at(-1)!
      .trim();
    expect(lastRow).toHaveLength(MAX_SHELL_PROMPT_LENGTH);
    expect(judgeToolLiveness(codexExited, { ...codexSpec, shellPromptPatterns: [] })).toEqual({
      alive: true,
    });
  });
});

describe('[#2070] claude keeps every verdict it had (受入条件)', () => {
  const claude = resolveLivenessSpec('claude');

  it('an empty pane is unhealthy, and says so in the same words', () => {
    expect(judgeToolLiveness('', claude)).toEqual({ alive: false, reason: 'empty output' });
  });

  it('a start error in the tail is unhealthy', () => {
    const verdict = judgeToolLiveness(
      'some scrollback\nClaude Code cannot be launched inside another Claude Code session\n',
      claude
    );
    expect(verdict).toEqual({
      alive: false,
      reason: 'error pattern: Claude Code cannot be launched inside another Claude Code session',
    });
  });

  it('a live composer wins over an error that has already scrolled past', () => {
    expect(
      judgeToolLiveness('Error: Claude Code blew up\n' + 'x\n'.repeat(20) + '❯ \n', claude)
    ).toEqual({ alive: true });
  });

  it('keeps the auto-compact percentage carve-out', () => {
    expect(judgeToolLiveness('Context left until auto-compact: 7%', claude)).toEqual({
      alive: true,
    });
  });

  it('keeps the 40-character gate', () => {
    const long = 'x'.repeat(MAX_SHELL_PROMPT_LENGTH) + '$';
    expect(judgeToolLiveness(long, claude)).toEqual({ alive: true });
    expect(judgeToolLiveness('host $', claude).alive).toBe(false);
  });

  it('declares NONE of the three fields the added tools take', () => {
    expect(claude.aliveTailLines).toBeNull();
    expect(claude.shellPromptPatterns).toEqual([]);
    expect(claude.unreadableIsExited).toBe(true);
  });
});

describe('[#2070] an unreadable frame is not evidence of an exit', () => {
  it('is alive for every tool this Issue added — a relaunch hangs off this', () => {
    for (const tool of CLI_TOOL_IDS) {
      if (tool === 'claude') continue;
      expect(judgeToolLiveness('', resolveLivenessSpec(tool))).toEqual({ alive: true });
      expect(judgeToolLiveness('   \n\n  ', resolveLivenessSpec(tool))).toEqual({ alive: true });
    }
  });
});

describe('[#2070] the declaration table', () => {
  it('answers for every CLI tool, with the shared shell rule intact', () => {
    for (const tool of CLI_TOOL_IDS) {
      const spec = resolveLivenessSpec(tool);
      expect(spec.alivePatterns.length).toBeGreaterThan(0);
      expect(spec.shellPromptEndings).toEqual(SHELL_PROMPT_ENDINGS);
      expect(spec.maxShellPromptLength).toBe(MAX_SHELL_PROMPT_LENGTH);
      expect(spec.probeCaptureLines).toBeGreaterThan(0);
    }
  });

  it('carries claude fatal patterns for claude and for nobody else', () => {
    expect(resolveLivenessSpec('claude').fatalPatterns.length).toBeGreaterThan(0);
    for (const tool of CLI_TOOL_IDS) {
      if (tool === 'claude') continue;
      expect(resolveLivenessSpec(tool).fatalPatterns).toEqual([]);
      expect(resolveLivenessSpec(tool).fatalRegexPatterns).toEqual([]);
    }
  });

  it('findFatalPattern only reads the tail, so a recovered session survives', () => {
    const claude = resolveLivenessSpec('claude');
    const scrolledPast =
      'Claude Code cannot be launched inside another Claude Code session\n' + 'x\n'.repeat(20);
    expect(findFatalPattern(scrolledPast, claude)).toBeNull();
  });
});

describe('[#2070] the reason token is one token', () => {
  it('the sidebar restatement equals the detector vocabulary', () => {
    expect(EXITED_STATUS_REASON).toBe(STATUS_REASON.EXITED);
    expect(STATUS_REASON.EXITED).toBe('exited');
  });
});
