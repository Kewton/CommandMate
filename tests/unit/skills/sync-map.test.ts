/**
 * Cross-repository drift gate for the skills CommandMate shares with
 * `Kewton/commandmate-skills` (Issue #1612).
 *
 * WHAT THIS GUARDS, AND WHAT IT DOES NOT
 *
 * `.claude/skills` <-> `.agents/skills` (both inside this repo) is already fixed
 * by cmate-verify/dual-placement.test.ts, demo-video/mirror.test.ts and
 * video-to-gif/mirror.test.ts. This file never compares those two roots — it
 * only ever reads `.claude/skills`, and asserts that every `.agents/skills`
 * entry has a `.claude` twin so the classification below stays exhaustive.
 * The gap it closes is the one across repositories, which nothing watched:
 * #1586 ported cmate-verify byte-for-byte, #1607 changed only the CommandMate
 * side, and the drift survived four days until someone happened to notice.
 *
 * HOW IT DETECTS
 *
 * `.claude/skills/sync-map.json` pins the sha256 of every file that has a
 * counterpart, as of the last sync. Editing such a file turns this test red at
 * the exact moment the author still holds the context needed to decide whether
 * the change must be ported. No network, no submodule, no cross-repo token —
 * skills is a personal repository and CI must not gain write credentials for it
 * (docs/user-guide/skills.md §3-9).
 *
 * WHY THREE POLICIES AND NOT TWO
 *
 * Issue #1612 proposed `identical` / `adapted`, where `adapted` files are
 * excluded from detection. That reproduces #1613: orchestrate-monitor's scripts
 * are NOT byte-identical (comments carry each repository's own Issue numbers)
 * yet their code diff is 0 lines on all 8 files, so a behaviour change must be
 * ported both ways. Excluding them as `adapted` is exactly how that drift went
 * unnoticed. `adapted` is therefore split into `port-required` (ported, bytes
 * free) and `local-only` (no counterpart at all).
 *
 * @vitest-environment node
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const MAP_RELATIVE = '.claude/skills/sync-map.json';
const MAP_PATH = path.join(REPO_ROOT, MAP_RELATIVE);
const CLAUDE_SKILLS = path.join(REPO_ROOT, '.claude/skills');
const AGENTS_SKILLS = path.join(REPO_ROOT, '.agents/skills');
const UPDATE_CMD = 'node scripts/skills-sync-map.mjs update';
const REVIEW_PREFIX = 'REVIEW:';

type Policy = 'byte-identical' | 'port-required';

interface MappedFile {
  path: string;
  policy: Policy;
  sha256: string;
  note?: string;
}

interface SyncPackage {
  local: string;
  counterpart: string | null;
  policy: 'mapped' | 'local-only';
  reason?: string;
  rationale?: string;
  mirrors?: string[];
  counterpartOnly?: string[];
  files?: MappedFile[];
}

interface SyncMap {
  version: number;
  counterpart: { repo: string; lastSyncedRef: string; lastSyncedAt: string };
  policies: Record<string, { meaning: string; onChange: string; detected: string }>;
  policyRationale: string;
  packages: SyncPackage[];
  notMapped: { counterpart: string[]; reason: string; measuredAt: string }[];
  knownGap: string;
}

const map: SyncMap = JSON.parse(fs.readFileSync(MAP_PATH, 'utf8'));

function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(path.relative(root, full));
    }
  };
  walk(root);
  return out.sort();
}

function listDirs(root: string): string[] {
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

const sha256 = (absolute: string) =>
  createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');

const mapped = () => map.packages.filter((p) => p.policy === 'mapped');
const localOnly = () => map.packages.filter((p) => p.policy === 'local-only');

/**
 * The message a drifting file produces. It has to answer the only two questions
 * the author has at that moment: where does this go, and how do I clear the red
 * without pretending the port happened.
 */
