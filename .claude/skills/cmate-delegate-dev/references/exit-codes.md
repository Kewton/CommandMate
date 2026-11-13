# exit code 表と、それぞれで何をするか

[SKILL.md](../SKILL.md) 第4.4節の完全版である。

## 1. 一次ソース

CommandMate CLI 自身が持っている表が正本である。**この文書を信じる前にそちらを見ること。**

```bash
commandmatedev docs --section agent-operations   # 末尾の "All Exit Codes"
```

下の表は **commandmate 0.31.3 で実測**したものである（測り方は第4節）。

## 2. `wait` / `ask` の exit code

| code | 名前 | 何が起きたか | 委任元がすること |
|---|---|---|---|
| `0` | `SUCCESS` | 相手が 1 ターンを終えてコンポーザーへ戻った | `capture` して要約する。**「頼んだ作業が終わった」ではない**（第3節） |
| `1` | `DEPENDENCY_ERROR` | サーバが起動していない | `commandmatedev status` の出力を人に見せる。委任は始まってすらいない |
| `2` | `CONFIG_ERROR` | 引数が不正（未知の agent、duration の書式など） | コマンドを直す。**宛先が居ないことではない** |
| `10` | `PROMPT_DETECTED` | 相手が確認を待っている | **答えない。** prompt 本文と選択肢を人へ写して止まる（SKILL.md 第5節） |
| `11` | `UPSTREAM_FAULT` | ターンが走っていない。**`id=context-limit`（`--json` と stderr）のときは、相手の文脈が上限で、依頼は何もされていない** | 既定は「ターンは走っていない、送り直す」。`id=context-limit` のときは**待っても送り直しても直らない**。`commandmatedev instances <worktree-id> kill <instance-id>` で新しいセッションにしてから送る（第2.1節） |
| `20` | `VERIFY_FAILED` | 検証ゲートが落ちた | **`--verify` を付けたときにだけ出る。** この Skill は付けない（`cmate-orchestrate` の領分） |
| `21` | `NOT_STARTED` | 宛先のセッションが起動していない／作業証跡ゼロ | `send` を実際に打ったか確認する。打っていて 21 なら相手が落ちている |
| `30` | `NO_ACTIVE_SESSIONS` | `interrupt` の対象が居ない | この Skill は `interrupt` を使わないので出ない |
| `99` | `UNEXPECTED_ERROR` | **worktree-id / instance-id が解決できない**、または裁定に到達しなかった | 宛先解決（SKILL.md 第2節）へ戻り、候補を人に見せる |
| `124` | `TIMEOUT` | `--timeout` / `--stall-timeout` を超えた | `capture` して生死を人に見せる。**同じ依頼を再送しない**（第5節） |

> **`99` を「壊れた」と読まない。** 実測では、存在しない worktree-id、存在しない instance-id、
> どちらも `Error: Resource not found. Check the worktree ID.` と **exit 99** になる。
> Issue #241 の起案時点では宛先解決の失敗を `2` と想定していたが、
> **0.31.3 の実測値は `99` である。** `2` は引数の書式エラーであって、宛先の不在ではない。

### 2.1 `11` と `id=context-limit`（文脈の上限）

Command Code の管理セッションを長く使い回すと、依頼が
`⚠ Error: 400 This model's maximum context length is 1048576 tokens. However, you requested ...`
で**何もされずに**終わる。ターン自体は終わるので、古い `wait` / `ask` は `0` を返し、
通常の完了と区別できなかった（CommandMate#3011）。

- 対応した CLI の `ask` は、これを既存の `11`（`UPSTREAM_FAULT`）で返し、`--json` と stderr に
  `id=context-limit` を出す。`ask.sh` は `11` を素通しにする。
- **`id=context-limit` の `11` は、他の `11` と対処が違う。** 他の `11` は「ターンが走っていない、
  送り直せ」だが、文脈の上限は待っても送り直しても直らない。
  `commandmatedev instances <worktree-id> kill <instance-id>` で新しいセッションにしてから送る。

対応していない版の CLI 向けの保険として、`ask.sh` は上流が `0` を返したときに限り、
返答の**末尾 20 行（空行を除く）**を見て、`This model's maximum context length is N tokens` が
**行頭から**（インデントと `⚠` `⎿` `●` などの飾り、`API Error:` / `Error:`、HTTP status だけを許す）
始まる行として出ていれば `11` に読み替え、stderr に `id=context-limit` と kill コマンドの案内を出す。
返答の中で**引用されているだけ**の語は当たらない。読み替えるのは `0` だけで、`10` / `124` はそのまま返る。
返答本文は stdout にそのまま出す。Claude の `Prompt is too long` や OpenAI 系の
`context_length_exceeded` は別 Issue で、この検出には含めない。

