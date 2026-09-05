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
  loadOpencodeSkills,
  loadSkills,
  mergeCodexFamilySkills,
} from '@/lib/slash-commands';
import {
  SKILL_CLAUDE_INSTALL_ROOT_PREFIX,
  SKILL_INSTALL_ROOT_PREFIX,
  SKILL_INSTALL_ROOT_PREFIXES,
} from '@/lib/skills/constants';
import {
  findSkillAgentMatrixEntry,
  getSkillAgentMatrix,
  isAgentMeasured,
  type SkillAgentMatrixEntry,
} from '@/lib/skills/compatibility-matrix';
import type { SlashCommand, SlashCommandGroup } from '@/types/slash-commands';
import { removeTempDir } from '@tests/helpers/temp-dir';

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

/**
 * Agents whose entries do not come from the root-keyed loaders above (#2037).
 *
 * opencode was measured to read *both* install roots and to run a Skill as
 * `/<name>`, so its palette entries are produced by one loader that folds every
 * root it reads — `loadOpencodeSkills` — rather than by the per-root loader the
 * codex/claude split uses. Resolving by agent first keeps the binding this
 * suite exists for: a root named in the matrix must be reachable from *that
 * Agent's* loader, whichever loader that is.
 */
const LOADER_BY_AGENT: Partial<
  Record<SkillAgentMatrixEntry['agent'], (basePath: string) => Promise<SlashCommand[]>>
> = {
  opencode: loadOpencodeSkills,
};

/**
 * Measured Agents whose matrix roots CommandMate's own palette does not serve.
 *
 * Issue #2302 measured three Agents that read an install root and get nothing
 * from CommandMate's palette:
 *
 *  - **command-code** reads `.agents/skills` and offers what it finds there in
 *    its own composer as `[skill]` rows.
 *  - **copilot** reads *both* install roots and lists them in its own palette.
 *
 * (gemini 0.58.0 has the same shape and the same gap; its matrix row is still
 * unmeasured because its invocation axis could not be measured at all, so it is
 * not listed here.)
 *
 * So nothing here is an invisible install — each Agent finds the Skill itself.
 * What is missing is the CommandMate half: `loadAgentsSkills` tags its entries
 * `cliTools: ['codex', 'antigravity']` and `loadSkills` leaves `cliTools`
 * undefined (Claude-only), so neither is served a row. Worse than a missing
 * row, `getSlashCommandTrigger` spells a `codex-skill` as `$name`, which is not
 * the `/name` either of them resolves.
 *
 * Wiring that up is a `src/lib/slash-commands.ts` change and Issue #2302 is a
 * measurement, so the gap is *pinned* below rather than waved through: the
 * "palette parity" suite asserts it still exists exactly as described, and
 * closing it turns that suite red — which is when these exemptions come out.
 */
const PALETTE_PARITY_GAPS: Partial<Record<SkillAgentMatrixEntry['agent'], string>> = {
  'command-code': 'CommandMate does not serve .agents/skills rows to Command Code yet',
  copilot: 'CommandMate serves neither install root to Copilot yet',
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
  removeTempDir(workspace);
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
  const measured = getSkillAgentMatrix()
    .filter(isAgentMeasured)
    .filter((entry) => PALETTE_PARITY_GAPS[entry.agent] === undefined);

  it('has measured rows to check, so this suite cannot pass vacuously', () => {
    expect(measured.length).toBeGreaterThan(0);
    expect(measured.every((entry) => entry.discoveryRoots.length > 0)).toBe(true);
  });

  it.each(measured.map((entry) => [entry.agent, entry] as const))(
    '%s finds the Skill through the loader for the root it reads',
    async (agent, entry: SkillAgentMatrixEntry) => {
      for (const root of entry.discoveryRoots) {
        const loader = LOADER_BY_AGENT[agent] ?? LOADER_BY_ROOT[root];
        expect(loader, `no CommandMate loader for ${agent} + ${root}`).toBeTypeOf('function');

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

describe('palette parity: the CommandMate-side gap the measurement exposed (#2302)', () => {
  it('pins every exemption to a row the matrix actually calls measured', () => {
    // An exemption naming an unmeasured Agent would silence the loop above for
    // a row that was never checked in the first place.
    const exempted = Object.keys(PALETTE_PARITY_GAPS) as SkillAgentMatrixEntry['agent'][];
    expect(exempted.length).toBeGreaterThan(0);
    for (const agent of exempted) {
      const entry = findSkillAgentMatrixEntry(agent);
      expect(entry, `${agent} is exempted but absent from the matrix`).not.toBeNull();
      expect(isAgentMeasured(entry!), `${agent} is exempted but unmeasured`).toBe(true);
    }
  });

  it('still scopes .agents/skills rows away from a Command Code session', async () => {
    // Command Code was measured on 1.49.0 to read this exact root and to reach
    // the Skill on its own, so this is a palette *parity* gap and not an
    // invisible install — the user gets there, just not through CommandMate's
    // palette.
    //
    // Asserted by value so that widening the loader's cliTools fails here,
    // which is the reminder to delete the exemptions above and to check that
    // `getSlashCommandTrigger` spells these `/name` rather than `$name`.
    const loaded = await loadAgentsSkills(workspace);
    expect(loaded.map((command) => command.name)).toEqual([SKILL_ID]);
    expect(loaded[0].cliTools).toEqual(['codex', 'antigravity']);
    expect(namesFor(loaded, 'command-code')).toEqual([]);
  });

  it('serves Copilot neither install root, though it was measured to read both', async () => {
    // The widest of the three gaps: copilot 1.0.83 lists a Skill from
    // `.agents/skills` AND `.claude/skills` in its own palette, and CommandMate
    // offers it rows from neither — `.claude/skills` entries carry no cliTools
    // at all, which means Claude-only.
    const agents = await loadAgentsSkills(workspace);
    const claude = await loadSkills(workspace);
    expect(namesFor(agents, 'copilot')).toEqual([]);
    expect(claude[0].cliTools).toBeUndefined();
    expect(namesFor(claude, 'copilot')).toEqual([]);
  });

  it('leaves the codex and antigravity rows exactly as they were', async () => {
    // The gap must stay a gap and not quietly become a regression elsewhere.
    const loaded = await loadAgentsSkills(workspace);
    expect(namesFor(loaded, 'codex')).toEqual([SKILL_ID]);
    expect(namesFor(loaded, 'antigravity')).toEqual([SKILL_ID]);
  });
});
