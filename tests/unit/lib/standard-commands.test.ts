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
  getStandardCommandGroups,
  getFrequentlyUsedCommands,
} from '@/lib/standard-commands';
import { keyOf } from '@/lib/command-merger';
import type { SlashCommandCategory } from '@/types/slash-commands';

const LOCALES = ['en', 'ja'] as const;

/**
 * Read the real `slashCommands.descriptions` block straight off disk.
 *
 * Issue #1306: these tests must fail when a key is missing from the shipped
 * dictionary, so they read the actual JSON rather than a mocked translator.
 */
function loadDescriptions(locale: (typeof LOCALES)[number]): Record<string, string> {
  const file = path.resolve(__dirname, `../../../locales/${locale}/worktree.json`);
  const dict = JSON.parse(fs.readFileSync(file, 'utf8'));
  return dict.slashCommands?.descriptions ?? {};
}

describe('STANDARD_COMMANDS', () => {
  // Issue #1488: +9 Claude built-ins (loop, add-dir, mcp, usage, memory,
  // statusline, terminal-setup, hooks, agents), all cliTools: ['claude'].
  // Issue #1502: +9 Antigravity real commands (help, usage, mcp, hooks, diff,
  // fork, plan, rewind, tasks), all cliTools: ['antigravity'].
  // Issue #1503: -7 phantom entries removed — claude cost/lazy/todos/pr-comments
  // + the "(removed)" claude /agents stub, and codex approvals/undo. 63 -> 56.
  it('should have 56 standard commands (Issue #1503: 63 - 7 phantom)', () => {
    expect(STANDARD_COMMANDS.length).toBe(56);
  });

  it('should have all required properties for each command', () => {
    STANDARD_COMMANDS.forEach((cmd) => {
      expect(cmd.name).toBeDefined();
      expect(cmd.name.length).toBeGreaterThan(0);
      // Issue #1306: descriptions moved into the dictionary; the definition
      // carries a key, and the literal description is gone.
      expect(cmd.descriptionKey).toBe(`slashCommands.descriptions.${cmd.name}`);
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

  it('should have commands shared between Claude and OpenCode', () => {
    const sharedCommands = ['compact', 'help'];
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

  it('should have 10 commands available for OpenCode', () => {
    const opencodeCommands = STANDARD_COMMANDS.filter(
      (cmd) => cmd.cliTools?.includes('opencode')
    );
    expect(opencodeCommands.length).toBe(10);
  });

  // Issue #1503: -2 codex phantoms (approvals/undo) removed → 23.
  it('should have 23 commands available for Codex (Issue #1503: 25 - 2 phantom)', () => {
    const codexCommands = STANDARD_COMMANDS.filter(
      (cmd) => cmd.cliTools?.includes('codex')
    );
    expect(codexCommands.length).toBe(23);
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
  // and were purged; the "(removed)" claude /agents stub went too, leaving only
  // the opencode /agents. None of them may reappear in the catalog.
  it('does not carry the Issue #1503 phantom commands', () => {
    for (const name of ['cost', 'lazy', 'todos', 'pr-comments', 'approvals', 'undo']) {
      expect(STANDARD_COMMANDS.some((c) => c.name === name), `/${name} must be gone`).toBe(false);
    }
    const agentsEntries = STANDARD_COMMANDS.filter((c) => c.name === 'agents');
    expect(agentsEntries.length).toBe(1);
    expect(agentsEntries[0].cliTools).toEqual(['opencode']);
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
  it('should have 24 commands available for Claude (Issue #1503: 29 - 5 phantom)', () => {
    const claudeCommands = STANDARD_COMMANDS.filter(
      (cmd) => !cmd.cliTools || cmd.cliTools.includes('claude')
    );
    expect(claudeCommands.length).toBe(24);
  });

  // Issue #689: agent (Codex) vs agents (OpenCode) differentiation (DR1-002)
  // Issue #1306: distinct keys are not enough — two keys can hold identical
  // text (see /model and /models), so assert the resolved text differs too.
  it('agent (Codex) and agents (OpenCode) should have distinct descriptions', () => {
    const agent = STANDARD_COMMANDS.find((c) => c.name === 'agent');
    const agents = STANDARD_COMMANDS.find((c) => c.name === 'agents');
    expect(agent).toBeDefined();
    expect(agents).toBeDefined();
    expect(agent?.descriptionKey).not.toBe(agents?.descriptionKey);

    for (const locale of LOCALES) {
      const dict = loadDescriptions(locale);
      expect(dict.agent).toBeTruthy();
      expect(dict.agents).toBeTruthy();
      expect(dict.agent).not.toBe(dict.agents);
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
      const dict = loadDescriptions(locale);
      STANDARD_COMMANDS.forEach((cmd) => {
        const description = dict[cmd.name];
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
  const NEW_CLAUDE_BUILTINS: Array<{ name: string; category: SlashCommandCategory }> = [
    { name: 'loop', category: 'standard-util' },
    { name: 'add-dir', category: 'standard-util' },
    { name: 'mcp', category: 'standard-util' },
    { name: 'usage', category: 'standard-monitor' },
    { name: 'memory', category: 'standard-config' },
    { name: 'statusline', category: 'standard-config' },
    { name: 'terminal-setup', category: 'standard-config' },
    { name: 'hooks', category: 'standard-config' },
    // Issue #1503: /agents was a "(removed)" stub on claude 2.1.218 and was
    // purged; the opencode /agents entry stays (asserted separately below).
  ];

  it('registers each new built-in with cliTools: ["claude"], the right category, and a name-derived key', () => {
    for (const { name, category } of NEW_CLAUDE_BUILTINS) {
      const claudeEntry = STANDARD_COMMANDS.find(
        (c) => c.name === name && c.cliTools?.length === 1 && c.cliTools[0] === 'claude'
      );
      expect(claudeEntry, `missing Claude entry for /${name}`).toBeDefined();
      expect(claudeEntry?.category).toBe(category);
      expect(claudeEntry?.descriptionKey).toBe(`slashCommands.descriptions.${name}`);
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
      for (const { name } of NEW_CLAUDE_BUILTINS) {
        const text = dict[name];
        expect(typeof text === 'string' && text.length > 0, `${locale} missing /${name}`).toBe(true);
        expect(text).not.toBe(`slashCommands.descriptions.${name}`);
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

  // /schedule is deliberately out of scope; /vim was removed upstream in v2.1.92
  // so it must not ship in a catalog verified against 2.1.218.
  it('does not add /schedule or /vim', () => {
    expect(STANDARD_COMMANDS.some((c) => c.name === 'schedule')).toBe(false);
    expect(STANDARD_COMMANDS.some((c) => c.name === 'vim')).toBe(false);
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

  it('OpenCode frequently used should include models, new, compact, help, exit', () => {
    expect(FREQUENTLY_USED.opencode).toContain('models');
    expect(FREQUENTLY_USED.opencode).toContain('new');
    expect(FREQUENTLY_USED.opencode).toContain('compact');
    expect(FREQUENTLY_USED.opencode).toContain('help');
    expect(FREQUENTLY_USED.opencode).toContain('exit');
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

  it('should return OpenCode commands when cliToolId is opencode', () => {
    const commands = getFrequentlyUsedCommands('opencode');
    expect(commands.length).toBe(5);
    expect(commands.some((c) => c.name === 'models')).toBe(true);
    expect(commands.some((c) => c.name === 'new')).toBe(true);
    expect(commands.some((c) => c.name === 'compact')).toBe(true);
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
      const dict = loadDescriptions(locale);
      for (const cmd of STANDARD_COMMANDS) {
        expect(
          typeof dict[cmd.name] === 'string' && dict[cmd.name].length > 0,
          `${locale}/worktree.json is missing slashCommands.descriptions.${cmd.name}`
        ).toBe(true);
      }
    }
  });

  it('should not carry description keys that no command uses', () => {
    const names = new Set(STANDARD_COMMANDS.map((cmd) => cmd.name));
    for (const locale of LOCALES) {
      const orphans = Object.keys(loadDescriptions(locale)).filter((key) => !names.has(key));
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
});
