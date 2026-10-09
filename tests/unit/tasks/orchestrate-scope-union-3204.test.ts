import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const orchestrate = readFileSync(join(process.cwd(), '.claude/commands/orchestrate.md'), 'utf-8');

// Since #3481 (2 本目) the run-time-optional procedures live in docs/orchestrate/; the body section points there.
/** The `## <heading>` section of docs/orchestrate/<file>, up to the next `## ` heading. */
function docSection(file: string, heading: string): string {
  const doc = readFileSync(join(process.cwd(), 'docs/orchestrate', file), 'utf-8');
  const start = doc.indexOf(`\n## ${heading}\n`);
  expect(start, `docs/orchestrate/${file} has no \`## ${heading}\``).toBeGreaterThanOrEqual(0);
  const end = doc.indexOf('\n## ', start + 1);
  return doc.slice(start, end === -1 ? undefined : end);
}

/** The text between a section heading and the next heading of the same depth. */
function section(heading: string): string {
  const start = orchestrate.indexOf(heading);
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = orchestrate.slice(start + heading.length);
  const next = rest.search(/\n### /);
  return next === -1 ? rest : rest.slice(0, next);
}

describe('orchestrate.md: 同じブランチに契約を積むときの scope.allow (#3204)', () => {
  it('2-4 に、前の契約の allow との和集合にする項がある', () => {
    const s = section('### 2-4. 実行契約の起案');
    expect(s).toContain('同じブランチに契約を積むとき');
    expect(s).toContain('前の契約の allow との和集合');
    expect(s).toContain('ブランチ全体の差分');
  });

  it('3-4 に、前の契約のファイルによる scope の違反はワーカー起因ではないと書いてある', () => {
    const s = `${section('### 3-4. exit code 分岐')}\n${docSection('exit-codes.md', '3-4 20 の対応')}`;
    expect(s).toContain('同じブランチの前の契約のコミットで入ったファイル');
    expect(s).toContain('git show --name-only <この契約のコミット>');
  });

  it('陰性対照: scope 違反は、原則としてワーカー起因のまま', () => {
    const s = `${section('### 3-4. exit code 分岐')}\n${docSection('exit-codes.md', '3-4 20 の対応')}`;
    expect(s).toContain('`scope` 違反、`work-evidence` の不足');
  });
});
