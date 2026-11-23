#!/usr/bin/env node
/**
 * The role bodies in the database against their canon in this repository (Issue #4548).
 *
 *   node scripts/orchestrate/roles-sync.mjs check    [--cli <path>] [--dir <path>] [--roles a,b,...] [--json]
 *   node scripts/orchestrate/roles-sync.mjs launched --worktrees <wt>[,<wt>...] [--cli <path>] [--dir <path>] [--json]
 *
 * The canon is `docs/orchestrate/roles/<name>.md`, one file per role, the file name
 * being the role's `name`. The directory holds those files and nothing else: the
 * list of roles is {@link CANON_ROLES}, not a scan of the directory.
 *
 * `check` compares each file's sha256 (its bytes as they are: no decoding, no
 * newline normalisation — a dropped trailing `\n` or a CRLF is a difference) with
 * the `bodyFingerprint` that `<cli> roles list --json` reports (the sha256 of the
 * body's UTF-8 bytes, src/lib/agent-roles/fingerprint.ts). One call for all roles.
 *
 * `launched` asks `<cli> instances <wt> list --require-roles --json` for each
 * worktree given, and compares the body a running instance of a canon role was
 * started with (`role.launched.bodyFingerprint`) with the canon. The worktrees are
 * an argument: none is built in.
 *
 * Read only. Nothing here writes a role, a setting or an instance: there is no
 * `apply` (a role body is changed by a person, with `commandmate roles edit`).
 * The CLI is run without a shell; which server it asks is the CLI's own choice,
 * as in resolve-instance.mjs (#3633 A).
 *
 * Exit: 0 everything matches / 1 something does not (the comparison was made) /
 * 2 bad arguments / 3 the CLI could not be read (exit != 0, not JSON,
 * `success: false`) — never 0 or 1 for what could not be compared.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The roles whose canon lives in docs/orchestrate/roles. Anything else in the database is not looked at. */
export const CANON_ROLES = Object.freeze(['project-manager', 'dev-leader', 'judge', 'enabler']);

/**
 * MAX_ROLE_BODY_BYTES of src/types/agent-roles.ts (a .mjs cannot import the .ts).
 * The unit test pins the two equal.
 */
export const MAX_ROLE_BODY_BYTES = 16384;

/** How long one CLI call may take before it counts as unreadable (exit 3). */
export const SPAWN_TIMEOUT_MS = 60_000;

export const EXIT_OK = 0;
export const EXIT_MISMATCH = 1;
export const EXIT_USAGE = 2;
export const EXIT_UNREADABLE = 3;

/** The canon directory of the checkout this script is in, whatever the cwd. */
export const DEFAULT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../docs/orchestrate/roles');

const USAGE = `Usage:
  node scripts/orchestrate/roles-sync.mjs check    [--cli <path>] [--dir <path>] [--roles a,b,...] [--json]
  node scripts/orchestrate/roles-sync.mjs launched --worktrees <wt>[,<wt>...] [--cli <path>] [--dir <path>] [--json]`;

class UsageError extends Error {}
class UnreadableError extends Error {}

