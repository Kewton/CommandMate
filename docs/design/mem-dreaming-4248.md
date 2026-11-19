# 作業の外で Agent が mem をまとめ直し、人が承認する提案として出す（dreaming）（Issue #4248）設計

- 段: 設計（この文書だけ）。コード・DB・試験は書かない。実装は、§11 の人の答えと設計レビューの処分の後に、§10 の PR ごとに別の契約で行う（Sprint 9 前半・Sprint 10 後半）
- 版: 第 2 版（2026-11-19、イネーブラー claude-5）
  - 第 2 版: 設計レビュー 2 本の処分を反映した。処分の表は §13
    - A: 安全、`workspace/orchestration/runs/2026-11-19/s8/review-4248-a.md`、P1 2・P2 7・P3 7
    - B: 被覆・整合・PR の分け方、`review-4248-b.md`、P1 3・P2 9・P3 6
  - 第 1 版: `54246d925`
- 基準: develop `b8f6e33b8`（v0.53.0）。行番号はこの版のもの。「事実」は file:line、「見立て」「未確認」は明記する
- 正: Issue #4248 の本文（範囲 1〜9・受入基準・やらないこと）と追記（2026-11-15）。Epic #4220 の決定 D1〜D13
- 入力: #4354 の設計（`docs/design/mem-approval-4354.md` 第 3.1 版）の §6
  - この設計は #4354 の推奨（案 1・P-a）と、PM の決定（Q3〜Q8）を前提にする
  - **dreaming は許可（行き先なし・期限つきの decision）を起案しない**（§7.1、レビュー A P1-2）。#4354 §6 の 2 も、この形に直した
- 参照する既存の設計: `mem-store-4221.md`（A）・`mem-close-when-4222.md`（B）・`brief-4223.md`（C）・`mem-promote-4225.md`（E）・`mem-ui-4227.md`（G）・`mem-skills-4228.md`（H）
- 覆う項目: `enabler-s8-filemap.md` の「#4248 の設計の成果物が覆うべきこと」の 12 項目（対応は §0.2）

---

## 0. 冒頭

### 0.1 やらないこと（Issue の再掲。設計のすべての節がこれに従う）

1. 提案を人の承認なしに確定すること。承認の割合が高い種類の自動の確定は、記録がたまってから別 Issue で考える
2. CommandMate が Schedule の行を自動で足すこと、新しい定期の実行や常駐の見張り（タイマー）を足すこと（D13）
3. 会話の記録の本文を DB に写すこと、会話の記録を検索する汎用の CLI
4. ブランチをまたぐまとめ直し、資料の全体から wiki を作ること
5. 再現の資料に、実際の会話・項目・モデル名を載せること（架空の例で足りる）
6. mem・brief・check・`dream-input`・`dream-read` がモデルや外部の生成を呼ぶこと（D1・D13）
7. 失敗したときに別のモデルへ自動で移ること（D13）
8. 期限の許可・`promoted` の片付けを提案すること（#4354 が持つ）
9. **許可（行き先なし・期限つきの decision）を作る・延ばす・変える提案、decision を対象にした言い直し・閉じる・まとめる提案**（§7.1）

### 0.2 12 項目と節の対応

| # | 項目 | 節 |
|---|---|---|
| 1 | 起動の識別・CLI を起動する前の検査・理由つきの skip | §2 |
| 2 | 身元と権限（run の token・通る口・ツールの表・保証の範囲） | §3 |
| 3 | 材料 `mem dream-input` | §4 |
| 4 | 根拠 `mem dream-read <ref>` | §5 |
| 5 | 出力の取り込み | §6 |
| 6 | 提案の schema（G と共通） | §7 |
| 7 | 排他と確定の単位・DB の表と migration の分け方 | §8 |
| 8 | 記録 `mem dream list` | §9 |
| 9 | 依存 Issue（A・B・C・E・G・H）へ加える契約 | §9.3 |
| 10 | 追記（まとめての承認・拒否、2 週間の計測、#4354 の前提） | §7.4・§9.2 |
| 11 | 脅威モデルと受入基準の対応表、Sprint 9・10 の PR の分け方と陽性対照 | §1・§10 |
| 12 | 人に伺う点 | §11 |

### 0.3 全体の流れ

```
利用者の CMATE.md の Schedule の行（Purpose: mem-dream）
  └─ job-executor: 機能の旗（§2.4）が off → skip（not_enabled）
       └─ 起動の前の検査（§2.3）── 欠け → skip（理由つき。子を起動しない）
            └─ 排他の取得（§8.1）・run の行と token の発行（§3.1）
                 └─ 子の claude（CommandMate が固定で組む argv、§3.3）
                      ├─ commandmate mem dream-input（token）→ 材料（§4）── 変化なし → NOOP
                      ├─ commandmate mem dream-read <ref>（token）→ 根拠（§5）
                      └─ 最後の答え = 提案の JSON（§6・§7）
            └─ 取り込み（§6）: 形の検査・秘密の検査 → 確定のトランザクション（§8.2）
                 失敗なら → 別のトランザクションで失敗の記録・token の失効・排他の解放
            └─ 提案は人が画面で承認・拒否（§7.3・§7.4）
```

---

## 1. 脅威モデルと受入基準の対応

### 1.1 守るもの・守らないもの

| 守る（保証の形を持つ） | 守らない（限界として書く） |
|---|---|
| 子の claude が、CommandMate の組む argv（§3.3）のもとで、許可した 2 つのコマンドのほかの道具・コマンド・設定・hooks・MCP・skill を使えないこと。S9-0 の実機の確認の範囲で | 同じ OS 権限の子が DB・ファイルを直に書き換えること（A §11.3 と同じ限界） |
| dream の 2 つの口が、dream token の範囲（run の repository＋ブランチ・snapshot）の外を返さないこと。token なしでは、認証の有無にかかわらず 401 | サーバーの認証が無効（既定）・`remote-only`（`src/middleware.ts:163-168`）のとき、ローカルのプロセスが通常の API を呼べること。この構成では、上の argv の制限だけが子の守り |
| 提案が人の承認なしに確定しないこと。ただし承認の API の守りは `screen_only` の見出し（`src/lib/security/screen-request.ts:52-67`）で、ローカルのプロセスは偽れる。偽れる構成（認証なし・`remote-only`）では、子への argv の制限が唯一の守り | 根拠が結論を支えるかどうか（人が見る。機械の検査は、形・権限・版・範囲・保存まで） |
| 秘密らしい文字列（今の規則、run の token の値・`CM_*` の値の完全一致を含む）を、保存の前と表示の前に伏せること | 規則に無い形の秘密（エントロピーだけの判定はしない、A §6.1） |
| 同じブランチで 2 本の run が同時に確定しないこと | ツール自体の不具合（許可の外の道具が通る等）。S9-0 で確かめた版の範囲の外 |

### 1.2 脅威と受入基準の対応表

