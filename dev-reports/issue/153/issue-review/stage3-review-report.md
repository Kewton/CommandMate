# Issue #153 影響範囲レビュー（Stage 3）

## レビュー概要

| 項目 | 値 |
|------|-----|
| Issue番号 | #153 |
| レビューステージ | Stage 3 - 影響範囲レビュー（1回目） |
| レビュー日時 | 2026-02-04 |
| 影響レベル | **低** |
| 指摘件数 | 5件（Must Fix: 0, Should Fix: 2, Nice to Have: 3） |

---

## 1. コード影響分析

### 1.1 変更対象ファイル

| ファイル | 変更種別 |
|---------|---------|
| `src/lib/auto-yes-manager.ts` | 修正（globalThisによる状態永続化） |

### 1.2 影響を受ける関数

以下の関数は内部的にMapインスタンスを参照していますが、**インターフェースに変更はありません**：

- `getAutoYesState()`
- `setAutoYesEnabled()`
- `clearAllAutoYesStates()`
- `getActivePollerCount()`
- `clearAllPollerStates()`
- `getLastServerResponseTimestamp()`
- `updateLastServerResponseTimestamp()`（内部関数）
- `resetErrorCount()`（内部関数）
- `incrementErrorCount()`（内部関数）
- `pollAutoYes()`（内部関数）
- `scheduleNextPoll()`（内部関数）
- `startAutoYesPolling()`
- `stopAutoYesPolling()`
- `stopAllAutoYesPolling()`

### 1.3 呼び出し元への影響

**呼び出し元の変更は不要です。**

提案された変更はMapインスタンスの保存場所をモジュールスコープからglobalThisに移動するのみで、エクスポートされる関数のインターフェースは変更されません。

---

## 2. テスト影響分析

### 2.1 影響を受けるテストファイル

| ファイル | 影響度 |
|---------|--------|
| `tests/unit/lib/auto-yes-manager.test.ts` | 中 |
| `tests/unit/lib/auto-yes-resolver.test.ts` | 低 |
| `tests/unit/components/worktree/AutoYesToggle.test.tsx` | 低 |
| `tests/unit/components/worktree/AutoYesConfirmDialog.test.tsx` | なし |

### 2.2 テスト分離の考慮事項

既存のテストファイル（`auto-yes-manager.test.ts`）は以下の対策を実施済み：

```typescript
beforeEach(() => {
  clearAllAutoYesStates();
  clearAllPollerStates();
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
  stopAllAutoYesPolling();
});
```

globalThis移行後も、これらのクリア関数はglobalThis上のMapを正しくクリアするため、テスト分離は維持されます。

### 2.3 必要なテスト変更

1. globalThis状態が正しく初期化・クリアされることを検証するテストの追加
2. モジュール再読み込みをシミュレートした回帰テストの追加

---

## 3. ランタイム影響分析

### 3.1 メモリへの影響

| 項目 | 評価 |
|------|------|
| メモリ使用量 | 変化なし |
| GC挙動 | globalThisへの参照はプロセス終了まで保持 |
| 実用上の影響 | 無視可能（worktree数は通常100未満） |

### 3.2 クリーンアップ機構への影響

既存のクリーンアップ機構は引き続き有効です：

| 機構 | 場所 | 動作 |
|------|------|------|
| gracefulShutdown | `server.ts:127` | `stopAllAutoYesPolling()`を呼び出し |
| セッションクリーンアップ | `session-cleanup.ts:117` | `stopAutoYesPolling(worktreeId)`を呼び出し |
| タイマークリア | `auto-yes-manager.ts:374-376` | `clearTimeout()`でタイマーを停止 |

---

## 4. 関連機能への影響

### 4.1 Issue #138 サーバー側ポーリング

**直接的な修正対象。** この修正により、ホットリロードやワーカー再起動後もサーバー側ポーリング状態がUIと同期されます。

### 4.2 useAutoYes クライアントフック

**変更不要。** `src/hooks/useAutoYes.ts`はAPIレスポンスに依存しており、バックエンド状態が正しく維持されれば正常に動作します。

