[English](../en/user-guide/cmate-schedules-guide.md)

# CMATEスケジュール機能ガイド

CMATE.mdファイルを使った定期実行スケジュールの設定・管理ガイドです。

---

## 概要

CMATEスケジュール機能は、worktreeルートに配置した`CMATE.md`ファイルのSchedulesセクションにcron式を定義することで、`claude -p`（または`codex exec`、`gemini -p`、`vibe-local -p`、`gh copilot -p`、`agy -p`、`opencode run`）を自動実行する機能です。

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
| **CLI Tool** | いいえ | 使用するCLIツール（`claude` / `codex` / `gemini` / `vibe-local` / `opencode` / `copilot` / `antigravity`。正本は `src/lib/cli-tools/types.ts` の `CLI_TOOL_IDS`）。**`--model <model-name>` を書けるのは copilot と opencode のみ**で、他のツールに書くと構文エラーとして行ごとスキップされる。opencode だけは `--agent` / `--variant` / `--continue` / `--title` も書ける（Issue #2044） | `claude` |
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

### gemini

パーミッション設定なし。Permission列は無視されます（値を書くとバリデーションエラーになります）。

### copilot（--allow-all-tools / --yolo）

| 値 | 説明 |
|----|------|
| `allow-all-tools` | 全てのツール使用を許可（**デフォルト**） |
| `yolo` | 全てのツール使用を許可し、ユーザー確認を一切バイパスする |

> **Warning:** `yolo`はユーザー確認を一切バイパスする最大権限モードです。スケジュール実行（無人バッチ）と組み合わせた場合、ファイルシステムへの無制限な書き込みや任意のコマンド実行が人的チェックなしに行われるリスクがあります。

#### copilotのモデル指定

CLI Tool列で `copilot --model <model-name>` と記述すると、スケジュール実行時に指定モデルを使用します。

```markdown
| copilot-task | 0 9 * * * | コードを分析してください | copilot --model claude-opus-4.6 | true | allow-all-tools |
```

モデル名は英数字・ハイフン・ドット・スラッシュ・コロンが使用可能で、先頭は英数字である必要があります（先頭 `-` は CLI オプションと紛れるため拒否）。**`--model` を書けるのは CLI Tool 列では copilot と opencode の 2 つだけ**で、他のツールに書いた場合は「無視される」のではなく**構文エラーになり、その行がスケジュールごとスキップされます**（`parseCliToolColumn` の `TOOLS_WITH_MODEL_SUPPORT`）。vibe-local のモデルは worktree の Agent 設定（DB）で決まります。antigravity の `--model` は表示名に空白を含むため CLI Tool 列では扱えず、`commandmate send --model` 側の担当です。

### antigravity（--dangerously-skip-permissions）

| 値 | 説明 |
|----|------|
| `--dangerously-skip-permissions` | ツール使用を自動承認（**デフォルト**。他の値は指定できません） |

> **Warning:** 無人バッチであるスケジュール実行では、これが唯一の許可値である点に注意してください。

### opencode

パーミッション設定なし。**Permission 列に値を書くとバリデーションエラーになります**（Issue #1914）。
それ以前は Claude の `--permission-mode` の値（`acceptEdits` など）がそのまま通ってしまい、
opencode に存在しないオプションとして扱われていました。

> **Note:** opencode に「許可レベル」の語彙が無いという意味で、フラグが 1 つも無いわけではありません。
> `opencode run` には真偽値の `--auto`（"auto-approve permissions that are not explicitly denied"、
> opencode 1.18.21 の `--help` で実測）がありますが、これは claude の `--permission-mode` や
> codex の `--sandbox` のような**段階**ではなく、CommandMate は現在これを渡していません。

#### opencodeのモデル指定

CLI Tool 列で `opencode --model <provider/model>` と記述すると、スケジュール実行時に
`opencode run -m <provider/model> <message>` で起動します。

```markdown
| oc-task | 0 9 * * * | コードを分析してください | opencode --model ollama/qwen3:8b | true | |
```

値は **`provider/model` 形式**です（`opencode run --help` の `-m, --model` が
"model to use in the format of provider/model" と明記。opencode 1.18.21 で実測）。
CommandMate は値を**そのまま渡します** — Issue #1914 以前のコードは `ollama/` を前置していましたが、
その分岐は到達不能で（当時の `resolveModelOption()`、現在の `resolveScheduleExecuteOptions()` が
opencode に対して常に `undefined` を返していた）、
Ollama 以外のプロバイダを指定する手段が無く、`ollama/anthropic/…` のように二重化する形でした。
モデル名の書式が誤っている場合、opencode 側は不透明なエラーで終了します
（実測: 存在しない provider と裸のモデル名は同じ `UnknownError` になり区別できないため、
CommandMate は書式を推測して拒否することはしません）。実行結果は Execution Log で確認してください。

#### opencode の run オプション（Issue #2044）

CLI Tool 列は opencode に限り**フラグの並び**を受け付けます（他のツールは従来どおり
`<tool> --model <name>` の 3 トークンのみ）。

| フラグ | opencode 側 | 例 |
|--------|-------------|-----|
| `--model` / `-m` | `-m <provider/model>` | `--model github-copilot/claude-sonnet-4.6` |
| `--agent` | `--agent <name>` | `--agent plan` |
| `--variant` | `--variant <name>`（provider ごとの reasoning effort） | `--variant high` |
| `--continue` / `-c` | `-c`（直近セッションを継続） | `--continue` |
| `--title` | `--title <text>`（セッション名） | `--title "夜間レビュー"` |

```markdown
| nightly | 0 3 * * * | 今日の差分をレビューして | opencode --agent plan --variant high | true | |
```

- 順序は自由ですが、**同じフラグを 2 回書くとその行はスキップされます**（どちらの値か決められないため）。
- 値を伴うフラグの直後に別のフラグが来る書き方（`--agent --title x`）もエラーです。
- 空白を含む `--title` は `"…"` または `'…'` で囲みます。`|` は表を壊すため使えません。
- `--agent` / `--variant` は英数字と `.` `_` `-` のみ（先頭は英数字）。`/` や `:` は使えません。
- opencode 1.18.22 で `--agent plan --variant high --title …` がセッションに反映されることを
  実測済みです（`docs/design/opencode-server-live-verification.md` §15.4）。

> **スケジュール実行まで配線済みです（Issue #2044）**。`executeSchedule()` は
> `resolveScheduleExecuteOptions()` 経由で CLI Tool 列の内容を解決するので、ここに書いた
> フラグはそのまま `opencode run` の引数になります。vibe-local のモデル（worktree の Agent 設定＝DB）は
> 従来どおり別経路で解決され、他のツールの起動引数も変わりません。
> 経路の固定は `tests/integration/schedule-opencode-run-options-2044.test.ts`、
> 設計上の理由は `docs/design/opencode-server-live-verification.md` §15.7 を参照してください。

> **Note:** `commandmate report generate --tool` に opencode が入りました（Issue #2044）。
> `SUMMARY_ALLOWED_TOOLS` は claude / codex / copilot / antigravity / opencode で、既定は `claude` のままです。

### vibe-local

パーミッション設定なし。Permission列は無視されます。`-y`フラグで自動承認されます。

> **Note:** vibe-localのモデルは、worktreeのAgent設定で選択したOllamaモデルが使用されます。

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
| CLI Tool | `claude`、`codex`、`gemini`、`vibe-local`、`opencode`、`copilot`、`antigravity` のいずれか。opencode のみ `--model` / `--agent` / `--variant` / `--continue` / `--title` を後置できる |
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
