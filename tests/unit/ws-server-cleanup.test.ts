/**
 * WebSocket server cleanup unit tests
 * Issue #69: Repository delete feature
 * TDD Approach: Write tests first (Red), then implement (Green), then refactor
 *
 * ## Issue #1977: なぜ `@/lib/cli-tools/manager` を stub するのか
 *
 * `cleanupRooms` が触るのは `ws-server.ts` のモジュールスコープにある `rooms` /
 * `clients` の 2 つの Map だけで、CLI ツールにも DB にも tmux にも触らない。
 * それなのに `import('@/lib/ws-server')` は 1160ms かかっていた。冷えた worker で
 * import を 1 本ずつ計測した内訳:
 *
 *     ws-server 1160ms
 *       ├─ @/lib/db/db-instance          249ms
 *       └─ @/lib/cli-tools/manager       658-1046ms
 *            └─ @/lib/polling/response-poller   997ms
 *                 └─ @/lib/polling/response-checker   915ms
 *                      ├─ @/lib/session/cli-session   996ms  ← 実際の底
 *                      └─ @/lib/ws-server             (循環)
 *
 * `manager.ts` がこのグラフを引くのは `stopPollers()` の中の 1 行
 * （`stopResponsePolling(...)`, manager.ts:181）のためだけで、`ws-server` は
 * `CLIToolManager.getInstance().getTool()` を **ハンドラの中でしか**呼ばない
 * （ws-server.ts:695 / :958）。つまり module load 時には 1 つも要らない。
 *
 * 本来は本番側の import グラフを直したいが、循環を切れる辺
 * （`response-poller-core → response-checker` / `response-checker → ws-server`）は
 * どちらも本 Issue の scope 外で、scope 内で切れる 2 辺はいずれも同期 API を
 * 非同期化する必要がある（詳細は commit message / dev-reports/issue-1977-findings.md）。
 * ここでは unit テストとして正しい形 — 対象が使わない依存を stub する — を採る。
 * 実測: import 1160ms -> 372ms。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Issue #1977: 使われたら黙って通さず、理由つきで落とす。`cleanupRooms` は
// CLI ツールを一切呼ばないので、この throw に到達するのは「このファイルが
// stub していない前提のテストを増やした」ときだけ。
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => {
      throw new Error(
        'tests/unit/ws-server-cleanup.test.ts stubs @/lib/cli-tools/manager (Issue #1977): ' +
          'cleanupRooms touches only the room/client maps, so the real manager — which drags in ' +
          'response-poller -> response-checker -> cli-session — is not loaded here. ' +
          'A test that needs a real CLI tool belongs in a file that does not stub it.'
      );
    },
  },
}));

// We need to test cleanupRooms function behavior
// Since ws-server uses global state, we test through the exported functions
//
// Issue #1977: `await import()` を `it()` の中で 3 回やっていたが、モジュール
// ロードは 1 回きりの固定費で、最初に走った `it()` が全額を払っていた
// （負荷下フル実行で 2.67-3.33s の全部がこの 1 テスト）。静的 import に変更。
import { cleanupRooms } from '@/lib/ws-server';

describe('WebSocket Server cleanupRooms', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should be exported from ws-server', () => {
    expect(typeof cleanupRooms).toBe('function');
  });

  it('should accept an array of worktree IDs', () => {
    // cleanupRooms should not throw when called with empty array
    expect(() => cleanupRooms([])).not.toThrow();
  });

  it('should handle non-existent rooms gracefully', () => {
    // Should not throw when cleaning up rooms that don't exist
    expect(() => cleanupRooms(['non-existent-1', 'non-existent-2'])).not.toThrow();
  });
});
