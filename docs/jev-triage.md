# Jev による Issue の棚卸し（優先度・担当モデルの下書き）

Jev は TypeSafe の System One モデル。状態（テキストか JSON）と型付きの質問を送ると、文章ではなく構造化された答えを返す。
Issue の優先度と、1-2b の担当（antigravity / sonnet / opus）の**下書き**に使う。裁定ではない。

- 公式: https://docs.typesafe.ai/introduction ／ Quick Start ／ 索引 https://docs.typesafe.ai/llms.txt
- 鍵: `.env` の `JEV_API_KEY`（画面・ログ・Issue に出さない）。送るのは公開リポジトリの Issue 本文だけにする

## API

`POST https://api.typesafe.ai/v1/systemone`、`Authorization: Bearer <鍵>`、`Content-Type: application/json`。

```json
{ "state": "<Issue のタイトル・ラベル・本文>", "model": "jev-latest",
  "questions": { "<自由な ID>": { "type": "choice|score|noul", "instructions": "...", "criteria": {} } } }
```

| type | criteria | 返り値 |
|---|---|---|
| choice | 選択肢名 → 説明（最大 255） | `choice` / `probabilities` / `confidence` |
| score | ルーブリックの配列（段階は 0 始まり） | `score`（段階ごとの確率 `probabilities` から出る値。公式の例では 0.67）/ `confidence` |
| noul | 無し（instructions に「〜である」と書く） | `noul`（0〜1、真である確からしさ） |

質問は互いに独立に評価される。1 問に 1 つのことだけ聞き、合算は自分のコードでやる。

## 実行

```bash
node scripts/orchestrate/jev-triage.mjs --skip 3508,3055,2657 --out workspace/orchestration/runs/$DATE/jev-out.json
```

質問は 4 つ: `model`（担当）・`impact`（影響度 0〜2）・`ready`（原因と修正箇所が本文で確定しているか）・`urgent`（放置すると誤動作が続くか）。
`model` の選択肢の説明は 1-2b の難易度表の書き写し。表を変えたらスクリプトの `questions` も合わせる。

## 読み方の注意（2026-10-17 の初回で分かったこと）

- Jev が見るのは **Issue 本文だけ**。コードも、コメントも見ない。コメントで「環境要因」と決着した Issue（#3717〜#3719）も高く出る。**コメントとコードで裏を取ってから使う**
- `modelConf` が低い（0.5 未満）担当は当てにならない。1-2b の「迷ったら opus」に従う
- `impact` は自動起票の文言に引きずられる。metrics 系の複雑度・肥大化は低く、計測の誤報は高く出やすい
- `ready` が低い Issue は「原因の調査が先」の合図。担当より先に調査の段を置く
- 利用者側の作業が先に要る Issue（専用ユーザー、実機）は点数が高くても着手の候補にしない
