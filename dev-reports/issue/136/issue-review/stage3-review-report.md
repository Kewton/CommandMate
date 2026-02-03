# Issue #136 影響範囲レビューレポート（Stage 3）

**レビュー日**: 2026-02-03
**フォーカス**: 影響範囲レビュー
**イテレーション**: 1回目
**Issue URL**: https://github.com/Kewton/CommandMate/issues/136

---

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 3 |
| Should Fix | 5 |
| Nice to Have | 3 |

本レビューでは、Issue #136「Git Worktree 並列開発環境の整備」の提案された変更が既存システムに与える影響範囲を分析しました。

---

## Must Fix（必須対応）

### MF-1: Issue #135との依存関係（ブロッキング依存）

**カテゴリ**: 依存関係影響
**場所**: ## 依存関係 セクション

**問題**:
Issue #135（DBパス解決ロジック修正）が「依存: 先に完了が必要」と明記されているが、現時点で#135は **OPEN状態** です。本Issueの実装順序に直接影響します。

**証拠**:
- `gh issue view 135` の結果: `state: OPEN`
- 本Issueではdb-path-resolver.tsに`getIssueDbPath()`を追加する計画
- Issue #135もdb-path-resolver.tsを変更対象としている

**推奨対応**:
1. Issue #135の完了を待ってから本Issueの実装を開始する
2. または、#135と#136を同時に実装する場合の競合回避戦略を明記:
   - Phase 1: #135でdb-path-resolver.tsのバグ修正を完了
   - Phase 2: #136で`getIssueDbPath()`を追加
3. 依存関係セクションに#135のステータス確認手順を追加

---

### MF-2: DBマイグレーション計画の欠如

**カテゴリ**: 互換性影響
**場所**: ### ポート管理設計 セクション

**問題**:
external_appsテーブルへの`issue_no`カラム追加が計画されていますが、これには新規DBマイグレーション（Migration #16）が必要です。現在のマイグレーション計画に含まれていません。

**証拠**:
```typescript
// src/lib/db-migrations.ts
export const CURRENT_SCHEMA_VERSION = 15;
```
- external_appsテーブルはMigration #12で作成
- カラム追加にはALTER TABLE文を含む新規マイグレーションが必須

**推奨対応**:
1. 影響範囲テーブルに以下を追加:
   | ファイル | 変更内容 |
   |---------|---------|
   | `src/lib/db-migrations.ts` | Migration #16追加（external_appsへissue_noカラム） |

2. Migration #16の内容例:
```typescript
{
  version: 16,
  name: 'add-issue-no-to-external-apps',
  up: (db) => {
    db.exec(`
      ALTER TABLE external_apps ADD COLUMN issue_no INTEGER;
    `);
  }
}
```

---

### MF-3: システムリソース使用量の考慮不足

**カテゴリ**: パフォーマンス影響
**場所**: Issue全体

**問題**:
複数のNext.jsサーバーを同時起動する設計ですが、システムリソース（メモリ、CPU、ポート）の使用量に関する考慮が不足しています。

**証拠**:
- ポート範囲: 3001-3100（最大100個のWorktreeをサポートする想定）
- Next.jsサーバー1インスタンスあたりのメモリ使用量: 約200-500MB
- 10個のWorktreeを同時起動すると2-5GBのメモリが必要

**推奨対応**:
1. 同時起動可能なWorktree数の推奨上限を設定（例: 5-10個）
2. リソース要件をドキュメントに明記:
   - 最小要件: 8GB RAM（5 Worktree同時起動）
   - 推奨: 16GB RAM（10 Worktree同時起動）
3. ポートアロケータにリソースチェック機能を追加する検討

---

## Should Fix（推奨対応）

### SF-1: 既存テストへの影響範囲が不明確

**カテゴリ**: テスト影響
**場所**: ## テスト計画 セクション

**問題**:
`getPidFilePath()`の引数拡張により、既存のユニットテスト/統合テストへの影響が発生する可能性があります。

**推奨対応**:
1. 既存テストファイルの影響調査:
   - `tests/unit/cli/utils/env-setup.test.ts` - getPidFilePath()のテスト
   - `tests/unit/cli/utils/pid-manager.test.ts` - PidManagerのテスト
2. テスト計画に「既存テストの修正」項目を追加

---

### SF-2: ログ管理・監視方法の未定義

**カテゴリ**: 運用影響
**場所**: ### 2.4 ログ分離 セクション

**問題**:
各Worktreeが独立したログディレクトリを持つ設計は妥当ですが、複数Worktreeのログを一元的に確認する運用方法が未定義です。

**推奨対応**:
1. ログ集約方法の検討（例: `commandmate logs --all`コマンド）
2. ログローテーション・保持期間の方針を追加
3. 運用ガイド（`docs/dev-guide/worktree-development.md`）にログ確認手順を記載

---

### SF-3: daemon.tsの変更内容の詳細化

**カテゴリ**: 影響ファイル
**場所**: ### 変更対象ファイル テーブル

**問題**:
daemon.tsの変更内容「複数.envファイルのマージ読み込み対応」は記載されていますが、DaemonManagerクラスの変更有無が不明確です。

**推奨対応**:
DaemonManagerがissueNoを引数として受け取る必要があるか検討し、明確化:

```typescript
// 現在の設計
constructor(pidFilePath: string) {}

// 拡張が必要な場合
constructor(pidFilePath: string, issueNo?: number) {}
```

