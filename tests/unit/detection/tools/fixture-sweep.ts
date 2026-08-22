/**
 * The per-tool fixture sweep §11 makes an acceptance condition (Issue #1927).
 *
 * 方針書 §11's scraper row asks for one thing per tool: a walk over every
 * fixture, with **a "processing vocabulary reworded by one word → evidence
 * none" case required** — 「変異注入でしか非空虚性を証明できない」(DR1-020).
 *
 * The reason that mutation is the acceptance condition and not a nicety: a
 * suite that only asserts the RIGHT verdicts on the RIGHT frames is satisfied by
 * a detector that answers `'positive'` unconditionally, because every live
 * capture of a working tool is a frame with evidence on it. Only a frame where
 * the evidence has been taken away tells the two apart.
 *
 * This module holds the shared machinery; each tool declares its own frames and
 * expectations in `tools/<tool>/fixtures.test.ts`, which is where a reader looks
 * when that tool's TUI changes.
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { detectSessionStatus } from '@/lib/detection/status-detector';
import type { CLIToolType } from '@/lib/cli-tools/types';
import type { StatusEvidence } from '@/lib/session/status-evidence';

/** What a fixture is expected to publish. */
export interface FixtureExpectation {
  /** Fixture basename, without `.txt`. */
  frame: string;
  status: 'idle' | 'ready' | 'running' | 'waiting';
  reason: string;
  evidence: StatusEvidence;
}

export interface ToolFixtureSuite {
  tool: CLIToolType;
  /** Absolute path of the directory holding the verbatim captures. */
  fixtureDir: string;
  /** Rows the pane must have when captured, so a re-capture at the wrong geometry fails. */
  paneRows: number;
  /** Every fixture and what it must publish. Must cover the directory exactly. */
  expectations: readonly FixtureExpectation[];
  /**
   * The frames whose ONLY running evidence is the tool's busy vocabulary.
   *
   * Reword one word of it and the frame must lose its evidence — never fall
   * through to a confident `ready`. At least one is required; a tool suite with
   * none fails {@link runToolFixtureSuite} outright. That strictness is the
   * point: §11 makes this case an acceptance condition, so "we could not find a
   * frame" has to be a red test rather than an omission nobody notices.
   */
  mutationFrames: readonly string[];
  /**
   * Where {@link mutationFrames} live, when that is not {@link fixtureDir}.
   *
   * opencode needs it: the running frame in its idle-composer directory carries
   * a genuinely finished earlier step's `▣ … · 2.3s` marker underneath the busy
   * row, so removing the row leaves real evidence behind and the frame cannot
   * demonstrate its absence. The frame that can is in another Issue's capture
   * set, and pointing at it beats copying 200 rows of ANSI to a second place.
   */
  mutationDir?: string;
  /** Frames that positively show the turn is over. At least one is required. */
  idleFrames: readonly string[];
  /** The word the tool spells its busy affordance with, e.g. `interrupt`. */
  busyWord: string;
  /** What the word becomes. Any non-vocabulary string will do. */
  rewordedBusyWord: string;
}

/**
 * Replace one word in the BOTTOM ROW only, leaving every other byte — including
 * the identical word where the agent printed it as body text — untouched.
 *
 * The bottom row is where all three tools put the affordance (`esc to
 * interrupt` / `esc interrupt` / ` ◉ Working … esc interrupt`), and confining
 * the surgery to it is what makes the result a statement about that row rather
 * than about the pane.
 *
 * The WORD rather than the phrase: every one of these TUIs colours `esc` and
 * `interrupt` in separate SGR runs, so `raw.replace('esc interrupt', …)` is a
 * silent no-op on a real capture — the mutation would then "prove" nothing while
 * staying green. {@link runToolFixtureSuite} asserts the frame actually changed
 * for exactly that reason.
 */
export function rewordBottomRow(raw: string, from: string, to: string): string {
  const rows = raw.split('\n');
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].trim() === '') continue;
    rows[i] = rows[i].replace(from, to);
    return rows.join('\n');
  }
  return raw;
}

function readFrame(dir: string, name: string): string {
  return readFileSync(path.join(dir, `${name}.txt`), 'utf8');
}

/** Register every check §11 asks for, for one tool. */
export function runToolFixtureSuite(suite: ToolFixtureSuite): void {
  const names = readdirSync(suite.fixtureDir)
    .filter(f => f.endsWith('.txt'))
    .map(f => f.replace(/\.txt$/, ''))
    .sort();

  it('covers the fixture directory exactly', () => {
    // A fixture nobody asserts on is a capture that proves nothing, and an
    // expectation with no fixture is a rule nobody measured. Both are the way
    // this kind of suite rots.
    expect([...suite.expectations].map(e => e.frame).sort()).toEqual(names);
    expect(names.length).toBeGreaterThan(0);
  });

  it('holds verbatim captures at the production pane geometry', () => {
    for (const name of names) {
      const raw = readFrame(suite.fixtureDir, name);
      expect(raw, `${name} lost its escape sequences`).toContain('\x1b[');
      // The geometry is load-bearing, not incidental: every one of these TUIs
      // anchors chrome to the bottom of the pane and puts the transcript
      // hundreds of rows above it, so a re-capture at a default height would
      // put both in the same tail window and the rules would stop being about
      // the rows they name.
      expect(
        raw.split('\n').length,
        `${name} is not a ${suite.paneRows}-row capture`,
      ).toBeGreaterThanOrEqual(suite.paneRows);
    }
  });

  it.each(suite.expectations)(
    '$frame publishes $status/$reason with $evidence evidence',
    ({ frame, status, reason, evidence }) => {
      const result = detectSessionStatus(readFrame(suite.fixtureDir, frame), suite.tool);
      expect({ status: result.status, reason: result.reason, evidence: result.evidence }).toEqual({
        status,
        reason,
        evidence,
      });
    },
  );

  it('declares at least one positive idle frame and at least one mutation frame', () => {
    // The §11 requirement, enforced structurally rather than by convention: a
    // tool added to the rollout without both is a tool whose green says nothing.
    expect(suite.idleFrames.length).toBeGreaterThan(0);
    expect(suite.mutationFrames.length).toBeGreaterThan(0);
  });

  it.each(suite.idleFrames)('%s carries positive completion evidence', frame => {
    expect(detectSessionStatus(readFrame(suite.fixtureDir, frame), suite.tool).evidence).toBe(
      'positive',
    );
  });

  const mutationDir = suite.mutationDir ?? suite.fixtureDir;
  it.each(suite.mutationFrames)(
    '%s loses its evidence when one word of the busy row is reworded',
    frame => {
      const raw = readFrame(mutationDir, frame);
      const mutated = rewordBottomRow(raw, suite.busyWord, suite.rewordedBusyWord);

      // The mutation really landed. Without this the assertion below could pass
      // on an unchanged frame if the tool ever re-colours that row.
      expect(mutated, `${frame} carries no ${suite.busyWord} in its bottom row`).not.toBe(raw);

      const before = detectSessionStatus(raw, suite.tool);
      expect(before.evidence, `${frame} was not a positively-running frame to begin with`).toBe(
        'positive',
      );
      expect(before.status).toBe('running');

      // What must NOT happen is a confident `ready`: that is the §4 D1
      // violation — a completion declared because no busy marker was found.
      // Either the frame keeps no evidence at all, or the tool has some other
      // positive completion marker on it; the one thing forbidden is `ready`
      // with `evidence: 'positive'` derived from the missing negative.
      const after = detectSessionStatus(mutated, suite.tool);
      expect(after.evidence).toBe('none');
    },
  );
}
