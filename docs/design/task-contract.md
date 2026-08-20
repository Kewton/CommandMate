# 仕様: `.commandmate/tasks/<name>.yaml` v1（実行契約 / Task Contract）

- **Issue**: [#1545](https://github.com/Kewton/CommandMate/issues/1545)（親 [#1539](https://github.com/Kewton/CommandMate/issues/1539) / Phase 2-1）
- **ステータス**: Accepted
- **対象 version**: `1`
- **実装**: `src/lib/tasks/contract-parser.ts` / `src/lib/tasks/contract-message.ts`
- **テスト**: `tests/unit/tasks/`

本書は**実行契約ファイル**の正準仕様である。契約は「このタスクで何を達成するのか」「どのパスを
変更してよいのか」「何が満たされたら完了なのか」を **送信前に宣言** し、`send → wait → verify`
のパイプラインがその宣言を参照できるようにする。

> パーサ（v1）は全フィールドを**検証して保持する**。強制は別フェーズで入り、いずれも実装済み:
> `scope` は Phase 2-2（#1546）の組み込みゲート `scope`（`src/lib/verification/scope-gate.ts`）が
> 変更ファイル集合を `scope.allow` / `scope.deny` と突き合わせ、`success.requireScopeClean` が
> true の契約で自動的に走る（§2.2）。`autoYes` は Phase 2-3（#1547）で enforcement される（§2.4）。

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
  denyPatterns: []                 # 承認対象/質問文/選択肢にマッチしたら自動応答せずエスカレート（正規表現）
success:
  requireWorkEvidence: true        # 省略時 true
  requireScopeClean: true          # 省略時 true（組み込み scope ゲートが変更ファイルを突合。§2.2）
  requireCommit: false             # 省略時 false（true で work-evidence が commit を要求。§2.5）
  autoVerifyOnStop: false          # 省略時 false（エージェント停止イベントで検証を自動起動。§2.5）
```

> **無人実行の推奨レシピ（Issue #1684）**: 上の `mode: safe` は `yes_no` 型しか自動応答しない。
> **Claude の編集確認（`Do you want to make this edit …?`）は `multiple_choice` 型**
> （実質 Yes/No＋allow-all の 3 択）なので、safe のままでは編集のたびにワーカーが停止する
> （出典 #1678 A-2）。無人で走らせる契約は allow-listed に広げ、危険操作は `denyPatterns` で
> エスカレートさせる:
>
> ```yaml
> autoYes:
>   mode: allow-listed
>   allowPromptTypes: [yes_no, multiple_choice]
>   denyPatterns: ['rm -rf', 'git push.*--force', 'sudo ']
> ```
>
> ポリシーが応答を抑止した事実は `commandmate capture --json` の `autoYes.lastSuppression`
> と、`commandmate wait` の stderr / exit 10 payload の `autoYesSuppression` で観測できる
> （§2.4 enforcement、Issue #1699）。

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

契約は worktree の内側についてのみ語れる。外を指すパターンはゲートでも判定不能なので、
宣言時点で弾く。

#### 2.2.1 glob の意味（実装: `src/lib/verification/scope-gate.ts`）

glob ライブラリではなく、**この表に閉じた小さな部分集合**を自前で解釈する
（理由は §2.2.7）。

| 記法 | 意味 |
|---|---|
| `**` | パスセグメント全体を占めるときだけディレクトリ境界を越える。**0 個のセグメントにもマッチ**（`a/**/b` は `a/b` にマッチ、`**/*.ts` は `x.ts` にマッチ） |
| `*` | `/` を含まない任意の文字列 |
| `?` | `/` 以外の 1 文字 |
| `{a,b}` | 選択（入れ子可）。**括弧が閉じていなければリテラル**（シェルと同じ。`src/{a` は「波括弧を含むパス」） |
| `[` `]` | **リテラル**。文字クラスではない |
| 先頭の `.` | 普通の文字。`.github/**` や `**/*.yml` はそのまま読める通りに動く |

大文字小文字は区別する。バックスラッシュによるエスケープは無い。

`[` をリテラルにしているのは本リポジトリの都合ではなく**誤判定を避けるため**である。
Next.js の動的セグメントは `src/app/proxy/[...path]/` のように書かれる。これを文字クラスと
解釈すると、当該ディレクトリを指すパターンは**何にもマッチせず**（`[...path]` は
`.` `p` `a` `t` `h` のうち 1 文字を意味するため）、代わりに `src/app/proxy/p/` のような
無関係なパスにマッチする。黙って外れる glob はこのゲートが防ぐべき失敗そのものである。

**ディレクトリを指すパターンは、その配下すべてにマッチする。** つまり `src/lib`・`src/lib/`・
`src/lib/**` はすべて同義である。この規則が無いと、契約作者がディレクトリを書く最も自然な
表記 `allow: ["src/lib/verification"]` が、その中の全ファイルを違反にしてしまう。
代償として `X/*` で「直下のみ」を表すことはできない（拡張子で絞る `docs/*.md` は意図通り動く）。

#### 2.2.2 判定対象の変更ファイル集合

worktree の cwd で以下を実行し、**和集合**を取る:

1. `git merge-base <baseRef> HEAD` → `git diff --name-only -z --no-renames <merge-base> HEAD`
2. `git status --porcelain -z --untracked-files=all`

コミット済みだけを見ると未コミットの逸脱を見逃し、作業ツリーだけを見るとコミット済みの
逸脱を見逃す。オプションはいずれも偽の判定を避けるために必要である:

- **`-z`**: 人間向け書式は空白を含むパスを `"a b.md"` と C クォートし、rename を
  `old -> new` と 1 行に繋ぐ。空白で分割すると**存在しないファイル**が生まれる
- **`--untracked-files=all`**: 既定では新規ディレクトリが `?? dir/` の 1 エントリに畳まれ、
  ゲートがファイルではなくディレクトリ名を判定してしまう
- **`--no-renames`**（diff 側）: rename 検出が働くと `--name-only` は移動先だけを出す。
  移動元ディレクトリが空になった事実が消える
- rename / copy は**両方のパス**を判定対象にする。許可されたディレクトリから
  ファイルを持ち出すことは、そのディレクトリへの変更である。
  `-z` の porcelain では `R  <new>NUL<old>NUL` の順（人間向け表示の逆）で並ぶ

`.gitignore` されたファイルは `git status` が報告しないため、そもそも判定対象にならない。

#### 2.2.3 契約ファイルは判定対象から外す（#1580）

`.commandmate/tasks/` 配下は、`scope` の変更ファイル集合からも `work-evidence` の
コミット数・未コミット数からも**除外する**。これにより、契約を worktree に置いて
すぐ `send` する軽量フロー（base ブランチへの事前マージもセットアップコミットも不要）が
成立する。

除外しない場合、契約ファイルそのものが作業証跡として数えられ、**何もしなかった
エージェントと作業したエージェントが区別できなくなる**。`work-evidence` は汚れた
作業ツリーを見て `passed` を返し、`not_started`（`wait --verify` の exit 21）に
なるべきランが緑のゲート行を並べてしまう。

| 対象 | 除外の方法 |
|---|---|
| `work-evidence` コミット数 | `git rev-list --count <base>..HEAD -- ':(top)' ':(exclude,top).commandmate/tasks/'`（契約だけを触るセットアップコミットを数えない。`:(top)` は「除外だけの pathspec」を避けつつ両パターンを cwd ではなくリポジトリルートに固定する） |
| `work-evidence` 未コミット数 | porcelain のエントリ単位で判定し、**どのパスも契約ファイル**であるエントリを数えない |
| `scope` 変更集合 | committed 側（`git diff`）と uncommitted 側（`git status`）の**両方**から除外 |

除外プレフィックスは `CONTRACT_DIR_PREFIX`（`src/lib/verification/scope-gate.ts`）
1 箇所に集約し、両ゲートが参照する。

rename は 1 エントリが 2 つのパスを持つ（§2.2.2 の `R  <new>NUL<old>`）。
**どちらか一方でも契約ファイルでなければ**そのエントリは作業として数える —
契約を作業ディレクトリへ持ち出すのは移動先への変更だからである。この判定のために
`work-evidence` の `git status` も `-z --untracked-files=all` を使う。人間向け書式は
新規の `.commandmate/tasks/` を `?? .commandmate/tasks/` の 1 ディレクトリエントリに
畳むため、パス単位の除外が「パスでないもの」を判定することになる。

**`.commandmate/verify.yaml` は除外しない。** 契約本体は送信時に `tasks.contract_json`
へスナップショットされる（§4・`src/lib/db/tasks-db.ts`）ので、ファイルを後から
書き換えても検証の判定内容は変わらない。**だから tasks/ の除外は改竄安全である。**
verify.yaml にはこのスナップショット機構が無く、ゲート定義は毎ランでファイルから
読み直される。エージェントが自分のゲートを弱体化させる書き換えを `deny` で
捕まえられる状態を保つため、verify.yaml は変更集合に残す。

除外パスの設定化（`verify.yaml` の `excludePaths` オプション等）は将来判断とし、
v1 では固定である。

#### 2.2.4 常に許可されるパス

`.commandmate/` 配下と、その契約ファイル自身（`tasks.contract_path`）は
**`allow` の要求から除外**する。契約はそこに置かれるので、`allow` に書き忘れた契約が
自分自身の保管場所を違反にしてしまうのを防ぐ。

ただし**明示的な `deny` は効く**。deny は意図的な禁止であり、事故を防ぐための除外規則が
意図的な宣言を無効化するほうが害が大きい。

#### 2.2.5 ゲートの判定

| 状況 | gate status |
|---|---|
| 違反 0 件 | `passed` |
| 違反 1 件以上 | `failed`（`log_tail` に**最大 100 件**を列挙し、残りは件数で示す） |
| 許可された変更 | 合否を問わず `log_tail` の `admitted:` 節に path とそれを許可したパターンを残す（§2.2.5.1・#1841） |
| 変更ファイル 0 件 | `passed`（「何も起きていない」の判定は `work-evidence` の仕事。ここでも落とすと 1 つの問題が 2 件に見える） |
| run に契約が紐づいていない（契約自体が存在しない） | `skipped`（集計に数えない） |
| run に契約が紐づかず、**しかし終端状態の契約が worktree に存在する** | `skipped`（**集計に数える** → run は `error`。#1620） |
| `success.requireScopeClean: false` | `skipped` |
| `baseRef` 未解決 / git が答えられない | `error` |

`scope` は `work-evidence` の直後・コマンド系ゲートの前に走る。ゲートが失敗しても run は
打ち切らない（1 往復で問題が 1 件ずつ判明する体験を避けるため）。

**`skipped` の集計は例外扱いである。** 通常 `skipped` が 1 つでもあれば run は `passed` に
ならず `error` になる（§4・「チェックしなかった」を「チェックして問題なかった」と
読ませないため）。しかし `scope` は既定のゲート集合に常に含まれるので、契約を使っていない
リポジトリの検証がすべて `error` になってしまう。そこで **`gateIds` で名指しされた場合の
`skipped` だけを集計に数える** — 名指しされたのに判定しなかったのは「断った」ことだが、
契約が無いのは「判定すべき宣言が存在しない」ことであって、断ったわけではない。

#### 2.2.5.1 判定の証跡 — 何がどのパターンで許可されたか（#1841）

ゲートは違反 path だけでなく、**許可された変更ファイルと、それを許可したパターン**も
`log_tail` に残す。`allow` が完全一致 path なら「パターン＝ファイル」で情報量はゼロだが、
#1546 で glob が正式化された後は `src/**` という宣言だけが残り、**その run で実際に何が
許可されたのか**は後から読めない。契約は主張であり、これはその主張に対する証跡である。

```
scope: baseRef=origin/develop changed=3 violations=1
allow: src/**, docs/*.md
deny: src/secret/**
admitted:
  + docs/x.md  ← docs/*.md
  + src/a/b.ts  ← src/**
out of scope:
  - src/secret/key.ts  ← src/secret/**
```

| 規則 | 内容 |
|---|---|
| 記録するパターン | **宣言順で最初に一致したもの**（allow / deny とも）。最後に一致したものを名指すと「消しても判定が変わらないルール」を提示することになる |
| 例外で許可された path | `(exempt: .commandmate/)` / `(exempt: contract path)`。括弧付きなのは、契約を grep しても見つからないことが事実だから（§2.2.4） |
| deny で落ちた path | `admitted:` に入らず、`out of scope:` 側に**拒否した deny パターン**が付く。`deny:` 見出しは宣言の一覧、こちらはこの path が踏んだ実体（＝revert すべきか allow を広げるべきかの違い） |
| マーカー | 許可は `+`、違反は `-`。1 行だけを見た読者（や grep）が両者を取り違えないため |
| 件数上限 | 各節 `MAX_REPORTED_VIOLATIONS`（100 件）。超過は `  ... (+N more)`（admitted）/ `  ... and N more`（違反）と明示する。**切り詰めは表示規則であり、判定は全ファイルに対して行う** |
| 節の順序 | `admitted:` が `out of scope:` より前。CLI は不合格ゲートの log を**末尾 40 行**しか表示しない（`MAX_PRINTED_LOG_TAIL_LINES`）ので、長い `admitted:` を後ろに置くと違反一覧とガイダンスが流れる |

**pass / fail の裁定はこの追加で 1 バイトも変わらない。** `ScopeMatcher.isViolation()` は
`classify()` の否定に委譲するので、判定と証跡が食い違う経路そのものが無い。

##### JSON への露出

`commandmate verify --json` と `commandmate verify show --json` は、`scope` ゲートの結果に
機械可読な `scope` フィールドを足す（既存フィールドは不変）。

```jsonc
"scope": {
  "admitted": [{ "path": "src/a/b.ts", "pattern": "src/**" }],  // 最大 100 件
  "violations": ["src/secret/key.ts"],                          // 最大 100 件
  "totals": { "changed": 3, "admitted": 2, "violations": 1 }    // 全ファイルの実数
}
```

`totals` を別に持つのは、2 つの配列がレポートと同じ 100 件で切れるからである。
「scope 外が在るか」は `violations.length` ではなく `totals.violations` で判定する。

この組み立ては**サーバではなく CLI 側**で行う。`verification_gate_results` は status・
exit code・log 本文しか持たず（migration v49 / v56）、構造化データを載せる列が無いためで、
`log_tail` のレポートが唯一の運搬経路である。CLI は `src/cli/**` だけを alias 無しで
コンパイルする（`tsconfig.cli.json`）ので `src/lib/**` を import できず、書式定数は
`SCOPE_PATTERN_ARROW`（`src/lib/verification/scope-gate.ts`）と
`src/cli/commands/verify.ts` の 2 箇所に写しが在る。両者の一致は定数の比較ではなく、
**実ゲートのレポートを実パーサに通す往復テスト**（`tests/unit/verification/scope-gate.test.ts`）で
担保する。定数の比較は「コピーされたこと」しか証明しない。

`scope` フィールドは scope ゲートが実際に判定したときだけ付く。`skipped` / `error` の
`log_tail` はレポートではなく 1 文のメッセージなので、フィールドごと不在にする。空の
`admitted` を出すと「判定した結果 1 件も許可されなかった」と読まれるためである。

#### 2.2.6 「契約が無い」と「契約に結び付かなかった」の区別（#1620）

上の緩和には、想定していなかった経路がある。**ワーカーが自分で `commandmate verify` を回すと
契約タスクは `succeeded` へ遷移する**（これは推奨されている振る舞いである）。その後に
オーケストレーターが回す run は active なタスクを 1 件も解決できず、`scope` は「契約が無い」
として `skipped` になり、緩和によって集計から外れ、**判定していない scope を含んだまま
`passed` を返していた**。

そこで run が契約に結び付かなかったとき、**その worktree の最新タスクを見て 2 つを区別する**。

| 状態 | `log_tail` | 集計 |
|---|---|---|
| タスクが 1 件も無い / 最新が `pending` / `requireScopeClean: false` | `SCOPE_SKIP_NO_CONTRACT`（従来どおり） | 数えない（`passed` のまま） |
| 最新タスクが `succeeded` / `cancelled` で scope を宣言している | `scopeSkipDetachedContract()`（**タスク id と status を名指しする**） | 数える → run は `error` |

run の `task_id` は**空のまま**にする。この run はその契約を判定していないので、紐づけると
判定していない run がタスクの履歴に載ってしまう。

あわせて、**タスク解決の対象を `failed` / `not_started` まで広げた**
（`VERIFIABLE_TASK_STATUSES`）。状態機械は `verify_started` をこの 2 つから受理する（§状態機械・
「フレーキーなゲートで落ちた task は再実行でやり直せる」）のに、id を知らない呼び出し元は
その task を**見つけられなかった**。ゲートが赤 → 直す → もう一度 verify という最も普通の
往復で契約が失われていたのを閉じたものである。`getActiveTask`（Auto-Yes・プロンプト事象）は
従来どおり active 3 状態のみで、終わったタスクを「今動いている」と誤答しない。

**呼び出し側の対応**: `commandmate wait --verify` は**待ち始める時点**（タスクがまだ active な
うち）にタスク id を読み、後続の run に `taskId` として渡す。ワーカーが待機中に自己 verify で
タスクを閉じても、その run は契約の scope を判定する。読めなければ黙って従来動作に戻す
（台帳が読めないことは判定結果ではない）。

#### 2.2.7 glob ライブラリを直接依存に足さなかった理由

Issue #1546 本文は `picomatch` を dependencies に追加するよう指示しているが、着手時に実測した
以下の条件により、**上表の部分集合を自前で解釈する**方針を採った。

- `picomatch` / `minimatch` はいずれも**直接依存ではなく推移依存**（`next-intl` →
  `@parcel/watcher` 経由）。直接 import するには `package.json` と `package-lock.json` の
  両方を更新する必要がある（`npm ci` は両者の不整合で落ちる）
- `picomatch` は型定義を同梱しておらず `@types/picomatch` は `node_modules` に存在しない。
  `strict: true` 下で使うには実ネットワークインストールが必要
- この worktree の `node_modules` は**兄弟 worktree と 14 本の hardlink を共有**しており、
  並列ワーカーが同時に build / test を回している最中の再展開は他の作業を壊しうる

代わりに、`[` をリテラルにする・ディレクトリを配下ごと含める、といった**このゲートに
固有の判断**を明示的に選べる利点を得た。glob 解釈の 6 種の変異注入（`*` が `/` を越える、
globstar が 0 セグメントにマッチしない、括弧を文字クラスとして解釈する等）で、
テストが実際に赤くなることを確認している。

### 2.3 `verify`

| キー | 型 | 既定 | 制約 |
|---|---|---|---|
| `gates` | list of string | `null`（= 全ゲート） | 各要素は `verify.yaml` の `gates[].id` 形式。空リストは契約エラー。最大 32 件 |
| `gateDefinitions` | list of `{id, command, timeoutSec, mutex, retryOnFail, flakyIsPass}` | `[]` | 形も検証も `verify.yaml` の `gates[]` と同一（Issue #1791）。`mutex` は任意（Issue #1771）、`retryOnFail` / `flakyIsPass` も任意（Issue #1772）。最大 32 件 |

`gates: []`（空リスト）は「ゲートなしで合格させる」という意味になりうるため**エラー**にする。
「全部走らせる」は `verify` キー自体の省略、または `verify.gates` の省略で表す。

ゲート id が `.commandmate/verify.yaml` に**実在するか**は、契約の送信時
（`send --contract`）に照合される（§5）。パーサ単体は verify.yaml を読まない。

#### 2.3.1 `gateDefinitions` — 契約自身が運ぶゲート（Issue #1791 / #1756 案 B）

`gates` は**選択**、`gateDefinitions` は**定義**である。両者は別の役割であり、
`gates` の意味は #1791 で変えていない。

```yaml
verify:
  gates: [lint, issue-1234-repro]   # 省略時は「全ゲート」
  gateDefinitions:                  # 任意。この契約でだけ有効なゲート
    - id: issue-1234-repro
      command: "node scripts/repro-1234.mjs"
      timeoutSec: 300               # 省略時 DEFAULT_TIMEOUT_SEC=600
```

**なぜ契約側に載せるのか。** Issue 固有の使い捨てゲートを worktree へ渡す経路は、
以前は「orchestrator が `.commandmate/verify.yaml` を書き換える」しか無かった。しかし
`verify.yaml` は work-evidence の変更集合に**残る**設計であり（除外は `.commandmate/tasks/`
だけ ——`scope-gate.ts` の `CONTRACT_DIR_PREFIX`）、**追記を置いただけの worktree が
「作業済み」に見えて `exit 21` が意味を失う**（#1756 の実測）。一方で除外を広げると、
エージェントが自分を裁くゲートを弱めたことを検出できなくなる（verify.yaml は毎ラン
ファイルから読み直され snapshot が無い）。契約は既に `tasks.contract_json` へ
snapshot 済みで変更集合からも除外済みなので、**新しい改竄面を作らずに済む**。

- 形と検証は `verify.yaml` の `gates[]` と**同じ関数**（`validateGateEntries`）を通す。
  id パターン `^[a-z0-9][a-z0-9-]{0,31}$`・予約 id 禁止・リスト内重複禁止・
  `timeoutSec` の整数と 1..7200 の範囲は、二重定義ではなく同一実装で保証される。
  Issue #1771 の `mutex`（マシン全体のロック名。`^[A-Za-z0-9_.-]+$` / 64 文字以内、
  [verification-config.md](./verification-config.md) §9）も同じ経路で受理される
  — 契約が運ぶ使い捨てゲートこそ固定ポートを掴みがちだからである。
  Issue #1772 の `retryOnFail`（`0` か `1`）と `flakyIsPass`（boolean。`true` は
  `retryOnFail: 1` を伴わなければ契約エラー）も同様
  （[verification-config.md](./verification-config.md) §10）。
  **`mutex` / `retryOnFail` / `flakyIsPass` を宣言しなかったゲートの JSON には
  キー自体が現れない**（契約は `tasks.contract_json` へ verbatim に保存され
  再検証されないので、`undefined` 値のキーを書くと「宣言されていない」と
  「値の無い宣言」が混ざる）
- `gates` 省略時は「verify.yaml の全ゲート ＋ この契約の `gateDefinitions` 全部」
- 空リスト `gateDefinitions: []` はキー省略と同義（`gates: []` と違い解釈が一意なので
  エラーにしない。YAML を機械生成する orchestrator が空の場合分けを持たずに済む）
- **`gates` を書いたのに定義したゲートを選ばないのは契約エラー**。その契約が唯一の
  宣言元なので、選ばれなければ**永久に走らない**——「チェックを足したつもりで足していない」
  契約になる（`requireCommit` × `requireWorkEvidence: false` と同型の規則）
- 実行順は **verify.yaml の宣言順 → 契約の宣言順**（§6）。Issue 固有ゲートは repo 共通
  ゲートの後に走る

送信時の拒否（exit 2）は §5 を参照。`.commandmate/verify.yaml` は**読むだけで
1 バイトも書かない**——それが本機能の前提である。

組み込みゲート `work-evidence` / `scope` の実行有無は**このリストではなく
`success.requireWorkEvidence` / `success.requireScopeClean` が決める**。両方 true（既定）の
契約が `gates: [lint, unit]` と書いた場合、解決後のゲート集合は
`[work-evidence, scope, lint, unit]` になる。そうしないと「作業証跡を要求する」
「スコープを守る」と宣言しているのに何もそれを確認しない契約が成立してしまう。
明示的に `gates` に書いた場合も重複せず、**組み込みは常に実行順で先頭に並ぶ**
（解決後のリストは §5 で「実際に走るコマンドの順序」として提示されるため、
契約の記述順がその順序を偽ってはならない）。

組み込み `env-clean`（§2.6）も同じ規則で、実行有無は `success.requireEnvClean` と
verify.yaml の `options.requireEnvClean` の OR が決める。ただし現時点では
`verify.gates: [env-clean]` と書くと送信時の照合（`validateContractAgainstVerifyConfig`）で
未知の id として弾かれる — §2.6「未着地部分」を参照。

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

#### enforcement（#1547 で実装済み）

判定は `resolveAutoAnswerWithPolicy()`（`src/lib/polling/auto-yes-resolver.ts`）が行う。
**ポリシーは抑止しかしない**: 従来ルールが `null` を返すプロンプトを応答に変えることはない。

1. 従来ルールで答えが出ないプロンプト（選択肢ゼロ、テキスト入力必須）はそのまま `null`
2. `mode: off` → 常に抑止
3. `denyPatterns` のいずれかがマッチ → 抑止。マッチ対象は**質問文・`approvalTarget`・
   全選択肢ラベル**。Claude の許可プロンプトは承認対象のコマンドを質問文の上に置くため、
   質問文だけでは効かない。

   > **#1699 の訂正**: この面はかつて `instructionText` だった。`instructionText` は人間が
   > 文脈を読むためのペイン窓であり、**数ターン前に承認済みのコマンドが窓に残り続ける**。
   > その結果 `rm -rf` を一度承認すると、以後の無関係なプロンプト（編集確認など）まで
   > 恒久的に抑止され、当該行がスクロールアウトするまで Auto-Yes が事実上死ぬ
   > （2026-08-05 の並列委任でワーカー2台が停止、片方は約1時間無進捗）。現在は検出時点で
   > **直前ターンの境界で切った `approvalTarget`** を別フィールドとして持ち、判定はそちら、
   > 表示は従来どおり `instructionText` を使う。
4. `mode: safe` → `yes_no` のみ従来ルール、他は抑止（#1495 の `/model` オーバーレイ誤検出は
   この型に該当する）
5. `mode: allow-listed` → `allowPromptTypes` に含まれる型のみ従来ルール

`denyPatterns` は **`mode: null` でも効く**。パターンを書いた契約は既にポリシーを述べており、
「列挙したのに何も守らない」は契約の最悪の失敗モードだから。`mode: null` かつ
`denyPatterns` 空（= `autoYes` ブロックの無い契約）はどの分岐にも入らず、契約なし運用と
**完全に同一の挙動**になる。

パターンは実行前に `validateStopPattern()`（長さ・safe-regex2 による指数バックトラック検出・
構文）で審査し、**評価できないパターンは抑止側に倒す**（`deny-pattern-unusable`）。
無視すると契約が要求した保護が黙って消えるため。マッチ対象テキストは 1 フィールド
20,000 文字までを見る（プロンプト文は実際には数百文字。上限は病的な pane が毎 poll
メガバイトを走査させないための決定的な境界）。

抑止時は `auto-yes-poller` が `poller:auto-yes-suppressed-by-policy` を理由付きで警告ログに
出す。エージェントへのキーストロークは送られず、**人間への通知は既存経路**
（`polling/response-checker.ts` の prompt 保存 → WS broadcast → Web Push）が担う。

抑止の事実は CLI からも観測できる（Issue #1684）: 最後の抑止が
`src/lib/polling/auto-yes-suppression-state.ts` にセッション単位で記録され、
`GET /current-output`（= `commandmate capture --json`）の
`autoYes.lastSuppression`（`reason` / `mode` / `promptType` / `pattern` / `at`）に出る。
抑止されたプロンプトはポーラーの重複ガードに載らず毎 poll 再評価されるため、プロンプトが
画面に残っている間は `at` が更新され続ける — `isPromptWaiting: true` かつ `at` が新しければ
「いまポリシー抑止で停止している」と読める。露出のみで、この記録を読んで挙動を変えるものは無い。

適用範囲は**サーバ側 Auto-Yes ポーラーのみ**。クライアント側 `hooks/useAutoYes.ts` は
サーバポーラーが動いていないときだけ応答するフォールバックで、DB を読めないためポリシーを
知らない（`src/hooks/useAutoYes.ts` の注記を参照）。

### 2.5 `success`

| キー | 型 | 既定 | 意味 |
|---|---|---|---|
| `requireWorkEvidence` | boolean | `true` | commit も差分も無い「作業ゼロ」を不合格とする（`work-evidence` ゲート） |
| `requireScopeClean` | boolean | `true` | `scope` 外の変更を不合格とする（組み込み `scope` ゲート。§2.2） |
| `requireCommit` | boolean | `false` | `work-evidence` に「変更が在る」ではなく **「commit が在る」** を要求する。`commits=0 uncommitted=1` は failed（run は `not_started`）。Issue #1642 |
| `autoVerifyOnStop` | boolean | `false` | `POST /api/hooks/agent-event`（`event: stop`）受信時に検証ランを自動起動する（Issue #1549） |
| `requireEnvClean` | boolean | `false` | リポジトリ**外**の副作用（プロセス・ポート・tmux セッション・`$HOME`）を不合格とする（組み込み `env-clean` ゲート。§2.6）。Issue #1740。**現時点でパーサはこのキーを受理しない** — §2.6 の「未着地部分」を参照 |

`requireWorkEvidence` / `requireScopeClean` は §2.3 のとおり `verify.gates` に対応する
組み込みゲートを自動で足す。フラグが単独で意味を持つ（ゲートリストと矛盾しない）ように
するための規則である。

`requireScopeClean` が true のとき `scope.allow` が空なら契約エラー。
「スコープを守れ」と言いながらスコープを 1 つも挙げていない契約は、
Phase 2-2 のゲートが有効になった瞬間に**あらゆる変更を不合格**にする。

同じ理由で、**`requireCommit: true` かつ `requireWorkEvidence: false` は契約エラー**。
commit の要求を裁定するのは `work-evidence` ゲートであり、`requireWorkEvidence: false` は
そのゲートを契約のゲート集合から外す。受理すると前文に「必ず commit」と書きながら
それを見る機械が 1 つも無い契約が成立する — 本フィールドが塞ぐはずの欠陥そのものになる。

`autoVerifyOnStop` / `requireCommit` の既定が false なのは、前 2 つが「判定基準」なのに対し
`autoVerifyOnStop` は**サーバに動作を起こさせる**唯一のフラグだから、`requireCommit` は
**既存の全契約の判定が変わってしまう**からである。本フィールドが存在しなかった時代に
書かれた契約が、Stop hook を設定した途端に検証ランを走らせ始めたり、未 commit の作業で
不合格になり始めたりしてはならない。

#### `requireCommit` と `verify.yaml` の `options.requireCommit`（Issue #1642）

同じ要求は `.commandmate/verify.yaml` の `options.requireCommit`（Issue #1628）にもある。
違いは**適用単位**である。

| 宣言場所 | 単位 | 使いどころ |
|---|---|---|
| `options.requireCommit`（verify.yaml） | リポジトリ | このリポジトリでは常に commit を要求する |
| `success.requireCommit`（契約） | 委任 1 件 | このワーカー委任では commit を要求する |

**両者の合成は OR（どちらか一方が true なら true）。** 契約が verify.yaml を上書きすることは
ない。契約側を足した目的は「契約が宣言したルールを機械が検査していない」穴を塞ぐことなので、
リポジトリが `options.requireCommit: true` で要求しているものを個々の委任契約が黙って
緩められるようにすると、同じ穴が委任単位で再発する。**契約は締める方向にしか効かない。**

リポジトリ単位のスイッチだけでは両立しなかった 2 用途:

| 用途 | 求めるもの |
|---|---|
| ワーカー委任（`send --contract` → `wait --verify`） | commit を要求したい |
| 手元の対話的な `commandmate verify` | 要求されたくない。**`work-evidence` が落ちると後続ゲートは全て `skipped`** になり、作業中に lint / typecheck / unit の結果が一切返らなくなる |

裁定の理由行には**どちらの宣言が要求したか**を書く
（`options.requireCommit (.commandmate/verify.yaml) and success.requireCommit (task contract)`）。

契約に紐付かないラン（`taskId` も解決結果も無い素の `commandmate verify`）は
`options.requireCommit` だけを見る。`findDetachedContract`（§2.2 / Issue #1620）が拾う
**未接続の契約からはフラグを読まない** — そのランはその契約についてのランではないため。
未接続の契約が在ること自体は `scope` の `skipped` として集計に数えられ、run は `error` になる。

Phase 0 の bash 参照実装（`.claude/skills/cmate-verify/scripts/verify-run.sh`）は
**契約を読まないスタンドアロンランナー**なので `options.requireCommit` だけを見る（Issue #1639）。

### 2.6 組み込み `env-clean` ゲート（Issue #1740）

実装: `src/lib/verification/env-snapshot.ts` / `src/lib/verification/env-clean-gate.ts`
テスト: `tests/unit/verification/env-snapshot.test.ts` /
`tests/unit/verification/env-clean-gate.test.ts` /
`tests/unit/verification/gate-runner-env-clean.test.ts` /
`tests/integration/env-clean-gate-1740.test.ts`

`scope` は**リポジトリ内**のファイル変更を裁定する。`env-clean` は**リポジトリ外**を裁定する。
両方あって初めて「この委任が何を変えたか」が閉じる。

2026-08-06 に起きた 4 件（本番サーバの停止 #1739 / `~/.commandmate-uat-1726` の放置 /
隔離サーバ 3779 の残存 / `~/.commandmate/hooks` の汚染 #1722）は**すべて `scope` を PASS する**。
ファイルはリポジトリ内しか見ていないためである。

#### スナップショット項目

| probe id | 取得方法 | 違反の意味 |
|---|---|---|
| `listeners` | `lsof -nP -iTCP -sTCP:LISTEN -F pcn` を `ps -A -o pid=,command=` と突き合わせ、コマンドラインが CommandMate のもの（`COMMANDMATE_PROCESS_PATTERN`）だけを残す。key は `tcp/<port>`、anchor は `lsof -a -d cwd` で引いた cwd | ポートが消えた＝サーバを落とした／増えた＝サーバを残した |
| `tmux-sessions` | `tmux list-sessions -F '#{session_name}'` のうち `mcbd-` 始まり | 他ワーカーのセッションを殺した（#1624）／自分のセッションを残した |
| `home-entries` | `$HOME` 直下の `readdir` | HOME を汚した |
| `commandmate-entries` | `~/.commandmate` 直下の `readdir` | 設定・状態ディレクトリを汚した |

無関係なポートまで記録すると、ブラウザやコンテナランタイムが開閉するだけで違反が量産され
ゲートが使い物にならない。`listeners` を CommandMate 関連に絞るのはそのためである。
同じ理由で `-wal` / `-shm` / `-journal` / `.DS_Store` と、本機構自身の保存先
`env-snapshots/` は両ディレクトリ probe から除外する（SQLite のサイドカーはサーバの
起動・停止で勝手に増減する）。

#### fail-open にしない（**本ゲートで最も重要な設計判断**）

probe は `ok` / `unavailable` のどちらかを必ず名乗り、`unavailable` の `entries` は空である。
**「取れなかった」を「空だった」に潰さない。** 潰すと #1614 と同型（測っていない 0 を配る）
になる。差分側も、どちらか一方のスナップショットが `unavailable` なら該当 probe を
`unknown` にする（欠けた側を空集合とみなせば全件が added / removed になり、等しいとみなせば
それが fail-open そのものになる）。

| ゲート結果 | 条件 | run 集計 |
|---|---|---|
| `passed` | 全 probe を比較でき、全て一致 | `passed` |
| `failed` | 実測された違反が 1 件以上 | `failed` |
| `error`（UNKNOWN） | ベースライン不在／`unknown` な probe が 1 つ以上 | `failed` |

`skipped` は使わない。`skipped` は「判定すべき宣言が無かった」と読まれるが、
測れなかった機械について言ってよい台詞ではない。

#### 偽陽性の抑制 — 非対称ルール

- **減ったものは常に違反。** タスク開始時に在ったものが消えたなら、誰のものであれ違反である
  （`pkill -f` が本番サーバを巻き込む #1739、`kill-server` が全 `mcbd-*` を消す #1624 が
  まさにこれ）。
- **増えたものは、他ワーカーに帰属できる場合だけ免除。** 並列委任は互いの計測窓の中で
  正当に自分のセッションやサーバを起こすため、これを違反にすると並列実行が成立しない。

帰属の判定:

| probe | 判定 |
|---|---|
| `tmux-sessions` | 名前 `mcbd-<cli>-<worktreeId>[-suffix]` を分解し、自 worktree なら `self`、別 worktree なら `other`、解釈できなければ `unattributed`。worktree id はハイフンを含みうるので曖昧なケースは `self` に倒す（厳しい側） |
| `listeners` | プロセスの cwd が自 worktree 配下なら `self`、**自 worktree の兄弟ディレクトリ**なら `other`（linked worktree は横並びに作られ、ユーザの本番サーバが動くプライマリ checkout もそこに居る）、それ以外・cwd 不明は `unattributed` |
| `home-entries` / `commandmate-entries` | ファイルに所有者は無いので常に `unattributed` |

`unattributed` は「たぶん誰のものでもない」ではなく「他人のものだと**示せなかった**」であり、
追加は違反として扱う。免除には他所有者の積極的な証拠が要る。

#### 既定は無効、opt-in で有効

| 宣言場所 | 単位 |
|---|---|
| `options.requireEnvClean`（verify.yaml、[verification-config.md](./verification-config.md) §2.3） | リポジトリ |
| `success.requireEnvClean`（契約） | 委任 1 件 |

`requireCommit` と同じく **OR** で合成し、契約は締める方向にしか効かない。
両方省略時はゲート行が 1 つも作られず、probe も一切実行されず、ベースラインファイルも
書かれない — **既存契約の挙動は 1 bit も変わらない**。

`commandmate verify <id> --gates env-clean` で明示指名もできる。ベースラインが無ければ
UNKNOWN を返す（黙って PASS はしない）。

#### 実行位置

`work-evidence` → `scope` → **`env-clean`** → コマンド系ゲート。
コマンド系ゲートの**前**に測るのは、2 枚のスナップショットがエージェントの作業窓を表すから
である。後ろに置くと、`test:e2e` のようにサーバを起こすゲート自身の副作用が
エージェントの漏らしとして報告される。`work-evidence` が通らなかったランでは
`scope` と同様 `skipped` を記録する（そのランは `not_started` で終わり、緑にはならない）。

#### 未着地部分（本 Issue のスコープ外に落ちた分）

1. **`success.requireEnvClean` は契約 YAML にまだ書けない。** `TaskContractSuccess` と
   `SUCCESS_KEYS`（`src/lib/tasks/contract-parser.ts`）は閉じた集合で、未知キーは
   `unknown key "requireEnvClean"` として送信時に 400 になる。同ファイルは本委任の
   `scope.allow` の外にあるため触れていない。**解決は 2 行**（`TaskContractSuccess` に
   `requireEnvClean: boolean` を足し、`SUCCESS_KEYS` に `'requireEnvClean'` を足す。
   既定値は `validateSuccess` の初期値に `requireEnvClean: false`）。
   `resolveRequireEnvClean` は契約の `success` を**構造的に**読むので、この 2 行が入った
   瞬間に検証側は無改修で動く（`tests/unit/verification/gate-runner-env-clean.test.ts` が
   その挙動を先に固定してある）。
2. **`verify.gates: [env-clean]` も同じ理由でまだ書けない。**
   `validateContractAgainstVerifyConfig`（`src/lib/tasks/contract-message.ts`、同じく
   scope 外）の `known` 集合に `ENV_CLEAN_GATE_ID` を足す 1 行が要る。
3. **オーケストレーター向けヘルスチェック**（Issue「併せて欲しいもの」の
   `commandmate status --json` 拡張）は `src/cli/commands/status.ts` が scope 外のため
   未着手。`env-clean` は事後検知であり、即時検知は別の層である。

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

**commit の行は宣言ではなく裁定の写しである**（Issue #1642）。上の「必ず commit すること
（未 commit の作業は未完了とみなされる）」が出るのは §2.5 の OR が true のとき**だけ**で、
false のときは実際に効く内容に合わせて次の文が出る。

```
- 作業完了後は commit すること（ただし work-evidence は未 commit の変更も作業証跡として認めるため、commit の有無そのものは検査されない）
```

同じ理由で `work-evidence` ゲートのラベルも 2 通りある
（`commit または未 commit の変更が存在すること` / `commit が存在すること。未 commit の変更は
作業証跡として数えない`）。この行が固定文言だった時代、ゲートは `commits=0 uncommitted=1` で
`passed` を返しており、Epic #1585 の受入実測で **Codex ワーカーが未コミットのまま
`wait --verify` で exit 0 / `RESULT passed` を受け取った**（Issue #1628 D-4）。
**前文が宣言したルールと機械が裁定するルールが食い違わないことが、この節の不変条件である。**

そのため送信時に verify.yaml との照合が入る。以下は契約エラー（exit 2）:

- `verify.gates` が宣言されているのに `.commandmate/verify.yaml` が無い / 読めない
- `verify.gates` が verify.yaml にも `verify.gateDefinitions` にも無いゲート id を指している
- `verify.gateDefinitions` が宣言されているのに `.commandmate/verify.yaml` が無い / 読めない
  （config 無しでは run 自体が起動しないので、評価され得ない完了条件になる）
- `verify.gateDefinitions[].id` が **verify.yaml の既存 gate id と衝突**している（#1791）
- `verify.gateDefinitions[].id` が**予約 id**（`work-evidence` / `scope` / `env-clean`）
  と衝突している（#1791。こちらは共有バリデータがパース時点で弾く＝同じく送信時）

存在しないゲート id を許すと、検証時に `selectGates` が弾くまで気付けない。
「契約を送った」と「契約の完了条件が実在する」を同じ瞬間に確定させる。

**id 衝突を黙って上書きにしない理由**（#1791）。同じ id を契約が再定義できると、
リポジトリ自身が宣言した「合格の定義」を委任単位で差し替えられることになる。しかも
レポート上は同じ id なので**差し替えたことが読み取れない**。契約は**足せるだけ**で、
上書きが要るなら別 Issue で明示的な override 構文として設計する。

前文（`resolveGateCommands`）は `gateDefinitions` の `command` も実コマンドとして
展開する。契約にしか存在しないゲートこそ、id だけ渡されてもエージェントは何が走るのか
判定できない。

---

## 6. verify / wait との連携

- `startVerification` は `taskId` 未指定でも `getActiveTask(worktreeId)` で解決を試みる
  （`running` / `waiting_input` / `verifying` の最新 1 件）。検証ランは worktree 単位
  （同一 worktree で同時に 1 ラン）なので、解決も worktree 単位で行う。
- 解決できた task の契約に `verify.gates` があれば、`gateIds` 未指定時の既定として使う
  （`success.requireWorkEvidence` による `work-evidence` の補完込み。§2.3）。
  呼び出し側が明示した `gateIds` は常に優先される。
- **契約の `verify.gateDefinitions` は verify.yaml のゲート集合にマージされる**（#1791）。
  実行順は verify.yaml の宣言順 → 契約の宣言順で、`--gates` での名指しも解決できる。
  マージ元は**このランが結び付いた task の契約だけ**——未接続の契約
  （`findDetachedContract`）からは読まない（`requireCommit` と同じ規則。そのランは
  その契約についてのランではない）。id が verify.yaml と衝突する契約が届いた場合は
  マージせず run を `error` にする（送信時に弾いているので旧ビルド由来のみ。
  同一 id の行が 2 つ並ぶとレポートがどちらの裁定か言えなくなる）
- **`verification_gate_results.source`（migration v56）に出所を残す** ——
  `builtin`（work-evidence / scope / env-clean / 擬似ゲート `config`）/
  `verify.yaml` / `contract`。v56 以前の行は `null`（履歴は書き換えない。
  `timingsMeasured` と同じ作法）。`verify --json` / `verify show`（`src=<source>`）/
  `verify history --json` から読める。`wait --verify` と `verify` の GATE 行は
  `contract` のときだけ末尾に ` [contract]` を付ける——verify.yaml はディスクで
  引けるが契約の写しは `contract_json` の中にしか無いため、**印の無い行＝リポジトリの
  合格定義**と読めることが分離の可読性そのものになる。他の出所では出力は 1 bit も変えない
- ラン開始時に task は `verifying` になり、終了時に §4 の表に従って終端状態へ遷移する。
  `last_verification_run_id` と `finished_at` も同時に記録される。
- したがって `wait --verify` は CLI 側の変更なしに契約の `verify.gates` で検証される。

この直接更新は Phase 3-1 で状態機械経由に置換される暫定実装である。

---

## 7. Phase 2-2 以降への申し送り

- `scope` ゲート（#1546）: **実装済み**。§2.2 が正準仕様
  （`src/lib/verification/scope-gate.ts` / `tests/unit/verification/scope-gate.test.ts`）。
- `autoYes` enforcement（#1547）: **実装済み**（§2.4 の enforcement を参照）。
  Auto-Yes は `status-detector` を経由せず `detectPrompt` を直接呼ぶため、
  配線先は `auto-yes-poller.ts` の `detectAndRespondToPrompt` である。
- 状態機械（#1548 系 / Phase 3-1）: 本仕様の `status` 語彙をそのまま使い、
  `updateTaskStatus` の直接呼び出しを状態機械の遷移関数に置き換える。
