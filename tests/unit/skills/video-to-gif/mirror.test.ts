/**
 * The video-to-gif skill must exist byte-identically in both install roots.
 *
 * `.agents/skills` is what the official install path writes and what Codex /
 * Antigravity discover; `.claude/skills` is what Claude Code reads. A skill
 * present in only one root is invisible to half its intended agents, and the
 * failure mode is silent — nothing errors, the command simply never appears
 * (cf. demo-video #1553, cmate-verify #1540).
 *
 * @vitest-environment node
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const CLAUDE_ROOT = path.join(REPO_ROOT, '.claude/skills/video-to-gif');
const AGENTS_ROOT = path.join(REPO_ROOT, '.agents/skills/video-to-gif');

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

describe('video-to-gif skill mirroring', () => {
  const claudeFiles = walk(CLAUDE_ROOT);

  it('ships the expected asset list', () => {
    // Guards against an empty tree quietly passing the comparison below.
    expect(claudeFiles).toEqual(['SKILL.md', 'scripts/to-gif.sh']);
  });

  it('has the same file set in both roots', () => {
    expect(walk(AGENTS_ROOT)).toEqual(claudeFiles);
  });

  it.each(claudeFiles)('%s is byte-identical in both roots', (relative) => {
    const claude = fs.readFileSync(path.join(CLAUDE_ROOT, relative));
    const agents = fs.readFileSync(path.join(AGENTS_ROOT, relative));
    expect(agents.equals(claude)).toBe(true);
  });

  it('diff -r reports no difference', () => {
    // The check a reviewer would actually type, run for real so this file
    // cannot drift from it.
    execFileSync('diff', ['-r', CLAUDE_ROOT, AGENTS_ROOT], { encoding: 'utf8' });
  });

  it('declares the frontmatter keys the loaders read', () => {
    const skill = fs.readFileSync(path.join(CLAUDE_ROOT, 'SKILL.md'), 'utf8');
    const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(skill);
    expect(frontmatter).not.toBeNull();
    expect(frontmatter![1]).toMatch(/^name: video-to-gif$/m);
    expect(frontmatter![1]).toMatch(/^description: .+$/m);
    expect(frontmatter![1]).toMatch(/^allowed-tools: .+$/m);
  });

  it('grants itself both script roots, not just the Claude one', () => {
    // A rule naming only `.claude/skills/**` denies the identical script when
    // the same skill is invoked from its `.agents` copy.
    const skill = fs.readFileSync(path.join(CLAUDE_ROOT, 'SKILL.md'), 'utf8');
    const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(skill)![1];
    expect(frontmatter).toMatch(/\.claude\/skills\/video-to-gif\/scripts\/\*/);
    expect(frontmatter).toMatch(/\.agents\/skills\/video-to-gif\/scripts\/\*/);
  });
});
