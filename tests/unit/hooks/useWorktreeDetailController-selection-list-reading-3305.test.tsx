/**
 * useWorktreeDetailController が、選択リストの読み取りを公開する（Issue #3305）
 *
 * スマホのドックの選択リストの操作は、`WorktreeDetailRefactored` にある。この画面は
 * フレームを持たない（#736）。ドックは History / Files / Tools のタブでも出たままなので、
 * ターミナルのタブ（`MobileTerminalTab`）が持つフレームにも頼れない — タブを移った時点で
 * タブはアンマウントされ、「このセッションのみ」と注意文が消えて、既定のモデルを書き換える
 * ラベルの無い Enter が戻っていた。
 *
 * そこで、タブに関係なく走っている controller の `/current-output` poll が、応答の
 * フレームを `readSelectionListFrame` で読み、読み取り（4 つの欄）だけを state にする。
 *
 * ここで固定するもの:
 *  1. フラグ（`isSelectionListActive`）と読み取りは、同じ 1 つの応答から同時に届く。
 *     「フラグは立ったが、読み取りはまだ前の画面のもの」という描画が無い
 *  2. 読むのは、チャット面のカードと PC のフッタが読むのと同じフレーム（`fullOutput`）
 *  3. 選択リストでない応答のフレームは読まない（本文の `1.` `2.` を番号キーにしない）
 *  4. 前と同じ読み取りなら、同じ object のまま（poll のたびに画面を描き直さない）。
 *     フレームそのものを持っていたら、ハイライトが動くたびに変わる
 *
 * フレーム本体を公開しないことは、#2809 の suite
 * （`useWorktreeDetailController-plan-review-2809.test.tsx`）が固定している。
 *
 * @vitest-environment jsdom
 */

import { useEffect } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import fs from 'fs';
import path from 'path';

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => '/worktrees/wt-3305-reading',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: () => true,
  MOBILE_BREAKPOINT: 768,
}));

vi.mock('@/contexts/SidebarContext', () => ({
  useSidebarContext: () => ({
    isOpen: true,
    width: 288,
    isMobileDrawerOpen: false,
    toggle: vi.fn(),
    setWidth: vi.fn(),
    openMobileDrawer: vi.fn(),
    closeMobileDrawer: vi.fn(),
  }),
}));

vi.mock('@/components/providers/WorktreesCacheProvider', () => ({
  useOptionalWorktreesCacheContext: () => null,
}));

import { useWorktreeDetailController } from '@/hooks/useWorktreeDetailController';
import {
  NO_SELECTION_LIST_READING,
  readSelectionListFrame,
  type SelectionListReading,
} from '@/lib/session/selection-list-ops';
import { stripAnsi } from '@/lib/detection/ansi';

const FIXTURES = path.resolve(__dirname, '../../fixtures/chat-dialog-card-2254');
const capture = (name: string): string => fs.readFileSync(path.join(FIXTURES, name), 'utf-8');

/** claude の `/model`: `Enter to set as default · s to use this session only · Esc to cancel`。 */
const CLAUDE_MODEL = capture('claude-model-2-1-259.txt');
/** codex の `/model`: 番号つきの 7 件。 */
const CODEX_MODEL = capture('codex-model-0-151-0.txt');
/** claude のフォルダの信頼: 番号も、セッションだけの確定も無い。 */
const CLAUDE_TRUST = capture('claude-trust-2-1-259.txt');

const ESC = '\u001b';
/** 同じ `/model` で、ハイライト（`❯`）だけを 2 番目から 3 番目へ動かしたフレーム。 */
const CLAUDE_MODEL_CURSOR_MOVED = CLAUDE_MODEL.replace(
  `${ESC}[38;5;153m❯${ESC}[39m ${ESC}[38;5;246m2. `,
  `  ${ESC}[38;5;246m2. `,
).replace(`     ${ESC}[38;5;246m3. `, `   ${ESC}[38;5;153m❯${ESC}[39m ${ESC}[38;5;246m3. `);

const CLAUDE_MODEL_READING: SelectionListReading = {
  numberKeyCount: 0,
  offersSessionScope: true,
  commitsDefaultOnEnter: true,
  offersPlanApprove: false,
};

const WORKTREE_ID = 'wt-3305-reading';

