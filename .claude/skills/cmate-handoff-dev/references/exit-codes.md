# exit code の読み方

`commandmatedev mem` の exit code と、この Skill での扱いである（`commandmatedev mem --help` の Exit codes）。
判定は出力の文字列ではなく exit code で行う。

| exit | 名前 | この Skill での扱い |
|---|---|---|
| 0 | 成功（`--key` の再送で既存を返したときも `replayed`） | 続ける |
| 1 | サーバが動いていない | mem を使わずに続ける |
| 2 | 入力の不正（`invalid_close_when`・`secret_like`・`too_long`・`absolute_path`・`target_required` …）。何も保存していない | 文を直して 1 回だけ再試行する。直せなければ書かずに続ける。**断られた原文を貼り直して秘密を広げない** |
| 50 | `disabled`：mode が `off` か `derived`。何も保存していない | **正常。** mem を使わずに続ける。失敗として報告しない |
| 51 | `version_conflict`：今の項目が返る | 返った項目を読み直し、まだ要るなら新しい版で 1 回だけ |
| 52 | 対象不明（未登録・項目／instance が無い・ブランチを読めない） | mem を使わずに続ける |
| 53 | 曖昧（root の設定が違う等） | mem を使わずに続ける。人へ「mem の設定が root で食い違っている」と 1 行報告 |
| 54 | 同じ `--key` で別の中身 | 鍵の付け方の誤り。新しい項目として足さない（既存の項目を読む） |
| 55 | `not_owner`／`state_forbids` | 他人の項目・`recorded` の decision。**触らない。** 人へ渡す |
| 56 | 件数の上限 | 足さない。自分の古い項目を閉じるか、人へ報告 |
| 57 | `check --suggest`：促しがある（`--quiet` では返らない） | 促しを読んで自分の項目を見直す。失敗ではない |
| 99 | それ以外 | mem を使わずに続ける |

## 入口の判定と exit code

SKILL.md 第 3.1 節の判定は、`commandmatedev mem mode --json` が **exit 0 で、かつ `"mode": "on"` を返した**ときだけ
「使う」にする。`mem` を持たない古い CLI は未知のコマンドとして非 0 で終わるので、判定は「使わない」に落ちる。
それは正常であり、この Skill の手順を 1 行も実行しないことが正しい動作である。

`brief` は mode が `off` のとき何も出さずに exit 50 で終わる。これも正常である。
