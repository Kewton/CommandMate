/**
 * `.commandcode/skills` / `.agents/skills` reach the Command Code palette (Issue #2322)
 *
 * The measurement behind this file (Command Code 1.47.0, isolated git repo,
 * 2026-09-04, recorded in Issue #2322):
 *
 *  - `cmd skills list -d` and the TUI `/skills` picker listed the probe Skills
 *    planted in `<project>/.agents/skills` (badged `[.agents]`) and
 *    `<project>/.commandcode/skills`, and nothing planted in `.claude/skills`
 *    or `.opencode/skills`.
 *  - `cmd -p "/probe-agents-root" --output-format json` emitted a
 *    `skill_loaded` event and answered `PROBE_OK_probe-agents-root`, so `/name`
 *    is the invocation route.
 *  - Negative control: `/probe-claude-root`, planted only under `.claude/skills`,
 *    answered "I don't see a skill named probe-claude-root available" with zero
 *    `skill_loaded` events.
 *
 * Before this change a command-code session saw *no* Skill in the palette at
 * all: the `.agents/skills` rows are produced by `loadAgentsSkills` with
 * `cliTools: ['codex', 'antigravity']`, and `filterCommandsByCliTool` drops
 * every one of them for command-code.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  loadAgentsSkills,
  loadCommandCodeSkills,
  loadOpencodeSkills,
  loadSkills,
  getSlashCommandGroups,
} from '@/lib/slash-commands';
import { filterCommandsByCliTool } from '@/lib/command-merger';
import { getSlashCommandTrigger } from '@/lib/slash-command-format';
import { keyOf } from '@/lib/command-merger';
import {
  SKILL_CLAUDE_INSTALL_ROOT_PREFIX,
  SKILL_INSTALL_ROOT_PREFIX,
} from '@/lib/skills/constants';
import type { SlashCommand, SlashCommandGroup } from '@/types/slash-commands';

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn().mockReturnThis(),
  }),
}));

const INSTALLED = 'cmate-installed-skill';
const COMMAND_CODE_NATIVE = 'commandcode-native-skill';
const CLAUDE_ONLY = 'claude-only-skill';
const OPENCODE_ONLY = 'opencode-native-skill';

const COMMAND_CODE_ROOT = path.join('.commandcode', 'skills');

let workspace: string;

function writeSkill(root: string, id: string, description: string): void {
  const dir = path.join(workspace, root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${id}\ndescription: ${description}\n---\nBody\n`
  );
}

function asGroup(commands: SlashCommand[]): SlashCommandGroup[] {
  return [{ category: 'skill', label: 'Skills', commands }];
}

function namesFor(commands: SlashCommand[], cliTool: Parameters<typeof filterCommandsByCliTool>[1]) {
  return filterCommandsByCliTool(asGroup(commands), cliTool).flatMap((group) =>
    group.commands.map((command) => command.name)
  );
}

beforeAll(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-cc-skills-'));
  // `commandmate skill install` writes the same payload into both roots (#1460).
  // Command Code reads only the first of the two.
  writeSkill(SKILL_INSTALL_ROOT_PREFIX, INSTALLED, 'Installed by CommandMate');
  writeSkill(SKILL_CLAUDE_INSTALL_ROOT_PREFIX, INSTALLED, 'Installed by CommandMate');
  // Command Code's own root, plus roots it was measured NOT to read.
  writeSkill(COMMAND_CODE_ROOT, COMMAND_CODE_NATIVE, 'Authored for Command Code');
  writeSkill(SKILL_CLAUDE_INSTALL_ROOT_PREFIX, CLAUDE_ONLY, 'Only in the claude root');
  writeSkill('.opencode/skills', OPENCODE_ONLY, 'Authored for opencode');
});

afterAll(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('loadCommandCodeSkills (Issue #2322)', () => {
  it('yields every root Command Code was measured to read', async () => {
    const names = (await loadCommandCodeSkills(workspace)).map((s) => s.name).sort();
    expect(names).toEqual([COMMAND_CODE_NATIVE, INSTALLED].sort());
  });

  it('omits the roots the negative control proved unreadable', async () => {
    const names = (await loadCommandCodeSkills(workspace)).map((s) => s.name);
    // `.claude/skills` — the probe planted only there was answered with
    // "I don't see a skill named …". A palette row for it would be unrunnable.
    expect(names).not.toContain(CLAUDE_ONLY);
    // `.opencode/skills` is opencode's root and is not scanned either.
    expect(names).not.toContain(OPENCODE_ONLY);
  });

  it('shows one row for a Skill installed into both CommandMate roots', async () => {
    const loaded = await loadCommandCodeSkills(workspace);
    expect(loaded.filter((s) => s.name === INSTALLED)).toHaveLength(1);
  });

  it('lets .agents/skills win a name collision with .commandcode/skills', async () => {
    const collision = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-cc-collide-'));
    const write = (root: string, description: string): void => {
      const dir = path.join(collision, root, INSTALLED);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'SKILL.md'),
        `---\nname: ${INSTALLED}\ndescription: ${description}\n---\nBody\n`
      );
    };
    try {
      write(COMMAND_CODE_ROOT, 'left over in .commandcode');
      write(SKILL_INSTALL_ROOT_PREFIX, 'installed by CommandMate');

      const loaded = await loadCommandCodeSkills(collision);
      expect(loaded).toHaveLength(1);
      // CommandMate's primary install root is scanned last so its package wins.
      expect(loaded[0].description).toBe('installed by CommandMate');
    } finally {
      fs.rmSync(collision, { recursive: true, force: true });
    }
  });

  it('scopes every entry to command-code and to nothing else', async () => {
    const loaded = await loadCommandCodeSkills(workspace);
    expect(namesFor(loaded, 'command-code').sort()).toEqual(
      [COMMAND_CODE_NATIVE, INSTALLED].sort()
    );
    for (const other of ['claude', 'codex', 'gemini', 'antigravity', 'copilot', 'opencode'] as const) {
      expect(namesFor(loaded, other), `${other} must not gain these rows`).toEqual([]);
    }
  });

  it('spells the trigger as /name, which is the route measured to run', async () => {
    const skill = (await loadCommandCodeSkills(workspace)).find((s) => s.name === INSTALLED)!;
    // `codex-skill` would spell this `$name` (getSlashCommandTrigger), and `$name`
    // is not what loaded a Skill on 1.47.0 — `/name` is.
    expect(skill.source).toBe('skill');
    expect(getSlashCommandTrigger(skill, 'command-code')).toBe(`/${INSTALLED}`);
  });

  it('keys distinctly from the codex/antigravity row for the same Skill', async () => {
    const commandCode = (await loadCommandCodeSkills(workspace)).find((s) => s.name === INSTALLED)!;
    const codexFamily = (await loadAgentsSkills(workspace)).find((s) => s.name === INSTALLED)!;
    // Same name, different dedup key: mergeCommandGroups must not let one
    // silently replace the other (keyOf = name + CLI tool scope, Issue #800).
    expect(keyOf(commandCode)).not.toBe(keyOf(codexFamily));
  });

  it('carries the frontmatter description into the palette', async () => {
    const skill = (await loadCommandCodeSkills(workspace)).find((s) => s.name === COMMAND_CODE_NATIVE);
    expect(skill?.description).toBe('Authored for Command Code');
  });

  it('answers empty for a workspace with no Skill roots at all', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-cc-empty-'));
    try {
      expect(await loadCommandCodeSkills(empty)).toEqual([]);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe('the other loaders are untouched (Issue #2322)', () => {
  it('leaves .claude/skills claude-only', async () => {
    const loaded = await loadSkills(workspace);
    expect(loaded.every((s) => s.cliTools === undefined)).toBe(true);
    expect(namesFor(loaded, 'command-code')).toEqual([]);
  });

  it('leaves .agents/skills on codex + antigravity, not command-code', async () => {
    const loaded = await loadAgentsSkills(workspace);
    expect(loaded.find((s) => s.name === INSTALLED)?.cliTools).toEqual(['codex', 'antigravity']);
    expect(namesFor(loaded, 'command-code')).toEqual([]);
  });

  it('leaves the opencode loader reading its own three roots', async () => {
    const names = (await loadOpencodeSkills(workspace)).map((s) => s.name).sort();
    // Unchanged by #2322: `.opencode/skills`, `.claude/skills`, `.agents/skills`.
    expect(names).toEqual([CLAUDE_ONLY, INSTALLED, OPENCODE_ONLY].sort());
    expect(names).not.toContain(COMMAND_CODE_NATIVE);
  });
});

describe('getSlashCommandGroups stays tool-agnostic (Issue #2322)', () => {
  it('does not add a command-code-scoped copy of every Skill', async () => {
    const groups = await getSlashCommandGroups(workspace);
    const all = groups.flatMap((group) => group.commands);

    // The command-code rows are loaded by the palette route, under
    // `cliTool === 'command-code'`, not here — same reason as the opencode rows
    // (#2037): every caller of this shared worktree layer would otherwise gain a
    // second row per Skill.
    expect(namesFor(all, 'command-code')).toEqual([]);

    // What it does load is unchanged: claude sees the .claude/skills entries,
    // codex sees the .agents/skills one.
    expect(namesFor(all, 'claude')).toContain(INSTALLED);
    expect(namesFor(all, 'codex')).toContain(INSTALLED);
  });
});
