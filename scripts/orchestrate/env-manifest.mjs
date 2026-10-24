/**
 * The inputs one `/orchestrate` execution depends on, as a manifest (Issue #3883 H-8).
 *
 * env-clean (src/lib/verification/env-snapshot.ts) compares listeners, tmux
 * sessions and the entries directly under `$HOME` and `~/.commandmate`. It does
 * not see the content of a file that was already there: the `model` of
 * `~/.claude/settings.json` (the global default a worker without a local
 * setting inherits, P3), the worktree's `.claude/settings.local.json`, the
 * lockfile, or which dependency tree `node_modules` is and at which versions
 * (P6). A green env-clean therefore does not say the environment stayed the
 * same. Widening env-clean to all of `$HOME` is not the answer (no recursive
 * hash of HOME); this reads only the inputs named above.
 *
 * wait-verify.mjs takes a manifest when the call starts, before each
 * verification it starts and after the verdict, and keeps them next to its log
 * (`<log>.env.json`, under the execution key). A change between the start of
 * the last verification and the verdict means the verdict was taken across two
 * environments: it is not taken. A change while the worker worked is recorded
 * with the verdict (`env-changed=<fields>`), and the verdict is the result in
 * the environment of the end manifest (`env=<hash>`), not in another one.
 *
 * The runbook's verification without a contract (5-1) has no wait-verify: it
 * calls `start` before `commandmatedev verify` and `end` after it (#3883 N6),
 * which keep the same `<file>.env.json` under the same execution key, so
 * precheck / publish / merge compare it the same way (verifyEnvState).
 *
 * Usage:
 *   node scripts/orchestrate/env-manifest.mjs start --worktree <path> --file <x.env.json> --key <execution key>
 *   node scripts/orchestrate/env-manifest.mjs end --worktree <path> --file <x.env.json>
 *
 * `start` writes the manifest (exit 0). `end` takes the manifest again, keeps
 * both and prints the note for the record: `env=<hash>`; exit 0 when nothing
 * changed during the verification, 3 when an input did (`env-changed-during-verify=<fields>`
 * is printed too, the verdict is not taken), 2 on a usage error or a missing start.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/** What a file that exists but cannot be read or parsed reads as (not the same as absent). */
export const UNREADABLE = '<unreadable>';

function sha256OfFile(file) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch (err) {
    return err?.code === 'ENOENT' ? null : UNREADABLE;
  }
}

function readJsonFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return err?.code === 'ENOENT' ? { absent: true } : { unreadable: true };
  }
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? { value } : { unreadable: true };
  } catch {
    return { unreadable: true };
  }
}

/** The `model` key of a settings file: its value, null when the file or the key is absent, UNREADABLE otherwise. */
export function settingsModel(file) {
  const read = readJsonFile(file);
  if (read.absent) return null;
  if (read.unreadable) return UNREADABLE;
  return typeof read.value.model === 'string' ? read.value.model : null;
}

/** Where `node_modules` is: its real path, and whether the worktree's entry is a link to it. */
export function nodeModulesLocation(dir) {
  let stat;
  try {
    stat = fs.lstatSync(dir);
  } catch {
    return { realpath: null, symlink: false };
  }
  try {
    return { realpath: fs.realpathSync(dir), symlink: stat.isSymbolicLink() };
  } catch {
    return { realpath: UNREADABLE, symlink: stat.isSymbolicLink() };
  }
}

/**
 * The installed version of each direct dependency of the worktree's
 * package.json (dependencies and devDependencies), sorted by name; null for one
 * that is not installed.
 */
export function packageVersions(worktree, nodeModules = path.join(worktree, 'node_modules')) {
  const manifest = readJsonFile(path.join(worktree, 'package.json'));
  if (!manifest.value) return {};
  const names = [
    ...Object.keys(manifest.value.dependencies ?? {}),
    ...Object.keys(manifest.value.devDependencies ?? {}),
  ];
  const versions = {};
  for (const name of [...new Set(names)].sort()) {
    const installed = readJsonFile(path.join(nodeModules, name, 'package.json'));
    versions[name] = typeof installed.value?.version === 'string' ? installed.value.version : null;
  }
  return versions;
}

