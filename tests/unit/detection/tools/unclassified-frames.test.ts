/**
 * The 別表: every frame that publishes `isUnclassifiedActive: true`
 * (Issue #1928, 方針書 §4 D1 決定 2 / DR2-001 / §11; corrected by #2011).
 *
 * The flag means "no rule could read this frame", and the table below is the
 * complete list of live captures in this repository that answer `true`. It is
 * pinned by equality of the whole list rather than by spot checks, so anything
 * that widens the set has to edit this file — the point being that a widening is
 * visible in a diff and not discovered in production when `TerminalEscapeHatch`
 * starts opening on ordinary idle frames. Which is exactly what happened: #1927
 * widened it by deriving the flag from `statusEvidence`, no equality pin covered
 * the route it widened, and every idle Claude pane opened the hatch (#2011).
 *
 * ## What #2011 changed about this file
 *
 * The `input_prompt` route does NOT widen the flag, and the second describe
 * below now pins that. `statusEvidence` widens; the flag does not, because a
 * composer row an idle rule declined to vouch for is a frame that was READ. The
 * two questions are separated in `status-evidence.ts`.
 *
 * The verdict pinned is the MERGED one (DR2-003): `mergeStructuredStatus` sees
 * the structured layer, and a scraper-only pin cannot see what it does.
 *
 * @vitest-environment node
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { IDLE_EVIDENCE_ENV_VAR } from '@/config/detection-evidence-config';
import { stripAnsi } from '@/lib/detection/cli-patterns';
import {
  detectSessionStatus,
  isGeneratingStatus,
  STATUS_REASON,
} from '@/lib/detection/status-detector';
import { mergeStructuredStatus } from '@/lib/session/current-output-builder';
import { isUnclassifiedFrame } from '@/lib/session/status-evidence';
import type { CLIToolType } from '@/lib/cli-tools/types';

afterEach(() => {
  delete process.env[IDLE_EVIDENCE_ENV_VAR];
});

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
  evidence: string;
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
      // Issue #2011: the builder's expression, which is no longer
      // `evidence === 'none'`. Calling the shared predicate rather than
      // restating it is deliberate — a copy here would agree with a copy in the
      // builder that had drifted the same way.
      isUnclassifiedActive: isUnclassifiedFrame(scraper.status, scraper.reason),
    },
    null,
  );
  return {
    isUnclassifiedActive: merged.isUnclassifiedActive,
    evidence: merged.evidence,
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
 * The table. Every live capture whose merged verdict is an unclassified frame.
 *
 * The Claude entry is #2011's positive control: a verbatim capture of the
 * `/help` overlay, which hides the composer entirely and so reaches the
 * `default` floor. It is what makes the rest of this Issue's fixtures mean
 * something — five of them are idle Claude panes captured minutes apart from the
 * same session, and a change that made the flag `false` everywhere would satisfy
 * every one of those while breaking the hatch this row protects.
 *
 * The six opencode entries are on the `unknown_frame` floor: a composer holding
 * residual text with no finished-turn marker above it (#1883), an aborted turn
 * whose `▣ Build` row has no duration (#1893), the pane after the first of two
 * Escapes (#1894), the ctrl+p palette and a composer with a typed `1.` (#1896),
 * and a pending multi-line composer (#1906). Each is a frame opencode's own
 * rules looked at and could not read, which is what `unknown_frame` says.
 */
const UNCLASSIFIED_LIVE_FRAMES: readonly string[] = [
  'claude-live-2011/help-overlay.txt',
  'opencode-live-1883/composer-residual.txt',
  'opencode-live-1893/turn-aborted-no-duration.txt',
  'opencode-live-1894/double-esc-interrupted.txt',
  'opencode-live-1896/command-palette.txt',
  'opencode-live-1896/composer-typed-numbered.txt',
  'opencode-live-1906/composer-multiline-pending.txt',
];

