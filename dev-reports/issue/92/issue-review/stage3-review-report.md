# Issue #92 影響範囲レビューレポート

**レビュー日**: 2026-01-30
**フォーカス**: 影響範囲レビュー
**イテレーション**: 1回目
**ステージ**: 3

---

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 1 |
| Should Fix | 3 |
| Nice to Have | 3 |

---

## Must Fix（必須対応）

### MF-1: PRODUCTION_CHECKLIST.md が更新対象から漏れている

**カテゴリ**: 影響ファイル
**場所**: 実装内容セクション（ドキュメント更新）

**問題**:
`docs/internal/PRODUCTION_CHECKLIST.md` が旧名称 `MCBD_*` を使用しており、Issueのドキュメント更新対象から漏れている。

**証拠**:
```markdown
# PRODUCTION_CHECKLIST.md (lines 10-12)
- [ ] `MCBD_ROOT_DIR` がワークツリーのルートディレクトリを正しく指している
- [ ] `MCBD_BIND=0.0.0.0` が設定されている（外部アクセスを許可する場合）
- [ ] `MCBD_AUTH_TOKEN` が安全なランダム値に設定されている（必須）

# PRODUCTION_CHECKLIST.md (lines 85-86)
- [ ] 認証トークンが設定されている（`MCBD_AUTH_TOKEN`）
- [ ] トークンが `.env` ファイルに保存され、Git に含まれていない
```

**推奨対応**:
`PRODUCTION_CHECKLIST.md` を実装内容セクションの「5. ドキュメント更新」に追加し、`MCBD_*` を `CM_*` に更新する対象として明記。

---

## Should Fix（推奨対応）

### SF-1: 新規スクリプトのテスト方針が未記載

**カテゴリ**: テスト範囲
**場所**: 受け入れ条件セクション

**問題**:
`preflight-check.sh` と `setup-env.sh` の具体的なテスト方針が明記されていない。

**証拠**:
受け入れ条件には「チェックする」「生成する」といった動作確認が含まれるが、具体的なテスト手順が未記載。
- 依存が無い環境での `preflight-check.sh` の動作確認
- 対話式入力のエッジケース（空入力、不正入力）のテスト
- 既存 `.env` のバックアップ機能のテスト

**推奨対応**:
受け入れ条件または別セクションに、手動テスト手順を追加。例：
- `preflight-check.sh` を各依存が無い環境で実行し、適切なエラーメッセージが表示されることを確認
- `setup-env.sh` で既存 `.env` がバックアップされることを確認

---

### SF-2: 既存ユーザーへの移行パスが不明確

**カテゴリ**: 後方互換性
**場所**: Issue全体

**問題**:
`setup.sh` の動作が変更されるため、既存ユーザー（特に `MCBD_*` 形式の `.env` を使用中のユーザー）への影響が考慮されていない。

**証拠**:
- 現在の `setup.sh` は `.env.production.example` からコピー
- 新しい `setup.sh` は `setup-env.sh` で対話式生成
- 既存の `.env`（MCBD_* 形式）を持つユーザーがどうすべきか未記載

**推奨対応**:
以下のいずれかを追加：
1. 既存ユーザー向けの移行手順セクション
2. `setup-env.sh` に「既存の .env を CM_* 形式に変換するオプション」

---

### SF-3: openssl 依存が事前チェックに含まれていない

**カテゴリ**: 依存関係
**場所**: preflight-check.sh の実装内容

**問題**:
`setup-env.sh` でトークン生成に `openssl rand -hex 32` を使用するが、`openssl` が無い環境での動作が未考慮。

**証拠**:
```
preflight-check.sh のチェック項目:
- Node.js: 必須
- npm: 必須
- tmux: 必須
- git: 必須
- Claude CLI: 必須（後からインストール可）
- openssl: 未記載 <-- ここ
```

**推奨対応**:
以下のいずれかを実施：
1. `preflight-check.sh` に `openssl` のチェックを追加（任意依存として警告レベル）
2. `setup-env.sh` で `openssl` が無い場合の代替手段を実装（例: `/dev/urandom` を使用）

---

## Nice to Have（あれば良い）

### NTH-1: 移行ガイドへの影響が未検討

**カテゴリ**: ドキュメント影響
**場所**: 実装内容セクション

**問題**:
`docs/migration-to-commandmate.md` は MCBD_* から CM_* への移行を説明するドキュメントであり、新スクリプトとの関連性がある。

**推奨対応**:
移行ガイドに新しいセットアップスクリプト（`setup-env.sh`）の使用方法を追加することを検討。

---

### NTH-2: Webアプリ操作ガイドへの影響

**カテゴリ**: 影響ファイル
**場所**: 実装内容セクション

**問題**:
`docs/user-guide/webapp-guide.md` は README.md の関連ドキュメントに含まれているが、セットアップ手順との連携が未検討。