### 4.3 current-output API

**変更不要。** `src/app/api/worktrees/[id]/current-output/route.ts`は`getAutoYesState()`と`getLastServerResponseTimestamp()`を呼び出しますが、これらは修正後も同じインターフェースで動作します。

### 4.4 auto-yes API

**変更不要。** `src/app/api/worktrees/[id]/auto-yes/route.ts`は状態管理関数を使用しますが、インターフェース変更がないため影響を受けません。

### 4.5 その他のコンポーネント

| コンポーネント | 影響 |
|---------------|------|
| `AutoYesToggle` | APIデータを消費するのみ、影響なし |
| `AutoYesConfirmDialog` | 状態と直接やり取りしない、影響なし |
| `WorktreeDetailRefactored` | APIデータを消費するのみ、影響なし |

---

## 5. 指摘事項

### 5.1 Should Fix（推奨対応）

#### SF-001: globalThis状態検証テストの追加

| 項目 | 内容 |
|------|------|
| カテゴリ | テスト分離 |
| 場所 | `tests/unit/lib/auto-yes-manager.test.ts` |
| 説明 | globalThis.__autoYesStatesとglobalThis.__autoYesPollerStatesが適切に管理されることを明示的に検証するテストを追加 |

#### SF-002: globalThisパターンのドキュメント化

| 項目 | 内容 |
|------|------|
| カテゴリ | ドキュメント |
| 場所 | `src/lib/auto-yes-manager.ts` |
| 説明 | Next.jsホットリロード耐性のためのglobalThisパターンについてJSDocコメントを追加 |

### 5.2 Nice to Have（検討事項）

#### N2H-001: globalThis拡張の型定義

| 項目 | 内容 |
|------|------|
| カテゴリ | 型安全性 |
| 場所 | `src/lib/auto-yes-manager.ts` |
| 推奨 | `src/types/global.d.ts`にNodeJS.Global拡張を定義し、eslint-disableコメントを不要にする |

#### N2H-002: response-poller.tsの一貫性確認

| 項目 | 内容 |
|------|------|
| カテゴリ | 一貫性 |
| 場所 | `src/lib/response-poller.ts` |
| 説明 | 同様のモジュールレベルMap（activePollers, pollingStartTimes）を使用しており、同じホットリロード問題が発生する可能性がある |

#### N2H-003: claude-poller.tsの一貫性確認

| 項目 | 内容 |
|------|------|
| カテゴリ | 一貫性 |
| 場所 | `src/lib/claude-poller.ts` |
| 説明 | session-cleanup.tsから参照されており、同様のインメモリ状態管理がある可能性 |

---

## 6. 結論

### 影響レベル評価: **低**

**理由：**
- 変更は1ファイル（約20行）に限定される
- エクスポートされる関数インターフェースに変更なし
- 既存のテストおよびクリーンアップ機構は修正なしで継続動作
- 呼び出し元の変更は不要

### 実装推奨

1. Issueで提案されている案1（globalThis永続化）は適切かつ低リスク
2. SF-001とSF-002の対応を実装に含めることを推奨
3. N2H-002とN2H-003は将来の技術的負債として記録し、同様の問題発生時に対応を検討

---

## 関連ファイル一覧

| ファイルパス | 役割 |
|-------------|------|
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-153/src/lib/auto-yes-manager.ts` | Auto-Yes状態管理（変更対象） |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-153/src/lib/session-cleanup.ts` | セッションクリーンアップ（呼び出し元） |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-153/server.ts` | gracefulShutdown（呼び出し元） |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-153/src/app/api/worktrees/[id]/auto-yes/route.ts` | Auto-Yes API（呼び出し元） |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-153/src/app/api/worktrees/[id]/current-output/route.ts` | 状態取得API（呼び出し元） |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-153/src/hooks/useAutoYes.ts` | クライアントフック（間接影響） |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-153/tests/unit/lib/auto-yes-manager.test.ts` | ユニットテスト（テスト対象） |
