# Issue #4367: チームの流れの計測・警報と人向けのダッシュボード（設計）

- 状態: **設計（上流の 3 回目、改訂 3）＋ PR1a の実装**。改訂 3 は、改訂 2（`8b3d5b1d0`）への再レビュー 3（`prereview-4367-3-reply.md`: P2 1 件 R7、F1→R1 と同じ種類の 3 回目）の開発リーダーの処分（狭めて塞ぐ）を、PR1a の実装と同じ PR で反映した。**PR の作成数・マージ数は「検索で観測できた件数」（`coverage: "search-observed"`）と定義し、`complete`（V1 の意味の母集団の完全性）は PR1a では常に false**。処置は §14.0
- 改訂 2 は、改訂 1（`9240bffd0`）への再レビュー（codex-2 `prereview-4367-2-reply.md`: 承認保留、P2 6 件 R1〜R6。F1・F3・F4・F5 が同じ種類の 2 回目）と、それを受けた原因調査（codex `enabler-return-4367-cause.md`）、開発リーダーの処分（`reinstruct-4367-design-2.md`: 原因調査 §8 をそのまま採る）を反映した。**PR1a を「期間を明示した PR の作成・マージの件数」の計測と記録と読み取りだけに狭めた**。外した経路（今の CI・過去の CI・台帳・警報・通知・資源・DB と API・常駐・公開）は §5.2 に、後の PR で満たす条件として残した。指摘ごとの処置は §14
- 改訂 1 は、1 回目（`b1e84d224`）への事前レビュー（`prereview-4367-reply.md`、P2 6 件 F1〜F6）と再指示 1・突き合わせの決定 X1〜X7 を反映した（§14.2）
- 正本: Issue #4367 の本文、Epic #4371 の本文（背景の実測）、段 3 の共通の枠（`workspace/orchestration/runs/2026-11-14/s3-common-frame.md`。以下「共通の枠」）と突き合わせの決定（同じ dir の `s3-crosscheck.md`。以下「X1」〜「X10」）。共通の枠に無いことを新しく決めたものは §11 に集めた
- 基準: develop **`a334a013f`**（v0.51.1）。file:line はこの版。行番号は古くなるので名前で引くこと
- 表記: **事実**＝コードを読んで、または読み取りのコマンドを実行して確かめたこと。**見立て**＝事実からの推論で、試していないこと。**未確認**＝この段で確かめていないこと。**未決**＝この設計では決めず、誰が決めるかを書いたもの（§13.3）
- 他の子（#4368・#4369・#4370）の設計本文は読んでいない。食い違いは突き合わせの決定に従う

## 結論（一覧）

| 段 | 中身 | 節 |
|---|---|---|
| 最上位の不変条件 | 原因調査 §5 の 3 文（**V1 確定は証拠がそろった時だけ**・**V2 確定の境界は全員で共通**・**V3 外部の呼び出しは正の予算がある時だけ、終わりは 1 回**）。改訂 1 の I-0 はこの 3 文に置き換えた | §1 |
| PR1a の中身 | 指標は **PR の作成数とマージ数の 2 つだけ**で、意味は**検索で観測できた件数**（`coverage: "search-observed"`・`complete: false`。母集団の完全な 0 と同一視しない。改訂 3）（repo／base・取得時刻・窓 `[from, to)` を保存）。`tick` は既定で直前 24 時間の 1 つの窓、`reconstruct` は指定した窓の同じ 2 列を時ごとに。`report` は記録した観測と窓をそのまま表示（重なる窓を合算しない）、`status` は最新の観測の時刻・scope・不明／不完全・記録なし・未確定の末尾を区別。警報の状態は表示しない | §2・§6 |
| 記録 | `flow.<repo-slug>` の排他（既存の `machine-lock-sync.mjs` の部品）で tick の全体を直列化し、`kind: tick` の改行つき 1 行だけを書く。**自動の復旧・改行の補修・rename の退避・checkpoint は入れない**。改行の無い末尾があれば追記を止め、警告して exit 1。読み手は改行の無い末尾を未確定として除き、そう表示する | §2.4・§3 |
| 取得と期限 | PR の照会の範囲・上限・応答の型を固定し、**正の予算を強制する runner を全部の外部の呼び出しで共有**（残り ≤ 0 なら呼ばない）。`report`／`status` は識別のための時間制限つきの読み取りの git だけ | §2.3・§3.2 |
| 外した経路 | 今の CI・過去の CI・台帳（WIP・着手→マージ）・開いた PR の数・警報（評価・回復・確定）・通知・資源・DB／API・常駐・公開。未使用の取得の API と設定キーを先に許可しない。各々に後の PR で満たす条件を書いた | §5.2 |
| 受入（Issue の「2026-11-13 の再現」） | **PR1a ではマージ数（と PR の作成数）だけ**。WIP・CI の待ちの再現は後の PR（§5.2 の PR-L・PR-C）で満たす | §8 |
| 試験 | 原因調査 §7 の軸（母集団・行の境界・期限と識別）の全組み合わせと必須の対照 C1〜C9、変異の対照 | §7 |
| ダッシュボード | 第 1 段は数だけを載せる Artifact の試作を推奨（PR1a の `report --json` が入力）。画面は後の PR | §9 |

---

## 0. 前提の確かめ（事実）

| # | 事実 | 場所 | 本書での扱い |
|---|---|---|---|
| F1 | orchestrate の台帳の書き手は最後の行が改行で終わっていなければ改行を足してから書く。読み手は改行の有無によらず各行を JSON として読む | `scripts/orchestrate/run-log.mjs:178-195`・`:201-222` | **写さない**。改行を足すと「完全な JSON で改行だけが無い末尾」が後から確定する（原因調査 §3.3）。flow の書き手・読み手は改行を確定の境界にし、補修しない（V2） |
| F2 | `DEFAULT_REPO = 'Kewton/CommandMate'`・`DEFAULT_BASE_BRANCH = 'develop'` が orchestrate のスクリプトに埋め込まれている | `scripts/orchestrate/pr-common.mjs:24`・`:26` | import しない。repo は `git remote`、base は設定か git の ref から |
| F3 | 読み取りの `gh` は 5xx・接続の失敗で最大 4 回（10・30・60 秒の間隔）呼び直す。`defaultRun` は `spawnSync` に時間切れを渡さない | `pr-common.mjs:82-84`・`:143-155`・`:58-67` | 使わない。flow の runner（§3.2）を通す |
| F4 | Node の `spawnSync` は `timeout > 0` のときだけ停止のタイマーを始める（`timeout: 0` は「時間切れ無し」になる） | 原因調査 §3.5 が引く Node v22.0.0 の `src/spawn_sync.cc:455-475`（**未確認**: 本書の作者は読んでいない。原因調査の確認に拠る） | runner は予算が正の整数ミリ秒のときだけ子を起こす（V3） |
| F5 | マージのロックの名前は `merge.<owner>.<repo>.<base>`（64 文字を超えると sha1 で縮める） | `scripts/orchestrate/merge-pr.mjs:313-317` | repo-slug の作り方を同じ流儀にする。ロック自体は使わない |
| F6 | `acquireMachineLockSync(name, { root, timeoutMs, … })` は札を取ってから `mkdir` で取る。`timeoutMs: 0` は 1 回だけ試し、期限で自分の札を片付けて `acquired: false`。例外の時も札を片付けて投げ直す。死んだ持ち主（同じ host で pid が ESRCH）は脇へ退かして回収し、pid の再利用は起動時刻で見分け、観測できないもの（EPERM・EIO）は取らない・消さない | `scripts/orchestrate/machine-lock-sync.mjs:1080`・`:1140-1143`・`:1369-1372`・`:1380-1383`・`:450-453`・`:462-470`・`:1003-1012`・冒頭の注記 `:24-32` | tick の排他に部品のまま使う（表 S0） |
| F7 | 解放 `release()` は自分の `<lock>` を消せないとき（EACCES・EIO・EBUSY）に警告して**例外を投げる** | `machine-lock-sync.mjs:1269-1275` | 解放の例外も 1 回の終わりに集める（表 S1 の段 8） |
| F8 | 持ち主の起動時刻の読み `processStartMs` は `ps` を時間切れ無しで呼ぶ | `machine-lock-sync.mjs:118-119` | runner の予算は flow 自身の外部の呼び出しの上限で、**CLI 全体の実時間の上限は証明しない**（V3 の範囲。§3.2） |
| F9 | ロックの root は `CM_VERIFY_LOCK_ROOT` か `~/.commandmate/locks` | `scripts/orchestrate/precheck.mjs:523-526` | 同じ root（名前が違うので `merge.*`・`cpu.heavy` とは互いに待たない） |
| F10 | `tests/setup.ts` は `~/.commandmate` の下を指す設定を pid ごとの一時パスに向けている | `tests/setup.ts:287-291` | `CM_FLOW_DIR` を同じ形で足す（共通の枠 §2） |
| F11 | 設定の YAML は `yaml` パッケージで読む | `src/lib/verification/verify-config.ts:12`・`:165` | `.commandmate/flow.yaml` も同じ |
| F12 | team.md §6 の 3（危険の境目で分ける）・4（API は呼び手と同じ PR）・5（狭めて塞ぐ）・6（同じ種類の 2 回目で止める） | `docs/orchestrate/team.md:64-78` | 改訂 2 は 6 で止めた後の原因調査の推奨を 5 で採った |
| F13 | `tests/unit/` の下と `scripts/**` は既存のガードの範囲 | `tests/unit/guards/test-file-placement.test.ts:76-85`、`lint-scripts-scope.test.ts:51`・`:77` | `scripts/flow/`・`tests/unit/scripts/flow/` はガードの中 |

