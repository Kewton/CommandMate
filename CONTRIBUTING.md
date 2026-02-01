# Contributing

CommandMate への貢献を歓迎します。

## 開発環境のセットアップ

> **Note**: コントリビューターは `git clone` を使用してください。`npm install -g commandmate` は一般ユーザー向けです。

```bash
git clone https://github.com/Kewton/CommandMate.git
cd CommandMate
npm install
cp .env.example .env   # CM_ROOT_DIR を設定
npm run db:init
npm run dev
```

### 前提条件

- Node.js v20+
- npm
- tmux
- git
- openssl
- Claude CLI（動作確認する場合）

## ブランチ戦略

| ブランチ種類 | パターン | 例 |
|-------------|----------|-----|
| 機能追加 | `feature/<issue番号>-<説明>` | `feature/123-add-dark-mode` |
| バグ修正 | `fix/<issue番号>-<説明>` | `fix/456-fix-login-error` |
| 緊急修正 | `hotfix/<説明>` | `hotfix/critical-security-fix` |
| ドキュメント | `docs/<説明>` | `docs/update-readme` |

## コミットメッセージ規約

```
<type>(<scope>): <subject>
```

| type | 説明 |
|------|------|
| `feat` | 新機能 |
| `fix` | バグ修正 |
| `docs` | ドキュメント |
| `style` | フォーマット（機能変更なし） |
| `refactor` | リファクタリング |
| `test` | テスト追加・修正 |
| `chore` | ビルド・設定変更 |

## PR手順

1. Issue を立てて背景・課題・提案内容を共有
2. フィーチャーブランチを作成
3. 変更を実装し、テストを通す
4. PR を作成（`main` ブランチ向け）
5. レビューを経てマージ

### PRの要件

- タイトル: `<type>: <description>` 形式（例: `feat: add dark mode toggle`）
- CI チェック（lint, type-check, test, build）が全パス
- 1名以上のレビュー承認

## 品質チェック

PR提出前に以下を確認してください。

```bash
npm run lint          # ESLint
npx tsc --noEmit      # TypeScript 型チェック
npm run test:unit     # ユニットテスト
npm run build         # ビルド確認
```

## コーディングルール

- TypeScript の strict モードを遵守
- `any` 型の使用は最小限に
- 関数コンポーネントを使用（React）
- Server Components を優先し、必要な場合のみ `'use client'` を使用
- `console.log` をコミットに含めない

## 質問・相談

不明点がある場合は Issue で質問してください。`question` ラベルを付けていただけると助かります。
