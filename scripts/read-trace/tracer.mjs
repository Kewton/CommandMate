/**
 * Read tracer for the B2 measurement (Issue #4432 PR3).
 *
 * Measurement only: nothing here is read by any gate (run-related-unit-tests,
 * precheck, merge-pr, wait-verify). tests/setup.ts imports this file only when
 * CM_TRACE_REPO_READS is set; without it this module is never loaded.
 *
 * What it records, per test file (design §2.3.3):
 *   - M4: every function of `fs` and `fs/promises` is wrapped (not a list of
 *     read APIs), including function-valued properties such as
 *     `realpathSync.native`. The first argument is recorded as a path; the
 *     second only for the two-path operations (copyFile / cp / rename / link /
 *     symlink), so written contents and encodings never reach the table.
 *     Writes and failed lookups are recorded too (M8) — the table
 *     over-selects, never under-selects.
 *   - Paths outside the repository are not written out; only their count
 *     (`outsideCount`) is, so no `$HOME` path reaches the public artifact.
 *   - Known hole (M3): a dependency that copied `fs` functions before setup ran
 *     (e.g. @nodelib/fs.scandir's adapter) bypasses the wrapper. See the design
 *     doc §2.3.3.
 *   - M2: `module.syncBuiltinESMExports()` after wrapping, so ESM named imports
 *     (`import { readFileSync } from 'node:fs'`) see the wrapper.
 *   - M5: every `child_process` launch is recorded and makes the file opaque.
 *     (Conservative: the reply-from-child protocol is not built; a file that
 *     starts any child is always selected.)
 *   - M6: constructing a `worker_threads.Worker` makes the file opaque.
 *   - M12: reads made by tests/setup.ts before beginFile() are not attributed.
 *
 * Install is idempotent per process (state lives on the fs module object, which
 * survives vitest's per-file module reset), and uninstall restores the exact
 * original functions (===).
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import childProcess from 'node:child_process';
import workerThreads from 'node:worker_threads';
import crypto from 'node:crypto';
import nodeModule from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TRACE_VERSION = 1;
export const STATE_KEY = Symbol.for('commandmate.readTrace.state');
export const ORIGINAL_KEY = Symbol.for('commandmate.readTrace.original');

const CHILD_FUNCTIONS = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'];
const SKIP_PROPS = new Set(['length', 'name', 'prototype', 'arguments', 'caller']);

/** Operations whose second argument is also a path (the destination). */
const TWO_PATH = /^(copyFile|copyFileSync|cp|cpSync|rename|renameSync|link|linkSync|symlink|symlinkSync)$/;

/** Turns a path-like argument into an absolute path, or null. */
export function toPathString(value, cwd) {
  try {
    if (typeof value === 'string') return path.resolve(cwd, value);
    if (value instanceof URL) return value.protocol === 'file:' ? fileURLToPath(value) : null;
    if (Buffer.isBuffer(value)) return path.resolve(cwd, value.toString('utf8'));
  } catch {
    return null;
  }
  return null;
}

function isPlainFunctionName(name, value) {
  // Classes (Stats, ReadStream, Dirent, ...) start with an upper-case letter and
  // are constructors, not path operations; leave them alone.
  return typeof value === 'function' && /^[a-z]/.test(name);
}

function makeWrapper(original, onCall, wrapMember = null) {
  const wrapper = function tracedFsFunction(...args) {
    onCall(args);
    return original.apply(this, args);
  };
  for (const key of Reflect.ownKeys(original)) {
    if (typeof key === 'string' && SKIP_PROPS.has(key)) continue;
    try {
      const desc = Object.getOwnPropertyDescriptor(original, key);
      // P3-6: `realpathSync.native` and friends are path operations too.
      if (wrapMember && typeof key === 'string' && desc && 'value' in desc && isPlainFunctionName(key, desc.value)) {
        desc.value = wrapMember(key, desc.value);
      }
      Object.defineProperty(wrapper, key, desc);
    } catch {
      // A non-configurable own property cannot be copied; not one fs uses.
    }
  }
  Object.defineProperty(wrapper, ORIGINAL_KEY, { value: original });
  Object.defineProperty(wrapper, 'name', { value: original.name, configurable: true });
  return wrapper;
}

/**
 * @param {{
 *   outDir: string,
 *   repoRoot: string,
 *   modules?: { fs: object, fsp: object, childProcess: object, workerThreads: object },
 *   syncEsm?: () => void,
 * }} options
 */
