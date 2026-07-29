/**
 * The demo-video skill must exist byte-identically in both install roots
 * (Issue #1553, cf. #1460).
 *
 * `.agents/skills` is what the official install path writes and what Codex
 * discovers; `.claude/skills` is what Claude Code reads. A skill present in only
 * one root is invisible to half its intended agents, and the failure mode is
 * silent — nothing errors, the command simply never appears.
 *
 * @vitest-environment node
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const CLAUDE_ROOT = path.join(REPO_ROOT, '.claude/skills/demo-video');
const AGENTS_ROOT = path.join(REPO_ROOT, '.agents/skills/demo-video');

function walk(root: string): string[] {
  const found: string[] = [];
  const visit = (dir: string) => {
    for (const entry of fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else found.push(path.relative(root, full));
    }
  };
  visit(root);
  return found;
}

describe('demo-video skill mirroring', () => {
  const claudeFiles = walk(CLAUDE_ROOT);

  it('ships the Phase A assets', () => {
    // Guards against an empty tree quietly passing the comparison below.
    expect(claudeFiles).toEqual([
      'SKILL.md',
      'fixtures/claude-session-sample.cast',
      'scripts/env-down.sh',
      'scripts/env-up.sh',
      'scripts/fake-agent.sh',
      'scripts/record-scenes.ts',
    ]);
  });

  it('has the same file set in both roots', () => {
    expect(walk(AGENTS_ROOT)).toEqual(claudeFiles);
  });

  it.each(claudeFiles)('%s is byte-identical in both roots', (relative) => {
    const claude = fs.readFileSync(path.join(CLAUDE_ROOT, relative));
    const agents = fs.readFileSync(path.join(AGENTS_ROOT, relative));
    expect(agents.equals(claude)).toBe(true);
  });

  it('declares the frontmatter keys the loaders read', () => {
    const skill = fs.readFileSync(path.join(CLAUDE_ROOT, 'SKILL.md'), 'utf8');
    const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(skill);
    expect(frontmatter).not.toBeNull();
    expect(frontmatter![1]).toMatch(/^name: demo-video$/m);
    expect(frontmatter![1]).toMatch(/^description: .+$/m);
    expect(frontmatter![1]).toMatch(/^allowed-tools: .+$/m);
  });

  it('never points the operator at port 3000', () => {
    const skill = fs.readFileSync(path.join(CLAUDE_ROOT, 'SKILL.md'), 'utf8');
    expect(skill).not.toMatch(/127\.0\.0\.1:3000\/|localhost:3000/);
  });
});