---

## 1. 不変条件

### 1.1 最上位（原因調査 §5 の 3 文。改訂 1 の I-0 を置き換える）

- **V1**: 各指標・警報状態は、対象集合・期間・scope とそれを覆う証拠がそろった場合だけ確定し、範囲外・未読・上限・履歴欠落を 0・初回 ok・連続性へ補わない。
- **V2**: 確定した記録の境界と tick の対象は全ての書者・読者で共通とし、今回と前回の未確定を混ぜず、次の追記や再起動で未確定の末尾を後から確定させず、表示は確定できた記録だけに基づける。
- **V3**: 外部呼出しは実行直前に同じ絶対期限から算出した正の有効な予算がある時だけ開始し、期限後の結果を確定せず、正常・失敗・解放例外の全てを一度の終端へ集め、計測の値を既存の操作許可へ転用しない。

V2 は電源断の後の永続性までは言わない。対象はプロセスの落下・部分的な書き込みと、通常のローカルのファイルシステムの前提（原因調査 §5 の注）。

### 1.2 PR1a で V1〜V3 を守る場所

| # | 条件 | 守る場所 | 上位 |
|---|---|---|---|
| P-1 | 指標は 2 つだけ: `prCreated`（`createdAt ∈ [from, to)`）と `prMerged`（`mergedAt ∈ [from, to)`）。どちらも「照会した時に repo／base に属する PR」（過去の時点の base の所属や、過去の開いた状態を再現したとは呼ばない） | §2.1 | V1 |
| P-2 | 各指標は自分の照会だけから値を出す。値を出すのは exit 0・JSON の配列・全要素の形の検査・件数 < 上限・同じ番号の矛盾が無い、を全部満たしたときだけで、その値は**検索で観測できた件数**（`coverage: "search-observed"`）。正常な応答は検索の索引に載った集合しか覆わないので、**`complete`（母集団の完全性）は PR1a では常に false**。観測の 0 を「母集団の完全な 0」と表示しない（改訂 3・R7） | §2.3。T-P・R7 | V1 |
| P-3 | 記録に無い指標（開いた PR・CI・台帳・WIP・資源）は「非対応」で、読み手は 0・ok・緑に化けさせない | §2.2・§2.5 | V1 |
| P-4 | 書き手は排他の中で、ファイルの最後のバイトが改行（または空のファイル）であることを確かめてから 1 行を 1 回だけ追記する。改行で終わらなければ追記せず、元のバイトを変えず、警告して exit 1。補修・退避・回復をしない | 表 S1。T-L | V2 |
| P-5 | 読み手は改行で終わる行だけを確定した記録として読み、改行の無い末尾は（完全な JSON でも）未確定として除き、あることを表示する | §2.4。T-L | V2 |
| P-6 | 外部の呼び出しはすべて共通の runner を通り、runner は呼ぶ直前に予算（正の整数ミリ秒）を計算し、0 以下・非有限なら子を起こさず `timeout` を返す | §3.2。T-D | V3 |
| P-7 | 締め切りの後に返った結果は確定しない（`timeout`）。記録は高々 1 行、終わりは 1 回（解放の例外を含む） | 表 S1。T-D | V3 |
| P-8 | `report`・`status` は識別の git（時間制限つき・許可した引数だけ）しか呼ばない。gh・API・ロック・記録の dir の作成・書き込みをしない | §2.5。T-I | V3 |
| P-9 | 計測の値・記録を verify・precheck・CI・merge・send の許可に使わない。`merge.*`・`cpu.heavy` を取らない。`src/`・`scripts/orchestrate/`・`.commandmate/verify.yaml`・`.github/` を変えない | §5・§11 | V3 |
| P-10 | GitHub でない origin は exit 2（記録先の識別を作らない）。scope は `repo`＋`base`、別の scope の行は読み飛ばす | §2.1。T-I | V1 |
| P-11 | 呼び手の無い設定キー・記録の種類・取得の関数を置かない。設定の許可は `version`・`repo`・`base`・`exclude`・`tz` だけ | §6.1。T-I | 共通の枠・F12 |

---

## 2. 記録の形と指標（PR1a）

### 2.1 scope・置き場所・名前

- scope: `repo`（`owner/name`。origin から。`flow.yaml` の `repo` が優先）＋`base`（`flow.yaml` の `base`、無ければ `refs/remotes/origin/develop` があれば develop、無ければ `refs/remotes/origin/HEAD` の先）
- 計測の記録: `<flowDir>/<repo-slug>/<YYYY-MM-DD>.jsonl`。`<flowDir>` は `CM_FLOW_DIR`、無ければ `<home>/.commandmate/flow`。日付は `tz` での `at` の日付
- `<repo-slug>`: `<owner>.<name>` を小文字にし、`[a-z0-9_.-]` 以外を `_` に（F5 の流儀。64 文字を超えたら先頭 51 文字＋`.`＋sha1 の 12 桁）。base は slug に入れず、各行の `base` で分ける
- 排他: `<lockRoot>/flow.<repo-slug>.lock`（F6・F9）

### 2.2 計測の記録（`kind: "tick"`、v1）

```jsonc
{
  "v": 1, "kind": "tick",
  "tickId": "6f0c…",                          // 排他を取った後に決める UUID
  "at": "2026-11-13T10:00:03.120Z",           // 排他を取った壁時計の時刻（UTC）
  "repo": "Kewton/CommandMate", "base": "develop",
  "window": { "from": "2026-11-12T10:00:00.000Z", "to": "2026-11-13T10:00:00.000Z" },  // [from, to)
  "metrics": {                                 // PR1a の指標はこの 2 つだけ（P-1・P-3）
    "prCreated": { "value": 7, "coverage": "search-observed", "complete": false, "fetchedAt": "…", "limit": 1000 },
    "prMerged":  { "value": null, "coverage": "search-observed", "complete": false, "why": "timeout", "fetchedAt": null, "limit": 1000 }
  },
  "durationMs": 8123
}
```

- `value` は検索で観測できた件数（`coverage: "search-observed"`）か `null`。`complete` は PR1a では常に `false`（V1 の意味の母集団の完全性は主張しない。改訂 3・R7）
- `why` は `timeout`・`fail`（exit ≠ 0。呼び直さないので一時的な失敗も `fail`。実装は `GH_TRANSIENT_PATTERN` を写していない: 分類が要るのは呼び直す時だけ）・`denied`（`HTTP 403`・`HTTP 404`）・`truncated`（件数 ≥ 上限）・`schema`（形の検査に落ちた）・`conflict`（同じ番号で時刻が食い違う）
- tick の窓: `to` は `at` を分に切り下げた時刻から**猶予 10 分を引いた時刻**、`from = to − 24 時間`（既定。変える設定は置かない: P-11）。猶予は検索の索引の遅れに対する**見立てであって保証ではない**（10 分待っても索引に載っていない PR は観測の外。それでも値は「観測できた件数」のまま。改訂 3・U2）
- 後の PR が足すキーは `metrics.<名前>` に限る（§5.2）。足すだけで v1 の既存のキーの意味は変えない。**読み手は `metrics` に無い名前を「非対応」と表示し、0 と読まない**（P-3）

### 2.3 照会と完全性（PR1a の取得は 2 本だけ）

| 指標 | 照会（runner 経由） | 時刻の絞り込み | 値を出す条件（全部。満たしても `complete` は false） |
|---|---|---|---|
| `prCreated` | `gh pr list --repo R --base B --state all --search "created:<D1>..<D2>" --limit 1000 --json number,createdAt,baseRefName` | `D1`・`D2` は `from`・`to` を UTC の日付に広げたもの（`to` が 0 時ちょうどなら前日）。返った `createdAt` で `[from, to)` に絞る | exit 0・JSON の配列・各要素が `number`（正の整数）・`createdAt`（ISO の時刻）・`baseRefName === B` を持つ・件数 < 1000・同じ `number` が 2 回出たら時刻が同じ（違えば `conflict`）。重複は 1 つにする |
| `prMerged` | `gh pr list --repo R --base B --state merged --search "merged:<D1>..<D2>" --limit 1000 --json number,mergedAt,baseRefName` | 返った `mergedAt` で `[from, to)` | 同じ（`mergedAt` が null の要素は `schema`） |