| # | 脅威 | 対策 | 受入基準（Issue） | 試験の層と陰性対照（PR） |
|---|---|---|---|---|
| T1 | 材料の中の文が子への命令として働く（注入） | データの区画（D12）。子の道具を 2 つのコマンドに絞る（§3.3）。提案は人が承認する。手順は固定の文で渡す | 人が固定の例で根拠を辿って拒否できる | e2e（S10-4）。S9-0 で、注入の文を含む fixture のもとで、許可の外の Bash が断られる実機の記録（軽減の実測） |
| T2 | token の転用・再使用・遅い出力 | token は run の行に結ぶ。保存はハッシュ（比較は `timingSafeEqual`）。取り込みは `execution_log_id` で run を引き、出力の中の token を読まない（§6.1）。消費・失効の後は断る | 別の execution-log への転用・期限切れ・使用済みを受け付けない | 結合（S9-2・S9-3）: 他の run の token・期限切れ・消費の後の `dream-input`・`dream-read` が 401／403 |
| T3 | 子が通常の API・ファイルで mem や外を書く | argv の固定（§3.3）、dream token は dream の 2 つの route だけ、`CM_AUTH_TOKEN` を戻さない（`src/lib/security/env-sanitizer.ts:147`） | token で読め、更新・mode・purge・承認・外への書き込みは断られる | 結合（S9-3）: **全 API の route の一覧を回し、dream token だけを付けて 401**（変異: middleware の除外を前方一致に広げると赤）。dream token と偽の screen の見出しで承認の API が断られる（認証あり、S10-3） |
| T4 | 出力の偽装・混入 | 生の stdout から 1 つの JSON だけを受ける。切り詰めはバイト数と `maxBuffer` の error code で判定（§6.1） | 切り詰め・警告・JSON の外・2 つの JSON・失敗や時間切れは提案にならず、位置が進まない | 単体（S10-1）: 境界の値の表 |
| T5 | 秘密の漏れ | 保存の前・表示の前の検査。`dream-read` の本文にも同じ規則をかける（§5） | 秘密らしい文字列が記録と画面に原文で残らない（100KB の境界・日本語を含む） | 単体＋結合（S9-4・S10-1）: `execution_logs` の行と `dream-read` の応答を読む |
| T6 | 古い版への提案が確定する | 確定のときに版・kind・状態・行き先・期限の印を照らす。merge は全部が一致したときだけ | 古い版は競合。merge で 1 つでも違えば何もしない | 単体（S10-3）: 照らし直しを外すと確定して赤 |
| T7 | 同じブランチの 2 本の同時の実行 | repository＋ブランチの期限つきの排他（§8.1） | 後の 1 本は skip。止まった run の排他は期限で戻る | 結合（S9-2） |
| T8 | 取り込みの途中の DB の失敗 | 確定のトランザクションと、失敗の記録のトランザクションを分ける（§8.2）。**回復は「次の cron の回の再 run」と定義する**（生の出力は保持しない。位置を進めないので同じ範囲を取り直す） | 保存の途中で DB が失敗しても、重複せずに回復する（「回復」はこの定義で読む） | 結合（S10-2）: 確定の途中で失敗を注入 → 提案 0・run は `failed`・位置は同じ。次の run が同じ範囲を渡す |
| T9 | run の途中で mode が off・ブランチが切り替わる | 取り込みと確定のときに mode と所属を照らし直す | 起動の後の mode off・ブランチの切り替えの出力は断られる | 結合（S10-2: 取り込み、S10-3: 承認）: 照らし直しを外すと確定して赤 |
| T10 | 副作用（材料の読みで項目が閉じる・知らせが消える） | `dream-input` が呼んでよい関数と、呼んではならない関数を名指す（§4.2） | run の前後で項目・知らせ・受領が変わらない | 結合（S9-3）: 期限切れの許可・条件の成立した項目を含む fixture。spy で禁止の関数が 0 回 |
| T11 | 承認の詰まり | 1 回の提案の上限、まとめての拒否・種類ごとの承認、2 週間の計測 | 未判断の推移が `mem dream list --json` で読める。まとめての承認・拒否で古い版だけが競合になる | 結合（S10-3）＋e2e（S10-4: 画面のまとめての操作） |
| T12 | 外部の生成の混入 | 既存の「モデルを呼ばない」の表に行を足す | mem・brief・check・`dream-input`・`dream-read` がモデルを呼ばない | 単体（S9-3・S9-4・S10-1）: spy |
| T13 | dreaming が許可を作る・延ばす・人の決定を書き換える（レビュー A P1-2） | 提案の対象と欄を store 層の関数で限る（§7.1）。取り込みと確定の両方で検査する | （Issue の範囲 6 の「`recorded`・`promoted` を指定できない」の拡張） | 単体（S10-2・S10-3）: 禁止の形の表。取り込みだけ・確定だけの検査を外す変異でそれぞれ赤 |
| T14 | 機能が仕上がる前の dreaming の行が、守りなしに通常の Schedule として走る（レビュー B P1-1・P2-1） | 機能の旗（§2.4）。Purpose を落とす書き手を作らない | — | 結合（S9-1）: 旗が off で起動 0。CMATE.md の書き手が Purpose を保つ |

---

## 2. 起動の識別と、CLI を起動する前の検査（項目 1）

### 2.1 事実

- Schedules の表の列は `| Name | Cron | Message | CLI Tool | Enabled |` と、任意の権限の列（`src/lib/cmate-parser.ts:196-272`）
  - 列は位置で読む。見出しの行は読み飛ばす（`:161-164`）
  - `ScheduleEntry` に用途の欄は無い（`src/types/cmate.ts:48-61`）
- 実行は `executeSchedule`（`src/lib/job-executor.ts:238-311`）
  - 出力はそのまま `execution_logs.result` に書く（`:298`）
  - コメント（`:296-297`）が「失敗の理由が出力の頭に入るので、要約にしない」と固定している（#2253）
- 同じ Schedule の重なりは `state.isExecuting` で止める（`job-executor.ts:242-245`）
- CMATE.md の同期で entry が差し替わっても、実行中の run は開始時の entry のまま進む（#4436 I1a、`job-executor.ts:225-230`）

### 2.2 識別

- Schedules の表に任意の列 `Purpose` を足し、**見出しの名前で読む**（PM の決定。parser に見出しの読み取りを足す）。値が `mem-dream` の行だけを dreaming の行とする
- `ScheduleEntry` に `purpose: 'mem-dream' | null` を足す。DB の列は足さない（entry は CMATE.md の同期から来る）
- **Purpose を落とさない（レビュー B P2-1、T14）**:
  - CMATE.md の書き手（`cmate-writer.ts`・画面の編集・`batchUpsertSchedules`）が、未知の列と Purpose を保つことを試験で固定する（S9-1）
  - 書き手が Purpose を落とすと、dreaming の行が通常の行に戻り、読むだけでない設定で走る（fail-open）。これを防ぐ
- 子への本文は**固定の文だけ**（材料は必ず `dream-input` から取る）。`Message` の列は使わない（PM の決定）
- 判定は run の開始時に 1 回だけ行う。同じ entry のまま最後まで通す（§2.1 の I1a と同じ）

### 2.3 起動の前の検査（子のプロセスを起動する前。欠けたら skip）

`executeSchedule` の中に dreaming の分岐を置く。`createExecutionLog` の後、`executeClaudeCommand` の前に、次を順に確かめる。dreaming 専用の実行の関数に分け、通常の Schedule の経路は変えない。

| 順 | 検査 | 欠けたときの理由（固定の語） |
|---|---|---|
| 0 | 機能の旗が on（§2.4） | `not_enabled` |
| 1 | worktree から `repository_id` とブランチを決められる（A の規則） | `branch_unresolved`・`ambiguous` |
| 2 | そのブランチの mode が `on` | `mode_not_on` |
| 3 | 行の CLI ツールが §3.3 の表で対象 | `tool_not_supported` |
| 4 | ツールの利用方針（antigravity は対象外。#4436 の柵と同じ） | `tool_policy_denied` |
| 5 | 前回のこのブランチの run の終了から 60 分以上たっている（タイマーではなく、比較だけ。レビュー A P3-7） | `too_frequent` |
| 6 | その日のこのブランチの run の数が、上限（§11 H2）の内 | `daily_limit` |
| 7 | 同じ repository＋ブランチの排他を取れた（§8.1） | `lease_held` |
| 8 | 組んだ argv が §3.3 の形と一致する（組み立ての関数の自己検査） | `argv_mismatch` |

