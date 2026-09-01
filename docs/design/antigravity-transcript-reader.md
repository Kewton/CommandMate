# antigravity 転写リーダー — go/no-go 実測と設計（Issue #2198）

親 Epic: #2192 ／ Phase 2 の 2-c ／ 依存: #2196（共通ヘルパ）、#2197（gate の capability 化）

**判定: go。** 4 つの条件をすべて満たした。以下は実測記録であり、想定や公式ドキュメントの引き写しではない。

---

## 0. 採取環境

| 項目 | 値 |
|---|---|
| agy | **1.1.18**（`/Users/<user>/.local/bin/agy`、Mach-O arm64） |
| model | `gemini-3.7-flash-high`（payload の `modelName` 実測値） |
| 採取日 | 2026-09-01 |
| 起動 | `agy -p`（print モード＝非対話。picker も TUI も開かない） |
| ワークスペース | スクラッチ配下の空ディレクトリ。ユーザーのリポジトリには一切触れていない |
| hook 受け口 | **127.0.0.1:39871 に立てた使い捨ての sink**。`CM_HOOK_URL` / `CM_PERMISSION_HOOK_URL` をそこへ向けたので、稼働中の CommandMate サーバには 1 件も届いていない |
| ターン数 | 3（`--continue` で同一 conversation を継続） |

### 隔離について — HOME 隔離は「できなかった」

Issue の指示は「実測でセッションを作る操作は隔離 HOME で行う」だった。**これは達成できていない。**
理由は実測済みで、推測ではない:

- 隔離 HOME に `~/.gemini` の**全トップレベルファイル**（`oauth_creds.json` / `jetski-standalone-oauth-token` /
  `google_accounts.json` / `installation_id` / `settings.json` / `projects.json` / `state.json`）と
  `~/.gemini/config/` を複製して `agy -p` を実行したところ、`Error: authentication required. Run 'agy' to log in, then retry.`
  で終了した。agy の資格情報は **HOME 配下のファイルではない**（バイナリに `Keyring SaveUserTier ... falling back to
  file storage` の文字列があり、keyring 経由と読める）。
- したがって HOME を差し替えると agy は再ログインを要求し、実測そのものが成立しない。
  `CODEX_HOME` に相当する状態ディレクトリの上書き環境変数も、バイナリの文字列走査
  （`AGY_*` / `ANTIGRAVITY_*` / `*_DIR|HOME|PATH|ROOT`）に存在しなかった。

代わりに、隔離要求が守ろうとしていた**中身**を個別に満たした:

| 危険 | 実際にやったこと | 検証 |
|---|---|---|
| 破壊的な picker / probe | `-p`（非対話）のみ。TUI も picker も開いていない | — |
| `~/.gemini/config/hooks.json` はグローバル 1 本 | **一度も書いていない**。実行前に sha256 を採取 | 後述 |
| 稼働中の CommandMate を汚す | hook 送信先を使い捨て sink に差し替え | サーバ側に 0 件 |
| ユーザーの IDE セッションを壊す | CLI は `~/.gemini/antigravity-cli/`、IDE は `~/.gemini/antigravity/` と**別ディレクトリ**。CLI 側にしか書いていない | `find -newer` |

`~/.gemini/{config/hooks.json, trusted_hooks.json, trustedFolders.json, settings.json, antigravity-cli/settings.json}`
の sha256 を実行前後で比較した。**4 本は完全に不変。**

`config/hooks.json` だけは実行後に変化したが、**この実測が原因ではない**。差分は
`commandmate-issue-2197/scripts/hooks/…` → `commandmate-issue-2199/scripts/hooks/…` というハンドラのパス書き換えのみで、
並行して動いている別 worktree の CommandMate が `writeAntigravityHooksConfig()` で書いたもの。
本実測はハンドラのパスを一切生成していない。
**これは「グローバル 1 本の hooks.json は並列 worktree どうしで上書きし合う」ことの実地観測でもある**（本 Issue の対象外）。

副作用として `~/.gemini/antigravity-cli/` に conversation が 1 本増えた
（`1ce50bef-fc2a-4039-8114-5aae518678e6`）。追記のみで、既存の会話は書き換えていない。
削除すると `cache/last_conversations.json` の参照が壊れるため、そのまま残している。

---

## 1. 会話本文がどこに永続化されるか

`find ~/.gemini -newer <marker>` で 3 ターン分の差分を取った結果、本文を持つのは 2 か所:

| パス | 形式 | 中身 |
|---|---|---|
| `~/.gemini/antigravity-cli/conversations/<conversationId>.db` | **SQLite ＋ protobuf blob** | `steps` テーブル。`step_payload` が protobuf バイナリ（`step_type` 14=user / 15=assistant / 23=メタ） |
| `~/.gemini/antigravity-cli/brain/<conversationId>/.system_generated/logs/transcript_full.jsonl` | **平文 JSONL** | 1 行 1 ステップ。`content` は Markdown そのまま |

**JSONL を読む。** 理由は 3 つとも実測:

