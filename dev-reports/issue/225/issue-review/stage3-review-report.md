# Issue #225 影響範囲レビューレポート

**レビュー日**: 2026-02-10
**フォーカス**: 影響範囲レビュー
**ステージ**: 3（影響範囲レビュー 1回目）
**前提**: Stage 1（通常レビュー）の指摘事項はStage 2で全件反映済み

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 1 |
| Should Fix | 4 |
| Nice to Have | 3 |

Stage 1の通常レビュー後にデータフロー、API スキーマ、定数定義等が充実しており、技術的な設計品質は高い。影響範囲レビューでは主にテストカバレッジの漏れと、変更不要だが影響を受けるファイルの認識不足を検出した。

---

## Must Fix（必須対応）

### MF-1: current-output/route.ts が影響範囲に未記載

**カテゴリ**: 影響ファイル
**場所**: 影響範囲 セクション

**問題**:
`src/app/api/worktrees/[id]/current-output/route.ts` がIssueの影響範囲（「変更対象ファイル」にも「関連コンポーネント（変更不要の見込み）」にも）記載されていない。このルートは `getAutoYesState()` を呼び出してGETレスポンスに `autoYes.expiresAt` を含めており、duration変更の間接的影響を受ける。

加えて、`AutoYesState` interfaceのJSDocコメント（auto-yes-manager.ts L26）に `enabledAt + 3600000ms = 1 hour` という固定値前提の記述があり、duration可変化に伴い不正確になる。

**証拠**:
- `src/app/api/worktrees/[id]/current-output/route.ts` L15:
  ```typescript
  import { getAutoYesState, getLastServerResponseTimestamp } from '@/lib/auto-yes-manager';
  ```
- L105-130: `getAutoYesState(params.id)` を呼び出し、`autoYes.expiresAt` をレスポンスに含める
- `src/lib/auto-yes-manager.ts` L26:
  ```typescript
  /** Timestamp when auto-yes expires (enabledAt + 3600000ms = 1 hour) */
  expiresAt: number;
  ```

**推奨対応**:
1. 「関連コンポーネント（変更不要の見込み）」セクションに `src/app/api/worktrees/[id]/current-output/route.ts` を追加し、「getAutoYesState()経由で間接的に影響を受けるが変更不要」と注記する
2. 実装タスクに `AutoYesState` interfaceのJSDocコメント更新（固定値記述の削除）を追加する

---

## Should Fix（推奨対応）

### SF-1: コンポーネントテスト（AutoYesToggle.test.tsx, AutoYesConfirmDialog.test.tsx）の更新タスクが未記載

**カテゴリ**: テスト範囲
**場所**: 実装タスク セクション

**問題**:
Issueの実装タスクには `tests/unit/lib/auto-yes-manager.test.ts` の更新のみ記載されているが、以下2つのコンポーネントテストファイルもシグネチャ変更により更新が必要。

**証拠**:
- `tests/unit/components/worktree/AutoYesToggle.test.tsx` L43:
  ```typescript
  expect(defaultProps.onToggle).toHaveBeenCalledWith(true);
  ```
  変更後は `onToggle(true, duration)` の呼び出しになるためアサーションが不正確になる。

- `tests/unit/components/worktree/AutoYesConfirmDialog.test.tsx` L66:
  ```typescript
  expect(defaultProps.onConfirm).toHaveBeenCalledTimes(1);
  ```
  `onConfirm` の型が `() => void` から `(duration: number) => void` に変わるため、引数の検証テストを追加すべき。

**推奨対応**:
実装タスクに以下を追加:
- `tests/unit/components/worktree/AutoYesConfirmDialog.test.tsx` の更新（ラジオボタンUI表示テスト、onConfirmコールバックのduration引数検証）
- `tests/unit/components/worktree/AutoYesToggle.test.tsx` の更新（onToggle(true, duration)アサーション、handleConfirmでのduration伝搬検証）

---

### SF-2: 統合テスト（auto-yes-persistence.test.ts）の影響範囲認識不足

**カテゴリ**: テスト範囲
**場所**: 影響範囲 セクション

**問題**:
`tests/integration/auto-yes-persistence.test.ts` が `setAutoYesEnabled('...', true)` を2引数で呼び出している。duration引数がオプショナルのため後方互換性は維持されるが、テストファイルとして影響範囲に含めるべき。

**証拠**:
- `tests/integration/auto-yes-persistence.test.ts` L39, L73, L102, L119: 全て `setAutoYesEnabled(worktreeId, true)` の2引数呼び出し

**推奨対応**:
影響範囲テーブルに `tests/integration/auto-yes-persistence.test.ts` を追加し、「既存テストはデフォルトdurationで動作する見込み。duration指定ありの永続化テスト追加を検討」と注記する。

---

### SF-3: ユーザーガイド・安全性ドキュメントの更新タスクが未記載

**カテゴリ**: ドキュメント更新
**場所**: 影響範囲 セクション

**問題**:
以下のドキュメントにAuto Yesモードに関する記述があるが、有効時間選択機能の追加に伴う更新がIssueの実装タスクに含まれていない。

**証拠**:
- `docs/user-guide/webapp-guide.md` L161-176: Auto Yesモードの使い方説明。有効時間の記載なし
- `docs/TRUST_AND_SAFETY.md` L42-49: Auto Yesモードのリスク説明。時間制限の記載なし

**推奨対応**:
実装タスクまたは別Issueとして以下のドキュメント更新を追加:
1. `docs/user-guide/webapp-guide.md`: 「1時間/3時間/8時間から有効時間を選択可能」の記述追加
2. `docs/TRUST_AND_SAFETY.md`: 最大有効時間が8時間に拡大された旨の注記