- 欠けたときは子を起動しない
  - `execution_logs` の行は `cancelled`（既存の値、`job-executor.ts:38`）。`result` に「dreaming skipped: <理由の語>」を書く
  - `dream_runs` に `skipped` と理由を残す
  - 状態の対応: `dream_runs` の `skipped` は `execution_logs` の `cancelled`、`noop`・`succeeded` は `completed`、`failed` は `failed`・`timeout`（レビュー B P3-6）
- **役割（role）を適用しない**（レビュー A P2-6）
  - dreaming の行では `resolveScheduleRole` の args・env を子に渡さない
  - `CM_DREAM_TOKEN` は、env の組み立ての最後に書く（`RUN_ORIGIN_ENV` の前例、`claude-executor.ts:1023-1030`）
  - argv と env は単体試験で固定する

### 2.4 機能の旗（レビュー B P1-1、T14）

- サーバーの環境変数 `CM_MEM_DREAM`（名前は見立て）を足す。既定は off
- off のとき:
  - Purpose が `mem-dream` の行は、**常に**子を起動せず `not_enabled` で skip する
  - 通常の Schedule としても走らせない
- Sprint 9 の途中（token・argv・取り込みが揃う前）に入った部品は、旗が off のあいだは起動に届かない。各 PR を独立に戻せる
- 旗を on にしてよいのは S10-4 のマージの後。既定を on にするかは人が決める（§11 H1 の公開の時期と一緒に）

---

## 3. 身元と権限（項目 2）

### 3.1 run の token

- 起動の前の検査が通ったら、run の行（`dream_runs`）と token を、1 つのトランザクションで作る
- token の作り方と持ち方:
  - 値: 32 バイトの乱数を base64url にしたもの
  - DB にはハッシュ（SHA-256）だけを保存する。照合は `timingSafeEqual`
- 結ぶもの（サーバーの run の行が持つ。出力の自己申告では置き換えない）:
  - `schedule_id`・`execution_log_id`
  - `repository_id`・`branch`
  - `snapshot_id`
  - `expires_at`: 実行の上限の 30 分＋5 分（PM の決定）
  - `consumed_at`・`revoked_at`
- 渡し方: 子の環境の `CM_DREAM_TOKEN`（§2.3 の最後に書く）。`CM_AUTH_TOKEN` は戻さない
- 消費と失効:
  - 確定のトランザクションで `consumed_at` を書く
  - 失敗の記録のトランザクションで `revoked_at` を書く
  - どちらかがあれば、`dream-input`・`dream-read` と取り込みを断る

### 3.2 通る口（レビュー A P2-1）

| 口 | dream token で通るか |
|---|---|
| `GET /api/mem/dream/input`（`mem dream-input`） | 通る |
| `GET /api/mem/dream/read?ref=`（`mem dream-read`） | 通る |
| それ以外のすべての API | **通らない**。dream token は認証の代わりにならない |

- dream の 2 つの route の約束:
  - Node の runtime の中で、**認証の有無・受け口の除外にかかわらず**、必ず dream token を要求する（無ければ 401。認証が無効でも）
  - 範囲（repository・ブランチ・snapshot）は token の run の行から決める。URL に worktree の ID を持たない
- middleware の扱い:
  - 認証が有効なとき、middleware の除外にはこの 2 つの完全な path だけを載せる（前方一致・正規表現にしない。`AUTH_EXCLUDED_PATHS` の完全一致の形、`src/middleware.ts:173`）
- ingress（Tailscale・Cloudflare の経由）の受け口では、dream token を受けない（`x-cm-ingress` の判定を使う）
- 限界: 認証が無効（既定）・`remote-only` では、ローカルのプロセスは通常の API を呼べる。この構成での子の守りは §3.3 の argv だけ（§1.1、§11 H6）

### 3.3 ツールの表と、claude の argv の固定（レビュー A P1-1）

| ツール | v1 で対象にするか |
|---|---|
| claude | **対象**（S9-0 の実機の確認に合格した版だけ。PM の決定） |
| codex | 対象外（`read-only` の sandbox が localhost を許すか未確認。S9-0 で調べ、結果で人に伺う） |
| antigravity | **対象外**（Google Antigravity 追加規約 6 条。AI からの起動をしない） |
| そのほか | 対象外（v1） |

**claude の argv（CommandMate が固定で組む。利用者・ブランチの設定から足さない）**:

| 目的 | 引数（見立て。S9-0 で版ごとに確かめる） |
|---|---|
| 非対話・答えを JSON で | `-p <固定の短い本文>` `--output-format json` |
| 組み込みの道具を Bash だけにする（Read・Grep・Glob・Edit・Write・WebFetch・WebSearch・Task などを使わせない） | `--tools Bash`（無い版では `--disallowedTools` に全部を明示） |
| 許可の一覧の外は断る | `--permission-mode dontAsk` |
| 許可は 2 つだけ | `--allowedTools "Bash(commandmate mem dream-input:*)" "Bash(commandmate mem dream-read:*)"` |
| 利用者・project・local の設定（allow・hooks・MCP）を読まない | `--setting-sources ""` と、CommandMate が書いた一時の設定 `--settings <tmp.json>`（allow 2 つだけ・hooks なし） |
| MCP を使わない | `--strict-mcp-config`（MCP の設定を渡さない） |
| 手順 | skill を読ませず、CommandMate が版つきの固定の文を `--append-system-prompt` で渡す（project の skill の名前の衝突も起きない） |

- `commandmate` は、サーバーと同じパッケージの CLI の絶対パスで許可する（見立て。PATH の別の `commandmate` を通さない）
- argv は単体試験で固定する。変異: `--setting-sources` を外す・`--tools` を外す・許可を 3 つにする、のどれでも赤（S9-1）
- **S9-0 の実機の確認**（隔離した HOME とサーバー、本物の claude。agy は使わない）で、次の陰性の記録を残す。版ごとに表を確定する:
  - cwd の外の Read（`~/.claude/projects` など）
  - WebFetch・WebSearch
  - project の settings に置いた allow（`Bash(touch:*)`）
  - project の skill の `allowed-tools`
  - SessionStart の hook
  - Bash の形: `commandmate mem dream-read x; touch y`・`$(touch y)`・`> file`・`| tee`・`FOO=1 commandmate …`
  - 許可の外の `commandmate mem add`
  - 注入の文を含む材料のもとでの上の各形（T1）
- 1 つでも通った版は対象外にする（`tool_not_supported`）。必要な引数が無い版も対象外
- 保証の範囲: 「子は書けない」とは書かない。「CommandMate が組む argv で、許可した 2 つのコマンドのほかを断らせる。S9-0 で確かめた版の範囲で、同じ OS 権限での直の書き込みは防げない」と書く

---

## 4. 材料 `mem dream-input`（項目 3）

### 4.1 中身（データの区画、D12）

| 区画 | 中身 | 出所 |
|---|---|---|
| items | このブランチの `open`・`recorded`・`promoted` の項目。期限を過ぎた許可は除く（`presentMemItem` の `expired`、#4354 PR1a）。各項目に ID・kind・状態・版・本文（withheld なら印だけ）・根拠の参照・作成者・更新の時刻 | `listMem`（副作用なし） |
| conditions | 条件の評価の結果と、その時刻（§4.2） | B |
| relays | このブランチの instance を端点にする relay の状態 | C の S3 と同じ読み |
| transcripts | 同じブランチのセッションの会話の記録への**参照**（instance・世代・範囲）。本文は入れない | C の S9（`src/lib/brief/sources.ts:557-605`） |
| proposals | このブランチの未判断の提案（dreaming と handoff） | §7 |
| meta | snapshot ID・作った時刻・予算・渡した範囲・残り・schema の版 | — |

