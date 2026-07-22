/**
 * Shared harness for the Skill MVP integration suite (Issue #1242)
 *
 * The per-Issue suites (#1229–#1236) each mock the layer below the one under
 * test. That proves every layer in isolation but never proves they compose, so
 * this harness deliberately keeps the layers real: a real git repository, the
 * real snapshot store, the real package reader/validator and the real
 * filesystem writes. Only three seams are stubbed, and each for a reason that
 * is not "the code below is inconvenient":
 *
 * - the Catalog and the artifact download, because a test must never depend on
 *   the network (the real endpoints are exercised by the opt-in suite);
 * - the worktree row, because the DB-of-record is the server's, not the test's;
 * - the CommandMate config root, so locks/journals/snapshots land in a
 *   throwaway directory instead of the developer's `~/.commandmate`.
 *
 * Roots live under `$HOME`, never `os.tmpdir()`: `system-directories.ts`
 * rejects `/tmp` and `/var`, and on macOS `os.tmpdir()` resolves under `/var`,
 * so a tmpdir root makes the snapshot store throw `SKILL_FETCH_STORE_IO`.
 */

import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  lstatSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { homedir } from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { SKILL_INSTALL_ROOT_PREFIX, SKILL_STAGING_DIRNAME } from '@/lib/skills/constants';
import type { SkillCatalog, SkillCatalogVersion } from '@/types/skills';
import { buildPackage, type PackageOptions } from '../../fixtures/skills/malicious-packages/package';

/** Root every temp directory of this suite is created under. */
const TEST_ROOT_PARENT = path.join(homedir(), '.commandmate-test-skills-mvp');

/**
 * The three Skills the MVP ships, mirrored as fixtures.
 *
 * Same IDs and versions as the published Catalog so the fixture flow and the
 * opt-in real-release flow assert against the same identifiers, but the bytes
 * are built locally — the fixture suite never reaches the network.
 */
export const MVP_SKILLS = [
  { id: 'cmate-repository-analysis', version: '0.1.0', name: 'Repository Analysis' },
  { id: 'cmate-issue-refinement', version: '0.1.0', name: 'Issue Refinement' },
  { id: 'cmate-acceptance-test', version: '0.1.0', name: 'Acceptance Test' },
] as const;

export const WORKTREE_ID = 'wt-00000000-0000-4000-8000-000000000001';
export const CATALOG_REPOSITORY = 'Kewton/commandmate-skills';

/**
 * Insert the worktree row the mocked `getWorktreeById` pretends to read.
 *
 * Since #1430 `skill_installations.worktree_id` is a foreign key, so the row the
 * routes resolve must also exist in the test database — in production both come
 * from the same connection.
 */
export function seedWorktreeRow(
  db: Database.Database,
  worktreePath: string,
  id: string = WORKTREE_ID
): void {
  db.prepare(
    `INSERT OR REPLACE INTO worktrees (id, name, path, repository_path, repository_name)
     VALUES (?, 'demo-worktree', ?, ?, 'commandmate')`
  ).run(id, worktreePath, path.dirname(worktreePath));
}

/** Deterministic 40-hex commit per Skill, so receipts are reproducible. */
export function commitFor(skillId: string): string {
  return createHash('sha256').update(`commit:${skillId}`).digest('hex').slice(0, 40);
}

export function createTestRoot(prefix: string): string {
  mkdirSync(TEST_ROOT_PARENT, { recursive: true });
  return mkdtempSync(path.join(TEST_ROOT_PARENT, `${prefix}-`));
}

export function removeTestRoot(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

// =============================================================================
// Git
// =============================================================================

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'CommandMate Test',
  GIT_AUTHOR_EMAIL: 'test@commandmate.invalid',
  GIT_COMMITTER_NAME: 'CommandMate Test',
  GIT_COMMITTER_EMAIL: 'test@commandmate.invalid',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

export function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf-8' }).trim();
}

/**
 * A real single-commit repository on branch `main`.
 *
 * Real git, not a mocked `execGitCommand`, because branch/HEAD/dirty drift and
 * `git check-ignore` are exactly what the plan is supposed to observe — a
 * canned mock would assert the test's idea of git, not git.
 */
