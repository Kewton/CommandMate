[English](../en/user-guide/cmate-schedules-guide.md)

# CMATEスケジュール機能ガイド

CMATE.mdファイルを使った定期実行スケジュールの設定・管理ガイドです。

---

## 概要

CMATEスケジュール機能は、worktreeルートに配置した`CMATE.md`ファイルのSchedulesセクションにcron式を定義することで、`claude -p`（または`codex exec`）を自動実行する機能です。

**動作フロー:**

```
CMATE.md に Schedules テーブルを記述
  ↓
CommandMate が60秒間隔で CMATE.md を読み込み
  ↓
cron式に一致したタイミングで claude -p を自動実行
  ↓
実行結果を Execution Logs に記録
```

---

## CMATE.mdの作成方法

### ファイルの配置場所

`CMATE.md`はworktreeのルートディレクトリに配置します。

```
your-project/          ← worktreeルート
├── CMATE.md           ← ここに配置
├── src/
├── package.json
└── ...
```

### UIからの作成

1. サイドバーでworktreeを選択
2. **CMATE** タブをクリック
3. **CMATEボタン** をクリックすると、テンプレート付きの`CMATE.md`が作成されます

---

## Schedulesテーブルの書き方

`CMATE.md`内に`## Schedules`セクションを作成し、Markdownテーブル形式で定義します。

### テーブル構造

```markdown
## Schedules

| Name | Cron | Message | CLI Tool | Enabled | Permission |
|------|------|---------|----------|---------|------------|
| daily-review | 0 9 * * * | コードの変更点をレビューしてください | claude | true | acceptEdits |
```

### カラム説明

| カラム | 必須 | 説明 | デフォルト値 |
|--------|------|------|-------------|
| **Name** | はい | スケジュール名。1〜100文字。英数字・日本語・ハイフン・スペースが使用可能 | - |
| **Cron** | はい | cron式（5〜6フィールド）。実行タイミングを指定 | - |
| **Message** | はい | `claude -p`に送信するプロンプト。最大10,000文字 | - |
| **CLI Tool** | いいえ | 使用するCLIツール（`claude` / `codex`） | `claude` |
| **Enabled** | いいえ | スケジュールの有効/無効（`true` / `false`） | `true` |
| **Permission** | いいえ | 実行時の許可レベル。下記のPermission一覧を参照 | ツール別のデフォルト値 |

### Cron式クイックリファレンス

| パターン | 説明 |
|---------|------|
| `0 * * * *` | 毎時0分 |
| `0 9 * * *` | 毎日9:00 |
| `0 9 * * 1-5` | 平日9:00 |
| `0 18 * * 5` | 毎週金曜18:00 |
| `0 2 * * *` | 毎日2:00 |
| `0 0 1 * *` | 毎月1日0:00 |
| `*/30 * * * *` | 30分ごと |

cron式は5フィールド（分 時 日 月 曜日）または6フィールド（秒 分 時 日 月 曜日）に対応しています。

---

## Permission一覧

### claude（--permission-mode）

| 値 | 説明 |
|----|------|
| `default` | デフォルトの権限。ファイル変更時に確認を求める |
| `acceptEdits` | ファイル編集を自動で許可（**デフォルト**） |
| `plan` | 計画モード。コード変更を行わない |
| `dontAsk` | 全ての許可を自動で承認 |
| `bypassPermissions` | 全ての権限チェックをスキップ |

### codex（--sandbox）

| 値 | 説明 |
|----|------|
| `read-only` | 読み取りのみ。ファイル変更不可 |
| `workspace-write` | ワークスペース内のファイル変更を許可（**デフォルト**） |
| `danger-full-access` | 全てのファイルへのフルアクセス |

---

## 実用例

### 日次コードレビュー

```markdown
| daily-review | 0 9 * * 1-5 | 昨日のコミットをレビューして、改善点があれば報告してください | claude | true | acceptEdits |
```

平日の朝9時にコード変更のレビューを自動実行します。

### 定期テスト実行

```markdown
| nightly-test | 0 2 * * * | npm run test:unit を実行して結果をまとめてください | claude | true | plan |
```

毎日深夜2時にテストを実行し、結果をレポートします。`plan`モードでコード変更は行いません。

### ステータスチェック

```markdown
| hourly-status | 0 * * * * | git status を確認して問題があれば報告してください | claude | true | default |
```

毎時0分にリポジトリのステータスを確認します。

---

## UIでの確認方法

### スケジュール一覧

1. サイドバーでworktreeを選択
2. **CMATE** タブをクリック
3. **Schedules** セクションに定義済みスケジュールが一覧表示されます

### 実行ログの確認

1. **CMATE** タブの **Execution Logs** セクションを確認
2. 各ログエントリをクリックして展開すると、以下の詳細が表示されます：
   - **Message**: 送信したプロンプト
   - **Response**: CLIツールからの応答

---

## バリデーション

CMATE.mdの内容はCommandMateが自動的にバリデーションします。

### バリデーションのタイミング

- CMATEボタンの再クリック時
- CommandMateの60秒間隔のポーリング時

### バリデーション項目

| 項目 | ルール |
|------|--------|
| Name | 1〜100文字、英数字・日本語・ハイフン・スペースのみ |
| Cron | 5〜6フィールドの有効なcron式 |
| Message | 空でないこと。最大10,000文字 |
| CLI Tool | `claude` または `codex` |
| Permission | ツールごとの許可値一覧に一致すること |

無効なエントリは警告ログとともにスキップされます。他の有効なエントリは正常に処理されます。

---

## トラブルシューティング

### スケジュールが実行されない

- **Enabledを確認**: `false`に設定されていないか確認してください
- **Cron式を確認**: 正しいフォーマット（5〜6フィールド）で記述されているか確認してください
- **CMATE.mdの配置場所**: worktreeのルートディレクトリに配置されているか確認してください
- **CommandMateの起動状態**: サーバーが起動中であることを確認してください

### Permissionの確認メッセージが表示される

- Permission列を明示的に設定してください
- claudeの場合、`acceptEdits`以上の権限が必要な操作を行うプロンプトには適切なPermissionを設定してください

### Name変更時の挙動

- スケジュール名を変更すると、新しいスケジュールとして認識されます
- 古い名前のスケジュールは自動的に停止されます

### 同時実行について

- 同一スケジュールの同時実行は防止されています（前回の実行が完了するまで次の実行はスキップされます）
- 全worktree合計で最大100スケジュールまで登録可能です

---

## CLIからの参照

```bash
commandmate docs --section cmate-schedules
```

このコマンドで、このガイドの内容をターミナルから参照できます。

---

## 関連ドキュメント

- [クイックスタートガイド](./quick-start.md) - 5分で始める開発フロー
- [コマンド利用ガイド](./commands-guide.md) - コマンドの詳細
- [Webアプリガイド](./webapp-guide.md) - WebアプリのUI操作
- [ワークフロー例](./workflow-examples.md) - 実践的な使用例