- 窓の幅は tick が 24 時間、`reconstruct`・`report` は 31 日以内（日付に広げた照会が上限 1000 を超えにくくするため。超えたら `truncated` で `null`）
- **未確認**: GitHub の検索の索引の遅れ（作られた直後の PR が検索に出るまでの時間）とその上限。窓の終わりの直前の PR を落とす恐れがある
- **R7 の処分（改訂 3、開発リーダーの決定: 狭めて塞ぐ）**: 正常な応答（exit 0・配列・型・件数 < 上限・矛盾なし）は「検索がその時に返した集合」の証拠であって、repo／base の全 PR イベントを覆った証拠ではない（索引の遅れで、窓の終わりの直前の PR が `[]` の中に居ないことがある）。そこで PR1a の 2 指標は**検索で観測できた件数**と定義し、記録と出力に `coverage: "search-observed"` を持たせ、`complete` は常に `false` にする。`report`・`status` は「観測した件数（検索） — 母集団の完全な数ではない」と書き、母集団の完全な 0 と同一視しない。取得の失敗・上限・型の誤りはその指標を `null`（`why`）。母集団を覆う取得（例: 一覧の全ページと照合）を入れて `complete` を真にするのは後の PR で、その証拠と終了条件を設計の上流で閉じてから
- 猶予: tick の既定の `to` は観測時刻の分の切り下げ − 10 分（§2.2）。見立てであって保証ではない。`reconstruct` は指定の窓をそのまま照会する（過去の日を後から照会する使い方なので猶予を足さない）

### 2.4 書き手と読み手（行の境界）

- 書き手（`appendTick`）: 排他の中で、ファイルが無い・空・最後のバイトが `\n` のどれかなら `JSON.stringify(tick) + '\n'` を 1 回の `appendFileSync` で書く。それ以外（改行で終わらない）なら書かず、元のバイトを変えず、`flow: unfinished tail in <file>; not appending` を stderr に出して exit 1。dir が無ければ作る（mode 0700）
- 読み手（`readTicks`）: `\n` で終わる行だけを読む。改行の無い末尾は（JSON として読めても）未確定として除き、`unfinishedTail: true` を返す。改行で終わる行が JSON として読めない・形の検査に落ちる（`v`・`kind`・`tickId`・`at`・`repo`・`base`・`window`・`metrics` の型）ときは、その行を除き `corruptLines` に数える。別の scope の行は読み飛ばす
- 落ちた後の復旧は**しない**。改行の無い末尾が残ったファイルには、人が直す（§10 H8）まで tick が書かない（その間 `status` が知らせる）。日付が変われば新しいファイルに書ける

### 2.5 `reconstruct`・`report`・`status`

| cmd | 読むもの | 出すもの | 呼ぶ外部 |
|---|---|---|---|
| `reconstruct --date <YYYY-MM-DD>` か `--from`・`--to` | GitHub（§2.3 の照会を窓で） | 時ごと（`tz`）の `prCreated`・`prMerged` の 2 列（観測できた件数）と、各列の `coverage`・`complete`（常に false）・`why`。時の鍵は `YYYY-MM-DDTHH±hh:mm`（夏時間の日は 23・25 行、重なる時はオフセットで分ける）。記録は書かない。取得の締め切りは識別の後の単調時計 + 200 秒（tick の T0 と同じ扱い） | 識別の git、gh 2 本 |
| `report --from --to` | 記録（窓に `at` が入る tick） | 観測ごとに `at`・`window`・2 つの値（「観測した件数（検索）」、`null` は「不明（理由）」）。**重なる窓を合算しない**。ほかの指標は「非対応」。`corruptLines`・未確定の末尾・上限で読まなかったファイルを末尾に。記録の dir を読めない（EACCES 等）は exit 1 で「記録が無い」と分ける | 識別の git だけ |
| `status` | 記録（最新の tick） | 最新の観測の `at`・scope・2 つの値（観測した件数（検索））、「記録が無い」、未確定の末尾だけがある、壊れた行がある、上限で読まなかった新しいファイルがある（その時は最新を出さない）、を区別して出す（`--json` の `state`: `observed`・`unfinished-only`・`truncated`・`no-records`）。警報の状態は出さない | 識別の git だけ |

`--json` で同じ内容を JSON に。`report`・`status` は記録の dir を作らない（無ければ「記録が無い」）。

---

## 3. 状態と遷移の表（PR1a）

### 3.1 表 S0: 排他（`flow.<repo-slug>`。`tick` だけが取る）

| 出来事 | 次 |
|---|---|
| `acquireMachineLockSync('flow.<slug>', { root, timeoutMs: 0 })` が `acquired: true` | `tickId` と `at`・締め切りを決め、表 S1 の段 4 へ |
| `acquired: false`（生きた持ち主・先の札） | 何も書かずに exit 0。stderr に `flow: tick skipped: held by <heldBy>` |
| `acquired: false` で `unknown` あり・例外 | 何も書かずに exit 1（札は部品が片付ける。F6） |

死んだ持ち主の回収・pid の再利用の判定は部品の挙動をそのまま使う（F6）。

### 3.2 runner（全部の外部の呼び出しが共有する）

```
runBounded(cmd, args, { deadlineMono, capMs }):
  budget = Math.floor(Math.min(capMs, deadlineMono − monoNow()))   // 先に切り下げる
  if (!Number.isFinite(budget) || budget <= 0) return { status: 'timeout', called: false }
  r = spawnSync(cmd, args, { timeout: budget, killSignal: 'SIGKILL', encoding: 'utf8', maxBuffer: 32 MiB })
  if (monoNow() >= deadlineMono || r.error?.code === 'ETIMEDOUT') return { status: 'timeout', called: true }
  return { status: r.status === 0 ? 'ok' : 'fail', stdout, stderr, called: true }
```

- 時計: 予算は単調な時計（`performance.now()`）。`at`・窓は壁時計。壁時計が巻き戻っても予算は変わらない
- 正の小数を確かめてから切り下げると 0 になる（原因調査 R5）ので、**切り下げてから**確かめる
- 締め切り: 識別（git）は CLI の開始から `identifyBudgetMs`（30 秒）、各 git は `capMs` 10 秒。`tick` の取得は排他を取った時刻 `T0` から `fetchBudgetMs`（200 秒）、各 gh は `capMs` 30 秒。呼び出しごとに予算を取り直さない（同じ締め切りから毎回計算する）
- `killSignal: 'SIGKILL'` なので子が SIGTERM を無視しても戻る（**見立て**: カーネルの中で止まった子は前提の外）
- runner の外の時間（排他の部品の中の `ps`（F8）・ローカルのファイルの読み書き）は上限を保証しない。CLI 全体の実時間の上限は主張しない

### 3.3 表 S1: `tick` の段

| 段 | 成功 | 失敗 | 予算切れ |
|---|---|---|---|
| 1 引数・設定（排他の前） | 2 へ | exit 2、何も書かない | — |
| 2 識別（git、排他の前、`identifyBudgetMs`） | 3 へ | exit 2（GitHub でない origin・base を決められない・git でない） | exit 2 |
| 3 排他（表 S0） | 4 へ | 表 S0 | — |
| 4 取得（`prCreated` → `prMerged`、runner） | 次へ | その指標を `null`・`why`。tick は続ける | 呼ばずに `timeout` |
| 5 形の検査・集計（純関数） | 6 へ | 形に落ちた指標を `null`（`schema`）。想定外の例外は段 8 へ（exit 1、書かない） | — |
| 6 末尾の確かめと 1 回の追記（§2.4） | 7 へ | 改行で終わらない・書けない: 書かずに段 8 へ（exit 1） | — |
| 7 （無し: 警報も通知も無い） | 8 へ | — | — |
| 8 終わり（1 回だけ） | `release()`。`released` なら要約を stdout に出して exit 0 | `release()` が例外・`released` 以外: stderr に 1 行、要約を出さずに exit 1（書いた行は残る。消さない） | — |

段 8 は `try … finally` の 1 か所で、exit を決めるのも 1 回だけ。段 4〜6 の途中の例外も段 8 に集める。

---

## 4. 外部の呼び出しごとの失敗の倒れ方（PR1a）

| 呼び出し | 上限 | 失敗・時間切れ・部分的な成功 | 倒れる向き |
|---|---|---|---|
| `gh pr list`（2 本） | 各 30 秒・取得の締め切り | 指標ごとに `null`・`why`（§2.3）。呼び直しは 0 回 | fail-open（未知として記録して続ける）。部分を確定値にしない |
| git（`remote get-url origin`・`rev-parse`・`symbolic-ref`） | 各 10 秒・識別の締め切り | exit 2、何も書かない。`fetch` はしない | fail-closed |
| `.commandmate/flow.yaml` | 64 KB | 無い＝既定値。読めない・壊れた YAML・知らないキー・型の誤り＝exit 2 | fail-closed |
| ロック | 0 秒 | 表 S0 | fail-closed |
| 記録の書き込み | 前提の外 | 改行で終わらない末尾・EACCES・ENOSPC・EROFS は exit 1、書かない | fail-closed |
| 記録の読み（`report`・`status`） | 1 ファイル 16 MB・合計 64 MB（超えたら `truncated` と表示し、その範囲の値を出さない） | 壊れた行・未確定の末尾は除いて数を表示 | 表示は確定した行だけ |

