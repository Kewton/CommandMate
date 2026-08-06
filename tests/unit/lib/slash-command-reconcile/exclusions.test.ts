/**
 * Curation exclusions (Issue #1704).
 *
 * The exclusion list exists because the *intent* to keep a command out lived
 * only in test assertions, which `catalog:refresh` cannot read: v0.21.2, v0.21.3
 * and v0.21.4 each re-proposed the same three commands. These tests cover the
 * data contract (a decision without a traceable reason is not a decision), the
 * engine honoring it, and the tool-scoped granularity that keeps a ban on one
 * CLI from hiding a real command on another.
 *
 * @vitest-environment node
 */

import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_EXCLUSIONS,
  EXCLUSION_KINDS,
  MIN_EXCLUSION_REASON_LENGTH,
  buildExclusionIndex,
  describeExclusion,
  findExclusion,
  parseExclusions,
} from '@/lib/slash-command-reconcile/exclusions';
import { reconcileCatalog } from '@/lib/slash-command-reconcile/engine';
import type {
  CatalogExclusion,
  ProviderResult,
  SlashCommandsCatalog,
} from '@/lib/slash-command-reconcile/types';

const EXCLUSIONS_PATH = path.resolve(
  __dirname,
  '../../../../src/config/slash-commands-exclusions.json'
);

function emptyCatalog(): SlashCommandsCatalog {
  return { verifiedAgainst: {}, frequentlyUsed: {}, commands: [] };
}

function valid(overrides: Partial<CatalogExclusion> = {}): CatalogExclusion {
  return {
    name: 'schedule',
    cliTools: ['claude'],
    kind: 'out-of-scope',
    reason: 'Out of scope for the palette by an explicit product decision.',
    issue: 1488,
    ...overrides,
  };
}

function source(tool: string, commands: ProviderResult['commands']): ProviderResult {
  return { tool, ok: true, commands, warnings: [] };
}

describe('parseExclusions', () => {
  it('accepts a well-formed row', () => {
    expect(parseExclusions({ exclusions: [valid()] })).toEqual([valid()]);
  });

  it('accepts an empty list', () => {
    expect(parseExclusions({ exclusions: [] })).toEqual([]);
  });

  it.each([
    ['not an object', 'file must be a JSON object'],
    [{}, '"exclusions" must be an array'],
    [{ exclusions: {} }, '"exclusions" must be an array'],
  ])('rejects a malformed file shape (%#)', (raw, message) => {
    expect(() => parseExclusions(raw)).toThrow(message);
  });

  // Each field is required for a reason, so each has its own guard.
  it('requires a valid command name', () => {
    expect(() => parseExclusions({ exclusions: [valid({ name: '' })] })).toThrow('name');
    expect(() => parseExclusions({ exclusions: [valid({ name: '/schedule' })] })).toThrow(
      'not a valid command name'
    );
  });

  // A name-wide ban is deliberately not expressible: v0.21.2 had to narrow the
  // /vim ban from the name to claude once codex turned out to ship a real /vim.
  it('requires a non-empty cliTools scope', () => {
    expect(() => parseExclusions({ exclusions: [valid({ cliTools: [] })] })).toThrow(
      'name-wide exclusions are not expressible'
    );
    expect(() =>
      parseExclusions({ exclusions: [valid({ cliTools: undefined as unknown as string[] })] })
    ).toThrow('cliTools');
    expect(() =>
      parseExclusions({ exclusions: [valid({ cliTools: ['claude', 'claude'] })] })
    ).toThrow('twice');
  });

  it('requires a kind from the closed set', () => {
    expect(() =>
      parseExclusions({ exclusions: [valid({ kind: 'because-i-said-so' as never })] })
    ).toThrow('kind must be one of');
    for (const kind of EXCLUSION_KINDS) {
      expect(parseExclusions({ exclusions: [valid({ kind })] })[0].kind).toBe(kind);
    }
  });

  it('requires a reason long enough to actually explain the decision', () => {
    expect(() => parseExclusions({ exclusions: [valid({ reason: 'no' })] })).toThrow('too short');
    expect(() => parseExclusions({ exclusions: [valid({ reason: '' })] })).toThrow('reason');
    const justLongEnough = 'x'.repeat(MIN_EXCLUSION_REASON_LENGTH);
    expect(parseExclusions({ exclusions: [valid({ reason: justLongEnough })] })).toHaveLength(1);
  });

  it('requires a positive integer issue number', () => {
    for (const issue of [0, -1, 1.5, '1488' as unknown as number]) {
      expect(() => parseExclusions({ exclusions: [valid({ issue })] })).toThrow('issue');
    }
  });

  it('rejects two rows excluding the same command on the same tool', () => {
    expect(() =>
      parseExclusions({
        exclusions: [valid({ cliTools: ['claude', 'codex'] }), valid({ cliTools: ['codex'] })],
      })
    ).toThrow('duplicate exclusion for /schedule on codex');
  });

  it('allows the same name excluded on different tools by separate decisions', () => {
    expect(
      parseExclusions({
        exclusions: [
          valid({ cliTools: ['claude'], issue: 1488 }),
          valid({ cliTools: ['codex'], kind: 'phantom', issue: 1503 }),
        ],
      })
    ).toHaveLength(2);
  });
});

