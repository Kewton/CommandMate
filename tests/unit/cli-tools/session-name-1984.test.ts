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

import { describe, it, expect, vi, afterEach } from 'vitest';
import { CLIToolManager } from '@/lib/cli-tools/manager';
import { CLI_TOOL_IDS } from '@/lib/cli-tools/types';
import {
  parseSessionName,
  resolveLegacySessionName,
  resolveNamespacedSessionName,
  resolveSessionName,
  setActiveSessionNamespace,
} from '@/lib/cli-tools/session-name';
import {
  clearLegacyAliasesForTests,
  dropLegacyAliasByLegacyName,
  registerLegacyAlias,
} from '@/lib/tmux/legacy-session-alias';

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
    expect(CLI_TOOL_IDS.length).toBe(8);
    expect(WORKTREE_IDS.length * 4 * CLI_TOOL_IDS.length).toBe(96);
  });
});

// ---------------------------------------------------------------------------
// Issue #2866: server namespace, legacy names and the parser
// ---------------------------------------------------------------------------

describe('session names with a server namespace (Issue #2866)', () => {
  const NS = '0a1b2c3d';

  afterEach(() => {
    setActiveSessionNamespace(null);
    clearLegacyAliasesForTests();
  });

  it('keeps the legacy form while no namespace is set', () => {
    expect(resolveSessionName('claude', 'feature-foo')).toBe('mcbd-claude-feature-foo');
    expect(resolveSessionName('codex', 'wt-1', 'codex-review')).toBe('mcbd-codex-wt-1-review');
  });

  it('puts the namespace after mcbd- once set (primary and additional instances)', () => {
    setActiveSessionNamespace(NS);
    expect(resolveSessionName('claude', 'feature-foo')).toBe(`mcbd-${NS}-claude-feature-foo`);
    expect(resolveSessionName('claude', 'feature-foo', 'claude')).toBe(`mcbd-${NS}-claude-feature-foo`);
    expect(resolveSessionName('claude', 'feature-foo', 'claude-2')).toBe(`mcbd-${NS}-claude-feature-foo-2`);
    expect(resolveSessionName('vibe-local', 'wt-1', 'vibe-local-review')).toBe(
      `mcbd-${NS}-vibe-local-wt-1-review`
    );
  });

  it('every tool still agrees with the rule under a namespace', () => {
    setActiveSessionNamespace(NS);
    const manager = CLIToolManager.getInstance();
    for (const toolId of CLI_TOOL_IDS) {
      expect(manager.getTool(toolId).getSessionName('wt-1', `${toolId}-2`)).toBe(
        resolveSessionName(toolId, 'wt-1', `${toolId}-2`)
      );
    }
  });

  it('returns the adopted legacy name while an alias is registered', () => {
    setActiveSessionNamespace(NS);
    registerLegacyAlias(`mcbd-${NS}-claude-wt-1`, 'mcbd-claude-wt-1');

    expect(resolveSessionName('claude', 'wt-1')).toBe('mcbd-claude-wt-1');
    // Only the aliased name is affected.
    expect(resolveSessionName('claude', 'wt-1', 'claude-2')).toBe(`mcbd-${NS}-claude-wt-1-2`);

    dropLegacyAliasByLegacyName('mcbd-claude-wt-1');
    expect(resolveSessionName('claude', 'wt-1')).toBe(`mcbd-${NS}-claude-wt-1`);
  });

  it('resolveLegacySessionName is always the legacy form', () => {
    expect(resolveLegacySessionName('claude', 'wt-1')).toBe('mcbd-claude-wt-1');
    setActiveSessionNamespace(NS);
    expect(resolveLegacySessionName('claude', 'wt-1')).toBe('mcbd-claude-wt-1');
    expect(resolveLegacySessionName('codex', 'wt-1', 'codex-2')).toBe('mcbd-codex-wt-1-2');
  });

  it('refuses an ill-formed namespace', () => {
    expect(() => setActiveSessionNamespace('ABCDEF01')).toThrow(/Invalid session namespace/);
  });
});

describe('parseSessionName (Issue #2866)', () => {
  it('reads the legacy form', () => {
    expect(parseSessionName('mcbd-claude-wt-1')).toEqual({ namespace: null, cliToolId: 'claude', rest: 'wt-1' });
  });

  it('reads the namespaced form', () => {
    expect(parseSessionName('mcbd-0a1b2c3d-codex-wt-1')).toEqual({
      namespace: '0a1b2c3d',
      cliToolId: 'codex',
      rest: 'wt-1',
    });
  });

  it('keeps a suffix and hyphenated worktree IDs in rest', () => {
    expect(parseSessionName('mcbd-claude-feature-foo-bar-2')).toEqual({
      namespace: null,
      cliToolId: 'claude',
      rest: 'feature-foo-bar-2',
    });
    expect(parseSessionName('mcbd-0a1b2c3d-claude-feature-foo-review')).toEqual({
      namespace: '0a1b2c3d',
      cliToolId: 'claude',
      rest: 'feature-foo-review',
    });
  });

  it('reads a hyphenated tool id whole, not as a shorter one', () => {
    expect(parseSessionName('mcbd-vibe-local-wt')?.cliToolId).toBe('vibe-local');
    expect(parseSessionName('mcbd-0a1b2c3d-command-code-wt')).toEqual({
      namespace: '0a1b2c3d',
      cliToolId: 'command-code',
      rest: 'wt',
    });
  });

  it('round-trips what resolveNamespacedSessionName builds', () => {
    for (const toolId of CLI_TOOL_IDS) {
      for (const ns of [null, 'deadbeef']) {
        const name = resolveNamespacedSessionName(ns, toolId, 'a-b', `${toolId}-2`);
        expect(parseSessionName(name)).toEqual({ namespace: ns, cliToolId: toolId, rest: 'a-b-2' });
      }
    }
  });

  it('returns null for non-CommandMate names and unknown tools', () => {
    expect(parseSessionName('my-editor')).toBeNull();
    expect(parseSessionName('xmcbd-claude-wt')).toBeNull();
    expect(parseSessionName('mcbd-unknowncli-wt')).toBeNull();
    expect(parseSessionName('mcbd-0a1b2c3d-unknowncli-wt')).toBeNull();
    expect(parseSessionName('mcbd-claude-')).toBeNull();
    expect(parseSessionName('mcbd-0a1b2c3d')).toBeNull();
    // An upper-case "namespace" is not one: the tool slot then fails.
    expect(parseSessionName('mcbd-0A1B2C3D-claude-wt')).toBeNull();
  });
});
