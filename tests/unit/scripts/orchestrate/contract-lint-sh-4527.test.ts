/**
 * scripts/orchestrate/contract.mjs — a worktree whose `verify.yaml` declares
 * `lint-sh` gets that gate in every contract generated for it (Issue #4527).
 *
 * What #4433 hit: its contract wrote `gates: [lint, typecheck, build-server,
 * unit-related]`, verify run 3534 passed every declared gate, and the same
 * commit then failed the precheck and CI's shellcheck (SC1003 at
 * scripts/uat/run-server.sh:126). The gate existed in `.commandmate/verify.yaml`
 * all along (declared there since #3478); the contract simply did not name it,
 * and a written-out `gates` list runs exactly as written.
 *
 * The rule is add-only: nothing written is dropped or reordered, and a worktree
 * that does not declare `lint-sh` keeps the gates it had (negative control).
 * The gate goes right after `lint`, as everywhere else in this repository.
 *
 * Every worktree and config here is written under os.tmpdir(); nothing in the
 * repository is touched. `writeContract` is used for the three positive cases,
 * because it is the `--worktree` path the runbook takes
 * (`.claude/commands/orchestrate.md` 2-4: `--worktree "$WT_PATH"`).
 *
 * @vitest-environment node
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse as parseYaml } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_GATE_IDS, writeContract } from '../../../../scripts/orchestrate/contract.mjs';

const SCRIPT = path.resolve(__dirname, '../../../../scripts/orchestrate/contract.mjs');

const base = {
  issue: 4527,
  title: 't',
  kind: 'bug',
  agent: 'claude',
  model: 'opus',
  scope: ['scripts/orchestrate/**'],
};

const DECLARES = 'version: 1\ngates:\n  - id: lint\n    command: "true"\n  - id: lint-sh\n    command: "true"\n';
const DECLARES_NOT = 'version: 1\ngates:\n  - id: lint\n    command: "true"\n';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A worktree with (or without) the given verify.yaml, a config in it, and the gates the generator wrote. */
function generated(verifyYaml: string | null, config: Record<string, unknown> = {}): string[] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-lint-sh-4527-'));
  dirs.push(dir);
  if (verifyYaml !== null) {
    fs.mkdirSync(path.join(dir, '.commandmate'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.commandmate', 'verify.yaml'), verifyYaml);
  }
  const configFile = path.join(dir, 'config.yaml');
  fs.writeFileSync(configFile, JSON.stringify({ ...base, ...config }));
  const written = writeContract({ configFile, worktree: dir });
  return (parseYaml(fs.readFileSync(written.path, 'utf-8')) as { verify: { gates: string[] } }).verify.gates;
}

describe('a worktree declaring lint-sh gets it in the contract gates (#4527)', () => {
  it('default gates: lint-sh follows lint, the rest of the default is kept', () => {
    expect(generated(DECLARES)).toEqual(['lint', 'lint-sh', 'typecheck', 'unit-related']);
  });

  it('a gates list written out: added, nothing dropped or reordered', () => {
    expect(generated(DECLARES, { gates: ['lint', 'typecheck', 'build-server', 'unit-related'] })).toEqual([
      'lint',
      'lint-sh',
      'typecheck',
      'build-server',
      'unit-related',
    ]);
  });

  it('a refactor (the two-gate default): added too', () => {
    expect(
      generated(DECLARES, { kind: 'refactor', scope: ['src/lib/x/**'], refactor: { mergesCopies: true } })
    ).toEqual(['lint', 'lint-sh', 'typecheck']);
  });

  it('negative control: a worktree that does not declare lint-sh keeps its gates exactly as before', () => {
    expect(generated(DECLARES_NOT)).toEqual(['lint', 'typecheck', 'unit-related']);
    expect(generated(DECLARES_NOT, { gates: ['lint', 'unit'] })).toEqual(['lint', 'unit']);
    expect(generated(DECLARES_NOT, { kind: 'refactor', scope: ['src/lib/x/**'], refactor: { mergesCopies: true } })).toEqual([
      'lint',
      'typecheck',
    ]);
  });

  it('negative control: no verify.yaml at all changes nothing', () => {
    expect(generated(null)).toEqual(['lint', 'typecheck', 'unit-related']);
    expect(generated(null, { gates: ['lint', 'unit'] })).toEqual(['lint', 'unit']);
  });

  it('does not duplicate one the config already wrote', () => {
    expect(generated(DECLARES, { gates: ['lint', 'lint-sh', 'unit'] })).toEqual(['lint', 'lint-sh', 'unit']);
  });

  it('is added before the gate checks, so a full list plus it is refused rather than sent', () => {
    // 32 gates written out; the added lint-sh makes 33 and must be refused (the same bound #4135 relies on).
    const full = ['lint', ...Array.from({ length: MAX_GATE_IDS - 1 }, (_, i) => `g${i}`)];
    expect(() => generated(DECLARES, { gates: full })).toThrow(/at most 32/);
    // Negative control: the same list fits when the worktree does not declare lint-sh.
    expect(generated(DECLARES_NOT, { gates: full })).toHaveLength(MAX_GATE_IDS);
  });

  it('the CLI path the runbook takes (`generate --worktree`) adds it too', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-lint-sh-4527-'));
    dirs.push(dir);
    fs.mkdirSync(path.join(dir, '.commandmate'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.commandmate', 'verify.yaml'), DECLARES);
    const configFile = path.join(dir, 'config.yaml');
    fs.writeFileSync(configFile, JSON.stringify(base));
    const result = spawnSync(
      process.execPath,
      [SCRIPT, 'generate', '--config', configFile, '--worktree', dir, '--stdout'],
      { encoding: 'utf-8' }
    );
    expect(result.status, result.stderr).toBe(0);
    expect((parseYaml(result.stdout) as { verify: { gates: string[] } }).verify.gates).toEqual([
      'lint',
      'lint-sh',
      'typecheck',
      'unit-related',
    ]);
  });

  it('without --worktree the file output reads the cwd; --stdout does not (#4532 review P3-2)', () => {
    // The difference is documented in docs/orchestrate/contract.md 2-4: the
    // file-writing path defaults the worktree to process.cwd(), the preview has
    // no worktree at all. The runbook always passes --worktree, so neither is
    // the path a contract is sent on.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-lint-sh-4527-'));
    dirs.push(dir);
    fs.mkdirSync(path.join(dir, '.commandmate'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.commandmate', 'verify.yaml'), DECLARES);
    const configFile = path.join(dir, 'config.yaml');
    fs.writeFileSync(configFile, JSON.stringify(base));
    const outFile = path.join(dir, 'contract.yaml');

    const written = spawnSync(process.execPath, [SCRIPT, 'generate', '--config', configFile, '--out', outFile], {
      encoding: 'utf-8',
      cwd: dir,
    });
    expect(written.status, written.stderr).toBe(0);
    expect((parseYaml(fs.readFileSync(outFile, 'utf-8')) as { verify: { gates: string[] } }).verify.gates).toEqual([
      'lint',
      'lint-sh',
      'typecheck',
      'unit-related',
    ]);

    const preview = spawnSync(process.execPath, [SCRIPT, 'generate', '--config', configFile, '--stdout'], {
      encoding: 'utf-8',
      cwd: dir,
    });
    expect(preview.status, preview.stderr).toBe(0);
    expect((parseYaml(preview.stdout) as { verify: { gates: string[] } }).verify.gates).toEqual([
      'lint',
      'typecheck',
      'unit-related',
    ]);
  });
});
