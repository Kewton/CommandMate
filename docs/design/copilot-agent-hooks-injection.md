# copilot hooks の注入設計と実測（Phase 4-3）

- Issue: [#1761](https://github.com/Kewton/CommandMate/issues/1761)（Epic [#1720](https://github.com/Kewton/CommandMate/issues/1720) Phase 4-3）
- 実装: `src/lib/hooks/sources/copilot/`
- 前提: [`agent-event-source-interface.md`](./agent-event-source-interface.md)（#1759 の I/F）/ [`agent-hooks-phase4-live-verification.md`](./agent-hooks-phase4-live-verification.md) §5.2（#1757 の実測）
- fixture: [`tests/fixtures/hooks/copilot/`](../../tests/fixtures/hooks/copilot/)
- 検証時の版: **GitHub Copilot CLI 1.0.79**（2026-08-13）／ §7 は **1.0.80**（2026-08-21、[#1904](https://github.com/Kewton/CommandMate/issues/1904)）

---

## 0. 3 行で

- **Issue 本文冒頭の「hooks が実在しないかもしれない／実在しなければ取り下げ」は誤り。** #1757 が実在を確定させており、payload は 4 ツール中もっとも Claude Code に近い。取り下げていない。
- 近いのは **payload だけ**。設定の置き場所・裁定の返し方・裁定の締切の 3 つは Claude と別物で、本 Issue の実装コストはそこにある。
- **設定は `~/.copilot/settings.json` 1 本＝マシン全体で共有**。だから相関キーは設定ファイルに焼けず、**起動コマンドの環境変数**に載せる（本書 §2 が根拠）。
- #1904: 同じ理屈が**ポート**にも当てはまり、`config.json` の `hooks` は settings.json を**上書き**する。§7 を参照。

---

## 1. 本 Issue で新たに実測したこと

#1757 は「hooks が実在し、payload が Claude 互換で、timeout が ≈10 秒の fail-open」までを確定させた。
そこから先の**注入方式を決めるのに必要な 3 点は未計測**だったので、本 Issue で測った。

計測は `COPILOT_HOME` を隔離したうえで `copilot -p`（非対話）で実施し、**`~/.copilot/` は sha256 一致で無変更**であることを前後で確認している（§4）。

| # | 実測項目 | 結果 | これが偽なら |
|---|---|---|---|
| **L1** | hook コマンドは**シェル経由で実行されるか** | **される。** `;` / `$(…)` / `[ … ]` / リダイレクト / `printf` がすべて期待どおり動いた（`hookpost.sh cp-stop; echo marker > …/shell-marker.txt` の marker ファイル生成で確認） | 自己完結の 1 行コマンドが書けない。gate も timeout 上限も表現できない |
| **L2** | copilot プロセスの**環境変数が hook に継承されるか** | **される。** 起動時に与えた `CM_PROBE_VAR=probe-value-42` が hook プロセスから見え、コマンド中の `"$CM_PROBE_VAR"` も argv に展開された。あわせて copilot 自身が `COPILOT_CLI` / `COPILOT_CLI_BINARY_VERSION` / `COPILOT_HOME` / `COPILOT_PROJECT_DIR` を注入することも再確認 | **グローバル 1 本の設定でインスタンス相関が取れない。** 同一 worktree の 2 インスタンスが区別できなくなる |
| **L3** | `PreToolUse` hook の **stdout が裁定として解釈されるか**（インライン `curl` でサーバ応答を中継する形で） | **される。** `permissionDecision:"deny"` → `✗ … └ Denied by preToolUse hook: <reason>` でファイルは作られない。**`permissionDecision:"allow"` → `--allow-all-tools` 無しでもプロンプト無しに実行された**。`{}` → 通常フロー | Auto-Yes が copilot で成立しない。#1757 は deny と `{}` のみ実測で、**allow は未計測だった** |

### 1.1 裁定の締切に対する余裕（実測）

生成された `PreToolUse` コマンドをそのまま実行して往復を測った。

| 条件 | 往復 | stdout |
|---|---|---|
| 受け口が応答する | **107 / 110 / 114 ms** | `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}` |
| 受け口が落ちている | **133 ms** | `{}` |
| 相関 env が無い（CommandMate 以外が起動した copilot） | 即時 | `{}` |

copilot の既定 timeout は **≈10 秒**（#1757 §5.2.3）なので、**約 90 倍の余裕**がある。
受け口は in-memory の Auto-Yes 状態と TTL キャッシュ済みポリシーだけで裁定するので、この比は負荷でも大きく崩れない。

締切に間に合わない状況は「サーバが応答を返さないまま掴んだままになる」場合だけで、そこは
コマンド側の `curl -m 4`（`COPILOT_HOOK_CURL_TIMEOUT_SECONDS`）が 10 秒より内側で打ち切る。
**エージェントの timeout に judgement を任せない**のが設計意図で、任せると「遅れて届いた裁定が黙って捨てられる」（#1757 §5.2.3 の実測）ケースと区別がつかなくなる。

なお `"timeout"` は**生成する設定に書いていない**。#1757 の実測では `"timeout": 3` が 5.12 秒の待ちになっており、値と実挙動の対応が取れていないため、既定（≈10 秒）のまま最大の裁定予算を確保し、上限はコマンド側で持つ。

---

## 2. なぜ相関キーが環境変数に乗るのか

Claude は `--settings <file>` が起動ごとなので、`claude` と `claude-2` に別ファイルを渡し、
**URL に worktreeId / instanceId を焼き込める**（#1722）。

copilot に `--settings` 相当は無い。session 限定の注入手段は `COPILOT_HOME` の差し替えだけで、
それは認証・`trustedFolders`・履歴ごと別ホームにすることを意味するため、既存セッションを壊す。
したがって設定は **`~/.copilot/settings.json` グローバル 1 本**（`configScope: 'global-singleton'`）になる。

グローバル 1 本ということは、**書き込み時点で URL に焼けるインスタンスは 1 つだけ**であり、
2 番目のインスタンスは 1 番目の名前でイベントを送ることになる。L2 がその出口である:

```
CM_AGENT_WORKTREE_ID='wt-1' CM_AGENT_INSTANCE_ID='copilot-2' gh copilot
```

- 起動コマンドの**環境変数プレフィックス**として与える（`tmux set-environment` ではない）。
  pane はエージェント起動前に作られるので、割り当てを唯一意味のあるプロセスに直接載せるほうが、
  後からセッション環境を編集するもの（`sanitizeSessionEnvironment` を含む）の影響を受けない。
- hook 側は fire 時に読む。`--instance-id "${CM_AGENT_INSTANCE_ID:-copilot}"` と既定を持たせてあるので、
  未設定でも primary instance に落ちる。

### 2.1 副作用として: CommandMate が起動していない copilot では無効になる

グローバル設定は**オペレータが自分の端末で起動した copilot でも発火する**。
その cwd がたまたま登録済み worktree だと、`Stop` が cwd 解決で当たって
**誰のエージェントも終わっていないのに `commandmate wait` が返る**。

そこで生成コマンドは全て次の gate で始まる:

```sh
: cmate-copilot-agent-hooks; if [ -z "${CM_AGENT_WORKTREE_ID:-}" ]; then cat >/dev/null; exit 0; fi; …
```

- 先頭の `:` はシェルの no-op ビルトイン。引数の `cmate-copilot-agent-hooks` が
  **ユーザー設定へマージするときに自分のエントリを見分けるマーカー**を兼ねる。
- `cat >/dev/null` は copilot が stdin に書く payload を捨てるため。先に exit すると書き込み側が EPIPE になる。
- 実測: 相関 env 無しで 1 ターン走らせて**受信 0 件**、セッションは正常完了（§4 RUN 2）。

---

## 3. 書き先とユーザー設定の非破壊

- **書き先は `~/.copilot/settings.json`**（`COPILOT_HOME` があればその配下）。
  `copilot help config` は `config.json` に書けると言うが、copilot は起動時に `hooks` を settings.json へ移送し、
  config.json を機械管理形式（先頭に `// User settings belong in settings.json.`）で書き戻す（#1757 P2）。
  **config.json に書くと次回起動で消える**。`tests/unit/hooks/sources/copilot-hook-settings.test.ts` の
  `where the file goes` がこの 1 点だけを見ている（書き先を config.json に変える変異で赤になる）。
- **置換ではなくマージ**。既存 JSON を読み、マーカーを含む自分のエントリだけを取り除き、現行を足して書き戻す。
  他のキー・他のハンドラ（grouped 形 / flat 形の両方）はそのまま通す。
- **パースできないファイルには触らない。** 読めない／JSON でない場合は例外にして注入を諦め、素の `gh copilot` で起動する。
  イベントを失うのは回復できるが、手編集された設定の上書きは回復できない。
- 再起動しても**自分のエントリは増えない**（マーカーで置換されるため）。

---

## 4. 実機検証の結果（copilot 1.0.79 / 2026-08-13）

実装が生成した設定と起動コマンドをそのまま使い、受け口はスタブ（`127.0.0.1:8918`）で受けた。
**本番サーバ（port 3000）には一切送っていない。**

隔離ホームには検証前にユーザー設定を置いてある（`theme: "dark"` と `Stop` のユーザー hook 1 本）。

| RUN | 条件 | 結果 |
|---|---|---|
| **1** | 相関 env あり（`instanceId=copilot-2`）／受け口あり | `user_prompt_submit` → `session_start` → **`PreToolUse` の裁定 `allow` でツールが無承認実行** → `post_tool_use` → `stop` → `session_end` の 6 件。**全件 `worktreeId=wt-live` / `instanceId=copilot-2`**。`detail` は `new` / `Bash` / `complete` と fixture どおり。**ユーザーの `Stop` hook も一緒に発火**（＝併存の実証） |
| **2** | 相関 env なし／受け口あり | **受信 0 件**、セッションは正常完了（PONG） |
| **3** | `CM_AGENT_INSTANCE_ID` 未設定／受け口あり | 4 件すべて `instanceId=copilot` に落ちた（`:-copilot` 既定） |
| **4** | 相関 env あり／**受け口を停止** | セッションは正常完了（exit 0、PONG）。**fail-open** |

イベント順は 4 回とも **`UserPromptSubmit` → `SessionStart`**。#1757 の観測と一致する。

**非汚染**:

```
$ shasum -a 256 -c baseline.sha256
/Users/…/.copilot/settings.json: OK
/Users/…/.copilot/config.json: OK
```

隔離ホーム側も `config.json` は前後で完全一致、`settings.json` は `theme` とユーザー `Stop` hook が保持され、
CommandMate のエントリは各イベント 1 件ずつ（`Stop` のみユーザー分と合わせて 2 件）だった。

---

## 5. 実装上の判断とその理由

| 判断 | 理由 |
|---|---|
| `supportedEvents` に **`notification` を入れない** | #1757 で登録したが**一度も発火しなかった**。TUI は未計測。`capabilities` は約束なので、観測していない語は約束しない（mapper は綴りを知っているので、手設定の hook から届けば読める） |
| `supportedEvents` に **`pre_tool_use` を入れない** | copilot に `PermissionRequest` は無く、`PreToolUse` が承認ゲートそのもの。CommandMate はこれを**裁定用の受け口**に向けるため、イベントストアには入らない。約束すると「別の場所で応答されているイベント」を待たせることになる |
| `PreToolUse` を event receiver と permission receiver の**両方には送らない** | 同一イベントに 2 ハンドラを置いたときどちらの stdout が採用されるかは**未計測**。copilot に `AskUserQuestion` 相当は無く、`pre_tool_use` の観測価値は `post_tool_use` / `user_prompt_submit` と重複する（どちらも `running`）ので、未計測の挙動に賭ける理由が無い |
| `encodeVerdict` が **`deny` を表現する** | copilot は `permissionDecision:"deny"` ＋ 理由文字列を実際に解釈する（実測）。Claude 実装には綴りが無い。ただし `permission-decision-service` は deny を出さないので、**能力の記述であって挙動の変更ではない** |
| `hook-event-vocabulary` の表を**共有したまま使う** | copilot の綴りは Claude / codex と同一であることが 6 payload で実測済み。#1759 の表はまさにこの 3 ツールの方言として置かれている。private な複製を作ると同じ綴りが 2 箇所で drift する |
| **中継スクリプトを使う（観測イベント）／インライン `curl`（裁定）** | `cmate-agent-event.sh` は copilot の綴りを既に全て知っており fail-open も実装済み。ただし応答ボディを捨てるので、裁定の中継には使えない。裁定だけインライン `curl` で stdout に流す |

---

## 6. 既知の限界

- ~~**サーバのポートは書き込み時点で固定される。**~~ → #1904 で解消（§7.2）。ポートは `CM_HOOK_PORT` で起動時に運ぶ。
- **repo-level `.github/hooks/*.json` は使っていない。** #1757 で発火せず、discovery 条件が未確定のため。
- **TUI での `Notification` は未計測。** プロンプト検出は #1723 のスクレイパ（2 層目）に残る。
- `Stop` にしか `transcript_path` が無い等、payload の細部は fixture が正。

---

## 7. #1904: マシン共通ファイル由来の脆さ 3 件（copilot 1.0.80 / 2026-08-21）

Issue [#1904](https://github.com/Kewton/CommandMate/issues/1904)。3 件とも根は同じで、
**`~/.copilot/settings.json` が「最後に copilot を起動したサーバが書いた 1 ファイル」である**こと。
設計判断の正本は [`multi-agent-state-architecture.md`](./multi-agent-state-architecture.md) §10.8 / §10.9、
受入条件は同 §13.2 の S7 / S8 / S16。

### 7.1 `config.json` の `hooks` が settings.json を上書きする

**実測（1.0.80）**: 両方のファイルにマーカー hook を置いて 1 セッション動かすと、
発火したのは `CONFIG-*` だけで、直後に読んだ settings.json は `CONFIG-*` 6 件 / `SETTINGS-*` 0 件。
config.json には `// User settings belong in settings.json.` が書かれていた。
つまり copilot は起動時に config.json の `hooks` を settings.json へ**移送し、既存の `hooks` キーを置き換える**。

`copilot help config` は今も `hooks` を config.json に書くよう案内しているので、
**ドキュメントに従ったユーザーは CommandMate の hooks を丸ごと失う**（イベントも Auto-Yes も無音で止まる）。

**対応**: 書き込み前に config.json を読み、`hooks` キーがあれば **settings.json を書かずに素の `gh copilot` で起動**し、
`copilot-hook-config-json-shadows-settings` を warn に出す。

- 「警告して settings.json に fold する」は採らなかった。**fold しても copilot が起動時に消す**ので、
  ユーザーのファイルを触るコストだけが残る（上の実測がそれを示している）。
- copilot 自身の移送でキーは消えるため、**この拒否は 1 回の起動で自然に解ける**（自己修復）。
- config.json は**厳密な JSON ではない**（先頭 2 行が `//` コメント）。実ファイルは `JSON.parse` が 0 文字目で落ちる。
  検出はコメントを除去してから解析し、それでも解析できなければ `unreadable` として**注入は続行**する（fail-open）。

### 7.2 ポートと relay パスが「最後に起動したサーバ」に固定される

**実測**: port 3011 の開発サーバが copilot を起動した結果、
マシン上の全 copilot セッションの宛先が 3011 に書き換わった（バックアップから復元）。
relay も `process.cwd()` 由来の絶対パスなので、その checkout を消すとイベントが全滅する。

**対応**（§10.8 の決定に従う）:

| 値 | 扱い | 理由 |
|---|---|---|
| **port** | `CM_HOOK_PORT` で起動 env に載せる。hook 冒頭で `case "$CM_HOOK_PORT" in ''\|*[!0-9]*) … exit 0;; esac` | セッションごとに正しい宛先になる唯一の値 |
| **scheme / host** | 生成時の定数のまま（`http://127.0.0.1:`） | `curlArgumentPreamble` は**宛先を見ずに** `Authorization: Bearer` を付ける。宛先が定数であることがトークン漏洩の防波堤（§10.7） |
| **relay の絶対パス** | 生成時の literal のまま。ただし `[ -x '<path>' ]` を**発火時**に見て、無ければ inline `curl` へ落ちる | env で運ぶと「hook のたびに実行するプログラム」を env に委譲することになる（§10.8 決定 2） |

**`${VAR:-既定}` の綴りは使わない。** 未設定時に黙って別の宛先へ落ちるため、未設定なら**発火しない**（§10.8 決定 3）。
これは `tests/unit/hooks/sources/copilot-hook-settings-1904.test.ts` が
`${CM_HOOK_PORT:-` の出現そのものを赤にして固定している。

### 7.3 4xx のボディが裁定として copilot に渡る

`PreToolUse` の生成コマンドは `out=$(curl …)` の標準出力をそのまま裁定として印字するが `-f` が無かったため、
`{"error":"cwd rejected: …"}` のような**受け口のエラーメッセージが copilot の verdict パーサに渡っていた**。

**対応**: `curl` の引数を `-fsS` にし（relay スクリプトと同じ）、非 2xx では `out` を空にして `{}` を印字する。
併せて **失敗を無音にしない**: `cmate-copilot-agent-hooks: permission_request_failed rc=22` のような
理由コード 1 行を stderr に出す。観測イベント側の inline `curl` も `|| true` をやめて
`agent_event_post_failed rc=<n>` を出す。

### 7.4 settings.json の書き込み規約（S16）

`commandmate start --issue N --auto-port` による複数サーバ同時稼働は公式サポートなので、
このファイルには**複数プロセスが書く**。

- **temp + `rename`** の原子的置換にした（`writeFileSync` は truncate してから書くので、
  途中で落ちるとユーザーの settings.json が切り詰められる）。
- 同一ディレクトリの `.cmate.lock` を `O_EXCL` で取り、**取れなければ書かずに hooks なしで起動**する。
  10 秒より古いロックは落ちたプロセスの残骸として奪う。
- 書き換える場合のみ**直前の内容を 1 世代** `settings.json.cmate-backup` に残す。
- #1904 でファイルの内容がサーバ非依存になったため、**再起動しても普通はバイト列が変わらない**。
  変わらないときは書かずに返す（ユーザーのファイルの mtime も触らない）。

### 7.5 積み残し

- **`CM_HOOK_*` を子プロセス環境から除去する**という §10.7 / S8 後半は本 Issue の scope 外
  （`src/lib/security/env-sanitizer.ts`）。`COMMANDMATE_HOOK_ENV_VARS`
  （`src/lib/hooks/sources/launch-command.ts`）に一覧を置いたので、sanitizer 側はこれを import すればよい。
- **`tests/setup.ts` に `COPILOT_HOME` の既定が無い。** `CODEX_HOME` と同じ理由（既定値こそが危険）で
  1 行足すべきだが、`tests/setup.ts` は本 Issue の scope 外。現状 copilot の launch を実行するテストは
  すべて自前で `COPILOT_HOME` か `HOME` を stub している（実測）。
