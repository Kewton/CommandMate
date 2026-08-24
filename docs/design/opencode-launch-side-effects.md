# opencode 起動時の副作用 — 実測と落とし所（Issue #1908）

対象: opencode 1.18.21 / macOS (Darwin 25.6.0) / CommandMate `fix/1908-opencode-launch-side-effects`
計測日: 2026-08-22
計測環境: 私設 tmux ソケット（`tmux -L cm1908`）＋使い捨て `HOME`＋pane 80x200（`OPENCODE_PANE_HEIGHT`）

Issue #1908 は「opencode を起動すると (1) worktree ルートに untracked な `opencode.json`
が生成される (2) 固定 15 秒の sleep で初回 `send` の HTTP 呼び出しが 15 秒以上保持される」
という 2 件。どちらも**実測してから**落とし所を決めた。以下はその実測結果と、
実装がそれをどう使っているか。

---

## 1. opencode の設定解決順（`opencode debug config` 実測）

使い捨て `HOME` で各層に `username` だけ違う設定を置き、`opencode debug config` の
解決結果を読んだ。

| # | 置いた層 | 読まれたか | 備考 |
|---|---------|-----------|------|
| 1 | 何も無し | — | 既定値のみ |
| 2 | `<project>/opencode.json` | **読まれる** | |
| 3 | `<project>/opencode.jsonc` | **読まれる** | |
| 4 | 2 と 3 の両方 | 両方読まれ、キー衝突は **`.jsonc` が勝つ** | |
| 5 | `<project>/.opencode/opencode.json` | **読まれる** | |
| 6 | `$XDG_CONFIG_HOME/opencode/opencode.json` | **読まれる** | `opencode debug paths` の `config` |
| 7 | 同 `.jsonc` | **読まれる** | |
| 8 | `$OPENCODE_CONFIG` | **読まれる** | |
| 9 | 8 ＋ 2 | キー衝突は **`<project>/opencode.json` が勝つ** | |
| 10 | 6 ＋ 2 | キー衝突は **`<project>/opencode.json` が勝つ** | |

`provider` マップは**全層でマージ**される（4・9・10 いずれも両方の provider キーが
解決結果に残る）。したがって生成物は「足すだけ」に見えるが、**同じ provider キーを
利用者が別の層で定義していると、worktree ルートのファイルが黙って勝つ**。
`$OPENCODE_CONFIG`（利用者が明示的に選んだ設定ファイル）に対しても勝つ。

### ここから決めたこと

- **既定では書かない。** これが Issue の本体（利用者の git リポジトリに勝手に
  ファイルを作る）で、書き先を変えるだけでは驚きの場所が変わるだけになる。
- opt-in は `CM_OPENCODE_LOCAL_PROVIDER_CONFIG`:
  - 未設定 / `off` / `0` / `false` / `none` / 未知の値 → **書かない**
  - `worktree`（`project`）→ 従来どおり `<worktree>/opencode.json`
  - `global`（`user`）→ `$XDG_CONFIG_HOME/opencode/opencode.json`（マシン 1 本）
- **opt-in していても、利用者が設定を持っていれば書かない。** スキップ判定は
  `$OPENCODE_CONFIG` が設定済み → worktree の `opencode.json` / `opencode.jsonc` /
  `.opencode/opencode.json(c)` → グローバル設定（`.json` / `.jsonc`）の順。
  `worktree` モードではグローバル層も見る（上表 9・10 のとおり worktree ファイルが
  両方に勝つため）。`global` モードでは worktree 層は見ない（1 リポジトリの設定は
  マシンの設定について何も言っていない）。
- **既存の生成物は消さない・触らない。** 旧版が書いたファイルはそのまま読まれるので、
  アップグレードで provider 一覧が消えることはない。掃除は利用者の判断。

### Issue 本文からの意図的な逸脱

- 本文の修正案 1 は「生成先を `$XDG_CONFIG_HOME` / `OPENCODE_CONFIG` に変更」だが、
  **`OPENCODE_CONFIG` は書き先にしない**。上表 9 のとおり worktree ファイルはこれに
  勝つので、この変数が設定されていることは「利用者が設定を所有している」という
  肯定的証拠として扱い、生成を止める側に使う。
- 本文は「最低でも `.gitignore` を見る」「書く場合は `.git/info/exclude` への追記」
  を挙げるが、**どちらも実装していない**。`.git/info/exclude` への追記は「利用者の
  リポジトリに黙って書く」という本 Issue の症状そのものであり、env var による
  opt-in を明示的な同意として扱う方が筋が良い。`worktree` モードは untracked な
  ファイルを残す旨をドキュメントに明記する。

---

## 2. 起動タイムライン（`capture-pane` 実測）

`tmux -L cm1908` で pane を作り、launch キーストロークから 250〜550ms ごとに
`capture-pane -p -S -50 -E -` を採取した。

