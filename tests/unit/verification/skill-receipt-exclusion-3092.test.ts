/**
 * Issue #3092: files a recorded Skill install placed in a worktree are not the
 * agent's work.
 *
 * Every exclusion case is paired with a negative control — a file the user or
 * the agent wrote, or a Skill file whose bytes changed — that must still count.
 * The gates decide "may this be called done", so the only acceptable loosening
 * is one that cannot turn "nothing happened" into a pass.
 *
 * Real temporary git repositories, as in scope-gate.test.ts: the bug is git's
 * untracked output being read as work, which a stubbed git cannot reproduce.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { runMigrations } from '@/lib/db/db-migrations';
import { getVerificationRun, upsertWorktree } from '@/lib/db';
import {
  startVerification,
  waitForVerification,
  WORK_EVIDENCE_GATE_ID,
} from '@/lib/verification/gate-runner';
import { collectChangedPaths, evaluateScope } from '@/lib/verification/scope-gate';
import { collectSkillReceiptOwnedPaths } from '@/lib/skills/receipt-owned-paths';
import { removeTempDir } from '@tests/helpers/temp-dir';

declare module '@/lib/db/db-instance' {
  export function setMockDb(db: Database.Database): void;
}

vi.mock('@/lib/db/db-instance', () => {
  let mockDb: Database.Database | null = null;
  return {
    getDbInstance: () => {
      if (!mockDb) throw new Error('Mock database not initialized');
      return mockDb;
    },
    setMockDb: (db: Database.Database) => {
      mockDb = db;
    },
    closeDbInstance: () => {
      if (mockDb) {
        mockDb.close();
        mockDb = null;
      }
    },
  };
});

let db: Database.Database;
const tempDirs: string[] = [];

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function write(repo: string, relativePath: string, contents: string): void {
  const absolute = join(repo, relativePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents);
}

const VERIFY_CONFIG = `
version: 1
gates:
  - id: first
    command: "sh -c 'exit 0'"
    timeoutSec: 30
options:
  baseRef: main
`;

function createRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'skill-receipt-3092-')));
  tempDirs.push(dir);
  git(['init', '-b', 'main'], dir);
  git(['config', 'user.email', 'skill@example.test'], dir);
  git(['config', 'user.name', 'Skill'], dir);
  git(['config', 'commit.gpgsign', 'false'], dir);
  write(dir, 'README.md', 'base\n');
  write(dir, 'src/greet.js', 'module.exports = () => "hi";\n');
  write(dir, '.commandmate/verify.yaml', VERIFY_CONFIG);
  git(['add', '-A'], dir);
  git(['commit', '-m', 'base'], dir);
  git(['checkout', '-b', 'work'], dir);
  return dir;
}

const SKILL_FILES: Record<string, string> = {
  'SKILL.md': '# demo\n',
  'commandmate.skill.yaml': 'id: demo\n',
  'scripts/run.sh': '#!/bin/sh\necho demo\n',
};

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/**
 * Lay a Skill down the way `skill install` does: the same payload and the same
 * receipt bytes in `.agents/skills/<id>` and `.claude/skills/<id>`.
 */
function installSkill(
  repo: string,
  overrides: { skillId?: string; dirName?: string; roots?: string[] } = {}
): void {
  const skillId = overrides.skillId ?? 'demo';
  const dirName = overrides.dirName ?? skillId;
  const roots = overrides.roots ?? [`.agents/skills/${dirName}`, `.claude/skills/${dirName}`];
  const receipt = {
    schema_version: 1,
    skill_id: skillId,
    version: '1.0.0',
    install_root: roots[0],
    ...(roots.length > 1 ? { install_roots: roots } : {}),
    files: Object.entries(SKILL_FILES).map(([path, contents]) => ({
      path,
      sha256: sha256(contents),
      size: Buffer.byteLength(contents),
      executable: false,
    })),
  };
  const receiptText = JSON.stringify(receipt);
  // Files land in every root named, and also in the conventional pair so a
  // forged root list still has real files beside it.
  const placed = new Set([...roots, `.agents/skills/${dirName}`, `.claude/skills/${dirName}`]);
  for (const root of placed) {
    for (const [path, contents] of Object.entries(SKILL_FILES)) {
      write(repo, `${root}/${path}`, contents);
    }
    write(repo, `${root}/.commandmate-receipt.json`, receiptText);
  }
}

/** Every path the default install above writes: 2 roots × (3 files + receipt). */
const INSTALLED_PATHS = ['.agents/skills/demo', '.claude/skills/demo'].flatMap((root) =>
  [...Object.keys(SKILL_FILES), '.commandmate-receipt.json'].map((path) => `${root}/${path}`)
);

async function changedPaths(repo: string): Promise<string[]> {
  const result = await collectChangedPaths(repo, 'main');
  if ('error' in result) throw new Error(result.error);
  return result.paths;
}

async function runWorkEvidence(id: string, repo: string): Promise<number> {
  upsertWorktree(db, {
    id,
    name: `feature/${id}`,
    path: repo,
    repositoryPath: repo,
    repositoryName: 'fixture',
  });
  const { runId } = await startVerification({ worktreeId: id, worktreePath: repo, trigger: 'api' });
  await waitForVerification(runId);
  return runId;
}

function workEvidenceGate(runId: number) {
  return getVerificationRun(db, runId)?.gates.find((gate) => gate.gateId === WORK_EVIDENCE_GATE_ID);
}

