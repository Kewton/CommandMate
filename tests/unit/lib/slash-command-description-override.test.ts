/**
 * Per-entry descriptionKey overrides, end to end (Issue #1704).
 *
 * Six commands (`/btw` `/copy` `/ide` `/rename` `/stop` `/theme`) exist on both
 * claude and codex as separate catalog entries that shared one `descriptionKey`.
 * The tools mean different things by them, so the reconcile could not keep
 * either sentence and wrote the command *name* as the description — v0.21.2
 * shipped a palette reading "/btw — btw" until a human rewrote all six by hand.
 *
 * The fix is that `descriptionKey` is a value the catalog owns rather than one
 * derived from the command name. This file walks the whole chain the fix has to
 * survive: engine mints the key → runner writes the dictionary → catalog entry
 * becomes a SlashCommand → the renderer resolves it back to that tool's text.
 *
 * @vitest-environment node
 */

import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';
import { reconcileCatalog, toolDescriptionKeyFor } from '@/lib/slash-command-reconcile/engine';
import {
  applyLocaleAdditions,
  lookupNestedValue,
  type LocaleDictionary,
} from '@/lib/slash-command-reconcile/locale';
import { resolveCommandDescription } from '@/lib/slash-command-format';
import { STANDARD_COMMANDS, toStandardCommand } from '@/lib/standard-commands';
import catalogJson from '@/config/slash-commands-catalog.json';
import type { ProviderResult, SlashCommandsCatalog } from '@/lib/slash-command-reconcile/types';
import type { SlashCommand } from '@/types/slash-commands';

const CLAUDE_BTW = 'Ask a quick side question in an ephemeral fork';
const CODEX_BTW = 'send a message to the model out of band';

function emptyCatalog(): SlashCommandsCatalog {
  return { verifiedAgainst: {}, frequentlyUsed: {}, commands: [] };
}

function source(tool: string, description: string): ProviderResult {
  return { tool, ok: true, commands: [{ name: 'btw', description }], warnings: [] };
}

/** Turn a catalog entry into the SlashCommand shape the renderer receives. */
function asSlashCommand(entry: { name: string; descriptionKey?: string }): SlashCommand {
  return {
    name: entry.name,
    descriptionKey: entry.descriptionKey,
    category: 'standard-util',
    isStandard: true,
    source: 'standard',
    filePath: '',
  };
}

describe('descriptionKey override, engine → dictionary → renderer', () => {
  it('lets claude and codex keep their own description for one command name', () => {
    const result = reconcileCatalog(
      emptyCatalog(),
      [source('claude', CLAUDE_BTW), source('codex', CODEX_BTW)],
      { exclusions: [] }
    );

    // 1. The engine mints a tool-scoped key per entry.
    const entries = result.catalog.commands.filter((c) => c.name === 'btw');
    expect(entries.map((c) => c.descriptionKey)).toEqual([
      toolDescriptionKeyFor('btw', 'claude'),
      toolDescriptionKeyFor('btw', 'codex'),
    ]);

    // 2. The runner writes those keys into the shipped dictionaries. This is the
    //    same helper scripts/refresh-slash-command-catalog.ts uses, so a key the
    //    engine invents and a key the file can hold cannot drift apart.
    const en = applyLocaleAdditions({} as LocaleDictionary, result.localeAdditions, (a) => a.en);
    const ja = applyLocaleAdditions({} as LocaleDictionary, result.localeAdditions, (a) => a.ja);

    // 3. The renderer resolves each entry through its own key and gets that
    //    tool's sentence — not the other tool's, and not the command name.
    const t = (key: string) => lookupNestedValue(en, key) ?? key;
    const descriptions = entries.map((entry) => resolveCommandDescription(asSlashCommand(entry), t));

    expect(descriptions).toEqual([CLAUDE_BTW, CODEX_BTW]);
    expect(descriptions[0]).not.toBe(descriptions[1]);
    expect(descriptions).not.toContain('btw');

    // ja gets its usual review placeholder per tool, not one shared placeholder.
    expect(lookupNestedValue(ja, toolDescriptionKeyFor('btw', 'claude'))).toBe(
      `[要レビュー] ${CLAUDE_BTW}`
    );
    expect(lookupNestedValue(ja, toolDescriptionKeyFor('btw', 'codex'))).toBe(
      `[要レビュー] ${CODEX_BTW}`
    );
  });

  it('nests the split under the command name, leaving no stale flat string behind', () => {
    const result = reconcileCatalog(
      emptyCatalog(),
      [source('claude', CLAUDE_BTW), source('codex', CODEX_BTW)],
      { exclusions: [] }
    );
    const en = applyLocaleAdditions({} as LocaleDictionary, result.localeAdditions, (a) => a.en);

    expect(en).toEqual({
      slashCommands: {
        descriptions: { btw: { claude: CLAUDE_BTW, codex: CODEX_BTW } },
      },
    });
    // A JSON object cannot be a string at the same path, so the shared key must
    // be gone rather than merely unused — this is why a split moves both sides.
    expect(lookupNestedValue(en, 'slashCommands.descriptions.btw')).toBeUndefined();
  });

  it('leaves an uncontested command on the single shared key', () => {
    const shared = 'Choose the color theme';
    const result = reconcileCatalog(
      emptyCatalog(),
      [
        { tool: 'claude', ok: true, commands: [{ name: 'theme', description: shared }], warnings: [] },
        { tool: 'codex', ok: true, commands: [{ name: 'theme', description: shared }], warnings: [] },
      ],
      { exclusions: [] }
    );
    const en = applyLocaleAdditions({} as LocaleDictionary, result.localeAdditions, (a) => a.en);

    expect(en).toEqual({ slashCommands: { descriptions: { theme: shared } } });
  });
});

