/**
 * scripts/orchestrate/contract.mjs — the /orchestrate contract generator (Issue #3477).
 *
 * The generated YAML is parsed with the real contract parser, so a shape the
 * server would reject fails here rather than at `send --contract`. The script
 * calls nothing external (no gh / commandmatedev / git); every file it touches
 * here is under os.tmpdir().
 *
 * @vitest-environment node
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  ContractConfigError,
  FRAGMENT_RULES_TEMPLATE,
  GOAL_TEMPLATE,
  MAX_GOAL_LENGTH,
  SONNET_RULE,
  buildContract,
  contractPath,
  contractYaml,
  isolationRules,
  normalizeConfig,
  readTemplate,
  writeContract,
} from '../../../../scripts/orchestrate/contract.mjs';
import { MAX_PATTERN_LENGTH, MAX_TITLE_LENGTH, parseTaskContract } from '@/lib/tasks/contract-parser';
import { parseFragment } from '../../../../scripts/changelog-fragments.mjs';

const SCRIPT = path.resolve(__dirname, '../../../../scripts/orchestrate/contract.mjs');

const base = {
  issue: 3477,
  title: 'orchestrate のスクリプトをリポジトリに入れる',
  kind: 'feature',
  agent: 'claude',
  model: 'opus',
  scope: ['scripts/orchestrate/**', 'tests/unit/scripts/orchestrate/**'],
};

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-orchestrate-contract-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('contract shape', () => {
  it('is a v1 contract the real parser accepts', () => {
    const text = contractYaml(normalizeConfig(base));
    const contract = parseTaskContract(text, 'generated');
    expect(contract.title).toBe('Issue #3477: orchestrate のスクリプトをリポジトリに入れる');
    expect(contract.goal.startsWith('https://github.com/Kewton/CommandMate/issues/3477 を実装する（機能追加）。')).toBe(true);
  });

  it('always requires a commit, work evidence and a clean scope', () => {
    const doc = parseYaml(contractYaml(normalizeConfig(base)));
    expect(doc.success).toEqual({ requireWorkEvidence: true, requireCommit: true, requireScopeClean: true });
  });

  it('defaults the gates to lint / typecheck / unit-related and defines unit-related', () => {
    const doc = buildContract(normalizeConfig(base));
    expect(doc.verify.gates).toEqual(['lint', 'typecheck', 'unit-related']);
    expect(doc.verify.gateDefinitions).toEqual([
      {
        id: 'unit-related',
        command: 'node scripts/run-related-unit-tests.mjs --base origin/develop',
        timeoutSec: 5400,
        mutex: 'cpu.heavy',
      },
    ]);
  });

  it('omits gateDefinitions when unit-related is not a gate', () => {
    const doc = buildContract(normalizeConfig({ ...base, gates: ['lint', 'typecheck', 'unit'] }));
    expect(doc.verify).toEqual({ gates: ['lint', 'typecheck', 'unit'] });
  });

  it('writes the goal as a literal block', () => {
    expect(contractYaml(normalizeConfig(base))).toMatch(/^goal: \|/m);
  });
});

describe('scope', () => {
  it('adds the CHANGELOG fragment of the Issue', () => {
    const doc = buildContract(normalizeConfig(base));
    expect(doc.scope.allow).toEqual([
      'scripts/orchestrate/**',
      'tests/unit/scripts/orchestrate/**',
      'changelog.d/3477.md',
    ]);
    expect(doc.scope.deny).toEqual([]);
  });

  it('does not add the fragment twice', () => {
    const doc = buildContract(normalizeConfig({ ...base, scope: [...base.scope, 'changelog.d/3477.md'] }));
    expect(doc.scope.allow.filter((p: string) => p === 'changelog.d/3477.md')).toHaveLength(1);
  });

  it('keys the fragment by the Issue number, not the contract key', () => {
    const config = normalizeConfig({ ...base, key: '3477-opus' });
    expect(buildContract(config).scope.allow).toContain('changelog.d/3477.md');
    expect(contractPath('/wt', config)).toBe(path.join('/wt', '.commandmate', 'tasks', 'issue-3477-opus.yaml'));
  });

  it.each(['CHANGELOG.md', 'docs/module-reference.md'])('rejects the shared file %s', (shared) => {
    expect(() => normalizeConfig({ ...base, scope: [...base.scope, shared] })).toThrow(ContractConfigError);
  });

  it('rejects an empty scope', () => {
    expect(() => normalizeConfig({ ...base, scope: [] })).toThrow(/scope: at least one path/);
  });
});

describe('CHANGELOG section', () => {
  const sectionLine = (config: Record<string, unknown>) =>
    buildContract(normalizeConfig(config)).goal.split('\n').find((line: string) => line.includes('この Issue の断片は'));

  it('defaults from the kind', () => {
    expect(sectionLine(base)).toContain('`<!-- ### Added -->`');
    expect(sectionLine({ ...base, kind: 'bug' })).toContain('`<!-- ### Fixed -->`');
  });

  it('is overridden by changelog.section', () => {
    expect(sectionLine({ ...base, kind: 'bug', changelog: { section: 'Security' } })).toContain('`<!-- ### Security -->`');
  });

  it('rejects a section changelog-fragments.mjs does not know', () => {
    expect(() => normalizeConfig({ ...base, changelog: { section: 'Misc' } })).toThrow(/changelog.section/);
  });

  it('carries the minimum-version declaration only when one is given', () => {
    expect(buildContract(normalizeConfig(base)).goal).not.toContain('<!-- bump:');
    const goal = buildContract(normalizeConfig({ ...base, changelog: { bump: 'minor' } })).goal;
    expect(goal).toContain('`<!-- bump: minor -->`');
    expect(() => normalizeConfig({ ...base, changelog: { bump: 'patch' } })).toThrow(/changelog.bump/);
  });
});

describe('goal', () => {
  it('fills every placeholder and drops the template notes', () => {
    const goal = buildContract(normalizeConfig({ ...base, decisions: ['PR 1 だけ'], issueBody: '## 目的\n本文' })).goal;
    expect(goal).not.toMatch(/\{\{[A-Z_]+\}\}/);
    expect(goal).not.toMatch(/^#!/m);
    expect(goal).not.toContain('<N>');
    expect(goal).toContain('## この契約での決定（Issue の「決めること」への答え。これに従う）\n- PR 1 だけ');
    expect(goal).toContain('## Issue 本文\n## 目的\n本文');
  });

  it('leaves no empty lines where the optional blocks were', () => {
    const goal = buildContract(normalizeConfig(base)).goal;
    expect(goal).not.toContain('## この契約での決定');
    expect(goal).not.toContain('## Issue 本文');
    expect(goal).not.toMatch(/\n{3,}/);
    // The rules list stays one list.
    expect(goal).toMatch(/「本文に無い指摘」として報告する。\n- tmux セッション/);
  });

  it('carries the 2-4-1 fragment rules for the Issue', () => {
    const goal = buildContract(normalizeConfig(base)).goal;
    expect(goal).toContain('`changelog.d/3477.md` は**実装と同じコミットに含めます**');
    expect(goal).toContain('dev-reports/module-reference/issue-3477.md');
    expect(goal).toContain("grep -n '^| \\`<path>\\`' docs/module-reference.md");
  });

  it('names the commit message prefix from commit.type / commit.scope', () => {
    expect(buildContract(normalizeConfig(base)).goal).toContain('メッセージは `feat: <要約> (#3477)`');
    const scoped = buildContract(normalizeConfig({ ...base, commit: { type: 'fix', scope: 'orchestrate' } })).goal;
    expect(scoped).toContain('メッセージは `fix(orchestrate): <要約> (#3477)`');
  });

  it('adds the escape-hatch line for sonnet only', () => {
    expect(buildContract(normalizeConfig({ ...base, model: 'sonnet' })).goal).toContain(`- ${SONNET_RULE}`);
    expect(buildContract(normalizeConfig(base)).goal).not.toContain(SONNET_RULE);
    expect(buildContract(normalizeConfig({ ...base, agent: 'antigravity', model: '-' })).goal).not.toContain(SONNET_RULE);
  });

  it('ends with IMPL_COMPLETED and forbids the full suite', () => {
    const goal = buildContract(normalizeConfig(base)).goal;
    expect(goal).toContain('テスト全体（`npm run test:unit`）は実行しないこと。全体は検証ゲートか CI が実行する。');
    expect(goal.trimEnd().endsWith('すべて終わったら、最後に `IMPL_COMPLETED` とだけ出力する。')).toBe(true);
  });

  it(`fails generation above ${MAX_GOAL_LENGTH} characters`, () => {
    const config = normalizeConfig({ ...base, issueBody: 'あ'.repeat(MAX_GOAL_LENGTH) });
    expect(() => buildContract(config)).toThrow(/exceeds 8000/);
  });

  it('reads issueBodyFile relative to the config', () => {
    fs.writeFileSync(path.join(tmp, 'body.md'), '## 背景\n事実');
    const config = normalizeConfig({ ...base, issueBodyFile: 'body.md' }, { baseDir: tmp });
    expect(buildContract(config).goal).toContain('## Issue 本文\n## 背景\n事実');
  });
});

describe('config validation', () => {
  it('rejects a model for an antigravity worker', () => {
    expect(() => normalizeConfig({ ...base, agent: 'antigravity', model: 'opus' })).toThrow(/only a claude worker/);
  });

  it('defaults a claude worker to opus', () => {
    expect(normalizeConfig({ ...base, model: undefined }).model).toBe('opus');
  });

  it('collects every problem at once', () => {
    try {
      normalizeConfig({ issue: 'x', kind: 'chore', scope: [] });
      expect.unreachable();
    } catch (error) {
      expect((error as ContractConfigError).problems.length).toBeGreaterThanOrEqual(4);
    }
  });
});

describe('templates', () => {
  it('owns the 2-4-1 block and the 2-4-2 goal', () => {
    expect(readTemplate(FRAGMENT_RULES_TEMPLATE)).toContain('**実装と同じ commit の時点で書くこと。**');
    expect(readTemplate(GOAL_TEMPLATE)).toContain('`IMPL_COMPLETED`');
    expect(fs.readFileSync(GOAL_TEMPLATE, 'utf8')).toMatch(/^#! /m);
    expect(readTemplate(GOAL_TEMPLATE)).not.toMatch(/^#!/m);
  });
});

describe('writeContract / CLI', () => {
  function writeConfig(config: Record<string, unknown>, name = 'issue-3477.yaml'): string {
    const file = path.join(tmp, name);
    fs.writeFileSync(file, JSON.stringify(config));
    return file;
  }

  it('writes .commandmate/tasks/issue-<key>.yaml in the worktree, and a rerun is a no-op', () => {
    const configFile = writeConfig(base);
    const worktree = path.join(tmp, 'wt');
    const first = writeContract({ configFile, worktree });
    expect(first).toEqual({ path: path.join(worktree, '.commandmate/tasks/issue-3477.yaml'), status: 'written' });
    expect(writeContract({ configFile, worktree }).status).toBe('unchanged');
  });

  it('keeps a different contract already in place unless --force', () => {
    const worktree = path.join(tmp, 'wt');
    writeContract({ configFile: writeConfig(base), worktree });
    const changed = writeConfig({ ...base, decisions: ['変えた'] }, 'changed.yaml');
    expect(() => writeContract({ configFile: changed, worktree })).toThrow(/already exists/);
    expect(writeContract({ configFile: changed, worktree, force: true }).status).toBe('written');
  });

  it('accepts a YAML config from the command line', () => {
    const file = path.join(tmp, 'issue.yaml');
    fs.writeFileSync(file, 'issue: 3477\ntitle: t\nscope:\n  - "scripts/orchestrate/**"\n');
    const out = path.join(tmp, 'contract.yaml');
    const result = spawnSync(process.execPath, [SCRIPT, 'generate', '--config', file, '--out', out], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(parseTaskContract(fs.readFileSync(out, 'utf8'), out).scope.allow).toContain('changelog.d/3477.md');
  });

  it('exits 1 with the problems on an invalid config', () => {
    const result = spawnSync(process.execPath, [SCRIPT, 'generate', '--config', writeConfig({ issue: 1 }), '--stdout'], {
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('title: required');
  });

  it('exits 2 on a usage error', () => {
    expect(spawnSync(process.execPath, [SCRIPT, 'nope'], { encoding: 'utf8' }).status).toBe(2);
  });
});

describe('the generator rejects exactly what the contract parser rejects', () => {
  /** Generator verdict and parser verdict for the same config. */
  function verdicts(config: Record<string, unknown>) {
    let generated: string | null = null;
    let generatorAccepts = true;
    try {
      generated = contractYaml(normalizeConfig(config));
    } catch {
      generatorAccepts = false;
    }
    // What the parser says about the same contract, built without the generator's checks.
    const unchecked = {
      version: 1,
      title: `Issue #${config.issue}: ${config.title}`,
      goal: 'g',
      scope: { allow: [...(config.scope as string[]), `changelog.d/${config.issue}.md`], deny: [] },
      verify: { gates: config.gates ?? ['lint'] },
      success: { requireWorkEvidence: true, requireCommit: true, requireScopeClean: true },
    };
    let parserAccepts = true;
    try {
      parseTaskContract(generated ?? JSON.stringify(unchecked), 'contract');
    } catch {
      parserAccepts = false;
    }
    return { generatorAccepts, parserAccepts };
  }

  const prefix = 'Issue #3477: '.length;

  it.each([
    ['a title at the 200-character limit', { title: 'あ'.repeat(MAX_TITLE_LENGTH - prefix) }, true],
    ['a title one over the limit', { title: 'あ'.repeat(MAX_TITLE_LENGTH - prefix + 1) }, false],
    ['a duplicated gate', { gates: ['lint', 'lint'] }, false],
    ['a gate id the runner cannot resolve', { gates: ['Lint'] }, false],
    ['an empty gate list', { gates: [] }, false],
    ['an absolute scope path', { scope: ['/etc/**'] }, false],
    ['a scope that leaves the worktree', { scope: ['src/../../x'] }, false],
    ['a scope pattern over 200 characters', { scope: [`src/${'a'.repeat(MAX_PATTERN_LENGTH)}`] }, false],
    ['a scope with a NUL byte', { scope: ['src/\0x'] }, false],
    ['an ordinary scope', { scope: ['src/lib/**', 'tests/unit/**'] }, true],
  ])('%s', (_name, override, accepted) => {
    const result = verdicts({ ...base, ...override });
    expect(result.parserAccepts).toBe(accepted);
    expect(result.generatorAccepts).toBe(accepted);
  });
});

