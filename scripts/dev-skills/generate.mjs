#!/usr/bin/env node
/**
 * Generate and verify the `-dev` skills derived from Kewton/commandmate-skills
 * (Issue #4323). Rules live in ./transform.mjs; the pin (upstream ref, per-file
 * upstream and output sha256) lives in ./pin.json.
 *
 *   node scripts/dev-skills/generate.mjs generate --source ../commandmate-skills
 *       The source HEAD must equal pin.ref and every upstream file must match
 *       the pinned sha256. Writes identical bytes to .claude/skills/<id>/ and
 *       .agents/skills/<id>/ (mode 0644). The upstream manifest is not copied.
 *   node scripts/dev-skills/generate.mjs generate --source <dir> --ref <sha>
 *       Re-pins to a new upstream ref (a human picks the ref), then generates.
 *   node scripts/dev-skills/generate.mjs check
 *       Needs no checkout: the derived files are inverse-transformed and the
 *       result is compared with the pinned upstream sha256.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { forward, inverse } from './transform.mjs';

const REPO_ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
export const PIN_PATH = path.join(REPO_ROOT, 'scripts/dev-skills/pin.json');
export const ROOTS = ['.claude/skills', '.agents/skills'];
export const UPSTREAM_PACKAGES = [
  { id: 'cmate-delegate-dev', upstream: 'skills/cmate-delegate' },
  { id: 'cmate-handoff-dev', upstream: 'skills/cmate-handoff' },
];
const MANIFEST = 'commandmate.skill.yaml';
const FILE_MODE = 0o644;

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function listFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(path.relative(root, full).split(path.sep).join('/'));
    }
  };
  walk(root);
  return out.sort();
}

export function readPin(pinPath = PIN_PATH) {
  return JSON.parse(readFileSync(pinPath, 'utf8'));
}

/** `path:` / `sha256:` pairs of the upstream manifest's `files:` list. */
function manifestDigests(text) {
  const out = new Map();
  const re = /^ {2}- path: (\S+)\n {4}sha256: ([0-9a-f]{64})$/gm;
  let m;
  while ((m = re.exec(text)) !== null) out.set(m[1], m[2]);
  return out;
}

/**
 * Verify the derived tree against the pin. Returns a list of problems
 * (empty = consistent). Needs only the repository, never the skills checkout.
 */
export function checkDerived({ repoRoot = REPO_ROOT, pin = readPin() } = {}) {
  const problems = [];
  for (const pkg of pin.packages) {
    const expected = pkg.files.map((f) => f.path).sort();
    const contents = new Map();
    for (const root of ROOTS) {
      const dir = path.join(repoRoot, root, pkg.id);
      if (!existsSync(dir)) {
        problems.push(`${root}/${pkg.id}: missing directory`);
        continue;
      }
      const actual = listFiles(dir);
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        problems.push(`${root}/${pkg.id}: file set differs from pin (actual: ${actual.join(',')})`);
      }
      for (const file of pkg.files) {
        const abs = path.join(dir, file.path);
        if (!existsSync(abs)) continue;
        const buf = readFileSync(abs);
        const where = `${root}/${pkg.id}/${file.path}`;
        if (sha256(buf) !== file.outputSha256) problems.push(`${where}: output sha256 differs from pin`);
        const text = buf.toString('utf8');
        const back = inverse(file.path, text);
        if (sha256(Buffer.from(back, 'utf8')) !== file.upstreamSha256) {
          problems.push(`${where}: inverse transform does not reproduce the pinned upstream bytes`);
        }
        if (forward(file.path, back) !== text) {
          problems.push(`${where}: forward(inverse(file)) differs from file (hand edit?)`);
        }
        const prior = contents.get(file.path);
        if (prior !== undefined && Buffer.compare(prior, buf) !== 0) {
          problems.push(`${where}: differs between ${ROOTS[0]} and ${ROOTS[1]}`);
        }
        contents.set(file.path, buf);
      }
    }
  }
  return problems;
}

/** Throw naming every file missing from / extra in `actual` relative to `expected`. */
function assertSameSet(label, actual, expected) {
  const a = new Set(actual);
  const e = new Set(expected);
  const missing = expected.filter((f) => !a.has(f)).sort();
  const extra = actual.filter((f) => !e.has(f)).sort();
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `${label}: missing [${missing.join(', ')}], extra [${extra.join(', ')}]; nothing was written`,
    );
  }
}

