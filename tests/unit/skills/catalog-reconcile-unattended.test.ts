/**
 * Issue #3159: `/catalog-reconcile` has an unattended section that the
 * agent-health dispatch points catalog-drift workers at. The skill stays
 * user-invoked only, and the section names all seven items of the Issue's table.
 */

import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const skill = readFileSync(path.resolve(__dirname, '../../../.claude/skills/catalog-reconcile/SKILL.md'), 'utf8');

function section(heading: string): string {
  const start = skill.indexOf(`\n## ${heading}\n`);
  expect(start).toBeGreaterThan(-1);
  const end = skill.indexOf('\n## ', start + 1);
  return skill.slice(start, end === -1 ? undefined : end);
}

describe('catalog-reconcile unattended section (#3159)', () => {
  it('keeps the skill out of model invocation', () => {
    expect(skill).toMatch(/^disable-model-invocation: true$/m);
  });

  it('lists the seven items of the unattended table', () => {
    const body = section('無人実行（agent-health からの依頼）');
    const rows = [
      '| ja 訳・en の文体 |',
      '| `description-conflict` |',
      '| 除外の追加・変更・削除 |',
      '| attestation（claude / codex） |',
      '| attestation（antigravity / command-code / copilot / opencode-v2） |',
      '| opencode 1.x・copilot の実機照合（Phase 4-4） |',
      '| `npm run build` |',
    ];
    for (const row of rows) expect(body).toContain(row);
    expect(body).toContain('`[要レビュー]` が 0 件になるまで終わらない');
    expect(body).toContain('候補だけで残りが無ければ PR を作らずに止まる');
    expect(body).toContain('**カタログから写さない**');
    expect(body).toContain('「無人実行」と書き');
  });
});
