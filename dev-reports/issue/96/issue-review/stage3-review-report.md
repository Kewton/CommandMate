# Issue #96 影響範囲レビューレポート

**レビュー日**: 2026-01-31
**フォーカス**: 影響範囲レビュー
**イテレーション**: 1回目（Stage 3）

---

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 3 |
| Should Fix | 4 |
| Nice to Have | 3 |

### 影響規模

| 項目 | 件数 |
|------|------|
| 新規作成ファイル | 9 |
| 修正対象ファイル | 7 |
| 必要なテスト | 7 |
| 更新ドキュメント | 6 |

**総合評価**: 大規模な変更。新規ファイル作成が多く、既存機能への影響は限定的だが、package.json の変更は重要な破壊的変更。

---

## 影響範囲分析

### 1. 新規作成ファイル

| ファイルパス | 説明 | 優先度 |
|-------------|------|--------|
| `bin/commandmate.js` | CLIエントリポイント（shebang付き） | 必須 |
| `src/cli/index.ts` | CLIメインロジック | 必須 |
| `src/cli/commands/init.ts` | initコマンド実装 | 必須 |
| `src/cli/commands/start.ts` | startコマンド実装 | 必須 |
| `src/cli/commands/stop.ts` | stopコマンド実装 | 必須 |
| `src/cli/commands/status.ts` | statusコマンド実装 | 必須 |
| `src/cli/utils/preflight.ts` | 依存関係チェック（TypeScript移植） | 必須 |
| `src/cli/utils/env-setup.ts` | 環境設定（TypeScript移植） | 必須 |
| `.npmignore` | npm publish除外設定 | 必須 |

### 2. 修正対象ファイル

| ファイルパス | 変更内容 | 影響度 | 破壊的変更 |
|-------------|---------|--------|-----------|
| `package.json` | private削除, bin追加, engines追加 | 高 | Yes |
| `README.md` | npm install手順追加 | 中 | No |
| `docs/DEPLOYMENT.md` | CLIセットアップ手順追加 | 中 | No |
| `docs/release-guide.md` | npm publish手順追加 | 中 | No |
| `server.ts` | 環境変数参照の統一 | 中 | No |
| `docs/migration-to-commandmate.md` | npm移行手順追加 | 低 | No |
| `CHANGELOG.md` | 変更記録 | 低 | No |

### 3. 必要なテスト

| テストファイル | 説明 | 優先度 |
|---------------|------|--------|
| `tests/unit/cli/index.test.ts` | CLIエントリポイント | 必須 |
| `tests/unit/cli/commands/init.test.ts` | initコマンド | 必須 |
| `tests/unit/cli/commands/start.test.ts` | startコマンド | 必須 |
| `tests/unit/cli/commands/stop.test.ts` | stopコマンド | 必須 |
| `tests/unit/cli/commands/status.test.ts` | statusコマンド | 必須 |
| `tests/unit/cli/utils/preflight.test.ts` | 依存関係チェック | 必須 |
| `tests/integration/cli-e2e.test.ts` | CLI統合テスト | 推奨 |

### 4. CI/CD への影響

| ファイル | 変更内容 | 優先度 |
|---------|---------|--------|
| `.github/workflows/ci-pr.yml` | CLIテストステップ追加 | 推奨 |
| `.github/workflows/publish.yml`（新規） | npm publish自動化 | 推奨 |

---

## Must Fix（必須対応）

### MF-1: server.ts で環境変数を直接参照している

**カテゴリ**: 整合性
**場所**: `server.ts:43-44`

**問題**:
server.ts で環境変数を直接参照しており、`src/lib/env.ts` のフォールバック機能を使用していない。

**証拠**:
```typescript
const hostname = process.env.MCBD_BIND || '127.0.0.1';
const port = parseInt(process.env.MCBD_PORT || process.env.PORT || '3000', 10);
```

**推奨対応**:
`src/lib/env.ts` の `getEnvByKey()` を使用するよう修正が必要。CLI実装前にこの不整合を解消すべき。

**影響**:
CLI側で環境変数を設定しても server.ts で旧名称が参照される可能性がある。

---

### MF-2: .npmignore が存在しない

**カテゴリ**: 影響範囲
**場所**: プロジェクトルート

**問題**:
npm publish 時に不要なファイルが含まれる可能性がある。

**証拠**:
Glob検索で `.npmignore` がプロジェクトルートに存在しないことを確認。

**推奨対応**:
以下のファイル/ディレクトリを除外する `.npmignore` を作成:
- `tests/`
- `docs/`
- `dev-reports/`
- `.github/`
- `workspace/`
- `.claude/`
- `*.test.ts`
- `vitest.config.ts`
- `playwright.config.ts`

**影響**:
パッケージサイズの肥大化、テストファイルや内部ドキュメントの漏洩。

---

### MF-3: better-sqlite3 のネイティブモジュール対応

