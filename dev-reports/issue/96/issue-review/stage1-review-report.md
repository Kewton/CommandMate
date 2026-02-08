# Issue #96 レビューレポート

**レビュー日**: 2026-01-31
**フォーカス**: 通常レビュー
**イテレーション**: 1回目
**ステージ**: Stage 1 - 通常レビュー（1回目）

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 5 |
| Should Fix | 4 |
| Nice to Have | 3 |

**総評**: Issue #96 は「npm install からセットアップ可能にする」という目標は明確ですが、npm パッケージ公開に必要な技術的要素（bin フィールド、private フラグ、ネイティブ依存関係対応）の検討が不足しています。また、既存のシェルスクリプト群との関係性、受け入れ条件の定義が必要です。

---

## Must Fix（必須対応）

### MF-1: package.json の 'private: true' 設定が npm publish をブロックする

**カテゴリ**: 整合性
**場所**: 提案する解決策セクション

**問題**:
現在の package.json には `"private": true` が設定されており、この状態では `npm publish` コマンドが失敗します。

**証拠**:
```json
// package.json line 4
"private": true,
```

**推奨対応**:
npm publish を可能にするために `private: true` を削除する必要があることを Issue に明記してください。または、npm publish 不要の場合（npx のみでの配布等）は代替手法を検討してください。

---

### MF-2: CLI エントリポイント（bin フィールド）の設計が未記載

**カテゴリ**: 完全性
**場所**: 提案する解決策セクション

**問題**:
`npm install -g commandmate` でグローバルにインストールした後、`commandmate` コマンドを実行可能にするには、package.json に `bin` フィールドを定義し、対応するエントリポイントスクリプトを作成する必要があります。

**証拠**:
現在の package.json に `bin` フィールドが存在しません。

**推奨対応**:
以下のような設計を Issue に追加してください:

```json
// package.json に追加が必要
{
  "bin": {
    "commandmate": "./bin/commandmate.js"
  }
}
```

また、CLI エントリポイントスクリプト（`bin/commandmate.js` または `bin/commandmate.ts`）の作成が必要であることを明記してください。

---

### MF-3: ネイティブ依存関係（better-sqlite3）のクロスプラットフォーム対応が未検討

**カテゴリ**: 技術的妥当性
**場所**: 提案する解決策セクション

**問題**:
プロジェクトは `better-sqlite3` を使用しており、これはネイティブバイナリを含むモジュールです。`npm install -g` 時にユーザー環境でビルドが必要になる可能性があり、以下の問題が発生し得ます:

- ビルドツール（python, make, gcc/clang等）がない環境での失敗
- Windows/macOS/Linux 間の互換性問題
- Node.js バージョン間の ABI 互換性問題

**証拠**:
```json
// package.json line 24
"better-sqlite3": "^12.4.1",
```

**推奨対応**:
以下のいずれかの対応方針を検討し、Issue に記載してください:

1. prebuild バイナリの配布（better-sqlite3 は prebuild をサポート）
2. 対応プラットフォームの明示と制限
3. インストール時のビルド要件のドキュメント化
4. 代替 DB ドライバーの検討（sql.js 等の pure JS 実装）

---

### MF-4: 受け入れ条件が未定義

**カテゴリ**: 完全性
**場所**: Issue 本文全体

**問題**:
Issue に受け入れ条件（Acceptance Criteria）が定義されていないため、完了判定が曖昧です。

**推奨対応**:
以下のような具体的な受け入れ条件を追加してください:

```markdown
## 受け入れ条件

- [ ] `npm install -g commandmate` でグローバルインストールが成功する
- [ ] `commandmate --version` でバージョン番号が表示される
- [ ] `commandmate init` で以下が実行される:
  - [ ] システム依存関係のチェック（Node.js, tmux, git, openssl）
  - [ ] .env ファイルの対話的生成
  - [ ] データベースの初期化
- [ ] `commandmate start` でサーバーが起動し、ブラウザからアクセス可能になる
- [ ] macOS / Linux で動作確認済み
```

---

### MF-5: commandmate init / start が既存スクリプトと同等の機能を持つのか不明

**カテゴリ**: 明確性
**場所**: 提案する解決策セクション

**問題**:
既に `scripts/setup.sh` と `scripts/start.sh` が存在し、セットアップと起動の機能を提供しています。新しい CLI コマンド（`commandmate init`, `commandmate start`）との関係が不明確です。

**証拠**:
- `scripts/setup.sh`（135行）: preflight-check -> npm install -> setup-env -> build-and-start を順次実行
- `scripts/start.sh`（44行）: PM2 または直接 npm start で起動

**推奨対応**:
以下のいずれかの方針を明記してください:

1. **既存スクリプトのラッパー**: CLI コマンドが内部で既存シェルスクリプトを呼び出す
2. **TypeScript で再実装**: シェルスクリプトの機能を TypeScript で再実装し、クロスプラットフォーム対応を強化
3. **両方サポート**: CLI コマンドと既存スクリプトの両方を維持

