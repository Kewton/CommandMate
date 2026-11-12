/**
 * Unit tests for the -dev skill transform (Issue #4323).
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';
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
