/**
 * Schema and invariant tests for the measured Agent discovery matrix (Issue #1246)
 *
 * The matrix is the only place CommandMate states something as measured rather
 * than declared, so the invariants here are what stop a guess from wearing that
 * label: no `verified` without an evidence kind, no tested version without a
 * date, no discovery root outside the set CommandMate actually installs into.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { CLI_TOOL_DISPLAY_NAMES, CLI_TOOL_IDS } from '@/lib/cli-tools/types';
import {
  AGENT_AXIS_LABEL_KEYS,
  AGENT_AXIS_OUTCOME_LABEL_KEYS,
  AGENT_EVIDENCE_KIND_LABEL_KEYS,
  AGENT_LIMITATION_MESSAGE_KEYS,
  SKILL_AGENT_AXIS_OUTCOMES,
  SKILL_EVIDENCE_KINDS,
  SKILL_EVIDENCE_MAX_AGE_DAYS,
  agentsMissingFromMatrix,
  deriveMatrixAgentSupport,
  evidenceAgeInDays,
  findSkillAgentMatrixEntry,
  getSkillAgentMatrix,
  isAgentMeasured,
  isEvidenceStale,
  unmeasuredAgents,
} from '@/lib/skills/compatibility-matrix';
import {
  SKILL_CLAUDE_INSTALL_ROOT_PREFIX,
  SKILL_INSTALL_ROOT_PREFIX,
  SKILL_INSTALL_ROOT_PREFIXES,
} from '@/lib/skills/constants';

const MEASURED_DATE = '2026-07-26';
const DAY_AFTER = new Date('2026-07-27T00:00:00Z');

describe('the Agent discovery matrix covers every CLI tool', () => {
  it('names every CLI tool exactly once', () => {
    const agents = getSkillAgentMatrix().map((entry) => entry.agent);
    expect(agents.slice().sort()).toEqual(CLI_TOOL_IDS.slice().sort());
    expect(new Set(agents).size).toBe(agents.length);
  });

  it('leaves no CLI tool out', () => {
    // An Agent absent from the table renders as no statement at all, which a
    // reader completes as "presumably fine". Only an explicit row can say
    // "unknown".
    expect(agentsMissingFromMatrix()).toEqual([]);
  });

  it('resolves a known agent and refuses an unknown id', () => {
    expect(findSkillAgentMatrixEntry('claude')?.agent).toBe('claude');
    expect(findSkillAgentMatrixEntry('not-an-agent')).toBeNull();
    expect(findSkillAgentMatrixEntry('Claude')).toBeNull();
  });
});

describe('every matrix row is internally consistent', () => {
  const matrix = getSkillAgentMatrix();

  it('uses only the declared axis outcomes and evidence kinds', () => {
    for (const entry of matrix) {
      for (const axis of [entry.discovery, entry.invocation]) {
        expect(SKILL_AGENT_AXIS_OUTCOMES, entry.agent).toContain(axis.outcome);
        expect(SKILL_EVIDENCE_KINDS, entry.agent).toContain(axis.evidenceKind);
        expect(axis.labelKey).toBe(AGENT_AXIS_OUTCOME_LABEL_KEYS[axis.outcome]);
        expect(axis.evidenceKindKey).toBe(AGENT_EVIDENCE_KIND_LABEL_KEYS[axis.evidenceKind]);
      }
    }
  });

  it('never reports an outcome the evidence kind says was not measured', () => {
    for (const entry of matrix) {
      for (const axis of [entry.discovery, entry.invocation]) {
        if (axis.evidenceKind === 'not_measured') {
          expect(axis.outcome, `${entry.agent} claims a verdict it never measured`).toBe('unknown');
        }
        if (axis.outcome !== 'unknown') {
          expect(axis.evidenceKind, `${entry.agent} states an outcome with no evidence`).not.toBe(
            'not_measured'
          );
        }
      }
    }
  });

  it('only ever names an install root CommandMate writes to', () => {
    for (const entry of matrix) {
      for (const root of entry.discoveryRoots) {
        expect(SKILL_INSTALL_ROOT_PREFIXES, `${entry.agent} reads ${root}`).toContain(root);
      }
    }
  });

  it('pairs a measured row with a version, a date, a source and a root', () => {
    for (const entry of matrix.filter(isAgentMeasured)) {
      expect(entry.testedVersion, entry.agent).toEqual(expect.any(String));
      expect(entry.testedDate, entry.agent).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(entry.evidenceSource, entry.agent).toEqual(expect.any(String));
      expect(entry.discoveryRoots.length, entry.agent).toBeGreaterThan(0);
      expect(entry.skipReasonKey, entry.agent).toBeNull();
    }
  });

  it('pairs an unmeasured row with a skip reason and nothing else', () => {
    for (const entry of matrix.filter((candidate) => !isAgentMeasured(candidate))) {
      expect(entry.testedVersion, entry.agent).toBeNull();
      expect(entry.testedDate, entry.agent).toBeNull();
      expect(entry.evidenceSource, entry.agent).toBeNull();
      expect(entry.discoveryRoots, entry.agent).toEqual([]);
      expect(entry.skipReasonKey, entry.agent).toEqual(expect.any(String));
      expect(deriveMatrixAgentSupport(entry), entry.agent).toBe('unknown');
    }
  });

  it('gives every row a reload instruction, measured or not', () => {
    // "We do not know how to reload this" is still an answer the user needs.
    for (const entry of matrix) {
      expect(entry.reloadKey, entry.agent).toMatch(/^skills\.compatibility\.reload\./);
    }
  });

  it('names both axes with the shared label keys', () => {
    expect(AGENT_AXIS_LABEL_KEYS.discovery).toBe('skills.compatibility.axis.discovery');
    expect(AGENT_AXIS_LABEL_KEYS.invocation).toBe('skills.compatibility.axis.invocation');
  });
});

describe('the 2026-07-26 measurements are recorded as taken', () => {
  it('records Claude Code reading .claude/skills and not .agents/skills', () => {
    // The catalog's older entries credited `.agents/skills` for Claude support.
    // The conclusion was right and the reason was wrong: Claude does not read
    // that root, and the install works because #1460 also writes `.claude/skills`.
    const claude = findSkillAgentMatrixEntry('claude');
    expect(claude?.discoveryRoots).toEqual([SKILL_CLAUDE_INSTALL_ROOT_PREFIX]);
    expect(claude?.discoveryRoots).not.toContain(SKILL_INSTALL_ROOT_PREFIX);
    expect(claude?.testedVersion).toBe('2.1.220');
    expect(claude?.testedDate).toBe(MEASURED_DATE);
  });

  it('records Claude Code as machine-checked on both axes', () => {
    const claude = findSkillAgentMatrixEntry('claude');
    expect(claude?.discovery).toMatchObject({ outcome: 'verified', evidenceKind: 'mechanical' });
    expect(claude?.invocation).toMatchObject({ outcome: 'verified', evidenceKind: 'mechanical' });
  });

  it('splits Codex CLI into a discovered-yes, slash-command-no pair', () => {
    // The whole reason the matrix has two axes. A single native/unsupported
    // value would either hide a working install or promise a palette entry
    // that 0.145.0 does not produce.
    const codex = findSkillAgentMatrixEntry('codex');
    expect(codex?.discoveryRoots).toEqual([SKILL_INSTALL_ROOT_PREFIX]);
    expect(codex?.testedVersion).toBe('0.145.0');
    expect(codex?.discovery.outcome).toBe('verified');
    expect(codex?.invocation.outcome).toBe('unsupported');
  });

  it('marks the Codex discovery evidence as the Agent describing itself', () => {
    const codex = findSkillAgentMatrixEntry('codex');
    expect(codex?.discovery.evidenceKind).toBe('self_report');
    // The palette result was a control experiment, so it is machine-checked.
    expect(codex?.invocation.evidenceKind).toBe('mechanical');
  });

  it('attaches the no-slash-command limitation to the Codex invocation axis', () => {
    const codex = findSkillAgentMatrixEntry('codex');
    expect(codex?.invocation.limitationKey).toBe(AGENT_LIMITATION_MESSAGE_KEYS.NO_SLASH_COMMAND);
    expect(codex?.discovery.limitationKey).toBeNull();
  });

  it('still calls Codex natively supported, because discovery is what decides', () => {
    const codex = findSkillAgentMatrixEntry('codex');
    expect(codex && deriveMatrixAgentSupport(codex)).toBe('native');
  });

  it('leaves every unmeasured Agent unknown', () => {
    expect(unmeasuredAgents().slice().sort()).toEqual(
      ['antigravity', 'copilot', 'gemini', 'opencode', 'vibe-local'].sort()
    );
  });

  it('does not treat CommandMate serving .agents/skills to antigravity as evidence', () => {
    // The slash palette injects those entries (#1504). That is CommandMate
    // adding a command, not the Agent discovering a Skill, so it cannot be
    // quoted as a native-discovery measurement.
    const antigravity = findSkillAgentMatrixEntry('antigravity');
    expect(isAgentMeasured(antigravity!)).toBe(false);
    expect(antigravity?.discoveryRoots).toEqual([]);
  });

  it('never derives commandmate_runtime, which is not shipped', () => {
    for (const entry of getSkillAgentMatrix()) {
      expect(deriveMatrixAgentSupport(entry)).not.toBe('commandmate_runtime');
    }
  });
});

describe('the reference doc states the same matrix as the code', () => {
  // The doc is where a human goes to decide whether to trust a support badge.
  // Left unguarded it drifts, and a stale table reads exactly like a current
  // one.
  const doc = fs.readFileSync(
    path.resolve(__dirname, '../../../../docs/reference/skill-agent-compatibility.md'),
    'utf-8'
  );

  it('lists every Agent the code knows about', () => {
    for (const agent of CLI_TOOL_IDS) {
      expect(doc, `docs omit ${agent}`).toContain(CLI_TOOL_DISPLAY_NAMES[agent]);
    }
  });

  it('quotes the same tested version and root for every measured Agent', () => {
    for (const entry of getSkillAgentMatrix().filter(isAgentMeasured)) {
      expect(doc, `docs miss ${entry.agent} version`).toContain(entry.testedVersion!);
      expect(doc, `docs miss ${entry.agent} date`).toContain(entry.testedDate!);
      for (const root of entry.discoveryRoots) {
        expect(doc, `docs miss ${entry.agent} root ${root}`).toContain(root);
      }
    }
  });

  it('quotes the same evidence source and staleness threshold', () => {
    const source = getSkillAgentMatrix().find(isAgentMeasured)?.evidenceSource;
    expect(doc).toContain(source!);
    expect(doc).toContain(String(SKILL_EVIDENCE_MAX_AGE_DAYS));
  });
});

describe('evidence staleness', () => {
  const claude = findSkillAgentMatrixEntry('claude')!;
  const gemini = findSkillAgentMatrixEntry('gemini')!;

  it('counts whole days since the measurement', () => {
    expect(evidenceAgeInDays(claude, DAY_AFTER)).toBe(1);
    expect(evidenceAgeInDays(claude, new Date('2026-07-26T23:59:59Z'))).toBe(0);
  });

  it('clamps a measurement dated in the future to zero rather than going negative', () => {
    expect(evidenceAgeInDays(claude, new Date('2026-01-01T00:00:00Z'))).toBe(0);
  });

  it('has no age for an Agent that was never measured', () => {
    expect(evidenceAgeInDays(gemini, DAY_AFTER)).toBeNull();
  });

  it('is not stale the day after it was taken', () => {
    expect(isEvidenceStale(claude, DAY_AFTER)).toBe(false);
  });

  it('turns stale strictly after the maximum age, not on it', () => {
    const onTheBoundary = new Date(
      Date.parse(`${MEASURED_DATE}T00:00:00Z`) + SKILL_EVIDENCE_MAX_AGE_DAYS * 86_400_000
    );
    const justPast = new Date(onTheBoundary.getTime() + 86_400_000);
    expect(isEvidenceStale(claude, onTheBoundary)).toBe(false);
    expect(isEvidenceStale(claude, justPast)).toBe(true);
  });

  it('does not call an unmeasured Agent stale', () => {
    // Stale implies a measurement expired. There was never one to expire, and
    // "unknown" already says something stronger.
    expect(isEvidenceStale(gemini, new Date('2099-01-01T00:00:00Z'))).toBe(false);
  });
});