---

### SF-4: External Appキャッシュへの影響

**カテゴリ**: 依存関係影響
**場所**: ### 3. CommandMate External Apps 連携 セクション

**問題**:
`src/lib/external-apps/cache.ts`のgetByPathPrefix()がissueNoフィールドを考慮する必要がある場合、キャッシュ無効化ロジックの変更が必要です。

**推奨対応**:
1. 影響ファイルリストに`src/lib/external-apps/cache.ts`を追加
2. キャッシュ戦略（pathPrefixベースのまま or issueNoも考慮）を明確化

---

### SF-5: 後方互換性の明示的確認

**カテゴリ**: 破壊的変更
**場所**: ### 2.3 PID ファイル分離 セクション

**問題**:
`getPidFilePath(issueNo?: number)`の設計で後方互換性を維持する方針は妥当ですが、既存の呼び出し箇所が正しく動作することの確認が必要です。

**推奨対応**:
テスト計画に以下を追加:
- 既存のstart/stop/statusコマンドが引数なしで動作することの回帰テスト

---

## Nice to Have（あれば良い）

### NTH-1: CLIヘルプメッセージの更新

**カテゴリ**: ドキュメント更新
**場所**: ## 影響範囲 セクション

`commandmate start --auto-port`フラグ追加に伴い、`src/cli/index.ts`のCLIヘルプメッセージ更新を影響ファイルに追加することを推奨。

---

### NTH-2: 既存ユーザーのマイグレーションパス

**カテゴリ**: 移行考慮
**場所**: Issue全体

既存のメインDB（cm.db）を使用しているユーザーがWorktree機能を使い始める際の手順・注意点を検討。

---

### NTH-3: CI/CDパイプライン動作の詳細化

**カテゴリ**: CI/CD影響
**場所**: ### CI/CD対応（必須）セクション

develop -> mainへのPRとfeature -> developへのPRで異なるCI動作が必要かどうかを検討。

---

## 影響範囲サマリー

### 直接的な影響ファイル

| ファイル | 変更内容 |
|---------|---------|
| `src/lib/db-path-resolver.ts` | `getIssueDbPath(issueNo: number)` 追加 |
| `src/cli/utils/env-setup.ts` | `getPidFilePath(issueNo?)` 拡張 |
| `src/cli/utils/pid-manager.ts` | Issue番号対応のマルチPID対応 |
| `src/cli/utils/daemon.ts` | 複数.envファイルのマージ読み込み対応 |
| `src/cli/commands/start.ts` | `--auto-port` フラグ追加 |
| `src/types/external-apps.ts` | `issueNo?: number` フィールド追加 |
| `src/lib/db-migrations.ts` | Migration #16追加（external_appsへissue_noカラム）**[要追加]** |
| `.github/workflows/ci-pr.yml` | `branches: [main, develop]` に更新 |
| `CLAUDE.md` | ブランチ戦略セクション全体更新 |

### 間接的な影響ファイル

| ファイル | 影響内容 |
|---------|---------|
| `src/lib/external-apps/db.ts` | issueNoフィールド対応（createExternalApp等） |
| `src/lib/external-apps/cache.ts` | キャッシュ構造変更の可能性 |
| `src/app/proxy/[...path]/route.ts` | ルーティングロジック確認 |
| `src/cli/commands/stop.ts` | getPidFilePath()呼び出し確認 |
| `src/cli/commands/status.ts` | getPidFilePath()呼び出し確認 |
| `src/cli/index.ts` | CLIヘルプメッセージ更新 |

### 新規作成ファイル

| ファイル | 内容 |
|---------|------|
| `src/cli/utils/worktree-detector.ts` | Worktree検出ユーティリティ |
| `src/cli/utils/port-allocator.ts` | ポート自動割り当て |
| `.claude/skills/worktree-setup/SKILL.md` | セットアップスキル |
| `.claude/skills/worktree-cleanup/SKILL.md` | クリーンアップスキル |
| `docs/dev-guide/worktree-development.md` | 開発者向けガイド |

---

## 依存関係

### ブロッキング依存（先に完了が必要）

| Issue | タイトル | 状態 | 影響 |
|-------|---------|------|------|
| #135 | バージョンアップ時にDBクリア | **OPEN** | db-path-resolver.ts変更の前提条件 |

### 関連Issue（参照・連携）

| Issue | タイトル | 関係 |
|-------|---------|------|
| #96 | npm CLIサポート | CLI拡張の基盤 |
| #125 | グローバルインストール.env読み込み | .env処理の参照 |
| #42 | External Apps プロキシルーティング | 既存実装として参照 |

---

## リソース考慮事項

| リソース | 考慮事項 |
|---------|---------|
| **メモリ** | 複数Next.jsサーバー同時起動により、1サーバーあたり約200-500MBのメモリ消費 |
| **ポート** | 3001-3100のポート範囲（最大100個）を使用 |
| **ディスク** | 各Worktreeに独立したDB、PID、ログファイルが作成される |

**推奨上限**: 同時起動Worktree数 5-10個（8-16GB RAMの環境）

---

## 次のステップ

1. 本レビュー指摘事項をIssueに反映（Stage 4: Apply Review Findings）
2. Stage 5: 影響範囲レビュー 2回目で修正確認

---

*Generated by Issue Review Agent (Stage 3)*