/** `/current-output` の答え。テストの途中で差し替えられる。 */
let currentOutput: Record<string, unknown> = {};
let currentOutputCalls = 0;

beforeEach(() => {
  window.localStorage.clear();
  currentOutput = {};
  currentOutputCalls = 0;
  global.fetch = vi.fn((url: string) => {
    if (url.includes('/current-output')) {
      currentOutputCalls += 1;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ isRunning: true, ...currentOutput }),
      });
    }
    if (url.includes('/messages')) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          id: WORKTREE_ID,
          name: 'feature/3305',
          path: '/tmp/wt',
          repositoryPath: '/tmp/repo',
          repositoryName: 'CommandMate',
        }),
    });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** 1 回の描画で controller が返した、フラグと読み取りの組。 */
type Seen = { active: boolean; reading: SelectionListReading };

/** controller を描き、最初の `/current-output` の応答が反映されるまで待つ。 */
async function renderController() {
  const seen: Seen[] = [];
  let commits = 0;
  const hook = renderHook(() => {
    // 依存配列の無い effect は commit のたびに走る。React が「値が同じ」と見て打ち切った
    // 描画は commit されないので、数に入らない。
    useEffect(() => {
      commits += 1;
    });
    const controller = useWorktreeDetailController({ worktreeId: WORKTREE_ID });
    seen.push({ active: controller.isSelectionListActive, reading: controller.selectionListReading });
    return controller;
  });
  await waitFor(() => {
    expect(currentOutputCalls).toBeGreaterThan(0);
    expect(hook.result.current.loading).toBe(false);
  });
  // 最初の読み込みに続く更新が出つくすまで待つ。
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  return { ...hook, seen, commits: () => commits };
}

describe('[#3305] useWorktreeDetailController.selectionListReading', () => {
  it('poll の前は「何も無い」の読み取り', () => {
    currentOutput = { isSelectionListActive: true, fullOutput: CLAUDE_MODEL };
    const { result } = renderHook(() => useWorktreeDetailController({ worktreeId: WORKTREE_ID }));

    expect(result.current.selectionListReading).toBe(NO_SELECTION_LIST_READING);
  });

  it('claude の /model の応答: セッションだけの確定がある、Enter は既定を書き換える、と読む', async () => {
    currentOutput = { isSelectionListActive: true, fullOutput: CLAUDE_MODEL };
    const { result } = await renderController();

    expect(result.current.isSelectionListActive).toBe(true);
    expect(result.current.selectionListReading).toEqual(CLAUDE_MODEL_READING);
  });

  it('フラグと読み取りは同時に届く: フラグが立っている描画で、読み取りが前のままのことは無い', async () => {
    currentOutput = { isSelectionListActive: true, fullOutput: CLAUDE_MODEL };
    const { seen } = await renderController();

    const whileActive = seen.filter((entry) => entry.active);
    expect(whileActive.length).toBeGreaterThan(0);
    for (const entry of whileActive) {
      expect(entry.reading).toEqual(CLAUDE_MODEL_READING);
    }
  });

  it('選択リストが別の画面に替わったときも、フラグの立った描画はどれも、その応答の読み取りを持つ', async () => {
    currentOutput = { isSelectionListActive: true, fullOutput: CODEX_MODEL };
    const { result, seen } = await renderController();
    expect(result.current.selectionListReading.numberKeyCount).toBe(7);
    const before = seen.length;

    currentOutput = { isSelectionListActive: true, fullOutput: CLAUDE_MODEL };
    await act(async () => {
      await result.current.fetchCurrentOutput();
    });

    expect(result.current.selectionListReading).toEqual(CLAUDE_MODEL_READING);
    // 替わった後の描画に、番号キー 7 つ（前の画面）と claude のフッタが混ざったものが無い。
    for (const entry of seen.slice(before)) {
      expect([7, 0]).toContain(entry.reading.numberKeyCount);
      expect(entry.reading.offersSessionScope).toBe(entry.reading.numberKeyCount === 0);
    }
  });
});

