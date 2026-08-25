# opencode server SSE fixtures（Issue #1758 / Phase 4-0b スパイク）

`opencode serve` の **`GET /event`（SSE）** から実際に採取した payload。
採取手順・全観測結果は [`docs/design/opencode-server-live-verification.md`](../../../../docs/design/opencode-server-live-verification.md) を参照。

- **採取日**: 2026-08-13
- **対象**: opencode **1.18.3** / macOS (Darwin 25.6.0) / provider `github-copilot` `claude-sonnet-4.6`
- **採取元**: `curl -N http://127.0.0.1:4788/event` を隔離 HOME 上の `opencode serve --port 4788` に張った SSE tap

> **hooks 系 4 ツール（`../claude/` 等）とは envelope の形が根本的に違う。**
> hooks は「エージェントが CommandMate に POST する payload」だが、
> ここにあるのは「CommandMate が SSE で購読して受け取る event」である。
> 承認の裁定は payload の**戻り値ではなく** `POST /session/:id/permissions/:permissionID` という別の REST 呼び出しで返す。

## envelope

`GET /event` の 1 フレームは `event:` 行を持たない **`data:` のみ**の SSE フレームで、中身は必ずこの形。

```json
{ "id": "evt_…", "type": "<イベント名>", "properties": { … } }
```

**イベント種別は SSE の `event:` フィールドではなく JSON の `type` にしか入っていない。**
`EventSource` の名前付きリスナ（`es.addEventListener("session.idle", …)`）では 1 件も拾えない。

`GET /api/event`（v2）は envelope が違う（`properties` ではなく `data`、加えて `durable` / `location`）。
比較用に [`api-event-envelope-message-updated.json`](./api-event-envelope-message-updated.json) を 1 件だけ収録した。
**ただし `/api/event` は 1 ターンの先頭 3 件で無言に沈黙する**（実測・再現あり）ので、購読には使えない。
詳細は設計書 §5.2.2。

## `AGENT_EVENT_TYPES` 7 語へのマッピング

`src/lib/hooks/agent-event-types.ts` の 7 語に対する opencode 側の対応。
**1:1 で対応するのは 3 語だけ**で、残りは複合条件・部分一致・不在である。

| `AGENT_EVENT_TYPES` | opencode の event | fixture | 対応 |
|---|---|---|---|
| `stop` | `session.idle` | [`session-idle.json`](./session-idle.json) | **1:1**。ただし 1 ターンで**2 回発火しうる**（error / abort 経路）。設計書 §5.3 |
| `session_start` | `session.created` | [`session-created.json`](./session-created.json) | **1:1**。ただし発火は「セッションレコードが生まれた瞬間」で、TUI 起動ではない |
| `user_prompt_submit` | `message.updated`（`info.role == "user"`）＋ `message.part.updated`（`part.type == "text"`） | [`message-updated-user.json`](./message-updated-user.json) / [`message-part-updated-user-text.json`](./message-part-updated-user-text.json) | **複合**。専用イベントは無く、`role` を見て判別する。本文は part 側 |
| `pre_tool_use` | `message.part.updated`（`part.type == "tool"` かつ `part.state.status == "running"`） | [`message-part-updated-tool-running.json`](./message-part-updated-tool-running.json) | **部分一致**。1 つ手前に `status == "pending"` もある（[fixture](./message-part-updated-tool-pending.json)）。`matcher` に相当する概念は無いので購読側でフィルタする |
| `post_tool_use` | 同上で `part.state.status ∈ {"completed","error"}` | [`…-completed.json`](./message-part-updated-tool-completed.json) / [`…-error.json`](./message-part-updated-tool-error.json) | **部分一致**。相関キーは `part.callID` |
| `notification` | `permission.asked` / `question.asked` / `session.error` | [`permission-asked.json`](./permission-asked.json) / [`question-asked.json`](./question-asked.json) / [`session-error.json`](./session-error.json) | **相当なし**。Claude の `notification_type` に当たる 1 本の入口は無く、用途別に 3 つの別イベントへ分かれる。`idle_prompt` 相当（放置検知）は**存在しない** |
| `session_end` | `session.deleted` | [`session-deleted.json`](./session-deleted.json) | **意味が違う**。`DELETE /session/:id` を明示的に呼んだときだけ発火する。TUI の `/exit` では**イベントが 1 件も出ない**（実測）。「エージェントが終わった」の signal にはならない |

## ファイル一覧

