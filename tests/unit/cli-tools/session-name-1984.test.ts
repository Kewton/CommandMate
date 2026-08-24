/**
 * セッション名の規則は 1 箇所にある（Issue #1984）。
 *
 * ## なぜこのモジュールを切り出したか
 *
 * `mcbd-{tool}-{worktree}[-{suffix}]` を決めているのは `BaseCLITool.getSessionName()`
 * ただ 1 つで、7 つの具象ツールはどれも override していない。それなのに
 * 「名前だけが欲しい」呼び出し側は `CLIToolManager.getInstance().getTool(id)` を
 * 通るしかなく、7 ツールの実装（tmux / child_process / composer spec …）を
 * **モジュールロード時に**引かされていた。`ws-server.ts` がそれで、
 * `@/lib/cli-tools/manager` への静的 import は
 * `ws-server -> manager -> polling/response-poller -> ... -> ws-server` という
 * モジュールスコープの循環の一辺でもあった。実測でこの 1 辺が
 * `import('@/lib/ws-server')` の 458ms のうち 234ms を占めていた（1043 -> 458 -> 228ms）。
 *
 * ## このファイルが守る性質
 *
 * 切り出しは「規則が 2 つになった」ときにだけ危険になる。`base.ts` を直して
 * `session-name.ts` を直し忘れれば（あるいはその逆）、`ws-server` の付ける名前と
 * ツールが付ける名前が食い違い、**存在しない tmux セッションを購読しにいく**。
 * したがって固定するのは値そのものではなく、
 * **7 ツール全部で `tool.getSessionName(...) === resolveSessionName(tool.id, ...)`** という
 * 同値性である。値そのものは tests/unit/cli-tools/base.test.ts が押さえている。
 */

import { describe, it, expect, vi } from 'vitest';
import { CLIToolManager } from '@/lib/cli-tools/manager';
import { CLI_TOOL_IDS } from '@/lib/cli-tools/types';
import { resolveSessionName } from '@/lib/cli-tools/session-name';

// `manager` を import するだけで poller グラフを引かないための stub（#1984 で
// 静的 import は切れているが、`stopPollers()` の遅延 import 先はここで塞いでおく）。
vi.mock('@/lib/polling/response-poller', () => ({ stopPolling: vi.fn() }));

const WORKTREE_IDS = ['wt-1', 'feature-foo', 'a_b-9'];

describe('resolveSessionName (Issue #1984)', () => {
  it('produces the documented shape for the primary instance', () => {
    expect(resolveSessionName('claude', 'feature-foo')).toBe('mcbd-claude-feature-foo');
    expect(resolveSessionName('claude', 'feature-foo', 'claude')).toBe('mcbd-claude-feature-foo');
  });

  it('appends the instance suffix, with the tool prefix stripped (#868)', () => {
    expect(resolveSessionName('claude', 'feature-foo', 'claude-2')).toBe('mcbd-claude-feature-foo-2');
    expect(resolveSessionName('codex', 'wt-1', 'codex-review')).toBe('mcbd-codex-wt-1-review');
  });

  it('refuses a name that would carry shell metacharacters (T2.3 / MF4-001)', () => {
    expect(() => resolveSessionName('claude', 'feature/foo')).toThrow(/Invalid session name format/);
    expect(() => resolveSessionName('claude', 'wt; rm -rf /')).toThrow(/Invalid session name format/);
  });

  it('agrees with every tool implementation, so the rule has one source', () => {
    const manager = CLIToolManager.getInstance();
    const disagreements: string[] = [];

    for (const toolId of CLI_TOOL_IDS) {
      const tool = manager.getTool(toolId);
      for (const worktreeId of WORKTREE_IDS) {
        for (const instanceId of [undefined, toolId, `${toolId}-2`, `${toolId}-review`]) {
          const viaTool = tool.getSessionName(worktreeId, instanceId);
          const viaRule = resolveSessionName(toolId, worktreeId, instanceId);
          if (viaTool !== viaRule) {
            disagreements.push(`${toolId}/${worktreeId}/${instanceId ?? '-'}: ${viaTool} !== ${viaRule}`);
          }
        }
      }
    }

    expect(disagreements).toEqual([]);
  });

  it('compares a non-empty set of names (guards the loop above against a no-op)', () => {
    // CLI_TOOL_IDS が空になったり getTool が全部落ちたりすれば、上のループは
    // 0 回まわって緑になる。回数を名指ししておく。
    expect(CLI_TOOL_IDS.length).toBe(7);
    expect(WORKTREE_IDS.length * 4 * CLI_TOOL_IDS.length).toBe(84);
  });
});