- 出所・作者・時刻を付ける。本文は JSON の文字列として出す（D12）。秘密は withheld の印（A §6.4）

### 4.2 副作用なし（レビュー A P3-4、T10）

- **呼んでよい関数**: `listMem`・`presentMemItem`・C の S3・S9 の読み（`readRelaySource`・`latestTurnOf`）・提案の一覧の読み
- **呼んではならない関数**: `memList`（評価して閉じる、`src/lib/mem/service.ts:934`）・`memCheck`・`buildBrief`（評価を呼ぶ、`src/lib/brief/build.ts:330`）・`evaluateMemConditions`・incarnation の作成
- 結合の試験で spy を置き、呼んではならない関数が 0 回であることを確かめる（S9-3）
- 条件の評価の結果:
  - (a) 既にある評価の結果とその時刻を読む
  - (b) B に閉じない評価の口（dry run）を足す
  - (a) が成り立つかは、評価の結果が保存されているか（応答だけか）による。**S9-3 の前の事前調査で決める**（レビュー B P2-6・P3-5）。保存が無ければ (b) にし、B への契約（§9.3）に足す
- 条件が成立していても、dreaming は閉じない。通常の B が別の経路で閉じた場合は、確定のときに版の競合になる
- #4354 の `expire` は、書き込みの評価の口でだけ走る。`dream-input` は呼ばない（#4354 §6 の 6）

### 4.3 snapshot・位置・NOOP（レビュー B P2-4・P2-7）

**snapshot**: 参照と版の集合（item ID と版、記録の範囲、relay の ID）だけを DB に持つ。本文は持たない（レビュー A P2-7）
- 同じ run の 2 回目の `dream-input` は、同じ参照の集合から今の行を読んで返す
- 版が変わった項目は「変わった」の印つきで返す（版の履歴は A に無いので、本文までは固定しない）

**位置**（正は 1 か所ずつ）:

| 情報源 | 位置の正 | 「変わった」の定義 |
|---|---|---|
| items | `dream_delivered_items`（item ID → 渡した版） | 版が上がった・新しい項目・閉じた項目 |
| transcripts | `dream_cursors`（instance ごとの世代と、最後に渡したターン） | 同じ世代の追記、新しい世代 |
| relays | `dream_cursors`（最後に渡した relay の更新の時刻） | 状態の変化 |
| proposals | `dream_cursors`（最後に見た判断の時刻） | 判断が増えた |

- 全部の情報源で変化が無ければ NOOP。`dream-input` は `{ "noop": true }` だけを返す
- NOOP の snapshot の run の答えに提案があれば、取り込みで全部を断る（`noop_snapshot`。手順だけに頼らない。レビュー A P3-1）
- 取得の時刻・token の違いだけでは「変わった」にしない
- 位置を進めるのは、確定のトランザクション（§8.2）だけ

### 4.4 予算

- UTF-8 のバイト数で数える。既定は 64KB（PM の決定）
- 超えるとき:
  - 区画ごとに古い順に詰める
  - 実際に渡したものと、残りを run に記録する
  - 残りは次の回に渡す（位置を進めない）
- 見直しの範囲は、変わった項目と、その根拠の会話の範囲だけ

---

## 5. 根拠 `mem dream-read <ref>`（項目 4）

- 受ける参照は、その run の snapshot の中にあるものだけ。それ以外は 404 `ref_not_in_snapshot`

| 参照 | 返すもの | 範囲の限り |
|---|---|---|
| `item:<id>@<version>` | 今の行（版が違えば「変わった」の印つき） | 同じ repository＋ブランチ |
| `transcript:<instance>@<generation>#<from>..<to>` | 会話の記録のその範囲の本文。今ある記録から読む。DB に写さない | 範囲の中で、そのブランチだった区間だけ（区間の見分けは §12 の 6） |
| `relay:<id>` | relay の状態と時刻 | 同じブランチの端点 |
| `issue:#N`・`pr:#N` | 材料に含めた番号の状態だけ。本文は返さない（PM の決定） | 材料に含めた番号だけ |
| `path:<rel>` | 項目の evidence のパスの、今の内容の範囲 | evidence にあるパスだけ。symlink・範囲の外は断る（A §6.2） |

- **本文にも秘密の規則をかける**（レビュー A P2-7）。当たった範囲は印（`withheld:<rule-id>`）に置き換えて返す
- 同じ範囲で `secret_like` の失敗が 3 回続いたら、その範囲を `remaining` から外し、理由つきで記録する（人が見る）。止まり続けない
- 取得できない・消えた・変わった根拠は、理由つきの「未確認」として返す
- 読んだ参照の一覧（参照だけ。本文なし）を run に記録する（PM の決定）
- モデルを呼ばない
- 会話の抜粋は、子のモデル（外部の事業者のモデル）に渡る。これを人が了解するかは §11 H5

---

## 6. 出力の取り込み（項目 5）

### 6.1 取り出し（レビュー A P2-2・P3-3）

- **run は executor が持つ `execution_log_id` から引く**。出力の中の token は読まない。答えの schema に token の欄を作らない
- executor は、`truncateOutput` と失敗時の連結（`claude-executor.ts:1088-1097`）の**前の生の stdout** を、dreaming の分岐にだけ別の欄で返す（メモリの中だけ。保存しない）
- 受ける条件: 生の stdout が claude の結果の JSON で、`type='result'`・`subtype='success'`・exit 0 のときだけ
  - `is_error: true`・失敗・時間切れは、答えを読まずに run を失敗にする
- 切り詰めは、バイト数と `maxBuffer` 超過の error code（`claude-executor.ts:1045`）で判定する。印の文字列では判定しない
- `result` の中身は、前後の空白を除いて **1 つの JSON の object だけ**を受ける
  - 警告の行・JSON の外の本文・2 つ以上の JSON は、run の失敗
- `permission_denials` が空でなければ、件数を run に記録し、画面に「許可の外を試みた run」と出す（検知。止めるのは argv）
- 答えの JSON の上限は 64KB（PM の決定）

### 6.2 秘密の検査と保存（レビュー B P2-2）

- 保存の前と表示の前に、答えと stderr に次をかける:
  - 今の規則（`src/lib/mem/secret-scan.ts`）
  - **この run の token の値と、子の環境の `CM_*` の値の完全一致**（伏せる。レビュー A P2-2）
- dreaming の行の `execution_logs.result` には、生の出力でなく要約を書く
  - 要約には実行の失敗の理由の語（`Reason: …` の行の語）を必ず含める
  - 分岐は dreaming の行だけ。通常の Schedule の逐語の保存（#2253）は変えない。#2253 の試験が変わらないことを S10-1 の完了条件にする
- 秘密に当たったとき: 答えを受けない（run の失敗、理由 `secret_like`）。理由に原文を載せない
- 生の出力は保持しない（PM の決定）

### 6.3 答えの検査（提案ごと）

- **形の誤り（run 全体の失敗。位置を進めない）**:
  - schema の版が違う
  - run の行の token が消費済み・失効・期限切れ
  - JSON の上限を超えた
  - 提案の数が上限（1 回 20 件、PM の決定）を超えた
