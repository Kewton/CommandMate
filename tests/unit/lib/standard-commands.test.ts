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
import {
  DEFAULT_ATTESTATIONS,
  attestedCatalogNames,
  attestedVersions,
  buildAttestationIndex,
  describeAttestationViolation,
  findAttestationViolations,
  toolsOfCommand,
} from '@/lib/slash-command-reconcile/attestations';
import type { CatalogAttestation } from '@/lib/slash-command-reconcile/types';
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

const ATTESTATION_INDEX = buildAttestationIndex(DEFAULT_ATTESTATIONS);

/** Every catalog name a tool can see, sorted (an entry naming no tool is Claude's). */
function visibleTo(tool: string): string[] {
  return STANDARD_COMMANDS.filter((cmd) => toolsOfCommand(cmd).includes(tool))
    .map((cmd) => cmd.name)
    .sort();
}

/**
 * What the catalog must ship for `tool`: the set its source enumerated, minus
 * the names a human decided to keep out (Issue #2026).
 *
 * Read from src/config/slash-commands-attestations.json rather than written here
 * as a literal. That is the whole change #2026 makes to these pins: the number
 * used to be typed into this file and the evidence for it lived in a commit
 * message, so a *correct* refresh and a blind one turned the same assertions red
 * and the only way to tell them apart was archaeology. The expectation is still
 * hand-written — just in the file that also says which document, at which
 * version, on which day, it was read from.
 */
