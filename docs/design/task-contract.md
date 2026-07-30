# 仕様: `.commandmate/tasks/<name>.yaml` v1（実行契約 / Task Contract）

- **Issue**: [#1545](https://github.com/Kewton/CommandMate/issues/1545)（親 [#1539](https://github.com/Kewton/CommandMate/issues/1539) / Phase 2-1）
- **ステータス**: Accepted
- **対象 version**: `1`
- **実装**: `src/lib/tasks/contract-parser.ts` / `src/lib/tasks/contract-message.ts`
- **テスト**: `tests/unit/tasks/`

本書は**実行契約ファイル**の正準仕様である。契約は「このタスクで何を達成するのか」「どのパスを
変更してよいのか」「何が満たされたら完了なのか」を **送信前に宣言** し、`send → wait → verify`
のパイプラインがその宣言を参照できるようにする。

> **本フェーズの範囲は「宣言」であって「強制」ではない。**
> `scope` のゲート化は Phase 2-2（#1546）、`autoYes` の enforcement は Phase 2-3（#1547）。
> v1 のパーサは両フィールドを**検証して保持するだけ**で、実行時の挙動は変えない。

---

## 1. 全体像

```yaml
# .commandmate/tasks/verify-config-loader.yaml — v1
version: 1
title: "verify-config ローダの実装"
goal: |
  .commandmate/verify.yaml を読み込む型安全なローダを実装する。
  受入条件: Issue #NNN の受入条件チェックリストをすべて満たすこと。
scope:
  allow:
    - "src/lib/verification/**"
    - "tests/unit/verification/**"
    - "docs/module-reference.md"
  deny: []
verify:
  gates: [lint, typecheck, unit]   # verify.yaml のゲート id を参照。省略時: 全ゲート
autoYes:
  mode: safe                       # off | safe | allow-listed（省略時: 従来動作 = ポリシー制約なし）
  allowPromptTypes: [yes_no]       # mode=allow-listed 時に有効
  denyPatterns: []                 # 質問文/選択肢にマッチしたら自動応答せずエスカレート（正規表現）
success:
  requireWorkEvidence: true        # 省略時 true
  requireScopeClean: true          # 省略時 true（scope ゲートは Phase 2-2。それまで無視される）
```

契約ファイルは `.commandmate/tasks/*.yaml` として **Git 追跡対象**である
（`.gitignore` の 2 段構え規則。[commandmate-directory-tracking.md](./commandmate-directory-tracking.md) 参照）。
契約はレビュー対象の成果物であり、ランタイムデータではない。

---

## 2. フィールド仕様

### 2.1 トップレベル

| キー | 型 | 必須 | 既定 | 制約 |
|---|---|---|---|---|
| `version` | integer | ✅ | — | `1` のみ。他の値・欠落は契約エラー |
| `title` | string | ✅ | — | 非空。最大 200 文字 |
| `goal` | string | ✅ | — | 非空。最大 8000 文字。送信メッセージ本文になる |
| `scope` | map | — | `allow: []` / `deny: []` | `success.requireScopeClean` が true なら `allow` は 1 件以上 |
| `verify` | map | — | `gates: null`（全ゲート） | `gates` は verify.yaml のゲート id |
| `autoYes` | map | — | `mode: null`（ポリシー制約なし） | 下記 2.4 |
| `success` | map | — | 両フラグ true | 下記 2.5 |

**未知キーは契約エラー**（トップレベル・各サブマップとも）。v1 は閉じた集合として扱う。

> **Issue #1545 本文との差異（意図的）**: 本文は「未知キー無視」と書いているが、
> 同時に「`verify-config.ts` と同じ作法」を要求している。実測した `verify-config.ts` は
> 未知キーを**エラーにする**（"v1 is a closed set"）。`allowPromptTypes` の綴り間違いが
> 黙って無視されると「autoYes を縛っているように見えて縛っていない契約」が生まれ、
> これは契約という仕組みにとって最悪の失敗モードなので、**実装の作法を正**とした。

### 2.2 `scope`

| キー | 型 | 既定 | 制約 |
|---|---|---|---|
| `allow` | list of string | `[]` | 各要素は非空・最大 200 文字。最大 200 件。`requireScopeClean` が true なら 1 件以上 |
| `deny` | list of string | `[]` | 同上（件数上限は共通） |

パターンは **worktree ルートからの相対 glob**。以下は契約エラー:

- 絶対パス（`/etc/passwd`）
- `..` を含むパス（`../other-repo/**`）
- NUL バイトを含む文字列

契約は worktree の内側についてのみ語れる。外を指すパターンは Phase 2-2 のゲートでも
判定不能なので、宣言時点で弾く。

### 2.3 `verify`

| キー | 型 | 既定 | 制約 |
|---|---|---|---|
| `gates` | list of string | `null`（= 全ゲート） | 各要素は `verify.yaml` の `gates[].id` 形式。空リストは契約エラー。最大 32 件 |

`gates: []`（空リスト）は「ゲートなしで合格させる」という意味になりうるため**エラー**にする。
「全部走らせる」は `verify` キー自体の省略、または `verify.gates` の省略で表す。

ゲート id が `.commandmate/verify.yaml` に**実在するか**は、契約の送信時
（`send --contract`）に照合される（§5）。パーサ単体は verify.yaml を読まない。

組み込みゲート `work-evidence` の実行有無は**このリストではなく
`success.requireWorkEvidence` が決める**。`requireWorkEvidence: true`（既定）の契約が
`gates: [lint, unit]` と書いた場合、解決後のゲート集合は `[work-evidence, lint, unit]` になる。
そうしないと「作業証跡を要求する」と宣言しているのに何もそれを確認しない契約が成立してしまう。
明示的に `gates` に `work-evidence` を書いた場合は重複しない。

### 2.4 `autoYes`

| キー | 型 | 既定 | 制約 |
|---|---|---|---|
| `mode` | string | `null` | `off` / `safe` / `allow-listed` のいずれか |
| `allowPromptTypes` | list of string | `[]` | `mode: allow-listed` のときのみ意味を持つ。最大 16 件 |
| `denyPatterns` | list of string | `[]` | 正規表現としてコンパイル可能。**1 件あたり最大 200 文字**、最大 32 件 |

`mode` の省略（= `null`）は「契約はポリシーを何も述べていない」であり、`off` とは異なる。
`off` は「自動応答を禁止する」という積極的な宣言である。この区別は Phase 2-3 の
enforcement が「契約が無いから従来動作」と「契約が off と言っている」を取り違えないために存在する。

`denyPatterns` の長さ上限は **ReDoS 対策**である。マッチ対象はエージェントの出力（=
外部由来の文字列）であり、パターン自体はリポジトリのコミッタが書く。上限は
「壊れた正規表現を書ける自由」を削らずに、指数的バックトラックの入力面を小さく保つ。

`allowPromptTypes` は `mode: allow-listed` 以外では無視される（エラーではない）。
モードを一時的に落として実験する運用を、リストを消さずに行えるようにするため。

### 2.5 `success`

| キー | 型 | 既定 | 意味 |
|---|---|---|---|
| `requireWorkEvidence` | boolean | `true` | commit も差分も無い「作業ゼロ」を不合格とする（`work-evidence` ゲート） |
| `requireScopeClean` | boolean | `true` | `scope` 外の変更を不合格とする（**Phase 2-2 まで無視される**） |

`requireWorkEvidence` は §2.3 のとおり `verify.gates` に `work-evidence` を自動で足す。
このフラグが単独で意味を持つ（ゲートリストと矛盾しない）ようにするための規則である。

`requireScopeClean` が true のとき `scope.allow` が空なら契約エラー。
「スコープを守れ」と言いながらスコープを 1 つも挙げていない契約は、
Phase 2-2 のゲートが有効になった瞬間に**あらゆる変更を不合格**にする。

---

## 3. エラーの扱い

1. 1 つでも違反があれば `TaskContractError` を投げる。**best-effort 解釈はしない**
   （不正な契約が `succeeded` を出すのが最悪の失敗モードのため）。
2. 違反は**全件集約**して `issues: string[]` に載せる。1 往復で 1 件ずつ判明する体験を避ける。
3. YAML パースエラーもトップレベルの型違反も同じ経路で報告する。
4. `send --contract` はこのエラーを **exit 2**（`ExitCode.CONFIG_ERROR`）に対応させ、
   全件を stderr に出す。**tasks 行は作られない**（契約が読めていないので記録すべき契約が無い）。

---

## 4. `tasks` テーブルへのミラー（migration v50）

契約は送信時に**パース済みスナップショット**として `tasks.contract_json` に保存される。
ファイルの後編集は既存タスクの判定を変えない。`tasks.contract_path` には送信時点の
相対パスだけを記録する（再読込のためではなく、由来を辿るため）。

`status` の語彙:

| status | 意味 |
|---|---|
| `pending` | tasks 行は作られたが、まだ送信されていない |
| `running` | 送信済み。エージェントが作業中 |
| `waiting_input` | プロンプト待ち（Phase 3-1 の状態機械で使用） |
| `verifying` | 検証ラン実行中 |
| `succeeded` | 検証ランが `passed` |
| `failed` | 検証ランが `failed`、または送信・検証が成立しなかった |
| `not_started` | 検証ランが `not_started`（作業証跡ゼロ） |
| `cancelled` | 明示的に中止された |

検証ラン `error`（設定不備・spawn 失敗などで**判定に到達しなかった**）は task を `failed`
に落とす。判定に到達しなかったタスクは「合格したタスク」ではないし、`verifying` に
永久に留まらせるのは状態としての嘘である。理由は当該 run の `config` ゲートの
`log_tail` に残る。

---

## 5. 送信メッセージの合成

`send --contract` は契約前文と goal を連結して送信する:

```
## 実行契約
- 変更してよいのは次のパスのみ: src/lib/verification/**, tests/unit/verification/**
- 変更してはならないパス: （deny がある場合のみ）
- 作業完了後は必ず commit すること（未 commit の作業は未完了とみなされる）
- 完了条件: 次の検証コマンドがすべて成功すること: npm run lint / npx tsc --noEmit

## タスク
<goal>
```

前文の「完了条件」行は `verify.yaml` の `gates[].command` を解決して**実コマンド**で書く。
ゲート id だけを渡してもエージェントは何が走るのか分からず、契約の意味が伝わらない。

そのため送信時に verify.yaml との照合が入る。以下は契約エラー（exit 2）:

- `verify.gates` が宣言されているのに `.commandmate/verify.yaml` が無い / 読めない
- `verify.gates` が verify.yaml に存在しないゲート id を指している

存在しないゲート id を許すと、検証時に `selectGates` が弾くまで気付けない。
「契約を送った」と「契約の完了条件が実在する」を同じ瞬間に確定させる。

---

## 6. verify / wait との連携

- `startVerification` は `taskId` 未指定でも `getActiveTask(worktreeId)` で解決を試みる
  （`running` / `waiting_input` / `verifying` の最新 1 件）。検証ランは worktree 単位
  （同一 worktree で同時に 1 ラン）なので、解決も worktree 単位で行う。
- 解決できた task の契約に `verify.gates` があれば、`gateIds` 未指定時の既定として使う
  （`success.requireWorkEvidence` による `work-evidence` の補完込み。§2.3）。
  呼び出し側が明示した `gateIds` は常に優先される。
- ラン開始時に task は `verifying` になり、終了時に §4 の表に従って終端状態へ遷移する。
  `last_verification_run_id` と `finished_at` も同時に記録される。
- したがって `wait --verify` は CLI 側の変更なしに契約の `verify.gates` で検証される。

この直接更新は Phase 3-1 で状態機械経由に置換される暫定実装である。

---

## 7. Phase 2-2 以降への申し送り

- `scope` ゲート（#1546）: `allow` / `deny` は本仕様の形で既に保持されている。
  ゲートは `git diff --name-only <baseRef>...HEAD` と `git status --porcelain` の
  両方を対象にすること（commit 済みだけを見ると未 commit の逸脱を見逃す）。
- `autoYes` enforcement（#1547）: Auto-Yes は `status-detector` を経由せず
  `detectPrompt` を直接呼ぶ経路がある。ポリシーは `detectPrompt` 側の経路に効かせないと
  自動応答は止まらない。
- 状態機械（#1548 系 / Phase 3-1）: 本仕様の `status` 語彙をそのまま使い、
  `updateTaskStatus` の直接呼び出しを状態機械の遷移関数に置き換える。