- **個々の提案を断る**（run は成功。断った件数と理由の語だけを残す。本文は残さない。渡した範囲の位置は進める）:
  - 未知の操作・欄が足りない
  - 根拠が無い・材料に無い参照・未確認の根拠だけ
    - 各 `grounds` は、取り込みで `dream-read` と同じ関数で照らし直す。モデルの申告の印は使わない（レビュー A P3-2）
  - §7.1 の対象・欄の禁止（`target_forbidden`・`field_forbidden`）
  - NOOP の snapshot の run の提案（`noop_snapshot`）

### 6.4 取り込みのときの照らし直し（T9）

次のどれかが欠ければ run の失敗にする（位置を進めない）:
- run の行の token が消費・失効されていない、期限の前、execution-log が同じ
- mode がまだ `on`、所属が同じ
- worktree の HEAD のブランチが run のブランチと同じ

---

## 7. 提案の schema（項目 6）と承認

### 7.1 操作と、対象・欄の限り（レビュー A P1-2、T13）

```jsonc
{
  "schema": 1,
  "proposals": [
    {
      "op": "restate" | "close" | "merge" | "decision-candidate" | "move-to-destination" | "fix-refs",
      "targets": [{ "itemId": "…", "version": 3 }],
      "new": { … op ごとの許可の欄だけ … },
      "destination": "issue:#N" | "pr:#N" | "path:docs/…md",
      "reason": "…",          // 500 code point まで
      "grounds": ["transcript:…", "item:…@…"]
    }
  ]
}
```

| 操作 | 対象（今の状態で） | 受ける欄（許可の一覧） | 確定のとき |
|---|---|---|---|
| `restate`（言い直し） | 1 項目。`state='open'` かつ `kind != 'decision'` | `text`・`evidence` だけ。`kind`・`closeWhen`・`promoteTo`・`expiresAt`・`quote` は不変 | 版の一致 |
| `close` | 1 項目。`state='open'` かつ `kind != 'decision'` | — | 版の一致 |
| `merge` | 2 項目以上。全部が `state='open'`・同じ kind・`kind != 'decision'` | 新しい 1 項目（対象と同じ kind の `text`・`evidence`・`closeWhen`） | 全部の版が一致したときだけ全部を確定。1 つでも違えば何もしない |
| `decision-candidate` | — | decision（`open`、`createdBy: agent`、出所 dream）。**`promoteTo` 必須、`expiresAt` は禁止**（許可を起案しない）、`quote` なし | 作るだけ。`recorded`・`promoted` を指定できない。#4354 の作成の規則（store 層）も通る |
| `move-to-destination` | 1 項目と行き先。`state='open'` かつ `kind != 'decision'` | `destination` | E の差分（preview）へつなぐだけ。書き込みは E の承認。二重の検知は #4354 PR3a の一致の関数 |
| `fix-refs` | 1 項目。`state='open'` かつ `kind != 'decision'` | `evidence` だけ | 版の一致 |

- **decision（許可・承認待ち・`recorded`・`promoted`・引用つき）は、どの操作の対象にもしない**
  - これで #4354 第 3.1 版の N1（延長）・N2（許可への変更）・R1（承認待ちの取り下げ）と衝突しない
  - 許可・`promoted` の片付けは #4354 の機械の片付けが持つ
- 検査は 1 つの関数（`checkDreamProposal`、見込み）にする。**取り込み（§6.3）と確定（§7.3）の両方**で、対象の今の行に対して呼ぶ（取り込みの後に作業中の Agent が対象を変えた場合に備える）
- 欄の検査は A の関数（`validateMemFields`・`validateEvidence`）
- 出所: `source: { kind: 'dream', runId, skillVersion, schemaVersion }`

### 7.2 保存（レビュー B P2-5・P2-7）

- 新しい表 `dream_proposals`（`mem_` で始めない。v66 の「`mem_%` の表」の試験に当たらない、`tests/unit/db/migration-v66-mem-store-4221.test.ts:96`）
  - 主な列: `id`・`run_id`・`group_id`・`op`・`targets`・`payload`・`grounds`・`source`・`state`（`pending`・`approved`・`rejected`・`conflict`・`failed`）
  - 判断の列: `decided_at`・`decided_by`・`decided_version`
  - 変えない欄は trigger で固定する（v71 の前例）
- 判断の履歴の表 `dream_proposal_decisions`（追記だけ）: 提案・判断・時刻・人・版。取り消し・再判断の重複を数えないために使う
- 本文（`payload` の text）は、保存の前に秘密の規則で検査する
- mem との関係:
  - そのブランチの mem の purge で、提案も同じトランザクションで消す
  - mode が off になったら、未判断の提案は承認できない（確定のときの照らし直し）
- 断った提案は理由の語だけを残す（本文を残さない）
- handoff の提案の表と 1 つにしない理由: handoff の提案は handoff の要求に結び付き（`request_id NOT NULL`）、dreaming の提案は run に結び付く

### 7.3 確定（承認。レビュー A P2-4）

- 人が画面で承認したときだけ確定する（`screen_only`。§1.1 の限界のとおり）
- 確定は、次を 1 つのトランザクションで行う:
  1. 提案の行の `state='pending'` を条件にした UPDATE（変わった行が 0 なら何もしない。二重のクリック・2 つのタブで 2 回作らない）
  2. run の状態が `succeeded` であることの照らし
  3. mode・所属・`checkDreamProposal` の照らし
  4. A の書き込み
- `restate`・`close`・`fix-refs`: A の入口を版つきで呼ぶ
- `merge`: A に**複数の項目を版つきで照らして 1 つのトランザクションで閉じ・作る入口**を新しく足す（A への契約、§9.3）
- `decision-candidate`: A の作成（decision、`open`、`createdBy: agent`）。#4354 の store 層の規則を通る
- `move-to-destination`: E の差分を作る画面へつなぐ

### 7.4 まとめての承認・拒否（追記）

- まとめての承認・拒否の API は、**画面に出した提案の ID と版の一覧だけ**を受ける（「種類の全部」をサーバーで展開しない）
- 版の照合は 1 件ずつ。1 件の競合で他を止めない。結果は件数（確定・競合・失敗）で返す
- **`decision-candidate` は、まとめての承認から外す**（1 件ずつ。レビュー A P1-2）。まとめての拒否には入れてよい
- `merge` は 1 つの提案の中で全部か無しか

---

## 8. 排他と確定の単位（項目 7）

### 8.1 排他

- 表 `dream_leases`
  - 列: `repository_id`, `branch`（主キー）, `run_id`, `acquired_at`, `expires_at`
  - 取得: `INSERT … ON CONFLICT … DO UPDATE … WHERE expires_at < :now` の 1 文
- 解放は `WHERE run_id = :own` だけ（期限で他の run に移った lease を消さない）
- 期限を過ぎた lease を取得するときに、前の run が `running` なら、同じトランザクションで `failed`（理由 `abandoned`）にし、token を失効させる（レビュー A P3-5・B P2-3）
- サーバーの起動のときにも 1 回だけ、期限を過ぎた `running` の run を同じく始末する（起動の時の 1 回の掃除。タイマーではない）

### 8.2 確定と、失敗の記録（レビュー A P2-3・B P2-3、T8）

**確定のトランザクション**（成功のとき）:
1. token の消費（`consumed_at IS NULL AND revoked_at IS NULL` を条件に書く。変わった行が 0 なら何もしない）
2. 受けた提案の挿入と、断った提案の理由の語
3. run の成否と件数
4. 情報源ごとの位置の更新（渡した範囲だけ）
5. 排他の解放（`WHERE run_id = :own`）

