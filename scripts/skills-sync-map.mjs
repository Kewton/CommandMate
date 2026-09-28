#!/usr/bin/env node
/**
 * Maintain and inspect `.claude/skills/sync-map.json` — the declared
 * correspondence between CommandMate's in-repo skills and the packages
 * published from `Kewton/commandmate-skills` (Issue #1612).
 *
 * The CI gate itself is `tests/unit/skills/sync-map.test.ts`: it compares the
 * sha256 pinned in the map against the file on disk and needs neither the
 * network nor a checkout of the counterpart repository. This script is the
 * companion for the two moments the gate cannot cover on its own:
 *
 *   update      refresh the pins after a change has been ported, so the red
 *               turns green only once the author has been through the sync.
 *   check       the same comparison the test does, from a shell.
 *   --counterpart <dir>
 *               with a local checkout of commandmate-skills, diff the two
 *               trees for real. This is the only view that catches the
 *               skills -> CommandMate direction (the #1613 drift), which a
 *               digest pinned on our side structurally cannot see.
 *
 * Usage:
 *   node scripts/skills-sync-map.mjs check
 *   node scripts/skills-sync-map.mjs check  --counterpart ../commandmate-skills
 *   node scripts/skills-sync-map.mjs update
 *   node scripts/skills-sync-map.mjs update --counterpart ../commandmate-skills
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const REPO_ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const MAP_PATH = path.join(REPO_ROOT, '.claude/skills/sync-map.json');
const REVIEW_PREFIX = 'REVIEW:';

/** sha256 of a file's bytes, as lowercase hex. */
export function digestFile(absolute) {
  return createHash('sha256').update(readFileSync(absolute)).digest('hex');
}

/** Every regular file under `root`, as sorted paths relative to `root`. */
export function listFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(path.relative(root, full));
    }
  };
  walk(root);
  return out.sort();
}

export function readMap(mapPath = MAP_PATH) {
  return JSON.parse(readFileSync(mapPath, 'utf8'));
}

/** Packages that declare a counterpart (i.e. everything but `local-only`). */
export function mappedPackages(map) {
  return map.packages.filter((pkg) => pkg.policy !== 'local-only');
}

/**
 * Compare the pinned digests against the working tree.
 * Returns one entry per file whose bytes no longer match the pin.
 */
export function findStalePins(map, repoRoot = REPO_ROOT) {
  const stale = [];
  for (const pkg of mappedPackages(map)) {
    for (const file of pkg.files) {
      const absolute = path.join(repoRoot, pkg.local, file.path);
      if (!existsSync(absolute)) {
        stale.push({ pkg, file, reason: 'missing', actual: null });
        continue;
      }
      const actual = digestFile(absolute);
      if (actual !== file.sha256) stale.push({ pkg, file, reason: 'changed', actual });
    }
  }
  return stale;
}

/**
 * The counterpart path a file must be ported to, as written in the map.
 * `file.counterpartPath` overrides the default `${pkg.counterpart}/${file.path}`
 * join for packages whose counterpart repository places the file elsewhere
 * (Issue #2904 — cmate-verify's fixtures live outside the published package).
 */
export function counterpartPathOf(pkg, file) {
  if (file.counterpartPath) return file.counterpartPath;
  return `${pkg.counterpart}/${file.path}`;
}

/**
 * Infer the counterpartPath for a newly added file from existing entries in the
 * same package that live in the same directory (Issue #2911).
 */
export function inferCounterpartPath(pkg, rel) {
  const targetDir = path.posix.dirname(rel);
  const candidates = (pkg.files ?? []).filter(
    (f) => Boolean(f.counterpartPath) && path.posix.dirname(f.path) === targetDir,
  );

  if (candidates.length === 0) return null;

  const cpDirs = new Set(candidates.map((f) => path.posix.dirname(f.counterpartPath)));
  if (cpDirs.size !== 1) return null;

  const allSameBasename = candidates.every(
    (f) => path.posix.basename(f.counterpartPath) === path.posix.basename(f.path),
  );
  if (!allSameBasename) return null;

  const inferredDir = Array.from(cpDirs)[0];
  return path.posix.join(inferredDir, path.posix.basename(rel));
}

