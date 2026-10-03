/**
 * Issue #3126: state files an agent CLI writes for itself are not the worker's
 * change. Only declared paths are excluded; everything else stays counted.
 *
 * @vitest-environment node
 */

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { collectChangedPaths, evaluateScope } from '@/lib/verification/scope-gate';
import { isAgentStatePath } from '@/lib/skills/agent-state-paths';
import { removeTempDir } from '@tests/helpers/temp-dir';

const tempDirs: string[] = [];

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function write(repo: string, relativePath: string, contents: string): void {
  const absolute = join(repo, relativePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents);
}

function createRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agent-state-3126-')));
  tempDirs.push(dir);
  git(['init', '-b', 'main'], dir);
  git(['config', 'user.email', 'a@example.test'], dir);
  git(['config', 'user.name', 'A'], dir);
  git(['config', 'commit.gpgsign', 'false'], dir);
  write(dir, 'src/greet.js', 'module.exports = () => "hi";\n');
  git(['add', '-A'], dir);
  git(['commit', '-m', 'base'], dir);
  git(['checkout', '-b', 'work'], dir);
  return dir;
}

const SCOPE = { allow: ['src/greet.js'], deny: [] };

afterEach(() => {
  while (tempDirs.length > 0) removeTempDir(tempDirs.pop() as string);
});

describe('agent-managed state files (#3126)', () => {
  it('declares files, not the whole directory', () => {
    expect(isAgentStatePath('.commandcode/settings.local.json')).toBe(true);
    expect(isAgentStatePath('.commandcode/taste/taste.md')).toBe(true);
    expect(isAgentStatePath('.commandcode/commands/x.md')).toBe(false);
    expect(isAgentStatePath('.commandcode/taste/../x.md')).toBe(false);
    expect(isAgentStatePath('.commandcode/settings.json')).toBe(false);
  });

  it('passes scope when only declared state files accompany an in-scope edit, and says so', async () => {
    const repo = createRepo();
    write(repo, 'src/greet.js', 'module.exports = () => "hello";\n');
    write(repo, '.commandcode/settings.local.json', '{}\n');
    write(repo, '.commandcode/taste/taste.md', 'x\n');

    const changed = await collectChangedPaths(repo, 'main');
    expect(changed).toMatchObject({ paths: ['src/greet.js'] });
    const outcome = await evaluateScope(repo, SCOPE, true, 'main');
    expect(outcome.status).toBe('passed');
    expect(outcome.logTail).toContain('~ .commandcode/settings.local.json');
    expect(outcome.logTail).toContain('~ .commandcode/taste/taste.md');
  });

  it('still fails other files under .commandcode/ (negative control)', async () => {
    const repo = createRepo();
    write(repo, 'src/greet.js', 'module.exports = () => "hello";\n');
    write(repo, '.commandcode/settings.local.json', '{}\n');
    write(repo, '.commandcode/commands/evil.md', 'x\n');

    const outcome = await evaluateScope(repo, SCOPE, true, 'main');
    expect(outcome.status).toBe('failed');
    expect(outcome.logTail).toContain('- .commandcode/commands/evil.md');
  });

  it('still judges a declared file that was committed', async () => {
    const repo = createRepo();
    write(repo, '.commandcode/settings.local.json', '{}\n');
    git(['add', '-A'], repo);
    git(['commit', '-m', 'commit state'], repo);

    const outcome = await evaluateScope(repo, SCOPE, true, 'main');
    expect(outcome.status).toBe('failed');
  });
});
