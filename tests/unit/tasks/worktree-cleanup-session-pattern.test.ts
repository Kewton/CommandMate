/**
 * `/worktree-cleanup` Phase 3 must target the tmux session names the server
 * actually creates, not the old `feature-<N>-worktree` suffix (Issue #2903).
 *
 * The old pattern (`feature-${ISSUE_NO}-worktree$`) never matched the current
 * naming scheme (`mcbd-<cli>-commandmate-issue-<N>[-<suffix>]`, or
 * `mcbd-<ns>-<cli>-commandmate-issue-<N>[-<suffix>]` after #2866), so Phase 3
 * always reported "No tmux session found" and left the session running after
 * the worktree was removed. This pins the new `PATTERN=` regex embedded in the
 * doc against the exact match / non-match cases from the Issue, and confirms
 * `tmux kill-session` uses the exact-match target (`=name`) instead of a
 * prefix match.
 *
 * @vitest-environment node
 */

import { readFileSync } from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const DOC_PATH = '.claude/commands/worktree-cleanup.md';

const doc = readFileSync(path.join(REPO_ROOT, DOC_PATH), 'utf8');

/** The `### Phase 3: …` section body, up to the next `### ` heading. */
function phase3(): string[] {
  const lines = doc.split('\n');
  const start = lines.findIndex((line) => line.startsWith('### Phase 3'));
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('### '));
  return end === -1 ? rest : rest.slice(0, end);
}

const body = phase3().join('\n');

/** Extracts the `PATTERN="..."` regex literal from the doc's Phase 3 shell block. */
function extractPattern(): string {
  const match = body.match(/PATTERN="(\^mcbd-.+\$)"/);
  expect(match).not.toBeNull();
  return match![1];
}

const ISSUE_NO = '2861';

// The literal regex source with the bash `${ISSUE_NO}` interpolation resolved,
// so it can be compiled and exercised as a real JS RegExp.
const patternSource = extractPattern().replace(/\$\{ISSUE_NO\}/g, ISSUE_NO);
const pattern = new RegExp(patternSource);

const MATCHING = [
  'mcbd-claude-commandmate-issue-2861',
  'mcbd-claude-commandmate-issue-2861-2',
  'mcbd-e7375aa6-codex-commandmate-issue-2861-3',
  'mcbd-command-code-commandmate-issue-2861',
];

const NON_MATCHING = [
  'mcbd-claude-commandmate-issue-28610',
  'mcbd-claude-commandmate-issue-286',
  'mcbd-claude-other-2861',
  'mcbd-claude-commandmate-issue-2861x',
];

describe('/worktree-cleanup Phase 3 tmux session PATTERN', () => {
  it.each(MATCHING)('matches %s', (name) => {
    expect(pattern.test(name)).toBe(true);
  });

  it.each(NON_MATCHING)('does not match %s', (name) => {
    expect(pattern.test(name)).toBe(false);
  });

  it('kills sessions with an exact-match target ("=name"), not a prefix match', () => {
    expect(body).toContain('tmux kill-session -t "=');
  });

  it('no longer contains the old feature-<N>-worktree pattern', () => {
    expect(body).not.toMatch(/feature-\$\{ISSUE_NO\}-worktree/);
  });

  it('explains that git worktree remove and sync do not stop tmux sessions', () => {
    expect(body).toMatch(/git worktree remove/);
    expect(body).toMatch(/止めない/);
  });

  it('stops the CommandMate-managed roster without filtering on "running"', () => {
    expect(body).toContain('commandmate instances');
    expect(body).toContain('.[].instanceId');
    expect(body).not.toMatch(/running.*true|--running/);
  });

  it('kills mutant: loosening the trailing suffix group to `.*$` wrongly matches the ...28610 case', () => {
    expect(patternSource).toContain('(-[0-9A-Za-z]+)?$');
    const mutatedSource = patternSource.replace('(-[0-9A-Za-z]+)?$', '.*$');
    expect(mutatedSource).not.toBe(patternSource);

    const mutatedPattern = new RegExp(mutatedSource);
    expect(mutatedPattern.test('mcbd-claude-commandmate-issue-28610')).toBe(true);
    expect(pattern.test('mcbd-claude-commandmate-issue-28610')).toBe(false);
  });
});