- トランザクションの中の拒否（形の誤り・照らし直しの欠け）は、型付きの例外で戻す。値を返して断らない（値を返すとコミットされる。#4466 の設計レビュー A P1-1 と同じ種類の穴）

**失敗の記録のトランザクション**（確定が戻ったとき・失敗・時間切れ・形の誤りのとき、必ず走る）:
- run を `failed`（理由の語）にする
- token を失効させる（`revoked_at`）
- 排他を解放する（`WHERE run_id = :own`）
- 条件は `WHERE run_id = ? AND consumed_at IS NULL`
- 位置は進めない

**回復の定義**:
- 失敗した run の答えは保存しない
- 次の cron の回の run が、進まなかった同じ範囲を取り直す
- 同じ execution-log を取り込み直すことはしない（`dream_runs.execution_log_id` の一意の索引で、2 回目の確定を防ぐ）

### 8.3 DB の表（案）と migration（レビュー B P2-7）

| 表 | 主な列 | migration |
|---|---|---|
| `dream_runs` | `id`, `schedule_id`, `execution_log_id`（一意）, `repository_id`, `branch`, `state`（`skipped`・`running`・`noop`・`succeeded`・`failed`）, `reason`, `token_hash`, `token_expires_at`, `token_consumed_at`, `token_revoked_at`, `snapshot_id`, `delivered`, `remaining`, `read_refs`, `accepted`, `rejected`, `permission_denials`, `skill_version`, `schema_version`, `tool_configured`, `model_configured`, `tool_observed`, `model_observed`, `tokens_reported`, `started_at`, `ended_at` | M1（Sprint 9） |
| `dream_leases` | §8.1 | M1 |
| `dream_cursors` | `repository_id`, `branch`, `source`（transcripts・relays・proposals）, `position`, `updated_at` | M1 |
| `dream_delivered_items` | `repository_id`, `branch`, `item_id`, `version`, `run_id` | M1 |
| `dream_snapshots` | `snapshot_id`, `run_id`, 参照と版の集合（本文なし） | M1 |
| `dream_proposals`・`dream_proposal_decisions` | §7.2 | M2（Sprint 10） |

- 名前は全部 `dream_` で始める
- 番号は、M1 と M2 の 2 つを先に PM が予約する（間に別の migration が入って番号が動かないように）。#4354 PR3b の migration とも PM が割り当てる
- 各 migration は down を持つ（表を消す）
- 後始末:
  - repository の削除（`deleteRepository`、`src/lib/db/db-repository.ts:317`）で、その repository_id の dream の行を同じトランザクションで消す
  - ブランチの削除・名前の変更では消さない（保持の期間で消える）
- 保持の期間: `dream_runs`・`dream_delivered_items`・判断の済んだ提案は、既定 90 日（§11 H3）。次の run の確定のトランザクションで古いものを消す（タイマーを足さない）
- `mem_items` には触れない

---

## 9. 記録と比べ方（項目 8・10）と、依存の契約（項目 9）

### 9.1 `commandmate mem dream list [--json]`

- 実行ごと:
  - ブランチ、開始と終了
  - skip・NOOP とその理由
  - 渡した範囲と残り
  - 受けた件数・断った件数
  - `permission_denials` の件数
  - skill と schema の版、Schedule の行
  - execution-log への参照
  - 報告されていればトークンの数
- ツールとモデル: 設定（`tool_configured`・`model_configured`）と、観測（`tool_observed`・`model_observed`）を分けて出す。Agent が JSON に書いたモデル名だけでは確定しない。不明なら「不明」
- 判断の数え方（提案ごと・版ごと）:
  - 数える値: 承認・拒否・競合・未判断の件数
  - 比率は「判断済みを母数にした値」と「未判断を含む件数」を並べる
  - 母数が 0 なら比率を出さない
  - 取り消し・重複は数えない（`dream_proposal_decisions` から数える）
- `--json` の key（レビュー B P2-5）:
  - `runs[]`
  - `byOp.<op>.{approved,rejected,conflict,pending,ratio}`
  - `byToolModel.<tool>/<model>.{…}`
  - `pendingByDay[]`（`created_at` と `decided_at` から日ごとに再計算する）
- docs の注記: 材料の違う回の比率の差を、モデルの優劣とは書かない

### 9.2 2 週間の計測（追記。レビュー B P2-5・P2-9）

- 開始は旗を on にした日（§2.4）。見る人は PM。見るものは `mem dream list --json` の `pendingByDay` と `byOp`
- 終了は 14 日目で、PM が人に結果を渡す
- 頻度・上限を下げる基準の案: 週ごとの未判断の増分が 2 週続けて正なら、頻度を半分にする。判断は人（§11 H7）
- 手順は S10-5 の docs に書く

### 9.3 依存の契約

| 相手 | 契約 | いつ |
|---|---|---|
| **A（#4221、store）** | 1. merge のための、複数の項目を版つきで照らして 1 つのトランザクションで閉じ（`superseded`）・作る入口<br>2. `createdBy: agent`・出所 dream の decision の作成（#4354 の規則を通る）<br>3. mem の purge で `dream_proposals` を同じトランザクションで消す | S10-2・S10-3 の前に、A の設計書に追記（PM の承認） |
| **B（#4222、評価）** | 評価の結果の保存の有無を確かめる。無ければ、閉じない評価の口（dry run）（§4.2） | S9-3 の前の事前調査 |
| **C（#4223、brief）** | 1. 会話の記録は参照で出す（S9 は既にそう）<br>2. 「未判断の提案 N 件（うち dreaming M 件）」の 1 行。#4354 の承認待ちの数とは別<br>3. dreaming 用の副作用の無い索引の読み | S10-4 の前に、`brief-4223.md` に追記（PM の承認。今の C の設計書に dream の記述は無い） |
| **E（#4225）・#4354 PR3a** | 一致の関数（`prior-record.ts`）の公開の形 | S10-3 の前 |
| **G（#4227、画面）** | 1. 提案の承認の関数を、handoff と共通にする（`mem-ui-4227.md:467` の「#4248 で決める」に、別の表・共通の関数と答える）<br>2. 閉じる操作をしなくても、日ごとの提案を開いて承認・拒否できる一覧<br>3. 承認の画面に、差分・理由・辿れる根拠・材料の時点・欠けた材料<br>4. 提案の本文は平文で出し、Markdown の画像・リンクを自動で読まない（レビュー A P3-6）<br>5. G の既存の試験と `ENTRANCES` の表（`mem-ui-4227.md:524`）への影響を S10-3 の契約に書く。G の担当にもレビューを頼む | S10-3・S10-4 |
| **H（#4228）** | 手順の固定の文（§3.3 の `--append-system-prompt`）を正にする。skill の文書は、その写しと説明（置き場と公開は §11 H1） | S10-5。`mem-skills-4228.md` に追記（PM の承認） |
| **#4354** | 1. PR1a（`expired`）が S9-3 の前（レビュー B P1-3）<br>2. PR1c（作成の規則）が S10-2 の前<br>3. PR3a（一致の関数）が S10-3 の前 | 依存の順（§10） |

---

## 10. PR の分け方（項目 11。レビュー B P2-8）

- 全体の約束: 機能の旗（§2.4）が off のあいだは、どの PR が入っても dreaming の行は起動しない。各 PR に戻し方を書く

### Sprint 9（前半）

