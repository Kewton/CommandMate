/**
 * Drift gate for the generated -dev skills (Issue #4323).
 *
 * CI never checks out Kewton/commandmate-skills, so the proof "upstream bytes +
 * transform = today's file" goes through the inverse transform:
 *   sha256(inverse(file)) === pinned upstream sha256   (derived from the pin)
 *   forward(inverse(file)) === file                     (no hand edits survive)
 * @vitest-environment node
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkDerived, readPin, ROOTS } from '../../../../scripts/dev-skills/generate.mjs';
import { R1, R1B, countDevCli } from '../../../../scripts/dev-skills/transform.mjs';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const pin = readPin();
const IDS: string[] = pin.packages.map((p: { id: string }) => p.id);

function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else out.push(path.relative(root, full).split(path.sep).join('/'));
    }
  };
  walk(root);
  return out.sort();
}

describe('generated -dev skills', () => {
  it('pins the two packages at a full upstream ref', () => {
    expect(IDS).toEqual(['cmate-delegate-dev', 'cmate-handoff-dev']);
    expect(pin.ref).toMatch(/^[0-9a-f]{40}$/);
  });

  it('is consistent with the pin in both roots (no problems)', () => {
    expect(checkDerived({ repoRoot: REPO_ROOT, pin })).toEqual([]);
  });

  it.each(IDS)('%s: file set equals the pin, no manifest or receipt, same bytes in both roots', (id) => {
    const expected = pin.packages.find((p: { id: string }) => p.id === id).files
      .map((f: { path: string }) => f.path)
      .sort();
    const [a, b] = ROOTS.map((r: string) => path.join(REPO_ROOT, r, id));
    expect(listFiles(a)).toEqual(expected);
    expect(listFiles(b)).toEqual(expected);
    expect(expected).not.toContain('commandmate.skill.yaml');
    expect(expected).not.toContain('.commandmate-receipt.json');
    for (const rel of expected) {
      expect(fs.readFileSync(path.join(a, rel)).equals(fs.readFileSync(path.join(b, rel))), rel).toBe(true);
    }
  });

  it.each(IDS)('%s: SKILL.md name equals the directory name', (id) => {
    const text = fs.readFileSync(path.join(REPO_ROOT, '.claude/skills', id, 'SKILL.md'), 'utf8');
    expect(/^name: (\S+)$/m.exec(text)?.[1]).toBe(id);
  });

  it('leaves no public CLI call and has the expected number of commandmatedev', () => {
    let total = 0;
    for (const root of ROOTS) {
      for (const id of IDS) {
        const dir = path.join(REPO_ROOT, root, id);
        for (const rel of listFiles(dir)) {
          const text = fs.readFileSync(path.join(dir, rel), 'utf8');
          expect(text.match(R1), `${root}/${id}/${rel}`).toBeNull();
          expect(text.match(R1B), `${root}/${id}/${rel}`).toBeNull();
          total += countDevCli(text);
        }
      }
    }
    // 83 per root (81 replacements + 2 description prefixes), two roots.
    expect(total).toBe(83 * 2);
  });
});

describe('generated -dev skills: negative controls on a temp copy', () => {
  let tmp: string | null = null;
  afterEach(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    tmp = null;
  });

  function copyRepo(): string {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-skills-'));
    for (const root of ROOTS) {
      for (const id of IDS) {
        fs.cpSync(path.join(REPO_ROOT, root, id), path.join(tmp, root, id), { recursive: true });
      }
    }
    return tmp;
  }

  it('is clean on an untouched copy', () => {
    expect(checkDerived({ repoRoot: copyRepo(), pin })).toEqual([]);
  });

  it('flags a one-byte change in one root', () => {
    const t = copyRepo();
    const f = path.join(t, '.claude/skills/cmate-delegate-dev/references/exit-codes.md');
    fs.appendFileSync(f, 'x');
    const problems = checkDerived({ repoRoot: t, pin });
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join('\n')).toMatch(/inverse transform|output sha256|differs between/);
  });

  it('flags a hand edit that the inverse would absorb (commandmate -> commandmatedev)', () => {
    const t = copyRepo();
    const f = path.join(t, '.agents/skills/cmate-handoff-dev/references/exit-codes.md');
    const text = fs.readFileSync(f, 'utf8');
    fs.writeFileSync(f, text.replace('commandmatedev', 'commandmate'));
    expect(checkDerived({ repoRoot: t, pin }).length).toBeGreaterThan(0);
  });

  it('flags a missing file and an extra manifest', () => {
    const t = copyRepo();
    fs.rmSync(path.join(t, '.claude/skills/cmate-handoff-dev/references/changelog.md'));
    fs.writeFileSync(path.join(t, '.agents/skills/cmate-delegate-dev/commandmate.skill.yaml'), 'x');
    const problems = checkDerived({ repoRoot: t, pin }).join('\n');
    expect(problems).toMatch(/file set differs/);
  });
});
