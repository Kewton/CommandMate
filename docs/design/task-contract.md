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
  denyPatterns: []                 # 質問文/選択肢にマッチしたら自動応答せずエスカレート（正規表現）
success:
  requireWorkEvidence: true        # 省略時 true
  requireScopeClean: true          # 省略時 true（組み込み scope ゲートが変更ファイルを突合。§2.2）
  autoVerifyOnStop: false          # 省略時 false（エージェント停止イベントで検証を自動起動。§2.5）
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

契約は worktree の内側についてのみ語れる。外を指すパターンはゲートでも判定不能なので、
宣言時点で弾く。

#### 2.2.1 glob の意味（実装: `src/lib/verification/scope-gate.ts`）

glob ライブラリではなく、**この表に閉じた小さな部分集合**を自前で解釈する
（理由は §2.2.6）。

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
| 変更ファイル 0 件 | `passed`（「何も起きていない」の判定は `work-evidence` の仕事。ここでも落とすと 1 つの問題が 2 件に見える） |
| run に契約が紐づいていない | `skipped` |
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

#### 2.2.6 glob ライブラリを直接依存に足さなかった理由

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

`gates: []`（空リスト）は「ゲートなしで合格させる」という意味になりうるため**エラー**にする。
「全部走らせる」は `verify` キー自体の省略、または `verify.gates` の省略で表す。

ゲート id が `.commandmate/verify.yaml` に**実在するか**は、契約の送信時
（`send --contract`）に照合される（§5）。パーサ単体は verify.yaml を読まない。

組み込みゲート `work-evidence` / `scope` の実行有無は**このリストではなく
`success.requireWorkEvidence` / `success.requireScopeClean` が決める**。両方 true（既定）の
契約が `gates: [lint, unit]` と書いた場合、解決後のゲート集合は
`[work-evidence, scope, lint, unit]` になる。そうしないと「作業証跡を要求する」
「スコープを守る」と宣言しているのに何もそれを確認しない契約が成立してしまう。
明示的に `gates` に書いた場合も重複せず、**組み込みは常に実行順で先頭に並ぶ**
（解決後のリストは §5 で「実際に走るコマンドの順序」として提示されるため、
契約の記述順がその順序を偽ってはならない）。

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
3. `denyPatterns` のいずれかがマッチ → 抑止。マッチ対象は**質問文・`instructionText`・
   全選択肢ラベル**。Claude の許可プロンプトは承認対象のコマンドを質問文の上（=
   `instructionText`）に置くため、質問文だけでは効かない
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

適用範囲は**サーバ側 Auto-Yes ポーラーのみ**。クライアント側 `hooks/useAutoYes.ts` は
サーバポーラーが動いていないときだけ応答するフォールバックで、DB を読めないためポリシーを
知らない（`src/hooks/useAutoYes.ts` の注記を参照）。

### 2.5 `success`

| キー | 型 | 既定 | 意味 |
|---|---|---|---|
| `requireWorkEvidence` | boolean | `true` | commit も差分も無い「作業ゼロ」を不合格とする（`work-evidence` ゲート） |
| `requireScopeClean` | boolean | `true` | `scope` 外の変更を不合格とする（組み込み `scope` ゲート。§2.2） |
| `autoVerifyOnStop` | boolean | `false` | `POST /api/hooks/agent-event`（`event: stop`）受信時に検証ランを自動起動する（Issue #1549） |

前 2 つのフラグは §2.3 のとおり `verify.gates` に対応する組み込みゲートを自動で足す。
フラグが単独で意味を持つ（ゲートリストと矛盾しない）ようにするための規則である。

`requireScopeClean` が true のとき `scope.allow` が空なら契約エラー。
「スコープを守れ」と言いながらスコープを 1 つも挙げていない契約は、
Phase 2-2 のゲートが有効になった瞬間に**あらゆる変更を不合格**にする。

`autoVerifyOnStop` だけ既定が false なのは、他の 2 つが「判定基準」なのに対し
これは**サーバに動作を起こさせる**唯一のフラグだからである。本フィールドが存在しなかった
時代に書かれた契約が、Stop hook を設定した途端に検証ランを走らせ始めてはならない。

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

- `scope` ゲート（#1546）: **実装済み**。§2.2 が正準仕様
  （`src/lib/verification/scope-gate.ts` / `tests/unit/verification/scope-gate.test.ts`）。
- `autoYes` enforcement（#1547）: **実装済み**（§2.4 の enforcement を参照）。
  Auto-Yes は `status-detector` を経由せず `detectPrompt` を直接呼ぶため、
  配線先は `auto-yes-poller.ts` の `detectAndRespondToPrompt` である。
- 状態機械（#1548 系 / Phase 3-1）: 本仕様の `status` 語彙をそのまま使い、
  `updateTaskStatus` の直接呼び出しを状態機械の遷移関数に置き換える。
