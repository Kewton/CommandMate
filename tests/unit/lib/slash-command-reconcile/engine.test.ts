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
  JA_REVIEW_PREFIX,
} from '@/lib/slash-command-reconcile/engine';
import {
  applyLocaleAdditions,
  lookupNestedValue,
  type LocaleDictionary,
} from '@/lib/slash-command-reconcile/locale';
import type {
  CatalogAttestation,
  ProviderResult,
  SlashCommandsCatalog,
} from '@/lib/slash-command-reconcile/types';

/**
 * The attested reading these tests are held to (Issue #2026).
 *
 * Written here rather than defaulted to the shipped
 * src/config/slash-commands-attestations.json, for the reason
 * history-and-alias-rows.test.ts passes `exclusions: []`: what is under test is
 * how the engine reads provider results, and borrowing repo data would let a
 * release-time edit to a real attestation fail an unrelated engine test. It also
 * supplies the version map that used to be `catalog.verifiedAgainst`.
 */
const ATTESTATIONS: CatalogAttestation[] = [
  {
    tool: 'claude',
    version: '2.1.218',
    source: 'engine.test.ts fixture — the claude rows declared in this file',
    observedAt: '2026-08-24',
    issue: 1489,
    commands: ['loop', 'status'],
  },
  {
    tool: 'codex',
    version: '0.144.6',
    source: 'engine.test.ts fixture — the codex rows declared in this file',
    observedAt: '2026-08-24',
    issue: 1489,
    commands: ['status', 'undo'],
  },
];

/** reconcileCatalog with this file's attestations, unless a test overrides them. */
function reconcile(
  catalog: SlashCommandsCatalog,
  providerResults: ProviderResult[],
  options: Parameters<typeof reconcileCatalog>[2] = {}
): ReturnType<typeof reconcileCatalog> {
  return reconcileCatalog(catalog, providerResults, { attestations: ATTESTATIONS, ...options });
}

