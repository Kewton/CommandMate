# 設計方針書: Issue #79 Phase 4 - 移行ガイド・リリース準備

## 1. 概要

### 1.1 目的
CommandMateリネームの最終フェーズとして、移行ガイドの作成、後方互換サポートの整備、リリース準備を行う。

### 1.2 親Issue
- #74 Rename/Brand update: MyCodeBranchDesk → CommandMate

### 1.3 依存関係
- **前提**: Issue #76（環境変数フォールバック実装）完了済み
- **前提**: Issue #75（ドキュメント・UI表示変更）完了済み
- **前提**: Issue #77（設定・コード内の名称置換）完了済み

### 1.4 破壊的変更
**なし** - ドキュメント・告知のみ

### 1.5 レビュー履歴

| 日付 | レビュー結果 | 対応 |
|------|-------------|------|
| 2026-01-29 | Stage 4: セキュリティレビュー | MF-0件、SF-2件を反映（systemd認証、v2.0.0動作明確化） |
| 2026-01-29 | Stage 3: 影響分析レビュー | MF-0件、SF-2件を反映（README.mdリンク、#80更新リスト） |
| 2026-01-29 | Stage 2: 整合性レビュー | MF-1件（CHANGELOG重複確認）、SF-3件を反映 |
| 2026-01-29 | Stage 1: 通常レビュー | MF-1件（クローン関連設定削除）、SF-3件を反映 |
| - | 初版作成 | - |

---

## 2. 実施内容

### 2.1 移行ガイドの構成

#### ファイルパス
`docs/migration-to-commandmate.md`

#### 構成内容

1. **概要**: リネームの背景と目的
2. **環境変数マッピング表**: 全9種類（サーバー8種 + クライアント1種）
3. **既存環境の移行手順**
   - `.env`ファイルの更新手順
   - Git remoteの更新手順（#80完了後）
   - ローカルディレクトリ名の更新（任意）
   - Docker環境の更新手順
4. **systemdサービス移行手順**
5. **Claude Code設定の更新手順** (`.claude/settings.local.json`)
6. **後方互換サポートの説明**
7. **トラブルシューティング**

### 2.2 環境変数マッピング（全9種類）

> **Note**: 環境変数マッピングの正式な定義は `src/lib/env.ts` の `ENV_MAPPING` を Single Source of Truth とする。移行ガイドではこれを参照する。
>
> **内訳**: サーバー側8種類（`ENV_MAPPING`で定義）+ クライアント側1種類 = **計9種類**

#### サーバー基本設定（8種 - ENV_MAPPINGで定義）
| 旧名称 | 新名称 | 用途 |
|--------|--------|------|
| `MCBD_ROOT_DIR` | `CM_ROOT_DIR` | ワークツリールートディレクトリ |
| `MCBD_PORT` | `CM_PORT` | サーバーポート |
| `MCBD_BIND` | `CM_BIND` | バインドアドレス |
| `MCBD_AUTH_TOKEN` | `CM_AUTH_TOKEN` | 認証トークン |
| `MCBD_LOG_LEVEL` | `CM_LOG_LEVEL` | ログレベル |
| `MCBD_LOG_FORMAT` | `CM_LOG_FORMAT` | ログフォーマット |
| `MCBD_LOG_DIR` | `CM_LOG_DIR` | ログディレクトリ |
| `MCBD_DB_PATH` | `CM_DB_PATH` | DBファイルパス |

#### クライアント設定（1種）
| 旧名称 | 新名称 | 用途 |
|--------|--------|------|
| `NEXT_PUBLIC_MCBD_AUTH_TOKEN` | `NEXT_PUBLIC_CM_AUTH_TOKEN` | クライアント側認証トークン |

---

## 3. 詳細設計

### 3.1 移行ガイド構成

```markdown
# CommandMate 移行ガイド

## 概要
MyCodeBranchDesk は CommandMate にリネームされました。

## 環境変数の変更
### サーバー基本設定
[表形式]

### ログ設定
[表形式]

### データベース・クローン設定
[表形式]

### クライアント側
[表形式]

## 移行手順
### 1. 環境変数の移行
### 2. Git remoteの更新（#80完了後）
### 3. ローカルディレクトリ名の更新（任意）
### 4. Docker環境の更新
### 5. systemdサービスの移行
### 6. Claude Code設定の更新

## 後方互換サポート
### フォールバック機能
### Deprecation警告
### サポート終了予定

## トラブルシューティング
### よくある問題
### ログの確認方法
```

