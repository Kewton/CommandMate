/**
 * The development team document exists and is linked from its entry points (Issue #4239).
 * @vitest-environment node
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../../..');
const read = (p: string): string => fs.readFileSync(path.join(ROOT, p), 'utf8');

describe('docs/orchestrate/team.md (#4239)', () => {
  const team = read('docs/orchestrate/team.md');

  it('lists every role and instance', () => {
    for (const w of ['project-manager', 'enabler', 'judge', 'dev-leader', '`claude-2`', '`claude-3`', '`codex-2`']) {
      expect(team).toContain(w);
    }
    expect(team).toContain('易＝Command Code（#4238）');
  });

  it('states the flow, brief shape and overlap order', () => {
    expect(team).toContain('PM はワーカーへ直接送らない');
    expect(team).toContain('開発リーダーは利用者へ直接聞かない');
    expect(team).toContain('`DONE:`');
    expect(team).toContain('並行して 2 つの run を回さない');
  });

  it('is linked from orchestrate.md, CLAUDE.md and agent-health.md', () => {
    expect(read('.claude/commands/orchestrate.md')).toContain('docs/orchestrate/team.md#2-流れ');
    expect(read('CLAUDE.md')).toContain('./docs/orchestrate/team.md');
    const ah = read('docs/user-guide/agent-health.md');
    expect(ah).toContain('../orchestrate/team.md');
    expect(ah).not.toContain('この用途の専用');
  });
});
