/**
 * The 別表: every frame that publishes `isUnclassifiedActive: true`
 * (Issue #1928, 方針書 §4 D1 決定 2 / DR2-001 / §11).
 *
 * §4 D1 決定 2 is explicit about what may and may not be pinned here:
 *
 *  - the `no_recent_output` and `default` routes keep their truth value, and the
 *    existing fixtures pin that equivalence;
 *  - the `input_prompt` route does NOT. It is `false` for every frame today and
 *    the rollout deliberately widens it, so **an equivalence pin there would
 *    fail by design**. What DR2-001 asks for instead is a table: the frames that
 *    newly answer `true`, enumerated by name.
 *
 * This is that table. It is pinned by equality of the whole list rather than by
 * spot checks, so a rollout step that widens the set has to edit this file — the
 * point being that the widening is visible in a diff and not discovered in
 * production when `TerminalEscapeHatch` starts opening on ordinary idle frames.
 *
 * ## The measurement this file records
 *
 * Across every live capture in the repository, **no frame reaches
 * `input_prompt` with no evidence**. The `evidence: 'none'` set is exactly six
 * opencode frames, all of them on the `unknown_frame` floor — which was
 * `default` (and therefore already `true`) before #1927. So the widening
 * §6.1 row (2) authorises has, as of this branch, no live-capture membership at
 * all; the second table below shows what it WOULD catch, by taking the evidence
 * off a real capture.
 *
 * The verdict pinned is the MERGED one (DR2-003): `mergeStructuredStatus` can
 * clear the flag, and a scraper-only pin cannot see that.
 *
 * @vitest-environment node
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripAnsi } from '@/lib/detection/cli-patterns';
import {
  detectSessionStatus,
  isGeneratingStatus,
  STATUS_REASON,
} from '@/lib/detection/status-detector';
import { mergeStructuredStatus } from '@/lib/session/current-output-builder';
import type { CLIToolType } from '@/lib/cli-tools/types';

const LIVE_FIXTURES = path.resolve(__dirname, '../../lib/detection/fixtures');
const CLAUDE_1927_FIXTURES = path.resolve(__dirname, 'claude/fixtures');

/** Which tool a live fixture directory belongs to, from its name. */
const TOOL_BY_PREFIX: Readonly<Record<string, CLIToolType>> = {
  claude: 'claude',
  codex: 'codex',
  copilot: 'copilot',
  opencode: 'opencode',
};

/**
 * `isUnclassifiedActive` exactly as `buildCurrentOutput` computes it, minus the
 * structured layer (no hooks fire in a fixture, so `getStructuredSessionState`
 * would answer null and the merge returns the scraper untouched).
 */
function unclassifiedOf(raw: string, tool: CLIToolType): {
  isUnclassifiedActive: boolean;
  status: string;
  reason: string;
} {
  const scraper = detectSessionStatus(raw, tool);
  const merged = mergeStructuredStatus(
    {
      status: scraper.status,
      reason: scraper.reason,
      thinking: isGeneratingStatus({ status: scraper.status, reason: scraper.reason }),
      evidence: scraper.evidence,
      isUnclassifiedActive: scraper.evidence === 'none',
    },
    null,
  );
  return {
    isUnclassifiedActive: merged.isUnclassifiedActive,
    status: merged.status,
    reason: merged.reason,
  };
}

interface CorpusFrame {
  id: string;
  tool: CLIToolType;
  raw: string;
}

/** Every live capture in the repository, with the tool it was taken from. */
function readCorpus(): CorpusFrame[] {
  const frames: CorpusFrame[] = [];
  for (const dir of readdirSync(LIVE_FIXTURES).sort()) {
    const tool = TOOL_BY_PREFIX[dir.split('-')[0]];
    if (!tool) continue;
    for (const file of readdirSync(path.join(LIVE_FIXTURES, dir)).sort()) {
      if (!file.endsWith('.txt')) continue;
      frames.push({
        id: `${dir}/${file}`,
        tool,
        raw: readFileSync(path.join(LIVE_FIXTURES, dir, file), 'utf8'),
      });
    }
  }
  for (const file of readdirSync(CLAUDE_1927_FIXTURES).sort()) {
    if (!file.endsWith('.txt')) continue;
    frames.push({
      id: `claude-1927/${file}`,
      tool: 'claude',
      raw: readFileSync(path.join(CLAUDE_1927_FIXTURES, file), 'utf8'),
    });
  }
  return frames;
}

/**
 * The table. Every live capture whose merged verdict carries no evidence.
 *
 * All six are opencode frames on the `unknown_frame` floor: a composer holding
 * residual text with no finished-turn marker above it (#1883), an aborted turn
 * whose `▣ Build` row has no duration (#1893), the pane after the first of two
 * Escapes (#1894), the ctrl+p palette and a composer with a typed `1.` (#1896),
 * and a pending multi-line composer (#1906). Each is a frame opencode's own
 * rules looked at and could not read, which is what `unknown_frame` says.
 */
const UNCLASSIFIED_LIVE_FRAMES: readonly string[] = [
  'opencode-live-1883/composer-residual.txt',
  'opencode-live-1893/turn-aborted-no-duration.txt',
  'opencode-live-1894/double-esc-interrupted.txt',
  'opencode-live-1896/command-palette.txt',
  'opencode-live-1896/composer-typed-numbered.txt',
  'opencode-live-1906/composer-multiline-pending.txt',
];

