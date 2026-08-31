/**
 * `.commandmate/agents.yaml` — the repository layer of `resolveSelectedAgents()`
 * (Issue #2066).
 *
 * Two things are pinned here that nothing else can pin:
 *
 *  1. **Fail-open is a behaviour, not a comment.** Every malformed shape must
 *     produce `null` AND a warning. `null` alone would also be produced by a
 *     loader that silently swallowed the file, and a repository whose
 *     declaration is being ignored has to be able to find out why from the log,
 *     so both halves are asserted together.
 *  2. **The cache is what keeps the read off the polled path.** `getWorktrees()`
 *     runs on every sidebar tick, and #1913's rule says it may not grow a
 *     filesystem probe. That claim is checked here by *rewriting the file and
 *     asserting the answer does not move* — a stale answer is proof the disk was
 *     not consulted, and unlike a call-count spy it cannot be satisfied by a
 *     memo placed at the wrong level.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempDir, removeTempDir } from '../../helpers/temp-dir';

// vi.hoisted() so the mock logger exists by the time vi.mock is hoisted above
// the imports below.
const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn().mockReturnThis(),
  },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn(() => mockLogger),
  generateRequestId: vi.fn(() => 'test-request-id'),
}));

import {
  parseRepoAgentsConfig,
  loadRepoAgentsConfig,
  getRepoDefaultSelectedAgents,
  refreshRepoAgentsConfig,
  clearRepoAgentsConfigCache,
  REPO_AGENTS_CONFIG_RELATIVE_PATH,
  REPO_AGENTS_CACHE_TTL_MS,
  MAX_REPO_AGENTS_CONFIG_BYTES,
} from '@/lib/repo-config/agents-config';

const SOURCE = '/repo/.commandmate/agents.yaml';

/** Warning actions emitted since the last reset, in order. */
function warnedActions(): string[] {
  return mockLogger.warn.mock.calls.map((call) => call[0] as string);
}

describe('parseRepoAgentsConfig(): accepted declarations (Issue #2066)', () => {
  beforeEach(() => {
    mockLogger.warn.mockClear();
  });

  it('reads an ordered list, [0] primary', () => {
    expect(parseRepoAgentsConfig('agents: [codex, claude]', SOURCE)).toEqual(['codex', 'claude']);
    expect(warnedActions()).toEqual([]);
  });

  it('reads the block-sequence spelling identically', () => {
    expect(parseRepoAgentsConfig('agents:\n  - opencode\n  - codex\n', SOURCE))
      .toEqual(['opencode', 'codex']);
  });

  it('accepts an explicit version: 1, and the quoted spelling of it', () => {
    expect(parseRepoAgentsConfig('version: 1\nagents: [codex, claude]', SOURCE))
      .toEqual(['codex', 'claude']);
    expect(parseRepoAgentsConfig('version: "1"\nagents: [codex, claude]', SOURCE))
      .toEqual(['codex', 'claude']);
    expect(warnedActions()).toEqual([]);
  });

  it('moves `primary` to the front and keeps the rest in declared order', () => {
    expect(parseRepoAgentsConfig('agents: [codex, claude, gemini]\nprimary: gemini', SOURCE))
      .toEqual(['gemini', 'codex', 'claude']);
  });

  it('leaves the order alone when `primary` already is agents[0]', () => {
    expect(parseRepoAgentsConfig('agents: [codex, claude]\nprimary: codex', SOURCE))
      .toEqual(['codex', 'claude']);
  });

  it('accepts the full six-agent list `validateAgentsPair` allows', () => {
    const six = 'agents: [claude, codex, gemini, opencode, copilot, antigravity]';
    expect(parseRepoAgentsConfig(six, SOURCE)).toHaveLength(6);
    expect(warnedActions()).toEqual([]);
  });
});