export function installReadTracer(options) {
  const mods = options.modules ?? { fs, fsp, childProcess, workerThreads };
  const syncEsm = options.syncEsm ?? (() => nodeModule.syncBuiltinESMExports());
  const existing = mods.fs[STATE_KEY];
  if (existing) return existing.api;

  const originals = []; // [target, name, original]
  const origWrite = mods.fs.writeFileSync;
  const origMkdir = mods.fs.mkdirSync;
  const repoRoot = path.resolve(options.repoRoot);
  let current = null;
  let counter = 0;

  const recordPath = (op, value) => {
    if (!current) return;
    const abs = toPathString(value, process.cwd());
    if (abs === null) return;
    const ops = current.reads.get(abs) ?? new Set();
    ops.add(op);
    current.reads.set(abs, ops);
  };

  const wrapTarget = (target, prefix) => {
    for (const name of Object.keys(target)) {
      const value = target[name];
      if (!isPlainFunctionName(name, value) || value[ORIGINAL_KEY]) continue;
      const op = `${prefix}${name}`;
      const onCall = (memberOp, twoPath) => (args) => {
        recordPath(memberOp, args[0]);
        if (twoPath) recordPath(memberOp, args[1]);
      };
      target[name] = makeWrapper(value, onCall(op, TWO_PATH.test(name)), (member, fn) =>
        makeWrapper(fn, onCall(`${op}.${member}`, false))
      );
      originals.push([target, name, value]);
    }
  };

  wrapTarget(mods.fs, 'fs.');
  wrapTarget(mods.fsp, 'fsp.');

  for (const name of CHILD_FUNCTIONS) {
    const value = mods.childProcess[name];
    if (typeof value !== 'function' || value[ORIGINAL_KEY]) continue;
    mods.childProcess[name] = makeWrapper(value, (args) => {
      if (!current) return;
      // Only the program's base name: an absolute path may sit under $HOME.
      const command = typeof args[0] === 'string' ? path.basename(args[0]) : typeof args[0];
      current.children.push({ fn: name, command });
    });
    originals.push([mods.childProcess, name, value]);
  }

  const OrigWorker = mods.workerThreads.Worker;
  if (typeof OrigWorker === 'function' && !OrigWorker[ORIGINAL_KEY]) {
    const TracedWorker = class extends OrigWorker {
      constructor(...args) {
        if (current) current.workers += 1;
        super(...args);
      }
    };
    Object.defineProperty(TracedWorker, ORIGINAL_KEY, { value: OrigWorker });
    mods.workerThreads.Worker = TracedWorker;
    originals.push([mods.workerThreads, 'Worker', OrigWorker]);
  }

  syncEsm();

  const toRecord = () => {
    const reads = {};
    let outsideCount = 0;
    for (const [abs, ops] of [...current.reads.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const rel = path.relative(repoRoot, abs).split(path.sep).join('/');
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        outsideCount += 1;
        continue;
      }
      if (rel === 'node_modules' || rel.startsWith('node_modules/') || rel === '.git' || rel.startsWith('.git/')) continue;
      reads[rel === '' ? '.' : rel] = [...ops].sort();
    }
    return {
      version: TRACE_VERSION,
      testPath: current.testPath,
      pid: process.pid,
      reads,
      outsideCount,
      children: current.children,
      workers: current.workers,
    };
  };

  const api = {
    beginFile(testPath) {
      let rel = testPath
        ? path.relative(repoRoot, path.resolve(testPath)).split(path.sep).join('/')
        : null;
      if (rel !== null && (rel.startsWith('..') || path.isAbsolute(rel))) rel = 'outside';
      current = { testPath: rel, reads: new Map(), children: [], workers: 0 };
    },
    /** Returns the record of the current file without writing it. */
    snapshot() {
      return current ? toRecord() : null;
    },
    /** Writes the current file's record into outDir and stops attributing. */
    endFile() {
      if (!current) return null;
      const record = toRecord();
      current = null;
      counter += 1;
      origMkdir(options.outDir, { recursive: true });
      const file = path.join(options.outDir, `trace-${process.pid}-${workerThreads.threadId}-${counter}-${crypto.randomUUID()}.json`);
      origWrite(file, JSON.stringify(record));
      return file;
    },
    uninstall() {
      current = null;
      for (const [target, name, original] of originals.reverse()) target[name] = original;
      delete mods.fs[STATE_KEY];
      syncEsm();
    },
  };

  Object.defineProperty(mods.fs, STATE_KEY, { value: { api }, configurable: true });
  return api;
}
