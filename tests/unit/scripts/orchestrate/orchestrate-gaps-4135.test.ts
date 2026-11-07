/**
 * The gaps the `/orchestrate 4112…4117` run found (Issue #4135):
 *   1. a permission that says "if CI passes" waits for every check (`--last`);
 *   2. a contract touching src/ runs `build-server`, because `typecheck` does not
 *      read tsconfig.server.json;
 *   3. the goal's limit counts the string the parser counts;
 *   4. the exit codes of `send` and of launch-worker.mjs are documented apart.
 *
 * Every file written here is under os.tmpdir().
 *
 * @vitest-environment node
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  DEFAULT_GATES,
  MAX_GOAL_LENGTH,
  buildContract,
  contractYaml,
  normalizeConfig,
  touchesServerBuild,
  writeContract,
} from '../../../../scripts/orchestrate/contract.mjs';
import {
  EXIT_AUTO_YES_UNCONFIRMED,
  EXIT_MODEL_MISMATCH,
  EXIT_MODEL_UNKNOWN,
  EXIT_NOT_DELIVERED,
  EXIT_PERMISSION_ASK,
  EXIT_ROLE_CHANGED,
  EXIT_ROLE_CONFLICT,
  EXIT_ROLE_NOT_SENT,
  EXIT_STOP_UNCONFIRMED,
} from '../../../../scripts/orchestrate/launch-worker.mjs';
import { RoleExitCode } from '@/cli/types';
import { parseTaskContract } from '@/lib/tasks/contract-parser';
import { ScopeMatcher } from '@/lib/verification/scope-gate';

const ROOT = path.resolve(__dirname, '../../../..');
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf-8');
const runbook = read('.claude/commands/orchestrate.md');

const base = {
  issue: 4135,
  title: 't',
  kind: 'bug',
  agent: 'claude',
  model: 'opus',
  scope: ['scripts/orchestrate/**'],
};

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('1: a permission that says "if CI passes" (6-2)', () => {
  const start = runbook.indexOf('### 6-2.');
  const section = runbook.slice(start, runbook.indexOf('### 6-3.', start));

  it('the runbook gives every PR of such a run --last and says what passing means', () => {
    const rule = section.split('\n').find((line) => line.includes('「CI が通れば」')) ?? '';
    expect(rule).toContain('`--last`');
    expect(rule).toContain('`pass` か `skipping`');
    expect(rule).toContain('`pending`');
  });
});

describe('2: build-server when a contract touches src/', () => {
  const gatesOf = (config: Record<string, unknown>) => buildContract(normalizeConfig({ ...base, ...config })).verify.gates;

  it('is in the default gates of a contract whose scope reaches the server build', () => {
    for (const scope of ['src/lib/x/**', 'server.ts', 'tsconfig.server.json', 'tsconfig.base.json']) {
      expect(touchesServerBuild([scope]), scope).toBe(true);
      expect(gatesOf({ scope: [scope] }), scope).toEqual(['lint', 'typecheck', 'build-server', 'unit-related']);
    }
  });

  it('leaves everything else as it was: other scopes, a list written out, the shared default', () => {
    expect(DEFAULT_GATES).toEqual(['lint', 'typecheck', 'unit-related']);
    for (const scope of ['scripts/orchestrate/**', 'tests/unit/src/**', 'docs/**']) {
      expect(touchesServerBuild([scope]), scope).toBe(false);
      expect(gatesOf({ scope: [scope] }), scope).toEqual(DEFAULT_GATES);
    }
    expect(gatesOf({ scope: ['src/lib/x/**'], gates: ['lint', 'unit'] })).toEqual(['lint', 'unit']);
  });

  describe('reads a scope the way the scope gate does (scope-gate-glob.ts)', () => {
    const PROBES = [
      'src/x.ts',
      'src/x.tsx',
      'src/x.md',
      'src/lib/x.ts',
      'src/lib/new/a.ts',
      'src/lib/a/index.ts',
      'server.ts',
      'tsconfig.server.json',
      'tsconfig.base.json',
    ];
    const admittedByScopeGate = (pattern: string) =>
      PROBES.some((probe) => new ScopeMatcher({ allow: [pattern], deny: [] }).classify(probe).admitted);

    it.each([
      'src',
      'src/',
      'src/**',
      'src/lib',
      'src/lib/new/**',
      'src/**/*.ts',
      'src/lib/*/index.ts',
      '**',
      '**/*.ts',
      '**/*.md',
      '*',
      's*',
      's*/**',
      '?rc/**',
      '{src,docs}/**',
      '{docs,{tests,src}}/**',
      '*.ts',
      '*.json',
      '{server,foo}.ts',
      'server.ts',
      'tsconfig.server.json',
    ])('%s reaches it', (pattern) => {
      expect(admittedByScopeGate(pattern)).toBe(true);
      expect(touchesServerBuild([pattern])).toBe(true);
    });

    it.each([
      'docs',
      'docs/**',
      'scripts/**',
      'tests/**/*.ts',
      'tests/unit/src/**',
      '{tests,docs}/**',
      '*.md',
      'srcs/**',
      'sr',
      'server.tsx',
      'server.ts/x',
      '{src/**',
      'x/**/*.ts',
    ])('%s does not', (pattern) => {
      expect(admittedByScopeGate(pattern)).toBe(false);
      expect(touchesServerBuild([pattern])).toBe(false);
    });

    it('stays bounded on a pattern with very many alternatives', () => {
      expect(touchesServerBuild(['{a,b}'.repeat(40)])).toBe(true);
    });
  });

  describe('a worktree whose verify.yaml has no build-server (POST /tasks would answer unknown gate)', () => {
    /** Generate from a config in a temp worktree, through the same path `generate --worktree` takes. */
    function generated(verifyYaml: string | null, config: Record<string, unknown> = {}) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-gates-4135-'));
      tmpDirs.push(dir);
      if (verifyYaml !== null) {
        fs.mkdirSync(path.join(dir, '.commandmate'), { recursive: true });
        fs.writeFileSync(path.join(dir, '.commandmate', 'verify.yaml'), verifyYaml);
      }
      const configFile = path.join(dir, 'config.yaml');
      fs.writeFileSync(configFile, JSON.stringify({ ...base, scope: ['src/lib/x/**'], ...config }));
      const written = writeContract({ configFile, worktree: dir });
      return (parseYaml(fs.readFileSync(written.path, 'utf-8')) as { verify: { gates: string[] } }).verify.gates;
    }
    const WITH = 'version: 1\ngates:\n  - id: lint\n    command: "true"\n  - id: build-server\n    command: "true"\n';
    const WITHOUT = 'version: 1\ngates:\n  - id: lint\n    command: "true"\n';

    it('adds it when that worktree declares it', () => {
      expect(generated(WITH)).toEqual(['lint', 'typecheck', 'build-server', 'unit-related']);
    });

    it.each([
      ['does not declare it', WITHOUT],
      ['has no verify.yaml', null],
      ['has one that does not parse', ':\n  - [unbalanced'],
      ['has one without gates', 'version: 1\n'],
    ])('keeps the default when it %s', (_name, yaml) => {
      expect(generated(yaml)).toEqual(DEFAULT_GATES);
    });

    it('leaves a list written out as written, either way', () => {
      expect(generated(WITHOUT, { gates: ['lint', 'build-server'] })).toEqual(['lint', 'build-server']);
      expect(generated(WITH, { gates: ['lint'] })).toEqual(['lint']);
    });

    it('generate --stdout --worktree reads that worktree too', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-gates-4135-'));
      tmpDirs.push(dir);
      const configFile = path.join(dir, 'config.yaml');
      fs.writeFileSync(configFile, JSON.stringify({ ...base, scope: ['src/lib/x/**'] }));
      const result = spawnSync(
        process.execPath,
        [path.join(ROOT, 'scripts/orchestrate/contract.mjs'), 'generate', '--config', configFile, '--worktree', dir, '--stdout'],
        { encoding: 'utf-8' }
      );
      expect(result.status, result.stderr).toBe(0);
      expect((parseYaml(result.stdout) as { verify: { gates: string[] } }).verify.gates).toEqual(DEFAULT_GATES);
    });
  });

  it('is a gate verify.yaml declares, running the build that reads tsconfig.server.json', () => {
    const verify = parseYaml(read('.commandmate/verify.yaml')) as { gates: Array<{ id: string; command: string }> };
    expect(verify.gates.find((gate) => gate.id === 'build-server')?.command).toBe('npm run build:server');
    expect(read('package.json')).toContain('"build:server": "tsc --project tsconfig.server.json');
  });

  it('the runbook\'s config example asks for it, since a list written out stays as written', () => {
    expect(runbook).toContain('gates: [lint, typecheck, build-server, unit-related]');
  });

  /** tsc over one file in a temp dir, with the options of a repository tsconfig. */
  function tscWith(tsconfig: string, source: string): { status: number | null; output: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-build-4135-'));
    tmpDirs.push(dir);
    fs.writeFileSync(path.join(dir, 'probe.ts'), source);
    fs.writeFileSync(
      path.join(dir, 'tsconfig.json'),
      JSON.stringify({
        extends: path.join(ROOT, tsconfig),
        compilerOptions: { noEmit: true, incremental: false, declaration: false, rootDir: dir, plugins: [], types: [] },
        include: [path.join(dir, 'probe.ts')],
        exclude: [],
      })
    );
    const result = spawnSync(process.execPath, [path.join(ROOT, 'node_modules/typescript/bin/tsc'), '-p', dir], { encoding: 'utf-8' });
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  }

  it('positive control: code only tsconfig.server.json rejects passes `typecheck` and fails `build-server`', { timeout: 120_000 }, () => {
    const source = "export const ok: boolean = 'x'.isWellFormed();\n";
    expect(tscWith('tsconfig.json', source).status).toBe(0);
    const server = tscWith('tsconfig.server.json', source);
    expect(server.status, server.output).not.toBe(0);
    expect(server.output).toContain('isWellFormed');
  });

  it('negative control: code both read passes under tsconfig.server.json', { timeout: 120_000 }, () => {
    const server = tscWith('tsconfig.server.json', "export const ok: boolean = 'x'.startsWith('x');\n");
    expect(server.status, server.output).toBe(0);
  });
});

