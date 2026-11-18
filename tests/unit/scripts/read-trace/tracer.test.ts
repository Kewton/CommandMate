/**
 * Tests for scripts/read-trace/tracer.mjs (Issue #4432 PR3, design §2.3.3).
 *
 * @vitest-environment node
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  installReadTracer,
  ORIGINAL_KEY,
  STATE_KEY,
  toPathString,
} from '../../../../scripts/read-trace/tracer.mjs';

type AnyFn = (...args: unknown[]) => unknown;

function fakeModules() {
  const calls: string[] = [];
  const fakeFs: Record<string | symbol, unknown> = {
    readFileSync: (p: unknown) => {
      calls.push(`readFileSync:${String(p)}`);
      return 'x';
    },
    copyFileSync: (a: unknown, b: unknown) => {
      calls.push(`copyFileSync:${String(a)}:${String(b)}`);
    },
    readdirSync: () => [],
    writeFileSync: (p: unknown, data: unknown) => {
      calls.push(`writeFileSync:${String(p)}:${String(data).length}`);
    },
    mkdirSync: () => undefined,
    Stats: class Stats {},
  };
  const fakeFsp: Record<string, unknown> = { readFile: async () => 'y' };
  const fakeCp: Record<string, unknown> = {
    spawnSync: () => ({ status: 0 }),
    execFileSync: () => '',
  };
  class FakeWorker {
    constructor(public file: string) {}
  }
  const fakeWt: Record<string, unknown> = { Worker: FakeWorker };
  return { calls, modules: { fs: fakeFs, fsp: fakeFsp, childProcess: fakeCp, workerThreads: fakeWt } };
}

describe('read tracer on injected modules', () => {
  it('wraps every lower-case fs / fs.promises function and restores the exact originals', () => {
    const { modules } = fakeModules();
    const before = { ...modules.fs } as Record<string, unknown>;
    const beforeFsp = { ...modules.fsp };
    const beforeCp = { ...modules.childProcess };
    const beforeWorker = modules.workerThreads.Worker;
    let synced = 0;
    const tracer = installReadTracer({ outDir: '/nowhere', repoRoot: '/repo', modules, syncEsm: () => (synced += 1) });

    expect(modules.fs.readFileSync).not.toBe(before.readFileSync);
    expect(modules.fs.copyFileSync).not.toBe(before.copyFileSync);
    expect(modules.fsp.readFile).not.toBe(beforeFsp.readFile);
    expect(modules.childProcess.spawnSync).not.toBe(beforeCp.spawnSync);
    expect(modules.workerThreads.Worker).not.toBe(beforeWorker);
    // Classes are not path operations.
    expect(modules.fs.Stats).toBe(before.Stats);
    // M2: ESM named exports re-synced after wrapping.
    expect(synced).toBe(1);

    tracer.uninstall();
    for (const name of Object.keys(before)) expect(modules.fs[name]).toBe(before[name]);
    expect(modules.fsp.readFile).toBe(beforeFsp.readFile);
    expect(modules.childProcess.spawnSync).toBe(beforeCp.spawnSync);
    expect(modules.childProcess.execFileSync).toBe(beforeCp.execFileSync);
    expect(modules.workerThreads.Worker).toBe(beforeWorker);
    expect(modules.fs[STATE_KEY]).toBeUndefined();
    expect(synced).toBe(2);
  });

  it('is idempotent: a second install in the same process returns the same tracer and wraps nothing twice', () => {
    const { modules } = fakeModules();
    const a = installReadTracer({ outDir: '/nowhere', repoRoot: '/repo', modules, syncEsm: () => undefined });
    const wrapped = modules.fs.readFileSync;
    const b = installReadTracer({ outDir: '/nowhere', repoRoot: '/repo', modules, syncEsm: () => undefined });
    expect(b).toBe(a);
    expect(modules.fs.readFileSync).toBe(wrapped);
    a.uninstall();
  });

  it('records both paths of two-path operations, children and workers, relative to the repo', () => {
    const { modules, calls } = fakeModules();
    const tracer = installReadTracer({ outDir: '/nowhere', repoRoot: '/repo', modules, syncEsm: () => undefined });
    tracer.beginFile('/repo/tests/unit/a.test.ts');
    (modules.fs.readFileSync as AnyFn)('/repo/docs/a.md');
    (modules.fs.copyFileSync as AnyFn)('/repo/locales/en/common.json', '/elsewhere/out.json');
    (modules.fs.readdirSync as AnyFn)('/repo');
    (modules.fs.readFileSync as AnyFn)('/repo/node_modules/x/index.js');
    (modules.childProcess.spawnSync as AnyFn)('git', ['status']);
    new (modules.workerThreads.Worker as new (f: string) => unknown)('w.js');
    const record = tracer.snapshot();
    tracer.uninstall();

    // The wrapped call still reached the original.
    expect(calls).toContain('readFileSync:/repo/docs/a.md');
    expect(record?.testPath).toBe('tests/unit/a.test.ts');
    expect(record?.reads).toEqual({
      '.': ['fs.readdirSync'],
      'docs/a.md': ['fs.readFileSync'],
      'locales/en/common.json': ['fs.copyFileSync'],
    });
    expect(record?.children).toEqual([{ fn: 'spawnSync', command: 'git' }]);
    expect(record?.workers).toBe(1);
  });

  it('attributes nothing before beginFile (M12) or after endFile', () => {
    const { modules } = fakeModules();
    const outDir = '/trace-out';
    const tracer = installReadTracer({ outDir, repoRoot: '/repo', modules, syncEsm: () => undefined });
    (modules.fs.readFileSync as AnyFn)('/repo/tests/setup-read.md');
    expect(tracer.snapshot()).toBeNull();
    tracer.beginFile('/repo/tests/unit/b.test.ts');
    (modules.fs.readFileSync as AnyFn)('/repo/docs/b.md');
    const file = tracer.endFile();
    (modules.fs.readFileSync as AnyFn)('/repo/docs/after.md');
    expect(tracer.snapshot()).toBeNull();
    tracer.uninstall();
    expect(file).toMatch(/^\/trace-out\/trace-\d+-\d+-1\.json$/);
  });
});

describe('read tracer on the real fs module', () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it.skipIf(Boolean(process.env.CM_TRACE_REPO_READS))(
    'records a real read and a failed lookup (M8), writes the record, and uninstall restores === originals',
    async () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-trace-'));
      const repo = path.join(dir, 'repo');
      fs.mkdirSync(path.join(repo, 'docs'), { recursive: true });
      fs.writeFileSync(path.join(repo, 'docs', 'x.md'), '# x');
      const outDir = path.join(dir, 'out');
      const originalRead = fs.readFileSync;
      const originalExists = fs.existsSync;
      const originalPromisesRead = fsp.readFile;

      const tracer = installReadTracer({ outDir, repoRoot: repo });
      let written: string | null = null;
      try {
        tracer.beginFile(path.join(repo, 'tests', 'unit', 'x.test.ts'));
        expect(fs.readFileSync(path.join(repo, 'docs', 'x.md'), 'utf8')).toBe('# x');
        expect(fs.existsSync(path.join(repo, 'docs', 'missing.md'))).toBe(false);
        await fsp.readFile(path.join(repo, 'docs', 'x.md'), 'utf8');
        written = tracer.endFile();
      } finally {
        tracer.uninstall();
      }

      expect(fs.readFileSync).toBe(originalRead);
      expect(fs.existsSync).toBe(originalExists);
      expect(fsp.readFile).toBe(originalPromisesRead);
      expect(written).not.toBeNull();
      const record = JSON.parse(fs.readFileSync(written as string, 'utf8'));
      expect(record.testPath).toBe('tests/unit/x.test.ts');
      expect(record.reads['docs/x.md']).toEqual(['fs.readFileSync', 'fsp.readFile']);
      expect(record.reads['docs/missing.md']).toEqual(['fs.existsSync']);
    }
  );
});

describe('toPathString', () => {
  it('accepts strings, file URLs and Buffers, and ignores fds and other URLs', () => {
    expect(toPathString('a/b', '/cwd')).toBe('/cwd/a/b');
    expect(toPathString(new URL('file:///x/y'), '/cwd')).toBe('/x/y');
    expect(toPathString(Buffer.from('/z'), '/cwd')).toBe('/z');
    expect(toPathString(3, '/cwd')).toBeNull();
    expect(toPathString(new URL('https://example.com/'), '/cwd')).toBeNull();
  });

  it('marks wrappers so an unwrapped function can be told apart', () => {
    expect((fs.readFileSync as unknown as Record<symbol, unknown>)[ORIGINAL_KEY] === undefined).toBe(
      !process.env.CM_TRACE_REPO_READS
    );
  });
});
