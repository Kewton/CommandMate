# Issue #111 レビューレポート

**レビュー日**: 2026-02-02
**フォーカス**: 通常レビュー（整合性・正確性）
**イテレーション**: 1回目
**ステージ**: 1

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 2 |
| Should Fix | 4 |
| Nice to Have | 2 |

## 総評

Issue #111「現在の作業ブランチを可視化して欲しい」は、ブランチ切り替えによる作業ミスを防止する有用な機能提案です。

提案されている解決策は技術的に実現可能ですが、以下の点で既存コードとの整合性確認と実装詳細の明確化が必要です：

1. **DBスキーマ拡張**: セッション開始時のブランチ名を保存するカラムが既存のworktreesテーブルに存在しないため、マイグレーションが必要
2. **API設計**: 新規エンドポイントの作成か既存APIの拡張かの方針決定が必要
3. **UIコンポーネント設計**: BranchMismatchAlertの表示条件と配置の詳細化

---

## Must Fix（必須対応）

### MF-1: DBスキーマ拡張の明確化

**カテゴリ**: 整合性
**場所**: ## 技術要件 > API拡張 セクション

**問題**:
提案されている`GitStatusResponse`インターフェースの`initialBranch`フィールドを実現するには、既存のWorktree型およびworktreesテーブルにセッション開始時のブランチ名を保存するフィールドが必要ですが、現在のスキーマには存在しません。

**証拠**:
- `src/types/models.ts` のWorktree型にはブランチ関連のフィールドがない
- `src/lib/db.ts` のworktreesテーブル操作にもブランチ関連の処理がない
- Issueでは「セッション開始時のブランチ名をDBまたはメモリに保存」と記載されているが、永続化方針が不明確

**推奨対応**:
worktreesテーブルに`initial_branch`カラムを追加するDBマイグレーション（Migration #15）が必要であることを実装タスクに明記してください。

具体的には：
```typescript
// src/lib/db-migrations.ts に追加
{
  version: 15,
  name: 'add-initial-branch-to-worktrees',
  up: (db) => {
    db.exec(`
      ALTER TABLE worktrees ADD COLUMN initial_branch TEXT;
      ALTER TABLE worktrees ADD COLUMN initial_branch_set_at INTEGER;
    `);
  }
}
```

---

### MF-2: API設計方針の明確化

**カテゴリ**: 技術的妥当性
**場所**: ## 技術要件 > API拡張 セクション

**問題**:
新規APIエンドポイント `/api/worktrees/:id/git-status` の提案がありますが、既存の `GET /api/worktrees/:id` で既にセッションステータスを返却しており、新規エンドポイントの必要性と既存APIとの役割分担が不明確です。

**証拠**:
`src/app/api/worktrees/[id]/route.ts` のGETハンドラは既に以下を返却：
```typescript
{
  ...worktree,
  isSessionRunning: anyRunning,
  isWaitingForResponse: anyWaiting,
  isProcessing: anyProcessing,
  sessionStatusByCli,
}
```

`WorktreeDetailRefactored.tsx` はこのAPIを2〜5秒間隔でポーリングしています。

**推奨対応**:
以下のいずれかの方針を明確化してください：

**方針A（推奨）**: 既存APIを拡張
```typescript
// GET /api/worktrees/:id のレスポンスにgitStatusを追加
{
  ...worktree,
  gitStatus: {
    currentBranch: string,
    initialBranch: string | null,
    isBranchMismatch: boolean,
    isDirty: boolean,
    commitHash: string,
  }
}
```
メリット：既存のポーリング処理を変更せずに済む

**方針B**: 新規エンドポイント追加
```typescript
// GET /api/worktrees/:id/git-status
```
メリット：責務の分離、デメリット：フロントエンドで追加のAPI呼び出しが必要

---

## Should Fix（推奨対応）

### SF-1: ポーリング間隔の明確化

**カテゴリ**: 明確性
**場所**: ## 受け入れ条件 セクション

**問題**:
「ブランチ情報は定期的に更新される（ポーリング間隔に合わせて）」という記載が具体的でない。

**証拠**:
`WorktreeDetailRefactored.tsx` での現在のポーリング間隔：
- `ACTIVE_POLLING_INTERVAL_MS = 2000` (アクティブ時)
- `IDLE_POLLING_INTERVAL_MS = 5000` (アイドル時)

**推奨対応**:
受け入れ条件を以下のように具体化：
> ブランチ情報はセッションアクティブ時2秒間隔、アイドル時5秒間隔で更新される

