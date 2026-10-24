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
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

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
