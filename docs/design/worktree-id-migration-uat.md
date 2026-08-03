# worktree ID 移行の実機 UAT 記録（Issue #1645 / #1621 Phase 3・4）

測定日: 2026-08-03 / 測定者: 実装ワーカー / 対象ブランチ: `feature/1645-worktree-id-migration`

このドキュメントは**実測値の記録**である。単体テストで主張できないこと（HTTP ステータス
コード、tmux セッションのリネームがプロセスを保つこと）はここに書かれた測定が唯一の根拠。

---

## なぜ実測が要るか

- **ステータスコードは単体テストで主張できない。** `next/navigation` をモックしたテストは
  200 でも緑になる。#1644 が実際にそれを踏んでおり、テストは全部緑のまま実サーバは
  `HTTP 200 + <meta http-equiv="refresh">` を返していた（App Router の仕様）。
- **tmux のリネームがプロセスを保つことも同様。** モックした `renameSession` は、実際の
  `rename-session` がペインを殺すかどうかについて何も言わない。

---

## 隔離環境（本番に一切触れていない）

| 項目 | 値 |
|---|---|
| ポート | **3199**（本番 3000 は停止も再起動もしていない） |
| DB | `~/.cm1645-uat/db/cm.db`（`CM_DB_PATH` で明示。本番 DB には触れていない） |
| 走査源 | `WORKTREE_REPOS=~/.cm1645-uat/repos/cm1645-uat-alpha`（スクラッチの git repo 1 個） |
| 起動 | 自分の worktree で `npx tsx server.ts`（dev / production の両方で測定） |
| tmux | 既定サーバ。セッション名は `mcbd-claude-cm1645-uat-*` で、**起動前に既存 22 セッションと衝突しないことを確認**した |
| 後始末 | `kill-session -t '=mcbd-claude-cm1645-uat-alpha:'`（完全一致）。**`kill-server` は使っていない**。実行前後で他の `mcbd-*` は 21 個のまま |

`bind-key` / `set-option -g` を明示的には撃っていない。ただし `initReadMode`（#1623）は
サーバ起動の一部として走り、**本番サーバが既に導入しているものと同一の `prefix+g` バインドを
収束的に再確認**する（内容が同じなら書かない設計）。`CM_READ_MODE=off` は「スキップ」ではなく
「前回のバインドを削除する」収束型なので、**あえて設定しなかった**（設定するほうが本番の
バインドを消してしまう）。

---

## Part A: migration + 起動時 reconcile

### 手順

1. スクラッチ repo（branch `develop`）を作り、隔離サーバを 1 度起動して DB を作成
2. DB を **#1645 適用前の姿**へ巻き戻す: worktree 行の ID を旧方式
   `cm1645-uat-alpha-develop`（`<リポジトリ名>-<ブランチ名>`）にし、子行
   （`chat_messages` 2 / `tasks` 1 / `verification_runs` 1 / `agent_instances` 1）を
   その ID にぶら下げ、`schema_version` から 54 を削除
3. **旧セッション名で本物の `claude` を起動**: `tmux new-session -d -s mcbd-claude-cm1645-uat-alpha-develop -c <repo> 'claude'`
   → ペイン PID **94761**、`claude` v2.1.220（trust プロンプト表示中。**キーは一切送っていない**）
4. サーバを再起動 → migration v54 と起動時 reconcile が走る

### 結果

サーバログ:

```
Applying migration 54: renumber-worktree-ids-from-path...
Renumbered worktree cm1645-uat-alpha-develop -> cm1645-uat-alpha
Renumbered 1 of 1 worktree(s) to path-derived IDs
[INFO] [tmux] session:renamed {"oldName":"mcbd-claude-cm1645-uat-alpha-develop","newName":"cmate-renaming-0"}
[INFO] [tmux] session:renamed {"oldName":"cmate-renaming-0","newName":"mcbd-claude-cm1645-uat-alpha"}
[INFO] [worktree-session-reconcile] reconcile:complete {"renames":1,"renamedSessions":1,"skipped":0,"errors":0}
Reconciled 1 tmux session(s) to renamed worktree IDs
```

| 検証項目 | 結果 |
|---|---|
| セッション名 | `mcbd-claude-cm1645-uat-alpha`（新 ID） |
| **ペイン PID** | **94761 → 94761（同一）** = `claude` プロセスは殺されていない |
| スクロールバック | 保持（リネーム前に出ていた trust プロンプトが capture できる） |
| 旧セッション名 | `can't find session`（即座に解決不能） |
| 一時セッション | `cmate-renaming-*` は 0 個（サーバ全体で） |
| 2 段階リネームの証跡 | ログのとおり `旧名 → cmate-renaming-0 → 新名` |

DB:

```
worktrees        : [{"id":"cm1645-uat-alpha","name":"develop","branch":"develop"}]
aliases          : [{"old_id":"cm1645-uat-alpha-develop","worktree_id":"cm1645-uat-alpha"}]
chat_messages    : [{"worktree_id":"cm1645-uat-alpha","n":2}]
tasks            : [{"worktree_id":"cm1645-uat-alpha","n":1}]
verification_runs: [{"worktree_id":"cm1645-uat-alpha","n":1}]
agent_instances  : [{"worktree_id":"cm1645-uat-alpha","n":1}]
total orphan rows: 0     ← worktree_id 列を持つ全テーブルを走査（FK 宣言の有無を問わない）
```