---

## 5. PR の切り方

### 5.1 この run の PR は PR1a だけ

危険の境目（F12）: PR1a は「読み取りだけの計測（PR の件数）と、計測の dir・ロックの root への書き込み」。状態を持つ警報・送信・画面は入れない。

### 5.2 外した経路と、後の PR で満たす条件

どれも PR1a に関数・設定キー・fixture・受入基準を置かない（P-11）。後の PR の契約は、ここの条件を設計の上流で閉じてから書く。

| 後の PR | 中身 | 満たす条件（ここが閉じるまで始めない） |
|---|---|---|
| PR-O 開いた PR の数 | 今の開いた PR の数（`openPrs`）。過去の時点の開いた PR は作らない | 照会の上限・形の検査は §2.3 と同じ。「過去の時点の開いた状態」を作るなら、その時点を覆う証拠（作成・閉じたの両方の照会の完全性）を V1 で示す |
| PR-C 今の CI・過去の CI（Issue の受入「CI の待ちの再現」はここ） | job の順番待ち | 必要な run／job の集合（全 status・attempt）を覆う証拠。run の作成日で切る照会は、その外の古い run の窓の中の job を否定できない（原因調査 §3.1、GitHub は 30 日以内の再実行を許す）。job の `created_at` の意味（**未確認**）。証明できなければ指標の意味を「取得した run に属する job」に限って別の名前にし、全期間の値と呼ばない |
| PR-L 台帳（WIP・着手→マージ。Issue の受入「WIP の再現」はここ） | orchestrate の台帳から | 台帳の dir は run の開始日で、lookback より前の dir に窓の中の新しい item がありうる（原因調査 §3.1）。母集団を覆う索引か開始残高を持つか、名前を「読んだ台帳に最初の send が見えた item」に限る。窓の外の first-send と窓の中の再 send・merge の組の扱い。外部の台帳の書き手（F1）に flow の行の境界の規則を仮定しない |
| PR-A 警報（`open-prs`・`no-merge`・`ci-queue`・`source-down`） | 状態を持つ確定 | (1) 警報の意味の選択（原因調査 §6 の N2: 変化の時だけの `fired`／`resolved` か、毎回の状態のスナップショットか）は PM／リーダーが決める（未決 U3）。(2) 変化で書くなら、前の状態を覆う証拠（checkpoint 等）。読む範囲の外の前状態を「初回 ok」にしない。(3) 落ちた tick の回復をするなら、排他を取った時点で前回までの対象を固定し今回の `tickId` を除き、メモリ上で前回→今回の順に適用して 1 回で書く（原因調査 §3.2）。しないなら前回の未確定は unknown のまま「回復した」と表示しない。(4) 連続 N 回は予定の観測の欠けを扱える意味にするか、「間隔の制限つきの連続した記録」へ意味を限る（`2 × interval` ちょうどの欠けを連続と読まない）。(5) 末尾の確定は §2.4 のまま |
| PR-N 通知（PM への send） | 改訂 1 の表 S4 の形（送る前の試行の印・結果不明も試行に数える・上限で打ち切り・`capture` の `isRunning` は送らない理由にだけ使う・配送の安全は既存の `send`） | PR-A の後。`alerts.notify` を明示した時だけ（共通の枠 §3） |
| PR-R 資源（load・ランナー・Docker・#4370 の `cpu.sem/events.jsonl`） | | 取得元ごとの完全性（ランナーの 0 は「読めて 0」だけ。Docker の不応答は値として扱う）。#4370 の出来事の読み（X3）は壊れた行・未確定の末尾を未知に |
| PR-W #4368 の WIP | `countWip` の結果を記録 | X8: `complete` が真の時だけ本数を確定値、偽は `null`（上側の数は別の名前で、警報に使わない）。`active: null` を 0 にしない |
| PR-D DB／API（`/api/metrics/vibe`・`/api/worktrees`） | エージェント（③）・verify・task | DB のファイルを開かない。サーバーが止まっていれば未知 |
| PR-S 常駐 | launchd 等で 15 分ごとの `tick` | 人の操作（H1）。PR1a の `tick` は 1 回動いて終わる |
| PR-P 公開・画面 | Artifact の試作・Flow のページ | §9。数だけ。欠測を 0・緑で埋めない |

---

## 6. この run で実装する PR1a の範囲（実装の契約にそのまま写す）

### 6.1 変更するファイル

| ファイル | 新規／変更 | 中身 | 見積り（行） |
|---|---|---|---|
| `scripts/flow/flow.mjs` | 新規 | 入口。`main(argv, deps)` を export（`deps`: `run`（runner の下の同期の呼び出し）・`monoNow`・`now`（壁時計）・`env`・`home`・`lock`（排他の部品の差し替え口）・`stdout`・`stderr`）。cmd は `tick`・`reconstruct`・`report`・`status` | 220 |
| `scripts/flow/runner.mjs` | 新規 | `runBounded`（§3.2）と、許可した外部のコマンドの検査 `isAllowedCall(cmd, args)`（§7 の T-I） | 80 |
| `scripts/flow/config.mjs` | 新規 | `readFlowConfig(repoRoot, { runBounded, env, deadlineMono, tz? })` → `{ repo, slug, base, exclude, tz }` か `{ error }`（`deadlineMono` は単調時計の絶対の締め切り。`tz` は `--tz`）。`repoSlug` もここ（`slug` を返すため。`record.mjs` が re-export）。許可するキーは `version`（1）・`repo`・`base`・`exclude`（文字列の配列、64 件以内。base と main／master を常に足す）・`tz`（IANA）。`alerts`・`wip`・`train`・`ledger` は「後の PR／他の子のキー」と名指して exit 2、ほかの知らないキーも exit 2 | 160 |
| `scripts/flow/record.mjs` | 新規 | `flowDirOf(env, home)`・`repoSlug(repo)`（re-export）・`appendTick(dir, tick, { tz })`（§2.4。ファイル名は `tz` での `at` の日付）・`readTicks(dir, scope, { from?, to?, maxFileBytes?, maxTotalBytes? })`（§2.4。`unfinishedFiles`・`corruptLines`・`truncatedFiles`・`unreadable` を返す） | 140 |
| `scripts/flow/sources.mjs` | 新規 | `readPrCounts(runBounded, { repo, base, window, deadlineMono, now? })` → `{ prCreated, prMerged, events }`（§2.3。例外を投げない）。`events` は各指標の窓の中の時刻の配列（失敗した指標は `null`）で、`tick` は使わず `reconstruct` が `hourlyPrCounts` に渡す（gh 2 本の結果から両 cmd への経路を 1 つにする） | 150 |
| `scripts/flow/aggregate.mjs` | 新規 | 純関数: `hourlyPrCounts(events, { from, to, tz })`（`reconstruct` の 2 列）・形の検査 `validatePrList`・窓（`tickWindow`・`dayWindow`・`searchDateRange`） | 90 |
| `tests/unit/scripts/flow/flow-fakes.ts` | 新規 | 試験の共通の差し替え（identification の git の表・gh の応答・時計・一時 dir） | — |
| `tests/unit/scripts/flow/config-4367.test.ts` | 新規 | T-I の設定と識別の行 | — |
| `tests/unit/scripts/flow/sources-4367.test.ts` | 新規 | T-P | — |
| `tests/unit/scripts/flow/record-4367.test.ts` | 新規 | T-L | — |
| `tests/unit/scripts/flow/cli-4367.test.ts` | 新規 | T-D・T-I の CLI の行・T-M（変異） | — |
| `tests/unit/scripts/flow/reconstruct-4367.test.ts` | 新規 | T-R（§8） | — |
| `tests/fixtures/flow/2026-11-13/created.json`・`merged.json`・`meta.json` | 新規 | §8.2 | — |
| `tests/setup.ts` | 変更 | `process.env.CM_FLOW_DIR = join(tmpdir(), 'commandmate-test-flow', String(process.pid));` | 3 |
| `changelog.d/4367.md` | 変更 | 1 本目（この設計）の項目へ統合（2 本目の work item） | — |

本体は約 840 行、試験を合わせて 1500〜2000 行（**見立て**）。改訂 1 の PR1a から、CI・台帳・load の取得、runs／jobs／ledger の fixture、`intervalSec`・`ledger.*` の設定、警報の関数を外した。

### 6.2 引数の契約（`node scripts/flow/flow.mjs <cmd> …`）

