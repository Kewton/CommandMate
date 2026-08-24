/**
 * Issue #1603: the claude docs table is not a list of current built-ins.
 *
 * `catalog:refresh --check` offered `/pr-comments` and `/vim` as new commands
 * with "Removed in v2.1.91" as their description, offered the alias rows
 * `/cost` and `/stats`, and described `/simplify` as the single word "Skill".
 * These tests wire the real parser to the real engine over a fixture that
 * carries all four shapes, so the pass is fixed end to end without touching the
 * network (the live docs and the codex release move under us).
 *
 * The fixture rows are copied from the shipped docs table; only prose after the
 * first sentence is trimmed.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import { parseClaudeCommandsDoc } from '@/lib/slash-command-reconcile/providers/claude';
import { reconcileCatalog } from '@/lib/slash-command-reconcile/engine';
import type {
  ProviderResult,
  SlashCommandsCatalog,
} from '@/lib/slash-command-reconcile/types';

const CLAUDE_DOC = [
  '| Command | Purpose |',
  '| :------ | :------ |',
  '| `/agents` | {/* min-version: 2.1.198 */}As of v2.1.198, running `/agents` prints a reminder to ask Claude to manage [subagents](/docs/en/sub-agents). {/* max-version: 2.1.197 */}On v2.1.197 and earlier, opens an interactive interface |',
  '| `/cost` | Alias for `/usage` |',
  '| `/pr-comments [PR]` | {/* max-version: 2.1.90 */}Removed in v2.1.91. Ask Claude directly to view pull request comments instead |',
  '| `/simplify [target]` | {/* min-version: 2.1.154 */}**[Skill](/docs/en/skills#bundled-skills).** Review the changed code for cleanup opportunities and apply the fixes |',
  '| `/stats` | Alias for `/usage`. Opens on the Stats tab |',
  '| `/usage` | Show session cost, plan usage limits, and activity stats |',
  '| `/vim` | {/* max-version: 2.1.91 */}Removed in v2.1.92. To toggle between Vim and Normal editing modes, use `/config` |',
].join('\n');

/** An empty catalog: every fixture row is a potential *new* command. */
function emptyCatalog(): SlashCommandsCatalog {
  return {
    frequentlyUsed: { claude: [], codex: [] },
    commands: [],
  };
}

function claudeResult(): ProviderResult {
  return { tool: 'claude', ok: true, commands: parseClaudeCommandsDoc(CLAUDE_DOC), warnings: [] };
}

// `exclusions: []` isolates these from the shipped curation list (Issue #1704):
// what is under test is how the engine reads *source rows*, and the fixture
// names (`/agents`, `/vim`) are exactly the ones a future exclusion row might
// cover. Coupling them would turn a curation decision into an unrelated failure.
describe('catalog reconcile over the real claude docs shapes (Issue #1603)', () => {
  const result = reconcileCatalog(emptyCatalog(), [claudeResult()], { exclusions: [], attestations: [] });
  const addedNames = result.diff.added.map((a) => a.name);
  const added = (name: string) => result.diff.added.find((a) => a.name === name);

  it('offers no command whose description is its own removal note', () => {
    for (const name of ['pr-comments', 'vim']) {
      expect(addedNames, `/${name} must not be offered`).not.toContain(name);
    }
    for (const addition of result.diff.added) {
      expect(addition.enDescription ?? '').not.toMatch(/^Removed in v/i);
    }
  });

  it('offers no alias row', () => {
    expect(addedNames).not.toContain('cost');
    expect(addedNames).not.toContain('stats');
    // …while the command they alias is still offered.
    expect(addedNames).toContain('usage');
  });

  it('still offers live commands, including one documenting its own history', () => {
    expect(addedNames).toContain('agents');
    expect(added('agents')?.minVersion).toBe('2.1.198');
  });

  it('describes /simplify by what it does, not by its badge', () => {
    expect(added('simplify')?.enDescription).toBe(
      'Review the changed code for cleanup opportunities and apply the fixes'
    );
  });

  it('reports every refusal under a category rather than staying silent', () => {
    const byName = (name: string) => result.notices.find((n) => n.name === name);
    expect(byName('vim')?.category).toBe('removed-row');
    expect(byName('pr-comments')?.category).toBe('removed-row');
    expect(byName('cost')?.category).toBe('alias-row');
    expect(byName('stats')?.category).toBe('alias-row');
    expect(result.notices.every((n) => n.tool === 'claude')).toBe(true);
  });

  it('leaves no locale string behind for a refused row', () => {
    for (const name of ['vim', 'pr-comments', 'cost', 'stats']) {
      expect(
        result.localeAdditions.some((l) => l.key === `slashCommands.descriptions.${name}`),
        `/${name} must not reach the dictionaries`
      ).toBe(false);
    }
  });

  it('does not let a removed claude row poison another tool sharing the name', () => {
    const codex: ProviderResult = {
      tool: 'codex',
      ok: true,
      commands: [{ name: 'vim', description: 'toggle vim keybindings in the composer' }],
      warnings: [],
    };
    const shared = reconcileCatalog(emptyCatalog(), [claudeResult(), codex], { exclusions: [], attestations: [] });

    // claude's /vim is refused, so codex's real description owns the key.
    expect(
      shared.localeAdditions.find((l) => l.key === 'slashCommands.descriptions.vim')
    ).toEqual({
      key: 'slashCommands.descriptions.vim',
      en: 'toggle vim keybindings in the composer',
      ja: '[要レビュー] toggle vim keybindings in the composer',
    });
    expect(shared.catalog.commands.filter((c) => c.name === 'vim')).toEqual([
      {
        name: 'vim',
        descriptionKey: 'slashCommands.descriptions.vim',
        category: 'standard-util',
        cliTools: ['codex'],
        isStandard: true,
        source: 'standard',
      },
    ]);
  });
});
