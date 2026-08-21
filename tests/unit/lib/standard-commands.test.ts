/**
 * Tests for standard-commands module (Issue #56, Issue #4)
 * TDD: Red phase - write tests first
 *
 * Issue #4: Updated to test CLI tool-specific commands
 *
 * @vitest-environment node
 */

import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';
import {
  STANDARD_COMMANDS,
  FREQUENTLY_USED,
  CATALOG_VERIFIED_AGAINST,
  getStandardCommandGroups,
  getFrequentlyUsedCommands,
} from '@/lib/standard-commands';
import { keyOf } from '@/lib/command-merger';
import {
  DESCRIPTION_KEY_PREFIX,
  JA_REVIEW_PREFIX,
  descriptionKeyFor,
  hasReviewMarker,
  toolDescriptionKeyFor,
} from '@/lib/slash-command-reconcile/engine';
import { DEFAULT_EXCLUSIONS, findExclusion, buildExclusionIndex } from '@/lib/slash-command-reconcile/exclusions';
import type { SlashCommand, SlashCommandCategory } from '@/types/slash-commands';

const LOCALES = ['en', 'ja'] as const;

/** Read a whole shipped locale namespace (Issue #1703 sweeps beyond descriptions). */
function loadLocaleFile(locale: (typeof LOCALES)[number]): unknown {
  const file = path.resolve(__dirname, `../../../locales/${locale}/worktree.json`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Flatten a nested dictionary into dotted-key → string pairs. */
function flattenStrings(value: unknown, prefix = ''): Array<[string, string]> {
  if (typeof value === 'string') return [[prefix, value]];
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    flattenStrings(child, prefix ? `${prefix}.${key}` : key)
  );
}

/**
 * Read the real `slashCommands.descriptions` block straight off disk, flattened
 * to leaf strings.
 *
 * Issue #1306: these tests must fail when a key is missing from the shipped
 * dictionary, so they read the actual JSON rather than a mocked translator.
 *
 * Issue #1704: keys are flattened rather than read one level deep, because a
 * command whose tools disagree about what it does carries the tool-scoped key
 * `<name>.<tool>` — a nested object, not a string. Flattening keeps every guard
 * below working on both shapes.
 */
function loadDescriptions(locale: (typeof LOCALES)[number]): Record<string, string> {
  const file = path.resolve(__dirname, `../../../locales/${locale}/worktree.json`);
  const dict = JSON.parse(fs.readFileSync(file, 'utf8'));
  return Object.fromEntries(flattenStrings(dict.slashCommands?.descriptions ?? {}));
}

/**
 * Every descriptionKey a catalog entry is allowed to carry (Issue #1704).
 *
 * The default is the one key shared by every tool that has the command; the
 * tool-scoped form is legal only for a tool the entry actually serves, so an
 * override can never point at a description for a CLI the entry does not cover.
 */
function allowedDescriptionKeys(cmd: SlashCommand): string[] {
  const tools = cmd.cliTools ?? ['claude'];
  return [descriptionKeyFor(cmd.name), ...tools.map((tool) => toolDescriptionKeyFor(cmd.name, tool))];
}

/** The shipped description for a command, resolved through its own key. */
function descriptionFor(cmd: SlashCommand, locale: (typeof LOCALES)[number]): string | undefined {
  const key = cmd.descriptionKey?.slice(DESCRIPTION_KEY_PREFIX.length) ?? '';
  return loadDescriptions(locale)[key];
}

describe('STANDARD_COMMANDS', () => {
  // Issue #1488: +9 Claude built-ins (loop, add-dir, mcp, usage, memory,
  // statusline, terminal-setup, hooks, agents), all cliTools: ['claude'].
  // Issue #1502: +9 Antigravity real commands (help, usage, mcp, hooks, diff,
  // fork, plan, rewind, tasks), all cliTools: ['antigravity'].
  // Issue #1503: -7 phantom entries removed — claude cost/lazy/todos/pr-comments
  // + the "(removed)" claude /agents stub, and codex approvals/undo. 63 -> 56.
  // v0.21.2: the catalog had not been reconciled since #1503, so a single
  // refresh against claude docs / codex 0.146.0 added 104 real commands.
  // 56 -> 159. The bans below are what actually protects the set; this number
  // only pins that a refresh was reviewed rather than applied blind.
  // Issue #1767: +3 claude built-ins the weekly drift check surfaced — /agents,
  // /import, /list-agents, all real rows on code.claude.com/docs/en/commands.md.
  // 159 -> 162.
  // Issue #1913: copilot entered the catalog (68, from `copilot help commands`
  // on 1.0.80 plus the palette-only /undo) and opencode was reconciled against
  // the 1.18.21 palette (+9 entries; /compact left the opencode scope but its
  // claude/codex entry stays). 163 -> 240.
  it('should have 240 standard commands', () => {
    expect(STANDARD_COMMANDS.length).toBe(240);
  });

  it('should have all required properties for each command', () => {
    STANDARD_COMMANDS.forEach((cmd) => {
      expect(cmd.name).toBeDefined();
      expect(cmd.name.length).toBeGreaterThan(0);
      // Issue #1306: descriptions moved into the dictionary; the definition
      // carries a key, and the literal description is gone.
      // Issue #1704: the key may be overridden per tool for a contested command,
      // so the assertion is "one of the legal keys for this entry" rather than
      // "derived from the name" — but nothing outside that set is accepted.
      expect(allowedDescriptionKeys(cmd)).toContain(cmd.descriptionKey);
      expect(cmd.description).toBeUndefined();
      expect(cmd.category).toBeDefined();
      expect(cmd.isStandard).toBe(true);
      expect(cmd.source).toBe('standard');
    });
  });

  it('should have Claude commands without cliTools field (backward compatible)', () => {
    const claudeOnlyCommands = [
      'rewind',
      'config',
      'context',
      'doctor',
      'export',
    ];
    claudeOnlyCommands.forEach((name) => {
      const cmd = STANDARD_COMMANDS.find((c) => c.name === name);
      expect(cmd).toBeDefined();
      expect(cmd?.cliTools).toBeUndefined();
    });
  });

  it('should have commands shared between Claude and Codex', () => {
    const sharedCommands = [
      'clear',
      'compact',
      'resume',
      'model',
      'permissions',
      'status',
      'review',
    ];
    sharedCommands.forEach((name) => {
      const cmd = STANDARD_COMMANDS.find((c) => c.name === name);
      expect(cmd).toBeDefined();
      expect(cmd?.cliTools).toEqual(expect.arrayContaining(['claude', 'codex']));
    });
  });

  // Issue #990 (Phase C): Antigravity shares the universal claude/codex commands.
  // Issue #1502: compact/status/review were phantom on agy 1.1.3 and were
  // removed from the antigravity scope, so only these four remain shared.
  it('should have shared session/config commands including "antigravity"', () => {
    const antigravitySharedCommands = ['clear', 'resume', 'model', 'permissions'];
    antigravitySharedCommands.forEach((name) => {
      const cmd = STANDARD_COMMANDS.find((c) => c.name === name);
      expect(cmd).toBeDefined();
      expect(cmd?.cliTools).toEqual(expect.arrayContaining(['antigravity']));
    });
  });

  // Issue #1502: these three do not exist in agy 1.1.3 (/compact = "No matches",
  // /status -> /statusline, /review -> /teamwork-preview). They must not be
  // offered to antigravity, or the palette drives a mis-execution on send.
  it('should NOT expose phantom commands (compact/status/review) to Antigravity', () => {
    ['compact', 'status', 'review'].forEach((name) => {
      const antigravityEntry = STANDARD_COMMANDS.find(
        (c) => c.name === name && c.cliTools?.includes('antigravity')
      );
      expect(antigravityEntry, `/${name} must not be antigravity-visible`).toBeUndefined();
    });
  });

  // Issue #1502: real agy 1.1.3 commands added with cliTools: ['antigravity'].
  it('should expose the real agy 1.1.3 commands to Antigravity', () => {
    const realAgyAdded = ['help', 'usage', 'mcp', 'hooks', 'diff', 'fork', 'plan', 'rewind', 'tasks'];
    realAgyAdded.forEach((name) => {
      const cmd = STANDARD_COMMANDS.find(
        (c) => c.name === name && c.cliTools?.includes('antigravity')
      );
      expect(cmd, `/${name} must be antigravity-visible`).toBeDefined();
    });
  });

  it('should have 13 commands available for Antigravity (Issue #1502: 4 shared + 9 real)', () => {
    const antigravityCommands = STANDARD_COMMANDS.filter(
      (cmd) => cmd.cliTools?.includes('antigravity')
    );
    expect(antigravityCommands.length).toBe(13);
  });

  // Issue #1913: /compact used to be listed here too. It is not in the opencode
  // 1.18.21 palette — typing the full /compact matches nothing but the /review
  // description text — so the opencode scope was dropped from that entry.
  it('should have commands shared between Claude and OpenCode', () => {
    const sharedCommands = ['help'];
    sharedCommands.forEach((name) => {
      const cmd = STANDARD_COMMANDS.find((c) => c.name === name);
      expect(cmd).toBeDefined();
      expect(cmd?.cliTools).toEqual(expect.arrayContaining(['claude', 'opencode']));
    });
  });

  it('should have Codex commands with cliTools including "codex"', () => {
    const codexOnlyCommands = [
      'logout',
      'quit',
      'diff',
      'mention',
      'mcp',
      'init',
      'feedback',
      // Issue #689: new Codex commands
      'plan',
      'goal',
      'agent',
      'subagents',
      'fork',
      'memories',
      'skills',
      'hooks',
    ];
    codexOnlyCommands.forEach((name) => {
      // Issue #1488: mcp/hooks also have a Claude entry now; select the Codex one.
      const cmd = STANDARD_COMMANDS.find((c) => c.name === name && c.cliTools?.includes('codex'));
      expect(cmd).toBeDefined();
      expect(cmd?.cliTools).toEqual(['codex']);
    });
    // /new is shared between Codex and OpenCode
    const newCmd = STANDARD_COMMANDS.find((c) => c.name === 'new');
    expect(newCmd).toBeDefined();
    expect(newCmd?.cliTools).toEqual(expect.arrayContaining(['codex', 'opencode']));
  });

  it('should have OpenCode-only commands with cliTools: ["opencode"]', () => {
    const opencodeOnlyCommands = [
      'sessions',
      'connect',
      'exit',
      'models',
      'agents',
      'themes',
      'editor',
    ];
    opencodeOnlyCommands.forEach((name) => {
      // Issue #1488: /agents also has a Claude entry now; select the OpenCode one.
      const cmd = STANDARD_COMMANDS.find((c) => c.name === name && c.cliTools?.includes('opencode'));
      expect(cmd).toBeDefined();
      expect(cmd?.cliTools).toEqual(['opencode']);
    });
  });

  // Issue #1913: reconciled against the opencode 1.18.21 palette (18 rows,
  // /agents … /variants). -1 phantom (/compact) +9 missing. 10 -> 18.
  it('should have 18 commands available for OpenCode', () => {
    const opencodeCommands = STANDARD_COMMANDS.filter(
      (cmd) => cmd.cliTools?.includes('opencode')
    );
    expect(opencodeCommands.length).toBe(18);
  });

  // Issue #1503: -2 codex phantoms (approvals/undo) removed → 23.
  // v0.21.2: reconciled against the codex 0.146.0 enum → 53.
  it('should have 53 commands available for Codex', () => {
    const codexCommands = STANDARD_COMMANDS.filter(
      (cmd) => cmd.cliTools?.includes('codex')
    );
    expect(codexCommands.length).toBe(54);
  });

  it('should include session management commands', () => {
    const sessionCommands = ['clear', 'compact', 'resume', 'rewind'];
    sessionCommands.forEach((name) => {
      const cmd = STANDARD_COMMANDS.find((c) => c.name === name);
      expect(cmd).toBeDefined();
      expect(cmd?.category).toBe('standard-session');
    });
  });

  it('should include config commands', () => {
    const configCommands = ['config', 'model', 'permissions'];
    configCommands.forEach((name) => {
      const cmd = STANDARD_COMMANDS.find((c) => c.name === name);
      expect(cmd).toBeDefined();
      expect(cmd?.category).toBe('standard-config');
    });
  });

  it('should include monitor commands', () => {
    const monitorCommands = ['status', 'context'];
    monitorCommands.forEach((name) => {
      const cmd = STANDARD_COMMANDS.find((c) => c.name === name);
      expect(cmd).toBeDefined();
      expect(cmd?.category).toBe('standard-monitor');
    });
  });

  it('should include git commands', () => {
    const gitCommands = ['review'];
    gitCommands.forEach((name) => {
      const cmd = STANDARD_COMMANDS.find((c) => c.name === name);
      expect(cmd).toBeDefined();
      expect(cmd?.category).toBe('standard-git');
    });
  });

  it('should include utility commands', () => {
    const utilCommands = ['help', 'doctor', 'export'];
    utilCommands.forEach((name) => {
      const cmd = STANDARD_COMMANDS.find((c) => c.name === name);
      expect(cmd).toBeDefined();
      expect(cmd?.category).toBe('standard-util');
    });
  });

  // Issue #1488: mcp/hooks/agents now carry a Claude entry alongside the
  // existing Codex/OpenCode one, so uniqueness is by name + cliTools scope
  // (keyOf) — the same dedup granularity command-merger/slash-commands use.
  it('should not have duplicate name + cliTools keys', () => {
    const keys = STANDARD_COMMANDS.map(keyOf);
    expect(keys.length).toBe(new Set(keys).size);
  });

  // Issue #1503: /clear, /quit, /subagents are REAL on codex 0.144.6 — hidden
  // aliases the bare "/" popup does not list but that match on full input. They
  // must survive the phantom purge; deleting them strips real commands.
  it('keeps codex hidden real commands /clear, /quit, /subagents (Issue #1503 regression)', () => {
    for (const name of ['clear', 'quit', 'subagents']) {
      const cmd = STANDARD_COMMANDS.find((c) => c.name === name && c.cliTools?.includes('codex'));
      expect(cmd, `/${name} must remain codex-visible`).toBeDefined();
    }
  });

  // Issue #1503: these 6 entries did not exist on claude 2.1.218 / codex 0.144.6
  // and were purged. None of them may reappear in the catalog.
  //
  // Issue #1767 narrows the /agents half exactly the way v0.21.2 narrowed /vim.
  // The old assertion was "claude ships no /agents at all", which was right while
  // the claude docs row was a bare "(removed)" stub. It no longer is: the row on
  // code.claude.com/docs/en/commands.md (fetched 2026-08-13) reads "As of
  // v2.1.198, running `/agents` prints a reminder to ask Claude to create or
  // manage subagents…" — a real command with a real description. So claude gets
  // an entry, and what is pinned instead is that the two entries stay separate
  // and never share a description key (Issue #1704 tool-scoped keys).
  //
  // Issue #1913 narrows the /undo half the same way, for the same reason. The
  // ban was name-wide because /undo was a codex 0.144.6 phantom, but copilot
  // 1.0.80 ships a real /undo: it is absent from `copilot help commands` yet
  // matches on full input in the palette ("Rewind the last turn and revert file
  // changes"), exactly the hidden-alias shape /clear and /quit have on codex.
  // Banning the string hid a real command, so the ban now names codex.
  it('does not carry the Issue #1503 phantom commands', () => {
    for (const name of ['cost', 'lazy', 'todos', 'pr-comments', 'approvals']) {
      expect(STANDARD_COMMANDS.some((c) => c.name === name), `/${name} must be gone`).toBe(false);
    }
    expect(
      STANDARD_COMMANDS.some((c) => c.name === 'undo' && c.cliTools?.includes('codex')),
      '/undo must stay off codex'
    ).toBe(false);
    const agentsEntries = STANDARD_COMMANDS.filter((c) => c.name === 'agents');
    expect(agentsEntries.map((c) => c.cliTools?.join(',')).sort()).toEqual(['claude', 'opencode']);
    expect(new Set(agentsEntries.map((c) => c.descriptionKey)).size).toBe(2);
  });

  // Issue #689: New Claude commands with explicit cliTools: ['claude'] (DR1-001)
  it('should have new Claude-only commands (effort/fast/focus) with explicit cliTools: ["claude"]', () => {
    const newClaudeCommands = ['effort', 'fast', 'focus'];
    newClaudeCommands.forEach((name) => {
      const cmd = STANDARD_COMMANDS.find((c) => c.name === name);
      expect(cmd).toBeDefined();
      expect(cmd?.cliTools).toEqual(['claude']);
    });
  });

  it('should have new Claude commands in correct categories (DR1-003)', () => {
    const configCommands = ['effort', 'fast'];
    configCommands.forEach((name) => {
      const cmd = STANDARD_COMMANDS.find((c) => c.name === name);
      expect(cmd).toBeDefined();
      expect(cmd?.category).toBe('standard-config');
    });
    const focusCmd = STANDARD_COMMANDS.find((c) => c.name === 'focus');
    expect(focusCmd).toBeDefined();
    expect(focusCmd?.category).toBe('standard-session');
  });

  // Issue #689: New Codex commands (DR1-004)
  it('should have new Codex commands in correct categories', () => {
    const sessionCommands = ['plan', 'goal', 'agent', 'subagents', 'fork'];
    sessionCommands.forEach((name) => {
      const cmd = STANDARD_COMMANDS.find((c) => c.name === name);
      expect(cmd).toBeDefined();
      expect(cmd?.category).toBe('standard-session');
      expect(cmd?.cliTools).toEqual(['codex']);
    });
    const configCommands = ['memories', 'skills', 'hooks'];
    configCommands.forEach((name) => {
      // Issue #1488: /hooks also has a Claude entry now; select the Codex one.
      const cmd = STANDARD_COMMANDS.find((c) => c.name === name && c.cliTools?.includes('codex'));
      expect(cmd).toBeDefined();
      expect(cmd?.category).toBe('standard-config');
      expect(cmd?.cliTools).toEqual(['codex']);
    });
  });

  // Issue #689: Claude display total = 20 (DR2-001)
  // Issue #1488: +9 Claude built-ins → 29.
  // Issue #1503: -5 Claude-visible phantoms (cost/lazy/todos/pr-comments + the
  // "(removed)" /agents stub) → 24.
  // v0.21.2: reconciled against the claude commands doc → 97.
  // Issue #1767: +3 (/agents, /import, /list-agents) → 100.
  it('should have 100 commands available for Claude', () => {
    const claudeCommands = STANDARD_COMMANDS.filter(
      (cmd) => !cmd.cliTools || cmd.cliTools.includes('claude')
    );
    expect(claudeCommands.length).toBe(100);
  });

  // Issue #689: agent (Codex) vs agents (OpenCode) differentiation (DR1-002)
  // Issue #1306: distinct keys are not enough — two keys can hold identical
  // text (see /model and /models), so assert the resolved text differs too.
  // Issue #1767: claude's /agents joined the pair meaning a third thing, so
  // `descriptions.agents` is now a per-tool object rather than one string.
  // Each entry is therefore resolved through its own key (a flat `dict.agents`
  // lookup would silently read undefined here), and all three must differ.
  it('agent (Codex), agents (OpenCode) and agents (Claude) have distinct descriptions', () => {
    type CliTool = NonNullable<SlashCommand['cliTools']>[number];
    const pick = (name: string, tool: CliTool): SlashCommand => {
      const cmd = STANDARD_COMMANDS.find((c) => c.name === name && c.cliTools?.includes(tool));
      expect(cmd, `/${name} must be ${tool}-visible`).toBeDefined();
      return cmd as SlashCommand;
    };
    const entries = [pick('agent', 'codex'), pick('agents', 'opencode'), pick('agents', 'claude')];
    expect(new Set(entries.map((c) => c.descriptionKey)).size).toBe(entries.length);

    for (const locale of LOCALES) {
      const texts = entries.map((cmd) => descriptionFor(cmd, locale));
      texts.forEach((text) => expect(text).toBeTruthy());
      expect(new Set(texts).size).toBe(entries.length);
    }
  });

  // Issue #689: Security - allowlist validation (DR4-002)
  it('should have all command names matching allowed pattern /^[a-z][a-z0-9-]*$/', () => {
    const allowedPattern = /^[a-z][a-z0-9-]*$/;
    STANDARD_COMMANDS.forEach((cmd) => {
      expect(cmd.name).toMatch(allowedPattern);
    });
  });

  it('should have all commands with source=standard and filePath=""', () => {
    STANDARD_COMMANDS.forEach((cmd) => {
      expect(cmd.source).toBe('standard');
      expect(cmd.filePath).toBe('');
    });
  });

  // Issue #689: XSS regression - description safety (DR4-003)
  // Issue #1306: the rendered text now lives in the dictionary, so the guard
  // has to follow it there — checking the definitions would prove nothing.
  it('should have all descriptions without HTML tags or dangerous patterns', () => {
    const dangerousPatterns = [/<[^>]+>/, /javascript:/i, /onerror=/i, /onclick=/i];
    for (const locale of LOCALES) {
      STANDARD_COMMANDS.forEach((cmd) => {
        const description = descriptionFor(cmd, locale);
        expect(description).toBeTruthy();
        dangerousPatterns.forEach((pattern) => {
          expect(description).not.toMatch(pattern);
        });
      });
    }
  });

  // Issue #689: new Claude-only 4 commands should not have undefined cliTools (DR1-001)
  it('should not have new commands with undefined cliTools (DR1-001: no new undefined)', () => {
    const newCommandNames = ['effort', 'fast', 'focus', 'plan', 'goal', 'agent', 'subagents', 'fork', 'memories', 'skills', 'hooks'];
    newCommandNames.forEach((name) => {
      const cmd = STANDARD_COMMANDS.find((c) => c.name === name);
      expect(cmd).toBeDefined();
      expect(cmd?.cliTools).toBeDefined();
    });
  });
});

// Issue #1488: add missing Claude built-ins (/loop etc.) to the bundled catalog.
// Verified against the official docs for Claude Code 2.1.218 (= verifiedAgainst.claude).
describe('Claude built-in catalog additions (Issue #1488)', () => {
  // `key` is the leaf of the shipped descriptionKey. It is the plain command
  // name unless the tools disagree about what the command does — Issue #1913
  // split /memory because copilot's is "show memory status, enable/disable
  // memory across sessions" while claude's edits CLAUDE.md memory files, and
  // one shared key cannot hold both (the same mechanism #1767 used for /agents).
  const NEW_CLAUDE_BUILTINS: Array<{
    name: string;
    category: SlashCommandCategory;
    key?: string;
  }> = [
    { name: 'loop', category: 'standard-util' },
    { name: 'add-dir', category: 'standard-util' },
    { name: 'mcp', category: 'standard-util' },
    { name: 'usage', category: 'standard-monitor' },
    { name: 'memory', category: 'standard-config', key: 'memory.claude' },
    { name: 'statusline', category: 'standard-config' },
    { name: 'terminal-setup', category: 'standard-config' },
    { name: 'hooks', category: 'standard-config' },
    // Issue #1503: /agents was a "(removed)" stub on claude 2.1.218 and was
    // purged; the opencode /agents entry stays (asserted separately below).
  ];

  it('registers each new built-in with cliTools: ["claude"], the right category, and its shipped key', () => {
    for (const { name, category, key } of NEW_CLAUDE_BUILTINS) {
      const claudeEntry = STANDARD_COMMANDS.find(
        (c) => c.name === name && c.cliTools?.length === 1 && c.cliTools[0] === 'claude'
      );
      expect(claudeEntry, `missing Claude entry for /${name}`).toBeDefined();
      expect(claudeEntry?.category).toBe(category);
      expect(claudeEntry?.descriptionKey).toBe(`${DESCRIPTION_KEY_PREFIX}${key ?? name}`);
      expect(claudeEntry?.isStandard).toBe(true);
      expect(claudeEntry?.source).toBe('standard');
    }
  });

  it('surfaces every new built-in in the Claude-visible set', () => {
    const claudeVisible = new Set(
      STANDARD_COMMANDS.filter((c) => !c.cliTools || c.cliTools.includes('claude')).map((c) => c.name)
    );
    for (const { name } of NEW_CLAUDE_BUILTINS) {
      expect(claudeVisible.has(name), `/${name} is not Claude-visible`).toBe(true);
    }
  });

  it('resolves each new built-in description in en and ja without leaking the raw key', () => {
    for (const locale of LOCALES) {
      const dict = loadDescriptions(locale);
      for (const { name, key } of NEW_CLAUDE_BUILTINS) {
        const text = dict[key ?? name];
        expect(typeof text === 'string' && text.length > 0, `${locale} missing /${name}`).toBe(true);
        expect(text).not.toBe(`${DESCRIPTION_KEY_PREFIX}${key ?? name}`);
      }
    }
  });

  // The Claude variants of mcp/hooks/agents coexist with the pre-existing
  // Codex/OpenCode entries via keyOf (name + cliTools); those must be untouched.
  it('keeps the Codex/OpenCode variants of mcp/hooks/agents intact (no regression)', () => {
    const codexMcp = STANDARD_COMMANDS.find((c) => c.name === 'mcp' && c.cliTools?.includes('codex'));
    const codexHooks = STANDARD_COMMANDS.find((c) => c.name === 'hooks' && c.cliTools?.includes('codex'));
    const opencodeAgents = STANDARD_COMMANDS.find(
      (c) => c.name === 'agents' && c.cliTools?.includes('opencode')
    );
    expect(codexMcp?.cliTools).toEqual(['codex']);
    expect(codexHooks?.cliTools).toEqual(['codex']);
    expect(opencodeAgents?.cliTools).toEqual(['opencode']);
  });

  // /schedule is deliberately out of scope, and claude's /vim was removed
  // upstream in v2.1.92 so it must not ship for claude.
  //
  // v0.21.2 narrows the /vim ban to claude. It used to forbid the name outright,
  // which was correct while claude was the only source considered — but codex
  // 0.146.0 declares `SlashCommand::Vim => "toggle Vim mode for the composer"`
  // in codex-rs/tui/src/slash_command.rs, so banning the name hid a real codex
  // command. The ban tracks the tool that removed it, not the string.
  //
  // Issue #1704 moved the *intent* behind the /schedule half into
  // src/config/slash-commands-exclusions.json so `catalog:refresh` stops
  // proposing it. This assertion stays as-is: it is name-wide (stronger than the
  // claude-scoped data row) and covers /vim, which the exclusions file does not
  // list because the claude docs already mark it removed.
  it('does not add /schedule, and keeps /vim off claude', () => {
    expect(STANDARD_COMMANDS.some((c) => c.name === 'schedule')).toBe(false);
    const vim = STANDARD_COMMANDS.filter((c) => c.name === 'vim');
    expect(vim.length).toBe(1);
    expect(vim[0].cliTools).toEqual(['codex']);
  });
});

// Issue #1704: the catalog and the curation list are two halves of one decision,
// so their disagreement is a test failure rather than something a human notices
// while reading a release diff. Intent lives in the data; verification here.
describe('catalog ∩ curation exclusions (Issue #1704)', () => {
  it('ships no command that the exclusions file excludes for that tool', () => {
    const index = buildExclusionIndex(DEFAULT_EXCLUSIONS);
    const violations: string[] = [];
    for (const cmd of STANDARD_COMMANDS) {
      for (const tool of cmd.cliTools ?? ['claude']) {
        const exclusion = findExclusion(index, cmd.name, tool);
        if (exclusion) {
          violations.push(`/${cmd.name} on ${tool} (excluded by #${exclusion.issue})`);
        }
      }
    }
    expect(
      violations,
      `the catalog ships ${violations.length} excluded command(s): ${violations.join(', ')}`
    ).toEqual([]);
  });

  // Without this, the guard above would also pass on an empty exclusions file.
  it('has a non-empty exclusions list to check against', () => {
    expect(DEFAULT_EXCLUSIONS.length).toBeGreaterThan(0);
  });
});

// Issue #1913: copilot and opencode were reconciled against the installed CLIs
// on 2026-08-22 (copilot 1.0.80, opencode 1.18.21 — the issue was filed against
// opencode 1.18.20, which auto-updated before the work started).
//
// Both sets are pinned by name rather than by count, because a count alone
// cannot tell "we added the 21 missing commands" from "we added 21 commands".
// The sources are recorded next to each list so the next reconcile can re-run
// exactly the same measurement.
describe('copilot / opencode catalog reconcile (Issue #1913)', () => {
  /**
   * `copilot help commands` on GitHub Copilot CLI 1.0.80 (67 rows) plus /undo.
   *
   * /undo is in the interactive palette but not in `help commands`, the same
   * hidden-alias shape /clear and /quit have on codex (#1503). /footer and
   * /rewind are the mirror case — in `help commands`, not listed in the palette
   * scroll, but matched on full input — so all three are carried.
   *
   * /streamer-mode is NOT here: it is in neither surface on 1.0.80.
   */
  const COPILOT_1_0_80 = [
    'add-dir', 'agent', 'allow-all', 'app', 'ask', 'autopilot', 'changelog',
    'chronicle', 'clear', 'compact', 'context', 'copy', 'cwd', 'delegate',
    'diagnose', 'diff', 'env', 'exit', 'experimental', 'feedback', 'fleet',
    'footer', 'fork', 'help', 'ide', 'init', 'instructions', 'keep-alive',
    'limits', 'list-dirs', 'login', 'logout', 'lsp', 'mcp', 'memory', 'model',
    'new', 'permissions', 'plan', 'plugin', 'pr', 'refine', 'remote', 'rename',
    'research', 'reset-allowed-tools', 'restart', 'resume', 'review', 'rewind',
    'rubber-duck', 'search', 'security-review', 'session', 'settings', 'share',
    'skills', 'statusline', 'subagents', 'tasks', 'terminal-setup', 'theme',
    'undo', 'update', 'usage', 'user', 'version', 'voice',
  ];

  /** The opencode 1.18.21 slash palette, scrolled end to end (18 rows). */
  const OPENCODE_1_18_21 = [
    'agents', 'connect', 'debug', 'diff', 'editor', 'exit', 'help', 'init',
    'mcps', 'models', 'move', 'new', 'review', 'sessions', 'skills', 'status',
    'themes', 'variants',
  ];

  const visibleTo = (tool: string): string[] =>
    STANDARD_COMMANDS.filter((c) => c.cliTools?.includes(tool as never))
      .map((c) => c.name)
      .sort();

  it('ships exactly the copilot 1.0.80 command set', () => {
    expect(visibleTo('copilot')).toEqual([...COPILOT_1_0_80].sort());
  });

  it('ships exactly the opencode 1.18.21 palette', () => {
    expect(visibleTo('opencode')).toEqual([...OPENCODE_1_18_21].sort());
  });

  // The two phantoms this reconcile removed. Both are recorded in
  // src/config/slash-commands-exclusions.json so catalog:refresh stops
  // proposing them; this is the catalog-side half of that decision.
  it('carries neither phantom: /streamer-mode anywhere, /compact on opencode', () => {
    expect(STANDARD_COMMANDS.some((c) => c.name === 'streamer-mode')).toBe(false);
    expect(
      STANDARD_COMMANDS.some((c) => c.name === 'compact' && c.cliTools?.includes('opencode'))
    ).toBe(false);
  });

  // The bug that motivated the move: copilot built-ins used to live in
  // getCopilotBuiltinCommands() with literal English `description`, so a ja
  // user saw English for copilot and only copilot.
  it('gives every copilot entry a descriptionKey and no literal description', () => {
    const copilotEntries = STANDARD_COMMANDS.filter((c) => c.cliTools?.includes('copilot'));
    expect(copilotEntries.length).toBe(COPILOT_1_0_80.length);
    for (const cmd of copilotEntries) {
      expect(cmd.cliTools).toEqual(['copilot']);
      expect(cmd.description).toBeUndefined();
      expect(allowedDescriptionKeys(cmd)).toContain(cmd.descriptionKey);
      expect(cmd.source).toBe('standard');
      expect(cmd.isStandard).toBe(true);
    }
  });

  it('resolves every copilot description in both locales', () => {
    for (const locale of LOCALES) {
      for (const cmd of STANDARD_COMMANDS.filter((c) => c.cliTools?.includes('copilot'))) {
        const text = descriptionFor(cmd, locale);
        expect(text, `${locale} missing /${cmd.name}`).toBeTruthy();
        expect(hasReviewMarker(text ?? '')).toBe(false);
      }
    }
  });

  // The headline i18n defect: one flat `descriptions.exit` held "Exit OpenCode
  // TUI", and claude / codex both resolved through it. Splitting it per tool is
  // only useful if each entry actually points at its own leaf.
  it('gives /exit a tool-scoped key per tool, and keeps the OpenCode wording on opencode', () => {
    const exits = STANDARD_COMMANDS.filter((c) => c.name === 'exit');
    expect(exits.map((c) => c.cliTools?.join(',')).sort()).toEqual([
      'claude',
      'codex',
      'copilot',
      'opencode',
    ]);
    for (const cmd of exits) {
      const tool = cmd.cliTools?.[0] as string;
      expect(cmd.descriptionKey).toBe(toolDescriptionKeyFor('exit', tool));
    }

    for (const locale of LOCALES) {
      const dict = loadDescriptions(locale);
      const opencodeText = dict['exit.opencode'];
      expect(opencodeText).toBeTruthy();
      for (const tool of ['claude', 'codex', 'copilot']) {
        expect(dict[`exit.${tool}`], `${locale} exit.${tool}`).toBeTruthy();
        expect(
          dict[`exit.${tool}`],
          `${locale}: /exit on ${tool} still ships the opencode wording`
        ).not.toBe(opencodeText);
      }
    }
  });

  // Splitting a key is a rewrite of every claimant, not an addition: a flat
  // string cannot coexist with `<name>.<tool>` leaves, so an entry left on the
  // old flat key resolves to undefined and renders blank.
  it('leaves no entry pointing at a flat key that was split per tool', () => {
    const splitNames = ['exit', 'login', 'logout', 'feedback', 'skills', 'init', 'agent',
      'plugin', 'memory', 'app', 'debug'];
    for (const locale of LOCALES) {
      const dict = loadDescriptions(locale);
      for (const name of splitNames) {
        expect(dict[name], `${locale}: ${name} is still a flat string`).toBeUndefined();
      }
    }
    for (const cmd of STANDARD_COMMANDS) {
      if (!splitNames.includes(cmd.name)) continue;
      expect(cmd.descriptionKey, `/${cmd.name} still uses the flat key`).not.toBe(
        descriptionKeyFor(cmd.name)
      );
    }
  });

  it('records the probed CLI versions in verifiedAgainst', () => {
    expect(CATALOG_VERIFIED_AGAINST.copilot).toBe('1.0.80');
    expect(CATALOG_VERIFIED_AGAINST.opencode).toBe('1.18.21');
  });
});

describe('FREQUENTLY_USED', () => {
  it('should be an object with cli tool keys', () => {
    expect(FREQUENTLY_USED).toBeDefined();
    expect(FREQUENTLY_USED.claude).toBeDefined();
    expect(FREQUENTLY_USED.codex).toBeDefined();
    expect(FREQUENTLY_USED.opencode).toBeDefined();
  });

  it('should contain 5 frequently used commands per tool', () => {
    expect(FREQUENTLY_USED.claude.length).toBe(5);
    expect(FREQUENTLY_USED.codex.length).toBe(5);
    expect(FREQUENTLY_USED.opencode.length).toBe(5);
  });

  it('should only contain names that exist in STANDARD_COMMANDS', () => {
    const standardNames = STANDARD_COMMANDS.map((c) => c.name);
    Object.values(FREQUENTLY_USED).forEach((names) => {
      names.forEach((name: string) => {
        expect(standardNames).toContain(name);
      });
    });
  });

  it('Claude frequently used should include clear and compact', () => {
    expect(FREQUENTLY_USED.claude).toContain('clear');
    expect(FREQUENTLY_USED.claude).toContain('compact');
  });

  // Issue #1503: /undo and /approvals were phantom on codex 0.144.6 and were
  // dropped from frequentlyUsed; /status and /review backfill to keep the list at 5.
  it('Codex frequently used should include new, plan, status (not undo/approvals/mcp)', () => {
    expect(FREQUENTLY_USED.codex).toContain('new');
    expect(FREQUENTLY_USED.codex).toContain('plan');
    expect(FREQUENTLY_USED.codex).toContain('status');
    expect(FREQUENTLY_USED.codex).not.toContain('undo');
    expect(FREQUENTLY_USED.codex).not.toContain('approvals');
    expect(FREQUENTLY_USED.codex).not.toContain('mcp');
  });

  // Issue #1913: /compact is not in the opencode 1.18.21 palette, so it left
  // this list too — leaving it in would re-surface the phantom through the
  // frequently-used row, which is exactly how #1502 leaked into antigravity.
  // /status backfills to keep the list at 5.
  it('OpenCode frequently used should be 5 real, opencode-visible commands', () => {
    expect(FREQUENTLY_USED.opencode).toEqual(['models', 'new', 'status', 'help', 'exit']);
    expect(FREQUENTLY_USED.opencode).not.toContain('compact');
    FREQUENTLY_USED.opencode.forEach((name) => {
      const visible = STANDARD_COMMANDS.some(
        (c) => c.name === name && c.cliTools?.includes('opencode')
      );
      expect(visible, `frequentlyUsed /${name} is not opencode-visible`).toBe(true);
    });
  });

  // Issue #1502: antigravity gets its own frequentlyUsed list (was falling back
  // to Claude's, which surfaced the phantom /compact, /status, /review).
  it('Antigravity frequently used should be 5 real, antigravity-visible commands (Issue #1502)', () => {
    expect(FREQUENTLY_USED.antigravity).toBeDefined();
    expect(FREQUENTLY_USED.antigravity.length).toBe(5);
    FREQUENTLY_USED.antigravity.forEach((name) => {
      const visible = STANDARD_COMMANDS.some(
        (c) => c.name === name && c.cliTools?.includes('antigravity')
      );
      expect(visible, `frequentlyUsed /${name} is not antigravity-visible`).toBe(true);
    });
    // None of the phantom commands may leak back in via this list.
    ['compact', 'status', 'review'].forEach((phantom) => {
      expect(FREQUENTLY_USED.antigravity).not.toContain(phantom);
    });
  });
});

describe('getStandardCommandGroups', () => {
  it('should return groups organized by category', () => {
    const groups = getStandardCommandGroups();
    expect(Array.isArray(groups)).toBe(true);
    expect(groups.length).toBeGreaterThan(0);
  });

  it('should have proper group structure', () => {
    const groups = getStandardCommandGroups();
    groups.forEach((group) => {
      expect(group).toHaveProperty('category');
      expect(group).toHaveProperty('label');
      expect(group).toHaveProperty('commands');
      expect(Array.isArray(group.commands)).toBe(true);
      expect(group.commands.length).toBeGreaterThan(0);
    });
  });

  it('should include standard category groups', () => {
    const groups = getStandardCommandGroups();
    const categories = groups.map((g) => g.category);
    expect(categories).toContain('standard-session');
    expect(categories).toContain('standard-config');
    expect(categories).toContain('standard-monitor');
    expect(categories).toContain('standard-git');
    expect(categories).toContain('standard-util');
  });

  it('should have localized labels for each category', () => {
    const groups = getStandardCommandGroups();
    groups.forEach((group) => {
      expect(group.label).toBeDefined();
      expect(group.label.length).toBeGreaterThan(0);
    });
  });

  it('should mark all commands as standard', () => {
    const groups = getStandardCommandGroups();
    groups.forEach((group) => {
      group.commands.forEach((cmd) => {
        expect(cmd.isStandard).toBe(true);
        expect(cmd.source).toBe('standard');
      });
    });
  });
});

describe('getFrequentlyUsedCommands', () => {
  it('should return Claude frequently used commands by default', () => {
    const commands = getFrequentlyUsedCommands();
    expect(commands.length).toBeGreaterThan(0);
    expect(commands.some((c) => c.name === 'clear')).toBe(true);
    expect(commands.some((c) => c.name === 'compact')).toBe(true);
  });

  it('should return Claude commands when cliToolId is claude', () => {
    const commands = getFrequentlyUsedCommands('claude');
    expect(commands.length).toBe(5);
    expect(commands.some((c) => c.name === 'clear')).toBe(true);
    // All returned commands should be Claude commands (no cliTools or includes 'claude')
    commands.forEach((cmd) => {
      expect(!cmd.cliTools || cmd.cliTools.includes('claude')).toBe(true);
    });
  });

  it('should return Codex commands when cliToolId is codex', () => {
    const commands = getFrequentlyUsedCommands('codex');
    expect(commands.length).toBe(5);
    expect(commands.some((c) => c.name === 'new')).toBe(true);
    expect(commands.some((c) => c.name === 'status')).toBe(true);
    // All returned commands should be available for Codex
    commands.forEach((cmd) => {
      expect(cmd.cliTools).toContain('codex');
    });
  });

  it('should not return Claude-only commands for Codex', () => {
    const commands = getFrequentlyUsedCommands('codex');
    // 'clear' is Claude-only (no cliTools), should not be in Codex list
    expect(commands.some((c) => c.name === 'clear')).toBe(false);
  });

  // Issue #1913: /compact left the opencode scope (not in the 1.18.21 palette)
  // and /status took its slot in frequentlyUsed.opencode.
  it('should return OpenCode commands when cliToolId is opencode', () => {
    const commands = getFrequentlyUsedCommands('opencode');
    expect(commands.length).toBe(5);
    expect(commands.some((c) => c.name === 'models')).toBe(true);
    expect(commands.some((c) => c.name === 'new')).toBe(true);
    expect(commands.some((c) => c.name === 'status')).toBe(true);
    expect(commands.some((c) => c.name === 'compact')).toBe(false);
    expect(commands.some((c) => c.name === 'help')).toBe(true);
    expect(commands.some((c) => c.name === 'exit')).toBe(true);
    // All returned commands should be available for OpenCode
    commands.forEach((cmd) => {
      expect(cmd.cliTools).toContain('opencode');
    });
  });

  it('should not return Claude-only commands for OpenCode', () => {
    const commands = getFrequentlyUsedCommands('opencode');
    // 'clear' is Claude-only (no cliTools), should not be in OpenCode list
    expect(commands.some((c) => c.name === 'clear')).toBe(false);
  });

  // Issue #1502: antigravity now has its own list; resolve it to real entries.
  it('should return Antigravity commands when cliToolId is antigravity', () => {
    const commands = getFrequentlyUsedCommands('antigravity');
    expect(commands.length).toBe(5);
    commands.forEach((cmd) => {
      expect(cmd.cliTools).toContain('antigravity');
    });
    // No phantom command survives resolution.
    ['compact', 'status', 'review'].forEach((phantom) => {
      expect(commands.some((c) => c.name === phantom)).toBe(false);
    });
  });
});

// Issue #1306: descriptions live in locales/{en,ja}/worktree.json and are
// resolved by the renderer. These guards read the shipped dictionaries, so a
// deleted/renamed/untranslated key fails here rather than shipping a raw key
// into the UI.
describe('STANDARD_COMMANDS description dictionary (Issue #1306)', () => {
  it('should resolve every descriptionKey in every locale', () => {
    for (const locale of LOCALES) {
      for (const cmd of STANDARD_COMMANDS) {
        const text = descriptionFor(cmd, locale);
        expect(
          typeof text === 'string' && text.length > 0,
          `${locale}/worktree.json is missing ${cmd.descriptionKey}`
        ).toBe(true);
      }
    }
  });

  // Issue #1704: matched against the keys entries actually carry, not against
  // command names — a tool-scoped override makes those two sets differ.
  it('should not carry description keys that no command uses', () => {
    const used = new Set(
      STANDARD_COMMANDS.map((cmd) => cmd.descriptionKey?.slice(DESCRIPTION_KEY_PREFIX.length))
    );
    for (const locale of LOCALES) {
      const orphans = Object.keys(loadDescriptions(locale)).filter((key) => !used.has(key));
      expect(orphans, `${locale} has orphaned description keys`).toEqual([]);
    }
  });

  it('should keep en and ja description key sets identical', () => {
    expect(Object.keys(loadDescriptions('ja')).sort()).toEqual(
      Object.keys(loadDescriptions('en')).sort()
    );
  });

  it('should have no CJK text in the en dictionary', () => {
    const dict = loadDescriptions('en');
    for (const [key, value] of Object.entries(dict)) {
      expect(value, `en description "${key}" contains CJK text`).not.toMatch(
        /[぀-ゟ゠-ヿ一-鿿]/
      );
    }
  });

  it('should actually translate every ja description rather than echoing en', () => {
    const en = loadDescriptions('en');
    const ja = loadDescriptions('ja');
    const untranslated = Object.keys(en).filter((key) => en[key] === ja[key]);
    expect(untranslated, 'ja descriptions identical to en').toEqual([]);
  });

  // Issue #1703: `catalog:refresh --write` seeds every new ja description with
  // the JA_REVIEW_PREFIX placeholder (ja text is out of reach of the heuristic
  // extraction), so a reconcile pass opens this leak *every* time. None of the
  // guards above close it — the key exists, and the marker itself makes ja
  // differ from en, so even the echo check passes. v0.21.2 reached its release
  // PR with 86 such placeholders and was caught only by reading the diff.
  it('should not ship untranslated review placeholders in any description', () => {
    const offenders: string[] = [];
    for (const locale of LOCALES) {
      for (const [key, value] of Object.entries(loadDescriptions(locale))) {
        if (hasReviewMarker(value)) offenders.push(`${locale}/${key}`);
      }
    }
    expect(
      offenders,
      `${offenders.length} description(s) still carry the "${JA_REVIEW_PREFIX.trim()}" ` +
        `translation marker — translate them before release: ${offenders.join(', ')}`
    ).toEqual([]);
  });

  // Same marker, hand-authored strings: the reconcile only writes into
  // slashCommands.descriptions, so this sweep covers the rest of the shipped
  // namespace (a human copying a placeholder elsewhere). Disjoint from the
  // guard above so one leak reports in exactly one place.
  it('should not leave review placeholders anywhere else in the shipped locales', () => {
    const offenders: string[] = [];
    for (const locale of LOCALES) {
      for (const [key, value] of flattenStrings(loadLocaleFile(locale))) {
        if (key.startsWith('slashCommands.descriptions.')) continue;
        if (hasReviewMarker(value)) offenders.push(`${locale}/${key}`);
      }
    }
    expect(
      offenders,
      `${offenders.length} locale string(s) still carry the "${JA_REVIEW_PREFIX.trim()}" ` +
        `translation marker: ${offenders.join(', ')}`
    ).toEqual([]);
  });
});