| PR | 中身 | 依存 | 陽性対照 | 戻し方 |
|---|---|---|---|---|
| S9-0 実機の確認（最初） | §3.3 の陰性の記録（claude の版ごと、codex の sandbox）。結果で §3.3 の表と argv を確定する docs の PR | — | 許可の外の各形が断られる記録 | docs だけ |
| S9-1 識別・旗・検査 | `Purpose` の列（名前で読む）・`ScheduleEntry.purpose`・書き手が保つ試験・旗（§2.4）・検査 0〜6・8・argv の組み立てと固定の試験・役割を適用しない | S9-0 | 旗 off で起動 0（旗の検査を外すと 1）。mode off・detached・対象外のツールで起動 0。argv の変異（`--setting-sources` を外す等）で赤。書き手が Purpose を落とす変異で赤 | 分岐ごと戻す（旗が off なので通常の Schedule は変わらない） |
| S9-2 run・token・排他（M1） | M1 の migration、token の発行・ハッシュ・失効、排他（期限・`WHERE run_id`・abandoned の始末）、検査 7 | S9-1、M1 の番号 | 2 本の同時の run で後が skip。期限で回復。他の run の token・期限切れが 401／403 | down で表を消す |
| S9-3 `dream-input` | 材料（§4）、副作用なし（呼ぶ関数の一覧）、snapshot・位置・NOOP・予算、dream token の route、middleware の完全一致の除外、ingress で受けない | S9-2、**#4354 PR1a**、B の事前調査（§4.2） | 前後で mem の行・知らせ・受領が同じ（期限切れの許可を含む fixture）。禁止の関数の spy が 0。全 route の一覧を dream token だけで回して 401（除外を前方一致にする変異で赤）。消費・失効の後は断る。モデルを呼ばない spy | route を戻す |
| S9-4 `dream-read` | 参照ごとの読み（§5）、範囲の限り、本文の秘密の検査、未確認、同じ範囲の秘密の失敗 3 回で外す | S9-3 | snapshot の外・別のブランチの区間で断る。秘密を含む会話が伏せて返る（検査を外すと原文が出て赤）。モデルを呼ばない spy | route を戻す |
| S9-5 薄い縦の通し | 旗を on にした隔離の環境で、NOOP の run だけが「起動 → `dream-input` → NOOP → 失敗の記録でない終わり」まで通る（取り込みはまだ無いので、NOOP 以外の答えは `not_implemented` で失敗にする） | S9-1〜S9-4 | NOOP の run が `noop`、NOOP でない run が `failed(not_implemented)` で位置が進まない | 旗 off |

### Sprint 10（後半）

| PR | 中身 | 依存 | 陽性対照 | 戻し方 |
|---|---|---|---|---|
| S10-1 取り込みの検査 | 生の stdout の取り出し、JSON の受け方、切り詰めの判定、秘密の検査（token・`CM_*` を含む）、`execution_logs` の要約。**検査の結果を返すだけで、書かない**（書くのは S10-2） | S9-5 | 取り込みの境界の表（64KB ちょうど・超え・日本語・警告の行・2 つの JSON・`is_error`）。検査を外すと受けて赤。#2253 の試験が変わらない | 関数を戻す |
| S10-2 提案の保存と確定（M2） | M2 の migration、§6.3 の提案ごとの検査（`checkDreamProposal` の取り込みの側）、確定と失敗の記録のトランザクション（§8.2）、照らし直し（§6.4） | S10-1、**#4354 PR1c**、M2 の番号 | 確定の途中で失敗を注入 → 提案 0・run は `failed`・位置は同じ・token は失効（失敗の記録を外すと `running` のまま残り赤）。禁止の形の提案が `target_forbidden`・`field_forbidden`（取り込みの側の検査を外すと赤）。mode off の後の出力が断られる | down で表を消す |
| S10-3 承認（G と共通） | 承認の関数（`state='pending'` を条件の UPDATE・run の状態・`checkDreamProposal` の確定の側・mode の照らし直し）、A の merge の入口、まとめての承認・拒否（ID と版の一覧だけ、`decision-candidate` を除く） | S10-2、**#4354 PR3a**、A への契約 | merge で 1 つの版を変えると何も確定しない。種類ごとの承認で、古い版の 1 件だけが競合になり他が確定する（レビュー B P3-3）。確定の側の検査を外すと、取り込みの後に許可へ変えた対象が確定して赤。二重の承認で 1 回だけ。dream token と偽の screen の見出しで断られる | 関数を戻す |
| S10-4 画面と記録 | 一覧の画面（日ごと・出所の区別・根拠の辿り・平文の表示）、まとめての操作、`mem dream list`（§9.1 の key）、C の 1 行 | S10-3、C・G への契約 | e2e: 固定の例で根拠を辿って拒否、C の索引から G の承認まで、画面のまとめての承認・拒否（T11）。比率の表（母数 0 で出さない） | 画面と CLI を戻す |
| S10-5 手順と docs | 固定の手順の文の版、skill の写し（置き場は §11 H1）、docs（推奨の行・保証の範囲・注記・2 週間の計測の手順） | S10-4、§11 H1 の答え | 手順の文の版が argv に入る試験 | docs だけ |

- 高リスク（安全の中核）なので、各 PR のレビューは観点を分けて 2 本（安全・整合）。S10-3 は G の担当にもレビューを頼む

---

## 11. 伺う点

### 11.1 人に伺う点（レビュー B P2-9 で絞り直した）

| # | 問い | 推奨 | 答えの期限 |
|---|---|---|---|
| H1 | 手順の skill（`cmate-dream`）の置き場・名前・公開の時期。今の前例は、開発ブランチ用が `-dev` 付き（`cmate-delegate-dev`）、公開版は commandmate-skills（公開のリポジトリ） | 手順の正は CommandMate が渡す固定の文（§3.3）。skill はその写しと説明として、まず開発用の `cmate-dream-dev` をこのリポジトリに置く。2 週間の計測の後に、公開（commandmate-skills）と旗の既定を一緒に決める | S10-5 の前 |
| H2 | 費用の上限: 推奨の cron（例: 1 日 1 回、夜）・1 ブランチ 1 日の run の数の上限（検査 6）・1 run のモデルの利用の上限（claude の `--max-turns` などの値）・推奨の行の CLI Tool と権限の値 | cron は 1 日 1 回、run の上限は 1 ブランチ 1 日 2 回、ターンの上限は 20（値は S9-0 の後に確かめる） | S9-1 の前 |
| H3 | 保持の期間（`dream_runs`・渡した項目・判断の済んだ提案） | 90 日 | S9-2 の前 |
| H4 | 対象のブランチの選び方: mode が `on` の全部か、dreaming の行を足した worktree のブランチだけか | 行を足した worktree のブランチだけ（1 行 = 1 ブランチ。意図しないブランチに広がらない） | S9-1 の前 |
| H5 | 会話の記録の抜粋（`dream-read` の本文）が、子のモデル（外部の事業者のモデル）に渡ることの了解。ツールをまたいで渡すか（例: codex のセッションの会話を claude の run に） | 了解を得たうえで、v1 は同じブランチの会話を claude の run に渡す。別の事業者のツールの会話を渡すかは、v1 では「渡す」（ブランチの会話の全部が対象）とし、渡したくない人は mode を off にする | S9-4 の前 |
| H6 | 認証が無効（既定）・`remote-only` のサーバーで dreaming を許すか（この構成では、子の守りは argv だけ） | 許す。docs と画面に限界を書く（止めると既定の構成で使えない）。S9-0 の結果を見て決め直す | S9-0 の後 |
| H7 | 2 週間の計測の後の判断の基準 | 週ごとの未判断の増分が 2 週続けて正なら、頻度を半分にする（判断は人） | S10-5 の前 |

### 11.2 PM が範囲の中で決めること（第 1 版の問いから移した）

