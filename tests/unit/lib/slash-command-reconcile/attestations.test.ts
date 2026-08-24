/**
 * Source attestations (Issue #2026).
 *
 * The attestation record exists because the catalog pins described the old set
 * with literals — `toBe(244)`, `toBe(56)`, a hard-coded /agents claimant list —
 * so a *correct* addition (codex 0.149.0 really did ship /agents, /cd and /pwd)
 * turned them red exactly as loudly as a blind `--write`, and clearing the red
 * meant retyping a number whose evidence lived only in a commit message.
 *
 * These tests cover the data contract (a reading nobody can re-run is not a
 * reading), the four failure directions the pins have to keep — stated here as
 * injected mutations rather than as "it passed on today's catalog" — and the
 * drift signal that tells a run its recorded reading has expired.
 *
 * @vitest-environment node
 */

import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_ATTESTATIONS,
  MIN_ATTESTATION_SOURCE_LENGTH,
  attestedCatalogNames,
  attestedVersions,
  buildAttestationIndex,
  compareAttestationToSource,
  describeAttestationDrift,
  describeAttestationViolation,
  findAttestationViolations,
  hasAttestationDrift,
  parseAttestations,
  toolsOfCommand,
  type ToolScopedCommand,
} from '@/lib/slash-command-reconcile/attestations';
import type {
  CatalogAttestation,
  CatalogExclusion,
} from '@/lib/slash-command-reconcile/types';

const ATTESTATIONS_PATH = path.resolve(
  __dirname,
  '../../../../src/config/slash-commands-attestations.json'
);

function valid(overrides: Partial<CatalogAttestation> = {}): CatalogAttestation {
  return {
    tool: 'codex',
    version: '0.149.1',
    source: 'openai/codex codex-rs/tui/src/slash_command.rs at tag rust-v0.149.1',
    observedAt: '2026-08-24',
    issue: 2026,
    commands: ['clear', 'diff', 'status'],
    ...overrides,
  };
}

describe('parseAttestations', () => {
  it('accepts a well-formed row', () => {
    expect(parseAttestations({ attestations: [valid()] })).toEqual([valid()]);
  });

  it.each([
    ['not an object', 'file must be a JSON object'],
    [{}, '"attestations" must be an array'],
    [{ attestations: {} }, '"attestations" must be an array'],
  ])('rejects a malformed file shape (%#)', (raw, message) => {
    expect(() => parseAttestations(raw)).toThrow(message);
  });

  // Unlike the exclusions file, an empty one is not a valid state: an empty
  // exclusions list means "we excluded nothing", while an empty attestation list
  // means "nobody has read any source", which would silently make every
  // catalog-side guard vacuous.
  it('rejects an empty list', () => {
    expect(() => parseAttestations({ attestations: [] })).toThrow('must not be empty');
  });

  it('requires a tool id', () => {
    expect(() => parseAttestations({ attestations: [valid({ tool: '' })] })).toThrow('tool');
  });

  it('requires a major.minor.patch version', () => {
    for (const version of ['', 'latest', '1.0', 'v1.0.0']) {
      expect(() => parseAttestations({ attestations: [valid({ version })] })).toThrow('version');
    }
  });

  // The field has to be an instruction for re-running the measurement. A short
  // one ("docs") passes a non-empty check and leaves the next reader exactly
  // where #2024 was — re-deriving which document said what.
  it('requires a source long enough to re-run the measurement from', () => {
    expect(() => parseAttestations({ attestations: [valid({ source: 'docs' })] })).toThrow(
      'too short'
    );
    const justLongEnough = 'x'.repeat(MIN_ATTESTATION_SOURCE_LENGTH);
    expect(parseAttestations({ attestations: [valid({ source: justLongEnough })] })).toHaveLength(1);
  });

  // Load-bearing for a source that is not version-pinned: the claude docs page
  // is live, so "claude 2.1.218" alone does not identify a document.
  it('requires an ISO date for observedAt', () => {
    for (const observedAt of ['', '2026-8-24', 'yesterday', '24/08/2026']) {
      expect(() => parseAttestations({ attestations: [valid({ observedAt })] })).toThrow(
        'observedAt'
      );
    }
  });

  it('requires a positive integer issue number', () => {
    for (const issue of [0, -1, 1.5, '2026' as unknown as number]) {
      expect(() => parseAttestations({ attestations: [valid({ issue })] })).toThrow('issue');
    }
  });

  it('requires a non-empty list of valid command names', () => {
    expect(() => parseAttestations({ attestations: [valid({ commands: [] })] })).toThrow(
      'non-empty array'
    );
    expect(() => parseAttestations({ attestations: [valid({ commands: ['/clear'] })] })).toThrow(
      'not a valid command name'
    );
  });

  // The list is reviewed as a diff at release time. An append-at-the-end habit
  // turns "three commands arrived" into a diff nobody can read at a glance,
  // which is the cost this whole record exists to remove.
  it('requires the command list to be sorted and duplicate-free', () => {
    expect(() =>
      parseAttestations({ attestations: [valid({ commands: ['status', 'clear'] })] })
    ).toThrow('must be sorted');
    expect(() =>
      parseAttestations({ attestations: [valid({ commands: ['clear', 'clear'] })] })
    ).toThrow('twice');
  });

  it('rejects two attestations for the same tool', () => {
    expect(() => parseAttestations({ attestations: [valid(), valid()] })).toThrow(
      'duplicate attestation for codex'
    );
  });

  // A bad row throws instead of being skipped, for the reason exclusions.ts
  // throws: an attestation that vanishes quietly takes its guard with it.
  it('throws rather than skipping the bad row', () => {
    expect(() =>
      parseAttestations({ attestations: [valid(), valid({ tool: 'claude', version: 'nope' })] })
    ).toThrow('attestations[1].version');
  });
});

