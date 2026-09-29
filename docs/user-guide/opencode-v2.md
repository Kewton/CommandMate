[English](../en/user-guide/opencode-v2.md)

# OpenCode V2（opencode-v2）

OpenCode V2 は OpenCode 2.0（実行ファイル `opencode2`、npm パッケージ `@opencode/cli`）です。CommandMate では
OpenCode 1.x（`opencode`）とは別のエージェント **OpenCode V2**（ツール ID `opencode-v2`）として、worktree ごとに選べます。
公開面（README・LP）では 1.x と V2 をまとめて「OpenCode（1.x と V2）」の 1 種と数えます。

このページに書いてあるのは、`opencode2` **2.0.18** を相手に 2026-09-28〜29 の実機受入テスト（UAT）と各 Issue の実機確認で
確かめた範囲です（Epic #2370）。

---

## 1. 導入と OpenCode 1.x との共存

```bash
npm install -g @opencode/cli               # OpenCode V2 (opencode2)
```

- このパッケージは `opencode2` と **`opencode`** の 2 つを登録します。1.x の `opencode` と名前が重なるため、CommandMate は
  名前ではなく `--version` の出力で 1.x と V2 を見分けます（Issue #2939）。
- 1.x と V2 は `~/.local/share/opencode/opencode.db` を共有します。V2 を動かした後に 1.x が `no such column: …` で
  起動できなくなることがあり、そのときは原因を起動エラーとして表示します。
- CommandMate が起動した V2 では、V2 自身の更新確認を止めています。これで起動のたびにプロジェクトの `package.json` に
  `"packageManager"` が書き込まれることはなくなりました（Issue #2957。UAT では 5 つの worktree すべてで `package.json` が不変）。
  V2 の更新は `npm install -g @opencode/cli` で行います。

