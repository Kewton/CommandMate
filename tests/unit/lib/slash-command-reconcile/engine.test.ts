/**
 * Tests for the reconcile engine (Issue #1489).
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import { reconcileCatalog } from '@/lib/slash-command-reconcile/engine';
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
