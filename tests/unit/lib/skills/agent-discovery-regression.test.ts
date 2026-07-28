/**
 * Discovery regression: the measured matrix against CommandMate's own loaders
 * (Issue #1246)
 *
 * The matrix says which install root each Agent reads. CommandMate's slash
 * command loaders decide which CLI session each installed Skill is offered to.
 * Nothing connected the two, so either could be edited alone and the mismatch
 * would only show up as "installed and invisible" on a user's machine.
 *
 * These tests install one Skill into both roots the way `commandmate skill
 * install` does (#1460, byte-identical payload in `.agents/skills` and
 * `.claude/skills`) and then assert the loaders agree with the matrix.
 *
 * The binding is asserted in one direction only. Matrix root implies the loader
 * must surface it — that is the claim CommandMate makes to the user. The
 * converse does not hold on purpose: `.agents/skills` entries are also offered
 * to antigravity sessions (#1504), which is CommandMate injecting a command
 * rather than that Agent natively discovering a Skill, so it is not evidence.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { filterCommandsByCliTool } from '@/lib/command-merger';
import {
  loadAgentsSkills,
  loadCodexSkills,
  loadSkills,
  mergeCodexFamilySkills,
} from '@/lib/slash-commands';
import {
  SKILL_CLAUDE_INSTALL_ROOT_PREFIX,
  SKILL_INSTALL_ROOT_PREFIX,
  SKILL_INSTALL_ROOT_PREFIXES,
} from '@/lib/skills/constants';
import {
  getSkillAgentMatrix,
  isAgentMeasured,
  type SkillAgentMatrixEntry,
} from '@/lib/skills/compatibility-matrix';
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

const SKILL_ID = 'cmate-discovery-probe';
const LEGACY_SKILL_ID = 'cmate-legacy-codex-skill';
const SKILL_MD = `---\nname: ${SKILL_ID}\ndescription: Discovery probe fixture\n---\nBody\n`;

let workspace: string;

/** Loader CommandMate uses for each install root, keyed by the root prefix. */
const LOADER_BY_ROOT: Record<string, (basePath: string) => Promise<SlashCommand[]>> = {
  [SKILL_INSTALL_ROOT_PREFIX]: loadAgentsSkills,
  [SKILL_CLAUDE_INSTALL_ROOT_PREFIX]: loadSkills,
};

function asGroup(commands: SlashCommand[]): SlashCommandGroup[] {
  return [{ category: 'skill', label: 'Skills', commands }];
}

function namesFor(commands: SlashCommand[], cliTool: Parameters<typeof filterCommandsByCliTool>[1]) {
  return filterCommandsByCliTool(asGroup(commands), cliTool).flatMap((group) =>
    group.commands.map((command) => command.name)
  );
}

beforeAll(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-discovery-'));
  for (const root of SKILL_INSTALL_ROOT_PREFIXES) {
    const dir = path.join(workspace, root, SKILL_ID);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), SKILL_MD);
  }
  const legacy = path.join(workspace, '.codex', 'skills', LEGACY_SKILL_ID);
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(
    path.join(legacy, 'SKILL.md'),
    `---\nname: ${LEGACY_SKILL_ID}\ndescription: Legacy codex skill\n---\nBody\n`
  );
});

afterAll(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('the install writes one payload into both roots (#1460)', () => {
  it('places byte-identical SKILL.md files in every install root', () => {
    const contents = SKILL_INSTALL_ROOT_PREFIXES.map((root) =>
      fs.readFileSync(path.join(workspace, root, SKILL_ID, 'SKILL.md'), 'utf-8')
    );
    expect(contents).toHaveLength(2);
    expect(new Set(contents).size).toBe(1);
  });
});

describe('every root the matrix names is reachable from that Agent', () => {
  const measured = getSkillAgentMatrix().filter(isAgentMeasured);

  it('has measured rows to check, so this suite cannot pass vacuously', () => {
    expect(measured.length).toBeGreaterThan(0);
    expect(measured.every((entry) => entry.discoveryRoots.length > 0)).toBe(true);
  });

  it.each(measured.map((entry) => [entry.agent, entry] as const))(
    '%s finds the Skill through the loader for the root it reads',
    async (agent, entry: SkillAgentMatrixEntry) => {
      for (const root of entry.discoveryRoots) {
        const loader = LOADER_BY_ROOT[root];
        expect(loader, `no CommandMate loader for ${root}`).toBeTypeOf('function');

        const loaded = await loader(workspace);
        expect(
          loaded.map((command) => command.name),
          `${root} did not yield the installed Skill`
        ).toContain(SKILL_ID);

        expect(
          namesFor(loaded, agent),
          `${agent} was not offered the Skill installed into ${root}`
        ).toContain(SKILL_ID);
      }
    }
  );
});

describe('the loaders keep classifying each root the way the matrix assumes', () => {
  it('offers a .claude/skills Skill to Claude and to nobody else', async () => {
    const loaded = await loadSkills(workspace);
    expect(loaded.map((command) => command.name)).toEqual([SKILL_ID]);
    // No cliTools override means Claude-only, which is what makes the matrix's
    // "Claude reads .claude/skills" statement true inside CommandMate too.
    expect(loaded[0].cliTools).toBeUndefined();
    expect(namesFor(loaded, 'claude')).toEqual([SKILL_ID]);
    for (const other of ['codex', 'gemini', 'opencode', 'antigravity'] as const) {
      expect(namesFor(loaded, other), other).toEqual([]);
    }
  });

  it('offers an .agents/skills Skill to Codex, and not to Claude', async () => {
    const loaded = await loadAgentsSkills(workspace);
    expect(loaded.map((command) => command.name)).toEqual([SKILL_ID]);
    expect(loaded[0].source).toBe('codex-skill');
    expect(namesFor(loaded, 'codex')).toEqual([SKILL_ID]);
    // Claude reaching this Skill at all is via `.claude/skills`, never here.
    expect(namesFor(loaded, 'claude')).toEqual([]);
  });

  it('still reads the legacy .codex/skills location', async () => {
    // #1165 moved the standard location; the old one stays readable so an
    // upgrade does not silently drop a user's existing Codex skills.
    const legacy = await loadCodexSkills(workspace);
    expect(legacy.map((command) => command.name)).toEqual([LEGACY_SKILL_ID]);
    expect(legacy[0].cliTools).toEqual(['codex']);
  });

  it('does not double-list a Skill present in both Codex-family locations', async () => {
    const merged = mergeCodexFamilySkills(
      await loadCodexSkills(workspace),
      await loadAgentsSkills(workspace)
    );
    const names = merged.map((command) => command.name).sort();
    expect(names).toEqual([LEGACY_SKILL_ID, SKILL_ID].sort());
    expect(new Set(names).size).toBe(names.length);
  });

  it('lists the Skill once per Agent even though it is installed into two roots', async () => {
    // The dual-root install must not make one Skill look like two in a session.
    const claudeSide = namesFor(await loadSkills(workspace), 'claude');
    const codexSide = namesFor(
      mergeCodexFamilySkills(await loadCodexSkills(workspace), await loadAgentsSkills(workspace)),
      'codex'
    );
    expect(claudeSide.filter((name) => name === SKILL_ID)).toHaveLength(1);
    expect(codexSide.filter((name) => name === SKILL_ID)).toHaveLength(1);
  });
});
