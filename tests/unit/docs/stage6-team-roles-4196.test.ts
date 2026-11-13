/**
 * Stage 6 of the setup guide and the team-roles templates (Issue #4196).
 *
 * Pinned: the six stages in order with the same five headings, the approval
 * principle (the person merges by default; a conditional delegation is an
 * operating rule the person chooses, not a product switch), the role
 * templates in both languages, and the links to them. Each check runs through
 * a function that is also applied to a weakened copy, so a vacuous pass shows.
 *
 * @vitest-environment node
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SETUP_GUIDE } from '../../../src/cli/docs/setup-guide';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const read = (relative: string): string => fs.readFileSync(path.join(REPO_ROOT, relative), 'utf8');

const EN = 'docs/en/user-guide/team-roles.md';
const JA = 'docs/user-guide/team-roles.md';

function stage6(guide: string): string {
  const start = guide.indexOf('\n## Stage 6: ');
  if (start < 0) return '';
  const rest = guide.slice(start + 1);
  const next = rest.indexOf('\n## ', 1);
  return next === -1 ? rest : rest.slice(0, next);
}

function stage6Problems(guide: string): string[] {
  const body = stage6(guide);
  const problems: string[] = [];
  if (!body) return ['no Stage 6'];
  const headings = Array.from(body.matchAll(/^### (.+)$/gm), ([, h]) => h);
  if (headings.join('|') !== 'Check|Run|Ask the person first|Confirm it worked|If it fails') problems.push('headings');
  if (!/The default is that the person merges\./.test(body)) problems.push('default merge');
  if (!/It is not a switch in the product\./.test(body)) problems.push('not a switch');
  if (!/You never approve or merge on the person's behalf/.test(body)) problems.push('agent never merges');
  for (const rule of ['Bash(commandmate send <worktree-id>:*)', 'Bash(commandmate ask <worktree-id>:*)']) {
    if (!body.includes(rule)) problems.push(rule);
  }
  for (const ignore of ['/.commandcode/', '/.claude/skills/cmate-*/', '/.agents/skills/cmate-*/']) {
    if (!body.includes(ignore)) problems.push(ignore);
  }
  for (const needle of ['commandmate whoami', '--duration', '--stop-pattern', 'send --contract', 'wait', '--verify', 'team-roles.md']) {
    if (!body.includes(needle)) problems.push(needle);
  }
  if (/profile-init\.mjs/.test(body) && !/Out of scope here/.test(body)) problems.push('scope note');
  if (/commandmate roles/.test(body)) problems.push('roles command must not be used');
  return problems;
}

describe('Stage 6 of the setup guide', () => {
  it('passes its own checks', () => {
    expect(stage6Problems(SETUP_GUIDE)).toEqual([]);
  });

  it('is the sixth stage, after Stage 5', () => {
    const titles = Array.from(SETUP_GUIDE.matchAll(/^## (Stage \d+): /gm), ([, t]) => t);
    expect(titles).toEqual(['Stage 1', 'Stage 2', 'Stage 3', 'Stage 4', 'Stage 5', 'Stage 6']);
  });

  it('control: a guide without the merge default or the permission rules is caught', () => {
    const weakened = SETUP_GUIDE.replace('The default is that the person merges.', '').replace(
      'Bash(commandmate ask <worktree-id>:*)',
      '',
    );
    expect(stage6Problems(weakened)).toEqual(expect.arrayContaining(['default merge', 'Bash(commandmate ask <worktree-id>:*)']));
    expect(stage6Problems(SETUP_GUIDE.replace('## Stage 6: ', '## Stage 7: '))).toEqual(['no Stage 6']);
  });

  it('no longer says Stages 3 to 5 or "after Stage 5" for the CLI stages', () => {
    expect(SETUP_GUIDE).not.toMatch(/Stages 3 to 5/);
    expect(SETUP_GUIDE).not.toMatch(/after Stage 5\b/);
  });
});

describe('team-roles templates', () => {
  it.each([EN, JA])('%s has a template per role and the report form', (file) => {
    const text = read(file);
    expect(text.match(/^## (?:Role|役割): /gm)?.length).toBe(3);
    expect(text).toContain('commandmate whoami');
    expect(text).toContain('commandmate ask <worktree-id>');
    expect(text).toContain('--verify');
    expect(text).toContain('--stop-pattern');
  });

  it('keeps the approval principle in both languages, and uses no instance names of the internal team', () => {
    for (const file of [EN, JA]) {
      const text = read(file);
      expect(text, file).not.toMatch(/claude-3|claude-2|dev-leader|project-manager/);
    }
    expect(read(EN)).toMatch(/The default is that the person merges\./);
    expect(read(EN)).toMatch(/not a switch in the product/);
    expect(read(JA)).toMatch(/既定は人がマージ/);
    expect(read(JA)).toMatch(/製品のスイッチではなく/);
  });

  it('is linked from the READMEs, the landing page and the internal team doc, and Level 3 still says the person approves', () => {
    expect(read('README.md')).toContain('./docs/en/user-guide/team-roles.md');
    expect(read('README.md')).toContain('commandmate-team-demo');
    expect(read('README.md')).toContain('Every step that changes something waits for your approval');
    expect(read('docs/ja/README.md')).toContain('../user-guide/team-roles.md');
    expect(read('docs/ja/README.md')).toContain('何かを書き換える手順はどれもあなたの承認を待つ');
    expect(read('docs/orchestrate/team.md')).toContain('../user-guide/team-roles.md');
    expect(read('website/index.html')).toContain('Hand the work to a PM');
  });
});