describe('the shipped attestations file', () => {
  it('parses, and DEFAULT_ATTESTATIONS is what the file says', () => {
    const raw = JSON.parse(fs.readFileSync(ATTESTATIONS_PATH, 'utf8'));
    expect(parseAttestations(raw)).toEqual(DEFAULT_ATTESTATIONS);
  });

  // The decision prose is the point of the file (Issue #1704 set the pattern):
  // without it the next reader re-derives why the pins read this instead of a
  // number, which is the recurrence #2024 documented.
  it('carries the $comment explaining what the record is for', () => {
    const raw = JSON.parse(fs.readFileSync(ATTESTATIONS_PATH, 'utf8')) as {
      $comment?: unknown;
    };
    expect(Array.isArray(raw.$comment)).toBe(true);
    expect((raw.$comment as string[]).join('\n')).toContain('excluded');
  });

  it('exposes one version per tool', () => {
    const versions = attestedVersions(DEFAULT_ATTESTATIONS);
    expect(Object.keys(versions).sort()).toEqual(DEFAULT_ATTESTATIONS.map((a) => a.tool).sort());
    for (const attestation of DEFAULT_ATTESTATIONS) {
      expect(versions[attestation.tool]).toBe(attestation.version);
    }
  });
});

describe('attestedCatalogNames', () => {
  const attestation = valid({ commands: ['clear', 'diff', 'status'] });
  const excludeDiff: CatalogExclusion[] = [
    {
      name: 'diff',
      cliTools: ['codex'],
      kind: 'out-of-scope',
      reason: 'A curation decision recorded for this test, long enough to explain itself.',
      issue: 2026,
    },
  ];

  it('subtracts exclusions scoped to that tool', () => {
    expect(attestedCatalogNames(attestation, excludeDiff)).toEqual(['clear', 'status']);
  });

  // Tool scoping is the whole point of the exclusions shape (v0.21.2 had to
  // narrow the /vim ban from the name to claude): an exclusion for another tool
  // must not shrink this tool's expected set.
  it('ignores an exclusion scoped to a different tool', () => {
    const forClaude = excludeDiff.map((e) => ({ ...e, cliTools: ['claude'] }));
    expect(attestedCatalogNames(attestation, forClaude)).toEqual(['clear', 'diff', 'status']);
  });
});

/**
 * The four directions the pins have to fail in, injected one at a time.
 *
 * "It passed on today's catalog" is compatible with a comparator that never
 * fails, so each property is stated as a mutation with an expected verdict.
 */