| 引数 | 受ける cmd | 形 | 誤りは exit 2 |
|---|---|---|---|
| `--repo-root <dir>` | 全部 | 既定 cwd。linked worktree でもよい | 存在しない・git でない |
| `--tz <IANA>` | 全部 | 設定の `tz` より優先。既定はプロセスの TZ | `Intl.DateTimeFormat` が受けない名前 |
| `--date <YYYY-MM-DD>` | `reconstruct` | `tz` での 0 時〜翌 0 時 | 暦にない日付・`--from` との併用 |
| `--from <ISO>`・`--to <ISO>` | `reconstruct`・`report` | 両方そろって `from < to`、幅 ≤ 31 日 | 片方だけ・逆・幅超え・時刻として読めない |
| `--json` | `reconstruct`・`report`・`status` | 出力を JSON に | — |
| それ以外（`--ledger-dir` も） | — | — | exit 2（PR1a に台帳は無い） |

`tick` は `--repo-root`・`--tz` だけ。exit は 0（成功・排他を取れずに飛ばした）／1（書けない・未確定の末尾・排他の観測不能・解放の例外・想定外）／2（引数・設定・識別）。

### 6.3 受入基準

1. `reconstruct --date 2026-11-13 --tz Asia/Tokyo` を fixture（`deps.run` が `meta.json` の照会に対応する応答を返す）で動かした出力が、§8.3 の表の 2 列の全セルと一致し、§8.4 の証人が全部成り立つ（値は観測できた件数、`complete: false`）
2. 実際の GitHub に対して同じ `reconstruct` を手で 1 回動かし、§8.3 と一致する（PR の説明に出力を貼る。CI では動かさない）
3. `tick` は排他を取り、`CM_FLOW_DIR` の下の `<repo-slug>/<日付>.jsonl` に §2.2 の形の 1 行だけを書く（窓の `to` は観測時刻の分の切り下げ − 10 分）
4. T-P・T-L・T-D・T-I の全行が通り、T-M の各変異が対応する行を赤にする（変異は試験の中の差し替えで作り、実装のファイルを書き換えない）
5. `report`・`status` は識別の git の外の外部を呼ばず、記録の dir を作らない
6. `src/`・`scripts/orchestrate/`・`.commandmate/verify.yaml`・`.github/` に変更が無い
7. Issue の受入のうち **WIP と CI の待ちの再現は PR1a では満たさない**（PR-L・PR-C）。PR の説明にそう書く
8. （改訂 3・R7）2 指標の記録と `reconstruct`・`report`・`status` の出力は `coverage: "search-observed"` を持ち、`complete` は常に false。正常な空の応答と 999 件の応答で `complete: true` を出す版が P1(b)・P3 で赤になる（created・merged の両方）

### 6.4 gates・scope・試験の隔離

- gates: `lint`・`typecheck`・`unit`（`tests/setup.ts` を変えるため）。手元の確かめ（`npx vitest run tests/unit/scripts/flow tests/unit/guards tests/unit/docs`・`npm run lint`・`npx tsc --noEmit`）は `unit` の代わりにならない
- scope.allow: `docs/design/flow-metrics-4367.md`（改訂 3 を同じ PR で）・`tests/unit/docs/**`・`scripts/flow/**`・`tests/unit/scripts/flow/**`・`tests/fixtures/flow/**`・`tests/setup.ts`・`changelog.d/4367.md`
- fixture を足すので、契約の生成の `touchesFixtures` の文に従う
- 隔離: 各 case は `fs.mkdtempSync(os.tmpdir())` の dir を `CM_FLOW_DIR`・`CM_VERIFY_LOCK_ROOT` として `deps.env` に渡し、`process.env` を変えたら `afterEach` で戻す。既定の home を試す case は `deps.home` も一時 dir にし、本物の home へ落とさない。実際の `gh`・`git` は呼ばない（`deps.run` の差し替え。linked worktree の行だけ一時 dir に `git init`・`git worktree add` してよい）

---

## 7. 試験の表（PR1a。行の形は `it.each` に写せる。実装はしない）

先に赤: 最初のコミットで各モジュールを `throw new Error('not implemented')` だけの export で置き、全行が赤になることを確かめる。これは呼んでいる証拠でしかないので、防御ごとの感度は T-M で示す。軸は原因調査 §7。PR1a に無い経路の軸（確定・再開、履歴）は §7.6 に「到達しない」と理由を書く。

### 7.1 T-P: 母集団（`prCreated`・`prMerged` × 下の行。V1。C2）

| # | 入力 | 期待 | 種 |
|---|---|---|---|
| P1(a) | 照会が exit 0・`[]`、かつ対象の集合を覆う証拠がある | PR1a には (a) の証拠の取り口が無いので到達しない（`complete: true` は出さない）。後の PR で証拠を足す時に陰性（本当の空＝0）として置く | — |
| P1(b) | 照会が exit 0・`[]`（索引の反映待ちを否定できない） | `value: 0`（観測した 0）・`coverage: "search-observed"`・`complete: false`。**`complete: true` を出す版は赤**（R7） | 陽性（R7）・陰性（観測値 0 は残る） |
| P2 | 3 件、全部窓の中 | 3・`complete: false` | 陰性 |
| P3 | 件数 999 | 窓の中の件数・`complete: false`。`complete: true` を出す版は赤（R7。既知の非空集合の対照） | 陽性（R7）・陰性（上限未満で値は出る） |
| P4 | 件数 1000（上限ちょうど） | `null`・`truncated` | 陽性 |
| P5 | exit 1（`HTTP 502`） | `null`・`fail` | 陽性 |
| P6 | exit 1（`HTTP 404`） | `null`・`denied` | 陽性 |
| P7 | 予算切れ（T-D） | `null`・`timeout` | 陽性 |
| P8 | JSON でない・配列でない | `null`・`schema` | 陽性 |
| P9 | 1 要素の `createdAt` が時刻でない／`number` が文字列／`baseRefName` が別の base | `null`・`schema` | 陽性（1 つでも落ちたら全体を確定しない） |
| P10 | 同じ `number` が 2 回、時刻が同じ | 1 つに数える | 陽性 |
| P11 | 同じ `number` が 2 回、時刻が違う | `null`・`conflict` | 陽性 |
| P12 | 日付に広げた照会が窓の外の PR を返す（`from` の 1 ms 前・`to` ちょうど） | 数えない（`[from, to)`） | 陽性 |
| P13 | `from` ちょうど・`to` の 1 ms 前 | 数える | 陽性 |
| P14 | `prCreated` は ok、`prMerged` は fail | `prCreated` だけ確定・`prMerged` は `null` | 陰性（片方の故障で他方は残る） |
| P15 | 同じ絶対の `from`・`to` を `tz` だけ変えて（UTC と Asia/Tokyo） | 時の分け方だけ変わり、窓の合計は同じ（`--date` を別の tz で評価すると窓そのものが違うので、この行は絶対の窓で比べる）。夏時間の日は 23・25 行 | 陰性 |
| P16（C1） | 記録・`report`・`status` に開いた PR・CI・台帳の列を求める | 「非対応」。0 にならない。取得の関数そのものが無い | 陽性 |
| P17 | 窓の前に作られ窓の中でマージされた PR（合成） | `prMerged` に入る（照会のキーは `merged`） | 陽性 |

### 7.2 T-L: 行の境界（V2。C4・C9）

ファイルの状態 × 次の書き手／読み手。

| # | ファイルの状態 | 書き手（`tick`） | 読み手（`report`・`status`） |
|---|---|---|---|
| L1 | 無い | 作って 1 行 | 「記録が無い」 |
| L2 | 空（0 バイト） | 1 行 | 「記録が無い」 |
| L3 | `A\n`（正常） | `A\nC\n`（1 回の追記） | A |
| L4 | `A\nB`、B は完全な JSON・改行だけ無い | 追記 0・元のバイト不変・exit 1・警告 | A だけ・未確定の末尾あり |
| L5 | `A\nB`、B は途中で切れた JSON | 同上 | 同上 |
| L6 | `B`（1 行目から改行無し） | 同上 | 記録 0・未確定の末尾あり（「記録が無い」と区別） |
| L7 | `A\nX\n`、X は JSON でない | 1 行追記（X は改行で終わるので境界は確定） | A と C・壊れた行 1 |
| L8 | `A\n` で `appendFileSync` が書く前に ENOSPC | exit 1・要約を出さない | A だけ |
| L8b | 前半だけ書けてから ENOSPC | 書き手は補修しない。次の書き手は未確定の末尾として追記しない | A だけ・未確定の末尾あり |
| L8c | 改行つきの 1 行が書けてから例外（close 等） | 書き手は `ok: false`（exit 1）。補修・再追記しない | A と C（V2: 改行で終わる行は確定） |
| L9 | L4 のあと人が直した（`A\n`） | 1 行追記 | A・C |
| L10 | 別の base の行 `A'\n` | 1 行追記 | 自分の scope の行だけ |
| L11 | 書き手の追記の後に解放が例外（F7） | 行は残る（消さない）・要約なし・exit 1 | 次の読み手はその行を確定として読む |

### 7.3 T-D: 期限（V3。C7・C9）

呼び出しの位置 × 予算 × 返った時刻。