describe('the bundled catalog carries descriptionKey through verbatim', () => {
  // The override only works if standard-commands.ts passes the authored key
  // along instead of re-deriving it from the name. Until Issue #1767 no shipped
  // entry overrode anything, so this had to be checked on a synthetic entry;
  // /agents and /import now override for real (see the shipped-override test
  // below), and this stays as the minimal statement of the property.
  it('does not re-derive the key from the command name', () => {
    const overridden = toStandardCommand({
      name: 'btw',
      descriptionKey: toolDescriptionKeyFor('btw', 'codex'),
      category: 'standard-util',
      cliTools: ['codex'],
      isStandard: true,
      source: 'standard',
    });
    expect(overridden.descriptionKey).toBe('slashCommands.descriptions.btw.codex');
  });

  it('reconstructs every bundled entry with the key the catalog authored', () => {
    const raw = (catalogJson as SlashCommandsCatalog).commands;
    expect(STANDARD_COMMANDS.map((c) => c.descriptionKey)).toEqual(
      raw.map((entry) => entry.descriptionKey)
    );
  });

  // Issue #1767: the first shipped overrides. /agents and /import each exist on
  // claude and on another tool with genuinely different meanings, so both names
  // became per-tool objects in the dictionary. Resolution here goes through
  // lookupNestedValue — path traversal, the way next-intl resolves a dotted key —
  // rather than the flattened map the other guards use, because a dictionary that
  // stored "agents.claude" as one literal key would satisfy a flat lookup and
  // still render the raw key in the palette.
  it('resolves every shipped tool-scoped override against the real dictionaries', () => {
    const overridden = (catalogJson as SlashCommandsCatalog).commands.filter(
      (entry) => (entry.descriptionKey ?? '').split('.').length > 3
    );
    // Sorted so the pin survives entries being appended to the catalog; the
    // point is which names are split, not where they sit in the file.
    // Issue #1913 added 30 of these: /exit /login /logout /feedback /skills
    // /init /agent /plugin /memory /app /debug. Each one is a case where a tool
    // that joined the catalog means something different by the same command
    // name, so the flat key had to become a per-tool object and every claimant
    // had to be rewritten onto its own leaf.
    // Issue #2024: codex 0.149.0 dropped /agent (so `agent.codex` is gone) and
    // gained /agents (so `agents` grew a third leaf) plus /cd, whose codex
    // meaning differs from claude's — the first split this file records that a
    // *human* had to perform, because the engine refuses to split a key an
    // earlier release already translated.
    expect(overridden.map((e) => e.descriptionKey).sort()).toEqual([
      'slashCommands.descriptions.agent.copilot',
      'slashCommands.descriptions.agents.claude',
      'slashCommands.descriptions.agents.codex',
      'slashCommands.descriptions.agents.opencode',
      'slashCommands.descriptions.app.codex',
      'slashCommands.descriptions.app.copilot',
      'slashCommands.descriptions.cd.claude',
      'slashCommands.descriptions.cd.codex',
      'slashCommands.descriptions.debug.claude',
      'slashCommands.descriptions.debug.opencode',
      'slashCommands.descriptions.exit.claude',
      'slashCommands.descriptions.exit.codex',
      'slashCommands.descriptions.exit.copilot',
      'slashCommands.descriptions.exit.opencode',
      'slashCommands.descriptions.feedback.claude',
      'slashCommands.descriptions.feedback.codex',
      'slashCommands.descriptions.feedback.copilot',
      'slashCommands.descriptions.import.claude',
      'slashCommands.descriptions.import.codex',
      'slashCommands.descriptions.init.claude',
      'slashCommands.descriptions.init.codex',
      'slashCommands.descriptions.init.copilot',
      'slashCommands.descriptions.init.opencode',
      'slashCommands.descriptions.login.claude',
      'slashCommands.descriptions.login.copilot',
      'slashCommands.descriptions.logout.claude',
      'slashCommands.descriptions.logout.codex',
      'slashCommands.descriptions.logout.copilot',
      'slashCommands.descriptions.memory.claude',
      'slashCommands.descriptions.memory.copilot',
      'slashCommands.descriptions.plugin.claude',
      'slashCommands.descriptions.plugin.copilot',
      'slashCommands.descriptions.skills.claude',
      'slashCommands.descriptions.skills.codex',
      'slashCommands.descriptions.skills.copilot',
      'slashCommands.descriptions.skills.opencode',
    ]);

    for (const locale of ['en', 'ja'] as const) {
      const dict = JSON.parse(
        fs.readFileSync(path.resolve(__dirname, `../../../locales/${locale}/worktree.json`), 'utf8')
      );
      for (const entry of overridden) {
        const text = resolveCommandDescription(asSlashCommand(entry), (key) =>
          lookupNestedValue(dict, key) ?? key
        );
        expect(text, `${locale} cannot resolve ${entry.descriptionKey}`).not.toBe(
          entry.descriptionKey
        );
        expect(text.length).toBeGreaterThan(0);
      }
    }
  });

  it('resolves a synthetic overridden key through the renderer', () => {
    const overridden = asSlashCommand({
      name: 'btw',
      descriptionKey: toolDescriptionKeyFor('btw', 'codex'),
    });
    const dict = applyLocaleAdditions({} as LocaleDictionary, [
      { key: toolDescriptionKeyFor('btw', 'codex'), en: CODEX_BTW, ja: CODEX_BTW },
    ], (a) => a.en);

    expect(resolveCommandDescription(overridden, (key) => lookupNestedValue(dict, key) ?? key)).toBe(
      CODEX_BTW
    );
  });
});
