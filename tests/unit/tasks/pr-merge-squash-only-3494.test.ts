import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '../../..');

function grepClaude(pattern: string): string[] {
  try {
    const out = execFileSync('git', ['grep', '-n', pattern, '--', '.claude'], {
      cwd: root,
      encoding: 'utf8',
    });
    return out.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

describe('PR merge is squash-only (#3494)', () => {
  it('no `gh pr merge` under .claude uses --merge', () => {
    const lines = grepClaude('gh pr merge');
    expect(lines.filter((l) => /--merge(\s|$)/.test(l))).toEqual([]);
  });

  it('/pr-merge-pipeline command is removed and no longer referenced', () => {
    expect(existsSync(path.join(root, '.claude/commands/pr-merge-pipeline.md'))).toBe(false);
    expect(grepClaude('/pr-merge-pipeline')).toEqual([]);
  });

  it('uat-fix-loop publishes and merges through the orchestrate scripts', () => {
    const body = readFileSync(path.join(root, '.claude/commands/uat-fix-loop.md'), 'utf8');
    expect(body).toContain('scripts/orchestrate/publish-pr.mjs');
    expect(body).toContain('scripts/orchestrate/merge-pr.mjs');
    expect(body).not.toMatch(/send\s+\S+\s+"\/create-pr"/);
  });
});