describe('isolated live checks (2-5 / 2-6)', () => {
  const BAN = 'tmux セッション、サーバー、バックグラウンドプロセスを起動しない。';
  const orchestrate = fs.readFileSync(path.resolve(__dirname, '../../../../.claude/commands/orchestrate.md'), 'utf8');

  it('bans starting processes by default', () => {
    expect(buildContract(normalizeConfig(base)).goal).toContain(BAN);
  });

  it.each([
    [['tmux'], ['2-5'], ['2-6']],
    [['server'], ['2-6'], ['2-5']],
    [['server', 'tmux'], ['2-5', '2-6'], []],
  ])('isolatedLiveCheck %j replaces the ban with the isolation rules', (kinds, present, absent) => {
    const goal = buildContract(normalizeConfig({ ...base, isolatedLiveCheck: kinds })).goal;
    expect(goal).not.toContain(BAN);
    expect(goal).toContain('`$HOME` 配下にファイルを作らない');
    const rules = isolationRules(orchestrate);
    for (const id of present) expect(goal).toContain(rules[id]);
    for (const id of absent) expect(goal).not.toContain(rules[id]);
  });

  it('takes the rules from orchestrate.md, the one owner', () => {
    const rules = isolationRules(orchestrate);
    expect(rules['2-5']).toContain('tmux -L <専用socket>');
    expect(rules['2-6']).toContain('CM_DB_PATH');
  });

  it('rejects an unknown kind', () => {
    expect(() => normalizeConfig({ ...base, isolatedLiveCheck: ['docker'] })).toThrow(/isolatedLiveCheck/);
  });
});