1. **agy 自身がそのパスを hook payload で渡してくる。** `PreToolUse` payload の `transcriptPath` が
   `…/brain/<conversationId>/.system_generated/logs/transcript_full.jsonl` そのもの（4/4 件）。
   どちらが「正」かを CommandMate が決める必要がない。
2. **SQLite 側は protobuf。** スキーマは `steps(idx, step_type, status, …, step_payload blob)` で、本文は
   protobuf の入れ子フィールド（assistant は 20.1 / 20.8、user は 19.2 / 19.3.1）。`.proto` は公開されておらず、
   フィールド番号は agy のリリースごとに動きうる。**安定した構造化形式とは言えない。**
3. **SQLite を開くと副作用が出る。** 検証のため `.db` をスクラッチへコピーして `sqlite3` で開いたところ、
   コピー先に `-shm` / `-wal` が生成された。ポーラの保存経路で本番の会話 DB を開く選択肢は取らない。

同じディレクトリに `transcript.jsonl` もあるが、これは**要約・切り詰め済みの view**である:

- `truncated_fields` を持つレコードは `transcript.jsonl` に 106/1156 件、
  **`transcript_full.jsonl` には 0/1024 件**。`_full` の名前どおり無切り詰め。
- 逆に、`transcript_full.jsonl` が 1 行しか残っていない会話が 41 本中 1 本あった
  （`e2d15ade…`、`transcript.jsonl` 側は 133 行）。**`_full` は必ずしも全履歴を保持しない。**
  → リーダーは「窓の中に USER_INPUT が無ければ false を返してスクレイパに委ねる」を正とする（§5）。

### コーパス

判定は 1 セッションではなく、このマシンにある **41 本の `transcript_full.jsonl` / 1,024 レコード**
（CLI 側 34 本＋IDE 側 6 本＋今回採取の 1 本）を全数走査して確かめた。

---

## 2. 判定基準 4 項目の実測結果

### ① user 本文と assistant 本文が平文または安定した構造化形式で読めるか → **満たす**

`transcript_full.jsonl` は 1 行 1 JSON オブジェクト。**1,024 行中 0 行が malformed。**

```json
{"step_index":0,"source":"USER_EXPLICIT","type":"USER_INPUT","status":"DONE",
 "created_at":"2026-09-01T02:12:41Z","content":"<USER_REQUEST>\n…\n</USER_REQUEST>\n<ADDITIONAL_METADATA>…"}
{"step_index":14,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE",
 "created_at":"2026-09-01T02:14:40Z","content":"**THIRD TURN OK**\n\n- Item 1\n- Item 2","thinking":"…"}
```

assistant の `content` は **TUI が描く前の Markdown 原文**（`**bold**` も箇条書きもそのまま）。
user の `content` は `<USER_REQUEST>…</USER_REQUEST>` に包まれ、**63/63 件が例外なくこの形**。
`<ADDITIONAL_METADATA>` が 63/63、`<USER_SETTINGS_CHANGE>` が 40/63 で後続する。

**語彙は全数固定した**（`source` × `type`、1,024 レコード）:

| source | type | 件数 | 意味 |
|---|---|---:|---|
| MODEL | PLANNER_RESPONSE | 495 | **agent の発話。本文はここにしか無い** |
| MODEL | LIST_DIRECTORY / VIEW_FILE / RUN_COMMAND / SEARCH_WEB / GREP_SEARCH / CODE_ACTION / GENERATE_IMAGE / GENERIC | 372 | ツールの**出力**。`content` は必ず `Created At: …` で始まる |
| USER_EXPLICIT | USER_INPUT | 63 | operator の入力 |
| SYSTEM | CHECKPOINT / CONVERSATION_HISTORY / SYSTEM_MESSAGE / EPHEMERAL_MESSAGE / ERROR_MESSAGE | 86 | 注入された文脈。agent の言葉ではない |

`tool_calls`（`{name, args}`）が付くのは **PLANNER_RESPONSE だけ**（439 件、他の type には 1 件も無い）。
`args` には **439/439 件で `toolAction` / `toolSummary`** という人間可読の要約が入っている。
`status` は `DONE` 1,020 / `RUNNING` 4（バックグラウンドタスク）。

### ② hook の `conversationId` でその instance のファイルを特定できるか → **満たす**

**cwd + 最新の推測は要らない。** 実測した対応関係:

```
hook payload  conversationId : 1ce50bef-fc2a-4039-8114-5aae518678e6
              transcriptPath : …/brain/1ce50bef-fc2a-4039-8114-5aae518678e6/.system_generated/logs/transcript_full.jsonl
ファイル          brain/<同じ uuid>/…        conversations/<同じ uuid>.db
```

- `session_start` / `stop` / `post_tool_use` の全イベントが同じ `conversationId` を載せる（10/10 件）。
- `--continue` は **conversationId を変えない**。3 ターンすべて同一値。
- `conversationId` は brain ディレクトリ名そのもの。パスは
  `<agyHome>/brain/<conversationId>/.system_generated/logs/transcript_full.jsonl` で**計算できる**
  （codex のように日時入りファイル名を走査する必要が無い）。

