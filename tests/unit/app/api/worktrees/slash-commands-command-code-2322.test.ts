/**
 * The palette route serves Skills to a Command Code session (Issue #2322)
 *
 * `loadCommandCodeSkills` is only half the fix; the rows reach a session only if
 * the route loads them, and only for `cliTool=command-code`. This file pins both
 * halves against a temp worktree and a temp `$HOME`:
 *
 *  - the four roots Command Code 1.47.0 was measured to read (project and user
 *    `.commandcode/skills` + `.agents/skills`) all reach the palette as `/name`;
 *  - `.claude/skills` — the one CommandMate install root the negative control
 *    proved unreadable — does not;
 *  - the claude / codex / antigravity / opencode palettes are unchanged, which
 *    is what makes this additive.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import * as fs from 'fs';
import * as realOs from 'os';
import * as path from 'path';
import { removeTempDir } from '@tests/helpers/temp-dir';
import { getSlashCommandTrigger } from '@/lib/slash-command-format';
import type { SlashCommand } from '@/types/slash-commands';

vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: vi.fn(() => ({})) }));
vi.mock('@/lib/db', () => ({ getWorktreeById: vi.fn() }));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn().mockReturnThis(),
  }),
}));

/** No real CLI processes: the route probes CLI versions for catalog staleness. */
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFile: (
      _command: string,
      _args: string[],
      _opts: unknown,
      cb: (err: Error | null, stdout: string, stderr: string) => void
    ) => {
      cb(new Error('ENOENT'), '', '');
    },
  };
});

/**
 * The route scans `os.homedir()` for the user-level Skill roots. Point it at a
 * temp home so the developer's real `~/.agents/skills` cannot decide whether an
 * assertion passes, and so the *user* half of the acceptance criterion
 * (`~/.commandcode/skills`, `~/.agents/skills`) is actually exercised.
 */
let fakeHome = '';
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, homedir: () => fakeHome }, homedir: () => fakeHome };
});

const INSTALLED = 'cmate-repository-analysis';
const WORKTREE_NATIVE = 'wt-commandcode-skill';
const WORKTREE_CLAUDE_ONLY = 'wt-claude-only-skill';
const HOME_AGENTS = 'home-agents-skill';
const HOME_NATIVE = 'home-commandcode-skill';
const HOME_CLAUDE_ONLY = 'home-claude-only-skill';

const AGENTS_ROOT = path.join('.agents', 'skills');
const CLAUDE_ROOT = path.join('.claude', 'skills');
const COMMAND_CODE_ROOT = path.join('.commandcode', 'skills');

let workspace: string;

function writeSkill(base: string, root: string, id: string, description: string): void {
  const dir = path.join(base, root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${id}\ndescription: ${description}\n---\nBody\n`
  );
}

async function callRoute(cliTool: string): Promise<SlashCommand[]> {
  const { getWorktreeById } = await import('@/lib/db');
  vi.mocked(getWorktreeById).mockReturnValue({
    id: 'wt',
    path: workspace,
  } as unknown as ReturnType<typeof getWorktreeById>);

  const { GET } = await import('@/app/api/worktrees/[id]/slash-commands/route');
  const request = new NextRequest(
    `http://localhost:3000/api/worktrees/wt/slash-commands?cliTool=${cliTool}`
  );
  const response = await GET(request, { params: Promise.resolve({ id: 'wt' }) });
  const body = (await response.json()) as { groups: Array<{ commands: SlashCommand[] }> };
  return body.groups.flatMap((group) => group.commands);
}

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(realOs.tmpdir(), 'cm-cc-route-'));
  fakeHome = fs.mkdtempSync(path.join(realOs.tmpdir(), 'cm-cc-home-'));

  // `commandmate skill install` writes byte-identical payloads into both roots
  // (#1460). Command Code reads only `.agents/skills` of the two.
  writeSkill(workspace, AGENTS_ROOT, INSTALLED, 'Installed by CommandMate');
  writeSkill(workspace, CLAUDE_ROOT, INSTALLED, 'Installed by CommandMate');
  writeSkill(workspace, COMMAND_CODE_ROOT, WORKTREE_NATIVE, 'Authored for Command Code');
  writeSkill(workspace, CLAUDE_ROOT, WORKTREE_CLAUDE_ONLY, 'Only in the claude root');

  writeSkill(fakeHome, AGENTS_ROOT, HOME_AGENTS, 'User-level .agents skill');
  writeSkill(fakeHome, COMMAND_CODE_ROOT, HOME_NATIVE, 'User-level .commandcode skill');
  writeSkill(fakeHome, CLAUDE_ROOT, HOME_CLAUDE_ONLY, 'User-level claude-only skill');
});