export function initGitRepo(dir: string): { head: string; branch: string } {
  git(dir, ['init', '-b', 'main', '-q']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  git(dir, ['config', 'user.name', 'CommandMate Test']);
  git(dir, ['config', 'user.email', 'test@commandmate.invalid']);
  writeRepoFile(dir, 'README.md', '# fixture worktree\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'initial']);
  return { head: git(dir, ['rev-parse', 'HEAD']), branch: 'main' };
}

export function writeRepoFile(dir: string, relativePath: string, content: string): void {
  const target = path.join(dir, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf-8');
}

// =============================================================================
// Artifacts and Catalog
// =============================================================================

export interface BuiltArtifact {
  skillId: string;
  version: string;
  bytes: Buffer;
  sha256: string;
  size: number;
  commit: string;
}

export function displayNameFor(skillId: string): string {
  return MVP_SKILLS.find((skill) => skill.id === skillId)?.name ?? 'Demo Skill';
}

/**
 * A benign package for `skillId`, carrying that Skill's own display name.
 *
 * The name has to be threaded through both `SKILL.md` and the manifest because
 * `validateSkillIdentityConsistency()` requires them to agree — and it has to
 * differ per Skill, or Agent discovery would report three Skills with one name
 * and the discovery assertion would pass without meaning anything.
 */
export function buildArtifact(
  skillId: string,
  version: string,
  options: Omit<PackageOptions, 'skillId' | 'version'> = {}
): BuiltArtifact {
  const name = displayNameFor(skillId);
  const skillMd = `---\nname: ${name}\ndescription: Fixture Skill ${skillId} for the MVP suite.\n---\n\n# ${name}\n\nSteps go here.\n`;
  const built = buildPackage({
    skillId,
    version,
    skillMd,
    ...options,
    manifestPatch: (manifest) => {
      manifest.name = name;
      options.manifestPatch?.(manifest);
    },
  });
  const bytes = built.bytes;
  return {
    skillId,
    version,
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.byteLength,
    commit: commitFor(skillId),
  };
}

/**
 * Describe arbitrary bytes as a Catalog artifact.
 *
 * The security suite needs the Catalog to *agree* with a malicious archive's
 * digest — otherwise every case would stop at the checksum guard and the
 * package guards under test would never run.
 */
export function artifactFromBytes(
  skillId: string,
  version: string,
  bytes: Uint8Array
): BuiltArtifact {
  const buffer = Buffer.from(bytes);
  return {
    skillId,
    version,
    bytes: buffer,
    sha256: createHash('sha256').update(buffer).digest('hex'),
    size: buffer.byteLength,
    commit: commitFor(skillId),
  };
}

export function catalogVersionFor(artifact: BuiltArtifact): SkillCatalogVersion {
  return {
    version: artifact.version,
    changelog: `Release ${artifact.version}`,
    published_at: '2026-07-16T09:30:00Z',
    source: {
      repository: CATALOG_REPOSITORY,
      ref: `${artifact.skillId}-v${artifact.version}`,
      commit: artifact.commit,
    },
    artifact: {
      asset_name: `${artifact.skillId}-${artifact.version}.tar.gz`,
      url: `https://github.com/${CATALOG_REPOSITORY}/releases/download/${artifact.skillId}-v${artifact.version}/${artifact.skillId}-${artifact.version}.tar.gz`,
      sha256: artifact.sha256,
      size: artifact.size,
      content_type: 'application/gzip',
      format: 'tar.gz',
    },
    compatibility: {
      commandmate: '>=0.11.0 <1.0.0',
      agents: [
        {
          agent: 'claude',
          support: 'native',
          evidence: 'Standard SKILL.md discovery from .agents/skills',
        },
      ],
    },
    declared_risk: 'low',
  } as SkillCatalogVersion;
}

export function buildCatalog(artifacts: readonly BuiltArtifact[]): SkillCatalog {
  return {
    schema_version: 1,
    entries: artifacts.map((artifact) => {
      const meta = MVP_SKILLS.find((skill) => skill.id === artifact.skillId);
      return {
        id: artifact.skillId,
        name: meta?.name ?? artifact.skillId,
        summary: `Fixture Skill ${artifact.skillId}.`,
        provider: { name: 'CommandMate' },
        license: 'MIT',
        latest: artifact.version,
        versions: [catalogVersionFor(artifact)],
      };
    }),
  } as SkillCatalog;
}

/** A fresh, non-stale Catalog snapshot result, as `getSkillCatalog` returns it. */
export function catalogResult(catalog: SkillCatalog) {
  return {
    ok: true as const,
    snapshot: {
      catalog,
      fetchedAt: '2026-07-16T10:00:00Z',
      revalidatedAt: '2026-07-16T10:00:00Z',
      stale: false,
      offline: false,
      state: 'fresh' as const,
      staleReason: null,
      source: { repository: CATALOG_REPOSITORY, ref: 'main', revision: null },
    },
  };
}

// =============================================================================
// Filesystem observation
// =============================================================================

export interface FileFacts {
  sha256: string;
  mode: number;
  size: number;
}

/**
 * Every regular file under `dir`, keyed by POSIX-relative path.
 *
 * Used to prove the negative half of the acceptance condition: that nothing
 * outside `.agents/skills/<id>` changed. Comparing digests rather than mtimes
 * keeps the assertion meaningful when a step rewrites a file with identical
 * content.
 */
export function snapshotTree(dir: string, skip: readonly string[] = ['.git']): Map<string, FileFacts> {
  const out = new Map<string, FileFacts>();
  const walk = (current: string, prefix: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const entry of entries.sort()) {
      if (prefix === '' && skip.includes(entry)) continue;
      const absolute = path.join(current, entry);
      const relative = prefix === '' ? entry : `${prefix}/${entry}`;
      const stats = lstatSync(absolute);
      if (stats.isDirectory()) {
        walk(absolute, relative);
      } else if (stats.isFile()) {
        out.set(relative, {
          sha256: createHash('sha256').update(readFileSync(absolute)).digest('hex'),
          mode: stats.mode & 0o777,
          size: stats.size,
        });
      } else {
        out.set(relative, { sha256: `irregular:${stats.mode}`, mode: stats.mode & 0o777, size: 0 });
      }
    }
  };
  walk(dir, '');
  return out;
}

/** Paths present in `after` but not `before`, plus paths whose bytes changed. */
export function treeDelta(
  before: Map<string, FileFacts>,
  after: Map<string, FileFacts>
): { added: string[]; removed: string[]; changed: string[] } {
  const added: string[] = [];
  const changed: string[] = [];
  for (const [key, facts] of after) {
    const previous = before.get(key);
    if (!previous) added.push(key);
    else if (previous.sha256 !== facts.sha256 || previous.mode !== facts.mode) changed.push(key);
  }
  const removed = [...before.keys()].filter((key) => !after.has(key));
  return { added: added.sort(), removed: removed.sort(), changed: changed.sort() };
}

export function listDirEntries(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

/**
 * Everything the service is allowed to leave behind, and everything it is not.
 *
 * `journal` is intentionally excluded from the residue count: a terminal
 * journal entry is the idempotency record, not a leak. Locks, package staging
 * and worktree staging are pure scratch and must be empty once the operation
 * returns, whichever way it returned.
 */
export function residueReport(configRoot: string, worktreePath: string) {
  const stateRoot = path.join(configRoot, 'skills');
  return {
    locks: listDirEntries(path.join(stateRoot, 'locks')),
    packageStaging: listDirEntries(path.join(stateRoot, 'package-staging')),
    worktreeStaging: listDirEntries(
      path.join(worktreePath, SKILL_INSTALL_ROOT_PREFIX, SKILL_STAGING_DIRNAME)
    ),
  };
}

export function installRootOf(worktreePath: string, skillId: string): string {
  return path.join(worktreePath, SKILL_INSTALL_ROOT_PREFIX, skillId);
}
