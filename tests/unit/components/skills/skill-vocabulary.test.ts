/**
 * Skill Catalog display vocabulary (Issue #1232)
 *
 * The invariants here are the ones a rendered-output test cannot prove on its
 * own: that `unknown` never borrows the compatible styling, and that Catalog
 * text can never make the browser reach an external host.
 */

import { describe, it, expect } from 'vitest';
import {
  COMPATIBILITY_BADGE_VARIANT,
  RISK_BADGE_VARIANT,
  catalogReasonLabelKey,
  collectAgentOptions,
  filterSkills,
  headlineDeclaredRisk,
  matchesSkillQuery,
  resolveSkillMessageKey,
  stripRemoteMedia,
  supportedAgents,
  EMPTY_SKILL_FILTERS,
} from '@/components/skills/skill-vocabulary';
import { makeIncompatibleSkill, makeSkill, makeUnknownSkill, makeVersion } from './fixtures';

describe('compatibility styling', () => {
  it('never gives unknown the same variant as compatible', () => {
    expect(COMPATIBILITY_BADGE_VARIANT.unknown).not.toBe(COMPATIBILITY_BADGE_VARIANT.compatible);
  });

  it('gives each of the three verdicts a distinct variant', () => {
    const variants = Object.values(COMPATIBILITY_BADGE_VARIANT);
    expect(new Set(variants).size).toBe(variants.length);
  });

  it('never renders a declared risk level as success', () => {
    expect(Object.values(RISK_BADGE_VARIANT)).not.toContain('success');
  });

  it('distinguishes high risk from the lower levels', () => {
    expect(RISK_BADGE_VARIANT.high).not.toBe(RISK_BADGE_VARIANT.low);
    expect(RISK_BADGE_VARIANT.high).not.toBe(RISK_BADGE_VARIANT.moderate);
  });
});

describe('resolveSkillMessageKey', () => {
  it('strips the namespace off a contract-supplied key', () => {
    expect(resolveSkillMessageKey('skills.compatibility.native')).toBe('compatibility.native');
  });

  it('leaves an already-relative key alone', () => {
    expect(resolveSkillMessageKey('compatibility.native')).toBe('compatibility.native');
  });
});

describe('catalogReasonLabelKey', () => {
  it('maps each stale reason to its own label key', () => {
    expect(catalogReasonLabelKey('SKILL_CATALOG_RATE_LIMITED')).toBe('catalog.reason.rateLimited');
    expect(catalogReasonLabelKey('SKILL_CATALOG_INVALID_SCHEMA')).toBe(
      'catalog.reason.invalidSchema'
    );
  });

  it('falls back to an explicit unknown rather than an empty string', () => {
    expect(catalogReasonLabelKey(null)).toBe('catalog.reason.unknown');
    expect(catalogReasonLabelKey('SOMETHING_NEW')).toBe('catalog.reason.unknown');
  });
});

describe('stripRemoteMedia', () => {
  it('removes a markdown image but keeps its alt text', () => {
    expect(stripRemoteMedia('before ![a pixel](https://tracker.invalid/p.gif) after')).toBe(
      'before a pixel after'
    );
  });

  it('removes raw media tags that would issue a request', () => {
    const input = '<img src="https://tracker.invalid/p.gif"><iframe src="https://evil.invalid">x';
    const output = stripRemoteMedia(input);
    expect(output).not.toContain('tracker.invalid');
    expect(output).not.toContain('<iframe');
    expect(output).toContain('x');
  });

  it.each(['<video src="https://a.invalid/v.mp4">', '<audio src="https://a.invalid/a.mp3">', '<embed src="https://a.invalid/e">'])(
    'removes %s',
    (tag) => {
      expect(stripRemoteMedia(tag)).not.toContain('a.invalid');
    }
  );

  it('leaves ordinary markdown links intact, since they load nothing until clicked', () => {
    const input = 'see [the docs](https://example.invalid/docs)';
    expect(stripRemoteMedia(input)).toBe(input);
  });

  it('leaves text with no media untouched', () => {
    expect(stripRemoteMedia('## Changes\n\n- fixed a thing')).toBe('## Changes\n\n- fixed a thing');
  });
});

describe('matchesSkillQuery', () => {
  const skill = makeSkill();

  it.each(['release', 'RELEASE', 'checklist', 'CommandMate', 'release-helper'])(
    'matches %s across name, summary, keywords, provider and id',
    (query) => {
      expect(matchesSkillQuery(skill, query)).toBe(true);
    }
  );

  it('does not match an unrelated term', () => {
    expect(matchesSkillQuery(skill, 'kubernetes')).toBe(false);
  });

  it('treats an empty query as no filter', () => {
    expect(matchesSkillQuery(skill, '   ')).toBe(true);
  });
});

describe('headlineDeclaredRisk / supportedAgents', () => {
  it('reports the recommended version risk rather than the first listed one', () => {
    const skill = makeSkill({
      recommendedVersion: '1.0.0',
      versions: [
        makeVersion({ version: '2.0.0', declaredRisk: 'high' }),
        makeVersion({ version: '1.0.0', declaredRisk: 'low' }),
      ],
    });
    expect(headlineDeclaredRisk(skill)).toBe('low');
  });

  it('excludes agents that are only claimed as unsupported or unknown', () => {
    expect(supportedAgents(makeIncompatibleSkill())).toEqual([]);
    expect(supportedAgents(makeSkill())).toEqual(['claude']);
  });
});

describe('filterSkills', () => {
  const skills = [makeSkill(), makeIncompatibleSkill(), makeUnknownSkill()];

  it('returns everything when nothing is filtered', () => {
    expect(filterSkills(skills, EMPTY_SKILL_FILTERS)).toHaveLength(3);
  });

  it('never returns an unknown-compatibility Skill under the compatible filter', () => {
    const result = filterSkills(skills, { ...EMPTY_SKILL_FILTERS, compatibility: 'compatible' });
    expect(result.map((s) => s.id)).toEqual(['release-helper']);
  });

  it('filters by declared risk', () => {
    const result = filterSkills(skills, { ...EMPTY_SKILL_FILTERS, risk: 'high' });
    expect(result.map((s) => s.id)).toEqual(['future-skill']);
  });

  it('filters by agent support', () => {
    const result = filterSkills(skills, { ...EMPTY_SKILL_FILTERS, agent: 'claude' });
    expect(result.map((s) => s.id)).toEqual(['release-helper']);
  });

  it('combines search with filters', () => {
    const result = filterSkills(skills, {
      ...EMPTY_SKILL_FILTERS,
      query: 'mystery',
      compatibility: 'unknown',
    });
    expect(result.map((s) => s.id)).toEqual(['mystery-skill']);
  });

  it('collects every named agent for the filter options, including unsupported claims', () => {
    expect(collectAgentOptions(skills)).toEqual(['claude', 'codex']);
  });
});
