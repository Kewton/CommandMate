# kind と close_when の形

SKILL.md 第 4 節の表の詳細である。ここにあるのは**形**の要件だけで、何を書くかは
SKILL.md 第 1 節の目的で決める。値は CommandMate の `commandmatedev mem --help` と各サブコマンドの
`--help` に従う（CommandMate#4221・#4222 で入った公開面）。食い違ったら CLI の `--help` を正とする。

## 1. close_when の文法

```
manual
replaced                                   (now だけ)
issue:[host/owner/repo]#N
pr:[host/owner/repo]#N[?state=merged|closed]
branch:<name>?merged=<ref>[&scope=local|remote]
branch:<name>?deleted
relay:<id>
worktree:<id>
session:task:<id> | session:verify:<run id> | session:schedule:<execution log id>
at:<ISO 8601 with offset>
```

省略したとき: `now` は `replaced`、`note` は `manual`、`decision` は「promote まで」。
`waiting`・`next`・`external` は省略できない。

条件は**読むとき**（`list`・`check`・brief）に評価され、常駐では評価しない。評価が `unknown`
（オフライン・404・権限・時間切れ・照会の上限）のときは何も閉じない。promote の前に成立した
decision は「未反映」として開いたまま残る。

## 2. kind ごとに許される条件の型

| kind | manual | replaced | issue | pr | branch | relay | worktree | session | at |
|---|---|---|---|---|---|---|---|---|---|
| `now` | — | ✓（既定） | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `waiting` | — | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `next` | ✓ | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `external` | ✓ | — | ✓ | ✓ | ✓ | — | — | — | ✓ |
| `decision` | — | — | ✓ | ✓ | ✓ | — | — | — | ✓ |
| `note` | ✓（既定） | — | — | — | — | — | — | — | ✓ |

許されない組み合わせは exit 2（`invalid_close_when`）で、何も保存されない。

- `waiting` に `manual` は無い。待つ相手を型で書けないなら、それは「待ち」ではなく `next` である
  （無人のときの人への質問は SKILL.md 第 6 節のとおり `next` ＋ `manual` ＋ `--evidence`）
- 委任の返答待ち（`relay:<id>`）の `waiting` は `cmate-delegate-dev` の `send --note` が作る。この Skill では足さない

## 3. 長さと件数

| 欄 | 上限 |
|---|---|
| `now` の文 | 100 文字 |
| `--text` | 1000 文字 |
| `--quote` | 500 文字 |
| `--evidence` | 1 項目に 5 個、各 300 文字 |
| `--promote-to` | 300 文字 |
| `--reason` | 300 文字 |
| `--key` | 128 文字 |

長さを超えたら（exit 2 の `too_long`）、詳細を Issue や文書へ移して参照だけを残す。文を削って詰め込まない。

ブランチの open の項目の数には上限がある（超えると exit 56、何も保存されない）。

| kind | 警告 | 上限 |
|---|---|---|
| `waiting`・`next`・`external` | 10 | 30 |
| `note` | 20 | 50 |
| `decision` | 20 | なし |

上限に当たったら足さない。自分の古い項目を閉じるか、人へ報告する。

## 4. evidence の形

`path:<rel>[:<line>]`・`commit:<sha>`・`issue:#N`・`pr:#N`・`url:https://…`。
`path:` は作業木の中の相対パスだけ（絶対パス・作業木の外・symlink・秘密の置き場は exit 2）。

## 5. key の付け方

`cmate-handoff:<kind>:<話題の短い名前>`。同じ鍵と同じ中身の再送は最初の項目を返す（exit 0、`replayed`）。
同じ鍵で別の中身なら exit 54 で、それは鍵の付け方の誤りである。新しい項目として足さずに、既存の項目を読む。
