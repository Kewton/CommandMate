# codex の構造化イベント連携 — 設計と実測

- Issue: [#1760](https://github.com/Kewton/CommandMate/issues/1760)（Epic [#1720](https://github.com/Kewton/CommandMate/issues/1720) Phase 4-2）
- 実装: `src/lib/hooks/sources/codex/`（`source.ts` / `hooks-config.ts` / `tool-id.ts`）、`src/lib/cli-tools/codex.ts`
- 前提: [`agent-event-source-interface.md`](./agent-event-source-interface.md)（#1759 の I/F）/ [`agent-hooks-phase4-live-verification.md`](./agent-hooks-phase4-live-verification.md) §5.1（#1757 の実測）
- 検証対象: **codex-cli 0.147.0** / macOS (Darwin 25.6.0) / Apple Silicon
- 検証日: 2026-08-13

> 本書に書いてあるのは**実際に動かして観測した結果**である。#1757 で未計測だった項目を本 Issue で追加計測した（[§2](#2-1760-で新たに実測した項目)）。

---

## 1. 3 行で

- codex には `--settings` 相当が無く、hooks 設定は `$CODEX_HOME/hooks.json` か `<cwd>/.codex/hooks.json` の**どちらもセッション単位にできない**。
- しかし **hook の `command` は POSIX シェルで実行され、hook プロセスは codex を起動したシェルの環境変数を継承する**（本 Issue で実測）。したがって**設定ファイルは全セッション共通の静的な内容**にし、`worktreeId` / `instanceId` / 受け口 URL は**起動コマンド行の環境変数**で渡す。
- hooks は**人間が trust するまで動かない**。trust は**ユーザーの `~/.codex/config.toml`** に書かれるので、CommandMate は**書かない**。既定では危険フラグも使わない。

---

## 2. #1760 で新たに実測した項目

| # | 観測 | 結果 | 影響 |
|---|---|---|---|
| **M1** | hook の `command` はシェル解釈されるか | **される**。`$VAR` 展開・`"…"` / `'…'` のグルーピング・`${VAR:+…}`・二重引用符内の `&`・末尾 `# コメント` すべて機能。**スペースを含むパスを引用符で囲んでも 1 引数**として渡る | 設定ファイルを静的にでき、相関キーを環境変数で渡せる。**本 Issue の設計全体がこれに依存する** |
| **M2** | hook プロセスの環境変数 | **codex を起動したシェルの環境をそのまま継承**（`CM_AGENT_INSTANCE_ID=codex-2` を付けて起動 → hook に `codex-2` が届く） | `codex` と `codex-2` の判別手段。`cwd` は両者で同一、`session_id` はインスタンスをまたいで安定しない |
| **M3** | TUI の「Hooks need review」ダイアログ | **`getCodexActiveDialog()` が `null`、`isCodexPromptReady()` が `false`** を返す（実 pane キャプチャで確認）。放置すると `waitForReady` が 30 回ポーリングして諦め、**ダイアログのまま `sendMessage` に渡る** | `cli-tools/codex.ts` 側で明示的に処理する必要がある。**hooks.json を置くだけで codex の起動が壊れる**ということ |
| **M4** | 同ダイアログの `3`（Continue without trusting）| **数字キー単独で即確定**（Enter 不要）。次のポーリングでプロンプト ready | #890 と同じ扱いでよい |
| **M5** | 「Continue without trusting」の永続性 | **しない。次回起動でも同じダイアログが出る** | 毎起動 1 回のダイアログ処理が要る（＝ M3 の対処は恒久的に必要） |
| **M6** | 「Trust all and continue」が書くもの | `~/.codex/config.toml` に `[hooks.state."<file>:<snake_case_event>:0:0"] trusted_hash = "sha256:…"` を**イベントごとに 1 エントリ**追記。以後ダイアログは出ず hooks が発火 | trust は**ファイルパス＋ハンドラ内容のハッシュ**に紐づく。**内容が変わると再レビュー**になるので、生成物は決定的でなければならない |
| **M7** | `SessionEnd` の timeout | **3 秒にクランプされ、TUI に `⚠ clamping SessionEnd hook timeout to 3s in …/hooks.json` が常時表示される** | `SessionEnd` だけ `timeout: 3` で書く |
| **M8** | `PermissionRequest` の裁定（再確認） | `{}` → 通常の承認ダイアログ（fail-safe）／`{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}` → **ダイアログ無しで実行**／受け口停止中 → ダイアログ（fail-open、セッションは止まらない） | `noDecision: { kind: 'proceeds' }` の根拠。`curl` の stdout がそのまま裁定になる |

M1・M2 の実測コマンド（抜粋。`$SP` は隔離スクラッチ、`CODEX_HOME` は隔離ホーム）:

```bash
# hooks.json の command に "$CM_AGENT_INSTANCE_ID" を含めて起動
CM_AGENT_INSTANCE_ID=codex-2 codex exec --dangerously-bypass-hook-trust "…"
# => probe が受け取った argv: ARG2=[codex-2]  ← シェル展開されている
```

---

## 3. 設計判断と根拠

### 3.1 書き先は `$CODEX_HOME/hooks.json`（`<worktree>/.codex/hooks.json` は採らない）

どちらも発火する（#1757 §5.1.2）。worktree ローカルを採らない理由:

1. **git 作業ツリーの中**なので、全 worktree に未追跡の `.codex/` が生える。Changes 画面に出るし、`git add -A` するエージェントがコミットしうる。
2. **trust は絶対パス単位**（M6）。worktree ごとにファイルが違えば、**worktree を作るたびに人間がレビューダイアログに答える**ことになる。

グローバル 1 本なら内容は全 worktree・全インスタンスで同一（相関キーは環境変数なので）＝ **trust は 1 回で済む**。代償は、CommandMate が起動していない codex セッションからもイベントが飛ぶこと。その場合は相関キーが未設定なので、リレーはキーを省略し、受け口は `cwd` から worktree を解決する（#1549 の手動設定と同じ挙動）。`CM_AGENT_HOOKS_INJECT=0` で全体を止められる。

### 3.2 trust は CommandMate が与えない（`--dangerously-bypass-hook-trust` は既定 OFF）

`--dangerously-bypass-hook-trust` は**そのプロセスが見えるすべての hooks のレビューを無効化する**。その中には `<cwd>/.codex/hooks.json` ——**作業対象リポジトリの中のファイル**——が含まれる。既定で付けると「悪意あるリポジトリを clone して CommandMate で開いた瞬間に、そのリポジトリの `.codex/hooks.json` がダイアログ無しで実行される」ことになり、codex がこの機構を作った理由そのものを潰す。構造化 `Stop` イベントはその代償に見合わない。

したがって:

- CommandMate は**設定ファイルを書くだけ**。trust は与えない。
- 起動時のレビューダイアログは `3.（Continue without trusting）`で閉じる（M3/M4/M5）。**hooks は動かないが、セッションは正常に起動し、スクレイパは #1760 以前とまったく同じに動く**。
- 有効化したい人間は、codex 自身のレビュー画面で 1 回 trust する（`~/.codex/config.toml` を書くのは codex であって CommandMate ではない）。以後は永続（M6）。
- 自動化・CI 向けに `CM_CODEX_HOOK_TRUST=bypass` を用意した（`bypass` 以外の値は無効）。

> **`~/.codex/config.toml` は読み取りすらしない。** 実機ではこのファイルの 5 行目に Computer Use の `notify` が設定されており、上書きするとユーザーの稼働中の機能を壊す。本 Issue の作業前後で sha256 が一致することを確認済み。

### 3.3 登録するイベントは 4 つ ＋ `PermissionRequest`

`SessionStart` / `UserPromptSubmit` / `Stop` / `SessionEnd` ＋ `PermissionRequest`。

- **`Notification` は codex に存在しない**（#1757 §5.1.1、レビュー画面が列挙する 11 イベントに無い）。書いても無言で捨てられる。
- **`PreToolUse` / `PostToolUse` は登録しない。** 発火はするが、Claude が matcher `AskUserQuestion` 限定で登録している（#1726）のは「その tool の引数が人間への質問そのもの」だから。codex にその tool は無いので、登録して得られるのはツール呼び出し 1 回につき 2 リクエストだけになる。`capabilities.supportedEvents` からも外し、待つ側が永久に待たないようにしてある。
- `PermissionRequest` は観測ではなく**裁定**なので、専用の受け口（`/api/hooks/permission-request`）に投げる。

### 3.4 配送はリレースクリプト＋インライン `curl` の二本

| 用途 | 実体 | 理由 |
|---|---|---|
| ライフサイクル 4 イベント | `scripts/hooks/cmate-agent-event.sh --tool codex --event <word> --worktree-id "$CM_AGENT_WORKTREE_ID" --instance-id "$CM_AGENT_INSTANCE_ID" --stdin-json` | 既に 7 語対応済み。空の相関キーを落として `cwd` にフォールバックする挙動もそのまま使える |
| `PermissionRequest` | インライン `curl … --data-binary @- "$CM_PERMISSION_HOOK_URL"` | **応答ボディが裁定そのもの**で、リレーはボディを捨てるため使えない。`curl` の stdout が codex の読む裁定になる |
| リレーが見つからない場合 | インライン `curl`（codex の payload をそのまま POST） | Claude の `buildSessionStartCommand` と同じ fail-open。受け口は `hook_event_name` を codex ソースのマッパで読む |

`type:"http"` は**書かない**。1 つでも書くと `hooks.json` 全体の parse が失敗し、command hooks も全部死ぬ（#1757 §5.1.4）。

### 3.5 ユーザーの既存設定は置換しない

`$CODEX_HOME/hooks.json` はユーザーのファイルであり、**ユーザー自身の codex hooks が置ける唯一の場所**でもある。したがって:

- 既存のイベント・ハンドラ・トップレベルキーはそのまま残し、CommandMate のハンドラを**追記**する。
- 自分のハンドラは `# commandmate:agent-hooks`（シェルコメント。M1 で無害と実測）で識別し、再生成時は**置換**する（重複しない）。
- 既存値が配列でないイベントは**触らない**（理解できない形を壊さない）。
- **内容が一致するときはファイルを開かない**（trust を無駄に失わせない、mtime も変えない）。
- JSON として読めないファイルは**上書きしない**（注入を諦めてセッションは起動する）。

---

## 4. `AgentEventSource` I/F で表現できなかったこと

**codex 固有の抜け道（`if (tool === 'codex')` 等）は 1 つも足していない。** I/F 自体の変更も無い。ただし 1 点だけ、I/F の形が codex に対して不足していた:

- **`AgentInstanceRef` に worktree の**パス**が無い。** `prepareLaunch(target, executablePath)` は `(worktreeId, cliToolId, instanceId)` しか受け取らないので、`configScope: 'per-worktree'` を選ぶ実装は自力で worktree パスを引く必要がある（DB 参照）。本 Issue はグローバル 1 本（§3.1）を選んだので**回避できた**が、`<worktree>/.gemini/settings.json` に書く #1762（gemini）は同じ壁に当たる。I/F を変えるなら `AgentLaunchPlan` を返す側ではなく `prepareLaunch` の入力に `worktreePath?: string` を足すのが最小である。#1759 に差し戻すほどではないと判断し、本 Issue では設計側で回避した。

---

## 5. 運用手順（構造化イベントを有効にする）

1. CommandMate から codex セッションを 1 回起動する（`$CODEX_HOME/hooks.json` が生成される）。
2. **端末で直接** `codex` を起動する。「Hooks need review」で `2. Trust all and continue` を選ぶ。
   - CommandMate 経由の起動では `3` が自動送信されるため、trust はここでしか与えられない（意図的。§3.2）。
   - これで `~/.codex/config.toml` に `[hooks.state…]` が追記される（書くのは codex）。
3. 以後、CommandMate から起動した codex セッションで `stop` / `user_prompt_submit` / 承認裁定が届く。

無効化: `CM_AGENT_HOOKS_INJECT=0`（設定を書かず、起動コマンドも #1760 以前と完全に同一になる）。
自動化での有効化: `CM_CODEX_HOOK_TRUST=bypass`（§3.2 のリスクを理解した上で）。

---

## 6. 関連

- Epic: [#1720](https://github.com/Kewton/CommandMate/issues/1720) / I/F: [#1759](https://github.com/Kewton/CommandMate/issues/1759) / スパイク: [#1757](https://github.com/Kewton/CommandMate/issues/1757)
- fixture: [`tests/fixtures/hooks/codex/`](../../tests/fixtures/hooks/codex/)
- テスト: `tests/unit/hooks/sources/codex-source-1760.test.ts` / `tests/unit/hooks/codex-hooks-config-1760.test.ts` / `tests/unit/cli-tools/codex-agent-hooks-1760.test.ts` / `tests/integration/hooks-agent-event-codex-1760.test.ts`