describe('[#3305] 読むフレームは、チャット面のカードと PC のフッタが読むのと同じ `fullOutput`', () => {
  it('`fullOutput` を読む（`realtimeSnippet` が別の画面でも）', async () => {
    currentOutput = {
      isSelectionListActive: true,
      fullOutput: CODEX_MODEL,
      realtimeSnippet: CLAUDE_TRUST,
    };
    const { result } = await renderController();

    expect(result.current.selectionListReading).toEqual(readSelectionListFrame(CODEX_MODEL));
    expect(result.current.selectionListReading.numberKeyCount).toBe(7);
  });

  it('`fullOutput` の無い応答では `realtimeSnippet` を読む', async () => {
    currentOutput = { isSelectionListActive: true, realtimeSnippet: CODEX_MODEL };
    const { result } = await renderController();

    expect(result.current.selectionListReading.numberKeyCount).toBe(7);
  });

  it('フレームの無い応答では「何も無い」の読み取り（今までどおりの pad になる）', async () => {
    currentOutput = { isSelectionListActive: true };
    const { result } = await renderController();

    expect(result.current.isSelectionListActive).toBe(true);
    expect(result.current.selectionListReading).toBe(NO_SELECTION_LIST_READING);
  });
});

describe('[#3305] 選択リストでない応答のフレームは読まない', () => {
  // 陰性対照。本文に `1.` `2.` のある普通の画面は、選択肢を出していない。
  it('番号つきのフレームでも、`isSelectionListActive` が false なら「何も無い」の読み取り', async () => {
    currentOutput = { isSelectionListActive: false, fullOutput: CODEX_MODEL };
    const { result } = await renderController();

    expect(result.current.isSelectionListActive).toBe(false);
    expect(result.current.selectionListReading).toBe(NO_SELECTION_LIST_READING);
  });

  it('選択リストが閉じたら、読み取りも「何も無い」へ戻る', async () => {
    currentOutput = { isSelectionListActive: true, fullOutput: CLAUDE_MODEL };
    const { result } = await renderController();
    expect(result.current.selectionListReading).toEqual(CLAUDE_MODEL_READING);

    currentOutput = { isSelectionListActive: false, fullOutput: CLAUDE_MODEL };
    await act(async () => {
      await result.current.fetchCurrentOutput();
    });

    expect(result.current.isSelectionListActive).toBe(false);
    expect(result.current.selectionListReading).toBe(NO_SELECTION_LIST_READING);
  });
});

describe('[#3305] 前と同じ読み取りなら、同じ object のまま', () => {
  it('同じ応答の poll は、読み取りの object を替えず、再描画も起こさない', async () => {
    currentOutput = { isSelectionListActive: true, fullOutput: CLAUDE_MODEL };
    const { result, commits } = await renderController();
    const first = result.current.selectionListReading;
    const before = commits();

    await act(async () => {
      await result.current.fetchCurrentOutput();
    });

    expect(result.current.selectionListReading).toBe(first);
    expect(commits()).toBe(before);
  });

  it('フレームが変わっても、読み取りが同じなら object を替えない（ハイライトが動いただけ）', async () => {
    currentOutput = { isSelectionListActive: true, fullOutput: CLAUDE_MODEL };
    const { result, commits } = await renderController();
    const first = result.current.selectionListReading;
    const before = commits();

    // ▼ を 1 回押した後の画面: `❯` が 2 番目から 3 番目へ移る。フレームの文字列は変わる。
    expect(stripAnsi(CLAUDE_MODEL)).toContain('❯ 2. Opus');
    expect(stripAnsi(CLAUDE_MODEL_CURSOR_MOVED)).toContain('❯ 3. Fable');
    expect(stripAnsi(CLAUDE_MODEL_CURSOR_MOVED)).not.toContain('❯ 2.');
    currentOutput = { isSelectionListActive: true, fullOutput: CLAUDE_MODEL_CURSOR_MOVED };
    await act(async () => {
      await result.current.fetchCurrentOutput();
    });

    expect(result.current.selectionListReading).toBe(first);
    expect(commits()).toBe(before);
  });

  // 陽性対照: 上の 2 つが「何をしても替わらない」せいでないことを示す。
  it('読み取りが変われば、新しい object になる', async () => {
    currentOutput = { isSelectionListActive: true, fullOutput: CLAUDE_MODEL };
    const { result } = await renderController();
    const first = result.current.selectionListReading;

    currentOutput = { isSelectionListActive: true, fullOutput: CODEX_MODEL };
    await act(async () => {
      await result.current.fetchCurrentOutput();
    });

    expect(result.current.selectionListReading).not.toBe(first);
    expect(result.current.selectionListReading.numberKeyCount).toBe(7);
  });
});
