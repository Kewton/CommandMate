# Issue #111 影響範囲レビュー（Stage 3）

**レビュー日**: 2026-02-02
**Issue**: 現在の作業ブランチを可視化して欲しい
**レビュータイプ**: 影響範囲分析（1回目）

---

## レビューサマリー

Issue #111 は worktrees テーブルへの `initial_branch` カラム追加、GET `/api/worktrees/:id` レスポンスへの `gitStatus` フィールド追加、およびフロントエンドでのブランチ不一致警告表示を実装する機能である。

主な影響範囲：
1. **DBマイグレーション**: Migration #15 追加（initial_branch カラム）
2. **API拡張**: GET /api/worktrees/:id レスポンスに gitStatus フィールド追加（後方互換）
3. **UIコンポーネント**: 2件修正 + 1件新規作成

全体として破壊的変更は少なく、オプショナルフィールド追加による段階的実装が可能。

---

## Must Fix（必須対応）

### MF-1: API設計の明確化

| 項目 | 内容 |
|------|------|
| カテゴリ | API設計 |
| 重要度 | 高 |

**問題点**:
現在の Issue 設計では「POST /api/sessions」と記載されているが、実際のセッション開始は `/api/worktrees/:id/send` エンドポイント内で `cliTool.startSession()` が呼ばれる。

**影響ファイル**:
- `src/app/api/worktrees/[id]/send/route.ts`
- `src/lib/cli-tools/base.ts`

**推奨対応**:
`send/route.ts` 内の `startSession()` 呼び出し直後に `initial_branch` を保存するか、`startSession()` メソッド内で git rev-parse を実行して返却値に含める設計に変更する。

```typescript
// send/route.ts 内での修正案
if (!running) {
  await cliTool.startSession(params.id, worktree.path);
  // 初期ブランチを保存
  const initialBranch = await getCurrentBranch(worktree.path);
  await saveInitialBranch(db, params.id, initialBranch);
}
```

---

### MF-2: git コマンドエラーハンドリングの定義

| 項目 | 内容 |
|------|------|
| カテゴリ | データ整合性 |
| 重要度 | 高 |

**問題点**:
`git rev-parse --abbrev-ref HEAD` 実行時のエラーハンドリングが未定義。detached HEAD 状態や worktree 外のディレクトリで git コマンドが失敗した場合の挙動が不明確。

**影響ファイル**:
- `src/app/api/worktrees/[id]/route.ts`

**推奨対応**:
エラー時は `currentBranch='(detached HEAD)'` または `'(unknown)'` を返却し、`isBranchMismatch=false` とする仕様を Issue に追加。

```typescript
interface GitStatus {
  currentBranch: string;        // 'feature/xxx' | '(detached HEAD)' | '(unknown)'
  initialBranch: string | null;
  isBranchMismatch: boolean;    // detached HEAD 時は false
  commitHash: string;           // 短縮形ハッシュ
  isDirty: boolean;
}
```

---

## Should Fix（推奨対応）

### SF-1: パフォーマンス - git コマンドタイムアウト

| 項目 | 内容 |
|------|------|
| カテゴリ | パフォーマンス |
| 重要度 | 中 |

**問題点**:
2秒間隔のポーリング時に毎回 `git rev-parse` を実行すると、リモートNFSマウントやネットワークドライブ上のリポジトリでは遅延が発生する可能性がある。

**推奨対応**:
git コマンド実行にタイムアウト（例: 1秒）を設定し、タイムアウト時はキャッシュ値を返却する設計を検討。

---

### SF-2: UI/UX - アラート再表示条件の明確化

| 項目 | 内容 |
|------|------|
| カテゴリ | UI/UX |
| 重要度 | 中 |

**問題点**:
BranchMismatchAlert の閉じるボタン押下後の再表示条件が不明確。「ブランチが再度変更された場合」の検出ロジックがフロントエンド側で必要。

**推奨対応**:
`previousBranch` state を保持し、`currentBranch !== previousBranch && !dismissed` 条件でアラート再表示。

---

### SF-3: 既存機能との整合性 - 型定義の後方互換性

| 項目 | 内容 |
|------|------|
| カテゴリ | 既存機能との整合性 |
| 重要度 | 中 |

**問題点**:
Worktree interface に `gitStatus` フィールドを追加すると、既存のすべてのコンポーネント（サイドバー、ヘッダー等）で型チェックエラーが発生する可能性がある。