describe('parseRepoAgentsConfig(): fail-open (Issue #2066 acceptance)', () => {
  beforeEach(() => {
    mockLogger.warn.mockClear();
  });

  /**
   * Every row is a way a hand-written file goes wrong. The expected action is
   * asserted alongside the `null` so that a future refactor cannot satisfy this
   * suite by dropping the warning and returning null from one early `return`.
   */
  it.each([
    ['unclosed flow sequence', 'agents: [codex, claude', 'repo-agents:yaml-parse-failed'],
    ['a duplicate top-level key', 'agents: [codex, claude]\nagents: [gemini, claude]\n', 'repo-agents:yaml-parse-failed'],
    ['a top-level list', '- codex\n- claude\n', 'repo-agents:not-a-mapping'],
    ['a top-level scalar', 'codex\n', 'repo-agents:not-a-mapping'],
    ['a misspelled key', 'agent: [codex, claude]', 'repo-agents:unknown-keys'],
    ['an unread extra key', 'agents: [codex, claude]\nprimaries: codex', 'repo-agents:unknown-keys'],
    ['a version from the future', 'version: 2\nagents: [codex, claude]', 'repo-agents:unsupported-version'],
    ['a non-numeric version', 'version: latest\nagents: [codex, claude]', 'repo-agents:unsupported-version'],
    ['agents as a scalar', 'agents: codex', 'repo-agents:agents-not-a-list'],
    ['agents as a mapping', 'agents:\n  first: codex\n', 'repo-agents:agents-not-a-list'],
    ['no agents key at all', 'primary: codex\n', 'repo-agents:agents-not-a-list'],
    ['a single agent', 'agents: [codex]', 'repo-agents:invalid-agents'],
    ['an empty list', 'agents: []', 'repo-agents:invalid-agents'],
    ['seven agents', 'agents: [claude, codex, gemini, opencode, copilot, antigravity, vibe-local]', 'repo-agents:invalid-agents'],
    ['an unknown tool id', 'agents: [codex, cursor]', 'repo-agents:invalid-agents'],
    ['a duplicate', 'agents: [codex, codex]', 'repo-agents:invalid-agents'],
    ['a non-string entry', 'agents: [codex, 7]', 'repo-agents:invalid-agents'],
    ['a primary outside agents', 'agents: [codex, claude]\nprimary: gemini', 'repo-agents:primary-not-in-agents'],
    ['a primary that is a list', 'agents: [codex, claude]\nprimary: [codex]', 'repo-agents:primary-not-in-agents'],
  ])('warns and falls through for %s', (_name, raw, action) => {
    expect(parseRepoAgentsConfig(raw, SOURCE)).toBeNull();
    expect(warnedActions()).toEqual([action]);
  });

  it('treats an empty file as "declares nothing" rather than as an error', () => {
    expect(parseRepoAgentsConfig('', SOURCE)).toBeNull();
    expect(parseRepoAgentsConfig('# only a comment\n', SOURCE)).toBeNull();
    // Not a warning: a repository with no declaration is the normal case, and
    // an empty file says the same thing as an absent one.
    expect(warnedActions()).toEqual([]);
  });

  /**
   * R4-005. The file is committed by whoever can push to the repository, and the
   * server log is read in a terminal, so an escape sequence in it must not reach
   * that terminal intact.
   */
  it('strips control characters out of the value it logs', () => {
    const evil = `agents: ["\u001b[2Kcodex\\nFAKE LOG LINE", claude]`;
    expect(parseRepoAgentsConfig(evil, SOURCE)).toBeNull();

    const logged = JSON.stringify(mockLogger.warn.mock.calls);
    expect(logged).toContain('FAKE LOG LINE');
    expect(logged).not.toContain('\\u001b');
    expect(logged).not.toContain('\\n');
  });
});

describe('loadRepoAgentsConfig(): the file on disk (Issue #2066)', () => {
  let repo: string;

  beforeEach(() => {
    repo = makeTempDir('repo-agents-2066-');
    mockLogger.warn.mockClear();
    clearRepoAgentsConfigCache();
  });

  afterEach(() => {
    removeTempDir(repo);
  });

  function declare(contents: string): void {
    mkdirSync(join(repo, '.commandmate'), { recursive: true });
    writeFileSync(join(repo, REPO_AGENTS_CONFIG_RELATIVE_PATH), contents, 'utf8');
  }

  it('returns null, silently, when the repository has no declaration', () => {
    expect(loadRepoAgentsConfig(repo)).toBeNull();
    expect(warnedActions()).toEqual([]);
  });

  it('returns null, silently, when `.commandmate` is a file rather than a directory', () => {
    writeFileSync(join(repo, '.commandmate'), 'not a directory', 'utf8');
    expect(loadRepoAgentsConfig(repo)).toBeNull();
    expect(warnedActions()).toEqual([]);
  });

  it('returns null, silently, when the repository directory itself is gone', () => {
    expect(loadRepoAgentsConfig(join(repo, 'deleted-repo'))).toBeNull();
    expect(warnedActions()).toEqual([]);
  });

  it('reads and resolves a declaration', () => {
    declare('agents: [opencode, codex]\nprimary: codex\n');
    expect(loadRepoAgentsConfig(repo)).toEqual(['codex', 'opencode']);
  });

  it('refuses a file too large to be a declaration', () => {
    declare(`# ${'x'.repeat(MAX_REPO_AGENTS_CONFIG_BYTES)}\nagents: [codex, claude]\n`);
    expect(loadRepoAgentsConfig(repo)).toBeNull();
    expect(warnedActions()).toEqual(['repo-agents:too-large']);
  });

  it('warns when a directory sits where the file should be', () => {
    mkdirSync(join(repo, REPO_AGENTS_CONFIG_RELATIVE_PATH), { recursive: true });
    expect(loadRepoAgentsConfig(repo)).toBeNull();
    // EISDIR is not "absent": something is wrong and the operator should see it.
    expect(warnedActions()).toEqual(['repo-agents:read-failed']);
  });
});