describe('the shipped exclusions file', () => {
  it('parses, and DEFAULT_EXCLUSIONS is exactly what is on disk', () => {
    const onDisk = parseExclusions(JSON.parse(fs.readFileSync(EXCLUSIONS_PATH, 'utf8')));
    expect(DEFAULT_EXCLUSIONS).toEqual(onDisk);
  });

  // The two decisions confirmed on Issue #1704. Both are claude-scoped: neither
  // says anything about the same name on another CLI.
  it('carries the confirmed decisions with their kind and issue', () => {
    const byName = new Map(DEFAULT_EXCLUSIONS.map((e) => [e.name, e]));

    expect(byName.get('ultraplan')).toMatchObject({
      cliTools: ['claude'],
      kind: 'phantom',
      issue: 1503,
    });
    expect(byName.get('schedule')).toMatchObject({
      cliTools: ['claude'],
      kind: 'out-of-scope',
      issue: 1488,
    });
  });

  // Deliberate absence, not an oversight (Issue #1704). Upstream changed: the
  // "(removed)" stub #1503 purged is now a row with a real description, so
  // whether claude's /agents belongs in the palette is an *open* decision.
  // Listing it here would silence the proposal and hide the open question; the
  // recurring line in `catalog:refresh --check` is the signal that it exists.
  it('does not list /agents, whose exclusion is not settled', () => {
    expect(DEFAULT_EXCLUSIONS.some((e) => e.name === 'agents')).toBe(false);
  });
});

