#! 契約の「作業ルール（厳守）」に入る断片の書き方（/orchestrate 2-4-1 の転記ブロック）。持ち主はこのファイル（#3477）。
#! scripts/orchestrate/contract.mjs が `<N>` を Issue 番号に、`{{ENTRY_LINE}}` / `{{AFTER_ENTRY_LINE}}` を最低の版の宣言（#3480）の
#! 有無に合わせた行番号に置き換え（宣言なし: 2 行目 / 3 行目、宣言あり: 3 行目 / 4 行目）、`#!` で始まる行を落として goal に入れる。
- **`CHANGELOG.md` と `docs/module-reference.md` を編集しないでください**（scope 外です）。
  代わりに次の 2 ファイルを書いてください。`changelog.d/<N>.md` は**実装と同じコミットに含めます**。
  `dev-reports/module-reference/issue-<N>.md` は `dev-reports/` 配下なので commit には入りません。
  - `changelog.d/<N>.md` — リリース時に `CHANGELOG.md` へ移される **1 エントリ**
    （{{ENTRY_LINE}}。先頭は `- **<type>(<scope>): …** (#<N>): …`）。どの節
    （`### Added` / `### Changed` / `### Fixed`）に入るかを 1 行目にコメントで書く。
    書き終えたら `node scripts/changelog-fragments.mjs check` を実行し、exit 0 であることを確かめる。
    **形式は次の実例に合わせてください**（develop の `CHANGELOG.md` にある実エントリを丸ごと 1 本。
    エントリは**ファイル中では 1 行**で、下で折り返して見えるのは表示上の都合です）:

    ```markdown
    <!-- ### Fixed -->
    - **fix(cli): `send` 直後の `wait` が「まだ始まっていない」を完了と読む問題を修正** (#1975): `wait` が `sessionStatus==='ready'` を完了と判定する直前に、**「このインスタンスに最後に渡されたプロンプト」と「エージェント自身が最後に報告したターン終了（`lastStopEventAt`）」を突き合わせる**ゲートを追加。`send` 直後は最新の構造化イベントが直前ターンの `stop` のままなので #1839 の `adoptTurnStart()` が何も採用せず、`turnStartedAt === null` が「決着済み」と読まれてアイドル composer をそのまま完了にしていた（隔離サーバ実測 2026-08-22 / copilot 1.0.80: `send`→`wait` 5 回中 3 回が約 0.3 秒・`basis=scraper_ready`・成果物ゼロで exit 0）。ゲートは `GET /api/worktrees/:id/messages?limit=1&unit=pairs` を `--instance`（無指定ならサーバが解決した `cliToolId`）でスコープして読む。**hook を出さないツールは挙動不変** — `structuredEvents.source.capabilities.supportedEvents`（#1924 の宣言値）が `stop` とターン開始語の両方を宣言しているソースだけがこのゲートに入り、legacy-relay（`supportedEvents: []`）と #1924 以前のサーバは従来経路のまま台帳も引かない。保留は `PENDING_PROMPT_HOLD_MS`=60 秒で打ち切り（hooks は全経路 fail-open なので `Stop` の取りこぼしで `wait` が返らなくなってはいけない）、`--timeout` / `--stall-timeout` はそれより短ければ従来どおり優先される。完了行の `basis=` は、エージェントが最新プロンプトの終了を報告していれば `hook_stop` になる（`scraper_ready` は「画面しか言っていない」という文書どおりの意味に戻る）。
    ```

    - `- **` で始めること — 集計は `changelog-fragments.mjs check` と `grep -cE '^- \*\*'` なので、外れると `check` が不合格にし、エントリとしても数えられません。
    - `(#<N>)` は要約の**外**（`**` を閉じた後）に置き、`<N>` をファイル名と揃えること — `（Issue #<N>）` を要約の中に埋めると `check` が不合格にします。
    - `<type>` は CLAUDE.md のコミットメッセージ規約と同じ語彙（`feat` / `fix` / `docs` / `refactor` / `test` / `chore` / `ci` / `style`）— 断片の検証（上の check）はこれ以外を不合格にし、リリースノート作成時の分類にも使います。
    - 1 エントリ＝1 行（折らない）— `CHANGELOG.md` は 1 エントリ 1 行で運用しており、`check` も {{AFTER_ENTRY_LINE}}以降に空行以外があると不合格にします。本文がどれだけ長くても改行を入れません。
  - `dev-reports/module-reference/issue-<N>.md` — `docs/module-reference.md` の表に足す注記を
    **行キー（`| \`path\` |`）ごと**に列挙する。既存行への追記なら「どの行に何を足すか」を書く。
    **既存行に足すときは `grep -n '^| \`<path>\`' docs/module-reference.md` を実行し、その出力
    （行番号つきの行キー）を断片に書き写してから**書くこと。0 件だった行への追記を指示しない
    （新しい行を足すなら「新規行」と明記する）。**ファイルの行が 0 件なら、親ディレクトリの行
    （`grep -n '^| \`<dir>/\`' docs/module-reference.md`。例 `src/lib/agent-health/`）も探し、あればそこに足す。**
    足すものが無ければ「追記なし」の 1 行でよい。実例:

    ```markdown
    ## 既存行への追記
    - `src/lib/session/worktree-status-helper.ts` — 実在確認: `docs/module-reference.md:103`（行番号は確認時点のもの）
      追記内容: 「private `getStatusCaptureLines()` を削除し `resolveCaptureSpec(cliToolId).statusLines` に置換（Issue #1933）」

    ## 新規行
    追記なし
    ```
- 断片が無いとリリースノートと module-reference に載らない。**実装と同じ commit の時点で書くこと。**
