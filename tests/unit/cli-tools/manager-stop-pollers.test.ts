/**
 * Unit tests for CLIToolManager.stopPollers()
 * Issue #4: T2.4 - Stop pollers method (MF1-001)
 *
 * ## Issue #1984: 同期 `void` から `Promise<void>` へ
 *
 * `stopPollers()` は `../polling/response-poller` を**静的**に import していた 1 行で、
 * これが `ws-server -> cli-tools/manager -> polling/response-poller ->
 * polling/response-poller-core -> polling/response-checker -> ws-server` という
 * モジュールスコープの循環の一辺だった（`manager` を通る循環 8 本すべてがこの辺を通る）。
 * `await import()` に置き換えて切ったため、戻り値が Promise になっている。
 *
 * 順序の側 — 呼び出し元が `await` を付けているか — は
 * tests/unit/api/kill-session-stop-pollers-order-1984.test.ts が実際の副作用の順序で
 * 固定する。ここで固定するのは委譲そのものと、**Promise を返すこと**（`async` を
 * 外されたら呼び出し元の `await` が意味を失うので、その形をここで押さえる）。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { CLIToolManager } from '@/lib/cli-tools/manager';

// Mock response-poller
vi.mock('@/lib/polling/response-poller', () => ({
  stopPolling: vi.fn(),
}));

describe('CLIToolManager.stopPollers (T2.4 - MF1-001)', () => {
  let manager: CLIToolManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = CLIToolManager.getInstance();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should have stopPollers method', () => {
    expect(typeof manager.stopPollers).toBe('function');
  });

  it('should stop response-poller for any CLI tool', async () => {
    const { stopPolling } = await import('@/lib/polling/response-poller');

    await manager.stopPollers('test-worktree', 'codex');

    // Issue #868: stopPollers forwards an optional instanceId (undefined → primary).
    expect(stopPolling).toHaveBeenCalledWith('test-worktree', 'codex', undefined);
  });

  it('should forward an explicit instance id', async () => {
    const { stopPolling } = await import('@/lib/polling/response-poller');

    await manager.stopPollers('test-worktree', 'codex', 'codex-2');

    expect(stopPolling).toHaveBeenCalledWith('test-worktree', 'codex', 'codex-2');
  });

  /**
   * Issue #1984: 返り値の形。`async` を外して同期に戻されると呼び出し元の `await` が
   * 無意味になり（`await undefined` は通ってしまう）、順序テストだけでは
   * 「なぜ壊れたか」が読み取りにくい。ここで形を名指ししておく。
   */
  it('returns a promise, so callers can order work after the stop', () => {
    const returned = manager.stopPollers('test-worktree', 'codex');

    expect(returned).toBeInstanceOf(Promise);
    return returned;
  });

  /**
   * Issue #1984: 遅延ロードは「速いから」ではなく「循環を切るため」に選んだので、
   * 静的 import に戻されたことが分かるようにする。循環そのものの検査は
   * tests/unit/guards/no-ws-server-manager-cycle-1984.test.ts。
   */
  it('does not reach response-poller through a module-scope import', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/lib/cli-tools/manager.ts'),
      'utf-8'
    );

    // 陽性対照: この正規表現が静的 import を実際に拾えることを、同ファイルに
    // 現に在る静的 import 1 本で確かめてから 0 件を主張する。
    expect(source).toMatch(/^\s*import\s+\{[^}]*\}\s*from\s*'\.\/claude';/m);
    expect(source).not.toMatch(/^\s*import\s[^\n]*from\s*'[^']*polling\/response-poller'/m);
    expect(source).toMatch(/await import\('\.\.\/polling\/response-poller'\)/);
  });
});
