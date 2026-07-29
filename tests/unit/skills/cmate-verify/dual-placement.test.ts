import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The skill must exist byte-identically under both roots (Issue #1540).
 *
 * The official install path is `.agents/skills` (what Codex / Antigravity read),
 * but Claude only reads `.claude/skills` — a skill placed in one root alone is
 * invisible to the other agent, and `commandmate skill install` has shipped the
 * same dual placement since #1460. Editing one copy and forgetting the other is
 * the failure this test exists to catch.
 */
const CLAUDE_ROOT = path.join(process.cwd(), '.claude/skills/cmate-verify');
const AGENTS_ROOT = path.join(process.cwd(), '.agents/skills/cmate-verify');

function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(path.relative(root, full));
    }
  };
  walk(root);
  return out.sort();
}

describe('cmate-verify is placed byte-identically in both skill roots', () => {
  it('both roots hold the same non-empty file list', () => {
    const claudeFiles = listFiles(CLAUDE_ROOT);
    const agentsFiles = listFiles(AGENTS_ROOT);
    // Comparing two empty trees would pass trivially.
    expect(claudeFiles.length).toBeGreaterThanOrEqual(20);
    expect(agentsFiles).toEqual(claudeFiles);
    expect(claudeFiles).toContain('SKILL.md');
    expect(claudeFiles).toContain(path.join('scripts', 'verify-run.sh'));
    expect(claudeFiles).toContain(path.join('scripts', 'tests', 'run-tests.sh'));
  });

  it('every file has identical bytes in both roots', () => {
    for (const rel of listFiles(CLAUDE_ROOT)) {
      const claude = readFileSync(path.join(CLAUDE_ROOT, rel));
      const agents = readFileSync(path.join(AGENTS_ROOT, rel));
      expect(agents.equals(claude), `differs between skill roots: ${rel}`).toBe(true);
    }
  });

  it('diff -r reports no difference', () => {
    // The acceptance criterion is spelled as `diff -r`; run the real thing so the
    // check cannot drift from what a reviewer would type.
    execFileSync('diff', ['-r', CLAUDE_ROOT, AGENTS_ROOT], { encoding: 'utf8' });
  });

  it('keeps the scripts executable in both roots', () => {
    for (const rel of listFiles(CLAUDE_ROOT).filter((f) => f.endsWith('.sh'))) {
      for (const root of [CLAUDE_ROOT, AGENTS_ROOT]) {
        const mode = statSync(path.join(root, rel)).mode;
        expect(mode & 0o111, `not executable: ${path.join(root, rel)}`).not.toBe(0);
      }
    }
  });
});
