/**
 * The OpenCode V2 row of the Skill compatibility matrix, pinned as a
 * measurement (Issue #2975)
 *
 * ## Why this file exists
 *
 * Issue #2934 registered `opencode-v2` as an unmeasured row. Issue #2975
 * measured it on the real `opencode2` 2.0.18 in an isolated `HOME`, with one
 * probe Skill per candidate root, and replaced the placeholder with that
 * measurement. The only assertion that would otherwise move is
 * `unmeasuredAgents()` losing the name, which stays true for *any* pair of
 * measured outcomes — the gap `opencode-matrix-measurement-2037.test.ts` closed
 * for v1.
 *
 * So, as there, the assertions are by-value and narrow: they state what was
 * measured on 2.0.18 and nothing about what a later release should do.
 * Re-measuring is supposed to make this file red.
 *
 * The v2 row is deliberately its own row even where its values equal v1's: the
 * release, the day and the route that makes invocation work all differ, and a
 * shared object would let a v1 re-measurement silently rewrite v2's claim.
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

/** The opencode2 release Issue #2975 measured against. */
const OPENCODE_V2_TESTED_VERSION = '2.0.18';
/** The day it was measured. */
const OPENCODE_V2_MEASURED_DATE = '2026-09-29';

describe('the 2026-09-29 OpenCode V2 measurement is recorded as taken (Issue #2975)', () => {
  const v2 = findSkillAgentMatrixEntry('opencode-v2');

  it('is a measured row, not an unmeasured placeholder', () => {
    expect(v2).not.toBeNull();
    expect(isAgentMeasured(v2!)).toBe(true);
    expect(v2?.skipReasonKey).toBeNull();
  });

  it('records both CommandMate install roots as the roots opencode2 read', () => {
    // `GET /api/skill` returned the `.agents/skills` and `.claude/skills`
    // probes with their absolute SKILL.md paths (six more roots too, which are
    // not CommandMate install roots and so are not named here).
    expect(v2?.discoveryRoots).toEqual([
      SKILL_INSTALL_ROOT_PREFIX,
      SKILL_CLAUDE_INSTALL_ROOT_PREFIX,
    ]);
  });

  it('names the release and the day it was measured on', () => {
    expect(v2?.testedVersion).toBe(OPENCODE_V2_TESTED_VERSION);
    expect(v2?.testedDate).toBe(OPENCODE_V2_MEASURED_DATE);
  });

  it('records OpenCode V2 as machine-checked on BOTH axes', () => {
    // Invocation is mechanical because the evidence is the `skill` tool part in
    // `GET /api/session/{id}/message` (`input.id` + the Skill's directory),
    // not the token the agent answered with.
    expect(v2?.discovery).toMatchObject({
      outcome: 'verified',
      evidenceKind: 'mechanical',
    });
    expect(v2?.invocation).toMatchObject({
      outcome: 'verified',
      evidenceKind: 'mechanical',
    });
  });

  it('keeps the display keys agreeing with the outcomes they label', () => {
    expect(v2?.discovery.labelKey).toBe(AGENT_AXIS_OUTCOME_LABEL_KEYS.verified);
    expect(v2?.invocation.labelKey).toBe(AGENT_AXIS_OUTCOME_LABEL_KEYS.verified);
    expect(v2?.discovery.evidenceKindKey).toBe(AGENT_EVIDENCE_KIND_LABEL_KEYS.mechanical);
    expect(v2?.invocation.evidenceKindKey).toBe(AGENT_EVIDENCE_KIND_LABEL_KEYS.mechanical);
  });

  it('hangs the no-slash-command limitation on invocation and nothing on discovery', () => {
    // Measured: `/probe-agents-root` in v2's composer shows "No matching
    // commands" and `ctrl+p` has no row for it. v2 does offer the Skill through
    // its `@` completion, but not as a slash command.
    expect(v2?.invocation.limitationKey).toBe(AGENT_LIMITATION_MESSAGE_KEYS.NO_SLASH_COMMAND);
    expect(v2?.discovery.limitationKey).toBeNull();
  });

  it('tells the operator to start a new session, the closest key to "picked up live"', () => {
    // Measured: no server restart is needed on 2.0.18 — a Skill planted while
    // the server ran was listed within seconds and ran in the same session. A
    // new session is sufficient advice; the vocabulary has no live-reload key.
    expect(v2?.reloadKey).toBe(AGENT_RELOAD_MESSAGE_KEYS.SESSION_RESTART);
  });

  it('derives native support, which is the badge the measurement earns', () => {
    expect(v2 && deriveMatrixAgentSupport(v2)).toBe('native');
  });

  it('links the evidence, which is the half of the row a reader can check', () => {
    const source = v2?.evidenceSource ?? '';
    expect(source.startsWith('https://')).toBe(true);
    expect(source).toContain('skill-agent-compatibility.md');
    expect(source).toContain('issue-2975');
  });

  it('is its own row, not the v1 row reused', () => {
    // Same outcomes as v1 on purpose, different release and day: the rows must
    // stay independent so re-measuring one cannot rewrite the other.
    const v1 = findSkillAgentMatrixEntry('opencode');
    expect(v1).not.toBe(v2);
    expect(v1?.testedVersion).not.toBe(v2?.testedVersion);
    expect(v1?.testedDate).not.toBe(v2?.testedDate);
    expect(v1?.evidenceSource).not.toBe(v2?.evidenceSource);
  });
});