/** The floors an entry in the table above is allowed to be sitting on. */
const FLOOR_REASONS: readonly string[] = [STATUS_REASON.UNKNOWN_FRAME, STATUS_REASON.DEFAULT];

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

  it.each(UNCLASSIFIED_LIVE_FRAMES)('%s is on a detection floor, not the idle route', id => {
    // The distinction DR2-001 turns on: every entry got here because no rule
    // could read it, never because a rule read it and declined to vouch.
    const entry = corpus.find(f => f.id === id);
    expect(entry, id).toBeDefined();

    const verdict = unclassifiedOf(entry!.raw, entry!.tool);
    expect(verdict.status).toBe('running');
    expect(FLOOR_REASONS, id).toContain(verdict.reason);
  });

  it('never puts the input_prompt route on the table, whatever the rollout says', () => {
    // The pin #1927 was missing. `enforce` on every tool at once is the widest
    // the evidence rollout can ever be, and even then no composer frame may
    // reach this table: `input_prompt` means the frame WAS read.
    process.env[IDLE_EVIDENCE_ENV_VAR] = '*=enforce';

    const onIdleRoute = corpus.filter(({ raw, tool }) => {
      const verdict = unclassifiedOf(raw, tool);
      return verdict.isUnclassifiedActive && verdict.reason === STATUS_REASON.INPUT_PROMPT;
    });

    expect(onIdleRoute.map(f => f.id)).toEqual([]);
  });

  it('has live captures the evidence rollout takes the proof off, and keeps them classified', () => {
    // The measurement #2011 recorded: with every tool enforcing, the corpus DOES
    // contain composer frames with no evidence — the five idle Claude panes
    // captured for this Issue. Under #1927's derivation all five were
    // `isUnclassifiedActive: true`, which is the production incident. The count
    // is asserted so this cannot silently become "no such frames exist" and make
    // the pin above vacuous.
    process.env[IDLE_EVIDENCE_ENV_VAR] = '*=enforce';

    const unproven = corpus.filter(({ raw, tool }) => {
      const verdict = unclassifiedOf(raw, tool);
      return verdict.reason === STATUS_REASON.INPUT_PROMPT && verdict.evidence === 'none';
    });

    expect(unproven.map(f => f.id)).toEqual([
      'claude-live-2011/idle-tail-command-result.txt',
      'claude-live-2011/idle-tail-model-saved.txt',
      'claude-live-2011/idle-tail-new-task-clear.txt',
      'claude-live-2011/idle-tail-tip-memory.txt',
      'claude-live-2011/idle-tail-update-installed.txt',
    ]);
    for (const frame of unproven) {
      expect(unclassifiedOf(frame.raw, frame.tool).isUnclassifiedActive, frame.id).toBe(false);
    }
  });
});

describe('[#2011] the input_prompt route moves evidence, never the flag', () => {
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

  it('takes the evidence off an ordinary idle claude frame and leaves it classified', () => {
    process.env[IDLE_EVIDENCE_ENV_VAR] = 'claude=enforce';
    const raw = readFileSync(CLAUDE_IDLE_FIXTURE, 'utf8');
    const mutated = withoutCompletionMarker(raw);
    expect(mutated).not.toBe(raw);

    const before = unclassifiedOf(raw, 'claude');
    expect(before.reason).toBe(STATUS_REASON.INPUT_PROMPT);
    expect(before.evidence).toBe('positive');
    expect(before.isUnclassifiedActive).toBe(false);

    // Issue #1927 made the SECOND assertion below `true`, and with it every idle
    // Claude pane on develop. The frame did not become unreadable: the composer
    // is still on screen, still the row the verdict was read from, and a human
    // can still type into it. What the rewording removed is the PROOF that the
    // turn is over — which is what `statusEvidence` is for.
    const after = unclassifiedOf(mutated, 'claude');
    expect(after.status).toBe('ready');
    expect(after.reason).toBe(STATUS_REASON.INPUT_PROMPT);
    expect(after.evidence).toBe('none');
    expect(after.isUnclassifiedActive).toBe(false);
  });

  it('is not the route to the floor at all: copilot and opencode fall there instead', () => {
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
    // …and this is the shape that legitimately raises the flag: a tool whose own
    // rules are the only rules that run for it, reporting that they read
    // nothing. Not "a rule read the frame and declined to vouch for it".
  });
});