describe('[#1928] the 別表 of frames with no evidence', () => {
  const corpus = readCorpus();

  it('reads a corpus at all, so an empty table cannot pass by accident', () => {
    expect(corpus.length).toBeGreaterThan(50);
  });

  it('lists exactly the frames whose merged verdict carries no evidence', () => {
    const observed = corpus
      .filter(({ raw, tool }) => unclassifiedOf(raw, tool).isUnclassifiedActive)
      .map(({ id }) => id);

    expect(observed).toEqual([...UNCLASSIFIED_LIVE_FRAMES]);
  });

  it.each(UNCLASSIFIED_LIVE_FRAMES)('%s is on the unknown_frame floor, not the idle route', id => {
    // The distinction DR2-001 turns on. These six were `running`/`default`
    // before #1927 and therefore already `true`, so they are NOT part of the
    // intentional widening — they are the equivalence half of the table.
    const entry = corpus.find(f => f.id === id);
    expect(entry, id).toBeDefined();

    const verdict = unclassifiedOf(entry!.raw, entry!.tool);
    expect(verdict.status).toBe('running');
    expect(verdict.reason).toBe(STATUS_REASON.UNKNOWN_FRAME);
  });

  it('has no live capture on the input_prompt route — the widening is empty today', () => {
    // Stated as a measurement rather than left implicit. When a tool's rollout
    // starts catching real frames, this expectation is where it shows up, and
    // the entry belongs in the table above with an explanation.
    const onIdleRoute = corpus.filter(({ raw, tool }) => {
      const verdict = unclassifiedOf(raw, tool);
      return verdict.isUnclassifiedActive && verdict.reason === STATUS_REASON.INPUT_PROMPT;
    });

    expect(onIdleRoute.map(f => f.id)).toEqual([]);
  });
});

describe('[#1928] what the input_prompt widening WOULD catch', () => {
  /**
   * A live claude capture with its completion marker reworded by one word.
   *
   * `✻ Brewed for 14s` is claude's measured turn-completion marker and the only
   * thing on this frame that says the turn is over; `✻ Brewed in 14s` is the
   * same row with the duration preposition changed, which is what a build of
   * claude that spells its marker differently would look like. The composer is
   * still on screen, so the frame still publishes `ready`/`input_prompt` — and
   * that is the point: the STATUS is unchanged (DR3-002 keeps the wire value)
   * and only the evidence moves.
   */
  function withoutCompletionMarker(raw: string): string {
    const rows = raw.split('\n');
    // The LAST marker, not the first: a multi-turn transcript carries one per
    // finished turn, and only the bottom-most is the transcript tail
    // `readIdleEvidence` reads. Mutating an earlier one changes nothing, which
    // would make this whole demonstration vacuous while staying green.
    let index = -1;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (/^\s*✻\s+\S+\s+for\s+\d/.test(stripAnsi(rows[i]))) {
        index = i;
        break;
      }
    }
    if (index < 0) throw new Error('fixture carries no claude completion marker');
    rows[index] = rows[index].replace(' for ', ' in ');
    return rows.join('\n');
  }

  const CLAUDE_IDLE_FIXTURE = path.join(CLAUDE_1927_FIXTURES, 'turn-complete-auto.txt');

  it('turns an ordinary idle claude frame into an unclassified one', () => {
    const raw = readFileSync(CLAUDE_IDLE_FIXTURE, 'utf8');
    const mutated = withoutCompletionMarker(raw);
    expect(mutated).not.toBe(raw);

    const before = unclassifiedOf(raw, 'claude');
    expect(before.reason).toBe(STATUS_REASON.INPUT_PROMPT);
    expect(before.isUnclassifiedActive).toBe(false);

    const after = unclassifiedOf(mutated, 'claude');
    expect(after.status).toBe('ready');
    expect(after.reason).toBe(STATUS_REASON.INPUT_PROMPT);
    expect(after.isUnclassifiedActive).toBe(true);
  });

  it('is the only route that can widen: copilot and opencode fall to the floor instead', () => {
    // Both opt out of the generic composer check, so a frame their rules cannot
    // vouch for never reaches `input_prompt` at all — it lands on
    // `unknown_frame`. Recorded here so a later reader does not go looking for a
    // copilot entry in the table above.
    const copilotIdle = readFileSync(
      path.join(LIVE_FIXTURES, 'copilot-live-1885', 'boot-idle.txt'),
      'utf8',
    );
    const rows = copilotIdle.split('\n');
    let bar = -1;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (/\/\s+commands\b/.test(stripAnsi(rows[i]))) {
        bar = i;
        break;
      }
    }
    expect(bar, 'fixture carries no copilot idle status bar').toBeGreaterThanOrEqual(0);
    // Both halves of COPILOT_IDLE_STATUS_PATTERN sit on this one row, so a
    // single-word edit leaves the other matching and the bar still reads idle.
    // Word by word, not phrase by phrase: copilot colours `?` and `help` in
    // separate SGR runs, so `'? help'` is a silent no-op on a real capture.
    rows[bar] = rows[bar].replace('commands', 'incantations').replace('help', 'aid');

    const verdict = unclassifiedOf(rows.join('\n'), 'copilot');
    expect(verdict.isUnclassifiedActive).toBe(true);
    expect(verdict.reason).toBe(STATUS_REASON.UNKNOWN_FRAME);
  });
});