| # | 位置 | 予算（切り下げた後） | 期待 |
|---|---|---|---|
| D1 | 識別の git | 負 | `run` を呼ばない（`called: false`）・exit 2 |
| D2 | 〃 | 0（0.5 ms を切り下げた） | 呼ばない |
| D3 | 〃 | 1 ms | `timeout: 1`・`killSignal: 'SIGKILL'` で呼ぶ |
| D4 | 1 本目の gh | 十分 | `timeout ≤ min(30000, 残り)`・正 |
| D5 | 2 本目の gh の直前に締め切りちょうど | 0 | 呼ばない・`prMerged: timeout` |
| D6 | 2 本目の gh | 締め切りの 1 ms 前に返る | 値を使う |
| D7 | 〃 | 締め切りちょうど・1 ms 後に返る | 捨てて `timeout`（記録は 1 行のまま） |
| D8 | 〃 | `deps.run` が throw | その指標を `fail`、tick は続く |
| D9 | 〃 | 壁時計が 1 時間戻る | 予算は単調な時計で決まり変わらない。窓は壁時計の `at` から |
| D10 | 段 5 で想定外の例外 | — | 書かずに exit 1・解放は 1 回 |
| D11 | 段 8 の `release()` が例外 | — | exit 1・stderr 1 行・要約なし・`release` は 1 回だけ呼ぶ |
| D12 | 呼び出しごと | — | 予算は毎回同じ締め切りから計算（取り直さない） |

### 7.4 T-I: 識別・設定・CLI（P-8・P-10・P-11。C8）

| # | 入力 | 期待 |
|---|---|---|
| I1 | `flow.yaml` 無し・`origin/develop` あり | `base=develop`・`exclude ⊇ {develop, main, master}` |
| I2 | 無し・develop 無し・`origin/HEAD → main` | `base=main` |
| I3 | 無し・どちらも無い | exit 2「base を決められない」 |
| I4 | `base: trunk`・`exclude: [release]` | `base=trunk`・`{release, trunk, main, master}` |
| I5 | 壊れた YAML／64 KB 超／EACCES／`version: 2` | exit 2、記録・ロック 0 |
| I6 | 知らないキー・`alerts`・`wip`・`train`・`ledger`・`intervalSec` | exit 2、キーを名指す（`wip` は「#4368 が足す」） |
| I7 | `exclude` が配列でない・65 件・要素が数 | exit 2 |
| I8 | origin `git@github.com:Kewton/CommandMate.git`／`https://github.com/Kewton/CommandMate(.git)` | `Kewton/CommandMate`・slug `kewton.commandmate` |
| I9 | origin が GitHub でない・origin 無し | exit 2、記録・ロック 0 |
| I10 | linked worktree から（`--git-common-dir` が相対で返る版を含む） | 同じ scope に着く |
| I11 | `report`・`status` × {設定あり, 無し} × {通常, linked} × {記録あり, 無し} | 正しい scope。`deps.run` が受けたのは許可した git だけ（gh・API・ロック・dir の作成・書き込み 0）。記録が無ければ「記録が無い」で exit 0 |
| I12 | `report`・`status` の識別が失敗・予算切れ | exit 2。全 repo・全 base へ広げない |
| I13 | `tick`・`reconstruct` が `deps.run` に出したもの | `git remote get-url origin`・`git rev-parse`（`--path-format=absolute --git-common-dir`／`--verify refs/remotes/origin/<b>`）・`git symbolic-ref refs/remotes/origin/HEAD`・`gh pr list`（`--search` は `created:`／`merged:` の範囲だけ、`--json` は §2.3 の欄だけ）だけ |
| I14 | §6.2 の誤りの各行・`--ledger-dir` | exit 2 |
| I15 | 生きた持ち主のロック | 何も書かずに exit 0・stderr 1 行 |
| I16 | 持ち主の pid が ESRCH | 部品が回収し tick を行う |
| I17 | 2 つの `tick` を同時に（本物の部品と一時の root） | 片方だけ書く、片方は exit 0 で飛ぶ |

### 7.5 T-M: 変異の対照（防御を 1 つずつ外すと赤）

| # | 外す防御 | 赤になる行 |
|---|---|---|
| M0（R7） | 正常な応答で `complete: true` を出す | P1(b)・P3 |
| M1 | 上限ちょうどでも値を出す | P4 |
| M2 | 失敗を 0 にする | P5〜P9 |
| M3 | 形の検査を全体でなく要素ごとに飛ばす | P9 |
| M4 | 半開区間を閉区間にする | P12 |
| M5 | 末尾に改行を足してから追記する（F1 の写し） | L4・L5・L6 |
| M6 | 読み手が改行の無い末尾を JSON として読む | L4 |
| M7 | 予算 0 で `run` を呼ぶ／正の小数を確かめてから切り下げる | D2・D5 |
| M8 | 締め切り後の結果を採る | D7 |
| M9 | `report`・`status` で gh を呼ぶ・dir を作る | I11 |
| M10 | 解放の例外を握りつぶして exit 0 | D11・L11 |
| M11 | 排他を外す | I15・I17 |
| M12 | 別の scope の行を読む | L10 |

### 7.6 到達しない軸（PR1a）

| 原因調査 §7 の軸・対照 | 到達しない理由 | 満たす PR |
|---|---|---|
| 確定・再開（前回 T／今回 C、印、alert の途中の落下）・C3 | PR1a に警報も回復も無い。記録は tick の 1 行だけで、落ちた tick は未確定の末尾として残り、次の書き手は追記しない（L4〜L6）。警報の記録は 0 | PR-A |
| 履歴（4 MB の外の前状態・予定の tick の欠け・`2 × interval`）・C5・C6 | 前状態を読まない。`status` は最新の観測を見せるだけで連続性を主張しない | PR-A |
| 照会の外の古い run の窓の中の job・古い dir の窓の中の新 item・窓の外の first-send（C1 の残り） | CI・台帳の取得が無い。P16 で「非対応」を 0 にしないことだけを固定する | PR-C・PR-L |

### 7.7 T-R: 再現（§8）

| # | 入力 | 期待 |
|---|---|---|
| R1 | fixture（`created.json`・`merged.json`）で `reconstruct --date 2026-11-13 --tz Asia/Tokyo` | §8.3 の 2 列 × 24 時の全セルと計 |
| R2 | §8.4 の W1〜W8 | 各 1 行 |
| R3 | `reconstruct` が `deps.run` へ出した照会と `meta.json` の照会 | 一致（取得の条件が fixture に結ばれている） |
| R4 | fixture の `merged.json` だけ exit 1 にする | マージの列は全時 `null`（`fail`）、作成の列は同じ（陰性） |

---

## 8. 2026-11-13 の実データからの再現（PR1a はマージ数と作成数だけ）

### 8.1 取得元と期間

- 期間: 2026-11-13 00:00〜24:00 JST（`tz=Asia/Tokyo`、時ごと）
- 設計の段の取得（2026-11-14、読み取りだけ）: `gh pr list --repo Kewton/CommandMate --base develop --state all --search "created:2026-11-12..2026-11-14" --limit 200 --json number,createdAt,mergedAt,closedAt,state`（49 本）と、`--search "created:<2026-11-12 closed:>=2026-11-12"`（1 本、#4312。11-12 13:24 JST に閉じたので 11-13 の値には効かない）。11-13 にマージされた PR はすべて 11-13 の作成で、マージされずに残った 11-13 作成の PR は無かった
- **PR1a の fixture は §2.3 の 2 本の照会（`created:2026-11-12..2026-11-13`・`merged:2026-11-12..2026-11-13`）の応答**（設計の段の照会は作成日で切っていて、窓の前に作られ窓の中でマージされた PR を一般には拾えない。この日は 0 本で、取り直した応答でも §8.3 の値は同じだった: **事実**、§8.2）
- WIP・CI の待ち・開いた PR の再現は PR1a の範囲外（§5.2 の PR-L・PR-C・PR-O）。改訂 1 の表のそれらの列は外した（その値は改訂 1 の §8.3 に残る。後の PR がそれぞれの完全性の条件を閉じてから、改めて期待値にする）

### 8.2 期待値の出し方と fixture への結び付け

**PR1a の fixture の出どころ（改訂 3、実装の段の事実）**: `tests/fixtures/flow/2026-11-13/` の `created.json`・`merged.json` は §2.3 の 2 本の照会の実際の `gh` の応答そのもの（開発リーダーが 2026-11-14T01:22:28Z に取得し、ワーカーが手元の記録から組み立てた仮のものを再指示 1 で差し替えた。`meta.json` の `fetchedAt`・`count`・`numbersSha256`・`provenance`）。受入 2（実際の GitHub に対する `reconstruct --date 2026-11-13 --tz Asia/Tokyo`）の出力は §8.3 と全セル一致し、差し替えた fixture でも T-R（§8.3 の全セル・§8.4 の証人）が通る