function driftMessage(pkg: SyncPackage, file: MappedFile, actual: string | null): string {
  const local = `${pkg.local}/${file.path}`;
  const remote = `${pkg.counterpart}/${file.path}`;
  const how =
    file.policy === 'byte-identical'
      ? `copy the same bytes to ${remote} (it must stay byte-identical)`
      : `re-express the behaviour change in ${remote} — a verbatim copy would destroy the intentional adaptation`;
  return [
    '',
    `${local} drifted from the last cross-repo sync.`,
    `  policy   : ${file.policy}`,
    `  port to  : ${map.counterpart.repo} :: ${remote}`,
    actual === null ? '  state    : listed in the map but missing on disk' : `  pinned   : ${file.sha256}`,
    actual === null ? '' : `  actual   : ${actual}`,
    file.note ? `  note     : ${file.note}` : '',
    'Clear this deliberately, one of two ways:',
    `  1) port it — ${how}, then re-pin: ${UPDATE_CMD}`,
    `  2) if the counterpart is gone, change this file's policy in ${MAP_RELATIVE}`,
    `     (or move the package to local-only) and write the reason there.`,
    `To see the real diff first: ${UPDATE_CMD.replace('update', 'check')} --counterpart <path-to-commandmate-skills>`,
    '',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

describe('skills sync map: shape and coverage', () => {
  it('declares a versioned map with a counterpart repository and the three policies', () => {
    expect(map.version).toBe(1);
    expect(map.counterpart.repo).toBe('Kewton/commandmate-skills');
    expect(map.counterpart.lastSyncedRef).toMatch(/^[0-9a-f]{7,40}$/);
    expect(map.counterpart.lastSyncedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Object.keys(map.policies).sort()).toEqual([
      'byte-identical',
      'local-only',
      'port-required',
    ]);
    for (const [name, policy] of Object.entries(map.policies)) {
      expect(policy.meaning.length, `${name}.meaning`).toBeGreaterThan(10);
      expect(policy.onChange.length, `${name}.onChange`).toBeGreaterThan(10);
      expect(policy.detected.length, `${name}.detected`).toBeGreaterThan(10);
    }
    // The three-state split is the correction this Issue makes to its own body;
    // losing the rationale would let a future reader collapse it back to two.
    expect(map.policyRationale).toMatch(/#1613/);
    expect(map.knownGap).toMatch(/counterpart/);
  });

  it('classifies every skill directory exactly once', () => {
    // Guards the map against rotting the moment a skill is added: an unclassified
    // directory is neither watched nor knowingly exempted.
    const declared = map.packages.map((p) => p.local).sort();
    expect(new Set(declared).size, 'duplicate package entries').toBe(declared.length);
    expect(declared).toEqual(listDirs(CLAUDE_SKILLS).map((d) => `.claude/skills/${d}`).sort());
    expect(mapped().length).toBeGreaterThanOrEqual(2);
    expect(localOnly().length).toBeGreaterThanOrEqual(1);
  });

  it('keeps .agents/skills a subset of .claude/skills so the classification stays exhaustive', () => {
    // This intentionally does NOT compare contents — dual-placement.test.ts and the
    // mirror tests own that. It only proves a skill cannot hide from the check above
    // by living solely under .agents.
    const claude = new Set(listDirs(CLAUDE_SKILLS));
    for (const name of listDirs(AGENTS_SKILLS)) {
      expect(claude.has(name), `.agents/skills/${name} has no .claude/skills twin`).toBe(true);
    }
    // The map declares CommandMate-side paths only; the .agents mirroring role
    // belongs to the existing tests and must not be duplicated here.
    for (const pkg of map.packages) expect(pkg.local.startsWith('.claude/skills/')).toBe(true);
  });

  it('gives every local-only package a reason and no pins', () => {
    for (const pkg of localOnly()) {
      expect(pkg.counterpart, `${pkg.local} is local-only but names a counterpart`).toBeNull();
      expect((pkg.reason ?? '').length, `${pkg.local}.reason`).toBeGreaterThan(10);
      expect(pkg.files, `${pkg.local} is local-only but carries pins`).toBeUndefined();
    }
  });

  it('gives every mapped package a counterpart path, a rationale and pins', () => {
    for (const pkg of mapped()) {
      expect(pkg.counterpart, `${pkg.local}.counterpart`).toMatch(/^skills\/[a-z0-9-]+$/);
      expect((pkg.rationale ?? '').length, `${pkg.local}.rationale`).toBeGreaterThan(10);
      expect(pkg.files!.length, `${pkg.local}.files`).toBeGreaterThan(0);
      for (const file of pkg.files!) {
        expect(['byte-identical', 'port-required'], `${pkg.local}/${file.path}.policy`).toContain(
          file.policy,
        );
        expect(file.sha256, `${pkg.local}/${file.path}.sha256`).toMatch(/^[0-9a-f]{64}$/);
        // `update` stamps REVIEW: on files it could not classify. Reaching main with
        // one still in place would mean an unreviewed entry.
        expect(file.note ?? '', `${pkg.local}/${file.path} still carries a ${REVIEW_PREFIX} note`).not.toMatch(
          new RegExp(`^${REVIEW_PREFIX}`),
        );
      }
    }
  });

  it('records why the .md-only skill packages are not mapped', () => {
    expect(map.notMapped.length).toBeGreaterThan(0);
    for (const entry of map.notMapped) {
      expect(entry.counterpart.length).toBeGreaterThan(0);
      expect(entry.reason.length).toBeGreaterThan(30);
      expect(entry.measuredAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    // The one judgement call this Issue left open: `.claude/commands/*.md` are not
    // ports of `skills/cmate-*`, so pinning them would produce a gate nobody acts on.
    const all = map.notMapped.flatMap((e) => e.counterpart);
    expect(all).toContain('skills/cmate-orchestrate');
  });
});

describe('skills sync map: the drift gate', () => {
  const mappedFiles = mapped().flatMap((pkg) => pkg.files!.map((file) => ({ pkg, file })));

  it('watches both known cross-repo pairs and a non-trivial number of files', () => {
    // Without this, deleting every entry would leave a green, meaningless suite.
    expect(mapped().map((p) => p.local).sort()).toEqual([
      '.claude/skills/cmate-verify',
      '.claude/skills/orchestrate-monitor',
    ]);
    expect(mappedFiles.length).toBeGreaterThanOrEqual(30);
    expect(mappedFiles.some((e) => e.file.policy === 'byte-identical')).toBe(true);
    expect(mappedFiles.some((e) => e.file.policy === 'port-required')).toBe(true);
  });

  it('lists every file under a mapped package — a new file cannot slip in unclassified', () => {
    for (const pkg of mapped()) {
      const onDisk = listFiles(path.join(REPO_ROOT, pkg.local));
      const declared = pkg.files!.map((f) => f.path).sort();
      expect(new Set(declared).size, `${pkg.local}: duplicate file entries`).toBe(declared.length);
      expect(
        declared,
        `${pkg.local}: the map and the working tree disagree on which files exist. Run: ${UPDATE_CMD}`,
      ).toEqual(onDisk);
    }
  });

  it.each(mappedFiles.map((e) => [`${e.pkg.local}/${e.file.path}`, e] as const))(
    '%s matches its pinned digest',
    (_label, { pkg, file }) => {
      const absolute = path.join(REPO_ROOT, pkg.local, file.path);
      // A path written into the map that does not exist must fail loudly rather
      // than pass by never being read.
      expect(fs.existsSync(absolute), driftMessage(pkg, file, null)).toBe(true);
      const actual = sha256(absolute);
      expect(actual, driftMessage(pkg, file, actual)).toBe(file.sha256);
    },
  );
});

describe('skills sync map: placement', () => {
  it('sits next to the skills it describes without becoming a phantom skill', () => {
    // scanSkillDirs() skips non-directories, so a JSON file at the root of
    // .claude/skills is invisible to the slash-command loader. Asserted here
    // because the map's location depends on it.
    expect(fs.statSync(MAP_PATH).isFile()).toBe(true);
    expect(listDirs(CLAUDE_SKILLS)).not.toContain('sync-map.json');
  });

  it('names the tool that refreshes the pins, and the tool exists', () => {
    expect(fs.existsSync(path.join(REPO_ROOT, 'scripts/skills-sync-map.mjs'))).toBe(true);
  });
});
