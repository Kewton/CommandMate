/**
 * resource-config.mjs: the reader of `resource.yaml` (Issue #4370 PR1a, docs/design/resource-4370.md
 * §2.7・§9.2 rows A1〜A4). Every file is written under a fresh os.tmpdir() directory, removed after.
 *
 * @vitest-environment node
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadResourceConfig, resourceConfigPath } from '../../../../scripts/orchestrate/resource-config.mjs';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-resource-config-4370-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function write(text: string): string {
  const file = path.join(dir, 'resource.yaml');
  fs.writeFileSync(file, text);
  return file;
}
const absent = () => path.join(dir, 'absent.yaml');

describe('A1: the defaults keep C ≥ 1 on any CPU count; the example values do not fit small machines', () => {
  it.each([
    [4, 1, 1, 0],
    [8, 3, 1, 2],
    [28, 11, 7, 4],
  ])('no file, ncpu %i → S %i, C %i, cpu_heavy %i', (ncpu, S, C, cpuHeavy) => {
    const viaAuto = loadResourceConfig({ path: absent(), availableParallelism: () => ncpu });
    const viaKey = loadResourceConfig({ path: write(`ncpu: ${ncpu}\n`) });
    for (const config of [viaAuto, viaKey]) {
      expect(config).toMatchObject({ ncpu, S, C, cpuHeavy, ciVmCpus: 0 });
      if (!('warnings' in config)) throw new Error('expected a config');
      expect(config.warnings.some((w) => w.includes('ci_vm.cpus is not set'))).toBe(true);
      expect(config.warnings.some((w) => w.includes('weights.cpu_heavy shrank'))).toBe(cpuHeavy < 4);
    }
  });

  it.each([
    [4, 'config C=-10 (S=2 ci_vm.cpus=8 weights.cpu_heavy=4)'],
    [8, 'config C=-8 (S=4 ci_vm.cpus=8 weights.cpu_heavy=4)'],
  ])('share 0.5・ci_vm 8・cpu_heavy 4 on ncpu %i is an error', (ncpu, error) => {
    const file = write(`ncpu: ${ncpu}\ncommandmate_share: 0.5\nweights: { cpu_heavy: 4 }\nci_vm: { cpus: 8, memory_gib: 24 }\n`);
    expect(loadResourceConfig({ path: file })).toEqual({ error, path: file });
  });

  it('share 0.5・ci_vm 8・cpu_heavy 4 on ncpu 28 is C 2, without the ci_vm warning', () => {
    const config = loadResourceConfig({ path: write('ncpu: 28\ncommandmate_share: 0.5\nweights: { cpu_heavy: 4 }\nci_vm: { cpus: 8, memory_gib: 24 }\n') });
    expect(config).toMatchObject({ S: 14, C: 2, ciVmCpus: 8, cpuHeavy: 4, warnings: [] });
  });

  it('the hash follows the normalized content (defaults filled in)', () => {
    const a = loadResourceConfig({ path: write('ncpu: 8\n') });
    const b = loadResourceConfig({ path: write('ncpu: 8\ncommandmate_share: 0.4\n') });
    const c = loadResourceConfig({ path: write('ncpu: 8\ncommandmate_share: 0.5\n') });
    if (!('configHash' in a && 'configHash' in b && 'configHash' in c)) throw new Error('expected configs');
    expect(a.configHash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.configHash).toBe(b.configHash);
    expect(a.configHash).not.toBe(c.configHash);
  });
});

describe('A2: a wrong file is an error naming why, never the defaults', () => {
  it.each([
    ['broken YAML', 'ncpu: [1, 2\n', /not YAML/],
    ['version 2', 'version: 2\n', /version 2 is not 1/],
    ['share 0', 'commandmate_share: 0\n', /commandmate_share 0 is not in/],
    ['share 1.5', 'commandmate_share: 1.5\n', /commandmate_share 1.5 is not in/],
    ['load_resume 1', 'load_resume: 1\n', /load_resume 1 is not in/],
    ['load_ceiling 0', 'load_ceiling: 0\n', /load_ceiling 0 is not > 0/],
    ['ncpu 0', 'ncpu: 0\n', /ncpu 0 is not an integer/],
    ['cpu_heavy -1', 'weights: { cpu_heavy: -1 }\n', /weights.cpu_heavy -1/],
    ['ci_vm.cpus 1.5', 'ci_vm: { cpus: 1.5 }\n', /ci_vm.cpus 1.5/],
    ['a list at the top', '- 1\n', /not a mapping/],
    ['weights not a mapping', 'weights: 3\n', /weights is not a mapping/],
  ])('%s', (_label, text, reason) => {
    const config = loadResourceConfig({ path: write(text) });
    expect('error' in config && config.error).toMatch(reason);
  });

  it('explicit ci_vm.cpus that leaves no host capacity is the C < 1 error', () => {
    const config = loadResourceConfig({ path: write('ncpu: 8\nci_vm: { cpus: 3 }\n') });
    expect(config).toMatchObject({ error: 'config C=0 (S=3 ci_vm.cpus=3 weights.cpu_heavy=0)' });
  });

  it('a path that is a directory cannot be read: an error, not the defaults', () => {
    const config = loadResourceConfig({ path: dir });
    expect('error' in config && config.error).toMatch(/cannot read \(EISDIR\)/);
  });
});

describe('A3 (negative): an unknown key at the same version warns and keeps the defaults', () => {
  it('one warning, the values as the defaults', () => {
    const config = loadResourceConfig({ path: write('ncpu: 28\nfuture_key: 1\n') });
    expect(config).toMatchObject({ S: 11, C: 7 });
    if (!('warnings' in config)) throw new Error('expected a config');
    expect(config.warnings.filter((w) => w.includes('unknown key'))).toEqual(['resource: warn unknown key future_key']);
  });

  it('an empty file is the defaults', () => {
    expect(loadResourceConfig({ path: write(''), availableParallelism: () => 28 })).toMatchObject({ S: 11, C: 7 });
  });
});

describe('A4 (negative): CM_RESOURCE_CONFIG names the place; a missing file is the defaults', () => {
  it('reads the env path', () => {
    const env = { CM_RESOURCE_CONFIG: absent() };
    expect(resourceConfigPath(env)).toBe(absent());
    expect(loadResourceConfig({ env, availableParallelism: () => 8 })).toMatchObject({ S: 3, C: 1, path: absent() });
    const file = write('ncpu: 28\n');
    expect(loadResourceConfig({ env: { CM_RESOURCE_CONFIG: file } })).toMatchObject({ C: 7, path: file });
  });

  it('S8: tests/setup.ts pins it under the temp directory', () => {
    expect(process.env.CM_RESOURCE_CONFIG?.startsWith(os.tmpdir())).toBe(true);
    expect(resourceConfigPath().startsWith(os.tmpdir())).toBe(true);
  });
});