/**
 * The manifest of the inputs of an execution in `worktree`, with `home` the
 * HOME whose `.claude/settings.json` the worker's Claude reads.
 *
 * @param {{ worktree: string, home: string }} where
 */
export function takeManifest({ worktree, home }) {
  const local = path.join(worktree, '.claude', 'settings.local.json');
  return {
    globalModel: settingsModel(path.join(home, '.claude', 'settings.json')),
    localSettings: { model: settingsModel(local), sha256: sha256OfFile(local) },
    lockfile: sha256OfFile(path.join(worktree, 'package-lock.json')),
    nodeModules: nodeModulesLocation(path.join(worktree, 'node_modules')),
    packages: packageVersions(worktree),
  };
}

/**
 * The inputs that differ between two manifests: `globalModel`, `localSettings`,
 * `lockfile`, `nodeModules`, and `packages.<name>` per package. Empty when equal.
 */
export function diffManifest(before, after) {
  const changed = [];
  for (const field of ['globalModel', 'localSettings', 'lockfile', 'nodeModules']) {
    if (JSON.stringify(before?.[field]) !== JSON.stringify(after?.[field])) changed.push(field);
  }
  const names = new Set([...Object.keys(before?.packages ?? {}), ...Object.keys(after?.packages ?? {})]);
  for (const name of [...names].sort()) {
    if ((before?.packages?.[name] ?? null) !== (after?.packages?.[name] ?? null)) changed.push(`packages.${name}`);
  }
  return changed;
}

/** A short name for one manifest (the first 12 hex digits of the sha256 of its JSON). */
export function manifestHash(manifest) {
  return crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex').slice(0, 12);
}

/** The `env=<hash>` of a record's note; null for a record taken before #3883 H-8 recorded it. */
export function recordedEnvHash(note) {
  const match = /(?:^|\s)env=(\S+)/.exec(note ?? '');
  return match ? match[1] : null;
}

/**
 * The manifest kept for a record: the `<log>.env.json` in `runDir` whose key is
 * the record's and whose end manifest has the recorded hash; null if none.
 */
export function keptManifest(runDir, key, hash) {
  let names;
  try {
    names = fs.readdirSync(runDir).filter((name) => name.endsWith('.env.json'));
  } catch {
    return null;
  }
  for (const name of names.sort()) {
    try {
      const kept = JSON.parse(fs.readFileSync(path.join(runDir, name), 'utf8'));
      if (kept?.key === key && kept.end && manifestHash(kept.end) === hash) return { file: name, manifest: kept.end };
    } catch {
      // another writer's half-written file, or not ours
    }
  }
  return null;
}

/**
 * The inputs a later commit may change on its own: a refresh (6-2) or a fold
 * (6-4) on top of the verified commit changes the lockfile and the installed
 * versions with the code, and the precheck of the new HEAD runs on them. The
 * inputs outside git (the models, the local settings, which `node_modules`)
 * are compared at any HEAD.
 */
const FOLLOWS_HEAD = (field) => field === 'lockfile' || field.startsWith('packages.');

/**
 * Whether a passed verification still holds for the environment of `worktree`
 * now (#3883 N3): the manifest kept with the record (keptManifest) against a
 * manifest taken now.
 *
 * - `unrecorded`: the note has no `env=` (a record from before #3883 H-8). It
 *   is taken as before; the caller says so (a warning), so the run in progress
 *   when this landed is not stopped by its own earlier records.
 * - `missing`: the note names an environment whose manifest is not in the run
 *   directory (or is not the one hashed) — nothing to compare, so re-verify.
 * - `changed`: an input differs (`fields`) — re-verify.
 * - `same`.
 *
 * @param {{ note?: string, key?: string, head?: string }} record
 * @param {{ runDir: string, worktree: string, home: string, head?: string }} where
 *   `head`: the HEAD the result is used at; another than the record's ignores the inputs that follow HEAD.
 * @returns {{ state: 'same' | 'unrecorded' | 'missing' | 'changed', fields: string[], detail: string }}
 */