---

### SF-4: route.ts のdurationバリデーションテスト方針が不明確

**カテゴリ**: テスト範囲
**場所**: 実装タスク セクション

**問題**:
`auto-yes/route.ts` のPOSTハンドラにALLOWED_DURATIONSバリデーションを追加する計画だが、このルートの単体/統合テストが存在しない。受入条件に「許可されていないduration値がAPIで拒否されること（400レスポンス）」が含まれているが、テスト方法が未定義。

**証拠**:
- `tests/` ディレクトリにroute.ts関連のテストファイルが存在しない
- IssueのユニットテストタスクはALLOWED_DURATIONSの「バリデーションテスト」を含むが、これがauto-yes-manager.ts内のテストなのかroute.tsのテストなのか曖昧

**推奨対応**:
テスト方針を明示すべき。推奨は以下のいずれか:
1. `auto-yes-manager.ts` にバリデーション関数（`isValidDuration()`）を切り出し、ユニットテストでカバーする
2. `auto-yes/route.ts` のAPIハンドラ統合テストを新規追加する
3. 受入条件をE2E/手動テストで確認する（テスト自動化は見送り）

---

## Nice to Have（あれば良い）

### NTH-1: CLAUDE.md・implementation-history.md の更新

**カテゴリ**: ドキュメント更新
**場所**: CLAUDE.md 主要機能モジュール テーブル

**問題**:
CLAUDE.mdのauto-yes-manager.tsモジュール説明にduration選択機能の記載が必要になる。

**推奨対応**:
実装完了後に以下を更新:
- CLAUDE.md: auto-yes-manager.tsの説明に「Issue #225: duration選択機能、ALLOWED_DURATIONS定数」を追記
- `docs/implementation-history.md`: Issue #225のエントリを追加

---

### NTH-2: AUTO_YES_TIMEOUT_MS定数の扱いの明示

**カテゴリ**: 破壊的変更
**場所**: ALLOWED_DURATIONS定数と型定義 セクション

**問題**:
`AUTO_YES_TIMEOUT_MS` 定数（L68）がDEFAULT_AUTO_YES_DURATIONに置き換えられる際の扱い（削除 or 維持）が未明示。非exportのため外部影響はないが、実装者への明確な指針がない。

**推奨対応**:
Issueに「AUTO_YES_TIMEOUT_MSはDEFAULT_AUTO_YES_DURATIONに置き換え、削除する」旨を明記する。

---

### NTH-3: ALLOWED_DURATIONSのクライアント/サーバー境界の考慮

**カテゴリ**: 移行考慮
**場所**: ALLOWED_DURATIONS定数と型定義 セクション

**問題**:
ALLOWED_DURATIONSを `auto-yes-manager.ts`（サーバーサイドモジュール）に定義し、`AutoYesConfirmDialog.tsx`（'use client'コンポーネント）からimportする設計。auto-yes-manager.tsはtmux操作やglobalThis等のサーバー専用コードを含んでおり、クライアントバンドルへの影響が不明。

**推奨対応**:
以下のいずれかの方針を検討・記載:
1. Next.jsのtree-shakingにより定数のみがバンドルされることを確認する（現実的だが検証が必要）
2. `src/config/auto-yes-durations.ts` 等の共有configファイルにALLOWED_DURATIONS定数を分離する（より安全なアプローチ）

---

## 影響分析サマリー

| 観点 | 結果 |
|------|------|
| 破壊的変更 | なし（全てオプショナルパラメータ追加） |
| DB変更 | 不要（インメモリ管理） |
| デプロイ | 特別な手順なし |
| セキュリティ | ALLOWED_DURATIONSホワイトリスト方式で許容範囲 |
| パフォーマンス | 影響なし |
| モバイル対応 | ダイアログ高さ増加の確認が必要 |

---

## 参照ファイル

### コード（変更対象）
- `src/lib/auto-yes-manager.ts`: ALLOWED_DURATIONS定数追加、setAutoYesEnabled()にduration引数追加
- `src/components/worktree/AutoYesConfirmDialog.tsx`: ラジオボタンUI追加、onConfirm型変更
- `src/components/worktree/AutoYesToggle.tsx`: onToggleシグネチャ変更、formatTimeRemaining更新検討
- `src/components/worktree/WorktreeDetailRefactored.tsx`: handleAutoYesToggleにduration引数追加
- `src/app/api/worktrees/[id]/auto-yes/route.ts`: durationバリデーション追加

### コード（変更不要だが影響あり）
- `src/app/api/worktrees/[id]/current-output/route.ts`: getAutoYesState()経由の間接影響
- `src/lib/auto-yes-resolver.ts`: 応答ロジック変更なし
- `src/hooks/useAutoYes.ts`: クライアント側ポーリング変更なし

### テスト（更新必要）
- `tests/unit/lib/auto-yes-manager.test.ts`: 既存テスト更新 + duration指定テスト追加（Issue記載済み）
- `tests/unit/components/worktree/AutoYesToggle.test.tsx`: シグネチャ変更に伴うアサーション更新（**Issue未記載**）
- `tests/unit/components/worktree/AutoYesConfirmDialog.test.tsx`: onConfirm引数検証追加（**Issue未記載**）
- `tests/integration/auto-yes-persistence.test.ts`: 後方互換性確認（**Issue未記載**）

### ドキュメント（更新必要）
- `docs/user-guide/webapp-guide.md`: Auto Yesモードの有効時間選択記述追加
- `docs/TRUST_AND_SAFETY.md`: 最大有効時間拡大の注記
- `CLAUDE.md`: モジュール説明更新
- `docs/implementation-history.md`: Issue #225エントリ追加