function gitHead(source) {
  return execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

export function generate({ source, ref = /** @type {string | null} */ (null), repoRoot = REPO_ROOT, pinPath = PIN_PATH, headOf = gitHead }) {
  const head = headOf(source);
  const existing = existsSync(pinPath) ? readPin(pinPath) : null;
  const repin = ref !== null;
  if (repin && head !== ref) throw new Error(`source HEAD ${head} is not the requested --ref ${ref}`);
  if (!repin) {
    if (!existing) throw new Error('no pin.json; pass --ref <sha> to create it');
    if (existing.ref !== head) {
      throw new Error(`source HEAD ${head} differs from pin.ref ${existing.ref}; pass --ref ${head} to re-pin`);
    }
  }

  const nextPins = [];
  const outputs = [];
  for (const def of UPSTREAM_PACKAGES) {
    const srcDir = path.join(source, def.upstream);
    const manifestText = readFileSync(path.join(srcDir, MANIFEST), 'utf8');
    const version = /^version: (\S+)$/m.exec(manifestText)?.[1];
    const digests = manifestDigests(manifestText);
    const pinned = existing?.packages.find((p) => p.id === def.id);
    const actualFiles = listFiles(srcDir).filter((f) => f !== MANIFEST);
    // Nothing is deleted or written before these set checks pass (Issue #4323).
    assertSameSet(`${def.upstream} files vs its manifest`, actualFiles, [...digests.keys()]);
    if (!repin) {
      assertSameSet(`${def.upstream} files vs pin`, actualFiles, (pinned?.files ?? []).map((f) => f.path));
    }
    const files = [];
    for (const rel of actualFiles) {
      const buf = readFileSync(path.join(srcDir, rel));
      const upstreamSha256 = sha256(buf);
      if (digests.get(rel) !== upstreamSha256) {
        throw new Error(`${def.upstream}/${rel}: sha256 differs from the upstream manifest`);
      }
      if (!repin) {
        const pf = pinned?.files.find((f) => f.path === rel);
        if (!pf || pf.upstreamSha256 !== upstreamSha256) {
          throw new Error(`${def.upstream}/${rel}: sha256 differs from pin`);
        }
      }
      const outText = forward(rel, buf.toString('utf8'));
      files.push({ path: rel, upstreamSha256, outputSha256: sha256(Buffer.from(outText, 'utf8')) });
      outputs.push({ id: def.id, rel, outText });
    }
    nextPins.push({ id: def.id, upstream: def.upstream, version, files });
  }

  for (const def of UPSTREAM_PACKAGES) {
    for (const root of ROOTS) rmSync(path.join(repoRoot, root, def.id), { recursive: true, force: true });
  }
  for (const { id, rel, outText } of outputs) {
    for (const root of ROOTS) {
      const abs = path.join(repoRoot, root, id, rel);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, outText, { mode: FILE_MODE });
    }
  }
  const pin = { ref: head, packages: nextPins };
  if (repin) writeFileSync(pinPath, `${JSON.stringify(pin, null, 2)}\n`);
  return pin;
}

function main(argv) {
  const [cmd, ...rest] = argv;
  const opt = (name) => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : null;
  };
  if (cmd === 'check') {
    const problems = checkDerived();
    if (problems.length > 0) {
      for (const p of problems) console.error(`FAIL ${p}`);
      return 1;
    }
    const n = readPin().packages.reduce((s, p) => s + p.files.length, 0);
    console.log(`dev-skills: ${n} files x ${ROOTS.length} roots consistent with pin`);
    return 0;
  }
  if (cmd === 'generate') {
    const source = opt('--source');
    if (!source) {
      console.error('usage: generate --source <commandmate-skills checkout> [--ref <sha>]');
      return 2;
    }
    const pin = generate({ source: path.resolve(source), ref: opt('--ref') });
    console.log(`dev-skills: generated ${pin.packages.map((p) => p.id).join(', ')} @ ${pin.ref}`);
    return 0;
  }
  console.error('usage: generate.mjs <generate --source <dir> [--ref <sha>] | check>');
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    console.error(`dev-skills: ${error.message}`);
    process.exit(1);
  }
}