/** sha256 hex of a file's bytes, as they are on disk. */
export function fileFingerprint(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * The canon files of `roles` under `dir`: `{ name, fingerprint, bytes }`, both null when the file is missing.
 * @returns {Array<{ name: string, fingerprint: string | null, bytes: number | null }>}
 */
export function readCanon(dir, roles = CANON_ROLES) {
  return roles.map((name) => {
    const file = path.join(dir, `${name}.md`);
    let buf;
    try {
      buf = fs.readFileSync(file);
    } catch {
      return { name, fingerprint: null, bytes: null };
    }
    return { name, fingerprint: createHash('sha256').update(buf).digest('hex'), bytes: buf.length };
  });
}

/**
 * One state per canon file, against the rows of `roles list --json`.
 * `same` is the fingerprint comparison, injectable so a test can show a broken one goes red.
 *
 * @param {{ roles: Array<{ name: string, bodyVersion?: number, bodyFingerprint?: string, bodyBytes?: number }> }} listJson
 * @param {ReturnType<typeof readCanon>} files
 * @param {{ same?: (a: string, b: string) => boolean, maxBytes?: number }} [options]
 */
export function classifyRoles(listJson, files, { same = (a, b) => a === b, maxBytes = MAX_ROLE_BODY_BYTES } = {}) {
  const rows = Array.isArray(listJson?.roles) ? listJson.roles : [];
  return files.map((file) => {
    const matches = rows.filter((row) => row?.name === file.name);
    const row = matches.length === 1 ? matches[0] : null;
    let state;
    if (file.fingerprint === null) state = 'missing-file';
    else if (file.bytes > maxBytes) state = 'too-large';
    else if (matches.length === 0) state = 'missing-role';
    else if (matches.length > 1) state = 'ambiguous-role';
    else state = same(String(row.bodyFingerprint ?? ''), file.fingerprint) ? 'ok' : 'differs';
    return {
      name: file.name,
      state,
      bodyVersion: typeof row?.bodyVersion === 'number' ? row.bodyVersion : null,
      dbFingerprint: typeof row?.bodyFingerprint === 'string' ? row.bodyFingerprint : null,
      fileFingerprint: file.fingerprint,
      dbBytes: typeof row?.bodyBytes === 'number' ? row.bodyBytes : null,
      fileBytes: file.bytes,
    };
  });
}

/** The canon role an instance row points at, or null. */
function roleNameOf(row) {
  const role = row?.role;
  if (!role) return null;
  if (role.stored?.state === 'role' && typeof role.stored.roleName === 'string') return role.stored.roleName;
  if (role.stored?.state === 'none') return null;
  const next = role.effectiveNext;
  return next?.kind === 'role' && typeof next.role?.name === 'string' ? next.role.name : null;
}

/**
 * The instances of one worktree that point at a canon role, with their state:
 * `current` / `stale` (running, started with another body) / `unknown` (running, no
 * launch record) / `stopped` (the next start takes the body it then finds).
 *
 * @param {Array<Record<string, any>>} rows the answer of `instances <wt> list --json`
 * @param {ReturnType<typeof readCanon>} canon
 */
export function classifyLaunched(rows, canon, { same = (a, b) => a === b } = {}) {
  const byName = new Map(canon.map((c) => [c.name, c]));
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const name = roleNameOf(row);
    if (name === null || !byName.has(name)) continue;
    const want = byName.get(name).fingerprint;
    const launched = row.role?.launched ?? null;
    const got = typeof launched?.bodyFingerprint === 'string' ? launched.bodyFingerprint : null;
    let state;
    if (row.running !== true) state = 'stopped';
    else if (launched === null) state = 'unknown';
    else state = want !== null && got !== null && same(got, want) ? 'current' : 'stale';
    out.push({
      instanceId: String(row.instanceId ?? ''),
      role: name,
      state,
      launchedVersion: typeof launched?.bodyVersion === 'number' ? launched.bodyVersion : null,
      launchedFingerprint: got,
      canonFingerprint: want,
    });
  }
  return out;
}

/**
 * How a CLI call is made; a test passes its own.
 * @typedef {(command: string, args: string[], options?: { timeoutMs?: number }) => { status: number | null, signal?: string | null, stdout: Buffer | string, stderr?: Buffer | string, error?: Error }} Spawn
 */

/** @type {Spawn} */
function defaultSpawn(command, args, { timeoutMs = SPAWN_TIMEOUT_MS } = {}) {
  const r = spawnSync(command, args, { encoding: 'buffer', shell: false, timeout: timeoutMs });
  return {
    status: r.status,
    signal: r.signal,
    stdout: r.stdout ?? Buffer.alloc(0),
    stderr: r.stderr ?? Buffer.alloc(0),
    error: r.error,
  };
}

/** The JSON a CLI call printed, or an UnreadableError. */
function readJson(spawn, cli, args, timeoutMs) {
  const r = spawn(cli, args, { timeoutMs });
  const text = (b) => (Buffer.isBuffer(b) ? b.toString('utf8') : String(b ?? ''));
  const label = `${cli} ${args.join(' ')}`;
  if (r.error) throw new UnreadableError(`${label}: ${r.error.message ?? r.error}`);
  // A timeout kills the child with a signal (spawnSync also sets error ETIMEDOUT); any signal is no answer.
  if (r.signal) throw new UnreadableError(`${label}: ended by ${r.signal}`);
  if (r.status !== 0) {
    throw new UnreadableError(`${label}: exit ${r.status}${text(r.stderr).trim() ? `: ${text(r.stderr).trim()}` : ''}`);
  }
  try {
    return JSON.parse(text(r.stdout));
  } catch {
    throw new UnreadableError(`${label}: not JSON`);
  }
}