1. 期待値は計測の実装とは別の実装で出し、製品の集計で作り直さない。§8.3 は設計の段で Python の短いスクリプト（§2.3 の定義を直接書いたもの）で出した。このスクリプトと母集団の証跡は設計の PR に入っていない（scope の外）。独立した正しさは §8.4 の手計算の証人で補う
2. fixture に写すのは `number`・`createdAt`・`mergedAt`・`baseRefName` だけ（題名・ブランチ名は写さない）
3. `meta.json` に raw の取得条件を書く: 2 本の照会のコマンドと引数・取得した時刻（UTC）・件数・番号の集合の sha256。T-R は `reconstruct` が出す照会と `meta.json` の照会が一致することを確かめる
4. fixture を取り直して §8.3 と食い違ったら、どちらの定義の読みが違うかを先に確かめ、表を勝手に直さない（直すときは本書を改訂）

### 8.3 期待値（事実: 設計の段の取得。時は JST）

| 時 | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20 | 21 | 22 | 23 | 計 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| PR の作成 | 1 | 3 | 2 | 0 | 3 | 0 | 0 | 1 | 2 | 4 | 0 | 0 | 1 | 2 | 4 | 2 | 3 | 1 | 5 | 0 | 0 | 0 | 0 | 0 | 34 |
| マージ | 1 | 0 | 1 | 1 | 1 | 2 | 2 | 2 | 1 | 1 | 2 | 1 | 1 | 1 | 1 | 2 | 1 | 0 | 0 | 6 | 2 | 1 | 3 | 1 | 34 |

- Epic との照合: 16:40（#4349）の後 19:02（#4358）まで 0 で、Epic の「16:40〜18:57 マージ 0」と一致。Epic の「13 時 2/0」はここでは 2/1（13:05 の #4342 が Epic の窓 13:10〜の前。区切りの違い）

### 8.4 手計算の証人（T-R に 1 行ずつ）

| # | 証人 | 期待 |
|---|---|---|
| W1 | #4342 の `mergedAt` 13:05 JST | 13 時のマージ |
| W2 | #4340 の `mergedAt` 10:59:22 JST | 10 時（11 時でない） |
| W3 | #4361 の `mergedAt` 22:00:56 JST | 22 時（21 時でない） |
| W4 | #4349 16:40 の次は #4358 19:02 | 17・18 時のマージ 0 |
| W5 | 19 時の 6 本（#4358 19:02・#4359 19:03・#4356 19:06・#4360 19:06・#4362 19:08・#4352 19:10） | 19 時のマージ 6 |
| W6 | 合成: 18:59:59.999 と 19:00:00.000 のマージ | 18 時と 19 時に 1 つずつ |
| W7 | 合成: 窓の前（11-12 23:50 JST）に作られ 11-13 00:10 にマージ | マージは 0 時に 1、作成は数えない |
| W8 | 合成: 11-14 00:00:00.000 JST ちょうどのマージ | 11-13 の窓に入らない |

---

## 9. ダッシュボードの第 1 段（推奨）

**推奨: 第 1 段は Artifact の試作。載せるのは数だけ（PR 番号・ブランチ名・題名・パスを載せない）。画面は試作で決まってから PR-P で作る。**

- 理由: 何を一目で見せるかがまだ決まっていない。製品の画面で試すと決め直すたびに画面の PR とレビューが回る。Artifact なら PM が `report --json` から作り直せる
- 入力（PR1a で出せるもの）: `report --json` の観測（24 時間の窓ごとの作成・マージの数）と `reconstruct --json` の時ごとの 2 列。`null` は欠測として描き、0 や緑で埋めない。PR1a に無い区画（WIP・詰まり・資源・品質・警報）は「未計測」と描く
- 区画の順: 健康（欠測が 1 つでもあれば灰）→ 流れ（時ごとのマージ数と作成数）→ ほかは後の PR が入るたびに足す
- 受入（試作の段）: 幅 1280 と 390 で健康と流れがスクロールせずに読める
- 人の判断（H4）: Artifact は claude.ai に置かれる（外へ出る）

---

## 10. 人の操作・人の判断

実機への導入（launchd・設定ファイルのコミット・Artifact の公開）はこの run の範囲外。どれも PR1a の実装を止めない（突き合わせの決定の「人の判断」の節）。

| # | 判断 | 推奨と理由 |
|---|---|---|
| H1 | 15 分ごとの `tick` を何で起こすか | **launchd の利用者の agent**（PR-S）。サーバー・エージェント・Docker が止まった時こそ動いていなければならない |
| H2 | 警報の閾値の既定（PR-A） | Epic の「運用で先に入れること」の値（開いた PR 5・60 分・15 分） |
| H3 | 台帳の場所（PR-L） | `flow.yaml` の `ledger.runsDir`（主 worktree の root から）。このリポジトリへの `flow.yaml` のコミットは人の承認の後（X7） |
| H4 | 外（Artifact）へ出す範囲 | 数だけ |
| H5 | 警報の送り先（PR-N） | 入っても最初の 1 週は送らない |
| H6 | 記録の保存期間 | 当面は消さない |
| H7 | ランナーの API の権限（PR-R） | 今の資格。403 は `denied` |
| H8 | 改行の無い末尾が残った記録のファイルの直し方 | **人が直す**（末尾を確かめて切り詰めるか、ファイルを脇へ移す）。自動の修復は入れない（原因調査 §6 の N3: 確定した前半を失わず未確定の後半を戻さない修復は新しい状態機械になる）。`status` が「未確定の末尾あり」と出したら PM が人に伝える。自動にするなら別の Issue で設計する |

---

## 11. 他の子への約束

突き合わせの決定 X1〜X10 に従う。PR1a が提供するのは設定の読み手と記録の書き手・読み手だけ。

| 相手 | 提供／利用 | 形 | 単位・意味 |
|---|---|---|---|
| #4368（WIP） | #4367 が**提供** | `scripts/flow/config.mjs` の `readFlowConfig`（`repo`・`base`・`exclude`・`tz`）。#4368 PR1 は #4367 PR1a のブランチから切り、`wip` 節を同じ読み手の許可へ足す（X1・X6） | scope は `repo`＋`base`。PR1a は `wip` を exit 2 で拒み、その試験の行（T-I の I6）は **#4368 PR1 が `wip` を許可する時に同じ PR で直す**（X9。#4368 の scope に入れる） |
| #4368 | #4367 が**利用**（PR-W） | `countWip` の配列（`unmerged`・`active`・`unknown`・`excluded`）と `complete` | X8: `complete` が真の時だけ本数を確定値、偽は `null`。上側の数は別のフィールドで警報に使わない。`active: null` を 0 にしない |
| #4369（merge train） | #4367 が**提供**（記録の書き手） | `kind: train` は **#4369 PR3 が呼び手と同じ PR で `record.mjs` に足す**（X2）。語彙は #4369 の語彙（`created`・`pushed`・`ci`・`merged`・`dropped`・`rebuilt`・`stopped`） | 書き手の行の境界は §2.4 と同じ（改行で終わらない末尾があれば追記しない・補修しない）。**書けなくても train は止めない**。計測の記録を train の判定に使わない（V3） |
| #4370（資源） | #4367 が**利用**（PR-R） | #4370 の `<lock root>/cpu.sem/events.jsonl` を読む（X3） | 壊れた行・改行の無い末尾は未知。#4370 の書き手に flow の行の境界の規則を仮定しない |
| #4370 | #4367 が**提供** | 計測の記録を `readTicks` で読んでよい | `null` を 0・空きと読まない。計測の値を受付・枠・マージの許可に使わない（V3、X10） |
| 全員 | 共通 | 警報は「記録＋画面」が先、PM への送信は `alerts.notify` を明示した時だけ（共通の枠 §3。PR-A・PR-N） | — |

---

## 12. 既存の仕組みの再利用の可否

| 既存 | 使う／使わない | 理由 |
|---|---|---|
| `run-log.mjs` の書き手・読み手 | **使わない・写さない** | 改行を足す補修は未確定の末尾を後から確定させる（F1、V2） |
| `pr-common.mjs` の `withGhRetry`・`ghJson`・`defaultRun`・`DEFAULT_REPO` | 使わない | F2・F3 |
| `pr-common.mjs` の `GH_TRANSIENT_PATTERN` | 写す（`why` の分類だけ） | — |
| `merge-pr.mjs` の `mergeLockName` | 形を写す（repo-slug） | F5 |
| `machine-lock-sync.mjs` の `acquireMachineLockSync` | **使う**（`flow.<repo-slug>`、`timeoutMs: 0`） | F6・F7 |
| `precheck.mjs` の `machineLockRoot` | 使う | F9 |
| `merge.*`・`cpu.heavy` | 使わない | V3 |
| `metrics-runners.ts` の `runCommand`・`ci-flaky.ts` | 使わない | 非同期で TS（`.mjs` から使えない）。CI は PR-C |

---

## 13. 未確認・見立て・未決と、本文に無い指摘

### 13.1 未確認

