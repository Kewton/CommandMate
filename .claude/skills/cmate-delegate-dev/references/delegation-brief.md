# 依頼文の定型（delegation brief）

[SKILL.md](../SKILL.md) 第3節の正本である。**相手はあなたの会話を見ていない**という一点から
すべての欄が導かれている。

## 1. 必須 5 欄

| key | ja ラベル | en ラベル | 無いと起きること |
|---|---|---|---|
| `purpose` | 目的 | Purpose | 言われたことだけが返り、判断に要る答えが返らない |
| `target` | 対象 | Target | 正しい答えが間違った対象について返る |
| `output` | 出力の形 | Expected output | 返答が長文になり、要約が推測混じりになる |
| `forbidden` | 触ってはいけないもの | Do not touch | 頼んでいない変更が相手の worktree に残る |
| `closing` | 締め方 | How to close | 返答の終端が判らず、途中の画面を完成品として読む |

`context`（前提 / Context you do not have）は 6 番目の欄で、**必須ではないが既定で書く**。
「相手が知らないこと」がゼロである委任はほとんど無い。

**5 欄のうち 1 つでも埋められないなら送らない。** 埋められないのは相手の問題ではなく、
**依頼する側がまだ何を頼みたいか決めていない**ということである。

## 2. テンプレート（ja）

<!-- BEGIN TEMPLATE ja -->
```text
【依頼】<1行で何をしてほしいか>

■ 目的
<何のために、何を判断したいのか。「レビューして」ではなく「merge してよいかを決めたい」>

■ 対象
- worktree: <worktree-id>（path: <path>）
- branch: <branch>
- 対象ファイル / 範囲: <paths または commit range>

■ 出力の形
<箇条書き / diff / 判定1行 / 表 のどれか。件数の上限も書く>

■ 触ってはいけないもの
- <変更禁止のパス>
- push / PR 作成 / merge は行わないでください
- 他の branch へは切り替えないでください

■ 前提（あなたは知らないはずのこと）
- <自分だけが知っている事情。base branch、直前に入った変更、既知の失敗など>

■ 締め方
最後に `DONE:` で始まる1行で結論を要約してください。
判断できない場合は `DONE: 判断不能 — <理由>` と書いてください。
```
<!-- END TEMPLATE ja -->

## 3. テンプレート（en）

<!-- BEGIN TEMPLATE en -->
```text
[Request] <one line: what you want done>

# Purpose
<what decision this feeds. Not "review it" but "decide whether this can be merged">

# Target
- worktree: <worktree-id> (path: <path>)
- branch: <branch>
- files / range: <paths or commit range>

# Expected output
<bullets / diff / a single verdict line / a table. State the cap on how many>

# Do not touch
- <paths that must not change>
- Do not push, open a PR, or merge
- Do not switch to another branch

# Context you do not have
<what only the requester knows: the base branch, a change that just landed, a known failure>

# How to close
End with a single line starting with `DONE:` that summarises your conclusion.
If you cannot decide, write `DONE: undecided - <reason>`.
```
<!-- END TEMPLATE en -->

## 4. なぜ `DONE:` なのか

v0.1 の回収経路は `capture --pane --tail <n>` であり、読めるのは**画面の末尾**である
（[SKILL.md](../SKILL.md) 第7節）。終端を示す固定の文字列が無いと、
**まだ書いている途中の画面**と**書き終わった画面**が区別できない。

`DONE:` は次の 3 つを同時に満たすので選んである。

1. **末尾に必ず来る。** tail で読める。
2. **1 行で完結する。** 折り返しても行頭の `DONE:` は残る。
3. **判断不能を表現できる。** `DONE: 判断不能 — <理由>` が返れば、
   「答えなかった」ではなく「答えられないと答えた」と読める。

`DONE:` 行が無いまま `wait` が exit 0 で返ることはある——相手が 1 ターンを終えて
コンポーザーへ戻っただけの場合である。そのときは**返答が途中である可能性**を報告に書くこと。

## 5. 語彙を揃える先（未着地）

[CommandMate#2376](https://github.com/Kewton/CommandMate/issues/2376) は GUI から委任文を
1 クリックで挿入する `buildDelegationBrief` を持つ予定である。**本 skill を書いた時点で
その実装は存在せず、文面は一度も突き合わせていない。**

そこで、突き合わせが可能になるように、この定型は**第1節の `key` 列**を正本として置く。
#2376 が着地したら:

1. 生成された文面の見出しを第1節の `key` へ写像する。
2. 欄が増えていたらこの表へ足す。**減っていたら減らさない**——
   減らせるのは「無くても委任が成立する」と実測できたときだけである。
3. 食い違ったほうを直し、この package の `version` を上げる。

**それまでは、この文書が正本である。** #2376 の文面を推測して先回りで合わせない。
