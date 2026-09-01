# antigravity 転写 JSONL — 実機 fixture（Issue #2198）

**agy 1.1.18** を実機で動かして採取した転写ファイルと hook payload。
採取手順・go/no-go 判定の全実測は
[`docs/design/antigravity-transcript-reader.md`](../../../../docs/design/antigravity-transcript-reader.md) を参照。

## 採取環境

| 項目 | 値 |
|---|---|
| agy | **1.1.18** |
| model | `gemini-3.7-flash-high`（payload の `modelName` 実測値） |
| 採取日 | 2026-09-01 |
| 起動 | `agy -p`（print モード＝非対話。picker も TUI も開かない） |
| ワークスペース | スクラッチ配下の空ディレクトリ |
| hook | `CM_HOOK_URL` / `CM_PERMISSION_HOOK_URL` を 127.0.0.1 の使い捨て sink へ向けて全 payload を採取。稼働中の CommandMate サーバには 1 件も送っていない |
| 隔離 | **HOME 隔離は不可能だった。** agy の資格情報は HOME 配下のファイルではなく（keyring）、HOME を差し替えると再ログインを要求されて実測が成立しない。代わりに「非対話・スクラッチ workspace・hook 送信先の差し替え」で同じ危険を潰し、`~/.gemini/{config/hooks.json, trusted_hooks.json, trustedFolders.json, settings.json, antigravity-cli/settings.json}` の sha256 を前後比較した |

## ファイル

| ファイル | 中身 |
|---|---|
| `transcript-three-turns-1118.jsonl` | **1 会話 3 ターンの無加工転写**（パス匿名化のみ）。①テキストのみ ②`tool_calls` を 4 回挟むターン ③Markdown（`**bold**` ＋箇条書き）と `thinking`。`conversationId` = `1ce50bef-fc2a-4039-8114-5aae518678e6` |
| `transcript-record-types-1118.jsonl` | **語彙 fixture。** コーパス 41 本 1,024 レコードに実在した `(source, type, フィールドの有無)` の組み合わせを 1 件ずつ実物から抜き、`content` / `thinking` / `error` を `<elided for fixture>` に置換して 1 会話に並べたもの。**これだけは組み立て物**であり、無加工なのは上の 1 本 |
| `hook-events-1118.json` | 上記セッションが実際に送った hook payload 10 件。`conversationId` と `transcriptPath` の対応がこれで検証できる |

## この fixture が固定している事実

1. **hook の `conversationId` は転写ディレクトリ名そのもの。**
   `transcriptPath` = `<agyHome>/brain/<conversationId>/.system_generated/logs/transcript_full.jsonl`。
   → 転写のパスは**計算できる**（codex のようなファイル走査も、claude のような cwd スラッグも要らない）。
2. **`--continue` は `conversationId` を変えない。** 3 ターンすべて同一値。
3. **hook の `cwd` はエージェントの作業ディレクトリではない。** 10/10 件で `~/.gemini/config`
   （agy 自身の設定ディレクトリ）。`workspacePaths` も空配列。→ **cwd から転写を推測してはいけない。**
4. **turn 境界は `USER_EXPLICIT` / `USER_INPUT`。** turn を閉じるレコードは存在しない（codex の
   `task_complete` に相当するものが無い）。
5. **agent の発話は `MODEL` / `PLANNER_RESPONSE` にしか無い。** 他の `MODEL` type は
   ツールの出力で、`content` は必ず `Created At: …` で始まる。
6. **`tool_calls` が付くのは `PLANNER_RESPONSE` だけ**で、`args.toolAction` / `args.toolSummary` が必ず入っている。
7. **`step_index` は会話内で一意だが、連番でも昇順でもない。** 41 本で重複ゼロ／10 本に欠番／1 本が非単調（8 → 7）。

## 置換したもの（それ以外は無加工）

| 元 | 置換後 | 理由 |
|---|---|---|
| `/Users/<user>/.gemini/antigravity-cli` | `/tmp/cmate-2198/agyhome` | ローカルパスの秘匿 |
| `/Users/<user>/.gemini` | `/tmp/cmate-2198/gemini` | 同上 |
| `/Users/<user>` | `/tmp/cmate-2198/home` | 同上 |
| ホスト名・ユーザ名 | `probe-host` / `operator` | 同上 |
| `transcript-record-types-1118.jsonl` の `content` / `thinking` / `error` | 先頭 1 行＋`<elided for fixture>` | 過去の実作業の本文が入るため |