describe('moved without losing a word (2-4-2 before #3477)', () => {
  const goal = () => buildContract(normalizeConfig(base)).goal;

  it('allows the scope and the two fragment files', () => {
    expect(goal()).toContain(
      '- 変更してよいのは scope.allow の範囲（scripts/orchestrate/**, tests/unit/scripts/orchestrate/**, changelog.d/3477.md）と、下の 2 つの断片ファイル（`changelog.d/3477.md` と `dev-reports/module-reference/issue-3477.md`）だけ。'
    );
  });

  it('says where to do the checks instead', () => {
    expect(goal()).toContain('確認は `os.tmpdir()` 配下に作った一時ディレクトリ（private HOME など）の中で行う。');
  });

  it('routes a needed test change to the out-of-body report', () => {
    expect(goal()).toMatch(/既存の `it\(\.\.\.\)` \/ `describe\(\.\.\.\)` を消したり名前を変えたりしない.*本文に無い指摘として報告する。/);
  });
});

describe('fragment line numbers follow the minimum-version declaration (#3480)', () => {
  it('says line 2 and "line 3 onwards" without a declaration', () => {
    const goal = buildContract(normalizeConfig(base)).goal;
    expect(goal).toContain('（2 行目。先頭は');
    expect(goal).toContain('`check` も 3 行目以降に空行以外があると不合格にします');
    expect(goal).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });

  it('says line 3 and "line 4 onwards" with one', () => {
    const goal = buildContract(normalizeConfig({ ...base, changelog: { bump: 'minor' } })).goal;
    expect(goal).toContain('（3 行目。2 行目は最低の版の宣言 `<!-- bump: minor -->`。先頭は');
    expect(goal).toContain('`check` も 4 行目以降に空行以外があると不合格にします');
    expect(goal).not.toContain('（2 行目。先頭は');
  });

  it('matches what changelog-fragments.mjs actually accepts', () => {
    const entry = '- **feat(orchestrate): x** (#3477): y';
    expect(parseFragment('3477.md', `<!-- ### Added -->\n<!-- bump: minor -->\n${entry}\n`).errors).toEqual([]);
    expect(parseFragment('3477.md', `<!-- ### Added -->\n<!-- bump: minor -->\n${entry}\nmore\n`).errors).toHaveLength(1);
    expect(parseFragment('3477.md', `<!-- ### Added -->\n${entry}\nmore\n`).errors).toHaveLength(1);
  });
});