---

## Should Fix（推奨対応）

### SF-1: 各サブコマンドの詳細仕様が未定義

**カテゴリ**: 明確性
**場所**: 提案する解決策セクション

**問題**:
`commandmate init`, `commandmate start`, `commandmate --version` の具体的な動作仕様が記載されていません。

**推奨対応**:
各コマンドの詳細仕様を追加してください:

```markdown
### commandmate init
- システム依存関係のチェック（preflight-check 相当）
- .env ファイルの対話的生成（setup-env 相当）
- npm install の実行
- データベースの初期化（db:init 相当）
- Next.js のビルド（オプション）

### commandmate start
- 開発モード（--dev）/ 本番モード（デフォルト）の選択
- PM2 使用有無の自動判定または指定
- ポート指定オプション（--port）

### その他検討すべきコマンド
- commandmate stop: サーバー停止
- commandmate status: 稼働状態確認
- commandmate logs: ログ表示
```

---

### SF-2: npm registry への公開方針が未検討

**カテゴリ**: 技術的妥当性
**場所**: 背景・課題セクション

**問題**:
「利用までのハードルを下げる」という目的を達成するには、配布方法の決定が必要です。

**推奨対応**:
以下の選択肢を検討し、方針を記載してください:

| 選択肢 | メリット | デメリット |
|--------|----------|------------|
| npmjs.com への公開 | 最も簡単な配布方法 | パッケージ名の重複確認が必要 |
| GitHub Packages | プライベート配布可能 | 認証が必要 |
| npx commandmate | インストール不要 | 毎回ダウンロードが発生 |
| GitHub Releases | バージョン管理が容易 | 手動インストールが必要 |

---

### SF-3: システム依存関係のインストールガイダンスが未検討

**カテゴリ**: 完全性
**場所**: 提案する解決策セクション

**問題**:
preflight-check.sh が検出する必須依存関係のインストール方法をユーザーに案内する必要があります。

**証拠**:
`scripts/preflight-check.sh` が以下を必須としてチェック:
- Node.js v20+
- npm
- tmux
- git
- openssl

**推奨対応**:
`commandmate init` 実行時に不足している依存関係を検出した場合、インストール方法を案内するか、ドキュメントへのリンクを表示する機能を検討してください。

---

### SF-4: バージョニング戦略が未記載

**カテゴリ**: 明確性
**場所**: 提案する解決策セクション

**問題**:
npm 公開後はバージョン管理が重要になります。

**推奨対応**:
以下の点を検討し、記載してください:
- Semantic Versioning (semver) の遵守
- CHANGELOG.md との連携
- GitHub Releases との同期
- npm version コマンドの使用方針

---

## Nice to Have（あれば良い）

### NTH-1: 代替案セクションが空

**カテゴリ**: 完全性
**場所**: 代替案セクション

**推奨対応**:
検討した代替案を記載してください:
- `npx commandmate`（インストール不要での実行）
- Docker イメージでの配布
- Homebrew formula の作成
- GitHub Releases からのバイナリ配布

---

### NTH-2: 関連 Issue へのリンクがない

**カテゴリ**: 完全性
**場所**: Issue 本文

**推奨対応**:
以下の関連 Issue へのリンクを追加してください:
- Issue #76: 環境変数フォールバック（CM_* vs MCBD_* の整合性）
- Issue #77: 名称置換（CommandMate リネーム）

---

### NTH-3: ターゲットユーザーとユースケースの記載がない

**カテゴリ**: 完全性
**場所**: 背景・課題セクション

**推奨対応**:
想定されるターゲットユーザーとユースケースを記載してください:
- 誰が: 開発者、チームリーダー、オープンソースコントリビューター
- いつ: 新規プロジェクト開始時、チームメンバーのオンボーディング時
- どこで: ローカル開発環境、リモート開発サーバー

---

## 参照ファイル

### コード

| ファイル | 関連性 |
|----------|--------|
| `package.json` | npm publish の設定確認（private フラグ、bin フィールド） |
| `server.ts` | サーバー起動ロジック（CLI start コマンドの実装参考） |
| `scripts/setup.sh` | 既存セットアップフロー（CLI init コマンドの実装参考） |
| `scripts/start.sh` | 既存起動フロー（CLI start コマンドの実装参考） |
| `scripts/preflight-check.sh` | システム依存関係チェックロジック |
| `scripts/setup-env.sh` | 環境変数設定ロジック |

### ドキュメント

| ファイル | 関連性 |
|----------|--------|
| `docs/architecture.md` | アーキテクチャドキュメント（システム依存関係の確認） |
| `CLAUDE.md` | プロジェクトガイドライン（既存コマンド体系の確認） |

---

## 次のステップ

1. Must Fix の 5 項目を優先的に Issue 本文に追記
2. Should Fix の 4 項目を検討し、必要に応じて追記
3. Stage 2（通常レビュー 2回目）で更新内容を確認