- Node の `spawnSync` の `timeout: 0` の挙動（F4。原因調査の確認に拠る）
- GitHub の検索の索引の遅れ（§2.3）
- 日付に広げた `created:`／`merged:` の検索が、時刻の境界をどう扱うか（広げてから絞るので結果には効かない見込み: 見立て）
- `report`・`status` の識別に、主 worktree の root が要るか（PR1a は台帳を読まないので要らない見込み。I10 で確かめる）

### 13.2 見立て

- PR1a は本体約 840 行・試験を合わせて 1500〜2000 行
- 15 分の間隔では tick が重ならない
- `SIGKILL` なら子はカーネルの中で止まっていない限り戻る

### 13.3 未決（誰が決めるか）

| # | 未決 | 決める人 | 本書の仮の値 |
|---|---|---|---|
| U1 | GitHub でない origin の識別 | 開発リーダー（必要になった時に別の Issue で） | exit 2 |
| U2 | 検索の索引の遅れに合わせて窓の `to` を後ろへずらすか・その値 | **決定（改訂 3、開発リーダー）**: tick の既定の `to` は観測時刻の分の切り下げ − 10 分。見立てであって保証ではない（値は観測できた件数のまま） | − 10 分 |
| U3 | 警報の意味（変化の時だけの遷移か、毎回の状態のスナップショットか。原因調査 §6 の N2） | PM／開発リーダー（PR-A の上流の前に） | 決めない。PR1a に警報は無い |
| U4 | 落ちた後の末尾の自動の修復を入れるか | 開発リーダー（別の Issue で設計） | 入れない。人が直す（H8） |
| U5 | CI の順番待ちを attempt の最新だけで数えるか | PM（PR-C で） | 決めない |
| U6 | 予算の値（識別 30 秒・取得 200 秒・各 gh 30 秒・各 git 10 秒） | H1 の後に PM | この値 |

### 13.4 本文に無い指摘（直さない）

- Issue の受入「2026-11-13 の実データから、時間ごとのマージ数・WIP・CI の待ちが再現される」は、PR1a ではマージ数（と作成数）だけを満たす。WIP・CI の待ちは PR-L・PR-C の完全性の条件が閉じてから
- Epic の時間帯ごとの数は窓の区切り（13:10〜）で、時の区切りと 13 時だけ違う。Epic の「CI の中央値 22 分・最長 78 分」の定義は書かれていない

---

## 14. 処置の記録

### 14.0 改訂 3（再レビュー 3 `prereview-4367-3-reply.md`・開発リーダーの R7 の処分。PR1a の実装と同じ PR）

| 指摘 | 処分 | 反映した場所 |
|---|---|---|
| R7（検索で返った集合の正常性を母集団の完全性へ進める。F1→R1 と同じ種類の 3 回目） | **狭めて塞ぐ**: 2 指標を「検索で観測できた件数」と定義し、`coverage: "search-observed"` を記録と出力に持たせ、`complete` は常に false。表示は「観測した件数（検索） — 母集団の完全な数ではない」。失敗・上限・型の誤りは `null` | P-2・§2.2・§2.3・§2.5・§6.3 の 8・§7.1 の P1(a)(b)・P3・M0 |
| R7 の猶予 | tick の既定の `to` を観測時刻の分の切り下げ − 10 分。見立てであって保証ではないと書いた | §2.2・§2.3・U2 |
| P3 補記: reconstruct のデータと期限 | `readPrCounts` が窓の中の時刻（`events`）も返し、`hourlyPrCounts` へ渡す。`reconstruct` の取得の締め切りは識別の後の単調時計 + 200 秒 | §2.5・§6.1 |
| P3 補記: 部分 append と一度の終端 | L8b（前半だけ書けた）・L8c（1 行書けてから例外）を足した。段 5・6 が exit 1 を選んだ後の解放の成功で exit 0 にしない対照を足した | §7.2・試験 |
| P3 補記: 読み手の不明 | 記録の dir を読めない（EACCES 等）は exit 1 で「記録が無い」と分ける。上限で読まなかったファイルを JSON と表示に残し、それより新しい観測があり得る時は最新を出さない。16 MB・64 MB の対照は上限を差し替えて試す | §2.5・試験 |
| P3 補記: 日時 | P15 を絶対の窓で比べる行にした。時の鍵にオフセットを持たせ、夏時間の 23・25 行を試験に置いた | §2.5・§7.1 P15 |
| P3 補記: 共有の読み手の引渡し | `readFlowConfig` の引数に `deadlineMono`（単調時計の絶対の締め切り）と `tz` を明記した | §6.1 |
| P3 補記: fixture | 開発リーダーが §2.3 の 2 本の照会の実際の gh の応答を取り、ワーカーの組み立て（推定 2 件を含む）を差し替えた（再指示 1）。受入 2 の実出力と §8.3 は全セル一致 | §8.2 |

### 14.1 改訂 2（再レビュー `prereview-4367-2-reply.md`・原因調査 `enabler-return-4367-cause.md`・再指示 2）

| 指摘 | 処分 | 反映した場所 |
|---|---|---|
| 原因調査 §5 の不変条件 3 文 | 最上位に置いた（I-0 を置き換え） | §1.1 |
| R1（lookback の内側だけで外側を否定）・F1 の 2 回目 | **狭めて塞ぐ**: PR1a から過去の CI・台帳を外した。照会のキーとイベントの時刻が同じ PR の 2 指標だけにした。外した経路の条件は PR-C・PR-L に | §2.3・§5.2・T-P・§7.6 |
| R2（回復の対象が今回の tick で上書き）・F3 の 2 回目 | PR1a から警報と回復を外した。回復する時の手順（前回までを固定・今回を除く・メモリ上で順に適用・1 回で書く）は PR-A の条件に | §5.2 PR-A・§7.6 |
| R3（改行を足すだけでは途中行を捨てたことにならない）・F3 の 2 回目 | 改行を確定の境界にし、書き手は改行で終わらない末尾があれば追記しない・補修しない、読み手は未確定として除く。自動の修復は入れない（H8・U4） | P-4・P-5・§2.4・T-L・M5・M6 |
| R4（履歴の欠けを初期状態・連続性へ）・F4 の 2 回目 | PR1a から警報を外した。前状態を覆う証拠・連続の意味は PR-A の条件に | §5.2 PR-A・§7.6 |
| R5（残予算 0 が時間切れ無し）・F5 の 2 回目 | 全部の外部の呼び出しが共有する runner で、切り下げた後の予算が正の時だけ呼ぶ。単調な時計。呼び出しごとに取り直さない | §3.2・P-6・T-D・M7 |
| R6（`report`・`status` の識別） | 識別の git（時間制限つき・許可した引数）だけを許し、gh・API・ロック・書き込みをしない。失敗は exit 2 | P-8・§2.5・T-I の I11・I12 |
| 再指示 2「外す」 | 今の CI・過去の CI・台帳・警報・通知・資源・DB／API・常駐・公開を PR1a から外し、関数・設定キー・fixture・受入を残さない。開いた PR の数も外した（PR-O） | §5.2・§6.1 |
| 再指示 2「受入」 | PR1a はマージ数と作成数だけ。WIP・CI の待ちは後の PR | §6.3 の 7・§8・§13.4 |
| 再指示 2「#4368 との約束」 | X1・X6・X8・X9 を保った | §11 |
| 原因調査 §7（全組み合わせの軸・必須の対照 C1〜C9） | PR1a の表に写し、到達しない軸は理由と満たす PR を書いた | §7 |

### 14.2 改訂 1（事前レビュー `prereview-4367-reply.md`・再指示 1）

F1〜F6 と P3 を、完全性・scope・排他と tick ID・取得元の健康・期限・通知の試行の記録で直した（`9240bffd0`）。改訂 2 で、そのうち scope（F2）・排他（F3 の一部）・通知の試行（F6、PR-N の条件）を残し、ほかは PR1a を狭めて塞ぐか後の PR の条件に移した。

---

## 改訂の履歴

- 改訂 1（2026-11-14）: 事前レビュー（codex-2、P2 6 件）と再指示 1・突き合わせの決定 X1〜X7 を反映。I-0 を最上位に、PR1 を PR1a（計測）・PR1b（警報）に分け、完全性・scope・排他と tick ID・取得元の健康・期限・通知の試行の記録を決め、変異の対照と再現の証人を足した
- 改訂 2（2026-11-14）: 再レビュー（P2 6 件、同じ種類の 2 回目）と原因調査・再指示 2 を反映。原因調査 §5 の 3 文を最上位に置き、PR1a を PR の作成数・マージ数の計測と記録と読み取りへ狭め（改行を確定の境界にして補修しない・正の予算を強制する runner・`report`／`status` は識別の git だけ）、外した経路の条件を §5.2 に残し、試験の表を原因調査 §7 の軸で作り直した
- 改訂 3（2026-11-14）: 再レビュー 3 の R7 の処分（2 指標を検索で観測できた件数に限り `complete` を常に false、猶予 10 分は見立て）と P3 の補記を、PR1a の実装と同じ PR で反映（§14.0）