describe('3: the goal limit counts what the parser counts', () => {
  /** A config whose goal comes out at exactly `length` characters. */
  function configOfLength(length: number) {
    const probe = buildContract(normalizeConfig({ ...base, issueBody: 'あ' })).goal.trimEnd().length;
    return normalizeConfig({ ...base, issueBody: 'あ'.repeat(length - probe + 1) });
  }

  it.each([MAX_GOAL_LENGTH - 1, MAX_GOAL_LENGTH])(
    'generates %i characters, and the YAML decodes to a goal the real parser accepts',
    (length) => {
      const yaml = contractYaml(configOfLength(length));
      const decoded = parseYaml(yaml) as { goal: string };
      expect(decoded.goal).toHaveLength(length);
      expect(parseTaskContract(yaml, 'contract').goal).toHaveLength(length);
    }
  );

  it('fails generation at 8001 characters, as the parser would', () => {
    expect(() => contractYaml(configOfLength(MAX_GOAL_LENGTH + 1))).toThrow(/8001 characters exceeds 8000/);
    const atLimit = parseYaml(contractYaml(configOfLength(MAX_GOAL_LENGTH))) as Record<string, unknown>;
    expect(() => parseTaskContract(JSON.stringify({ ...atLimit, goal: `${atLimit.goal}\n` }), 'contract')).toThrow(
      /goal: at most 8000 characters \(got 8001\)/
    );
  });

  it('keeps the goal text of a contract the same but for the final newline', () => {
    const goal = buildContract(normalizeConfig(base)).goal;
    expect(goal.endsWith('\n')).toBe(false);
    expect(goal.endsWith('すべて終わったら、最後に `IMPL_COMPLETED` とだけ出力する。')).toBe(true);
    expect(parseTaskContract(contractYaml(normalizeConfig(base)), 'contract').goal).toBe(goal);
  });
});