describe('findAttestationViolations — the four properties', () => {
  const attestations: CatalogAttestation[] = [
    valid({ tool: 'codex', commands: ['clear', 'diff', 'status'] }),
    valid({ tool: 'claude', version: '2.1.218', commands: ['clear', 'schedule'] }),
  ];
  const exclusions: CatalogExclusion[] = [
    {
      name: 'schedule',
      cliTools: ['claude'],
      kind: 'out-of-scope',
      reason: 'Real upstream, deliberately not surfaced — the /schedule case, in miniature.',
      issue: 1488,
    },
  ];
  /** A catalog that matches those attestations exactly. */
  const catalog: ToolScopedCommand[] = [
    { name: 'clear', cliTools: ['claude', 'codex'] },
    { name: 'diff', cliTools: ['codex'] },
    { name: 'status', cliTools: ['codex'] },
  ];
  const check = (commands: ToolScopedCommand[]) =>
    findAttestationViolations(commands, { attestations, exclusions });

  it('property 2: catalog and attestation moving together is green', () => {
    expect(check(catalog)).toEqual([]);
  });

  it('property 1: the catalog growing without the attestation is red', () => {
    expect(check([...catalog, { name: 'pwd', cliTools: ['codex'] }])).toEqual([
      { kind: 'unattested', tool: 'codex', name: 'pwd' },
    ]);
  });

  // Same verdict, different story: #1503's /agents came from a docs stub, so no
  // source ever enumerated it. A count pin could only say "one too many".
  it('property 3: a name no source enumerated is red, and says which one', () => {
    const violations = check([...catalog, { name: 'agents', cliTools: ['claude'] }]);
    expect(violations.map(describeAttestationViolation)).toEqual([
      '[claude] /agents is in the catalog but not attested',
    ]);
  });

  it('property 4: an attested name disappearing is red', () => {
    expect(check(catalog.filter((c) => c.name !== 'status'))).toEqual([
      { kind: 'missing', tool: 'codex', name: 'status' },
    ]);
  });

  // Property 4 must not fire on a settled curation decision, and the exclusion
  // must be what stops it — not an accident of the expected set.
  it('does not fire on a command that is attested but excluded', () => {
    expect(check(catalog)).toEqual([]);
    expect(findAttestationViolations(catalog, { attestations, exclusions: [] })).toEqual([
      { kind: 'missing', tool: 'claude', name: 'schedule' },
    ]);
  });

  // An excluded command that is nonetheless shipped is a third kind of
  // disagreement, and reads better than "unattested" would.
  it('names an excluded command the catalog ships anyway', () => {
    const violations = check([...catalog, { name: 'schedule', cliTools: ['claude'] }]);
    expect(violations.map(describeAttestationViolation)).toEqual([
      '[claude] /schedule is in the catalog although it is excluded',
    ]);
  });

  // A tool nobody attested makes the whole comparison vacuous for that tool.
  it('flags a tool the catalog serves that no attestation covers', () => {
    const violations = check([...catalog, { name: 'undo', cliTools: ['copilot'] }]);
    expect(violations.map(describeAttestationViolation)).toEqual([
      '[copilot] no attestation covers this tool',
    ]);
  });

  // An entry that names no tool is Claude's (Issue #594 back-compat), the same
  // rule the engine's entryHasTool applies. Getting this wrong would quietly
  // drop the five cliTools-less rows out of every comparison.
  it('treats an entry with no cliTools as Claude-scoped', () => {
    expect(toolsOfCommand({ name: 'doctor' })).toEqual(['claude']);
    expect(check([{ name: 'clear' }, { name: 'diff', cliTools: ['codex'] }])).toEqual([
      { kind: 'missing', tool: 'codex', name: 'clear' },
      { kind: 'missing', tool: 'codex', name: 'status' },
    ]);
  });
});

describe('compareAttestationToSource', () => {
  const attestations = [valid({ tool: 'codex', commands: ['clear', 'diff', 'status'] })];

  it('reports nothing when the source still enumerates the attested set', () => {
    const drift = compareAttestationToSource('codex', ['status', 'clear', 'diff'], attestations);
    expect(drift).toEqual({ tool: 'codex', attested: true, unattested: [], vanished: [] });
    expect(hasAttestationDrift(drift)).toBe(false);
  });

  it('reports arrivals and departures separately', () => {
    const drift = compareAttestationToSource('codex', ['clear', 'diff', 'pwd'], attestations);
    expect(drift).toEqual({
      tool: 'codex',
      attested: true,
      unattested: ['pwd'],
      vanished: ['status'],
    });
    expect(hasAttestationDrift(drift)).toBe(true);
    expect(describeAttestationDrift(drift)).toBe(
      '[codex] source now lists /pwd; source no longer lists /status'
    );
  });

  // A removal upstream is the case that used to slip through entirely: nothing
  // is added, so `--write` reported no change, and the stamp it bumped by itself
  // re-dated a claim that had just stopped being true.
  it('reports a pure upstream removal, which adds no commands at all', () => {
    const drift = compareAttestationToSource('codex', ['clear', 'diff'], attestations);
    expect(drift.unattested).toEqual([]);
    expect(drift.vanished).toEqual(['status']);
    expect(hasAttestationDrift(drift)).toBe(true);
  });

  it('reports a tool with no attestation as unattested', () => {
    const drift = compareAttestationToSource('opencode', ['help'], attestations);
    expect(drift).toEqual({
      tool: 'opencode',
      attested: false,
      unattested: ['help'],
      vanished: [],
    });
    expect(describeAttestationDrift(drift)).toContain('no attestation covers this tool');
  });
});

describe('buildAttestationIndex', () => {
  it('looks a tool up by id', () => {
    const index = buildAttestationIndex(DEFAULT_ATTESTATIONS);
    for (const attestation of DEFAULT_ATTESTATIONS) {
      expect(index.get(attestation.tool)).toBe(attestation);
    }
    expect(index.get('nonexistent-tool')).toBeUndefined();
  });
});