afterEach(() => {
  removeTempDir(workspace);
  removeTempDir(fakeHome);
  vi.clearAllMocks();
});

describe('GET /api/worktrees/[id]/slash-commands?cliTool=command-code (Issue #2322)', () => {
  it('serves the four roots Command Code was measured to read', async () => {
    const names = (await callRoute('command-code')).map((c) => c.name);

    expect(names, 'worktree .agents/skills').toContain(INSTALLED);
    expect(names, 'worktree .commandcode/skills').toContain(WORKTREE_NATIVE);
    expect(names, '$HOME/.agents/skills').toContain(HOME_AGENTS);
    expect(names, '$HOME/.commandcode/skills').toContain(HOME_NATIVE);
  });

  it('withholds a Skill that lives only in .claude/skills', async () => {
    const names = (await callRoute('command-code')).map((c) => c.name);

    // Negative control on 1.47.0: `/probe-claude-root` answered "I don't see a
    // skill named probe-claude-root available" with zero `skill_loaded` events.
    // A palette row here would be a route the session cannot follow.
    expect(names).not.toContain(WORKTREE_CLAUDE_ONLY);
    expect(names).not.toContain(HOME_CLAUDE_ONLY);
  });

  it('spells every served Skill as /name', async () => {
    const commands = await callRoute('command-code');
    for (const name of [INSTALLED, WORKTREE_NATIVE, HOME_AGENTS, HOME_NATIVE]) {
      const command = commands.find((c) => c.name === name)!;
      expect(command.source, `${name} must not be a codex-skill`).toBe('skill');
      expect(getSlashCommandTrigger(command, 'command-code')).toBe(`/${name}`);
    }
  });

  it('shows one row per Skill, not one per root it was found in', async () => {
    const commands = await callRoute('command-code');
    // INSTALLED sits in the worktree's `.agents/skills` and `.claude/skills`;
    // only the first is read, and the merge must not duplicate it either.
    expect(commands.filter((c) => c.name === INSTALLED)).toHaveLength(1);
  });

  it('lets a worktree Skill beat a same-named one in $HOME', async () => {
    writeSkill(fakeHome, AGENTS_ROOT, INSTALLED, 'stale copy in $HOME');
    const commands = await callRoute('command-code');
    const installed = commands.filter((c) => c.name === INSTALLED);
    expect(installed).toHaveLength(1);
    expect(installed[0].description).toBe('Installed by CommandMate');
  });
});

describe('other sessions are untouched by the command-code scan (Issue #2322)', () => {
  it('leaves the codex palette on its $NAME codex-skill rows', async () => {
    const commands = await callRoute('codex');
    const names = commands.map((c) => c.name);

    expect(names).toContain(INSTALLED);
    expect(getSlashCommandTrigger(commands.find((c) => c.name === INSTALLED)!, 'codex')).toBe(
      `$${INSTALLED}`
    );
    // `.commandcode/skills` is command-code's own root and reaches nobody else.
    expect(names).not.toContain(WORKTREE_NATIVE);
    expect(names).not.toContain(HOME_NATIVE);
  });

  it('leaves the antigravity palette unchanged', async () => {
    const names = (await callRoute('antigravity')).map((c) => c.name);
    expect(names).toContain(INSTALLED);
    expect(names).not.toContain(WORKTREE_NATIVE);
    expect(names).not.toContain(HOME_NATIVE);
  });

  it('leaves the claude palette on its .claude/skills rows', async () => {
    const names = (await callRoute('claude')).map((c) => c.name);
    expect(names).toContain(WORKTREE_CLAUDE_ONLY);
    expect(names).toContain(HOME_CLAUDE_ONLY);
    expect(names).not.toContain(WORKTREE_NATIVE);
    expect(names).not.toContain(HOME_NATIVE);
  });

  it('leaves the opencode palette reading its own three roots', async () => {
    const names = (await callRoute('opencode')).map((c) => c.name);
    // Unchanged by #2322 (#2037): `.opencode/skills`, `.claude/skills`,
    // `.agents/skills`, in the worktree and under $HOME.
    expect(names).toContain(INSTALLED);
    expect(names).toContain(WORKTREE_CLAUDE_ONLY);
    expect(names).toContain(HOME_CLAUDE_ONLY);
    expect(names).not.toContain(WORKTREE_NATIVE);
    expect(names).not.toContain(HOME_NATIVE);
  });
});