### 3.2 systemdサービス移行手順

> **Note**: サービス名は環境によって異なる場合があります。以下の例では `mycodebranch-desk` を使用していますが、実際のサービス名に合わせて読み替えてください。

```bash
# 1. 現在のサービスを停止
# ※ YOUR_SERVICE_NAME は既存のサービス名に置き換えてください
sudo systemctl stop mycodebranch-desk
sudo systemctl disable mycodebranch-desk

# 2. サービスファイルをリネーム
sudo mv /etc/systemd/system/mycodebranch-desk.service \
        /etc/systemd/system/commandmate.service

# 3. サービスファイル内の設定を更新
# - Description=: MyCodeBranchDesk → CommandMate
# - WorkingDirectory=: ディレクトリ名を変更した場合は更新
# - Environment=: MCBD_* → CM_*（任意、フォールバックあり）
#
# ⚠️ セキュリティ推奨事項:
# 認証トークン（CM_AUTH_TOKEN）はサービスファイルに直接記述せず、
# EnvironmentFile= で外部ファイルから読み込むか、systemd-creds を使用してください
# 例: EnvironmentFile=/etc/commandmate/env

# 4. systemdをリロードして新サービスを開始
sudo systemctl daemon-reload
sudo systemctl enable commandmate
sudo systemctl start commandmate
sudo systemctl status commandmate

# 5. 旧サービスファイルの削除（任意）
sudo rm /etc/systemd/system/mycodebranch-desk.service
sudo systemctl daemon-reload
```

### 3.3 Claude Code設定の更新手順

> **Note**: ディレクトリ名を変更しなかった場合、Claude Code設定の更新は不要です。

```bash
# ディレクトリ名を変更した場合のみ実行
sed -i '' 's/MyCodeBranchDesk/commandmate/g' .claude/settings.local.json
```

**更新が必要なケース**:
- プロジェクトディレクトリ名を `MyCodeBranchDesk` から `commandmate` 等に変更した場合

**更新が不要なケース**:
- ディレクトリ名をそのまま維持している場合
- `.claude/settings.local.json` が存在しない場合

> **Note**: 絶対パスは環境依存のため、各開発者が個別に確認する必要がある

### 3.4 CHANGELOG.md 更新手順

#### 事前確認（重複チェック）
CHANGELOG.md追記前に、既存の`[Unreleased]`セクションを確認し、以下の項目と重複がないことを確認する：
- Issue #76 の変更（環境変数フォールバック）
- Issue #75 の変更（ブランディング更新）
- Issue #77 の変更（名称置換）

#### 追記内容
`[Unreleased]`の`### Added`セクションに以下を追記（重複がない場合のみ）：

```markdown
### Added
- Migration guide for existing users (`docs/migration-to-commandmate.md`)
- systemd service migration instructions
- Claude Code settings update instructions
```

> **Note**: 既にAddedセクションに類似の記載がある場合は、内容を確認し重複を避けること

---

## 4. 対象ファイル一覧

| ファイル | アクション | 内容 |
|---------|----------|------|
| `docs/migration-to-commandmate.md` | 新規作成 | 移行ガイド |
| `CHANGELOG.md` | 更新 | Migration guide追加を記載 |
| `README.md` | 更新（推奨） | 移行ガイドへのリンク追加 |

---

## 5. テスト戦略

### 5.1 ドキュメントの検証

| 検証項目 | 方法 |
|---------|------|
| Markdown構文 | `npm run lint` でMarkdown lintが通ること |
| リンク整合性 | 相対リンクが正しいこと |
| 環境変数の網羅性 | 全9種類が記載されていること |

### 5.2 品質確認

```bash
npx tsc --noEmit
npm run lint
npm run test:unit
npm run build
```

---

## 6. セキュリティ設計

### 6.1 移行ガイド内のセキュリティ考慮事項

| 考慮点 | 対応 |
|-------|------|
| 認証トークンの例示 | `your-secret-token` のプレースホルダーを使用 |
| 機密情報のログ出力 | CM_AUTH_TOKEN はログにマスキングされることを明記 |
| 本番環境での注意点 | 認証が必須な状況を明記 |

### 6.2 後方互換サポートの終了予定