describe('reconcileCatalog with exclusions', () => {
  const claudeUltraplan = source('claude', [{ name: 'ultraplan', description: 'Plan deeply' }]);

  it('does not add an excluded command, and says why', () => {
    const result = reconcileCatalog(emptyCatalog(), [claudeUltraplan], {
      exclusions: [valid({ name: 'ultraplan', kind: 'phantom', issue: 1503 })],
    });

    expect(result.diff.added).toEqual([]);
    expect(result.catalog.commands).toEqual([]);
    expect(result.localeAdditions).toEqual([]);
    expect(result.changed).toBe(false);

    const notice = result.notices.find((n) => n.name === 'ultraplan');
    expect(notice?.category).toBe('excluded');
    expect(notice?.tool).toBe('claude');
    expect(notice?.message).toContain('#1503');
    expect(notice?.message).toContain('phantom');
  });

  // Control: without the list the command is added. Without this, the assertion
  // above would still pass if the source had simply stopped listing it.
  it('adds the very same command when it is not excluded', () => {
    const result = reconcileCatalog(emptyCatalog(), [claudeUltraplan], { exclusions: [] });
    expect(result.diff.added.map((a) => a.name)).toEqual(['ultraplan']);
  });

  // Issue #1704 requirement 1: exclusions are tool-scoped. A name-wide ban would
  // hide codex's real /vim, which is exactly what v0.21.2 had to undo.
  it('excludes per cliTool: /vim stays off claude and still lands for codex', () => {
    const result = reconcileCatalog(
      emptyCatalog(),
      [
        source('claude', [{ name: 'vim', description: 'Enter Vim mode' }]),
        source('codex', [{ name: 'vim', description: 'toggle Vim mode for the composer' }]),
      ],
      {
        exclusions: [
          valid({
            name: 'vim',
            cliTools: ['claude'],
            kind: 'phantom',
            issue: 1503,
            reason: 'Removed upstream in claude 2.1.92; codex still ships a real /vim.',
          }),
        ],
      }
    );

    expect(result.diff.added.map((a) => [a.tool, a.name])).toEqual([['codex', 'vim']]);
    expect(result.catalog.commands.map((c) => c.cliTools)).toEqual([['codex']]);
    expect(result.notices.filter((n) => n.category === 'excluded').map((n) => n.tool)).toEqual([
      'claude',
    ]);
    // codex's own sentence owns the key — the claude-side exclusion does not
    // poison it (the same invariant Issue #1603 established for refused rows).
    expect(result.localeAdditions).toEqual([
      {
        key: 'slashCommands.descriptions.vim',
        en: 'toggle Vim mode for the composer',
        ja: '[要レビュー] toggle Vim mode for the composer',
      },
    ]);
  });

  // An exclusion is a human decision, so it outranks the source's own opinion of
  // the row and the notice is not doubled up with a lower-level refusal.
  it('reports an excluded command once, as excluded', () => {
    const result = reconcileCatalog(
      emptyCatalog(),
      [source('claude', [{ name: 'ultraplan', description: 'Removed', status: 'removed' }])],
      { exclusions: [valid({ name: 'ultraplan', kind: 'phantom', issue: 1503 })] }
    );
    expect(result.notices.map((n) => n.category)).toEqual(['excluded']);
  });

  // Catalog ∩ exclusions must be empty; if it is not, the run says so instead of
  // quietly leaving the contradiction in place.
  it('flags a command that is excluded yet still catalogued', () => {
    const catalog = emptyCatalog();
    catalog.commands.push({
      name: 'ultraplan',
      descriptionKey: 'slashCommands.descriptions.ultraplan',
      category: 'standard-util',
      cliTools: ['claude'],
      isStandard: true,
      source: 'standard',
    });
    const result = reconcileCatalog(catalog, [claudeUltraplan], {
      exclusions: [valid({ name: 'ultraplan', kind: 'phantom', issue: 1503 })],
    });

    expect(result.notices.find((n) => n.name === 'ultraplan')?.message).toContain(
      'the catalog still lists it'
    );
  });

  // A caller that forgets to pass exclusions must not silently lose the guard —
  // that failure mode is the whole reason the mechanism exists.
  it('honors the bundled list when no exclusions are passed', () => {
    const result = reconcileCatalog(emptyCatalog(), [
      source('claude', [
        { name: 'schedule', description: 'Create, update, list, or run routines' },
      ]),
    ]);
    expect(result.diff.added).toEqual([]);
    expect(result.notices.find((n) => n.name === 'schedule')?.category).toBe('excluded');
  });
});

describe('exclusion lookup helpers', () => {
  it('indexes by name and tool', () => {
    const index = buildExclusionIndex([
      valid({ name: 'vim', cliTools: ['claude'] }),
      valid({ name: 'schedule', cliTools: ['claude', 'codex'] }),
    ]);
    expect(findExclusion(index, 'vim', 'claude')?.name).toBe('vim');
    expect(findExclusion(index, 'vim', 'codex')).toBeUndefined();
    expect(findExclusion(index, 'schedule', 'codex')?.name).toBe('schedule');
    expect(findExclusion(index, 'unknown', 'claude')).toBeUndefined();
  });

  it('renders a notice message carrying the kind, the issue and the reason', () => {
    expect(describeExclusion(valid())).toBe(
      'excluded as out-of-scope (#1488): Out of scope for the palette by an explicit product decision.'
    );
  });
});
