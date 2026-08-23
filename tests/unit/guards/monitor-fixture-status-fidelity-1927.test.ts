/**
 * The orchestrate-monitor fixtures must describe payloads the product emits
 * (Issue #1927, 方針書 §11 / DR3-012).
 *
 * `tests/unit/skills/orchestrate-monitor/fixture-fidelity.test.ts` already
 * guards the SHAPE of those fixtures — that the ANSI survived, that the JSON is
 * the pretty-printed form `capture --json` writes. What it cannot guard is the
 * STATUS TRIPLE, and that is the half Issue #1522's root cause actually lived
 * in: a fixture describing a payload the product never emits "proves" anchors
 * that never fire in production.
 *
 * This Issue is the demonstration. Before it, four fixtures carried
 * `sessionStatus: 'ready'` with `sessionStatusReason: 'no_recent_output'`, and
 * three of those four ALSO carried `isUnclassifiedActive: false` — a
 * combination the server has not produced since #1497 widened the flag to that
 * route. The suite stayed green the whole time, because nothing compared the
 * fixture's verdict to the product's rules.
 *
 * So this guard states the rules the payload builder applies, and checks the
 * fixtures against them. It lives under `tests/unit/guards/` rather than beside
 * the fixtures because it is a cross-cutting invariant — the same one the
 * server's own producer obeys — and because `unit/guards` is where this
 * repository keeps "a rule about files" rather than "a test of a function".
 *
 * @vitest-environment node
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { STATUS_REASON } from '@/lib/detection/status-detector';

const FIXTURE_DIR = fileURLToPath(
  new URL('../skills/orchestrate-monitor/fixtures/', import.meta.url),
);

interface MonitorFixture {
  isRunning?: boolean;
  sessionStatus?: string;
  sessionStatusReason?: string;
  isUnclassifiedActive?: boolean;
  statusEvidence?: string;
}

const FIXTURES = readdirSync(FIXTURE_DIR)
  .filter(f => f.endsWith('.json'))
  .sort()
  .map(name => [name, JSON.parse(readFileSync(path.join(FIXTURE_DIR, name), 'utf8')) as MonitorFixture] as const);

/**
 * The routes that mean "the frame said nothing".
 *
 * `default` — no pattern matched at all. `no_recent_output` — five seconds
 * without a repaint. `unknown_frame` — a tool whose own rules are the only rules
 * looked and recognised nothing (Issue #1927). All three are `running` with no
 * evidence; none of them may say `ready`, which is the §4 D1 決定 3 rule this
 * guard exists to keep the fixtures honest about.
 */
const NO_EVIDENCE_REASONS: readonly string[] = [
  STATUS_REASON.DEFAULT,
  STATUS_REASON.NO_RECENT_OUTPUT,
  STATUS_REASON.UNKNOWN_FRAME,
];

describe('[#1927] monitor fixtures carry a status triple the product can emit', () => {
  it('finds the fixtures', () => {
    // An empty glob would make every assertion below vacuously true.
    expect(FIXTURES.length).toBeGreaterThanOrEqual(15);
  });

  it.each(FIXTURES)('%s: isUnclassifiedActive is statusEvidence === none', (_name, fixture) => {
    if (fixture.isUnclassifiedActive === undefined) {
      // A payload for a session that is not running carries neither field.
      expect(fixture.statusEvidence).toBeUndefined();
      expect(fixture.isRunning).toBe(false);
      return;
    }
    expect(fixture.statusEvidence).toBe(fixture.isUnclassifiedActive ? 'none' : 'positive');
  });

  it.each(FIXTURES)('%s: a no-evidence reason is never published as ready', (_name, fixture) => {
    if (fixture.sessionStatusReason === undefined) return;
    if (!NO_EVIDENCE_REASONS.includes(fixture.sessionStatusReason)) return;

    // §4 D1 決定 3. `ready` on no evidence is what let `wait` report a stalled
    // worker as Completed, and a fixture that still spells it would teach the
    // monitor's tests a state the server stopped producing.
    expect(fixture.sessionStatus).toBe('running');
    expect(fixture.isUnclassifiedActive).toBe(true);
  });

  it('still holds at least one frame from each side of the evidence split', () => {
    // Non-vacuity for the two rules above: a fixture set that was all-positive
    // or all-none would satisfy them without saying anything.
    const evidences = FIXTURES.map(([, f]) => f.statusEvidence).filter(Boolean);
    expect(evidences).toContain('positive');
    expect(evidences).toContain('none');
  });
});