詳しくは [CLI セットアップガイドの「OpenCode（1.x）と OpenCode V2 の共存」](./cli-setup-guide.md#opencode1xと-opencode-v2-の共存)
を参照してください。

---

## 2. 起動のしくみ

- CommandMate はインスタンスごとに専用の `opencode2 serve`（ポート 4300–4399、パスワードは
  `~/.commandmate/opencode-v2/` に 0600 で保存）を立て、TUI をそのサーバーにつなぎます。ほかのツールと違い hook の設定ファイルは
  書かず、そのサーバーの SSE（`GET /api/event`）を購読して状態を受け取ります（Issue #2934）。
- 実行ファイルは解決した絶対パスで渡します。V2 が `opencode` の名前でしか入っていなくても、同じ形（専用サーバー + TUI）で
  起動します（Issue #2952）。
- ポート・パスワードファイル・起動スクリプトのどれかが用意できないときだけ `opencode2 --standalone` で起動します。
  この形では CommandMate に構造化イベントが届かず、状態表示・承認の回答は使えません。
- セッションを止めると、TUI と専用サーバーの両方が止まり、ポートも閉じます。

---

## 3. できること

| 機能 | 内容 | Issue |
|---|---|---|
| 送信 | 画面と `commandmate send` から送れます。引数なしの `/<name>`（project コマンド・Skill）もそのまま V2 で実行されます | #2934 #2950 |
| 状態 | SSE から実行中・完了・入力待ちを表示します（サイドバーに `OpenCode V2: waiting` など） | #2934 |
| 転写（History） | ターンが終わると V2 のサーバーから返答を読み、1 ターン 1 行でチャットに記録します | #2940 |
| 承認と質問 | 承認（差分つき）と質問に、PC のパネル・スマホ・`commandmate respond`・Auto-Yes から答えられます（下記） | #2945 #2951 |
| ダイアログ中の送信の拒否 | モデル選択・Commands パレットなどが開いているときは、本文をダイアログに入力せずに失敗で返します（下記） | #2971 |
| モデル表示 | 実際に返答したモデルを `capture --json` の `.model`・画面のペイン見出しに出します。TUI でモデルを替えると、次の返答の後に切り替わり、変更の通知が出ます | #2964 |
| 使用量 | トークン（入力・出力）・コスト・コンテキストの使用率を画面と API に出します。V2 自身の画面下部の表示と一致します。新しいセッションに替えると入れ替わり、インスタンスを止めると消えます | #2981 |
| クイックキー | V2 の実測のキー表で 11 キー（Next agent `shift+tab` / Commands / Variant / Agents / Sessions / New session / Models / Page up / Page down / First / Latest）を出します | #2966 |
| ダイアログカードのキー | モデル選択が開いているとき、チャットのカードに Variant `ctrl+t` / Models `ctrl+x m` / Commands `ctrl+p` が出て、押すと切り替わります | #2983 |
| スラッシュコマンド候補 | 組み込みコマンド・Skill・稼働中のサーバーの project コマンドを候補に出します。組み込み一覧の鮮度確認（`catalogStaleness`）にも V2 が載ります | #2944 #2950 |
| Skill | `.agents/skills` と `.claude/skills` を読みます。稼働中に入れた Skill は**開始し直し不要**で、次の送信から見つかります | #2975 #2985 |
| スケジュール | CMATE.md の CLI Tool 列に `opencode-v2` を書くと、スケジュールの worktree で `opencode2 run` が動きます | #2974 #2979 #2982 |
| 日次確認 | agent-health の日次確認に V2 の起動と SSE の確認が入っています（[agent-health](./agent-health.md)） | #2937 |

### 承認と質問の答え方

- 承認の選択肢は V2 の画面と同じ **Allow once / Always allow / Reject** です。`commandmate respond` は番号（`1`〜`3`）でも
  文字（`"Always allow"`）でも答えられ、1.x の `Allow always` も受け付けます。承認のカードには、対象と差分が出ます。
- 質問は選択肢の番号で答えます。自由記述を受け付ける質問には文字で答えられます（例: `respond "Purple"`）。
- Auto-Yes は V2 の承認に自動で答えます。承認が保留になっている間に Auto-Yes を有効にすると、その保留中の承認にも答えます
  （出力は `Re-judged 1 pending approval(s): 1 answered.`）。
- Auto-Yes は、返答の**本文**に番号つきの選択肢（`❯ 1. Yes` など）があっても答えません（Issue #2984）。

### ダイアログが開いているとき

- 承認・質問以外のダイアログ（Select model / Select variant / Commands など）が開いているとき、`commandmate send` は本文を入力せず
  exit 99 で `the "Select variant" dialog is open. Close it (esc) or finish the choice, then send again` のように返します。
- その間、状態は「入力待ち」のままで、`commandmate wait` は完了を返しません（既定では exit 10）。`esc` で閉じてから送り直すと届きます。

### スケジュールの注意

設定と実測は [cmate-schedules-guide の opencode-v2 の節](./cmate-schedules-guide.md#opencode-v2--auto) を参照してください。
画面で「常に許可」と答えた操作は、同じリポジトリのすべての worktree のスケジュールでも許可済みになります（同じ節）。

---

## 4. OpenCode 1.x との違い

| 観点 | OpenCode 1.x（`opencode`） | OpenCode V2（`opencode-v2`） |
|---|---|---|
| 実行ファイル | `--version` が `1.x` を返す `opencode` | `opencode2`。無ければ `--version` が `opencode v2.x` を返す `opencode` |
| エージェントの切り替え | `tab` / `shift+tab` | **`shift+tab` だけ**（Build ⇄ Plan）。`tab` では切り替わりません |
| 承認の文言 | Allow once / Allow always / Reject | Allow once / **Always allow** / Reject |
| Skill の反映 | セッションの開始し直しが必要 | 開始し直し不要（次の送信から見つかる） |
| Skill の呼び出し | サーバーが Skill をコマンドとして展開する | モデルが `skill` ツールを呼んで実行します。V2 自身の `/` 補完には出ないので、`@` 補完か CommandMate のスラッシュコマンド候補から `/<name>` を送ります |
| スケジュールの実行 | `opencode run` | `opencode2 run --standalone --format json`。`--variant` は `--model` と一緒のときだけ |

両方を入れて並べて使えます。導入と共存の詳細は [CLI セットアップガイド](./cli-setup-guide.md#opencode1xと-opencode-v2-の共存) にあります。

---

## 5. まだできないこと・既知の不具合

- **起動直後の最初の送信**: 新しく起動したインスタンスへの最初の `commandmate send` が `OpenCode V2 composer not ready`
  （exit 99、未送信）になることがあります。送り直すと届きます（2026-09-29 の UAT で観察）。
- **答えられない質問**: 数値・自由記述だけ・外部入力の欄を含む質問や、複数の欄がある質問は、CommandMate からは答えられません。
  V2 の TUI で答えてください。
- **「常に許可」の範囲**: OpenCode は同じリポジトリの worktree を 1 つの project として扱い、「常に許可」をそこに保存します。
  ある worktree で常に許可した操作は、同じリポジトリのほかの worktree でも確認なしに通ります。
- **Skill 詳細画面**: Skill 詳細の互換表に V2 の行が出るのは、Catalog の manifest が V2 を申告してからです（commandmate-skills#275）。
- **`--standalone` での起動**: 上の §2 のとおり、状態表示と承認の回答は使えません。

---

## 6. 関連

- [CLI セットアップガイド](./cli-setup-guide.md) — 導入と 1.x との共存
- [CMATE.md スケジュール](./cmate-schedules-guide.md) — `opencode-v2` の実行オプションと Permission
- [Agent Skills](./skills.md) — Skill の導入とエージェントごとの対応
- [Skill とエージェントの互換表](../reference/skill-agent-compatibility.md) — V2 の Skill の実測（§10）
- [エージェントイベント hook](./agent-event-hooks.md) — V2 は hook を書かず SSE を購読する