beforeEach(async () => {
  db = new Database(':memory:');
  runMigrations(db);
  const { setMockDb } = await import('@/lib/db/db-instance');
  setMockDb(db);
});

afterEach(() => {
  vi.restoreAllMocks();
  db.close();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) removeTempDir(dir);
  }
});

describe('collectSkillReceiptOwnedPaths', () => {
  it('names every file the receipt vouches for, in both roots, receipts included', () => {
    const repo = createRepo();
    installSkill(repo);
    expect([...collectSkillReceiptOwnedPaths(repo)].sort()).toEqual([...INSTALLED_PATHS].sort());
  });

  it('returns nothing for a worktree with no Skill installed', () => {
    expect(collectSkillReceiptOwnedPaths(createRepo()).size).toBe(0);
  });

  it('drops a Skill file whose bytes no longer match the receipt', () => {
    const repo = createRepo();
    installSkill(repo);
    write(repo, '.claude/skills/demo/SKILL.md', '# demo, edited by the agent\n');
    const owned = collectSkillReceiptOwnedPaths(repo);
    expect(owned.has('.claude/skills/demo/SKILL.md')).toBe(false);
    expect(owned.has('.agents/skills/demo/SKILL.md')).toBe(true);
  });

  it('drops files the receipt does not list, even inside the install root', () => {
    const repo = createRepo();
    installSkill(repo);
    write(repo, '.agents/skills/demo/notes.md', 'mine\n');
    expect(collectSkillReceiptOwnedPaths(repo).has('.agents/skills/demo/notes.md')).toBe(false);
  });

  it('ignores a receipt whose skill_id is not its directory', () => {
    const repo = createRepo();
    installSkill(repo, { skillId: 'other', dirName: 'demo', roots: ['.agents/skills/demo'] });
    expect(collectSkillReceiptOwnedPaths(repo).size).toBe(0);
  });

  it('ignores roots outside the known install prefixes', () => {
    const repo = createRepo();
    installSkill(repo, { roots: ['.agents/skills/demo', 'src'] });
    const owned = [...collectSkillReceiptOwnedPaths(repo)];
    expect(owned.some((path) => path.startsWith('src/'))).toBe(false);
    expect(owned.every((path) => path.startsWith('.agents/skills/demo/'))).toBe(true);
  });
});

describe('work-evidence with a Skill installed (#3092)', () => {
  it('reports not_started when the only change is the Skill install', async () => {
    const repo = createRepo();
    installSkill(repo);

    const runId = await runWorkEvidence('wt-skill-only', repo);

    const gate = workEvidenceGate(runId);
    expect(gate?.status).toBe('failed');
    expect(gate?.logTail).toContain('commits=0 uncommitted=0 (contract files excluded)');
    expect(gate?.logTail).toContain('(8 CommandMate-installed Skill file(s) excluded)');
    expect(getVerificationRun(db, runId)?.status).toBe('not_started');
  });

  it('still counts an untracked file the user placed (negative control)', async () => {
    const repo = createRepo();
    installSkill(repo);
    write(repo, 'notes/todo.md', 'mine\n');

    const runId = await runWorkEvidence('wt-skill-user-file', repo);

    const gate = workEvidenceGate(runId);
    expect(gate?.status).toBe('passed');
    expect(gate?.logTail).toContain('uncommitted=1');
  });

  it('still counts a Skill file the agent edited (negative control)', async () => {
    const repo = createRepo();
    installSkill(repo);
    write(repo, '.agents/skills/demo/scripts/run.sh', '#!/bin/sh\necho changed\n');

    const runId = await runWorkEvidence('wt-skill-edited', repo);

    const gate = workEvidenceGate(runId);
    expect(gate?.status).toBe('passed');
    expect(gate?.logTail).toContain('uncommitted=1');
  });

  it('still counts an undeclared .commandcode/ file, which no receipt records', async () => {
    const repo = createRepo();
    installSkill(repo);
    // settings.local.json is declared agent state since #3126; any other file is not.
    write(repo, '.commandcode/commands/x.md', 'x\n');

    const runId = await runWorkEvidence('wt-skill-commandcode', repo);

    expect(workEvidenceGate(runId)?.status).toBe('passed');
  });
});

describe('scope with a Skill installed (#3092)', () => {
  it('passes a change confined to allow', async () => {
    const repo = createRepo();
    installSkill(repo);
    write(repo, 'src/greet.js', 'module.exports = () => "hello";\n');

    expect(await changedPaths(repo)).toEqual(['src/greet.js']);
    const outcome = await evaluateScope(repo, { allow: ['src/greet.js'], deny: [] }, true, 'main');
    expect(outcome.status).toBe('passed');
  });

  it('still fails an out-of-scope file the user placed (negative control)', async () => {
    const repo = createRepo();
    installSkill(repo);
    write(repo, 'src/greet.js', 'module.exports = () => "hello";\n');
    write(repo, 'stray.txt', 'mine\n');

    const outcome = await evaluateScope(repo, { allow: ['src/greet.js'], deny: [] }, true, 'main');
    expect(outcome.status).toBe('failed');
    expect(outcome.logTail).toContain('- stray.txt');
    expect(outcome.logTail).not.toContain('.agents/skills/demo/SKILL.md');
  });

  it('still judges a Skill file that was committed', async () => {
    const repo = createRepo();
    installSkill(repo);
    git(['add', '-A'], repo);
    git(['commit', '-m', 'commit the skill'], repo);

    expect(await changedPaths(repo)).toEqual([...INSTALLED_PATHS].sort());
  });
});