**逆に、cwd は使えない。** agy は hook を **`~/.gemini/config` を cwd にして起動する**（10/10 件）。
エージェント本人の作業ディレクトリではない。`workspacePaths` も CLI モードでは空配列（#1757 の観測どおり）。
だから worktree の特定は起動時に焼き込む `--worktree-id` に依存し続ける（既存どおり。本 Issue は変更しない）。

**IDE と CLI は別ディレクトリ。** IDE 側 antigravity は `~/.gemini/antigravity/`、
CLI（`agy`）は `~/.gemini/antigravity-cli/`。CommandMate が起動するのは CLI なので、
IDE を同時に開いていても読む先が重ならない。加えて conversationId は uuid なので衝突しない。

### ③ turn 境界が判別できるか → **満たす**

`USER_EXPLICIT` / `USER_INPUT` レコードが turn を開く。3 ターンのセッションで step_index 0 / 2 / 12 の
3 件が立ち、それぞれの直後から次の USER_INPUT までが 1 ターンだった。

`step_index` は会話内で一意 — **41 本すべてで重複ゼロ**。ゆえに
`<conversationId>#<step_index>` が turn の安定した名前になる。ただし:

- **欠番がある**（41 本中 10 本）。拒否されたツール呼び出しの step が消える。連番を前提にしてはいけない。
- **1 本だけ非単調**（`924ee617…` で 8 → 7）。したがって並べ替えず**ファイル順**で読む。

codex の `task_complete` に相当する「turn を閉じる」レコードは**無い**。
claude の転写リーダー（#2121）と同じで、turn の終わりは agy 自身の `Stop` hook が知らせ、
そのタイミングでポーラが本リーダーを呼ぶ。

### ④ 読み取りがロックを起こさないか → **満たす**

`transcript_full.jsonl` は**追記専用の平文ファイル**。SQLite でも mmap でもロックファイルでもない。
`readTranscriptTail()`（`open(path,'r')` ＋ offset read）で読むだけなので、
排他も `-wal` 生成も起こらない。§1-3 のとおり `.db` を開く経路は採用しない。

> なお `~/.gemini/antigravity-cli/presence/<conversationId>.lock` は agy 自身が持つ presence lock で、
> 転写の読み取りとは無関係。本リーダーは触れない。

---

## 3. 判定

**go。** 4 条件すべてを満たす。scraper 継続の根拠は無い。

---

## 4. 実装

#2197（codex）と同じ形を踏襲する。逸脱は 2 点だけで、いずれも上の実測が理由。

| 部品 | 実装 |
|---|---|
| pointer latch | `resolveAntigravityConversationId()` — `getLastAgentEvent().sessionId`（= `conversationId`）。無ければ latch。**cwd フォールバックは置かない** |
| ホーム配下検証 | `acceptAntigravityTranscriptPath()` — `<agyHome>/brain` 配下・`.jsonl`・NUL 無しを resolve 後に検査 |
| 窓読み | `readTranscriptTail()`（#2196 の共通ヘルパ、4 MiB） |
| turn 境界 | `USER_EXPLICIT`/`USER_INPUT` が開く。最新 turn だけを書く |
| assistant 行 | `request_id = antigravity-turn:<conversationId>#<stepIndex>`。`AGENT_MARKDOWN_REQUEST_ID_PREFIXES` に追加 |
| user 行 | `antigravity-prompt:<conversationId>#<stepIndex>` を `recordUserTurn()` へ。prefix は Markdown 一覧に**入れない** |
| capability | `transcriptHistory: 'pull'` ＋ `PULL_TRANSCRIPT_READERS` に 1 行 |
| 例外 | 何も throw しない。pointer 無し・ファイル無し・turn 無しはすべて false（scraper へ fail-open） |

### codex と違う 2 点

1. **ファイル走査が要らない。** codex は rollout のファイル名にローカル時刻が埋まるので `sessions/` を
   走査するが、agy はパスが conversationId から決まる。走査コードは書かない。
2. **turn を閉じるレコードが無い。** codex は `task_complete` を待てるが agy には無いので、
   claude と同じく「最新 turn を書く」。空本文の turn は false を返して scraper に委ねる。

### レンダリング規則（すべて §2 ① の全数計測に基づく）

- `MODEL`/`PLANNER_RESPONSE` の `content` → 本文ブロック（Markdown 原文のまま）
- 同レコードの `thinking` → `> **Thinking**` の引用ブロック（claude / codex と同じ畳み方）
- 同レコードの `tool_calls` → `` - `<name>` — <toolAction> `` の 1 行
- それ以外の `MODEL` type（ツール出力）と `SYSTEM` type → **黙って落とす**。
  ツール出力は呼び出し行がすでに要約しており、`SYSTEM` は agent の言葉ではない。
  ただし**「知らない type」とは区別する**: 上記 15 語は既知の沈黙リストに置き、
  それ以外が来たら `unknownRecordTypes` に数えてログへ出す。