function attestedFor(tool: string): string[] {
  const attestation = ATTESTATION_INDEX.get(tool);
  if (!attestation) throw new Error(`no attestation covers ${tool}`);
  return attestedCatalogNames(attestation, DEFAULT_EXCLUSIONS);
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
  // Issue #2024: codex 0.149.0 replaced /agent with /agents and added /cd, /pwd
  // (-1 +3), and claude added /artifacts, /auto-mode-setup (+2). 240 -> 244.
  //
  // Issue #2026 retires the literal. `toBe(244)` did the job the comment above
  // describes — force a human to look before a refresh lands — but it did it by
  // describing the old set with a number nobody could check, so clearing the red
  // meant retyping it and the evidence stayed in a commit message. What replaces
  // it is the same statement made against data a human had to write down: the
  // (tool, command) pairs the catalog serves are exactly the attested pairs,
  // minus curation. It is strictly stronger — it fails on every change the count
  // failed on, and it names which command on which tool moved.
  //
  // 244 is also the one number in this file that is not attestable: it counts
  // catalog *rows*, and a row is a grouping decision (`clear` serves three tools
  // from one row), not something any CLI enumerates.
  it('serves exactly the attested (tool, command) pairs', () => {
    const served = STANDARD_COMMANDS.flatMap((cmd) =>
      toolsOfCommand(cmd).map((tool) => `${tool}:${cmd.name}`)
    );
    const attested = DEFAULT_ATTESTATIONS.flatMap((attestation) =>
      attestedCatalogNames(attestation, DEFAULT_EXCLUSIONS).map((name) => `${attestation.tool}:${name}`)
    );
    // Duplicates matter: two rows serving the same name to the same tool is a
    // real defect (the palette shows it twice), and a set comparison would hide it.
    expect(served.length).toBe(new Set(served).size);
    expect([...served].sort()).toEqual([...attested].sort());
  });

  // The one thing `toBe(244)` caught that the pair identity above does not:
  // merging two same-name rows into one multi-tool row leaves every tool's set
  // untouched while the row count drops. It only matters when the rows carry
  // different description keys — which is exactly what merging would destroy, so
  // that is what is pinned instead of the count. Merging two rows that already
  // share the flat key changes nothing a user can see.
  it('never lets a row serving several tools carry a tool-scoped description key', () => {
    for (const cmd of STANDARD_COMMANDS) {
      if ((cmd.cliTools?.length ?? 0) < 2) continue;
      expect(cmd.descriptionKey, `/${cmd.name} serves ${cmd.cliTools?.join(',')}`).toBe(
        descriptionKeyFor(cmd.name)
      );
    }
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

  // Issue #1502 measured this set off the agy 1.1.3 palette (4 shared + 9 real);
  // Issue #2026 moved the measurement itself into the attestation file, so the
  // assertion names the commands instead of counting them.
  it('should ship exactly the attested Antigravity command set', () => {
    expect(visibleTo('antigravity')).toEqual(attestedFor('antigravity'));
  });

  // Issue #1913: /compact used to be listed here too. It is not in the opencode
  // palette — typing the full /compact matches nothing but the /review
  // description text — so the opencode scope was dropped from that entry.
  // Issue #2036 re-measured this on 1.18.22 and found it worse than absent:
  // Enter on that fuzzy match substitutes /review into the composer, so the
  // entry would offer one command and run another.
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
      // Issue #2024: /agent left the codex enum in 0.149.0 (replaced by
      // /agents). The copilot /agent entry is a different row and stays.
      'agents',
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
  // Issue #2036: re-read on 1.18.22 against two sources that had to agree —
  // `GET /command` (which carries /init and /review and nothing else here) and
  // the palette scrolled end to end. Same 18 names, so the set does not move.
  it('should ship exactly the attested OpenCode command set', () => {
    expect(visibleTo('opencode')).toEqual(attestedFor('opencode'));
  });

  // Issue #1503: -2 codex phantoms (approvals/undo) removed → 23.
  // v0.21.2: reconciled against the codex 0.146.0 enum → 53. Later reconciles
  // took it to 54 (the title said 53 until #2024 measured it again).
  // Issue #2024: reconciled against the 0.149.0 enum. `SlashCommand::Agent` is
  // gone — the enum ships `Agents` and `MultiAgents` (= /subagents) instead —
  // and `Cd` / `Pwd` are new. -1 +3 → 56.
  // Issue #2026: those 56 names now live in the attestation, read off
  // rust-v0.149.1, so this assertion states which commands rather than how many.
  it('should ship exactly the attested Codex command set', () => {
    expect(visibleTo('codex')).toEqual(attestedFor('codex'));
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
  //
  // Issue #2024: on codex 0.149.0 all three are plainly *visible*. `is_visible()`
  // in codex-rs/tui/src/slash_command.rs special-cases only SandboxReadRoot /
  // Copy / App / Rollout / TestApproval and falls through to `_ => true`, so
  // Clear, Quit and MultiAgents (`#[strum(serialize = "subagents")]`) are all in
  // the popup. The 0.144.6 "hidden alias" observation no longer describes the
  // CLI; the pin it justified — these must not be deleted — still holds, which
  // is why the assertion is unchanged and only the reasoning is dated.
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
  //
  // Issue #2024 widens the /agents half a third time, for the third time on
  // evidence rather than on the string: codex 0.149.0 declares
  // `SlashCommand::Agents => "view and switch between all active agent
  // sessions"`, so codex joins claude and opencode. All three still mean
  // different things, so the "never share a key" half is what carries the pin.
  //
  // Issue #2026 stops spelling that claimant list as a literal and reads it off
  // the attestations instead. Both halves of the #1503 guard survive intact:
  // a tool gains /agents only when *its* attestation says its source enumerates
  // it (so a phantom from a docs stub is still red, which is the original #1503
  // defect), and a tool losing it is still red. What is gone is the third widening
  // in a row that had to be typed in by hand after the evidence was already
  // written down somewhere else.
  //
  // Issue #2253 narrows /todos and /pr-comments the way #1913 narrowed /undo,
  // and for the same reason. Both were **claude** phantoms in #1503, and both
  // are real on Command Code 1.40.1: `/todos` and `/pr-comments` are entries in
  // the shipped command registry of command-code@1.40.1/dist/cli.mjs, rows in
  // the "Slash Commands" section of `commandcode --help`, and rows in the
  // Built-in Commands tables of the attested source. Banning the string would
  // hide two real commands, so each ban now names the tool it was measured on.
  it('does not carry the Issue #1503 phantom commands', () => {
    for (const name of ['cost', 'lazy', 'approvals']) {
      expect(STANDARD_COMMANDS.some((c) => c.name === name), `/${name} must be gone`).toBe(false);
    }
    for (const name of ['todos', 'pr-comments']) {
      expect(
        STANDARD_COMMANDS.some((c) => c.name === name && toolsOfCommand(c).includes('claude')),
        `/${name} must stay off claude`
      ).toBe(false);
    }
    expect(
      STANDARD_COMMANDS.some((c) => c.name === 'undo' && c.cliTools?.includes('codex')),
      '/undo must stay off codex'
    ).toBe(false);

    const attestedClaimants = DEFAULT_ATTESTATIONS.filter((a) =>
      attestedCatalogNames(a, DEFAULT_EXCLUSIONS).includes('agents')
    ).map((a) => a.tool);
    // The evidence trail #1503/#1767/#1913/#2024/#2253 built, now stated once:
    // four tools ship /agents and copilot ships /agent, a different command.
    expect([...attestedClaimants].sort()).toEqual([
      'claude',
      'codex',
      'command-code',
      'opencode',
    ]);

    const agentsEntries = STANDARD_COMMANDS.filter((c) => c.name === 'agents');
    expect(agentsEntries.flatMap((c) => toolsOfCommand(c)).sort()).toEqual(
      [...attestedClaimants].sort()
    );
    // Each entry stays its own row with its own key: the three tools mean three
    // different things, and one shared key cannot hold them (Issue #1704).
    expect(agentsEntries).toHaveLength(attestedClaimants.length);
    expect(new Set(agentsEntries.map((c) => c.descriptionKey)).size).toBe(attestedClaimants.length);
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
  // Issue #2024: /agent → /agents (the 0.149.0 enum dropped `SlashCommand::Agent`).
  // /agents is selected by tool because claude and opencode also ship the name.
  it('should have new Codex commands in correct categories', () => {
    const sessionCommands = ['plan', 'goal', 'agents', 'subagents', 'fork'];
    sessionCommands.forEach((name) => {
      const cmd = STANDARD_COMMANDS.find(
        (c) => c.name === name && c.cliTools?.includes('codex')
      );
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
  // Issue #2024: +2 (/artifacts, /auto-mode-setup) from the commands doc → 102.
  // Issue #2026: the attested claude set is 104 — the two extras are /schedule
  // and /ultraplan, both real rows on the docs page and both in the exclusions
  // file, which is why the expectation subtracts curation rather than being a
  // second, silently different list.
  it('should ship exactly the attested Claude command set', () => {
    expect(visibleTo('claude')).toEqual(attestedFor('claude'));
  });

  // Issue #689: agent (Codex) vs agents (OpenCode) differentiation (DR1-002)
  // Issue #1306: distinct keys are not enough — two keys can hold identical
  // text (see /model and /models), so assert the resolved text differs too.
  // Issue #1767: claude's /agents joined the pair meaning a third thing, so
  // `descriptions.agents` is now a per-tool object rather than one string.
  // Each entry is therefore resolved through its own key (a flat `dict.agents`
  // lookup would silently read undefined here), and all three must differ.
  // Issue #2024: codex moved from /agent to /agents, so the four claimants now
  // span both names — copilot keeps /agent, and three tools share /agents. This
  // is the guard the reconcile bug defeated: flattening `descriptions.agents`
  // to one string collapsed three of these four to a single sentence.
  it('agent (Copilot) and agents (OpenCode/Claude/Codex) have distinct descriptions', () => {
    type CliTool = NonNullable<SlashCommand['cliTools']>[number];
    const pick = (name: string, tool: CliTool): SlashCommand => {
      const cmd = STANDARD_COMMANDS.find((c) => c.name === name && c.cliTools?.includes(tool));
      expect(cmd, `/${name} must be ${tool}-visible`).toBeDefined();
      return cmd as SlashCommand;
    };
    const entries = [
      pick('agent', 'copilot'),
      pick('agents', 'opencode'),
      pick('agents', 'claude'),
      pick('agents', 'codex'),
    ];
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
    // Issue #2024: 'agent' → 'agents'. Leaving 'agent' here would have kept
    // passing by silently resolving to the copilot entry instead of a codex one.
    const newCommandNames = ['effort', 'fast', 'focus', 'plan', 'goal', 'agents', 'subagents', 'fork', 'memories', 'skills', 'hooks'];
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

// Issue #2026: the pins that used to describe the old set with literals.
//
// `toBe(244)` / `toBe(102)` / `toBe(56)` and the hard-coded /agents claimant
// list all existed to stop an unreviewed `catalog:refresh --write` from landing.
// They did that — and they fired just as loudly on a *correct* addition, where
// the only way to clear the red was to retype the number, leaving the evidence
// in a commit message that the next release would have to re-derive. #2024
// measured that cost, refused to relax the pins, and left the fix as this issue.
//
// The replacement is not a weaker check. It is the same check made against a
// record a human had to write: catalog(tool) === attested(tool) \ excluded(tool).
// It fails in all four directions, and unlike a count it says which command on
// which tool moved:
//
//   1. catalog grows, attestation does not  -> `unattested`  (blind --write)
//   2. both move together                   -> green         (the case #2024 could not express)
//   3. a name no source ever listed         -> `unattested`  (#1503's docs-stub phantom)
//   4. an attested name disappears          -> `missing`     (a real command lost)
//
// The comparator itself is exercised in
// tests/unit/lib/slash-command-reconcile/attestations.test.ts, which injects each
// of those four mutations; here it is pointed at the shipped catalog.
describe('catalog ≡ attestation \ exclusions (Issue #2026)', () => {
  it('ships exactly the attested command set for every tool', () => {
    const violations = findAttestationViolations(STANDARD_COMMANDS).map(describeAttestationViolation);
    expect(
      violations,
      `the catalog disagrees with the attestations in ${violations.length} place(s):\n${violations.join('\n')}`
    ).toEqual([]);
  });

  // A tool entering the catalog with no attestation would make the guard above
  // vacuous *for that tool* — nothing would be reviewing its set at all.
  it('has an attestation for every tool the catalog serves', () => {
    const served = new Set(STANDARD_COMMANDS.flatMap((cmd) => toolsOfCommand(cmd)));
    const attested = new Set(DEFAULT_ATTESTATIONS.map((a) => a.tool));
    expect([...served].sort()).toEqual([...attested].sort());
  });

  // And the attestations must actually say something: an empty `commands` list
  // is rejected by the loader, but a file with zero records would pass every
  // assertion above by having nothing to compare.
  it('has a non-empty attestation carrying commands for each tool', () => {
    expect(DEFAULT_ATTESTATIONS.length).toBeGreaterThan(0);
    for (const attestation of DEFAULT_ATTESTATIONS) {
      expect(attestation.commands.length, `${attestation.tool} attests nothing`).toBeGreaterThan(0);
    }
  });

  /**
   * The seam between the two files, pinned so property 4 cannot misfire.
   *
   * /schedule is a real claude command — it is on the docs page, so it is in the
   * attestation — that #1488 decided the palette does not carry. Without the
   * subtraction, "attested but not in the catalog" would read as a lost command
   * and this suite would demand that a settled curation decision be undone.
   */
  it('treats a command that is attested but excluded as a legitimate absence', () => {
    const claude = ATTESTATION_INDEX.get('claude') as CatalogAttestation;
    expect(claude.commands, '/schedule must be attested — it is real on claude').toContain('schedule');
    expect(
      findExclusion(buildExclusionIndex(DEFAULT_EXCLUSIONS), 'schedule', 'claude'),
      '/schedule must be excluded'
    ).toBeDefined();
    expect(visibleTo('claude')).not.toContain('schedule');
    // Scoped to /schedule on purpose: the whole-catalog assertion lives in its
    // own test above, so a mutation elsewhere does not also fail this one and
    // blur which seam broke.
    expect(findAttestationViolations(STANDARD_COMMANDS).filter((v) => v.name === 'schedule')).toEqual(
      []
    );

    // …and the subtraction is load-bearing rather than decorative: drop the
    // exclusions and the same catalog is reported as having lost /schedule.
    expect(findAttestationViolations(STANDARD_COMMANDS, { exclusions: [] })).toContainEqual({
      kind: 'missing',
      tool: 'claude',
      name: 'schedule',
    });
  });

  /**
   * `out-of-scope` means "real upstream, we chose not to surface it", so the
   * source must actually enumerate it. A row that claims out-of-scope for a name
   * no source lists is really a `phantom` mislabelled, and the two have very
   * different re-decision costs (Issue #1704). `phantom` gets no such assertion:
   * /ultraplan is a docs stub the parser does read (so it is attested) while
   * /streamer-mode is on neither copilot surface (so it is not) — both are
   * legitimately phantom.
   */
  it('backs every out-of-scope exclusion with an attestation that lists it', () => {
    for (const exclusion of DEFAULT_EXCLUSIONS) {
      if (exclusion.kind !== 'out-of-scope') continue;
      for (const tool of exclusion.cliTools) {
        expect(
          ATTESTATION_INDEX.get(tool)?.commands,
          `/${exclusion.name} is out-of-scope on ${tool}, so ${tool}'s source must list it`
        ).toContain(exclusion.name);
      }
    }
  });

  it('derives CATALOG_VERIFIED_AGAINST from the attestations', () => {
    expect(CATALOG_VERIFIED_AGAINST).toEqual(attestedVersions(DEFAULT_ATTESTATIONS));
  });

  /**
   * The stamp must not come back as a second copy.
   *
   * While it lived in the catalog file it was editable independently of the set
   * it described — and `catalog:refresh --write` did edit it independently, so a
   * version could advance past the last reading anybody had actually done. This
   * reads the shipped JSON rather than the parsed module, because the module
   * would happily ignore an extra key.
   */
  it('keeps the version stamp out of the catalog file', () => {
    const file = path.resolve(__dirname, '../../../src/config/slash-commands-catalog.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(raw).sort()).toEqual(['commands', 'frequentlyUsed']);
  });
});

// Issue #1913: copilot and opencode were reconciled against the installed CLIs
// on 2026-08-22 (copilot 1.0.80, opencode 1.18.21 — the issue was filed against
// opencode 1.18.20, which auto-updated before the work started).
//
// Both sets are pinned by name rather than by count, because a count alone
// cannot tell "we added the 21 missing commands" from "we added 21 commands".
//
// Issue #2026: those two name lists were already attestations — "as of 1.0.80,
// `copilot help commands` plus the palette listed exactly these 68" — written in
// the one place `catalog:refresh` cannot read. They moved verbatim into
// src/config/slash-commands-attestations.json, with the probe date and issue
// number that used to live in this comment, and every tool now gets the same
// treatment instead of only the two whose reconcile happened to be manual. The
// set assertions themselves live in the STANDARD_COMMANDS block above; what
// stays here is what is specific to these two tools.
describe('copilot / opencode catalog reconcile (Issue #1913)', () => {
  const COPILOT_1_0_80 = attestedFor('copilot');
  const OPENCODE_1_18_21 = attestedFor('opencode');

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
    // Issue #2253: command-code joins the split. `/exit` means "Exit Command
    // Code" there, so it gets its own leaf like every other claimant.
    expect(exits.map((c) => c.cliTools?.join(',')).sort()).toEqual([
      'claude',
      'codex',
      'command-code',
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
      for (const tool of ['claude', 'codex', 'copilot', 'command-code']) {
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
    // Issue #2024: /cd joined the list. The claude docs say "Move this session to
    // a new working directory"; the codex enum says "change the current working
    // directory". Inheriting claude's sentence would have described a codex
    // command wrongly, so the flat key became an object here too.
    const splitNames = ['exit', 'login', 'logout', 'feedback', 'skills', 'init', 'agent',
      'plugin', 'memory', 'app', 'debug', 'cd'];
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

  // Issue #2026: the probed versions are no longer literals here. They are the
  // `version` field of the attestation that carries the set they were read with,
  // and `CATALOG_VERIFIED_AGAINST` is derived from those — see the #2026 block
  // below for the wiring and for the guard that keeps a second copy from coming
  // back into the catalog file.
  it('reports each probed CLI version through its attestation', () => {
    expect(ATTESTATION_INDEX.get('copilot')?.version).toBe(CATALOG_VERIFIED_AGAINST.copilot);
    expect(ATTESTATION_INDEX.get('opencode')?.version).toBe(CATALOG_VERIFIED_AGAINST.opencode);
    expect(ATTESTATION_INDEX.get('copilot')?.observedAt).toBe('2026-08-22');
    // Issue #2036 re-read the opencode source on 1.18.22 and the 18 names came
    // back byte-identical, so only the date and version moved. The pin is the
    // measured date, never a loosened one: a stale date is exactly the drift
    // this record exists to catch.
    expect(ATTESTATION_INDEX.get('opencode')?.observedAt).toBe('2026-08-25');
  });
});

// Issue #2024: reconciled against codex 0.149.0 (the release tag
// `catalog:refresh --codex-ref rust-v0.149.0` reads
// codex-rs/tui/src/slash_command.rs from) and the claude commands doc.
//
// Pinned by name rather than only by count, for the reason #1913 gave: a count
// cannot tell "we added the commands that appeared" from "we added commands".
describe('codex 0.149.0 / claude catalog reconcile (Issue #2024)', () => {
  const visible = (name: string, tool: string): SlashCommand | undefined =>
    STANDARD_COMMANDS.find((c) => c.name === name && c.cliTools?.includes(tool as never));

  // Issue #2026 re-read the enum at rust-v0.149.1 (upstream had moved on while
  // the stamp still said 0.149.0) and found the variant list byte-identical, so
  // the attestation records 0.149.1 with the same 56 names. The version is no
  // longer asserted as a literal here: `catalog:refresh --write` can no longer
  // move it — it reports the delta and a human re-attests — so the assertion
  // that matters is that the stamp and the set come from one record.
  it('stamps the codex version on the same record as the enumeration', () => {
    const codex = ATTESTATION_INDEX.get('codex');
    expect(codex?.version).toBe(CATALOG_VERIFIED_AGAINST.codex);
    expect(codex?.source).toContain('slash_command.rs');
  });

  // `SlashCommand::Agent` is absent from the 0.149.0 enum; `Agents` and
  // `MultiAgents` (= /subagents) replaced it. The name still exists on copilot,
  // which is why the removal is scoped to the tool rather than to the string.
  it('drops /agent from codex and keeps the copilot row', () => {
    expect(visible('agent', 'codex'), '/agent must be off codex').toBeUndefined();
    expect(visible('agent', 'copilot')?.cliTools).toEqual(['copilot']);
  });

  it('adds the codex 0.149.0 arrivals with their own descriptions', () => {
    expect(visible('agents', 'codex')?.descriptionKey).toBe(
      toolDescriptionKeyFor('agents', 'codex')
    );
    expect(visible('cd', 'codex')?.descriptionKey).toBe(toolDescriptionKeyFor('cd', 'codex'));
    expect(visible('pwd', 'codex')?.cliTools).toEqual(['codex']);

    for (const locale of LOCALES) {
      const dict = loadDescriptions(locale);
      expect(dict['agents.codex'], `${locale} agents.codex`).toBeTruthy();
      expect(dict['pwd'], `${locale} pwd`).toBeTruthy();
      // The whole point of splitting /cd: codex must not inherit claude's text.
      expect(dict['cd.codex']).toBeTruthy();
      expect(dict['cd.codex']).not.toBe(dict['cd.claude']);
    }
  });

  it('adds the claude arrivals /artifacts and /auto-mode-setup', () => {
    for (const name of ['artifacts', 'auto-mode-setup']) {
      expect(visible(name, 'claude')?.cliTools, `/${name}`).toEqual(['claude']);
      for (const locale of LOCALES) {
        expect(loadDescriptions(locale)[name], `${locale} /${name}`).toBeTruthy();
      }
    }
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