export function verifyEnvState(record, { runDir, worktree, home, head }) {
  const hash = recordedEnvHash(record?.note);
  if (hash === null) return { state: 'unrecorded', fields: [], detail: 'no env= in the record (taken before #3883 H-8): used as before' };
  const kept = record?.key ? keptManifest(runDir, record.key, hash) : null;
  if (!kept) return { state: 'missing', fields: [], detail: `env=${hash}: no manifest with that hash under key ${record?.key ?? '-'} in ${runDir}` };
  const sameHead = !head || head === record.head;
  const fields = diffManifest(kept.manifest, takeManifest({ worktree, home })).filter((field) => sameHead || !FOLLOWS_HEAD(field));
  return fields.length > 0
    ? { state: 'changed', fields, detail: `env=${hash} (${kept.file}) differs now in ${fields.join(',')}` }
    : { state: 'same', fields: [], detail: `env=${hash}` };
}

const USAGE = `Usage:
  node scripts/orchestrate/env-manifest.mjs start --worktree <path> --file <x.env.json> --key <execution key>
  node scripts/orchestrate/env-manifest.mjs end --worktree <path> --file <x.env.json>`;

/**
 * @param {string[]} argv
 * @param {{ home?: string, out?: (line: string) => void, error?: (line: string) => void }} [deps]
 * @returns {number} exit code
 */
export function main(argv, deps = {}) {
  const home = deps.home ?? os.homedir();
  const out = deps.out ?? ((line) => console.log(line));
  const error = deps.error ?? ((line) => console.error(line));
  const [command, ...rest] = argv;
  const o = {};
  for (let i = 0; i < rest.length; i += 2) {
    const flag = { '--worktree': 'worktree', '--file': 'file', '--key': 'key' }[rest[i]];
    if (!flag || i + 1 >= rest.length) {
      error(`unknown or incomplete argument: ${rest[i]}\n${USAGE}`);
      return 2;
    }
    o[flag] = rest[i + 1];
  }
  if (command !== 'start' && command !== 'end') {
    error(`unknown command: ${command ?? '(none)'}\n${USAGE}`);
    return 2;
  }
  if (!o.worktree || !o.file?.endsWith('.env.json') || (command === 'start' && !o.key)) {
    error(`--worktree, --file <*.env.json>${command === 'start' ? ' and --key' : ''} are required\n${USAGE}`);
    return 2;
  }
  if (command === 'start') {
    const manifest = takeManifest({ worktree: o.worktree, home });
    fs.mkdirSync(path.dirname(o.file), { recursive: true });
    // The verification starts right after: here the start and the verification's start are one moment.
    fs.writeFileSync(o.file, `${JSON.stringify({ key: o.key, start: manifest, verify: manifest, end: null }, null, 2)}\n`);
    return 0;
  }
  let kept;
  try {
    kept = JSON.parse(fs.readFileSync(o.file, 'utf8'));
  } catch {
    kept = null;
  }
  if (!kept?.verify || !kept.key) {
    error(`${o.file}: no start manifest (run start before the verification)`);
    return 2;
  }
  const end = takeManifest({ worktree: o.worktree, home });
  const duringVerify = diffManifest(kept.verify, end);
  fs.writeFileSync(o.file, `${JSON.stringify({ ...kept, end, changed: { duringTask: [], duringVerify } }, null, 2)}\n`);
  out([`env=${manifestHash(end)}`, ...(duringVerify.length > 0 ? [`env-changed-during-verify=${duringVerify.join(',')}`] : [])].join(' '));
  return duringVerify.length > 0 ? 3 : 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exit(main(process.argv.slice(2)));
