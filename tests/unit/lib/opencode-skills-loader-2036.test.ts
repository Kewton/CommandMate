/**
 * `.agents/skills` / `.claude/skills` reach the opencode palette (Issue #2037)
 *
 * The measurement behind this file (opencode 1.18.22, isolated HOME,
 * docs/design/opencode-server-live-verification.md §11): opencode discovers a
 * Skill in every one of these roots and runs it when `/<name>` is submitted, but
 * its own palette never offers one — typing the full name shows "No matching
 * items". So CommandMate's palette is the only place the route is discoverable,
 * which is what `loadOpencodeSkills` supplies.
 *
 * The loader is the *offline* half. `GET /command` supplies the same names while
 * a server is up (covered in opencode-live-commands-2036.test.ts); this scan is
 * what the palette shows before one has answered, and for a Skill installed
 * while the pane is not running.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  loadAgentsSkills,
  loadOpencodeSkills,
  loadSkills,
  getSlashCommandGroups,
} from '@/lib/slash-commands';
import { filterCommandsByCliTool } from '@/lib/command-merger';
import { getSlashCommandTrigger } from '@/lib/slash-command-format';
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
const OPENCODE_NATIVE = 'opencode-native-skill';
const CLAUDE_ONLY = 'claude-only-skill';

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
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-oc-skills-'));
  // `commandmate skill install` writes the same payload into both roots (#1460).
  writeSkill(SKILL_INSTALL_ROOT_PREFIX, INSTALLED, 'Installed by CommandMate');
  writeSkill(SKILL_CLAUDE_INSTALL_ROOT_PREFIX, INSTALLED, 'Installed by CommandMate');
  // opencode's own root, and a Skill only Claude's root carries.
  writeSkill('.opencode/skills', OPENCODE_NATIVE, 'Authored for opencode');
  writeSkill(SKILL_CLAUDE_INSTALL_ROOT_PREFIX, CLAUDE_ONLY, 'Only in the claude root');
});

afterAll(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('loadOpencodeSkills (Issue #2037)', () => {
  it('yields every root opencode was measured to read', async () => {
    const names = (await loadOpencodeSkills(workspace)).map((s) => s.name).sort();
    expect(names).toEqual([CLAUDE_ONLY, INSTALLED, OPENCODE_NATIVE].sort());
  });

  it('shows one row for a Skill installed into both roots', async () => {
    const loaded = await loadOpencodeSkills(workspace);
    expect(loaded.filter((s) => s.name === INSTALLED)).toHaveLength(1);
  });

  it('scopes every entry to opencode and to nothing else', async () => {
    const loaded = await loadOpencodeSkills(workspace);
    expect(namesFor(loaded, 'opencode').sort()).toEqual(
      [CLAUDE_ONLY, INSTALLED, OPENCODE_NATIVE].sort()
    );
    for (const other of ['claude', 'codex', 'gemini', 'antigravity', 'copilot'] as const) {
      expect(namesFor(loaded, other), `${other} must not gain these rows`).toEqual([]);
    }
  });

  it('spells the trigger as /name, which is the route measured to run', async () => {
    const skill = (await loadOpencodeSkills(workspace)).find((s) => s.name === INSTALLED)!;
    // `codex-skill` would spell this `$name` (getSlashCommandTrigger), and `$name`
    // is not what invoked a Skill on 1.18.22 — `/name` is.
    expect(skill.source).toBe('skill');
    expect(getSlashCommandTrigger(skill, 'opencode')).toBe(`/${INSTALLED}`);
  });

  it('carries the frontmatter description into the palette', async () => {
    const skill = (await loadOpencodeSkills(workspace)).find((s) => s.name === OPENCODE_NATIVE);
    expect(skill?.description).toBe('Authored for opencode');
  });

  it('answers empty for a workspace with no Skill roots at all', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-oc-empty-'));
    try {
      expect(await loadOpencodeSkills(empty)).toEqual([]);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe('the other loaders are untouched (Issue #2037)', () => {
  it('leaves .claude/skills claude-only', async () => {
    const loaded = await loadSkills(workspace);
    expect(loaded.every((s) => s.cliTools === undefined)).toBe(true);
    expect(namesFor(loaded, 'opencode')).toEqual([]);
  });

  it('leaves .agents/skills on codex + antigravity, not opencode', async () => {
    const loaded = await loadAgentsSkills(workspace);
    expect(loaded.find((s) => s.name === INSTALLED)?.cliTools).toEqual(['codex', 'antigravity']);
    expect(namesFor(loaded, 'opencode')).toEqual([]);
  });
});

describe('getSlashCommandGroups stays tool-agnostic (Issue #2037)', () => {
  it('does not add an opencode-scoped copy of every Skill', async () => {
    const groups = await getSlashCommandGroups(workspace);
    const all = groups.flatMap((group) => group.commands);

    // The opencode rows are loaded by the palette route, under
    // `cliTool === 'opencode'`, not here. This function is the shared worktree
    // layer: every caller of it would otherwise gain a second row per Skill —
    // invisible to them after filtering, and visible to anything that counts
    // entries by name across all tools.
    expect(namesFor(all, 'opencode')).toEqual([]);

    // What it does load is unchanged: claude sees the .claude/skills entries,
    // codex sees the .agents/skills one.
    expect(namesFor(all, 'claude')).toContain(INSTALLED);
    expect(namesFor(all, 'codex')).toContain(INSTALLED);
  });
});