**影響ファイル**:
- `src/types/models.ts`
- `src/components/sidebar/BranchListItem.tsx`
- `src/components/worktree/WorktreeDetailRefactored.tsx`
- `src/components/mobile/MobileHeader.tsx`

**推奨対応**:
`gitStatus?: GitStatus` 形式でオプショナルフィールドとして追加し、後方互換性を維持。

---

### SF-4: テスト - 既存テストへの影響対策

| 項目 | 内容 |
|------|------|
| カテゴリ | テスト |
| 重要度 | 中 |

**問題点**:
Worktree 型の変更により、既存テストが影響を受ける可能性がある。

**影響ファイル**:
- `tests/unit/db.test.ts`
- `tests/integration/api-worktrees.test.ts`
- `tests/integration/api-worktrees-cli-tool.test.ts`

**推奨対応**:
テストでは `gitStatus` フィールドの undefined ケースと値が存在するケースの両方をカバー。

---

## Nice to Have（任意対応）

### NTH-1: ブランチ復帰アクションボタン

警告表示だけでなく「元のブランチに戻る」ボタンがあると便利。将来の機能拡張として検討。

### NTH-2: git status キャッシュ機構

同一ワークツリーへの連続アクセス時に git コマンドを毎回実行せず、短時間キャッシュ（例: 5秒）を設けることでオーバーヘッドを削減。将来の最適化として検討。

---

## 影響範囲分析

### 影響ファイル一覧

| ファイル | 変更タイプ | 影響 |
|---------|-----------|------|
| `src/lib/db-migrations.ts` | 修正 | Migration #15追加（initial_branch カラム）|
| `src/types/models.ts` | 修正 | Worktree interface に gitStatus フィールド追加 |
| `src/lib/db.ts` | 修正 | saveInitialBranch(), getInitialBranch() 関数追加 |
| `src/app/api/worktrees/[id]/route.ts` | 修正 | GET レスポンスに gitStatus フィールド追加 |
| `src/app/api/worktrees/[id]/send/route.ts` | 修正 | startSession() 後に initial_branch 保存処理追加 |
| `src/components/worktree/WorktreeDetailRefactored.tsx` | 修正 | ブランチ情報表示追加 |
| `src/components/mobile/MobileHeader.tsx` | 修正 | ブランチ情報表示追加（省スペース版）|
| `src/components/worktree/BranchMismatchAlert.tsx` | 新規 | 警告コンポーネント作成 |

### 副作用分析

| カテゴリ | 説明 | 重要度 | 対策 |
|---------|------|--------|------|
| パフォーマンス | git rev-parse コマンド実行によるレイテンシ増加（推定 10-50ms/回）| 低 | タイムアウト設定とキャッシュ機構で対応可能 |
| 既存UI | ヘッダー領域の高さ増加（ブランチ情報表示分）| 低 | 既存の repository_name 表示と同様のスタイルで統合 |
| 既存テスト | Worktree 型変更による型エラー | 中 | オプショナルフィールドとして追加し、既存テストの互換性維持 |

### テストカバレッジ

**既存テスト（影響を受ける）**:
- `tests/unit/db.test.ts` - 既存 Worktree CRUD テスト
- `tests/integration/api-worktrees.test.ts` - API エンドポイントテスト

**必要な新規テスト**:
- `tests/unit/db-migrations.test.ts` - Migration #15 テスト追加
- `tests/unit/git-utils.test.ts` - git コマンド実行テスト（新規）
- `tests/unit/components/BranchMismatchAlert.test.tsx` - 新規コンポーネントテスト
- `tests/integration/api-worktrees-git-status.test.ts` - gitStatus レスポンス検証

**推定影響**: 新規テスト 4件追加、既存テスト修正 2件

---

## 結論

Issue #111 の実装は以下の点で適切に設計されている：

1. **後方互換性**: オプショナルフィールド追加による破壊的変更の回避
2. **段階的実装**: DB -> API -> UI の順で依存関係が明確
3. **スコープ制限**: aheadBehind を明示的にスコープ外としてパフォーマンス問題を回避

ただし、以下の点について Issue の明確化が必要：

1. **セッション開始ロジック**: 実際のコード（send/route.ts）に合わせた API 設計の修正
2. **エラーハンドリング**: detached HEAD やコマンド失敗時の挙動定義
3. **パフォーマンス**: git コマンドタイムアウトの設定

これらの点を修正することで、安全かつ効率的な実装が可能と判断する。
