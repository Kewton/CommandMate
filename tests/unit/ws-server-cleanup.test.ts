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
 *
 * ## Issue #1984: 本番側の import グラフが直った
 *
 * #1977 が scope 外として見送った「本来やりたいこと」を #1984 が実施し、
 * `ws-server` はもう `@/lib/cli-tools/manager` を静的 import しない
 * （必要なのはセッション名の規則だけなので `cli-tools/session-name` を引く）。
 * `manager -> polling/response-poller` も `await import()` になった。
 * 実測: `import('@/lib/ws-server')` 1043ms -> 228ms、
 * `import('@/lib/cli-tools/manager')` 1025ms -> 417ms。
 *
 * よって下の stub は**もう何も塞いでいない** — `manager` は `ws-server` の依存グラフに
 * 居ない。stub を残すと「これが無いと遅い」という誤った説明になるので外し、
 * 代わりに *manager がグラフに居ないこと自体* を下のテストで名指しする。
 * 循環そのものの検査は tests/unit/guards/no-ws-server-manager-cycle-1984.test.ts。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

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

  /**
   * Issue #1984: この 3 本が速いのは stub のおかげ **ではない** — `ws-server` が
   * 本当に manager を引かなくなったから。stub を消したうえで、消せた理由の側を
   * 直接名指ししておく（これが戻れば import は 1000ms 台に戻る）。
   */
  it('loads ws-server without the CLI tool manager in its module graph', () => {
    const source = readFileSync(join(process.cwd(), 'src/lib/ws-server.ts'), 'utf-8');

    // 陽性対照: この正規表現が静的 import を実際に拾えることを、現に在る 1 本で確かめる。
    expect(source).toMatch(/^\s*import\s[^\n]*from\s*'\.\/cli-tools\/types';/m);
    expect(source).not.toMatch(/^\s*import\s[^\n]*from\s*'[^']*cli-tools\/manager'/m);
  });
});