describe('the cache keeps the read off the polled path (Issue #2066 / #1913)', () => {
  const T0 = 1_000_000;
  let repo: string;

  beforeEach(() => {
    repo = makeTempDir('repo-agents-cache-2066-');
    declare(repo, 'agents: [codex, claude]\n');
    clearRepoAgentsConfigCache();
    mockLogger.warn.mockClear();
  });

  afterEach(() => {
    removeTempDir(repo);
  });

  function declare(root: string, contents: string): void {
    mkdirSync(join(root, '.commandmate'), { recursive: true });
    writeFileSync(join(root, REPO_AGENTS_CONFIG_RELATIVE_PATH), contents, 'utf8');
  }

  it('answers from memory inside the TTL, so an edit is invisible until it expires', () => {
    expect(getRepoDefaultSelectedAgents(repo, T0)).toEqual(['codex', 'claude']);

    declare(repo, 'agents: [opencode, gemini]\n');
    for (let i = 1; i < 25; i++) {
      expect(getRepoDefaultSelectedAgents(repo, T0 + i)).toEqual(['codex', 'claude']);
    }
    expect(getRepoDefaultSelectedAgents(repo, T0 + REPO_AGENTS_CACHE_TTL_MS - 1))
      .toEqual(['codex', 'claude']);
  });

  it('re-reads once the TTL has passed', () => {
    expect(getRepoDefaultSelectedAgents(repo, T0)).toEqual(['codex', 'claude']);
    declare(repo, 'agents: [opencode, gemini]\n');

    expect(getRepoDefaultSelectedAgents(repo, T0 + REPO_AGENTS_CACHE_TTL_MS + 1))
      .toEqual(['opencode', 'gemini']);
  });

  /**
   * The negative answer is cached too. Without that, a repository with a broken
   * file would emit one warning per sidebar poll — which is how a useful warning
   * becomes noise somebody filters out.
   */
  it('caches the refusal, so a broken file warns once rather than once per poll', () => {
    declare(repo, 'agents: [codex');
    clearRepoAgentsConfigCache();

    for (let i = 0; i < 10; i++) {
      expect(getRepoDefaultSelectedAgents(repo, T0 + i)).toBeNull();
    }
    expect(warnedActions()).toEqual(['repo-agents:yaml-parse-failed']);
  });

  it('answers null for a worktree row with no repository_path', () => {
    expect(getRepoDefaultSelectedAgents(null)).toBeNull();
    expect(getRepoDefaultSelectedAgents(undefined)).toBeNull();
    expect(getRepoDefaultSelectedAgents('')).toBeNull();
  });

  /**
   * `refreshRepoAgentsConfig` is what `scanWorktrees()` calls, and its whole job
   * is to make an edit visible without waiting out the TTL.
   */
  it('adopts an edit immediately on refresh, without waiting for the TTL', () => {
    expect(getRepoDefaultSelectedAgents(repo, T0)).toEqual(['codex', 'claude']);

    declare(repo, 'agents: [opencode, gemini]\n');
    expect(getRepoDefaultSelectedAgents(repo, T0 + 1)).toEqual(['codex', 'claude']);

    expect(refreshRepoAgentsConfig(repo, T0 + 1)).toEqual(['opencode', 'gemini']);
    expect(getRepoDefaultSelectedAgents(repo, T0 + 2)).toEqual(['opencode', 'gemini']);
  });

  it('forgets a repository whose declaration was deleted', () => {
    expect(getRepoDefaultSelectedAgents(repo, T0)).toEqual(['codex', 'claude']);
    rmSync(join(repo, REPO_AGENTS_CONFIG_RELATIVE_PATH));

    expect(refreshRepoAgentsConfig(repo, T0)).toBeNull();
    expect(getRepoDefaultSelectedAgents(repo, T0)).toBeNull();
  });

  it('caches per repository, not globally', () => {
    const other = makeTempDir('repo-agents-other-2066-');
    try {
      declare(other, 'agents: [gemini, claude]\n');

      expect(getRepoDefaultSelectedAgents(repo, T0)).toEqual(['codex', 'claude']);
      expect(getRepoDefaultSelectedAgents(other, T0)).toEqual(['gemini', 'claude']);

      declare(repo, 'agents: [copilot, claude]\n');
      declare(other, 'agents: [copilot, codex]\n');
      clearRepoAgentsConfigCache(repo);

      expect(getRepoDefaultSelectedAgents(repo, T0)).toEqual(['copilot', 'claude']);
      // `other` was not cleared, so it still answers from its own entry.
      expect(getRepoDefaultSelectedAgents(other, T0)).toEqual(['gemini', 'claude']);
    } finally {
      removeTempDir(other);
    }
  });
});