| ファイル | event `type` | 採取した状況 |
|---|---|---|
| [`server-connected.json`](./server-connected.json) | `server.connected` | SSE 接続直後の第 1 フレーム |
| [`server-heartbeat.json`](./server-heartbeat.json) | `server.heartbeat` | **10 秒ごと**の keepalive。**サーバの `/doc` には型定義が無い**（設計書 D3） |
| [`session-created.json`](./session-created.json) | `session.created` | TUI で初回プロンプト送信時 |
| [`session-deleted.json`](./session-deleted.json) | `session.deleted` | `DELETE /session/:id` |
| [`session-status-busy.json`](./session-status-busy.json) | `session.status` (`busy`) | ターン開始 |
| [`session-status-idle.json`](./session-status-idle.json) | `session.status` (`idle`) | ターン終了。`session.idle` と**同一ミリ秒**で出る |
| [`session-idle.json`](./session-idle.json) | `session.idle` | ターン終了。payload は `sessionID` **のみ** |
| [`session-error.json`](./session-error.json) | `session.error` | provider 側の失敗（LM Studio に model 未ロード） |
| [`message-updated-user.json`](./message-updated-user.json) | `message.updated` | ユーザー発話メッセージの生成 |
| [`message-part-updated-user-text.json`](./message-part-updated-user-text.json) | `message.part.updated` | 同メッセージの text part（プロンプト本文） |
| [`message-part-updated-tool-pending.json`](./message-part-updated-tool-pending.json) | `message.part.updated` | `bash` tool call が確定した瞬間 |
| [`message-part-updated-tool-running.json`](./message-part-updated-tool-running.json) | `message.part.updated` | `bash` 実行開始 |
| [`message-part-updated-tool-completed.json`](./message-part-updated-tool-completed.json) | `message.part.updated` | `bash` 完了（`state.output` あり） |
| [`message-part-updated-tool-error.json`](./message-part-updated-tool-error.json) | `message.part.updated` | 承認を `reject` した結果の失敗。`state.error` に REST で渡した `message` がそのまま入る |
| [`permission-asked.json`](./permission-asked.json) | `permission.asked` | allowlist 外ディレクトリへの `bash` |
| [`permission-replied.json`](./permission-replied.json) | `permission.replied` | 上記に REST で `once` を返した結果のエコー |
| [`question-asked.json`](./question-asked.json) | `question.asked` | `question` tool（Claude の `AskUserQuestion` 相当）。**選択肢が構造化されて入る** |
| [`question-replied.json`](./question-replied.json) | `question.replied` | `POST /question/:id/reply` のエコー |
| [`api-event-envelope-message-updated.json`](./api-event-envelope-message-updated.json) | `message.updated` | **`/api/event`（v2）側の envelope 比較用**。`properties` ではなく `data` |

## Issue #2041 の追加分（opencode **1.18.22** / 2026-08-13 ではなく **2026-08-25** 採取）

上の表とは**採取日もバージョンも違う**。§4 のハーネス（隔離 HOME・`--port 4881`）で 3 ターン
（プレーン Markdown / tool 呼び出しあり / 967 文字 1 行の段落）を流して採った。
詳細は設計書 [§13](../../../../docs/design/opencode-server-live-verification.md)。

| ファイル | 中身 |
|---|---|
| [`history-turns-1-18-22.json`](./history-turns-1-18-22.json) | SSE tap から `message.updated` / `message.part.updated` / `message.part.delta` / `session.idle` の **142 フレーム**を到着順に。`server.heartbeat` 等は除いてある |
| [`session-messages-1-18-22.json`](./session-messages-1-18-22.json) | 同じセッションの `GET /session/:id/message` 応答（7 メッセージ = user 3 + assistant 4） |

**この 2 つは同じ 3 ターンの 2 つの見え方**なので、「保存された本文が REST の text と一致する」を
テストで突き合わせられる。

1.18.3 の fixture 群に無い、ここで初めて記録された事実:

- **`message.part.delta` が存在する。** 142 フレーム中 95。text part の増分はこちらに乗る。
- **text part の `message.part.updated` は必ず 2 回**（`text: ""` → 本文全体）。途中経過は来ない。
- **`step-start` / `step-finish` も part** である（`message.part.updated` で届く）。
- **1 ターンが assistant メッセージ 2 通になりうる**（`finish: "tool-calls"` → `finish: "stop"`）。
  束ねるキーは assistant の `messageID` ではなく `parentID`。

### プレースホルダ（追加分）

| 元の値 | プレースホルダ |
|---|---|
| user メッセージ id | `msg_user000000000000000000N` |
| assistant メッセージ id | `msg_asst00000000000000000NN` |
| part id | `prt_00000000000000000000000NN` |
| tool call id | `toolu_000000000000000000000NN` |

`cost` / `tokens` / `time` / 本文は実測値のまま。

## プレースホルダ

環境固有値はすべて置換済み（`grep` で実 ID・実パスが残っていないことを確認済み）。

| 元の値 | プレースホルダ |
|---|---|
| `sessionID` | `ses_0000000000000000000000000` |
| `messageID` | `msg_0000000000000000000000000` |
| part ID | `prt_0000000000000000000000000` |
| event ID | `evt_0000000000000000000000000` |
| permission ID | `per_0000000000000000000000000` |
| question ID | `que_0000000000000000000000000` |
| tool call ID | `toolu_0000000000000000000000000` |
| snapshot ID | `snap_0000000000000000000000000` |
| worktree の絶対パス | `<WORKTREE_PATH>` |
| projectID（パスの sha1） | `<PROJECT_ID>` |
| OS ユーザー名 | `<USER>` |

`slug`（`brave-cabin` 等）は opencode が付ける人間向けの短縮名で、環境固有値ではないため実値を残している。
`cost` / `tokens` / `time` も実測値のまま（形を示すため）。

## 検証

```bash
for f in tests/fixtures/hooks/opencode/*.json; do python3 -m json.tool "$f" > /dev/null || echo "NG: $f"; done
```
