/**
 * The Copilot row of the Skill compatibility matrix, pinned as a measurement
 * (Issue #2302)
 *
 * Same reason as `command-code-matrix-measurement-2302.test.ts` and
 * `opencode-matrix-measurement-2037.test.ts`: a new measured row whose values
 * nothing asserts is a row that can be flipped silently, because the only
 * moving assertion is `unmeasuredAgents()` losing a name and that stays true
 * whatever the outcomes say.
 *
 * Gemini was probed the same day and is deliberately *not* here: its discovery
 * axis measured cleanly and its invocation axis could not be measured at all,
 * so its matrix row stays unmeasured. `docs/reference/skill-agent-compatibility.md`
 * §9.1 keeps that evidence for whoever lands it.
 *
 * ## What was measured, 2026-09-05
 *
 * Harness: `dev-reports/qa/issue-2302-other-agents-skill-probe.sh`. A scratch
 * `$HOME`, a fresh git repository with no Skills, one probe Skill per candidate
 * root with its own token, plus the `#1460` dual-root install. Copilot was not
 * signed in — `copilot skill list` is a filesystem scan and the composer
 * palette is local UI, so all of this is observable before any model call.
 *
 *  - **Copilot 1.0.83** — `copilot skill list` returns `.github/skills`
 *    (positive control), `.agents/skills` *and* `.claude/skills`, with the
 *    dual-root install folded into one row. Typing `/probe` in its composer
 *    offers all four; `/zzzznotacommand` matches nothing and `/hel` matches the
 *    built-ins, so the palette filters rather than lists everything.
 *
 * Re-measuring is supposed to make this file red.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import {
  AGENT_AXIS_OUTCOME_LABEL_KEYS,
  AGENT_EVIDENCE_KIND_LABEL_KEYS,
  AGENT_RELOAD_MESSAGE_KEYS,
  deriveMatrixAgentSupport,
  findSkillAgentMatrixEntry,
  isAgentMeasured,
} from '@/lib/skills/compatibility-matrix';
import { SkillAgentVerification, reconcileAgentSupport } from '@/lib/skills/compatibility';
import {
  SKILL_CLAUDE_INSTALL_ROOT_PREFIX,
  SKILL_INSTALL_ROOT_PREFIX,
} from '@/lib/skills/constants';

const MEASURED_DATE = '2026-09-05';

describe('the 2026-09-05 Copilot measurement is recorded as taken', () => {
  const copilot = findSkillAgentMatrixEntry('copilot');

  it('is a measured row with a version and a date', () => {
    expect(copilot).not.toBeNull();
    expect(isAgentMeasured(copilot!)).toBe(true);
    expect(copilot?.skipReasonKey).toBeNull();
    expect(copilot?.testedVersion).toBe('1.0.83');
    expect(copilot?.testedDate).toBe(MEASURED_DATE);
  });

  it('records BOTH install roots, which no other Agent but opencode does', () => {
    // The strongest statement in the table: one `copilot skill list` returned a
    // probe from each root, and the byte-identical dual-root install appeared
    // once rather than twice.
    expect(copilot?.discoveryRoots).toEqual([
      SKILL_INSTALL_ROOT_PREFIX,
      SKILL_CLAUDE_INSTALL_ROOT_PREFIX,
    ]);
  });

  it('machine-checks both axes', () => {
    expect(copilot?.discovery).toMatchObject({ outcome: 'verified', evidenceKind: 'mechanical' });
    expect(copilot?.invocation).toMatchObject({ outcome: 'verified', evidenceKind: 'mechanical' });
    expect(copilot?.discovery.labelKey).toBe(AGENT_AXIS_OUTCOME_LABEL_KEYS.verified);
    expect(copilot?.invocation.labelKey).toBe(AGENT_AXIS_OUTCOME_LABEL_KEYS.verified);
    expect(copilot?.invocation.evidenceKindKey).toBe(AGENT_EVIDENCE_KIND_LABEL_KEYS.mechanical);
  });

  it('attaches no limitation, because its own palette lists the Skills', () => {
    expect(copilot?.discovery.limitationKey).toBeNull();
    expect(copilot?.invocation.limitationKey).toBeNull();
  });

  it('says a restart is an assumption, because reload was not measured', () => {
    expect(copilot?.reloadKey).toBe(AGENT_RELOAD_MESSAGE_KEYS.UNKNOWN);
  });

  it('derives native support', () => {
    expect(copilot && deriveMatrixAgentSupport(copilot)).toBe('native');
  });

  it('links the evidence', () => {
    const source = copilot?.evidenceSource ?? '';
    expect(source.startsWith('https://')).toBe(true);
    expect(source).toContain('skill-agent-compatibility.md');
  });
});

describe('reconcileAgentSupport now has a measurement to reconcile Copilot against', () => {
  const NOW = new Date('2026-09-06T00:00:00Z');

  function view(support: 'native' | 'unknown') {
    return reconcileAgentSupport({ agent: 'copilot', support, evidence: 'declared' }, NOW);
  }

  it('stops answering UNVERIFIED, which is what it answered while the row was a placeholder', () => {
    const declared = view('native');
    expect(declared.verification).toBe(SkillAgentVerification.CONFIRMED);
    expect(declared.measured).not.toBeNull();
    expect(declared.skipReasonKey).toBeNull();
    expect(declared.measured?.ageDays).toBe(1);
    expect(declared.measured?.stale).toBe(false);
  });

  it('renders it as verified on both axes and reading both roots', () => {
    const declared = view('native');
    expect(declared.measured?.discovery.outcome).toBe('verified');
    expect(declared.measured?.invocation.outcome).toBe('verified');
    expect(declared.measured?.invocation.limitationKey).toBeNull();
    expect(declared.measured?.discoveryRoots).toEqual([
      SKILL_INSTALL_ROOT_PREFIX,
      SKILL_CLAUDE_INSTALL_ROOT_PREFIX,
    ]);
  });

  it('still refuses to raise a modest declaration to match the measurement', () => {
    const modest = view('unknown');
    expect(modest.support).toBe('unknown');
    expect(modest.verification).toBe(SkillAgentVerification.STALE_DECLARATION);
  });

  it('hands the UI the reload string that admits reload was not measured', () => {
    expect(view('native').reloadKey).toBe(AGENT_RELOAD_MESSAGE_KEYS.UNKNOWN);
  });
});
