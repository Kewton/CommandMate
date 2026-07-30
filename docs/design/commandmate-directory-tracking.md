# `.commandmate/` の追跡ポリシー

- **関連 Issue**: [#1540](https://github.com/Kewton/CommandMate/issues/1540)（verify.yaml）／[#1545](https://github.com/Kewton/CommandMate/issues/1545)（実行契約）
- **確認コマンド**: `./scripts/check-commandmate-tracking.sh`
- **CI ガード**: `tests/unit/config/commandmate-tracking.test.ts`

---

## 1. 方針

`.commandmate/` には **2 種類のものが混在**する。

| 種類 | 例 | Git 追跡 | 理由 |
|---|---|:---:|---|
| **設定**（人が書く宣言） | `verify.yaml`、`tasks/*.yaml` | ✅ **する** | チーム全員・全 worktree で同じ判定基準／同じ契約を共有する必要がある。レビュー対象でもある |
| **ランタイムデータ**（アプリが書く） | `attachments/`、キャッシュ類 | ❌ しない | アプリが動くたびに増え続ける生成物。`dev-reports/` と同じ扱い |

したがって `.gitignore` は **「全部除外 → 設定だけを例外にする」** という許可リスト方式で書く。
新しい設定ファイルを `.commandmate/` に追加するときは、この文書と `.gitignore` の両方を更新すること。

---

## 2. 現在の規則

```gitignore
/.commandmate/*
!/.commandmate/verify.yaml
!/.commandmate/tasks/
/.commandmate/tasks/*
!/.commandmate/tasks/*.yaml
```

読み方:

1. `/.commandmate/*` — 配下をすべて除外（既定は「追跡しない」）
2. `!/.commandmate/verify.yaml` — 検証ゲートの宣言だけ例外
3. `!/.commandmate/tasks/` — **`tasks` ディレクトリ自体**の除外を解除
4. `/.commandmate/tasks/*` — その中身は改めて全部除外
5. `!/.commandmate/tasks/*.yaml` — 契約ファイル（`.yaml`）だけ例外

---

## 3. 落とし穴：`!` を 1 行足すだけでは効かない

**サブディレクトリの中身を追跡したい場合、負パターン 1 行では追跡されない。**

```gitignore
# ❌ これは効かない
/.commandmate/*
!/.commandmate/verify.yaml
!/.commandmate/tasks/*.yaml
```

理由は git の仕様で、

> **除外されたディレクトリの中を git は走査しない。**

`/.commandmate/*` が `tasks/` ディレクトリ自体を除外するため、git は `tasks/` を開かず、
中のファイルに対する `!` パターンは**評価される機会がない**。

そのため上記 §2 の 3〜5 のように、**ディレクトリを除外解除 → 中身を再除外 → 拡張子で許可**
という 2 段構えが必要になる。

この落とし穴は #1540（verify.yaml の追跡）で一度踏んでおり、`.gitignore` 内にも注意書きがある。

---

## 4. 確認方法

### 手元で確認する

```bash
./scripts/check-commandmate-tracking.sh
```

```
commandmate config tracking (.gitignore):
  ok   .commandmate/verify.yaml               tracked (verification gates #1540)
  ok   .commandmate/tasks/build.yaml          tracked (execution contract #1545)
  ok   .commandmate/attachments/a.png         ignored (chat attachment (runtime))
  ok   .commandmate/tasks/scratch.log         ignored (log beside a contract)
  ...
OK: all check-commandmate-tracking.sh expectations hold.
```

終了コードは 0（全期待どおり）／1（1 件以上違反）／2（git リポジトリでない）。
規則を壊した場合は、正しい書き方のヒントを出して落ちる。

### 単一ファイルを調べる

```bash
git check-ignore -v --no-index .commandmate/tasks/mytask.yaml
```

判定は**終了コード**で読むこと（`0` = 無視される、`1` = 追跡できる）。

### 判定を誤りやすい点（2 つ）

1. **`-v` の出力有無で判断しない。**
   `-v` は否定パターンにマッチした場合も行を表示するため、「出力があった＝無視される」と
   読むと**追跡できるファイルを無視と誤判定**する。

2. **`--no-index` を省略しない。**
   `git check-ignore` は既定で index を参照し、**すでに追跡済みのファイルはルールに関係なく
   「無視されない」と報告する**。`verify.yaml` のようにコミット済みのファイルを既定のまま
   調べると、`!` 行を削除しても「追跡できる」と出てしまい、規則の破壊を検出できない。

   > この 2 点目は実際にこのリポジトリのテストで空振り（vacuous green）を生んだ。
   > `!/.commandmate/verify.yaml` を削除する変異を注入してもテストが緑のままだったため発覚し、
   > `--no-index` を付けて修正した。

---

## 5. 新しい設定ファイルを追加するとき

1. `.gitignore` に例外を追加する（サブディレクトリなら §3 の 2 段構え）
2. `scripts/check-commandmate-tracking.sh` の `expect` 行に**追跡されるべき例と、
   隣に置かれうる無視されるべき例の両方**を追加する
3. `tests/unit/config/commandmate-tracking.test.ts` の一覧にも同じ 2 例を追加する
4. **変異注入で確認する** — 追加した例外行を消してテストが実際に赤くなること。
   規則を書いただけでは「たまたま通っている」と区別できない
5. 本書の §1 の表を更新する