describe('4: exit codes of send and of launch-worker.mjs (workers.md)', () => {
  const workers = read('docs/orchestrate/workers.md');
  const HEADING = '## 3-1 send とワーカーの起動の exit code';
  const start = workers.indexOf(HEADING);
  const section = workers.slice(start, workers.indexOf('\n## ', start + 1));
  const sendPart = section.slice(section.indexOf('### `send`'), section.indexOf('### `launch-worker.mjs send`'));
  const launchPart = section.slice(section.indexOf('### `launch-worker.mjs send`'));
  /** The table row of a code, from one part only. */
  const row = (part: string, code: number) => part.split('\n').find((line) => line.startsWith(`| ${code} |`)) ?? '';

  it('has a section with a part for each', () => {
    expect(start).toBeGreaterThan(-1);
    expect(sendPart).not.toBe('');
    expect(launchPart).not.toBe('');
  });

  it('send: the numbers are the CLI\'s own', () => {
    expect(EXIT_ROLE_CONFLICT).toBe(RoleExitCode.CONFLICT);
    expect(EXIT_ROLE_NOT_SENT).toBe(RoleExitCode.NOT_SENT);
    expect(row(sendPart, EXIT_ROLE_CONFLICT)).toContain('`RoleExitCode.CONFLICT`');
    // send.ts createContractTaskWithRole: saved, then the answer shows another tool, then 31.
    expect(row(sendPart, EXIT_ROLE_CONFLICT)).toContain('`roleSettings.saved: true`');
    expect(row(sendPart, EXIT_ROLE_CONFLICT)).not.toContain('何も変えず');
    expect(row(sendPart, EXIT_ROLE_NOT_SENT)).toContain('`RoleExitCode.NOT_SENT`');
    expect(row(sendPart, EXIT_NOT_DELIVERED)).toContain('exit-codes.md');
  });

  it.each([
    [EXIT_MODEL_MISMATCH, 'EXIT_MODEL_MISMATCH', []],
    [EXIT_MODEL_UNKNOWN, 'EXIT_MODEL_UNKNOWN', []],
    [EXIT_STOP_UNCONFIRMED, 'EXIT_STOP_UNCONFIRMED', ['stop UNCONFIRMED']],
    [EXIT_AUTO_YES_UNCONFIRMED, 'EXIT_AUTO_YES_UNCONFIRMED', ['auto-yes UNCONFIRMED', 'ロール']],
    [EXIT_ROLE_CHANGED, 'EXIT_ROLE_CHANGED', ['send の 32']],
    [EXIT_ROLE_CONFLICT, 'EXIT_ROLE_CONFLICT', ['send の 31']],
    [EXIT_ROLE_NOT_SENT, 'EXIT_ROLE_NOT_SENT', ['`--model -`']],
  ] as Array<[number, string, string[]]>)('launch-worker: %i is %s, with its meaning', (code, name, words) => {
    const line = row(launchPart, code);
    expect(line).toContain(`\`${name}\``);
    for (const word of words) expect(line).toContain(word);
    expect(fs.readFileSync(path.join(ROOT, 'scripts/orchestrate/launch-worker.mjs'), 'utf-8')).toContain(`export const ${name} = ${code};`);
  });

  // Issue #4238: Command Code's permissions default `ask` stops the send.
  it('launch-worker: 45 is EXIT_PERMISSION_ASK, apart from 40〜44, with its meaning', () => {
    const line = row(launchPart, EXIT_PERMISSION_ASK);
    expect(line).toContain('`EXIT_PERMISSION_ASK`');
    expect(line).toContain('permissions.defaultMode');
    expect(line).toContain('何も送っていない');
    expect([40, 41, 42, 43, 44]).not.toContain(EXIT_PERMISSION_ASK);
    expect(fs.readFileSync(path.join(ROOT, 'scripts/orchestrate/launch-worker.mjs'), 'utf-8')).toContain(`export const EXIT_PERMISSION_ASK = ${EXIT_PERMISSION_ASK};`);
  });

  it('says the direct send returns send\'s code', () => {
    expect(launchPart).toContain('`--model -`');
    expect(launchPart).toContain('そのまま返す');
  });

  it('the runbook points there in one line and no longer stops at 43', () => {
    const pointers = runbook.split('\n').filter((line) => line.includes('docs/orchestrate/workers.md#3-1-send-とワーカーの起動の-exit-code'));
    expect(pointers).toHaveLength(1);
    for (const code of ['31', '32', '43', '44']) expect(pointers[0]).toContain(code);
    expect(runbook).not.toContain('exit 40〜43 は下の');
  });
});
