# Issue #96 レビューレポート - Stage 7

**レビュー日**: 2026-01-31
**フォーカス**: 影響範囲レビュー（2回目）
**イテレーション**: 2回目

---

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Stage 3 Must Fix 対応済み | 3 |
| Stage 3 Should Fix 対応済み | 4 |
| 新規 Must Fix | 0 |
| 新規 Should Fix | 2 |
| 新規 Nice to Have | 3 |

**総合評価**: Stage 3で指摘した全ての項目が適切に対応されており、実装に進む準備が整っている。

---

## Stage 3 指摘事項の対応状況

### Must Fix（必須対応）- 全て対応済み

#### MF-1: server.ts で環境変数を直接参照している

| 項目 | 内容 |
|------|------|
| **ステータス** | 対応済み |
| **対応内容** | Issue本文「0. 実装前提条件」セクションにserver.tsの修正要件を明記 |
| **証拠** | getEnvByKey()を使用するコード例も提示済み |

#### MF-2: .npmignore が存在しない

| 項目 | 内容 |
|------|------|
| **ステータス** | 対応済み |
| **対応内容** | Issue本文「3. 作成対象ファイル」に .npmignore を必須ファイルとして追加 |
| **証拠** | 除外内容（tests/, docs/, dev-reports/, .github/等）も詳細に記載 |

#### MF-3: better-sqlite3 のネイティブモジュール対応

| 項目 | 内容 |
|------|------|
| **ステータス** | 対応済み |
| **対応内容** | Issue本文「5. better-sqlite3 のクロスプラットフォーム対応」セクションで詳細記載 |
| **証拠** | 対応プラットフォーム、ビルドツール要件、postinstallスクリプト検討、docs/DEPLOYMENT.md追加内容を記載 |

### Should Fix（推奨対応）- 全て対応済み

| ID | 指摘事項 | 対応内容 |
|----|---------|---------|
| SF-1 | 既存シェルスクリプトとの整合性確認 | 「4. 既存スクリプトとの関係」「移行方針」セクションで詳細記載（移行期間6ヶ月、Deprecation警告、v2.0.0で削除） |
| SF-2 | CLIコマンドのテスト方針が未定義 | 「受け入れ条件 > テスト要件」セクションに各コマンドのユニットテスト、preflightテスト、統合テストを明記 |
| SF-3 | npm publish ワークフローが未定義 | 「7. CI/CD 拡張」セクションでpublish.ymlの詳細（トリガー、処理フロー）を記載 |
| SF-4 | npm publish 時の認証情報管理 | 「6. npm registry 公開方針 > 認証情報管理」でNPM_TOKENのGitHub Secrets管理を明記 |

---

## 新規発見事項

### Should Fix（推奨対応）

#### SF-1: env-setup.tsのテストがテスト要件リストに含まれていない

| 項目 | 内容 |
|------|------|
| **カテゴリ** | テスト |
| **場所** | Issue本文「受け入れ条件 > テスト要件」セクション |
| **問題** | preflight.tsのテストは記載されているが、env-setup.tsのテストが記載されていない |
| **推奨対応** | `tests/unit/cli/utils/env-setup.test.ts` をテスト要件に追加 |
| **影響** | 環境設定ロジックのテストカバレッジ不足 |

#### SF-2: CLIフレームワーク（commander等）の選定が未記載

| 項目 | 内容 |
|------|------|
| **カテゴリ** | 依存関係 |
| **場所** | Issue本文全体 |
| **問題** | CLIエントリポイントとコマンド構造は定義されているが、使用するCLIパーサーライブラリの記載がない |
| **推奨対応** | commander, yargs, oclif等のCLIフレームワーク選定を補足情報として追記するか、実装時に決定する方針を明記 |
| **影響** | 実装時の技術選定の曖昧さ |

### Nice to Have（あれば良い）

| ID | 項目 | 推奨対応 |
|----|------|---------|
| NTH-1 | CLIリファレンスの詳細ドキュメント | docs/cli-reference.md として詳細リファレンス（ユースケース例、トラブルシューティング）を作成検討 |
| NTH-2 | CLIの型定義ファイル | src/cli/types/index.ts として共通型定義を追加検討（コマンドオプション、設定型など） |
| NTH-3 | CLAUDE.mdへのCLIコマンド記載 | CLAUDE.mdの「開発コマンド」セクションにCLIコマンドを追加することを明記 |

---

## 影響範囲の追加分析

### 追加で作成を検討すべきファイル

| ファイル | 説明 | 優先度 |
|---------|------|--------|
| `src/cli/types/index.ts` | CLI型定義ファイル（コマンドオプション、設定型など） | 推奨 |
| `tests/unit/cli/utils/env-setup.test.ts` | env-setup.tsのユニットテスト | 必須 |
| `docs/cli-reference.md` | CLIコマンドの詳細リファレンス | 推奨 |

### 追加の依存関係

| モジュール | 説明 | 状況 |
|-----------|------|------|
| commander / yargs | CLIコマンドパーサーライブラリ | Issueに未記載 |

### 破壊的変更の確認

| 変更 | 評価 | ステータス |
|------|------|----------|
| package.json の private: true 削除 | 適切に文書化済み。ユーザー影響なし。 | OK |
| bin フィールド追加 | 適切に文書化済み。新機能として問題なし。 | OK |

---

## 参照ファイル

### コード

| ファイル | 関連性 |
|---------|--------|
| `/Users/maenokota/share/work/github_kewton/MyCodeBranchDesk/server.ts` | 環境変数の直接参照の修正対象 - Issue記載済み |
| `/Users/maenokota/share/work/github_kewton/MyCodeBranchDesk/src/lib/env.ts` | getEnvByKey()関数の参照元 - Issue記載済み |
| `/Users/maenokota/share/work/github_kewton/MyCodeBranchDesk/package.json` | private削除、bin追加の対象 - Issue記載済み |

### ドキュメント

| ファイル | 関連性 |
|---------|--------|
| `/Users/maenokota/share/work/github_kewton/MyCodeBranchDesk/docs/DEPLOYMENT.md` | better-sqlite3ビルドツール要件追加の対象 |
| `/Users/maenokota/share/work/github_kewton/MyCodeBranchDesk/docs/release-guide.md` | npm publish手順追加の対象 |
| `/Users/maenokota/share/work/github_kewton/MyCodeBranchDesk/README.md` | npmインストール手順追加の対象 |

---

## 結論

Stage 3で指摘した全ての項目（Must Fix 3件、Should Fix 4件）が適切に対応されている。Issue #96は影響範囲が適切に特定・文書化されており、実装フェーズに進む準備が整っている。

新たに発見したShould Fix 2件については、実装開始前に対応することを推奨するが、実装時に判断しても問題ない程度の軽微な指摘である。

---

**レビュー完了**: 2026-01-31
**レビュアー**: Claude Code (Issue Review Agent)