---

### SF-2: BranchMismatchAlertの詳細化

**カテゴリ**: 完全性
**場所**: ## 影響範囲 セクション

**問題**:
`BranchMismatchAlert.tsx`の表示条件、配置場所、スタイルの詳細が不足。

**推奨対応**:
以下を明確化：
- **表示条件**: `isBranchMismatch === true` の場合
- **配置場所**: DesktopHeaderの下部（ヘッダーとコンテンツの間）
- **スタイル**: 黄色/オレンジの警告背景、警告アイコン付き
- **閉じる機能**: なし（ブランチが一致するまで表示継続）
- **内容例**: 「現在のブランチ: feature/xxx (開始時: develop)」

---

### SF-3: aheadBehindのスコープ除外検討

**カテゴリ**: 技術的妥当性
**場所**: ## 技術要件 > API拡張 セクション

**問題**:
`aheadBehind`フィールドがオプションとして記載されていますが、リモートブランチとの比較には`git fetch`が必要でパフォーマンスに影響する可能性があります。

**証拠**:
`git fetch` はネットワーク通信を伴うため、2秒間隔のポーリングで毎回実行すると：
- ネットワーク負荷増大
- レスポンス遅延
- API Rateリミット（GitHub等）

**推奨対応**:
本Issueからは`aheadBehind`を除外し、別Issueで対応することを推奨：
```
- aheadBehind?: {  // 本Issueではスコープ外、別途Issue #XXX で対応
-   ahead: number;
-   behind: number;
- };
```

---

### SF-4: セッション開始時のブランチ保存タイミング

**カテゴリ**: 完全性
**場所**: ## 技術要件 > バックエンド セクション

**問題**:
セッション開始時のブランチ保存タイミングが不明確。

**推奨対応**:
以下のタイミングでinitialBranchを保存することを明記：
1. **tmuxセッション作成時** に `git rev-parse --abbrev-ref HEAD` を実行
2. 結果を `worktrees.initial_branch` に保存
3. セッション終了時に `initial_branch` をNULLにリセット

関連する実装タスクを追加：
> Task 1.5: セッション開始API (`/api/worktrees/:id/start-session`) にinitialBranch保存処理を追加

---

## Nice to Have（あれば良い）

### NTH-1: エラーハンドリングの追加

**カテゴリ**: 完全性
**場所**: ## 技術要件 セクション

**問題**:
`git rev-parse` コマンドが失敗した場合のエラーハンドリング方針が記載されていない。

**推奨対応**:
以下のケースに対する対応を検討：
- `.git` が存在しない場合 → currentBranch: null
- detached HEAD 状態 → currentBranch: "(detached)"
- git コマンド実行失敗 → エラーログ出力、UIではフォールバック表示

---

### NTH-2: テストケースの具体化

**カテゴリ**: 完全性
**場所**: ## 実装タスク > Task 5 セクション

**問題**:
「ユニットテスト・結合テスト追加」とのみ記載されており、具体的なテストケースが不明。

**推奨対応**:
以下のテストケースを追加：

**Unit Tests**:
1. ブランチ取得関数: git コマンド実行と結果パース
2. ブランチ比較関数: initialBranch と currentBranch の比較
3. BranchMismatchAlert: 警告表示/非表示の切り替え

**Integration Tests**:
1. API呼び出しでgitStatus情報が正しく返却される
2. ポーリングでブランチ情報が更新される

**E2E Tests**:
1. ブランチ変更時に警告が表示される
2. モバイル表示でブランチ情報が確認できる

---

## 参照ファイル

### コード
| ファイル | 関連性 |
|---------|--------|
| `src/types/models.ts` | Worktree型定義 - gitStatus関連フィールド追加が必要 |
| `src/components/worktree/WorktreeDetailRefactored.tsx` | UI統合先 - DesktopHeader, MobileHeaderへの表示追加 |
| `src/app/api/worktrees/[id]/route.ts` | API拡張先 - git status情報の取得・返却 |
| `src/components/mobile/MobileHeader.tsx` | モバイル用ブランチ表示追加先 |
| `src/lib/db.ts` | DB操作 - initialBranch保存関数追加が必要 |
| `src/lib/db-migrations.ts` | DBマイグレーション - Migration #15 追加が必要 |

### ドキュメント
| ファイル | 関連性 |
|---------|--------|
| `CLAUDE.md` | プロジェクト概要・技術スタック確認 |
