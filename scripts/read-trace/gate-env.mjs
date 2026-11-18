#!/usr/bin/env node
/**
 * gate-env for the B2 measurement (Issue #4432 PR3, design §2.3.3 M10).
 *
 * The table is "what each test read when the whole suite ran here". A branch in
 * a test that depends on something outside the tree (node version, which tools
 * are on PATH, CI, the lockfile) can make the verify side read different files,
 * so a table is only counted as a hit when its gate-env equals the verify
 * side's. Any difference — or a missing field on either side — is a miss
 * (fail-closed, "不透明").
 *
 * Measurement only: no gate reads this.
 *
 * Usage: node scripts/read-trace/gate-env.mjs [--root <repo>]   (prints JSON)
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const GATE_ENV_VERSION = 1;
/** Tools whose presence on PATH changes which branch some tests take. */
export const GATE_ENV_TOOLS = ['bash', 'gh', 'git', 'python3', 'rg', 'shellcheck', 'sqlite3', 'tmux'];
export const GATE_ENV_FIELDS = ['version', 'node', 'platform', 'arch', 'ci', 'lockfileHash', 'tools'];

function onPath(tool, envPath, exists) {
  for (const dir of (envPath ?? '').split(path.delimiter)) {
    if (dir && exists(path.join(dir, tool))) return true;
  }
  return false;
}

/**
 * @param {{
 *   root: string,
 *   env?: Record<string, string | undefined>,
 *   nodeVersion?: string, platform?: string, arch?: string,
 *   readFile?: (p: string) => Buffer, exists?: (p: string) => boolean,
 * }} options
 */
export function collectGateEnv(options) {
  const env = options.env ?? process.env;
  const readFile = options.readFile ?? ((p) => fs.readFileSync(p));
  const exists = options.exists ?? ((p) => fs.existsSync(p));
  let lockfileHash = 'missing';
  try {
    lockfileHash = crypto.createHash('sha256').update(readFile(path.join(options.root, 'package-lock.json'))).digest('hex');
  } catch {
    lockfileHash = 'missing';
  }
  const tools = {};
  for (const tool of GATE_ENV_TOOLS) tools[tool] = onPath(tool, env.PATH, exists);
  return {
    version: GATE_ENV_VERSION,
    node: options.nodeVersion ?? process.version,
    platform: options.platform ?? process.platform,
    arch: options.arch ?? process.arch,
    ci: env.CI === 'true',
    lockfileHash,
    tools,
  };
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Compares two gate-envs. Fail-closed: a missing or non-object side, or any
 * missing field, is a difference.
 *
 * @returns {{ same: boolean, diffs: string[] }}
 */
export function compareGateEnv(a, b) {
  if (!a || typeof a !== 'object' || !b || typeof b !== 'object') {
    return { same: false, diffs: ['missing'] };
  }
  const diffs = [];
  for (const field of GATE_ENV_FIELDS) {
    if (!(field in a) || !(field in b)) {
      diffs.push(field);
      continue;
    }
    if (canonical(a[field]) !== canonical(b[field])) diffs.push(field);
  }
  return { same: diffs.length === 0, diffs };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--root');
  const root = i >= 0 ? process.argv[i + 1] : process.cwd();
  process.stdout.write(`${JSON.stringify(collectGateEnv({ root }), null, 2)}\n`);
}
