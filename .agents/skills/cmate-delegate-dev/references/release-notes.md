# release notes

## 0.3.0 — 委任の目的を mem に残す（CommandMate#4228 の契約 2）

`send --reply-to` に `--note` を足す手順を第8.2節に加えた。手順の頭で
`commandmatedev mem mode --json` の `"mode"` が `"on"` と確かめたときだけ付ける。`off`・`derived`・
`mem` が無い古い CLI・exit 非 0 は「使わない」で、既存の `ask`／`send`／relay の経路は変わらない。
`--note` を付けて 50 などが返ったら本文は送られていないので、外して 1 回だけ送り直す。
`ask --async` では mem に書かない。`compatibility.commandmate` は `>=0.11.0 <1.0.0` のまま
（mem は実行時に確かめる）。

fixture の stub は、実物（`memMode`）に合わせて off でも exit 0・`"mode": "off"` を返す。判定は
`grep -q '"mode": "on"'` なので、off は「使わない」のまま変わらない。`--note` が 50 で断られたときの
再送（外して 1 回・本文の配送は 1）の対照を足した。
受け付けられた `--note` は本文を配送する（呼び出し 1・配送 1・再送なし）対照も、stub が配送を記録する形に直した。

UAT の差し戻し（mode on でも `--note` を省く Agent がいた）を直した。mode が `on` のときは
`send --reply-to` に `--note` を**必ず**付ける（「任意」「足してよい」を外した）。`mem mode` の確認は送信より前。
mode が `on` で返答を後で受け取るつもりの委任は `ask --async` ではなく `send --reply-to self --note` を使う
（`ask --async` は `on` でないとき、または返答の記録が要らないときだけ）。

## 0.2.0 — 文脈の上限で止まった依頼を、完了ではなく失敗として返す（CommandMate#3011）

**何が起きたか。** 管理（Command Code）のセッションを長く使い続けたら、依頼が
`400 This model's maximum context length is 1048576 tokens. However, you requested 1070861 tokens`
で何もされずに終わった。ターンは終わるので `wait` / `ask` は `0` を返し、
通常の完了と区別がつかなかった。

**だからこう変えた。** CommandMate の CLI 側で `ask` が文脈の上限を既存の `11`（`UPSTREAM_FAULT`）で返し、
`--json` と stderr に `id=context-limit` を出す（CommandMate 側で実装）。新しい exit code は作らない。
この Skill は `ask.sh` が `11` を素通しにし、`id=context-limit` のときは「待っても送り直しても直らない。
`commandmatedev instances <wt> kill <instance>` で新しいセッションにして送り直す」と表に載せた。
CLI が未対応の版向けの保険として、`scripts/ask.sh` は上流が `0` を返したときに限り、返答の末尾 20 行を見て、
`⚠ Error: 400 This model's maximum context length is N tokens ...` がエラーとして行頭に出ていれば
`11` を返し、stderr に `id=context-limit` と kill の案内を出す。引用されているだけの語は当たらない。
Claude の `Prompt is too long` と OpenAI 系の `context_length_exceeded` は別 Issue で、検出しない。
定義は [exit-codes.md](./exit-codes.md) 第2.1節。

**送る前に文脈の量を測って勧める提案は実装していない。** 上流 CLI に、相手の文脈の量を読む
手段が無い。文脈の使用量（`sessionContext`）は opencode でしか取れず、Command Code では
取れない（CommandMate#3011 のやり取りで確認）。手段ができたら別 Issue で扱う。
