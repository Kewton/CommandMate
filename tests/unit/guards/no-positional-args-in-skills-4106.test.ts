/**
 * #4106: スラッシュコマンド / スキルの本文では `$0`〜`$9` が引数の位置指定として
 * 置き換えられる（`/release v0.49.3` の `index($0, v)` が `index(v0.49.3, v)` になる等）。
 * 本文に `$<数字>` を書かない。
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '../../..');
const POSITIONAL = /\$\d+(?!\w)/;

function findPositionalLines(text: string): number[] {
  return text
    .split('\n')
    .flatMap((line, i) => (POSITIONAL.test(line) ? [i + 1] : []));
}

function targets(): string[] {
  const cmds = fs
    .readdirSync(path.join(ROOT, '.claude/commands'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => `.claude/commands/${f}`);
  const skills = fs
    .readdirSync(path.join(ROOT, '.claude/skills'), { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(ROOT, '.claude/skills', d.name, 'SKILL.md')))
    .map((d) => `.claude/skills/${d.name}/SKILL.md`);
  return [...cmds, ...skills];
}

describe('no positional args ($0..$9) in command / skill bodies (#4106)', () => {
  it('scans at least the known files', () => {
    const t = targets();
    expect(t).toContain('.claude/commands/orchestrate.md');
    expect(t).toContain('.claude/skills/release/SKILL.md');
  });

  it.each(targets())('%s has no $<digit>', (rel) => {
    const lines = findPositionalLines(fs.readFileSync(path.join(ROOT, rel), 'utf-8'));
    expect(lines, `${rel}: lines ${lines.join(',')}`).toEqual([]);
  });

  it('negative control: detects $0 / $1 / $12 in fixtures', () => {
    expect(findPositionalLines('a\nsource "$(dirname "$0")/x"\n')).toEqual([2]);
    expect(findPositionalLines("awk '{print $4}'")).toEqual([1]);
    expect(findPositionalLines('x --worktree "$1" --model "$2"')).toEqual([1]);
  });

  it('negative control: does not flag ${VAR}, $ARGUMENTS, $VAR1 or $$', () => {
    expect(findPositionalLines('echo "${NEXT_VERSION}" $ARGUMENTS $VAR1 ${1:-x}')).toEqual([]);
    expect(findPositionalLines('price $5abc')).toEqual([]);
  });
});