複数の worktree-id を 1 回の `wait` に渡した場合、返るのは**最も優先度の高い 1 つ**である
（`10` > `20` > `21` > `124`）。この Skill は**常に 1 宛先**なので、この合成は起きない。

`send --note` が mem に断られた 50・56・52・53 は、**本文が送られていない**（SKILL.md 第8.2節）。`--note` を外して 1 回だけ送り直す。

## 3. `0` が意味しないこと

coding CLI は **1 メッセージ = 1 ターン**で動き、ターンが終わるたびに入力待ちへ戻る。
`wait` の `0` は「そのターンが終わってコンポーザーへ戻った」であって、
**頼んだ作業が完了したこと**でも、**答えが正しいこと**でもない。

したがって:

- `0` を見たら**返答本文を読む**。読まずに「完了しました」と報告しない。
- `DONE:` 行が無いのに `0` が返ることはある。相手が途中で一度手を止めただけである。
- 契約付きの裁定（ゲートを回して pass/fail を決める）が要るなら `cmate-orchestrate` へ行く。
  ここに `--verify` を足して代用しない——**裁定の証跡が残らないまま緑になる。**

## 4. `--on-prompt` と `10` の関係

`wait --help`（0.31.3）の記述:

- `agent`（既定）— *exits 10 with a prompt JSON payload on stdout*
- `human` — *keeps waiting for a human reply*

つまり **`--on-prompt human` では `10` は返らない。** 人が UI で答えるまで block し、
答えが来なければ `--timeout` で `124` になる。

この Skill の規律は「自分で答えず、人へ報告して止まる」である。
報告するには prompt を**見る**必要があり、見えるのは `agent` のほうだけである。
だから既定は `--on-prompt agent` である。

`human` を選んでよいのは、**人が CommandMate の UI を見ていて、そこで答えると決まっているとき**
だけである。そのときは `10` が来ないことを承知して待つ。

### 分類できないフレーム（`10` のもう 1 つの出方）

対話的だが解析できないフレームが **60 秒**続くと、`wait` は `{"type":"unclassified"}` を伴って
`10` を返す（CommandMate#1708）。これは prompt の JSON とは形が違うので、
**選択肢を探して見つからないことがある**。そのときは `capture --pane` で生の画面を人に見せること。
`--timeout` を 60 秒未満にすると、この滞留より先に `124` が返る。

## 5. どう測ったか

commandmate 0.31.3・macOS・サーバ稼働中。**送信を伴う分岐は測っていない**（実セッションを
動かすため）。測ったのは宛先解決の失敗と、起動していない instance への `wait` である。

```bash
commandmatedev capture   nonexistent-worktree-xyz --pane --tail 5 ; echo $?   # 99
commandmatedev instances nonexistent-worktree-xyz --json         ; echo $?   # 99
commandmatedev wait      nonexistent-worktree-xyz --timeout 3    ; echo $?   # 99
commandmatedev capture   <real-wt> --instance nope-9 --pane      ; echo $?   # 99
commandmatedev wait      <real-wt> --instance codex --timeout 5  ; echo $?   # 21
#   -> Not started: <wt> has no running codex session for instance codex (resolvedBy=primary).
```

`0` / `10` / `124` は上記の実測に含まれない。**表の根拠は
`commandmatedev docs --section agent-operations` の "All Exit Codes" と `wait --help` である。**
実測とドキュメントの区別を、この節で保っておくこと。

## 6. `ask.sh` の透過

同梱の [`../scripts/ask.sh`](../scripts/ask.sh) は **`wait` の exit code をそのまま返す**。
`capture` が失敗しても、`echo` が成功しても、返る値は `wait` のものである。
`ask` が在る環境では `ask` の exit code をそのまま返す。

例外は、`0` を `11`（`id=context-limit`）に読み替える保険の検出だけである（第2.1節）。それ以外の code は書き換えない。

これはテストで固定してある（`tests/fixtures/cmate-delegate/run_tests.sh`）。
**stdout に出るのは `capture` の squeeze 済みテキストだけ**で、
診断・prompt JSON・ラッパ自身のメッセージはすべて stderr へ出る。
そうしないと、`$(...)` で受けた返答本文にラッパの独り言が混ざる。