| 項目 | 内容 |
|------|------|
| 現行バージョン | Unreleased（開発版） |
| 現行サポート | `MCBD_*` 環境変数はフォールバック機能により動作 |
| Deprecation警告 | 旧名称使用時にログ出力（同一キー1回のみ） |
| **サポート終了予定** | **次のメジャーバージョン（v2.0.0）** で旧名称のサポートを終了 |
| フォールバック期間 | 正式リリース後、1メジャーバージョンの間サポート継続 |
| **v2.0.0以降の動作** | 旧名称（`MCBD_*`）は完全に無視され、デフォルト値にフォールバック |

> **Note**: CHANGELOG.md の Deprecated セクションと整合性を保つこと
>
> **重要**: v2.0.0以降、旧名称（`MCBD_*`）を使用し続けた場合、アプリケーションは環境変数が未設定として扱い、デフォルト値を使用します。必ずv2.0.0アップグレード前に`CM_*`への移行を完了してください。

---

## 7. 実装チェックリスト

### Step 1: 移行ガイド作成
- [ ] `docs/migration-to-commandmate.md` を新規作成
- [ ] 概要セクション作成
- [ ] 環境変数マッピング表（全9種類）作成
- [ ] 移行手順セクション作成
- [ ] systemdサービス移行手順作成
- [ ] Claude Code設定更新手順作成
- [ ] 後方互換サポート説明作成
- [ ] トラブルシューティングセクション作成

### Step 2: CHANGELOG.md 更新
- [ ] 既存の`[Unreleased]`セクションの内容を確認（重複チェック）
- [ ] Migration guide追加を記載（重複がない場合のみ）

### Step 2.5: README.md 更新（推奨）
- [ ] 関連ドキュメントセクションに移行ガイドへのリンク追加

### Step 3: 品質確認
- [ ] TypeScriptコンパイルエラーなし (`npx tsc --noEmit`)
- [ ] ESLintエラーなし (`npm run lint`)
- [ ] 既存テストがすべてパス (`npm run test:unit`)
- [ ] ビルド成功 (`npm run build`)

### Step 4: クリーンアップ
- [ ] 不要な一時ファイルの削除
- [ ] workspace/ 配下の作業ドキュメント整理

---

## 8. 受け入れ条件

- [ ] 移行ガイド（`docs/migration-to-commandmate.md`）が整備されている
- [ ] **全9種類の環境変数マッピング**が記載されている
- [ ] **既存環境の移行手順**が具体的に記載されている
- [ ] **systemdサービス移行手順**が記載されている
- [ ] **.claude/settings.local.json の更新手順**が記載されている
- [ ] フォールバック期間が明記されている
- [ ] **CHANGELOG.md が最終整理されている**
- [ ] 全テストがパスする

---

## 9. 関連ドキュメント

- [親Issue #74](https://github.com/Kewton/MyCodeBranchDesk/issues/74) - リネーム計画全体
- [Issue #76設計書](./issue-76-env-fallback-design-policy.md) - 環境変数フォールバック実装
- [Issue #75設計書](./issue-75-design-policy.md) - ドキュメント・UI表示の変更
- [Issue #77設計書](./issue-77-rename-phase3-design-policy.md) - 設定・コード内の名称置換
- [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) - CHANGELOG形式

---

## 10. 補足: GitHub URL に関する注意

> **重要**: 移行ガイド内のGitHub URL（リポジトリリンク、clone URL等）は、本Issue時点では旧URL（`Kewton/MyCodeBranchDesk`）で記載する。#80（GitHubリポジトリ名変更）完了後に新URL（`Kewton/CommandMate`）へ更新すること。

### 10.1 Issue #80 完了後の更新箇所チェックリスト

Issue #80 完了後、以下の箇所を新URL（`Kewton/CommandMate`）に更新する必要がある：

| 更新箇所 | 現在の記載 | 更新後 |
|---------|----------|-------|
| 移行ガイド内のclone URL | `git clone https://github.com/Kewton/MyCodeBranchDesk.git` | `git clone https://github.com/Kewton/CommandMate.git` |
| 移行ガイド内のgit remote例 | `git@github.com:Kewton/MyCodeBranchDesk.git` | `git@github.com:Kewton/CommandMate.git` |
| README.md内のリポジトリリンク | 各種GitHub URL | 新URL |
| CONTRIBUTING.md内のリンク | 各種GitHub URL | 新URL |

> **Note**: これらの更新は Issue #80 のスコープで実施する

---

## 11. ロールバック計画

本Issueはドキュメント追加のみのため、ロールバックは容易。

### 問題発生時の対応

```bash
git revert <commit-hash>
```

または、

```bash
rm docs/migration-to-commandmate.md
git checkout HEAD~1 -- CHANGELOG.md
```
