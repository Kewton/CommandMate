# Issue #225 レビューレポート

**レビュー日**: 2026-02-10
**フォーカス**: 通常レビュー（整合性・正確性）
**イテレーション**: 1回目（Stage 1）

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 1 |
| Should Fix | 4 |
| Nice to Have | 2 |

## コードベース検証結果

Issue記載の現状認識をコードベースと照合した結果を以下にまとめる。

### 現状動作の検証

**判定: 正確**

Issue記載の「AUTO_YES_TIMEOUT_MS = 3600000（1時間固定）」は、`src/lib/auto-yes-manager.ts` L68の定義と完全に一致する。

```typescript
// src/lib/auto-yes-manager.ts L68
const AUTO_YES_TIMEOUT_MS = 3600000;
```

`setAutoYesEnabled()` (L181-201) において `expiresAt: now + AUTO_YES_TIMEOUT_MS` としてハードコードされていることも確認した。

### 変更対象ファイルの検証

**判定: 正確**

Issue記載の5ファイルは全て存在し、変更内容の記述も適切である。

| ファイル | 存在 | 変更内容の妥当性 |
|---------|------|----------------|
| `src/components/worktree/AutoYesConfirmDialog.tsx` | OK | ラジオボタンUI追加、onConfirm型変更が必要 |
| `src/components/worktree/AutoYesToggle.tsx` | OK | onToggleシグネチャ変更、表示テキスト動的化が必要 |
| `src/components/worktree/WorktreeDetailRefactored.tsx` | OK | handleAutoYesToggle (L1149-1164) にduration引数追加が必要 |
| `src/lib/auto-yes-manager.ts` | OK | setAutoYesEnabled() (L181) にduration引数追加が必要 |
| `src/app/api/worktrees/[id]/auto-yes/route.ts` | OK | POST (L83-126) にdurationバリデーション追加が必要 |

変更不要と記載された3ファイルについても確認した。

| ファイル | 存在 | 変更不要の妥当性 |
|---------|------|----------------|
| `src/lib/auto-yes-resolver.ts` | OK | 応答ロジックはdurationに無関係。正しい |
| `src/hooks/useAutoYes.ts` | OK | クライアント側ポーリングはdurationに無関係。正しい |
| `src/lib/prompt-detector.ts` | OK | プロンプト検出はdurationに無関係。正しい |

### DB変更なしの妥当性

**判定: 正確**

Auto-Yes状態は `globalThis` 上の `Map<string, AutoYesState>` でインメモリ管理されている（`src/lib/auto-yes-manager.ts` L101-114）。`expiresAt` フィールドは `AutoYesState` インターフェース内に既に存在し（L26）、値を変更するだけなのでスキーマ変更は不要である。

---

## Must Fix（必須対応）

### MF-1: コンポーネント間のdurationデータフローが未定義

**カテゴリ**: 整合性
**場所**: 影響範囲テーブル / 実装タスク セクション

**問題**:

Issueでは以下の変更を個別に記載している。

1. `AutoYesConfirmDialog.tsx`: onConfirmコールバックにdurationパラメータ追加
2. `AutoYesToggle.tsx`: onToggleシグネチャ変更

しかし、この2つのコンポーネント間でdurationがどのように伝搬されるかが明示されていない。

現在のコードでは以下の構造となっている。

```
AutoYesToggle (親)
  └── AutoYesConfirmDialog (子)
```

- `AutoYesConfirmDialog` の `onConfirm` は `() => void` 型（L17）
- `AutoYesToggle` の `handleConfirm` (L94-98) は `onConfirm` を呼んだ後、`onToggle(true)` を呼ぶ

duration選択UIが `AutoYesConfirmDialog` 内に追加される場合、以下のデータフローが必要になる。

```
AutoYesConfirmDialog (duration選択)
  -> onConfirm(duration)     // 子->親コールバック
  -> AutoYesToggle.handleConfirm(duration)
  -> onToggle(true, duration) // 親->上位コンポーネント
  -> WorktreeDetailRefactored.handleAutoYesToggle(enabled, duration)
  -> API POST { enabled, duration, cliToolId }
```

**推奨対応**:

Issueの「提案する解決策」セクションに、上記のデータフロー図を追加し、各コンポーネント間のインターフェース変更を明確にする。

---

## Should Fix（推奨対応）

### SF-1: ダイアログ内の固定テキスト更新が実装タスクに漏れている

**カテゴリ**: 完全性
**場所**: 実装タスク セクション

**問題**:

`AutoYesConfirmDialog.tsx` L46に以下の固定テキストが存在する。

```tsx
<p className="mt-1">1時間後に自動でOFFになります。</p>
```

Issueの実装タスクでは「AutoYesToggle.tsxの表示テキストを選択時間に応じて動的変更」は記載されているが、ダイアログ内のこの説明テキストの更新は含まれていない。ユーザーが3時間を選択した場合でも「1時間後に自動でOFF」と表示される不整合が生じる。

**推奨対応**:

実装タスクに「`AutoYesConfirmDialog.tsx`の説明テキストを選択されたdurationに応じて動的変更」を追加する。具体的には、ラジオボタン選択に連動して「{選択時間}後に自動でOFFになります。」と表示を更新する。

---

### SF-2: duration定数・型定義の配置場所が未指定

**カテゴリ**: 技術的妥当性
**場所**: 実装タスク: 許可されるduration値のバリデーション定数追加