API は旧 ID も受理する: `GET /api/worktrees/cm1645-uat-alpha-develop` → `{"id":"cm1645-uat-alpha",...}`。

---

## Part B: ブランチ切替 → sync（#1621 の元の事象）

稼働中の `claude` セッションと Auto-Yes を持ったまま、**同じディレクトリで**ブランチを
切り替えて sync した。

1. `POST /api/worktrees/cm1645-uat-alpha/auto-yes {"enabled":true,"duration":3600000}`
   → `{"enabled":true,"expiresAt":1785761356977,"pollingStarted":true}`
2. `git checkout -b feature/uat-1645`（worktree ディレクトリはそのまま）
3. `POST /api/repositories/sync` → `{"success":true,"worktreeCount":1,"deletedCount":0}`

| 検証項目 | 期待 | 実測 |
|---|---|---|
| worktree ID | 変わらない | `cm1645-uat-alpha`（不変） |
| 表示ブランチ | 追従する | `develop` → `feature/uat-1645`（`name` / `branch` とも） |
| tmux セッション | 残る | `mcbd-claude-cm1645-uat-alpha`、ペイン PID **94761（同一）** |
| UI 上の稼働表示 | 残る | `sessionStatusByCli.claude.isRunning: true` |
| Auto-Yes | 継続 | `{"enabled":true,"expiresAt":1785761356977}`（**expiresAt が同一**＝カウントダウンが再スタートしていない） |
| 履歴 / タスク / 検証履歴 / roster | 引き継がれる | 2 / 1 / 1 / 1 件とも新 ID の下に健在 |

---

## Part C: 真の 3xx（#1644 から引き継いだ宿題）

`curl` の実測。**dev（`tsx server.ts`）と production（`NODE_ENV=production`）の両方**で同じ。

| URL | ステータス | Location |
|---|---|---|
| `/worktrees/cm1645-uat-alpha-develop` | **308 Permanent Redirect** | `/worktrees/cm1645-uat-alpha` |
| `/worktrees/cm1645-uat-alpha-develop/terminal` | **308** | `/worktrees/cm1645-uat-alpha/terminal` |
| `/worktrees/cm1645-uat-alpha-develop/files/src/index.ts` | **308** | `/worktrees/cm1645-uat-alpha/files/src/index.ts` |
| `/worktrees/cm1645-uat-alpha-develop/terminal?_rsc=abc123` | **308** | `/worktrees/cm1645-uat-alpha/terminal?_rsc=abc123` |
| `/worktrees/cm1645-uat-alpha`（現行 ID） | 200 | —（転送しない） |

レスポンスヘッダ全体:

```
HTTP/1.1 308 Permanent Redirect
Location: /worktrees/cm1645-uat-alpha
Cache-Control: no-store
Content-Length: 0
```

`curl -L` で追従すると `final=/worktrees/cm1645-uat-alpha/terminal code=200 redirects=1`。
**サブパスが保持され、worktree 詳細ではなくターミナル画面に着地する** — #1644 の layout 実装が
できなかった点。

### なぜ 301 ではなく 308 + `no-store` か

- **308**: メソッド保存の恒久リダイレクト。`/worktrees/<id>` は今はページルートだが、
  Server Action はページ自身の URL へ POST するため、301 が歴史的に許す GET 化は避けたい
- **`no-store`**: 「旧 ID → この worktree」は永続的だが**永遠ではない**。worktree を削除すると
  alias は CASCADE で消え、後から同じ basename のディレクトリがその ID を **live** として
  採番されうる（解決では live が alias に優先）。恒久リダイレクトをキャッシュしたクライアントは
  二度と問い合わせず、永久に間違った worktree に着地する。ステータスコードは「移動した」と
  言い続けるが、その答えのキャッシュだけを断る

### 実装位置と、AsyncLocalStorage の地雷

`middleware.ts` は edge runtime で SQLite が引けないため**不可**。したがって `server.ts` が
Next へ渡す前に傍受する。`server.ts` の top-level に静的 import を足すと `tsx server.ts` 下で
Next の AsyncLocalStorage bootstrap が壊れ、最初のリクエストで落ちる前科があるため、
`src/lib/git/worktree-redirect.ts` は **`await import()` で遅延読込＋キャッシュ**している。
「Ready 表示」では出ない不具合なので、dev / production の両方で実際に `GET /` と
`GET /worktrees/<現行ID>` を撃ち、200 が返りサーバが生存し続けることを確認した。

---

## 本番への適用（PM 判断）

migration は**サーバ再起動時に自動で当たる**。適用は**並列ワーカーが稼働していない
タイミング**で行うこと — 実行中の監視スクリプトは旧 ID を握ったままなので、移行の瞬間から
`send` / `capture` が失敗する（セッションは生きているのに指示が届かない）。
alias が残るので読み取り互換は保たれ、v54 の `down()` でロールバックもできる。