export function updateMap(options = {}) {
  const opts = typeof options === 'string' ? { counterpartDir: options } : (options ?? {});
  const counterpartDir = opts.counterpartDir ?? null;
  const repoRoot = opts.repoRoot ?? REPO_ROOT;
  const mapPath = opts.mapPath ?? path.join(repoRoot, '.claude/skills/sync-map.json');

  const map = readMap(mapPath);
  let added = 0;
  let repinned = 0;
  let inferred = 0;
  const newlyAdded = [];

  for (const pkg of mappedPackages(map)) {
    const root = path.join(repoRoot, pkg.local);
    const onDisk = listFiles(root);
    const known = new Map(pkg.files.map((f) => [f.path, f]));
    const next = [];

    for (const rel of onDisk) {
      const previous = known.get(rel);
      const sha256 = digestFile(path.join(root, rel));
      if (!previous) {
        added += 1;
        const counterpartPath = inferCounterpartPath(pkg, rel);
        if (counterpartPath) inferred += 1;
        const newEntry = {
          path: rel,
          ...(counterpartPath ? { counterpartPath } : {}),
          // Never invent a classification. The test rejects any note that still
          // starts with REVIEW:, so a new file cannot reach main unclassified.
          policy: 'port-required',
          sha256,
          note: `${REVIEW_PREFIX} classify this file deliberately (byte-identical / port-required), or move the package to local-only`,
        };
        next.push(newEntry);
        newlyAdded.push({ pkg, file: newEntry });
        continue;
      }
      if (previous.sha256 !== sha256) repinned += 1;
      next.push({ ...previous, sha256 });
    }

    const removed = pkg.files.filter((f) => !onDisk.includes(f.path));
    for (const f of removed) console.log(`  - dropped ${pkg.local}/${f.path} (no longer on disk)`);
    pkg.files = next;
  }

  writeFileSync(mapPath, `${JSON.stringify(map, null, 2)}\n`);
  console.log(`updated ${path.relative(repoRoot, mapPath)}: ${repinned} re-pinned, ${added} added`);
  if (added > 0) {
    console.log(`\n${added} new file(s) carry a ${REVIEW_PREFIX} note. Replace each one with a real`);
    console.log('policy and rationale — the unit test fails while any REVIEW: note remains.');
  }
  if (inferred > 0) {
    console.log(`${inferred} new file(s) got counterpartPath inferred from their directory`);
  }
  if (counterpartDir) {
    reportCounterpart(map, counterpartDir, repoRoot);
    const root = path.resolve(counterpartDir);
    if (existsSync(root)) {
      for (const { pkg, file } of newlyAdded) {
        const targetPath = counterpartPathOf(pkg, file);
        const theirs = path.join(root, targetPath);
        if (!existsSync(theirs)) {
          console.warn(`warning: ${file.path} has no counterpart at ${targetPath}`);
        }
      }
    }
  }
  return 0;
}

function checkMap({ counterpartDir }) {
  const map = readMap();
  const stale = findStalePins(map);
  for (const { pkg, file, reason, actual } of stale) {
    console.error(`\nFAIL ${pkg.local}/${file.path} (${file.policy})`);
    if (reason === 'missing') {
      console.error('  the map lists this path but it does not exist on disk');
    } else {
      console.error(`  pinned ${file.sha256}`);
      console.error(`  actual ${actual}`);
    }
    console.error(`  port to ${map.counterpart.repo}: ${counterpartPathOf(pkg, file)}`);
  }
  if (stale.length > 0) {
    console.error(`\n${stale.length} file(s) drifted from the last cross-repo sync.`);
    console.error('Port the change, then: node scripts/skills-sync-map.mjs update --counterpart <dir>');
  } else {
    console.log(`all pins current (${mappedPackages(map).reduce((n, p) => n + p.files.length, 0)} files)`);
  }
  const counterpartFailures = counterpartDir ? reportCounterpart(map, counterpartDir) : 0;
  return stale.length + counterpartFailures > 0 ? 1 : 0;
}

/**
 * Live comparison against a checkout of commandmate-skills. Reports both
 * directions, which is what the pinned digests alone cannot do.
 * Returns the number of `byte-identical` violations (the only hard failures).
 */
function reportCounterpart(map, counterpartDir, repoRoot = REPO_ROOT) {
  const root = path.resolve(counterpartDir);
  if (!existsSync(root)) {
    console.error(`counterpart checkout not found: ${root}`);
    return 1;
  }
  console.log(`\ncounterpart: ${root}`);
  let hardFailures = 0;
  for (const pkg of mappedPackages(map)) {
    for (const file of pkg.files) {
      const mine = path.join(repoRoot, pkg.local, file.path);
      const theirs = path.join(root, counterpartPathOf(pkg, file));
      if (!existsSync(theirs)) {
        console.error(`  MISSING  ${counterpartPathOf(pkg, file)}`);
        if (file.policy === 'byte-identical') hardFailures += 1;
        continue;
      }
      const same = digestFile(mine) === digestFile(theirs);
      if (file.policy === 'byte-identical' && !same) {
        console.error(`  DIFFERS  ${counterpartPathOf(pkg, file)} (declared byte-identical)`);
        hardFailures += 1;
      } else if (file.policy === 'port-required' && !same) {
        // Expected: these diverge on purpose. Printed so the operator can eyeball
        // whether the divergence is still only the intentional part.
        console.log(`  differs  ${counterpartPathOf(pkg, file)} (port-required — review the diff)`);
      }
    }
    const theirRoot = path.join(root, pkg.counterpart);
    if (existsSync(theirRoot) && statSync(theirRoot).isDirectory()) {
      const declared = new Set(pkg.files.map((f) => f.path));
      const allowed = new Set(pkg.counterpartOnly ?? []);
      for (const rel of listFiles(theirRoot)) {
        if (!declared.has(rel) && !allowed.has(rel)) {
          console.log(`  extra    ${pkg.counterpart}/${rel} (counterpart-only, not in the map)`);
        }
      }
    }
  }
  if (hardFailures > 0) console.error(`\n${hardFailures} byte-identical violation(s).`);
  return hardFailures;
}

function main(argv) {
  const command = argv[0] ?? 'check';
  const at = argv.indexOf('--counterpart');
  const counterpartDir = at === -1 ? null : argv[at + 1];
  if (at !== -1 && !counterpartDir) {
    console.error('--counterpart needs a path to a commandmate-skills checkout');
    return 2;
  }
  if (command === 'update') return updateMap({ counterpartDir });
  if (command === 'check') return checkMap({ counterpartDir });
  console.error(`unknown command: ${command} (expected "check" or "update")`);
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  process.exit(main(process.argv.slice(2)));
}