function baseCatalog(): SlashCommandsCatalog {
  return {
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
    const result = reconcile(baseCatalog(), [claudeOk, codexOk, antigravitySkipped]);

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
    const first = reconcile(baseCatalog(), [claudeOk, codexOk, antigravitySkipped]);
    expect(first.diff.added.some((a) => a.name === 'loop')).toBe(false);

    // Re-run against the reconciled catalog: nothing new.
    const second = reconcile(first.catalog, [claudeOk, codexOk, antigravitySkipped]);
    expect(second.diff.added).toEqual([]);
    expect(second.changed).toBe(false);
  });

  it('reports catalog entries missing from a source without deleting them', () => {
    const result = reconcile(baseCatalog(), [claudeOk, codexOk, antigravitySkipped]);
    // codex source has no "undo"; it stays in the catalog but is reported.
    expect(result.diff.missingFromSource).toContainEqual({ tool: 'codex', name: 'undo' });
    expect(result.catalog.commands.some((c) => c.name === 'undo')).toBe(true);
  });

  // Issue #2026: the stamp is *reported*, never applied. It used to be written
  // into the catalog by this call, which meant `--write` re-dated a human's
  // reading of a source it had not re-read. The version now belongs to the
  // attestation, so the only output here is the delta a re-attestation owes.
  it('reports a version-pinned source moving past the attested version, and writes nothing', () => {
    const result = reconcile(baseCatalog(), [claudeOk, codexOk, antigravitySkipped]);
    expect(result.diff.verifiedAgainstUpdated).toEqual({
      codex: { from: '0.144.6', to: '0.145.0' },
    });
    // claude has no sourceVersion → nothing to report for it.
    expect(result.diff.verifiedAgainstUpdated.claude).toBeUndefined();
    expect(result.catalog).not.toHaveProperty('verifiedAgainst');
  });

  // The set half of the same staleness: a pin can only compare the catalog to
  // the attestation, so the run that actually fetched the source is the only
  // place that can say the attestation itself has expired.
  it('reports how far each attested set has fallen behind its source', () => {
    const result = reconcile(baseCatalog(), [claudeOk, codexOk, antigravitySkipped]);
    expect(result.diff.attestationDrift).toEqual([
      { tool: 'claude', attested: true, unattested: ['focus'], vanished: [] },
      { tool: 'codex', attested: true, unattested: ['fork'], vanished: ['undo'] },
    ]);
    // A fail-soft source yields no row at all — "not compared" must never read
    // as "unchanged".
    expect(result.diff.attestationDrift.some((d) => d.tool === 'antigravity')).toBe(false);
  });

  it('flags a tool the source enumerates but no attestation covers', () => {
    const result = reconcile(baseCatalog(), [codexOk], { attestations: [] });
    expect(result.diff.attestationDrift).toEqual([
      { tool: 'codex', attested: false, unattested: ['fork', 'status'], vanished: [] },
    ]);
  });

  it('produces locale additions: en from source, ja review placeholder, deduped by key', () => {
    const result = reconcile(baseCatalog(), [claudeOk, codexOk, antigravitySkipped]);
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
    const result = reconcile(baseCatalog(), [claudeNew, codexNew]);

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
    const result = reconcile(baseCatalog(), [claudeDown, codexOk]);

    expect(result.diff.added.some((a) => a.tool === 'claude')).toBe(false);
    expect(result.diff.added.map((a) => a.name)).toEqual(['fork']);
    expect(result.warnings).toContain('claude fetch failed');
  });

  it('does not mutate the input catalog', () => {
    const input = baseCatalog();
    reconcile(input, [claudeOk, codexOk]);
    expect(input.commands).toHaveLength(3);
    expect(input.commands.map((c) => c.name)).toEqual(['loop', 'status', 'undo']);
  });

  it('honors a custom defaultCategory for new commands', () => {
    const result = reconcile(baseCatalog(), [claudeOk], { defaultCategory: 'standard-config' });
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
    const result = reconcile(baseCatalog(), [
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
    const result = reconcile(baseCatalog(), [
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
    const result = reconcile(baseCatalog(), [
      withRows({ name: 'loop', description: 'Removed in v9.9.9', status: 'removed' }),
    ]);

    expect(result.catalog.commands.some((c) => c.name === 'loop')).toBe(true);
    expect(result.notices.find((n) => n.name === 'loop')?.message).toContain(
      'the catalog still lists it'
    );
  });

  it('drops a marker-like description but keeps the command', () => {
    const result = reconcile(baseCatalog(), [
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

  // Issue #1704 changes the resolution of this conflict. Issue #1603 refused to
  // let either sentence win the shared key and downgraded it to a placeholder —
  // which is *why* v0.21.2 shipped six commands whose description was their own
  // name ("/btw — btw"). The invariant that mattered is unchanged (no tool's
  // sentence is shipped under a key another tool shares); what changes is that
  // the key is now split per tool so both sentences survive.
  it("splits the i18n key per tool when two tools disagree about a command", () => {
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
    const result = reconcile(baseCatalog(), [claudeSide, codexSide]);

    // Nothing is written under the shared key any more.
    expect(
      result.localeAdditions.filter((l) => l.key === 'slashCommands.descriptions.vim')
    ).toEqual([]);
    expect(result.localeAdditions.filter((l) => l.key.startsWith('slashCommands.descriptions.vim')))
      .toEqual([
        {
          key: 'slashCommands.descriptions.vim.claude',
          en: 'Enter Vim mode',
          ja: '[要レビュー] Enter Vim mode',
        },
        {
          key: 'slashCommands.descriptions.vim.codex',
          en: 'toggle vim keybindings in the composer',
          ja: '[要レビュー] toggle vim keybindings in the composer',
        },
      ]);

    // Both catalog entries point at their own key — including the one that was
    // already pushed before the disagreement was discovered.
    expect(
      result.catalog.commands
        .filter((c) => c.name === 'vim')
        .map((c) => [c.cliTools, c.descriptionKey])
    ).toEqual([
      [['claude'], 'slashCommands.descriptions.vim.claude'],
      [['codex'], 'slashCommands.descriptions.vim.codex'],
    ]);
    // The reported diff carries the same keys, so --check does not describe a
    // different catalog than --write would produce.
    expect(result.diff.added.filter((a) => a.name === 'vim').map((a) => a.descriptionKey)).toEqual([
      'slashCommands.descriptions.vim.claude',
      'slashCommands.descriptions.vim.codex',
    ]);

    const conflict = result.notices.find((n) => n.category === 'description-conflict');
    expect(conflict?.name).toBe('vim');
    expect(conflict?.message).toContain('per-tool keys');
  });

  it('reports one conflict per key, not one per extra tool', () => {
    const three: ProviderResult[] = ['claude', 'codex', 'antigravity'].map((tool, i) => ({
      tool,
      ok: true,
      commands: [{ name: 'vim', description: `description ${i}` }],
      warnings: [],
    }));
    const result = reconcile(baseCatalog(), three);
    expect(result.notices.filter((n) => n.category === 'description-conflict')).toHaveLength(1);
    // Once contested, every tool keeps its own key — including the third one,
    // which arrives after the split was already decided.
    expect(result.localeAdditions.map((l) => l.key)).toEqual([
      'slashCommands.descriptions.vim.claude',
      'slashCommands.descriptions.vim.codex',
      'slashCommands.descriptions.vim.antigravity',
    ]);
  });

  it('keeps one shared key when tools agree, so the norm is still a single description', () => {
    const sides: ProviderResult[] = ['claude', 'codex'].map((tool) => ({
      tool,
      ok: true,
      commands: [{ name: 'theme', description: 'Choose the color theme' }],
      warnings: [],
    }));
    const result = reconcile(baseCatalog(), sides);

    expect(result.localeAdditions).toEqual([
      {
        key: 'slashCommands.descriptions.theme',
        en: 'Choose the color theme',
        ja: '[要レビュー] Choose the color theme',
      },
    ]);
    expect(
      result.catalog.commands.filter((c) => c.name === 'theme').map((c) => c.descriptionKey)
    ).toEqual(['slashCommands.descriptions.theme', 'slashCommands.descriptions.theme']);
    expect(result.notices.filter((n) => n.category === 'description-conflict')).toEqual([]);
  });

  it('does not split a key that a previous release already translated', () => {
    // `loop` is in baseCatalog(), so its dictionary entry exists and carries a
    // human ja translation. Splitting would orphan it with nothing to replace
    // it, so the engine reports the disagreement instead of acting on it.
    const codexSide: ProviderResult = {
      tool: 'codex',
      ok: true,
      commands: [{ name: 'loop', description: 'repeat the last turn' }],
      warnings: [],
    };
    const antigravitySide: ProviderResult = {
      tool: 'antigravity',
      ok: true,
      commands: [{ name: 'loop', description: 'Run a prompt on a schedule' }],
      warnings: [],
    };
    const result = reconcile(baseCatalog(), [codexSide, antigravitySide]);

    expect(result.localeAdditions).toEqual([]);
    expect(
      result.catalog.commands.filter((c) => c.name === 'loop').map((c) => c.descriptionKey)
    ).toEqual([
      'slashCommands.descriptions.loop',
      'slashCommands.descriptions.loop',
      'slashCommands.descriptions.loop',
    ]);
    const conflict = result.notices.find((n) => n.category === 'description-conflict');
    expect(conflict?.name).toBe('loop');
    expect(conflict?.message).toContain('already translated');
  });

  // Issue #1704: the case measured on the live sources. Adding claude's /agents
  // makes it inherit `slashCommands.descriptions.agents`, written for opencode
  // ("List and manage available agents") — a description that is simply wrong
  // for claude. No locale string is written, so before #1704 nothing in the
  // report mentioned it at all.
  describe('a new entry inheriting a key an earlier release already shipped', () => {
    function catalogWithOpencodeAgents(): SlashCommandsCatalog {
      const catalog = baseCatalog();
      catalog.commands.push({
        name: 'agents',
        descriptionKey: 'slashCommands.descriptions.agents',
        category: 'standard-util',
        cliTools: ['opencode'],
        isStandard: true,
        source: 'standard',
      });
      return catalog;
    }
    // exclusions: [] below — /agents is the one command deliberately left off
    // the curation list (Issue #1704), so these must not change meaning if that
    // decision is ever settled.
    const claudeAgents: ProviderResult = {
      tool: 'claude',
      ok: true,
      commands: [{ name: 'agents', description: 'Prints a reminder to ask Claude instead' }],
      warnings: [],
    };

    it('reports the inherited description and names the key to split to', () => {
      const result = reconcile(catalogWithOpencodeAgents(), [claudeAgents], {
        exclusions: [],
        existingEnDescriptions: {
          'slashCommands.descriptions.agents': 'List and manage available agents',
        },
      });

      const conflict = result.notices.find((n) => n.category === 'description-conflict');
      expect(conflict?.name).toBe('agents');
      expect(conflict?.tool).toBe('claude');
      expect(conflict?.message).toContain('List and manage available agents');
      expect(conflict?.message).toContain('slashCommands.descriptions.agents.claude');

      // Reporting only: nothing is rewritten, because splitting here would
      // orphan the shipped ja translation with no replacement.
      expect(result.localeAdditions).toEqual([]);
      expect(
        result.catalog.commands.filter((c) => c.name === 'agents').map((c) => c.descriptionKey)
      ).toEqual(['slashCommands.descriptions.agents', 'slashCommands.descriptions.agents']);
    });

    it('stays quiet when the tools actually agree', () => {
      const result = reconcile(catalogWithOpencodeAgents(), [claudeAgents], {
        exclusions: [],
        existingEnDescriptions: {
          'slashCommands.descriptions.agents': 'Prints a reminder to ask Claude instead',
        },
      });
      expect(result.notices.filter((n) => n.category === 'description-conflict')).toEqual([]);
    });

    it('stays quiet when the shipped text is unknown to the caller', () => {
      const result = reconcile(catalogWithOpencodeAgents(), [claudeAgents], {
        exclusions: [],
      });
      expect(result.notices.filter((n) => n.category === 'description-conflict')).toEqual([]);
    });
  });

  // Issue #1704: an override is a value the catalog owns, not something the
  // engine re-derives. A refresh must leave an existing tool-scoped key alone.
  it('preserves a tool-scoped descriptionKey already recorded in the catalog', () => {
    const catalog = baseCatalog();
    catalog.commands.push({
      name: 'btw',
      descriptionKey: 'slashCommands.descriptions.btw.claude',
      category: 'standard-util',
      cliTools: ['claude'],
      isStandard: true,
      source: 'standard',
    });
    const claudeSide: ProviderResult = {
      tool: 'claude',
      ok: true,
      commands: [{ name: 'btw', description: 'Ask a quick side question' }],
      warnings: [],
    };
    const result = reconcile(catalog, [claudeSide]);

    expect(result.catalog.commands.filter((c) => c.name === 'btw')).toEqual([
      {
        name: 'btw',
        descriptionKey: 'slashCommands.descriptions.btw.claude',
        category: 'standard-util',
        cliTools: ['claude'],
        isStandard: true,
        source: 'standard',
      },
    ]);
    expect(result.diff.added.some((a) => a.name === 'btw')).toBe(false);
    expect(result.localeAdditions).toEqual([]);
  });

  // Issue #2024: the third tool to arrive at a name two tools already contested.
  //
  // After a split, `descriptions.<name>` is an OBJECT parenting the per-tool
  // leaves — it is not a free key. The engine used to see only that no claim had
  // been staked on it during this pass and mint the flat key anyway, so
  // `--write` merged a plain string over the object and every existing tool's
  // sentence vanished from en and ja at once. codex 0.149.0 shipping /agents
  // (already split between opencode and claude by #1767) is the case that hit.
  describe('a name an earlier release already split per tool (Issue #2024)', () => {
    const OPENCODE_EN = 'List and manage available agents';
    const CLAUDE_EN = 'Show a reminder to ask Claude to create or manage subagents';
    const CODEX_EN = 'view and switch between all active agent sessions';

    /** The catalog shape a completed split leaves behind: no flat claimant. */
    function catalogWithSplitAgents(): SlashCommandsCatalog {
      const catalog = baseCatalog();
      catalog.commands.push(
        {
          name: 'agents',
          descriptionKey: 'slashCommands.descriptions.agents.opencode',
          category: 'standard-config',
          cliTools: ['opencode'],
          isStandard: true,
          source: 'standard',
        },
        {
          name: 'agents',
          descriptionKey: 'slashCommands.descriptions.agents.claude',
          category: 'standard-util',
          cliTools: ['claude'],
          isStandard: true,
          source: 'standard',
        }
      );
      return catalog;
    }

    /** The dictionary shape that goes with it: an object, not a string. */
    const shippedAgents = {
      'slashCommands.descriptions.agents.opencode': OPENCODE_EN,
      'slashCommands.descriptions.agents.claude': CLAUDE_EN,
    };

    const codexAgents: ProviderResult = {
      tool: 'codex',
      ok: true,
      commands: [{ name: 'agents', description: CODEX_EN }],
      sourceVersion: '0.149.0',
      warnings: [],
    };

    it('mints a per-tool leaf for the arriving tool, not the parent key', () => {
      const result = reconcile(catalogWithSplitAgents(), [codexAgents], {
        exclusions: [],
        existingEnDescriptions: shippedAgents,
      });

      expect(result.diff.added).toEqual([
        {
          tool: 'codex',
          name: 'agents',
          descriptionKey: 'slashCommands.descriptions.agents.codex',
          enDescription: CODEX_EN,
          minVersion: undefined,
        },
      ]);
      expect(result.localeAdditions).toEqual([
        {
          key: 'slashCommands.descriptions.agents.codex',
          en: CODEX_EN,
          ja: `${JA_REVIEW_PREFIX}${CODEX_EN}`,
        },
      ]);
      // The already-split siblings are untouched — no rewrite, no re-report.
      expect(
        result.catalog.commands
          .filter((c) => c.name === 'agents')
          .map((c) => c.descriptionKey)
          .sort()
      ).toEqual([
        'slashCommands.descriptions.agents.claude',
        'slashCommands.descriptions.agents.codex',
        'slashCommands.descriptions.agents.opencode',
      ]);
    });

    // The symptom itself, not just the key: merging the pass's additions into a
    // real-shaped dictionary must leave the other tools' text readable. A flat
    // key here replaces the whole object, which is what `--write` shipped.
    it('leaves the sibling descriptions resolvable after the additions are merged', () => {
      const result = reconcile(catalogWithSplitAgents(), [codexAgents], {
        exclusions: [],
        existingEnDescriptions: shippedAgents,
      });

      const dict = applyLocaleAdditions(
        {
          slashCommands: { descriptions: { agents: { opencode: OPENCODE_EN, claude: CLAUDE_EN } } },
        } as LocaleDictionary,
        result.localeAdditions,
        (addition) => addition.en
      );

      expect(lookupNestedValue(dict, 'slashCommands.descriptions.agents.opencode')).toBe(
        OPENCODE_EN
      );
      expect(lookupNestedValue(dict, 'slashCommands.descriptions.agents.claude')).toBe(CLAUDE_EN);
      expect(lookupNestedValue(dict, 'slashCommands.descriptions.agents.codex')).toBe(CODEX_EN);
    });

    // Either half of the evidence alone is enough. The catalog carries the shape
    // when no dictionary is passed; the dictionary carries it when a leaf
    // outlives the entry that minted it (a tool dropped from the catalog).
    it('detects the split from the catalog alone', () => {
      const result = reconcile(catalogWithSplitAgents(), [codexAgents], {
        exclusions: [],
      });
      expect(result.diff.added.map((a) => a.descriptionKey)).toEqual([
        'slashCommands.descriptions.agents.codex',
      ]);
    });

    it('detects the split from the shipped dictionary alone', () => {
      const result = reconcile(baseCatalog(), [codexAgents], {
        exclusions: [],
        existingEnDescriptions: shippedAgents,
      });
      expect(result.diff.added.map((a) => a.descriptionKey)).toEqual([
        'slashCommands.descriptions.agents.codex',
      ]);
    });

    // The guard keys off the name/tool boundary, so an uncontested name must
    // still get the plain shared key — splitting everything would be just as
    // wrong, and far quieter.
    it('still mints the shared key for a name nothing has split', () => {
      const result = reconcile(catalogWithSplitAgents(), [
        {
          tool: 'codex',
          ok: true,
          commands: [{ name: 'pwd', description: 'show the current working directory' }],
          warnings: [],
        },
      ], { exclusions: [], existingEnDescriptions: shippedAgents });

      expect(result.diff.added.map((a) => a.descriptionKey)).toEqual([
        'slashCommands.descriptions.pwd',
      ]);
    });
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
