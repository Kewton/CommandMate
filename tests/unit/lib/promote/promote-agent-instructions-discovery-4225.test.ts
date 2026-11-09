/**
 * The table of agent instruction files is not a list kept by hand (Issue #4225, Codex
 * review 5 P2-1): every project Skill root an agent was measured to discover must fall
 * under one of its rows. The roots are read from where they are recorded — the probe
 * roots of `docs/reference/skill-agent-compatibility.md` (the measurements, including the
 * roots CommandMate never installs to, e.g. Copilot's `.github/skills`) and the
 * `discoveryRoots` of `lib/skills/compatibility-matrix.ts` — so a root added there fails
 * here until `AGENT_INSTRUCTION_PATHS` refuses it.
 *
 * The worktrees live in a `mkdtemp` directory removed after each test.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { agentInstructionPathOf, checkDocPath } from '@/lib/promote/destination';
import { writeDocBlock } from '@/lib/promote/doc-write';
import { getSkillAgentMatrix } from '@/lib/skills/compatibility-matrix';
import { SKILL_CLAUDE_INSTALL_ROOT_PREFIX, SKILL_INSTALL_ROOT_PREFIX } from '@/lib/skills/constants';

const OP = '00000000-0000-4000-8000-000000000001';
const COMPAT_DOC = path.join(process.cwd(), 'docs/reference/skill-agent-compatibility.md');

/**
 * The project-relative Skill roots a text names: `.x/…/skills` (or `skill`) standing on
 * its own or under `$WORK/repo/`. A root under a home (`$WORK/home/`, `~/`, `$HOME/`) is
 * preceded by `/` and is not a worktree's document, so it is left out.
 */
function projectSkillRootsOf(text: string): string[] {
  const roots = new Set<string>();
  const pattern = /(?<![\w/~$.-])(?:\$WORK\/repo\/)?(\.[\w-]+(?:\/[\w.-]+)*?\/skills?)(?![\w/.-])/g;
  for (const match of text.matchAll(pattern)) roots.add(match[1]);
  return [...roots].sort();
}

const DOC_ROOTS = projectSkillRootsOf(readFileSync(COMPAT_DOC, 'utf8'));
const MATRIX_ROOTS = [...new Set(getSkillAgentMatrix().flatMap((entry) => entry.discoveryRoots))].sort();
const ALL_ROOTS = [...new Set([...DOC_ROOTS, ...MATRIX_ROOTS, SKILL_INSTALL_ROOT_PREFIX, SKILL_CLAUDE_INSTALL_ROOT_PREFIX])].sort();

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'promote-agent-instructions-discovery-4225-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('Codex review 5 P2-1: every measured Skill root is refused as a destination', () => {
  it('the sources are read (not vacuous): the measured roots include each agent’s positive control', () => {
    for (const expected of ['.agents/skills', '.claude/skills', '.commandcode/skills', '.gemini/skills', '.github/skills', '.opencode/skills', '.opencode/skill']) {
      expect(DOC_ROOTS).toContain(expected);
    }
    expect(MATRIX_ROOTS.length).toBeGreaterThan(0);
  });

  it('(control) the reader takes project roots only: a home root and a path inside a root are not roots', () => {
    expect(
      projectSkillRootsOf(
        '`$WORK/home/.config/opencode/skills` `~/.codex/skills` `$HOME/.opencode/skills` `$WORK/repo/.agents/skills/probe-x` `docs/skills` `.new/skills`'
      )
    ).toEqual(['.new/skills']);
  });

  it.each(ALL_ROOTS)('%s/x/SKILL.md is under a row of the table, refused when checked and right before the write', (skillRoot) => {
    const rel = `${skillRoot}/x/SKILL.md`;
    mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
    // An existing regular `.md`: nothing but the table can refuse it.
    writeFileSync(path.join(root, rel), '# skill\n');
    expect(agentInstructionPathOf(rel)).not.toBeNull();
    expect(checkDocPath(root, rel)).toEqual({ ok: false, code: 'agent_instructions' });
    const outcome = writeDocBlock({ root, rel, operationId: OP, body: 'body', baseFingerprint: 'absent', leftovers: new Map() });
    expect(outcome).toEqual({ result: 'not_written', reason: 'agent_instructions', refusal: true });
    expect(readFileSync(path.join(root, rel), 'utf8')).toBe('# skill\n');
  });

  it('(positive control) a root recorded tomorrow that no row covers would fail the check above', () => {
    const tomorrow = projectSkillRootsOf('`$WORK/repo/.newagent/skills` | `probe-newagent-root` | 陽性対照');
    expect(tomorrow).toEqual(['.newagent/skills']);
    expect(agentInstructionPathOf(`${tomorrow[0]}/x/SKILL.md`)).toBeNull();
  });

  it('(control) a `skills` directory that no agent reads is still a destination', () => {
    const rel = 'docs/skills/x.md';
    mkdirSync(path.join(root, 'docs/skills'), { recursive: true });
    expect(agentInstructionPathOf(rel)).toBeNull();
    expect(checkDocPath(root, rel)).toMatchObject({ ok: true, rel });
    expect(existsSync(path.join(root, rel))).toBe(false);
  });
});