**推奨対応**:
Webアプリ操作ガイドの冒頭に初期セットアップへのリンクを追加することを検討。

---

### NTH-3: CI/CD パイプラインでのスクリプト検証

**カテゴリ**: テスト範囲
**場所**: 受け入れ条件セクション

**問題**:
新規追加されるシェルスクリプトに対するCIレベルでの品質保証が未定義。

**推奨対応**:
将来的に以下をCIに追加することを検討：
- シェルスクリプトの構文チェック（`shellcheck`）
- ヘルプオプション出力のスモークテスト

---

## 影響分析

### 影響を受けるファイル

| ファイル | 種別 | 説明 |
|---------|------|------|
| `scripts/preflight-check.sh` | 新規 | 依存チェックスクリプト |
| `scripts/setup-env.sh` | 新規 | 対話式環境変数設定スクリプト |
| `scripts/setup.sh` | 変更 | 新スクリプトの統合フロー |
| `.env.production.example` | 変更 | MCBD_* から CM_* への更新 |
| `README.md` | 変更 | Quick Start セクションの簡素化 |
| `docs/DEPLOYMENT.md` | 変更 | 新スクリプトの使用方法追記 |
| `docs/internal/PRODUCTION_CHECKLIST.md` | 更新推奨 | MCBD_* 参照を CM_* に更新 |

### 影響を受ける機能

1. **初期セットアップフロー** - 完全に刷新される
2. **環境変数設定** - 対話式生成に変更
3. **依存関係チェック** - 新規追加
4. **本番環境デプロイ** - 手順が簡素化

### 後方互換性

| 項目 | 状態 | 対応策 |
|------|------|--------|
| MCBD_* 環境変数 | サポート継続 | Issue #76 のフォールバック機能により担保 |
| setup.sh の動作 | 変更あり | ドキュメントに移行手順を明記 |
| .env.production.example | 形式変更 | 旧形式を使用中のユーザーへの案内必要 |

### テスト要件

**手動テスト**:
- [ ] preflight-check.sh: 各依存が存在する/しない環境での動作確認
- [ ] setup-env.sh: 対話式入力の動作確認
- [ ] setup-env.sh: 既存 .env のバックアップ確認
- [ ] setup.sh: 統合フローの E2E 確認

**自動化検討**:
- [ ] シェルスクリプトの構文チェック（shellcheck）
- [ ] ヘルプオプション出力確認

### ドキュメント更新要件

**必須**:
- README.md - Quick Start セクション
- docs/DEPLOYMENT.md - セットアップ手順

**推奨**:
- docs/internal/PRODUCTION_CHECKLIST.md - 環境変数名の更新
- .env.production.example - CM_* 形式への更新

**任意**:
- docs/migration-to-commandmate.md - 新スクリプトとの連携
- CHANGELOG.md - 変更点の記録

---

## 参照ファイル

### コード
| ファイル | 関連性 |
|---------|--------|
| `scripts/setup.sh` (lines 27-28) | 現在の .env.production.example からのコピー処理 |
| `scripts/build-and-start.sh` (line 25) | 既存の --daemon オプション実装 |
| `src/lib/env.ts` (lines 20-29) | ENV_MAPPING による CM_* と MCBD_* のフォールバック定義 |
| `.env.production.example` (全体) | 現在の MCBD_* 形式の環境変数定義 |
| `docs/internal/PRODUCTION_CHECKLIST.md` (lines 10-12, 85-86) | MCBD_* 環境変数への参照 |

### ドキュメント
| ファイル | 関連性 |
|---------|--------|
| `docs/DEPLOYMENT.md` | セットアップ手順の記述、更新必須 |
| `docs/internal/PRODUCTION_CHECKLIST.md` | 本番チェックリスト、MCBD_* 参照あり |
| `README.md` | Quick Start セクション、更新必須 |
| `docs/migration-to-commandmate.md` | 移行ガイド、新スクリプトとの連携検討 |

---

## 総括

Issue #92 は全体的に影響範囲が明確に定義されているが、以下の点について追加の考慮が必要：

1. **PRODUCTION_CHECKLIST.md の更新漏れ**（Must Fix）- ドキュメントの一貫性のため対応必須
2. **テスト方針の明確化**（Should Fix）- 品質保証のため具体的なテスト手順を追加推奨
3. **既存ユーザーへの移行パス**（Should Fix）- 後方互換性の観点から案内を追加推奨
4. **openssl 依存**（Should Fix）- 環境依存を減らすため代替手段の検討推奨

影響を受けるファイルは7ファイル（新規2、変更4、更新推奨1）で、範囲は限定的。後方互換性は Issue #76 のフォールバック機能により部分的に担保されており、適切なドキュメント更新で対応可能。