| t (s) | pane の内容 |
|-------|-------------|
| 0.21 / 0.89 | シェル（`❯ ` プロンプト＋echo された launch コマンド） |
| 1.58 / 2.96 | 画面クリア済み・200 行すべて空 |
| 2.88（provider 無し fresh HOME）/ 3.64（24 モデルの Ollama 設定あり） | バナー＋composer（`┃  Ask anything...`）＋フッタ |

並列 6 エージェントが動いている負荷下では、同じ起動が **24.1 秒**かかった。
つまり `OPENCODE_INIT_WAIT_MS = 15000` は**両方向に外れている**（無負荷では
約 11 秒の無駄、負荷下では足りない）。コメントにある「Ollama の GPU ロード」は
起動と無関係（最初のリクエストまでモデルは読まれない）。

### #1907（copilot）の教訓は opencode に当てはまるか → **当てはまらない**

copilot では盲目 sleep がシェルのプロンプトを最初の poll から隠していただけで、
sleep を消すと `^[>❯]\s` が starship / pure / agnoster のプロンプトに当たって
偽 ready になった。opencode でも**同じシェルフレームが最初の約 0.9 秒表示される**
（上表）。しかし readiness に使う `OPENCODE_IDLE_COMPOSER_PATTERN`（#1883）は
**入力箱の gutter（`┃`/`│`）直後**のプレースホルダ行を要求するため、シェルフレームには
当たらない。実測フレームを実際にこのパターンへ通して確認した（t=0.21 / 0.89 / 1.58 /
2.96 はすべて false、composer 出現以降は true）。再実装はしていない。

### `Connect a provider` オーバーレイ

Issue 本文は「fresh HOME では `Connect a provider` オーバーレイが出る（1.18.20）」
とするが、**1.18.21 の fresh HOME では自動表示されなかった**（代わりに
`● Tip Run /connect to add an AI provider and start coding` が出る）。ただし
`/connect` を送って実際に出したフレームでは、**composer が画面から消える**
（`Ask anything` の出現回数が 0）。オーバーレイに parked した pane を composer だけで
待つと 30 秒窓を丸ごと空費するので、`OPENCODE_SELECTION_LIST_PATTERN` も ready の
肯定的証拠として受け取る。**応答はしない** — このオーバーレイの選択肢はどれも
利用者の設定に provider 資格情報を書くため、codex の hooks-review ダイアログに対する
#1760 の判断（利用者の設定を書き換える答えは CommandMate が代行しない）と同じ線を引く。

---

## 3. HTTP サーバと composer の前後関係

`attachOpencodeEventStream`（#1763）は health check を 1 回だけ行い、失敗したら
構造化イベント無しで縮退する。旧実装はこれを「15 秒経ったから」呼んでいたので、
readiness を composer に変えると**サーバがまだ立っていない時点で probe してしまう**
のではないか、という懸念がある。実測したところ逆だった。

| run | `/global/health` が healthy を返した時刻 | composer 描画 | 差 |
|-----|------------------------------------------|---------------|-----|
| A | 12.17 s | 14.00 s | 1.83 s |
| B | 22.80 s | 24.11 s | 1.31 s |
| C | 9.38 s | 11.21 s | 1.83 s |

（この 3 本は負荷の高い時間帯に採ったため絶対値が大きい。順序が論点。）

サーバは常に composer より先に立つ。構造的にもそうで、TUI は自分のサーバの
クライアントである（#1758 §5.1.2）。したがって composer を待って
`attachOpencodeEventStream` を呼ぶ方が、固定 15 秒より**強い**前提になる。
run B は 15 秒時点で probe しても何も無く、旧実装ならそのセッションは
構造化イベントを丸ごと落としていた。

---

## 4. 実装

| 何 | どこ |
|----|------|
| opt-in の解決 / スキップ判定 / 生成 | `src/lib/cli-tools/opencode-config.ts`（`resolveOpencodeConfigMode` / `findOwnedOpencodeConfig` / `opencodeGlobalConfigDir` / `ensureOpencodeConfig`） |
| readiness ポーリング | `src/lib/cli-tools/opencode.ts`（`OpenCodeTool.waitForReady`、`OPENCODE_READY_POLL_INTERVAL_MS` = 500 / `OPENCODE_READY_MAX_ATTEMPTS` = 60） |
| 実測フレーム | `tests/fixtures/opencode-launch-boot-11821.ts` |
| テスト | `tests/unit/cli-tools/opencode-config-optin-1908.test.ts` / `tests/unit/cli-tools/opencode-launch-readiness-1908.test.ts` |

`XDG_CONFIG_HOME` は `resolveSafeDirectory`（#1774）を通す。`global` モードは
そのディレクトリに対して recursive `mkdir` を行うため、`/proc` 配下を指されると
Linux では返ってこない。