**問題**:

「許可されるduration値のバリデーション定数追加（ホワイトリスト方式）」と記載されているが、以下が未定義である。

- 定数の配置ファイル（`auto-yes-manager.ts`? 新規の`config/auto-yes.ts`?）
- TypeScript型定義（リテラル型ユニオンの使用有無）
- クライアント側とサーバー側での共有方法

**推奨対応**:

定数定義の配置方針を記載する。例えば以下の設計が考えられる。

```typescript
// src/lib/auto-yes-manager.ts に追加
export const ALLOWED_DURATIONS_MS = [3600000, 10800000, 28800000] as const;
export type AutoYesDurationMs = typeof ALLOWED_DURATIONS_MS[number];
export const DEFAULT_DURATION_MS: AutoYesDurationMs = 3600000;
```

サーバー側（`route.ts`）とクライアント側（`AutoYesConfirmDialog.tsx`）の両方から参照可能にするため、`auto-yes-manager.ts` への配置が既存パターンと整合する。

---

### SF-3: 既存テスト更新の記載不足

**カテゴリ**: 完全性
**場所**: 実装タスク: ユニットテスト追加

**問題**:

「ユニットテスト追加」のみ記載されているが、既存テストの更新も必要である。特に以下のテストが影響を受ける。

**`tests/unit/lib/auto-yes-manager.test.ts`**:
- L64: `expect(state.expiresAt).toBe(now + 3600000)` -- durationパラメータなしの場合のデフォルト値テストとして残しつつ、duration指定テストの追加が必要
- L104: `vi.setSystemTime(now + 3600001)` による期限切れテスト -- 他のduration値でのテストも追加が必要

**推奨対応**:

実装タスクを「ユニットテスト追加・既存テスト更新」に変更し、以下を明示する。

- `setAutoYesEnabled()` のduration引数テスト（各duration値 + デフォルト値）
- `route.ts` のdurationバリデーションテスト（許可値・不正値・省略時）
- 既存テストがdurationデフォルト値で引き続きパスすることの確認

---

### SF-4: APIリクエスト/レスポンスの具体的スキーマが未記載

**カテゴリ**: 明確性
**場所**: 提案する解決策 セクション

**問題**:

「POSTリクエストにdurationフィールドを追加・バリデーション」と記載されているが、具体的なスキーマが未定義である。

**推奨対応**:

以下の情報を記載する。

```
POST /api/worktrees/:id/auto-yes

Request Body:
{
  "enabled": true,
  "cliToolId": "claude",     // optional, default: "claude"
  "duration": 10800000       // optional, default: 3600000 (1h)
                              // allowed: 3600000 | 10800000 | 28800000
}

Response (200):
{
  "enabled": true,
  "expiresAt": 1707580800000,
  "pollingStarted": true
}

Error Response (400) - invalid duration:
{
  "error": "duration must be one of: 3600000, 10800000, 28800000"
}
```

---

## Nice to Have（あれば良い）

### NTH-1: 関連Issueへのリンク追加

**カテゴリ**: 完全性
**場所**: Issue本文

Auto-Yes機能は複数のIssueで段階的に改善されてきた。以下へのリンクを追加すると、レビュアーや実装者が文脈を把握しやすくなる。

- #61: Auto Yesモード追加（初期実装）
- #138: バックグラウンドポーリング追加
- #153: ホットリロード時の状態不整合修正

---

### NTH-2: カウントダウン表示形式の検討

**カテゴリ**: 完全性
**場所**: 受入条件 セクション

現在の `formatTimeRemaining()` 関数（`AutoYesToggle.tsx` L32-37）は MM:SS 形式で表示する。

```typescript
function formatTimeRemaining(expiresAt: number): string {
  const remaining = Math.max(0, expiresAt - Date.now());
  const minutes = Math.floor(remaining / 60000);
  const seconds = Math.floor((remaining % 60000) / 1000);
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}
```

3時間の場合は `180:00`、8時間の場合は `480:00` と表示される。HH:MM:SS 形式（例: `03:00:00`）のほうが視認性が高い可能性がある。受入条件にカウントダウン表示形式の仕様を含めることを推奨する。

---

## 参照ファイル

### コード

| ファイル | 関連性 |
|---------|-------|
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-225/src/lib/auto-yes-manager.ts` | AUTO_YES_TIMEOUT_MS定数（L68）、setAutoYesEnabled()関数（L181-201）|
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-225/src/components/worktree/AutoYesConfirmDialog.tsx` | onConfirm型（L17）、固定テキスト（L46）|
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-225/src/components/worktree/AutoYesToggle.tsx` | onToggle型（L20）、handleConfirm（L94-98）、formatTimeRemaining（L32-37）|
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-225/src/components/worktree/WorktreeDetailRefactored.tsx` | handleAutoYesToggle（L1149-1164）|
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-225/src/app/api/worktrees/[id]/auto-yes/route.ts` | POSTハンドラ（L83-126）|
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-225/tests/unit/lib/auto-yes-manager.test.ts` | 既存テスト（L64: expiresAt期待値）|

### ドキュメント

| ファイル | 関連性 |
|---------|-------|
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-225/CLAUDE.md` | auto-yes-manager.tsモジュール説明の更新が必要になる可能性 |

---

*Generated by issue-review-agent (Stage 1 - Normal Review)*
