/**
 * Tests for the reconcile engine (Issue #1489).
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import {
  reconcileCatalog,
  formatNoticesForReport,
  isSuspectDescription,
} from '@/lib/slash-command-reconcile/engine';
import type {
  ProviderResult,
  SlashCommandsCatalog,
} from '@/lib/slash-command-reconcile/types';

function baseCatalog(): SlashCommandsCatalog {
  return {
    verifiedAgainst: { claude: '2.1.218', codex: '0.144.6' },
    frequentlyUsed: { claude: [], codex: [] },
    commands: [
      {
        name: 'loop',
        descriptionKey: 'slashCommands.descriptions.loop',
        category: 'standard-util',
        cliTools: ['claude'],
        isStandard: true,
        source: 'standard',
      },
      {
        name: 'status',
        descriptionKey: 'slashCommands.descriptions.status',
        category: 'standard-monitor',
        cliTools: ['claude', 'codex'],
        isStandard: true,
        source: 'standard',
      },
      {
        name: 'undo',
        descriptionKey: 'slashCommands.descriptions.undo',
        category: 'standard-session',
        cliTools: ['codex'],
        isStandard: true,
        source: 'standard',
      },
    ],
  };
}

const claudeOk: ProviderResult = {
  tool: 'claude',
  ok: true,
  commands: [
    { name: 'loop', description: 'Run a prompt repeatedly' },
    { name: 'status', description: 'Show status' },
    { name: 'focus', description: 'Toggle focus mode' },
  ],
  warnings: [],
};

const codexOk: ProviderResult = {
  tool: 'codex',
  ok: true,
  commands: [
    { name: 'status', description: 'Show status' },
    { name: 'fork', description: 'fork the current chat' },
  ],
  sourceVersion: '0.145.0',
  warnings: [],
};

const antigravitySkipped: ProviderResult = {
  tool: 'antigravity',
  ok: false,
  commands: [],
  warnings: ['antigravity provider not implemented yet'],
};

describe('reconcileCatalog', () => {
  it('adds only commands missing for a tool, with the correct shape', () => {
    const result = reconcileCatalog(baseCatalog(), [claudeOk, codexOk, antigravitySkipped]);

    const focus = result.catalog.commands.find(
      (c) => c.name === 'focus' && c.cliTools?.includes('claude')
    );
    expect(focus).toEqual({
      name: 'focus',
      descriptionKey: 'slashCommands.descriptions.focus',
      category: 'standard-util',
      cliTools: ['claude'],
      isStandard: true,
      source: 'standard',
    });

    const fork = result.catalog.commands.find((c) => c.name === 'fork');
    expect(fork?.cliTools).toEqual(['codex']);

    expect(result.diff.added.map((a) => `${a.tool}:${a.name}`).sort()).toEqual([
      'claude:focus',
      'codex:fork',
    ]);
  });

  it('is idempotent — an already-catalogued command is never re-added (no #1488 dupes)', () => {
    const first = reconcileCatalog(baseCatalog(), [claudeOk, codexOk, antigravitySkipped]);
    expect(first.diff.added.some((a) => a.name === 'loop')).toBe(false);

    // Re-run against the reconciled catalog: nothing new.
    const second = reconcileCatalog(first.catalog, [claudeOk, codexOk, antigravitySkipped]);
    expect(second.diff.added).toEqual([]);
    expect(second.changed).toBe(false);
  });

  it('reports catalog entries missing from a source without deleting them', () => {
    const result = reconcileCatalog(baseCatalog(), [claudeOk, codexOk, antigravitySkipped]);
    // codex source has no "undo"; it stays in the catalog but is reported.
    expect(result.diff.missingFromSource).toContainEqual({ tool: 'codex', name: 'undo' });
    expect(result.catalog.commands.some((c) => c.name === 'undo')).toBe(true);
  });

  it('stamps verifiedAgainst only for a version-pinned source', () => {
    const result = reconcileCatalog(baseCatalog(), [claudeOk, codexOk, antigravitySkipped]);
    expect(result.diff.verifiedAgainstUpdated).toEqual({
      codex: { from: '0.144.6', to: '0.145.0' },
    });
    expect(result.catalog.verifiedAgainst.codex).toBe('0.145.0');
    // claude has no sourceVersion → untouched.
    expect(result.catalog.verifiedAgainst.claude).toBe('2.1.218');
  });

  it('produces locale additions: en from source, ja review placeholder, deduped by key', () => {
    const result = reconcileCatalog(baseCatalog(), [claudeOk, codexOk, antigravitySkipped]);
    const focus = result.localeAdditions.find(
      (l) => l.key === 'slashCommands.descriptions.focus'
    );
    expect(focus).toEqual({
      key: 'slashCommands.descriptions.focus',
      en: 'Toggle focus mode',
      ja: '[要レビュー] Toggle focus mode',
    });
    // Existing keys (loop/status) are never re-emitted.
    expect(result.localeAdditions.some((l) => l.key.endsWith('.loop'))).toBe(false);
    expect(result.localeAdditions.some((l) => l.key.endsWith('.status'))).toBe(false);
  });

  it('emits one locale entry when two tools add the same new name', () => {
    const claudeNew: ProviderResult = {
      tool: 'claude',
      ok: true,
      commands: [{ name: 'shared', description: 'shared cmd' }],
      warnings: [],
    };
    const codexNew: ProviderResult = {
      tool: 'codex',
      ok: true,
      commands: [{ name: 'shared', description: 'shared cmd' }],
      warnings: [],
    };
    const result = reconcileCatalog(baseCatalog(), [claudeNew, codexNew]);

    // One catalog entry per tool scope…
    expect(result.catalog.commands.filter((c) => c.name === 'shared')).toHaveLength(2);
    // …but a single shared locale key.
    expect(
      result.localeAdditions.filter((l) => l.key === 'slashCommands.descriptions.shared')
    ).toHaveLength(1);
  });

  it('is fail-soft: a failed provider changes nothing for its tool', () => {
    const claudeDown: ProviderResult = {
      tool: 'claude',
      ok: false,
      commands: [],
      warnings: ['claude fetch failed'],
    };
    const result = reconcileCatalog(baseCatalog(), [claudeDown, codexOk]);

    expect(result.diff.added.some((a) => a.tool === 'claude')).toBe(false);
    expect(result.diff.added.map((a) => a.name)).toEqual(['fork']);
    expect(result.warnings).toContain('claude fetch failed');
  });

  it('does not mutate the input catalog', () => {
    const input = baseCatalog();
    reconcileCatalog(input, [claudeOk, codexOk]);
    expect(input.commands).toHaveLength(3);
    expect(input.verifiedAgainst.codex).toBe('0.144.6');
  });

  it('honors a custom defaultCategory for new commands', () => {
    const result = reconcileCatalog(baseCatalog(), [claudeOk], { defaultCategory: 'standard-config' });
    expect(result.catalog.commands.find((c) => c.name === 'focus')?.category).toBe(
      'standard-config'
    );
  });
});

// Issue #1603: an authoritative source lists more than its current commands.
describe('reconcileCatalog — active/canonical filter', () => {
  const withRows = (...commands: ProviderResult['commands']): ProviderResult => ({
    tool: 'claude',
    ok: true,
    commands,
    warnings: [],
  });

  it('never adds a row the source marks as removed, and says why', () => {
    const result = reconcileCatalog(baseCatalog(), [
      withRows(
        { name: 'vim', description: 'Removed in v2.1.92', maxVersion: '2.1.91', status: 'removed' },
        { name: 'focus', description: 'Toggle focus mode' }
      ),
    ]);

    expect(result.diff.added.map((a) => a.name)).toEqual(['focus']);
    expect(result.catalog.commands.some((c) => c.name === 'vim')).toBe(false);
    expect(result.localeAdditions.some((l) => l.key.endsWith('.vim'))).toBe(false);

    const notice = result.notices.find((n) => n.name === 'vim');
    expect(notice?.category).toBe('removed-row');
    expect(notice?.message).toContain('2.1.91');
  });

  it('never adds an alias row, and says which command it points at', () => {
    const result = reconcileCatalog(baseCatalog(), [
      withRows({ name: 'cost', description: 'Alias for /usage', aliasOf: 'usage' }),
    ]);

    expect(result.diff.added).toEqual([]);
    expect(result.changed).toBe(false);
    expect(result.notices).toContainEqual({
      category: 'alias-row',
      tool: 'claude',
      name: 'cost',
      message: 'alias for /usage; not added',
    });
  });

  it('reports a refused row that the catalog still ships, without deleting it', () => {
    const result = reconcileCatalog(baseCatalog(), [
      withRows({ name: 'loop', description: 'Removed in v9.9.9', status: 'removed' }),
    ]);

    expect(result.catalog.commands.some((c) => c.name === 'loop')).toBe(true);
    expect(result.notices.find((n) => n.name === 'loop')?.message).toContain(
      'the catalog still lists it'
    );
  });

  it('drops a marker-like description but keeps the command', () => {
    const result = reconcileCatalog(baseCatalog(), [
      withRows({ name: 'simplify', description: 'Skill' }),
    ]);

    expect(result.diff.added.map((a) => a.name)).toEqual(['simplify']);
    expect(result.diff.added[0].enDescription).toBeUndefined();
    expect(result.localeAdditions).toContainEqual({
      key: 'slashCommands.descriptions.simplify',
      en: 'simplify',
      ja: '[要レビュー] simplify',
    });
    expect(result.notices.find((n) => n.name === 'simplify')?.category).toBe(
      'suspect-description'
    );
  });

  it('refuses to let one tool\'s description win an i18n key another tool shares', () => {
    const claudeSide: ProviderResult = {
      tool: 'claude',
      ok: true,
      commands: [{ name: 'vim', description: 'Enter Vim mode' }],
      warnings: [],
    };
    const codexSide: ProviderResult = {
      tool: 'codex',
      ok: true,
      commands: [{ name: 'vim', description: 'toggle vim keybindings in the composer' }],
      warnings: [],
    };
    const result = reconcileCatalog(baseCatalog(), [claudeSide, codexSide]);

    const locale = result.localeAdditions.filter(
      (l) => l.key === 'slashCommands.descriptions.vim'
    );
    expect(locale).toHaveLength(1);
    // Neither sentence is shipped under the shared key.
    expect(locale[0]).toEqual({
      key: 'slashCommands.descriptions.vim',
      en: 'vim',
      ja: '[要レビュー] vim',
    });
    expect(result.notices.find((n) => n.category === 'description-conflict')?.name).toBe('vim');
    // Both tools still get their catalog entry.
    expect(result.catalog.commands.filter((c) => c.name === 'vim')).toHaveLength(2);
  });

  it('reports one conflict per key, not one per extra tool', () => {
    const three: ProviderResult[] = ['claude', 'codex', 'antigravity'].map((tool, i) => ({
      tool,
      ok: true,
      commands: [{ name: 'vim', description: `description ${i}` }],
      warnings: [],
    }));
    const result = reconcileCatalog(baseCatalog(), three);
    expect(result.notices.filter((n) => n.category === 'description-conflict')).toHaveLength(1);
  });
});

describe('isSuspectDescription', () => {
  it('flags badge leftovers and self-referential markers', () => {
    for (const value of ['Skill', 'workflow', 'Removed in v2.1.92', 'Alias for /usage', 'Deprecated. Use /x']) {
      expect(isSuspectDescription(value), value).toBe(true);
    }
  });

  it('leaves a real purpose alone', () => {
    for (const value of ['Review the changed code for cleanup opportunities', 'Skills are listed here', undefined]) {
      expect(isSuspectDescription(value), String(value)).toBe(false);
    }
  });
});

describe('formatNoticesForReport', () => {
  it('groups notices by category in a fixed order', () => {
    const lines = formatNoticesForReport([
      { category: 'alias-row', tool: 'claude', name: 'cost', message: 'alias for /usage' },
      { category: 'removed-row', tool: 'claude', name: 'vim', message: 'documented as removed' },
      { category: 'description-conflict', name: 'shared', message: 'tools disagree' },
    ]);

    expect(lines).toEqual([
      '[removed-row] (1)',
      '  - [claude] /vim: documented as removed',
      '[alias-row] (1)',
      '  - [claude] /cost: alias for /usage',
      '[description-conflict] (1)',
      '  - /shared: tools disagree',
    ]);
  });

  it('returns nothing when there is nothing to report', () => {
    expect(formatNoticesForReport([])).toEqual([]);
  });
});
