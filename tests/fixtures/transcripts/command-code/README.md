# Command Code (`commandcode`) 転写 — 実機 fixture と実測メモ

Command Code **v1.40.1** の転写 JSONL を実機で採取したもの。Issue #2252 / Epic #2249 Phase C。
読み手は `src/lib/hooks/sources/command-code/transcript.ts` と `.../history.ts`。

## 採取方法

隔離した作業ディレクトリで、`commandcode --trust --skip-onboarding --no-auto-update [--yolo]
-p "<prompt>" --output-format text` を実行して `~/.commandcode/projects/<slug>/<session_id>.jsonl`
に書かれたものをそのまま読み出した。**`--no-session` は使っていない** — これは
「セッションをディスクに永続化しない（in-memory only）」フラグで、付けると転写ファイルが
1 バイトも書かれない（バンドルの `--no-session` の説明文そのまま、実機でも確認）。

## ファイル

| ファイル | 中身 | 何のための形か |
|---|---|---|
| `three-turns-1401.jsonl` | header + 3 ターン（closed / closed / prompt だけ） | 通常読み取り・冪等・backfill |
| `three-turns-1401.turn-a.md` | 1 ターン目の本文 | `renderCommandCodeTurn` の本文一致 pin |
| `three-turns-1401.turn-b.md` | 2 ターン目の本文 | 同上 |
| `open-turn-1401.jsonl` | header + closed 1 ターン + **`tool_use` で終わっている 2 ターン目** | #2264 の「閉じていないターンを書かない」 |
| `open-turn-1401.turn-b.md` | その 2 ターン目を描画したもの | **空ではない**ことの証拠（下記） |

`.jsonl` の各 record は実機が書いたものそのまま。**手で変えたのは 3 箇所だけ**で、いずれも
機械が生成した識別子である:

- header の `id`（session id）を `33333333-3333-4333-8333-333333333333` に、`cwd` を
  `/private/tmp/MyCodeBranchDesk/probe` に置換した。`tests/fixtures/hooks/command-code/` の
  hook payload と同じ値なので、`transcript_path` と突き合わせて読める
- 2 セッション分の record を 1 本のファイルに連結したので、entry の `id` / `parentId` を
  出現順に振り直した（`parentId` は「直前の entry」を指すだけの鎖なので、順序を保てば意味は変わらない）
- `open-turn-1401.jsonl` は `three-turns-1401.jsonl` を 2 ターン目の assistant record で
  切っただけ（末尾を削っただけで、行の中身は変えていない）

`.md` は `renderCommandCodeTurn` の出力を書き出したうえで目視確認したもの。

## 実測（この reader が依存している事実）

1. **1 行目が header、以降が entry。** header は
   `{"type":"session","version":3,"id":…,"timestamp":…,"cwd":…}`。バンドルの `isSessionEntryV3` が
   受ける `type` は `message` / `model_change` / `effort_change` / `compaction` /
   `branch_summary` / `custom` / `custom_message` / `label` / `session_info` の 9 語で、
   会話を運ぶのは `message` だけ。
2. **`id` は uuid ではなく 8 桁 hex の短い id**（`cb06ab09`）。`parentId` は「直前の entry」で、
   返信と質問を結ぶポインタではない。だからターンは**出現順**で組む（claude と同じ）。
3. **`message.meta.source` が来歴を持つ。** `user`（操作者の入力）/ `model`（エージェント）/
   `tool`（`tool_result` の器）。バンドルのエージェントループはさらに `steering`
   （ターン実行中に打たれてキューされた入力）と `followup` を書く。**`user` だけを user 行にする**
   のはこの実測が根拠（#2196 の positive evidence 規則）。`meta` にはほかに `createdAt`（epoch ms）/
   `messageId` / `isMeta` / `isSummary` / `isAutomated` がある。
4. **entry の `timestamp` は「ストアに append した時刻」であって「メッセージが作られた時刻」ではない。**
   writer はバッファする — `persistEntry` は**最初の assistant message entry が来るまで 1 バイトも書かず**、
   来た時点で header ごと `writeWholeFile` で一括書き出しする。採取した session では
   prompt / assistant / tool_result の 3 record が同一の `timestamp` を持ち、`meta.createdAt` は
   3 つとも違った。だから reader は `createdAt` を優先する。
5. **`stop_reason` に相当するフィールドは無い。** claude の #2264 は `message.stop_reason` を読むが、
   Command Code はどの record にもそれを永続化しない（採取ファイルを grep して 0 件）。
   代わりにバンドルのエージェントループが
   `if(!hadToolCalls){ const e = "max_tokens"===stopReason ? "max_tokens" : "end_turn"; … }`
   と書いている — **「モデルの最後の発話が tool を呼ばなかった」ことがターンの終わり**であり、
   ただそれがファイルに書かれないだけである。`isCommandCodeTurnClosingRecord` はこれを
   「散文があり、同じ record に `tool_use` が無い」として実装している
   （antigravity が同じ理由で同じ規則に到達している）。
6. **`-p --session` の再開実行は assistant record を永続化しないことがある。** 採取中に実測:
   2 回目・3 回目の `-p` は返答を画面に出したのにファイルには user record しか残らなかった
   （append が enqueue されたままプロセスが終了する）。`open-turn-1401.jsonl` はまさにこの形で、
   **閉じていないターンを書いてしまう欠陥（#2264）が実機で起こりうる**ことの証拠になっている。

## 使うときの注意

- **`open-turn-1401.turn-b.md` は空ではない。** これが #2264 の核心で、書き手の「本文が空なら
  書かない」ガードでは捕まらないということ — `tool_use` で切れたターンも tool 欄のおかげで
  非空の本文を描画する。だから `isCommandCodeTurnWritable`（`closed || superseded`）が要る。
- **slug を計算しないこと。** `~/.commandcode/projects/<slug>` の `<slug>` は
  バンドルの `slugify(cwd)` で、camelCase も分解する（`MyCodeBranchDesk` → `my-code-branch-desk`）。
  claude の `[^A-Za-z0-9] → -` とは別の関数である。reader は session id でファイルを**探す**。
- **fork / clone は範囲外。** header に `parentSession`（別セッションの `.jsonl` パス）が付くことがあり、
  reader はそれを読んで**ログに出すだけ**で、木構造の再構成はしない（Issue #2252 スコープ外）。
