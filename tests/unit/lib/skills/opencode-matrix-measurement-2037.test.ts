/**
 * The opencode row of the Skill compatibility matrix, pinned as a measurement
 * (Issue #2037, verified by the Issue #2103 mutation sweep)
 *
 * ## Why this file exists
 *
 * `compatibility-matrix.test.ts` pins the 2026-07-26 measurements *by value* —
 * Claude's roots and version, Codex's discovered-yes / slash-command-no split,
 * the limitation key hanging off the Codex invocation axis. Issue #2037 added a
 * sixth measured row (opencode on 1.18.22) and pinned none of it: the only
 * assertion that moved was `unmeasuredAgents()` losing the name, which stays
 * true for *any* pair of measured outcomes.
 *
 * The Issue #2103 sweep measured that gap rather than assuming it. Flipping the
 * opencode discovery axis from `verified`/`mechanical` to
 * `unsupported`/`mechanical` — with `labelKey` moved to match, so the existing
 * consistency invariant stays satisfied — left the whole repository green
 * (`CI=true NODE_ENV=test npx vitest run tests/unit`, 2026-08-27). The matrix
 * would have gone on rendering a support badge for opencode that said the
 * opposite of what was measured, and `docs/reference/skill-agent-compatibility.md`
 * would not have caught it either: its guard quotes versions, dates and roots,
 * never outcomes.
 *
 * So the assertions below are deliberately by-value and deliberately narrow:
 * they say what was measured on 1.18.22 and nothing about what a later release
 * should do. Re-measuring is supposed to make this file red — that is the
 * review the matrix's `evidenceSource` link exists for.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import {
  AGENT_AXIS_OUTCOME_LABEL_KEYS,
  AGENT_EVIDENCE_KIND_LABEL_KEYS,
  AGENT_LIMITATION_MESSAGE_KEYS,
  AGENT_RELOAD_MESSAGE_KEYS,
  deriveMatrixAgentSupport,
  findSkillAgentMatrixEntry,
  isAgentMeasured,
} from '@/lib/skills/compatibility-matrix';
import {
  SKILL_CLAUDE_INSTALL_ROOT_PREFIX,
  SKILL_INSTALL_ROOT_PREFIX,
} from '@/lib/skills/constants';

/** The opencode release Issue #2037 measured against. */
const OPENCODE_TESTED_VERSION = '1.18.22';
/** The day it was measured. */
const OPENCODE_MEASURED_DATE = '2026-08-25';

describe('the 2026-08-25 opencode measurement is recorded as taken (Issue #2037)', () => {
  const opencode = findSkillAgentMatrixEntry('opencode');

  it('is a measured row, not an unmeasured placeholder', () => {
    expect(opencode).not.toBeNull();
    expect(isAgentMeasured(opencode!)).toBe(true);
    expect(opencode?.skipReasonKey).toBeNull();
  });

  it('records both CommandMate install roots as the roots opencode read', () => {
    // The measurement that made this row possible: six probe Skills, one per
    // candidate root, all returned by `GET /skill` with absolute paths. Both of
    // CommandMate's own install roots were among them, which is why the row is
    // `verified` rather than "the docs say so".
    expect(opencode?.discoveryRoots).toEqual([
      SKILL_INSTALL_ROOT_PREFIX,
      SKILL_CLAUDE_INSTALL_ROOT_PREFIX,
    ]);
  });

  it('names the release and the day it was measured on', () => {
    expect(opencode?.testedVersion).toBe(OPENCODE_TESTED_VERSION);
    expect(opencode?.testedDate).toBe(OPENCODE_MEASURED_DATE);
  });

  it('records opencode as machine-checked on BOTH axes', () => {
    // The assertion the sweep found missing. `discovery` is what
    // `deriveMatrixAgentSupport` reads, so a silent flip here is a silent flip
    // of the badge the reference doc and the Skills UI both render.
    expect(opencode?.discovery).toMatchObject({
      outcome: 'verified',
      evidenceKind: 'mechanical',
    });
    expect(opencode?.invocation).toMatchObject({
      outcome: 'verified',
      evidenceKind: 'mechanical',
    });
  });

  it('keeps the display keys agreeing with the outcomes they label', () => {
    // Pinned separately so that moving the outcome *and* its label together —
    // the shape that slipped past the existing consistency invariant — is still
    // a red test rather than a consistent lie.
    expect(opencode?.discovery.labelKey).toBe(AGENT_AXIS_OUTCOME_LABEL_KEYS.verified);
    expect(opencode?.invocation.labelKey).toBe(AGENT_AXIS_OUTCOME_LABEL_KEYS.verified);
    expect(opencode?.discovery.evidenceKindKey).toBe(
      AGENT_EVIDENCE_KIND_LABEL_KEYS.mechanical
    );
    expect(opencode?.invocation.evidenceKindKey).toBe(
      AGENT_EVIDENCE_KIND_LABEL_KEYS.mechanical
    );
  });

  it('hangs the no-slash-command limitation on invocation and nothing on discovery', () => {
    // Measured, and narrower than Codex's identical-looking key: opencode DOES
    // run a Skill submitted as `/name`; what it does not do is offer it in its
    // own palette. That is a limitation of the route's visibility, and it
    // belongs on invocation alone.
    expect(opencode?.invocation.limitationKey).toBe(
      AGENT_LIMITATION_MESSAGE_KEYS.NO_SLASH_COMMAND
    );
    expect(opencode?.discovery.limitationKey).toBeNull();
  });

  it('tells the operator a restart is what reloads a freshly installed Skill', () => {
    // Also measured: the server scans commands and Skills once at boot and
    // caches them, so `SESSION_RESTART` is a fact about 1.18.22 and not a
    // default. `SESSION_RESTART_NO_SLASH` would be the wrong advice — the slash
    // route works here.
    expect(opencode?.reloadKey).toBe(AGENT_RELOAD_MESSAGE_KEYS.SESSION_RESTART);
  });

  it('derives native support, which is the badge the measurement earns', () => {
    expect(opencode && deriveMatrixAgentSupport(opencode)).toBe('native');
  });

  it('links the evidence, which is the half of the row a reader can check', () => {
    // Issue #2037's first acceptance condition is "an outcome measured, WITH a
    // link to the evidence". A row that states a verdict with no reachable
    // record of how it was reached is the thing the matrix exists not to be.
    const source = opencode?.evidenceSource ?? '';
    expect(source.startsWith('https://')).toBe(true);
    expect(source).toContain('opencode-server-live-verification.md');
  });
});
