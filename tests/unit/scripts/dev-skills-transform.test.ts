/**
 * Unit tests for the -dev skill transform (Issue #4323).
 * @vitest-environment node
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { generate } from '../../../scripts/dev-skills/generate.mjs';
import {
  DESCRIPTION_PREFIX,
  countDevCli,
  forward,
  inverse,
} from '../../../scripts/dev-skills/transform.mjs';

describe('forward: R1 / R1b (CLI calls)', () => {
  it.each([
    ['run commandmate send wt "x"', 'run commandmatedev send wt "x"'],
    ['`commandmate wait` returns', '`commandmatedev wait` returns'],
    ['use `commandmate` here', 'use `commandmatedev` here'],
    ['$ commandmate\tmem mode --json', '$ commandmatedev\tmem mode --json'],
    ['日本語の後 commandmate ask', '日本語の後 commandmatedev ask'],
  ])('rewrites %s', (input, expected) => {
    expect(forward('references/x.md', input)).toBe(expected);
  });

  it.each([
    'CommandMate is a tool',
    'repo commandmate-skills',
    'commandmate.skill.yaml',
    '.commandmate/tasks/x.yaml',
    'compatibility.commandmate',
    'npx commandmate@latest',
    'LAUNCHER="${CM:-commandmate}" # ref',
    'commandmate 0.31.3',
    'commandmate CLI',
    'commandmate の',
    'https://example.com/commandmate/x',
    'CM_WORKTREE_ID',
    '~/bin/commandmate',
  ])('leaves %s unchanged (negative control)', (input) => {
    const out = forward('references/x.md', input);
    if (input.startsWith('LAUNCHER=')) {
      // only the exact literal is an exception, not the whole shape
      expect(out).toBe(input.replace('${CM:-commandmate}', '${CM:-commandmatedev}'));
    } else {
      expect(out).toBe(input);
    }
  });
});

describe('forward: R2 (skill names)', () => {
  it('adds -dev to the skill names', () => {
    expect(forward('references/x.md', 'see cmate-delegate and cmate-handoff.')).toBe(
      'see cmate-delegate-dev and cmate-handoff-dev.',
    );
  });

  it.each([
    'cmate-handoff:next:topic',
    'cmate-delegate-v0.1.2',
    'tests/fixtures/cmate-delegate/run_tests.sh',
    'xcmate-delegate',
    'cmate-delegatex',
    'cmate-orchestrate',
  ])('leaves %s unchanged (negative control)', (input) => {
    expect(forward('references/x.md', input)).toBe(input);
  });
});

describe('forward: E (ask.sh exceptions)', () => {
  it('rewrites the launcher default and the usage line', () => {
    const src = 'LAUNCHER="${CM:-commandmate}"\n  --cli <l>  commandmate launcher (default: $CM, else commandmate)\n';
    expect(forward('scripts/ask.sh', src)).toBe(
      'LAUNCHER="${CM:-commandmatedev}"\n  --cli <l>  commandmatedev launcher (default: $CM, else commandmatedev)\n',
    );
  });
});

describe('forward: D (SKILL.md description)', () => {
  const skill = (n: string) => `---\nname: ${n}\ndescription: 本文だ\n---\n# ${n}\n`;

  it.each(['cmate-delegate', 'cmate-handoff'] as const)('prefixes %s once', (n) => {
    const out = forward('SKILL.md', skill(n));
    expect(out).toContain(`description: ${DESCRIPTION_PREFIX[n]}本文だ`);
    expect(out).toContain(`name: ${n}-dev`);
    expect(out.match(/【開発ブランチ用/g)).toHaveLength(1);
  });

  it('does not touch description in other files (negative control)', () => {
    const t = '---\nname: cmate-delegate\ndescription: x\n---\n';
    expect(forward('references/x.md', t)).not.toContain('【開発ブランチ用');
  });
});

describe('inverse', () => {
  const samples: Array<[string, string]> = [
    ['SKILL.md', '---\nname: cmate-handoff\ndescription: 説明\n---\n# cmate-handoff\nrun commandmate mem list `commandmate`\n'],
    ['SKILL.md', '---\nname: cmate-delegate\ndescription: 説明\n---\nkey cmate-handoff:next:x\n'],
    ['scripts/ask.sh', 'LAUNCHER="${CM:-commandmate}"\n# (default: $CM, else commandmate)\nnpx commandmate@latest\n'],
    ['references/x.md', 'CommandMate commandmate-skills commandmate 0.31.3 fixtures/cmate-delegate/x'],
  ];

  it.each(samples)('round-trips %s', (rel, text) => {
    expect(inverse(rel, forward(rel, text))).toBe(text);
  });

  it('counts commandmatedev only where the rules produced it', () => {
    expect(countDevCli(forward('references/x.md', 'commandmate a, `commandmate`, CommandMate'))).toBe(2);
    expect(countDevCli('commandmate a')).toBe(0);
  });
});

describe('generate: refuses an upstream whose file set is not the declared one (Issue #4323)', () => {
  let tmp: string | null = null;
  afterEach(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    tmp = null;
  });

  const sha = (t: string) => createHash('sha256').update(t).digest('hex');
  const FILES: Record<string, string> = { 'SKILL.md': '---\nname: cmate-handoff\ndescription: d\n---\n', 'references/a.md': 'commandmate send\n' };

  function fixture(omit?: string) {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-skills-gen-'));
    const source = path.join(tmp, 'skills-src');
    const repoRoot = path.join(tmp, 'repo');
    const pinPath = path.join(tmp, 'pin.json');
    // The generator reads every UPSTREAM_PACKAGES entry, so both are faked.
    const manifestOf = (files: Record<string, string>) =>
      `version: 1.0.0\nfiles:\n${Object.entries(files)
        .map(([p, t]) => `  - path: ${p}\n    sha256: ${sha(t)}`)
        .join('\n')}\n`;
    for (const up of ['skills/cmate-delegate', 'skills/cmate-handoff']) {
      const dir = path.join(source, up);
      fs.mkdirSync(path.join(dir, 'references'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'commandmate.skill.yaml'), manifestOf(FILES));
      for (const [p, t] of Object.entries(FILES)) {
        if (p !== omit) fs.writeFileSync(path.join(dir, p), t);
      }
    }
    execFileSync('git', ['init', '-q'], { cwd: source });
    execFileSync('git', ['-c', 'user.email=a@b.c', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'x'], { cwd: source });
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim();
    return { source, repoRoot, pinPath, head };
  }

  const pinOf = (head: string) => ({
    ref: head,
    packages: ['cmate-delegate-dev', 'cmate-handoff-dev'].map((id) => ({
      id,
      upstream: id === 'cmate-delegate-dev' ? 'skills/cmate-delegate' : 'skills/cmate-handoff',
      version: '1.0.0',
      files: Object.entries(FILES).map(([p, t]) => ({ path: p, upstreamSha256: sha(t), outputSha256: 'x' })),
    })),
  });

  function seedRoots(repoRoot: string) {
    for (const root of ['.claude/skills', '.agents/skills']) {
      for (const id of ['cmate-delegate-dev', 'cmate-handoff-dev']) {
        for (const p of Object.keys(FILES)) {
          const abs = path.join(repoRoot, root, id, p);
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, 'ORIGINAL');
        }
      }
    }
  }

  const rootsUntouched = (repoRoot: string) =>
    ['.claude/skills', '.agents/skills'].every((root) =>
      ['cmate-delegate-dev', 'cmate-handoff-dev'].every((id) =>
        Object.keys(FILES).every((p) => fs.readFileSync(path.join(repoRoot, root, id, p), 'utf8') === 'ORIGINAL'),
      ),
    );

  it('(1) a declared file missing from upstream (no --ref) fails and writes nothing', () => {
    const { source, repoRoot, pinPath, head } = fixture('references/a.md');
    seedRoots(repoRoot);
    fs.writeFileSync(pinPath, JSON.stringify(pinOf(head)));
    const before = fs.readFileSync(pinPath, 'utf8');
    expect(() => generate({ source, repoRoot, pinPath })).toThrow(/references\/a\.md/);
    expect(rootsUntouched(repoRoot)).toBe(true);
    expect(fs.readFileSync(pinPath, 'utf8')).toBe(before);
  });

  it('(2) --ref with a declared file missing must not shrink the pin', () => {
    const { source, repoRoot, pinPath, head } = fixture('references/a.md');
    seedRoots(repoRoot);
    fs.writeFileSync(pinPath, JSON.stringify(pinOf(head)));
    const before = fs.readFileSync(pinPath, 'utf8');
    expect(() => generate({ source, repoRoot, pinPath, ref: head })).toThrow(/references\/a\.md/);
    expect(rootsUntouched(repoRoot)).toBe(true);
    expect(fs.readFileSync(pinPath, 'utf8')).toBe(before);
  });

  it('(negative control) a complete upstream still generates both roots', () => {
    const { source, repoRoot, pinPath, head } = fixture();
    seedRoots(repoRoot);
    fs.writeFileSync(pinPath, JSON.stringify(pinOf(head)));
    generate({ source, repoRoot, pinPath, ref: head });
    for (const root of ['.claude/skills', '.agents/skills']) {
      expect(fs.readFileSync(path.join(repoRoot, root, 'cmate-handoff-dev/references/a.md'), 'utf8')).toBe(
        'commandmatedev send\n',
      );
    }
  });
});