| # | 決定 |
|---|---|
| P1 | 識別は `Purpose: mem-dream`、列を名前で読む |
| P2 | `Message` は子への本文に足さない |
| P3 | token の期限は、実行の上限 30 分＋5 分 |
| P4 | 予算: 材料 64KB・答え 64KB・1 回 20 件 |
| P5 | 生の出力を保持しない（回復は再 run） |
| P6 | `dream-read` は Issue・PR の本文を返さない |
| P7 | 読んだ参照を記録する（参照だけ） |
| P8 | v1 の対象は claude だけ（S9-0 の後）。codex は S9-0 の結果で人に伺う |
| P9 | migration の番号（M1・M2 を先に予約） |
| P10 | 前回の run から 60 分以内は `too_frequent` |

---

## 12. 未確認（S9 の前の事前調査にする。レビュー B P3-5）

1. claude の `--tools`・`--setting-sources ""`・`--settings`・`--strict-mcp-config`・`--append-system-prompt`・`dontAsk`＋`--allowedTools` の版ごとの有無と効き方（S9-0）
2. codex の `read-only` の sandbox が localhost の HTTP を許すか（S9-0）
3. middleware の完全一致の除外と、Node の runtime の検査の 2 か所の形（S9-3）
4. B の評価の結果が保存されているか（§4.2。S9-3 の前）
5. 会話の記録の読みで、ブランチを切り替えた区間を見分けられるか（`getCurrentBoundary` がブランチの切り替えを記録しているか。S9-4 の前）
6. CMATE.md の書き手（`cmate-writer.ts`・画面・`batchUpsertSchedules`）が未知の列を保つか（S9-1）

---

## 13. 設計レビューの処分（第 2 版）

- 処分の語: 採用（設計を直した）・却下（理由つき）・未解決（次の手つき）
- P1 は全部を設計で塞いだ

### 13.1 レビュー A（安全）

| 指摘 | 処分 | 反映した節 |
|---|---|---|
| P1-1 claude の読むだけの設定の穴（設定・hooks・MCP・skill・組み込みの道具） | 採用（argv を CommandMate が固定で組む: `--tools Bash`・`--setting-sources ""`・`--settings`・`--strict-mcp-config`・固定の手順の文。argv を試験で固定。S9-0 の陰性の一覧を足し、最初の PR にした） | §1.1、§2.3 の 8、§3.3、§10 S9-0・S9-1 |
| P1-2 dreaming の提案で許可を作る・延ばす・変える。decision を対象にできる | 採用（`decision-candidate` は行き先を必須・期限を禁止。対象は `open` かつ decision 以外。`restate` は text と evidence だけ、`fix-refs` は evidence だけ。merge は同じ kind・decision 以外。取り込みと確定の両方で検査。まとめての承認から候補を外す。#4354 §6 の 2 も直した） | §0.1 の 9、§7.1、§7.3、§7.4、T13 |
| P2-1 `remote-only`・middleware の除外 | 採用 | §1.1、§3.2、§11 H6 |
| P2-2 token が出力・記録に載る | 採用（run は `execution_log_id` で引く。答えに token の欄なし。token・`CM_*` の値を伏せる） | §6.1、§6.2 |
| P2-3 失敗の経路と取り込み直し | 採用（確定と失敗の記録のトランザクションを分ける。回復は再 run と定義。`WHERE run_id`） | §8.1、§8.2、T8 |
| P2-4 承認の保証・まとめての承認・二重の確定 | 採用（§1.1 の書き直し、ID と版の一覧だけ、`state='pending'` の条件つきの UPDATE、run の状態の照らし） | §1.1、§7.3、§7.4 |
| P2-5 脅威表と PR の陰性対照の欠け | 採用（T2・T3・T9・T12・T13 の対照を PR に配った） | §1.2、§10 |
| P2-6 本文の argv・役割・env | 採用（本文は固定の文だけ。役割を適用しない。`CM_DREAM_TOKEN` は最後に書く） | §2.2、§2.3 |
| P2-7 mem の外の本文の写し・`dream-read` の秘密 | 採用（snapshot は参照と版だけ。断った提案は理由の語だけ。purge で提案も消す。`dream-read` の本文を伏せる。同じ範囲の失敗 3 回で外す） | §4.3、§5、§7.2 |
| P3-1 NOOP を手順だけに頼る | 採用（`noop_snapshot`） | §4.3、§6.3 |
| P3-2 未確認の根拠の判定 | 採用（取り込みで照らし直す） | §6.3 |
| P3-3 JSON の読み方・切り詰めの判定 | 採用 | §6.1 |
| P3-4 副作用の無い関数の名指し | 採用 | §4.2 |
| P3-5 再起動で残る run | 採用（lease の取得と起動の時の 1 回の掃除で `abandoned`） | §8.1 |
| P3-6 ツールをまたぐ会話・画面の出し方 | 採用（H5 に入れた。画面は平文） | §9.3 G、§11 H5 |
| P3-7 頻度の下限・`timingSafeEqual` | 採用 | §2.3 の 5、§3.1 |

### 13.2 レビュー B（被覆・整合・PR の分け方）

| 指摘 | 処分 | 反映した節 |
|---|---|---|
| P1-1 Sprint 9 の途中で無防備な子が起動できる | 採用（機能の旗、既定 off。off のあいだは常に `not_enabled` で skip） | §2.4、§10 |
| P1-2 取り込み直しの入力が無い | 採用（(b): 回復は再 run と定義。生の出力は保持しない） | §8.2、T8 |
| P1-3 S9-3 が #4354 PR1a に依存 | 採用 | §9.3、§10 S9-3 |
| P2-1 Purpose の保存先・書き手 | 採用（`ScheduleEntry.purpose`、名前で読む、書き手が保つ試験） | §2.2、T14 |
| P2-2 逐語と要約の衝突 | 採用（要約に理由の語、分岐は dreaming だけ、#2253 の試験を完了条件に） | §6.2 |
| P2-3 失敗の記録が戻る | 採用（A P2-3 と同じ） | §8.2 |
| P2-4 snapshot の実体 | 採用（参照と版の集合。版が変われば「変わった」） | §4.3 |
| P2-5 比べ方の列・履歴 | 採用（判断の列と履歴の表、`--json` の key、計測の手順） | §7.2、§9.1、§9.2 |
| P2-6 A・B・E・#4354 への契約 | 採用（表にした。C・H の設計書への追記の手順） | §9.3 |
| P2-7 migration の命名・番号・後始末・保持・二重の位置・down | 採用（`dream_` にそろえる、番号を予約、repository の削除で消す、保持 90 日、位置の正を 1 つ、down を持つ） | §7.2、§8.3 |
| P2-8 PR の順と境界・戻し方 | 採用（S9-0 を最初に、S9-5 に薄い縦の通し、S10-1 は書かない、戻し方の欄、G の担当のレビュー） | §10 |
| P2-9 人への問いの過不足 | 採用（人への問いを H1〜H7 に絞り直し、欠けていた問いを足した。残りは PM の決定へ） | §11 |
| P3-1 行番号 | 採用（`:298` など） | §2.1 |
| P3-2 json の分岐 | 採用（dreaming の分岐だけ） | §3.3、§6.1 |
| P3-3 S10-3 の陽性対照 | 採用 | §10 S10-3 |
| P3-4 T11 の画面の試験 | 採用 | §1.2、§10 S10-4 |
| P3-5 未確認を S9 の前に解く | 採用 | §12 |
| P3-6 状態の対応表 | 採用 | §2.3 |

- 却下 0 件・未解決 0 件