function parseArgs(argv) {
  const [sub, ...rest] = argv;
  if (sub !== 'check' && sub !== 'launched') throw new UsageError(`unknown subcommand: ${sub ?? '(none)'}`);
  const o = { sub, cli: 'commandmate', dir: DEFAULT_DIR, roles: [...CANON_ROLES], worktrees: null, json: false };
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    const value = () => {
      const v = rest[i + 1];
      if (v === undefined || v.startsWith('--')) throw new UsageError(`${flag} needs a value`);
      i += 1;
      return v;
    };
    const list = (v) => v.split(',').map((s) => s.trim()).filter(Boolean);
    if (flag === '--json') o.json = true;
    else if (flag === '--cli') o.cli = value();
    else if (flag === '--dir') o.dir = path.resolve(value());
    else if (flag === '--roles' && sub === 'check') o.roles = list(value());
    else if (flag === '--worktrees' && sub === 'launched') o.worktrees = list(value());
    else throw new UsageError(`unknown option: ${flag}`);
  }
  if (sub === 'check' && o.roles.length === 0) throw new UsageError('--roles is empty');
  if (sub === 'launched' && (o.worktrees === null || o.worktrees.length === 0)) {
    throw new UsageError('launched needs --worktrees <wt>[,<wt>...]');
  }
  return o;
}

const short = (v) => (typeof v === 'string' ? v.slice(0, 12) : '-');
const dash = (v) => (v === null || v === undefined ? '-' : String(v));

/**
 * @param {string[]} argv
 * @param {{ spawn?: Spawn, timeoutMs?: number, out?: (s: string) => void, err?: (s: string) => void }} [io]
 * @returns {number} the exit code
 */
export function main(argv, { spawn = defaultSpawn, timeoutMs = SPAWN_TIMEOUT_MS, out = (s) => process.stdout.write(`${s}\n`), err = (s) => process.stderr.write(`${s}\n`) } = {}) {
  let o;
  try {
    o = parseArgs(argv);
  } catch (e) {
    err(e instanceof Error ? e.message : String(e));
    err(USAGE);
    return EXIT_USAGE;
  }
  try {
    if (o.sub === 'check') {
      const listJson = readJson(spawn, o.cli, ['roles', 'list', '--json'], timeoutMs);
      if (listJson?.success !== true) throw new UnreadableError(`${o.cli} roles list --json: success is not true`);
      // Not "no roles" (missing-role, exit 1): an answer of another shape was not read.
      if (!Array.isArray(listJson.roles)) throw new UnreadableError(`${o.cli} roles list --json: roles is not a list`);
      const roles = classifyRoles(listJson, readCanon(o.dir, o.roles));
      const okCount = roles.filter((r) => r.state === 'ok').length;
      const result = okCount === roles.length ? 'ok' : 'mismatch';
      if (o.json) out(JSON.stringify({ result, roles }, null, 2));
      else {
        for (const r of roles) {
          out(`ROLE ${r.name} ${r.state} v=${dash(r.bodyVersion)} db=${short(r.dbFingerprint)} file=${short(r.fileFingerprint)} bytes=${dash(r.dbBytes)}/${dash(r.fileBytes)}`);
        }
        out(`RESULT ${result} ${okCount}/${roles.length}`);
      }
      return result === 'ok' ? EXIT_OK : EXIT_MISMATCH;
    }

    const canon = readCanon(o.dir, CANON_ROLES);
    const missing = canon.filter((c) => c.fingerprint === null).map((c) => c.name);
    if (missing.length > 0) throw new UnreadableError(`canon file missing under ${o.dir}: ${missing.join(', ')}`);
    const worktrees = o.worktrees.map((wt) => {
      const rows = readJson(spawn, o.cli, ['instances', wt, 'list', '--require-roles', '--json'], timeoutMs);
      if (!Array.isArray(rows)) throw new UnreadableError(`${o.cli} instances ${wt} list --json: not a list`);
      return { worktree: wt, instances: classifyLaunched(rows, canon) };
    });
    const all = worktrees.flatMap((w) => w.instances);
    const behind = all.filter((i) => i.state === 'stale' || i.state === 'unknown').length;
    const result = behind === 0 ? 'ok' : 'behind';
    if (o.json) out(JSON.stringify({ result, worktrees }, null, 2));
    else {
      for (const w of worktrees) {
        for (const i of w.instances) {
          out(`INSTANCE ${w.worktree} ${i.instanceId} ${i.role} ${i.state} v=${dash(i.launchedVersion)} launched=${short(i.launchedFingerprint)} canon=${short(i.canonFingerprint)}`);
        }
      }
      out(`RESULT ${result} ${behind}/${all.length}`);
    }
    return behind === 0 ? EXIT_OK : EXIT_MISMATCH;
  } catch (e) {
    if (!(e instanceof UnreadableError)) throw e;
    err(`cannot compare: ${e.message}`);
    if (o.json) out(JSON.stringify({ result: 'unreadable', error: e.message }));
    return EXIT_UNREADABLE;
  }
}

/** Both sides through realpath: node resolves a symlinked entry in import.meta.url, not in argv[1]. */
function isEntryPoint() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
const isMain = isEntryPoint();
if (isMain) {
  let code;
  try {
    code = main(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
    code = EXIT_UNREADABLE;
  }
  process.exit(code);
}