**カテゴリ**: 依存関係
**場所**: `package.json:24`

**問題**:
better-sqlite3 はネイティブバイナリを含むため、環境によってはビルドが必要。

**証拠**:
```json
"better-sqlite3": "^12.4.1"
```

**推奨対応**:
1. Issue記載のとおり、ビルドツール要件をドキュメントに追加
2. トラブルシューティングガイドを作成
3. postinstall スクリプトでの検証を検討

**影響**:
環境によっては `npm install` が失敗する可能性。特にビルドツール（python, make, C++コンパイラ）がない環境。

---

## Should Fix（推奨対応）

### SF-1: 既存シェルスクリプトとの整合性確認

**カテゴリ**: 影響範囲
**場所**: `scripts/*.sh`（11ファイル）

**問題**:
CLIコマンドと既存シェルスクリプトの機能が重複する。

**推奨対応**:
- 移行期間中の共存方針をドキュメント化
- README.md で推奨される使用方法を明記
- シェルスクリプトに「非推奨」コメントを追加

---

### SF-2: CLIコマンドのテスト方針が未定義

**カテゴリ**: テスト
**場所**: Issue本文

**問題**:
受け入れ条件にテストに関する記載がない。

**推奨対応**:
- 各CLIコマンドのユニットテスト方針を明確化
- 実際のファイルシステム操作を伴う統合テストの方針を定義
- テストカバレッジ目標を設定

---

### SF-3: npm publish ワークフローが未定義

**カテゴリ**: CI/CD
**場所**: `.github/workflows/`

**問題**:
npm publish の自動化ワークフローが存在しない。

**推奨対応**:
- GitHub Actions で npm publish を自動化
- タグプッシュ時に自動 publish するワークフローを追加
- `docs/release-guide.md` に npm publish 手順を追記

---

### SF-4: npm publish 時の認証情報管理

**カテゴリ**: セキュリティ
**場所**: Issue本文（npm registry 公開方針）

**問題**:
npm publish 時の認証トークン管理方針が未記載。

**推奨対応**:
- GitHub Secrets での `NPM_TOKEN` 管理方針を明記
- 2FA 要件を確認
- npm organization の使用検討（@commandmate/cli など）

---

## Nice to Have（あれば良い）

### NTH-1: npx commandmate サポートの詳細

**場所**: Issue本文（代替案セクション）

**推奨対応**:
npx でのインストールレス実行の動作確認手順を追加。

---

### NTH-2: Windows WSL2 対応の検証計画

**場所**: Issue本文（プラットフォーム要件）

**推奨対応**:
WSL2 での動作検証を別 Issue として計画。

---

### NTH-3: PM2 連携の詳細仕様

**場所**: Issue本文（--pm2 オプション）

**推奨対応**:
PM2 連携は初期リリースではスコープ外とし、別 Issue で対応することを明記。

---

## 参照ファイル

### コード

| ファイル | 関連性 |
|---------|--------|
| `/Users/maenokota/share/work/github_kewton/MyCodeBranchDesk/package.json` | private: true の削除、bin フィールド追加の対象 |
| `/Users/maenokota/share/work/github_kewton/MyCodeBranchDesk/server.ts` | 環境変数の直接参照（MCBD_BIND, MCBD_PORT）の修正対象 |
| `/Users/maenokota/share/work/github_kewton/MyCodeBranchDesk/src/lib/env.ts` | 環境変数フォールバック機能の参照元 |
| `/Users/maenokota/share/work/github_kewton/MyCodeBranchDesk/scripts/setup.sh` | CLI init コマンドの参考実装 |
| `/Users/maenokota/share/work/github_kewton/MyCodeBranchDesk/scripts/preflight-check.sh` | CLI preflight チェックの参考実装 |

### ドキュメント

| ファイル | 関連性 |
|---------|--------|
| `/Users/maenokota/share/work/github_kewton/MyCodeBranchDesk/README.md` | Quick Start セクションの更新対象 |
| `/Users/maenokota/share/work/github_kewton/MyCodeBranchDesk/docs/DEPLOYMENT.md` | デプロイ手順の更新対象 |
| `/Users/maenokota/share/work/github_kewton/MyCodeBranchDesk/docs/release-guide.md` | npm publish 手順の追加対象 |
| `/Users/maenokota/share/work/github_kewton/MyCodeBranchDesk/CHANGELOG.md` | 変更履歴の記録対象 |

---

## 結論

Issue #96 は大規模な変更を伴うが、影響範囲は明確に定義されている。主な懸念点は以下の3点:

1. **server.ts の環境変数参照の不整合**（MF-1）- CLI実装前に修正が必要
2. **.npmignore の欠如**（MF-2）- npm publish 前に作成必須
3. **better-sqlite3 のクロスプラットフォーム対応**（MF-3）- ドキュメント整備が必要

これらの問題を解決した上で実装を進めることを推奨する。

---

*レビュー完了: 2026-01-31*
