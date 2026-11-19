/**
 * Issue #4406: files a tool places on its own must not read as the worker's work,
 * and the worker's real work must still be counted.
 *
 * Out of scope (docs: workspace same-kind findings, TOCTOU): a deliberate swap of
 * a file by the same user the worker runs as. That uid can write the worktree,
 * `~/.commandmate` and the env-clean baselines alike, so no check here can stop
 * it. What is pinned is that a tool's own state stops counting and that nothing
 * else does.
 *
 * `.commandcode/` (this file, part 1): Command Code's state in a worktree is
 * `.commandcode/settings.local.json` (CommandMate writes it on every Command Code
 * start, merging into what is there) and `.commandcode/taste/` (Command Code's
 * own). The product gates already excuse exactly these untracked paths by the
 * #3126 roster (`src/lib/skills/agent-state-paths.ts`); the orchestrator's
 * dirty-tree check (`git status --porcelain`, scripts/orchestrate/dirty-tree.mjs)
 * did not, and failed `wait-verify` with exit 3. The repo `.gitignore` now names
 * the same two paths — and only them: `.commandcode/skills/`, `commands/`, a
 * *directory* called `settings.local.json`, and look-alikes elsewhere stay
 * visible.
 *
 * The git runs are isolated from the machine: no global or system config, no
 * XDG excludes file (`~/.config/git/ignore` hides `.claude/settings.local.json`
 * on developer machines), and `core.ignorecase=false` so macOS and Linux CI
 * agree. Case variants are left out: on a case-insensitive filesystem the
 * answer depends on the filesystem, not on the rule.
 *
 * @vitest-environment node
 */

import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import {
  AGENT_STATE_DIR_PREFIXES,
  AGENT_STATE_FILES,
  isAgentStatePath,
} from '@/lib/skills/agent-state-paths';
import { removeTempDir } from '@tests/helpers/temp-dir';
import { REAL_SHELL_SUBPROCESS_TIMEOUT_MS } from '@tests/helpers/real-shell-budget';

const REPO_GITIGNORE = join(process.cwd(), '.gitignore');

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) removeTempDir(tempDirs.pop() as string);
});

/** git with no user/system config, no XDG excludes file and case-sensitive paths. */
function git(args: string[], cwd: string): string {
  return execFileSync(
    'git',
    ['-c', 'core.excludesFile=/dev/null', '-c', 'core.ignorecase=false', ...args],
    {
      cwd,
      encoding: 'utf8',
      timeout: REAL_SHELL_SUBPROCESS_TIMEOUT_MS,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        HOME: cwd,
        XDG_CONFIG_HOME: join(cwd, '.no-xdg'),
      },
    }
  );
}

function write(repo: string, relativePath: string, contents = 'x\n'): void {
  const absolute = join(repo, relativePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents);
}

/** A fresh repository carrying this repository's `.gitignore`, committed. */
function createRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tool-files-4406-')));
  tempDirs.push(dir);
  git(['init', '-q', '-b', 'main'], dir);
  git(['config', 'user.email', 'a@example.test'], dir);
  git(['config', 'user.name', 'A'], dir);
  git(['config', 'commit.gpgsign', 'false'], dir);
  writeFileSync(join(dir, '.gitignore'), readFileSync(REPO_GITIGNORE, 'utf8'));
  write(dir, 'src/greet.ts', 'export const greet = 1;\n');
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'base'], dir);
  return dir;
}

/** What the dirty-tree check would see, file by file (`-uall`: no collapsed directories). */
function untracked(repo: string): string[] {
  return git(['status', '--porcelain', '-uall'], repo)
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(3));
}

describe('.commandcode/ tool state is not uncommitted work (#4406)', () => {
  it('R2: settings.local.json and taste/ written at a Command Code start leave the tree clean', () => {
    const repo = createRepo();
    write(repo, '.commandcode/settings.local.json', '{"hooks":{}}\n');
    write(repo, '.commandcode/taste/taste.md', 'prefers tabs\n');
    write(repo, '.commandcode/taste/nested/a.json', '{}\n');

    expect(untracked(repo)).toEqual([]);
  });

  it('S2: every path the #3126 roster excuses is ignored by the repository .gitignore', () => {
    const repo = createRepo();
    const samples = [
      ...AGENT_STATE_FILES,
      ...AGENT_STATE_DIR_PREFIXES.map((prefix) => `${prefix}sample.md`),
    ];
    for (const path of samples) {
      expect(isAgentStatePath(path)).toBe(true);
      write(repo, path);
    }

    expect(untracked(repo)).toEqual([]);
  });

  it('N7: the work, and anything only dressed as .commandcode/ state, is still uncommitted', () => {
    const repo = createRepo();
    const work = [
      'src/new-feature.ts',
      '.commandcode/skills/x/SKILL.md',
      '.commandcode/commands/x.md',
      '.commandcode/other.json',
      '.commandcode/settings.json',
      // A directory named like the excused file (the pattern would match it too).
      '.commandcode/settings.local.json/x/payload.ts',
      // The same names anywhere but the repository root.
      'src/.commandcode/settings.local.json',
      'src/.commandcode/taste/a.md',
      '.commandcodex/settings.local.json',
      '.commandcodex/taste/a.md',
    ];
    for (const path of work) write(repo, path);
    // The excused files sit beside the work and must not hide it.
    write(repo, '.commandcode/settings.local.json.bak');

    const seen = untracked(repo);
    for (const path of work) expect(seen).toContain(path);
    expect(seen).toContain('.commandcode/settings.local.json.bak');
  });

  it('N7: a file (not a directory) named .commandcode is still uncommitted', () => {
    const repo = createRepo();
    write(repo, '.commandcode', 'not a directory\n');

    expect(untracked(repo)).toEqual(['.commandcode']);
  });

  it('N7: a tracked file under .commandcode/ that changes is still counted (.gitignore does not apply)', () => {
    const repo = createRepo();
    write(repo, '.commandcode/settings.local.json', '{}\n');
    git(['add', '-f', '.commandcode/settings.local.json'], repo);
    git(['commit', '-q', '-m', 'force-added'], repo);
    write(repo, '.commandcode/settings.local.json', '{"permissions":{"allow":["*"]}}\n');

    expect(untracked(repo)).toEqual(['.commandcode/settings.local.json']);
  });
});
