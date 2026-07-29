/**
 * Unit tests for CommandMate compatibility judgement and version resolution
 * (Issue #1231)
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import {
  SKILL_COMPATIBILITY_MESSAGE_KEYS,
  SkillAgentVerification,
  SkillCompatibilityReason,
  SkillRecommendationReason,
  capSupportByMeasurement,
  describeAgentCompatibility,
  evaluateCommandMateCompatibility,
  evaluateVersionCompatibility,
  findSkillCatalogEntry,
  normalizeHostVersion,
  reconcileAgentSupport,
  resolveSkillVersions,
} from '@/lib/skills/compatibility';
import {
  AGENT_SUPPORT_LABEL_KEYS,
  SKILL_AGENT_SUPPORT_VALUES,
  SKILL_CLAUDE_INSTALL_ROOT_PREFIX,
} from '@/lib/skills/constants';
import type {
  SkillAgentCompatibility,
  SkillAgentSupport,
  SkillCatalog,
  SkillCatalogEntry,
  SkillCatalogVersion,
} from '@/types/skills';

function makeVersion(
  version: string,
  commandmate: string,
  overrides: Partial<SkillCatalogVersion> = {}
): SkillCatalogVersion {
  return {
    version,
    changelog: `Release ${version}`,
    published_at: '2026-07-16T09:30:00Z',
    source: {
      repository: 'Kewton/commandmate-skills',
      ref: `release-notes-v${version}`,
      commit: 'ef754e3638b357eee53a626541aca267bd57e45c',
    },
    artifact: {
      asset_name: `release-notes-${version}.tar.gz`,
      url: `https://github.com/Kewton/commandmate-skills/releases/download/v${version}/release-notes-${version}.tar.gz`,
      sha256: '481be185fb462c8d41c09e118ed631a7e10d670c13413f669dce72ba3aeee97e',
      size: 4096,
      content_type: 'application/gzip',
      format: 'tar.gz',
    },
    compatibility: {
      commandmate,
      agents: [{ agent: 'claude', support: 'native', evidence: 'verified' }],
    },
    declared_risk: 'low',
    ...overrides,
  };
}

function makeEntry(latest: string, versions: SkillCatalogVersion[]): SkillCatalogEntry {
  return {
    id: 'release-notes',
    name: 'release-notes',
    summary: 'Draft release notes.',
    provider: { name: 'CommandMate' },
    license: 'MIT',
    latest,
    versions,
  };
}

describe('normalizeHostVersion', () => {
  it('accepts a strict SemVer 2.0 version', () => {
    expect(normalizeHostVersion('0.11.4')).toBe('0.11.4');
    expect(normalizeHostVersion(' 1.2.3-beta.1 ')).toBe('1.2.3-beta.1');
  });

  it('rejects the unknown-version sentinel getServerVersion() falls back to', () => {
    expect(normalizeHostVersion('0.0.0')).toBeNull();
  });

  it('rejects a v-prefixed version, which the Skill contract does not allow', () => {
    expect(normalizeHostVersion('v0.11.4')).toBeNull();
  });

  it('rejects absent, empty and non-SemVer input', () => {
    expect(normalizeHostVersion(null)).toBeNull();
    expect(normalizeHostVersion(undefined)).toBeNull();
    expect(normalizeHostVersion('   ')).toBeNull();
    expect(normalizeHostVersion('0.11')).toBeNull();
  });
});

describe('evaluateCommandMateCompatibility', () => {
  it('reports compatible when the host version satisfies the range', () => {
    const result = evaluateCommandMateCompatibility('>=0.11.0 <1.0.0', '0.11.4');
    expect(result.status).toBe('compatible');
    expect(result.reasonCode).toBe(SkillCompatibilityReason.SATISFIED);
    expect(result.currentVersion).toBe('0.11.4');
  });

  it('reports incompatible with the required range in the message', () => {
    const result = evaluateCommandMateCompatibility('>=1.0.0', '0.11.4');
    expect(result.status).toBe('incompatible');
    expect(result.reasonCode).toBe(SkillCompatibilityReason.HOST_VERSION_OUT_OF_RANGE);
    expect(result.requiredRange).toBe('>=1.0.0');
    expect(result.message).toContain('>=1.0.0');
    expect(result.message).toContain('0.11.4');
  });

  it('reports unknown, never compatible, when the host version is undeterminable', () => {
    const result = evaluateCommandMateCompatibility('>=0.11.0', null);
    expect(result.status).toBe('unknown');
    expect(result.reasonCode).toBe(SkillCompatibilityReason.HOST_VERSION_UNKNOWN);
    expect(result.currentVersion).toBeNull();
  });

  it('fails closed to unknown when the declared range is unparsable', () => {
    for (const range of ['^1 || ^2', 'not-a-range', '1.x', '']) {
      const result = evaluateCommandMateCompatibility(range, '0.11.4');
      expect(result.status).toBe('unknown');
      expect(result.reasonCode).toBe(SkillCompatibilityReason.RANGE_UNSUPPORTED);
    }
  });

  it('pairs every verdict with a machine code and an i18n key', () => {
    const result = evaluateCommandMateCompatibility('>=1.0.0', '0.11.4');
    expect(result.messageKey).toBe(
      SKILL_COMPATIBILITY_MESSAGE_KEYS[SkillCompatibilityReason.HOST_VERSION_OUT_OF_RANGE]
    );
    expect(result.message.length).toBeGreaterThan(0);
  });

  it('does not let a prerelease host version satisfy a release range', () => {
    const result = evaluateCommandMateCompatibility('>=0.11.0 <1.0.0', '0.12.0-rc.1');
    expect(result.status).toBe('incompatible');
  });

  it('reads the range from a Catalog version', () => {
    const version = makeVersion('1.0.0', '>=0.11.0 <1.0.0');
    expect(evaluateVersionCompatibility(version, '0.11.4').status).toBe('compatible');
  });
});

describe('describeAgentCompatibility', () => {
  it('attaches the shared label key to each support claim', () => {
    const views = describeAgentCompatibility([
      { agent: 'claude', support: 'native', evidence: 'verified' },
      { agent: 'gemini', support: 'unknown', evidence: 'not verified' },
    ]);
    expect(views[0].labelKey).toBe(AGENT_SUPPORT_LABEL_KEYS.native);
    expect(views[1].labelKey).toBe(AGENT_SUPPORT_LABEL_KEYS.unknown);
    expect(views[1].support).toBe('unknown');
  });

  it('invents no verdict for an Agent the manifest does not mention', () => {
    // Issue #1242: as of 2026-07-26 only Claude Code and Codex CLI have been
    // measured. Gemini, OpenCode and vibe-local have not, and a fabricated
    // `unsupported` would be a measurement CommandMate never made, while
    // `commandmate_runtime` would be a capability Phase 1 does not ship. Silence
    // in the manifest has to stay silence on the wire.
    const views = describeAgentCompatibility([
      { agent: 'claude', support: 'native', evidence: 'measured on 2.1.220' },
    ]);

    expect(views).toHaveLength(1);
    expect(views.map((view) => view.agent)).toEqual(['claude']);
  });

  it('carries a declared claim through unchanged rather than re-judging it', () => {
    // The support value is the publisher's declaration. Rewriting it here would
    // turn an unverified claim into a CommandMate verdict.
    for (const support of SKILL_AGENT_SUPPORT_VALUES) {
      const [view] = describeAgentCompatibility([{ agent: 'codex', support, evidence: 'e' }]);
      expect(view.support).toBe(support);
      expect(view.labelKey).toBe(AGENT_SUPPORT_LABEL_KEYS[support]);
    }
  });
});

describe('capSupportByMeasurement (Issue #1246)', () => {
  // Exhaustive over the vocabulary rather than sampled: this rule is what keeps
  // an evidence-free claim from rendering as supported, so every pairing of a
  // declaration and a measurement needs a stated outcome.
  const RANK: Record<SkillAgentSupport, number> = {
    unsupported: 0,
    unknown: 1,
    commandmate_runtime: 2,
    native: 3,
  };

  it('shows the weaker of the declaration and the measurement, for every pairing', () => {
    for (const declared of SKILL_AGENT_SUPPORT_VALUES) {
      for (const measured of SKILL_AGENT_SUPPORT_VALUES) {
        const { support } = capSupportByMeasurement(declared, measured);
        expect(RANK[support], `declared=${declared} measured=${measured}`).toBe(
          Math.min(RANK[declared], RANK[measured])
        );
      }
    }
  });

  it('reports a weaker measurement as a restriction and shows the measurement', () => {
    const restricted = capSupportByMeasurement('native', 'unsupported');
    expect(restricted).toEqual({
      support: 'unsupported',
      verification: SkillAgentVerification.RESTRICTED,
    });
    expect(capSupportByMeasurement('native', 'unknown').support).toBe('unknown');
    expect(capSupportByMeasurement('unknown', 'unsupported').support).toBe('unsupported');
  });

  it('reports a stronger measurement as a stale declaration and keeps the declaration', () => {
    expect(capSupportByMeasurement('unknown', 'native')).toEqual({
      support: 'unknown',
      verification: SkillAgentVerification.STALE_DECLARATION,
    });
    expect(capSupportByMeasurement('unsupported', 'native').support).toBe('unsupported');
  });

  it('confirms an exact agreement', () => {
    for (const support of SKILL_AGENT_SUPPORT_VALUES) {
      expect(capSupportByMeasurement(support, support)).toEqual({
        support,
        verification: SkillAgentVerification.CONFIRMED,
      });
    }
  });

  it('ranks unknown above unsupported, so "we could not tell" is not "it fails"', () => {
    expect(capSupportByMeasurement('unknown', 'unsupported').support).toBe('unsupported');
    expect(capSupportByMeasurement('unsupported', 'unknown').support).toBe('unsupported');
  });
});

describe('reconcileAgentSupport against the measured matrix (Issue #1246)', () => {
  const NOW = new Date('2026-07-27T00:00:00Z');

  function view(agent: string, support: SkillAgentSupport, evidence = 'declared') {
    return reconcileAgentSupport(
      { agent: agent as SkillAgentCompatibility['agent'], support, evidence },
      NOW
    );
  }

  it('confirms a declaration the measurement agrees with', () => {
    const claude = view('claude', 'native');
    expect(claude.support).toBe('native');
    expect(claude.verification).toBe(SkillAgentVerification.CONFIRMED);
    expect(claude.measured?.testedVersion).toBe('2.1.220');
    expect(claude.measured?.discoveryRoots).toEqual([SKILL_CLAUDE_INSTALL_ROOT_PREFIX]);
  });

  it('keeps the publisher evidence string alongside the measurement', () => {
    const claude = view('claude', 'native', 'Publisher ran the conformance suite.');
    expect(claude.evidence).toBe('Publisher ran the conformance suite.');
    expect(claude.measured?.evidenceSource).toContain('github.com/Kewton/CommandMate');
  });

  it('surfaces both axes separately, so a discovered-but-unlisted Skill reads as such', () => {
    const codex = view('codex', 'native');
    expect(codex.measured?.discovery.outcome).toBe('verified');
    expect(codex.measured?.invocation.outcome).toBe('unsupported');
    expect(codex.measured?.invocation.limitationKey).toEqual(expect.any(String));
    // The support verdict still says native: it runs, it just is not in the palette.
    expect(codex.support).toBe('native');
  });

  it('never raises a declaration to match a stronger measurement', () => {
    // Only the publisher can widen what their package claims. CommandMate says
    // the declaration has fallen behind instead of rewriting it.
    const modest = view('claude', 'unknown');
    expect(modest.support).toBe('unknown');
    expect(modest.declaredSupport).toBe('unknown');
    expect(modest.verification).toBe(SkillAgentVerification.STALE_DECLARATION);
    // The measurement is still attached, so the user can see the discrepancy.
    expect(modest.measured?.discovery.outcome).toBe('verified');
  });

  it('marks an unmeasured Agent unverified and says why, without downgrading it', () => {
    const gemini = view('gemini', 'native');
    expect(gemini.support).toBe('native');
    expect(gemini.measured).toBeNull();
    expect(gemini.verification).toBe(SkillAgentVerification.UNVERIFIED);
    expect(gemini.skipReasonKey).toEqual(expect.any(String));
  });

  it('gives an Agent id that is not a CLI tool the unverified treatment, not a crash', () => {
    const stranger = view('not-an-agent', 'unknown');
    expect(stranger.measured).toBeNull();
    expect(stranger.verification).toBe(SkillAgentVerification.UNVERIFIED);
    expect(stranger.reloadKey).toEqual(expect.any(String));
  });

  it('always offers a reload instruction, measured or not', () => {
    for (const agent of ['claude', 'codex', 'gemini', 'opencode']) {
      expect(view(agent, 'unknown').reloadKey, agent).toMatch(/^skills\.compatibility\.reload\./);
    }
  });

  it('reports staleness from the instant it is given, not from the clock', () => {
    const fresh = view('claude', 'native');
    expect(fresh.measured?.stale).toBe(false);
    expect(fresh.measured?.ageDays).toBe(1);

    const later = reconcileAgentSupport(
      { agent: 'claude', support: 'native', evidence: 'x' },
      new Date('2030-01-01T00:00:00Z')
    );
    expect(later.measured?.stale).toBe(true);
  });
});

describe('resolveSkillVersions', () => {
  const range = '>=0.11.0 <1.0.0';

  it('sorts versions newest first by SemVer precedence', () => {
    const entry = makeEntry('1.10.0', [
      makeVersion('1.2.0', range),
      makeVersion('1.10.0', range),
      makeVersion('1.9.0', range),
    ]);
    const result = resolveSkillVersions(entry, { currentVersion: '0.11.4' });
    expect(result.versions.map((v) => v.version.version)).toEqual(['1.10.0', '1.9.0', '1.2.0']);
  });

  it('excludes prereleases unless they are explicitly requested', () => {
    const entry = makeEntry('1.0.0', [
      makeVersion('1.0.0', range),
      makeVersion('1.1.0-beta.1', range),
    ]);

    const without = resolveSkillVersions(entry, { currentVersion: '0.11.4' });
    expect(without.versions.map((v) => v.version.version)).toEqual(['1.0.0']);

    const withPrerelease = resolveSkillVersions(entry, {
      currentVersion: '0.11.4',
      includePrerelease: true,
    });
    expect(withPrerelease.versions.map((v) => v.version.version)).toEqual([
      '1.1.0-beta.1',
      '1.0.0',
    ]);
    expect(withPrerelease.versions[0].prerelease).toBe(true);
  });

  it('recommends the highest compatible version, skipping newer incompatible ones', () => {
    const entry = makeEntry('2.0.0', [
      makeVersion('1.0.0', '>=0.11.0 <1.0.0'),
      makeVersion('2.0.0', '>=1.0.0'),
    ]);
    const result = resolveSkillVersions(entry, { currentVersion: '0.11.4' });
    expect(result.recommended?.version.version).toBe('1.0.0');
    expect(result.reasonCode).toBe(SkillRecommendationReason.HIGHEST_COMPATIBLE);
  });

  it('recommends nothing when every version is incompatible', () => {
    const entry = makeEntry('2.0.0', [makeVersion('2.0.0', '>=1.0.0')]);
    const result = resolveSkillVersions(entry, { currentVersion: '0.11.4' });
    expect(result.recommended).toBeNull();
    expect(result.reasonCode).toBe(SkillRecommendationReason.NONE_COMPATIBLE);
    expect(result.versions[0].compatibility.status).toBe('incompatible');
  });

  it('offers the publisher latest as unverified when the host version is unknown', () => {
    const entry = makeEntry('1.0.0', [makeVersion('1.0.0', range), makeVersion('2.0.0', range)]);
    const result = resolveSkillVersions(entry, { currentVersion: null });
    expect(result.recommended?.version.version).toBe('1.0.0');
    expect(result.reasonCode).toBe(SkillRecommendationReason.LATEST_UNVERIFIED);
    expect(result.recommended?.compatibility.status).toBe('unknown');
  });

  it('reports no versions when filtering removes them all', () => {
    const entry = makeEntry('1.0.0-beta.1', [makeVersion('1.0.0-beta.1', range)]);
    const result = resolveSkillVersions(entry, { currentVersion: '0.11.4' });
    expect(result.versions).toEqual([]);
    expect(result.recommended).toBeNull();
    expect(result.reasonCode).toBe(SkillRecommendationReason.NO_VERSIONS);
  });
});

describe('findSkillCatalogEntry', () => {
  const catalog: SkillCatalog = {
    schema_version: 1,
    entries: [makeEntry('1.0.0', [makeVersion('1.0.0', '>=0.11.0')])],
  };

  it('finds an entry by exact id', () => {
    expect(findSkillCatalogEntry(catalog, 'release-notes')?.id).toBe('release-notes');
  });

  it('does not match on case-folded or partial ids', () => {
    expect(findSkillCatalogEntry(catalog, 'Release-Notes')).toBeNull();
    expect(findSkillCatalogEntry(catalog, 'release')).toBeNull();
  });
});
