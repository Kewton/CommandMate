# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **refactor(api,cli): tool/instance 解決を `resolveSessionTarget` に一本化し、CLI をサーバ委譲・版スキュー対応にする** (#1925): 「この要求はどのエージェントのどのインスタンス宛てか」の実装が **4 つ**あり、しかも答えが食い違っていた（設計 §3 P4）。`kill-session` は明示 `?cliTool` を roster より優先し矛盾を報告せず、CLI 側の写しには**プライマリインスタンスの段（instanceId がツール名、#868）が無かった**。CLI ツールIDは tmux セッション名の一部なので、食い違いはそのまま「別のセッションを触る」ことを意味する。**正本を `src/lib/session/resolve-session-target.ts` の 1 実装に寄せ**（優先順位は roster > 明示指定 > primary anchor > worktree 既定 > 既定エージェント、`instanceId` 未指定時は roster を見ない）、`GET /api/worktrees/:id/resolve-target`（`createRequestRateLimiter` 適用）と `GET /api/capabilities`（`{ serverVersion, capabilities }` の固定トークンのみ・`AUTH_EXCLUDED_PATHS` に入れない・`Cache-Control: no-store`）を新設した。CLI（`send` / `respond` / `capture` / `auto-yes`）は自前解決をやめてサーバへ委譲する。**挙動変化 3 件**: (a) **`kill-session` の解決が明示優先から roster 優先に変わり、矛盾時は 400 `instance_tool_conflict`**（従来は黙って明示側を採っていた）。あわせて「どれでも解決できない instance」への 400 が無くなり、`send` / `capture` と同じく worktree の既定エージェントへ落ちる。(b) **読み取り経路の矛盾は 400 ではなく警告つきで続行** — `capture --instance X --agent Y` が roster と食い違う場合、従来の exit 2 をやめて stderr に 1 行警告し roster 側を読む（監視スクリプトは capture の非 0 を「今回のポーリングを飛ばす」と解釈して無音で回り続けるため）。変更系（`send` / `respond` / `auto-yes --enable` / `terminal`）は従来どおり拒否する。(c) **`send --model` が解決後のエージェントに対して検証される** — `--instance copilot-2 --model gpt-5-mini` が `--agent copilot` の重複指定なしで通るようになった。あわせて `POST /api/worktrees/:id/terminal` が `instanceId` を受け付け、非プライマリのセッションへ送れるようになった（従来は常にプライマリ宛て）。**版スキュー**: `npm i -g` は稼働デーモンを再起動しないため、CLI は `GET /api/capabilities` をプロセス内 1 回プローブし（`Accept: application/json` ＋ `redirect: 'manual'`）、**本物の 404（本文が空 or JSON）だけ**を旧サーバと解釈して従来の 2 段解決へ縮退する（`resolvedBy: 'client-fallback'` ＋ stderr 警告 1 行）。401/403・3xx/HTML・500・通信エラーでは**フォールバックせず終了**する — 互換経路は primary anchor 段を持たない劣化解決なので、認証未通過や中間装置の応答をそこに落とすと `send` / `respond` の着弾先が変わりうる。

### Fixed

- **fix(verify): 並列ワーカーの verify が同時にフル `test:unit` を走らせ、diff と無関係の赤で exit 20 を返していた** (#1917): `/orchestrate` はワーカーの完了を `wait --verify` の **exit code だけ**で裁定する（#1544 / #1882）。その裁定が**マシンの負荷で反転**していた —— 2 ワーカーの verify が同時に `npm run test:unit` に到達した回だけ、サブプロセスの exit code を検査する `monitor-exit-codes.test.ts` が `exit 130` を取り逃して落ち、**その diff が触れてもいないテスト**で exit 20（不合格）になった（実測: 単独 486.5s / 553.4s は緑、同時実行の 640.5s だけが赤。単独再実行は 16/16 緑）。同一セッション中に再発しており、並列オーケストレーションでは構造的に繰り返す。二次被害のほうが重い: 「exit 20 は負荷かもしれない」と運用者が学習すると**本物の不合格まで疑われ、ゲートが形骸化する**。修正は**設定 1 行**である —— マシン全体のロック機構は #1771 で実装済み（`src/lib/verification/machine-lock.ts` / `verify-run.sh` / `mutex:` キー）で、**どのゲートも宣言していなかった**ことだけが欠けていた。`.commandmate/verify.yaml` の `unit` ゲートに **`mutex: cpu.heavy`** を宣言し、実装には一切手を入れていない。名前が `unit` でも `test-unit` でもないのは仕様 9.2 の命名規約による: mutex 名は**ゲート ID ではなく資源の名前**であり、ここで奪い合っているのは固定ポートでも DB でもなく「このマシンで重いスイートを走らせる枠」＝ CPU と実時間なので、`cpu.heavy` と名指しておけば**別リポジトリ**の同じくらい重いスイートが同じ名前を宣言するだけで同じ枠を共有できる（`unit` では自分自身としか排他できない）。**安いゲートには付けない**: 静的ガード 3 本（各 0.1s）は失敗を秒で返すために在るので（#1882）他 worktree の 500s の後ろに並ばせない。`lint` / `typecheck` も**実測に基づいて**見送った —— 2 worktree 同時実行で lint 5.4s / 5.2s、typecheck 10.8s / 10.6s といずれも緑のままで、負荷起因の赤を出した実績が無い一方、`mutex` を付けると「ロックが空かないまま `timeoutSec` に達した」＝ `SKIP reason=mutex-wait` ＝ **exit 99（裁定不能、仕様 9.4）** という**存在しなかった経路**を安いゲートに持ち込むことになる。実機検証は**隔離した DB・ロックルート・ポート**の CommandMate サーバに 2 つの使い捨て linked worktree を登録し、`commandmate verify` を**同時に起動**して行った（記録: [docs/qa/1917-parallel-unit-mutex.md](docs/qa/1917-parallel-unit-mutex.md)）。宣言が消えても他に赤くなるものが無いため、不変条件は `tests/unit/guards/verify-heavy-gate-mutex.test.ts` が固定する（`unit` が `cpu.heavy` を宣言する / 名前がゲート ID と一致しない / 静的ガードと lint・typecheck が直列化されない / mutex を宣言するゲートはちょうど 1 本）。

- **fix(guard): token discipline のパレット列挙が Tailwind 既定パレットの 11/26 ファミリーしか見ておらず、生配色が素通りしていた** (#1892): `TOKEN_DISCIPLINE_PATTERN` は #1082（gray/slate）と #1116（chromatic 9 色）で**その時コードに在った色を手で選んだ** 11 ファミリー列挙で、`neutral` / `zinc` / `stone` / `pink` / `rose` / `fuchsia` / `indigo` / `cyan` / `teal` / `emerald` / `lime` は検査対象ですらなかった。結果、移行済みディレクトリ内・`*Terminal*` 除外後・テスト除外後で **4 箇所の生配色が残ったまま** ガードが **exit 0（「生配色は無い」）** を返していた（`TreeNode` の `text-pink-500` ×2 / `VerificationPane` の `bg-neutral-900`・`text-neutral-100` / `gitPaneShared` の `text-teal-600`）。手で選んだ列挙は「誰も足そうと思わなかった色」について**構造的に無言**で、その無言はクリーンなツリーと区別できない。パレット一覧を `TAILWIND_PALETTE_FAMILY_NAMES` **1 箇所**に集約し、**不在検査の正規表現も実在検査（#1889）の組み込み配色判定も同じ配列から生成**するようにしたうえで、Tailwind 既定パレットの**全 26 ファミリー**へ拡張した。**列挙漏れが再発しない根拠**は「気をつける」ではなく機械で担保する: unit テストが `node_modules/tailwindcss/theme.css` の `--color-<family>-<step>` 実宣言を読み、この配列と**集合として一致すること**を検査する ＝ Tailwind を上げてファミリーが増えれば**その時点でテストが赤**になる（スクリプト自身が `tailwindcss` を import しないのは、CI の `token-discipline` ジョブが `npm install` を行わないため。#1889 と同じ制約）。実際この突き合わせで **Tailwind 4.3 が追加した `mauve` / `olive` / `mist` / `taupe`** が発覚し、拡張後の列挙に含めている。さらに**変異注入**（列挙を旧 11 ファミリーへ戻す）で新テスト 19 本が赤になることを確認した際に、**Issue が挙げていない 5 件目**が出た: `border-t-cyan-500`（`FileTreeView` のスピナー）は `(bg|text|border|ring)-<family>-<step>` の形に当たらず、**実在検査は「Tailwind 組み込み配色」と判定しているのに不在検査は見ていない**＝同じクラスについて 2 つの検査が食い違っていた。パターンに側面・オフセット segment（`border-t-*` / `ring-offset-*`）を足して塞ぎ、`border-t-accent-500`（cyan-500 と**同一 RGB**）へ置換した。置換は 5 箇所: ファイル種別アイコンの pink → `text-accent-500`、`untracked` の teal ペア → `text-accent-600 dark:text-accent-400`、スピナー → `border-t-accent-500`、そして `VerificationPane` のゲートログ `<pre>` → **新設のダーク島トークン** `bg-terminal-surface` / `text-terminal-foreground`。この `<pre>` は**常時ダークのまま維持**する判断で（CLI ゲートの生ログを流すターミナル出力面。#1075 分類 (a)、同じ画面に `TerminalDisplay` が並ぶ）、ガードの `*Terminal*` 除外へリネームで逃がす案は採らなかった — **「常時ダークである」という設計上の性質をファイル名の綴りに預ける**形であり、綴りを外れた瞬間に静かに壊れる（まさに `VerificationPane` がそれだった）。`--terminal-*` は `@layer base` の `:root` に 1 度だけ宣言し **`.dark` に対を置かない**ので、「テーマに追従しない」がトークンの定義そのものになる。値は `TerminalDisplay` が実際に描いている gray-900 / gray-300 に合わせ（旧 neutral-900 / neutral-100 から意図的に変更。コントラスト 11.6:1）、同じ「ターミナルのダーク」がコンポーネントごとに散るのを止めた。判断と不採用案は `docs/design-system.md` に記録。回帰テストは **develop に残っていた行を逐語で（実パスに）植えて CLI を実行し exit 1 を固定**し、トークンへ置換した同じツリーで exit 0 になることまで検査する。`*Terminal*` 例外・`.test.`/`.spec.`/`__tests__` 除外・`src/app/worktrees` 除外・#1889 の実在検査はいずれも不変（既存テストは緑のまま）、CI と `verify.yaml` が同じスクリプトを呼ぶ #1882 の構造も不変。

### Added

- **feat(guard): token discipline ガードに「トークン名の実在検査」を追加** (#1889): 従来のガードは生配色ユーティリティの**不在**しか見ておらず、実在しないセマンティックトークン名へ置換しても PASS した。Tailwind は解決できないクラスを黙って捨てるため、症状は「背景が消える／文字色が継承されて読めない」という**視覚だけの silent failure** で、クラス名が単なる文字列である lint・tsc・unit のいずれも検出できない（PR #1881 では実在を人間が `globals.css` の grep で手検証していた）。`scripts/check-token-discipline.mjs`（CI ジョブと `verify.yaml` ゲートが共有する #1882 の単一権威ソース）を拡張し、`(bg|text|border|ring)-<rest>` の `<rest>` が **Tailwind 組み込みの非配色ユーティリティ / Tailwind 組み込み配色 / `globals.css` の `--color-*`** のいずれにも当たらなければ hard-fail する。Tailwind に解決させず許可リストを採ったのは、CI の `token-discipline` ジョブが checkout ＋ `run:` 1 本で `npm install` を行わない（= `tailwindcss` を import できない）ため。Issue が指摘した「`--color-*` に無い名前は全部エラー」の素朴な実装は 121 種中 79 種を誤検出するが、許可リストを入れた時点で残る偽陽性は実測 11 種（`text-align` 等の CSS プロパティ名 6 種＋`a text-entry context` 等の英文コメント 5 種）まで落ち、コメント本文の除去と 「直後が `:` なら CSS 宣言」の判定で **0 種**になる（develop 現状で exit 0）。動的クラス名（`` `bg-${tone}-subtle` ``）・arbitrary value・4 接頭辞以外の配色ユーティリティ・コメント本文は**検出できない**ことをスクリプト冒頭と `docs/design-system.md` に明記。`*Terminal*` 例外・テストファイル除外・`src/app/worktrees` 除外は新検査にも同じく適用される。

### Fixed

- **fix(detection): `/send` の送信前 composer クリアが codex に効かず、残存があると本文が連結され続けていた** (#1890): #1880 は `extractComposerText` が claude 以外を `unsupported_tool` に短絡することを前提に**非 claude をクリア経路の手前で return** する設計だったため、codex は「壊れないが直りもしない」状態のまま残っていた（#1880 実機検証ケース7 で連結が再現）。同じ短絡により #1879 の未送信入力バーも `POST /api/worktrees/[id]/clear-composer` も codex では機能していなかった。`extractComposerText` に codex の入力箱を実測ベースで教え（`findCodexInputBox`）、`COMPOSER_CLEAR_SUPPORTED_TOOLS` に codex を追加して 3 つを同時に有効化した。codex は箱を描かないため claude の「終端セパレータ→開始セパレータ」探索は空振りする＝**フレーム末尾の空行区切りブロックを下から最大4つ辿って `›`(U+203A) 始まりのブロックを composer とする**構造探索に切り替え、codex が `›` を使う他の 2 箇所は属性で弾く（送信済みメッセージの transcript エコー＝**グリフが dim**、承認/model picker/hooks review の選択行＝**本文が bold**）。誤検知のコストは #1879 当時の「バーが出ない」ではなく**「送信のたびにクリアが暴発し最終的に送信自体を拒否する」**に上がっているため、判別できない形はすべて `no_composer` に倒す fail-closed 設計とし、placeholder（`Ask Codex to do anything` ほか 2 種）・承認ダイアログ・model picker・transcript エコーを **ANSI 保持の実 capture fixture** でテスト固定した（`tests/unit/lib/detection/fixtures/codex-live-1890/`、codex-cli 0.148.0 / 200x1000）。`cursor_x` による判別は**採らない**ことを実測で確定：codex では残存があっても Home を押していれば空 composer と同じ 2 を返す。gemini/copilot/opencode/vibe-local/antigravity は従来どおり `unsupported_tool` のまま（まず codex 1 つで確定させる）。claude の挙動は不変（実機で #1880 のケース1・ケース3 と dim ゴーストの非発火を再確認）。
- **fix(send): `/send` が composer の残存文字列と本文を連結する（本文が黙って改変・消失し、成功と報告される）** (#1880): `sendMessageWithSubmitVerification` は本文を **TUI の現在のカーソル位置に素のキーストロークで挿入**しており、composer に残存があると連結された 1 本のプロンプトが実行されていた。#1878 の実測で被害は 4 形（内容改変／スラッシュコマンド降格／カーソル行頭による順序反転／**残存が `/` 始まりのとき `Unknown command` で本文が完全消失**）、いずれも `exit 0` / `Message sent.` / `sessionStatus: ready` を返すため呼び出し側（CLI・`wait`・orchestrate ワーカー）から正常送信と**区別できなかった**。本文打鍵の直前に #1879 の `clearComposer()`（`C-e`+`C-u` を読み戻し検証つきでループ）を挟み、上限内に空にできなければ**打鍵せずに throw** する（黙って握り潰さない）。破棄した内容は `clearComposer()` に追加した `discardedText`（最初の読み戻し値。`remainingText` は最終読み戻しなのでクリア成功時は常に空で監査に使えない）としてログに残す。**claude 以外は従来どおり**：`extractComposerText` が claude 以外を `unsupported_tool` に短絡する＝`cleared` が常に false になるため、素直に「クリアできなければ失敗」とすると codex/gemini/copilot/opencode/vibe-local/antigravity が全滅する。ツール判定でクリア経路に**入る前に** return し、読み戻し capture もキー送出も発生させない（実測 codex 321ms は残存なし claude 330ms と同等）。`no_composer`（オーバーレイ表示中などで入力欄が画面に無い）も失敗と断定しない。実機（Claude Code v2.1.238 / Codex v0.148.0、200x1000 ペイン）で #1878 のケース1〜4・複数行残存・dim ゴースト・codex 退行なしを確認済み。

### Added

- **chore(verify): 検証ゲートの CI 網羅ギャップを塞ぎ、静的ガードの実装を `scripts/` に一本化** (#1882): `wait --verify` が**全ゲート exit 0** を返した commit が CI の `Token discipline` で FAILURE になった（PR #1881）。`.commandmate/verify.yaml` の宣言ゲートが `lint` / `typecheck` / `unit` の 3 本だけで、CI 11 ジョブのうち 8 本を見ていなかったためで、`/orchestrate` がワーカーの完了を exit code で裁定する設計を部分的に無効化していた。ただし **verify.yaml へ `git grep` や閾値をコピーしない**：同じ検査の実装が 2 箇所に増えると片方だけ更新されて静かに乖離し、乖離は必ず「verify は緑・CI は赤」の向きに倒れる。そこで `Token discipline` と `CLAUDE.md size check` の**インライン検査本体を `scripts/check-token-discipline.mjs` / `scripts/check-claudemd-size.mjs` へ切り出し**（既に `scripts/check-control-chars.mjs` を呼ぶ形だった `Control character check` に合わせた）、`ci-pr.yml` の当該ジョブは**そのスクリプトを呼ぶだけ**にしたうえで、verify.yaml に `token-discipline` / `control-chars` / `claudemd-size` の 3 ゲートを**同じスクリプトを実行する形で**追加した（実測 3 本合計 0.2 秒、裁定時間への影響はほぼゼロ）。Integration（2.1m）/ Legacy tmux / Security Audit / Build / E2E は所要と副作用のため追加していない。切り出しが挙動を変えていないことは**旧インラインシェルを抽出して新旧を同一入力で突き合わせ**て証明済み（clean / PR #1881 の生 sky 配色再現 / `*Terminal*` / `.test.`・`__tests__` / `src/app/worktrees` / CLAUDE.md の 34999・35000・35001 バイト境界で**出力・exit code とも完全一致**）。`*Terminal*` 例外（両テーマでダークを維持する意図的な常時ダーク島、#1079）を含む除外は新テストで固定し、除外を落とす変異注入で赤になることも確認した。実機では `commandmate verify commandmate-issue-1882` が新 3 ゲートを実行し、生配色を 1 行入れると **exit 20** を返す。
- **feat(ui): composer に残った未送信テキストを表示し、ワンクリックで実行・クリアできるようにする** (#1879): Claude が推奨コマンドを composer に事前入力した状態（あるいは人間が打ちかけて離席した状態）は、read-only ターミナル越しでは目で読んで打ち直すしかなかった。Enter を送れる既存 UI（`NavigationButtons` / `TerminalEscapeHatch`）は「迷子の Enter が composer に届かないように」検出フラグでゲートされており、通常の入力プロンプトでは意図的に出ないためである。capture payload に `composerText` / `composerState` を追加し、**中身が非空のときだけ**「未送信の入力」バーを PC・モバイル両方に出す。[実行] は**既存の** `special-keys` に `['Enter']` を送る（新 API なし）。[クリア] は新設の `POST /api/worktrees/[id]/clear-composer` で、#1878 §5-1 の実測（行頭カーソルでは `C-u` が何も消さない／複数行は 1 回では消えない）を踏まえ `C-e`+`C-u` を**読み戻し検証つきでループ**する。表示条件は `isUnclassifiedActive` / `isSelectionListActive` に一切依存せず、既存ゲートも不変（「中身が空なら Enter を送る導線は出ない」ことをテストで固定）。抽出は `stripAnsi` **前**の生 capture の SGR を見るため、Claude Code v2.1 が空の composer に dim（`ESC[2m`）で描くゴースト／プレースホルダを実内容と取り違えない（ANSI 除去後は実残存と 1 バイトも変わらないため、fixture も ANSI 付きの実 capture）。claude 限定。

## [0.26.1] - 2026-08-21

> **Highlight**: 高負荷環境でのみ落ちるテストを 3 件、**実測で機構を特定してから設計ごと**直したリリース。いずれも「上限を緩める」「閾値を上げる」ではなく検出力を保つ形に作り替え、**変異注入で検出力が落ちていないことを証明**している（#1849 は計測窓を絶対時間から関係へ、#1869 は競合の staging を 1→8 writer にしたうえでスケジューリングに依存しない決定的経路を追加、#1873 は共通 setup で採番の漏れを封じた）。3 件とも Issue 本文に書かれた原因仮説が実測で覆されており、とくに #1869 は「writer が飢餓する」ではなく「**高負荷が奪うのは CPU ではなく連続性**」だった（赤いラウンドでも writer は 101ms の walk 中に 462 回書き込めていた）。あわせて Epic #1848 で唯一未達だった「並列 worktree の e2e ポート衝突が env 注入で消える」ことを実機で記録し（導出ポート 3219/3220 で両方 PASS、対照の固定 3177 は衝突して FAIL）、v0.26.0 で出荷済みだった #1771 の配線を `playwright.config.ts` に入れた。**製品コード（`src/`）の変更は 1 バイトも無い。**

### Changed

- **test(verification): 並列 worktree の e2e ポート衝突が env 注入で消えることを実機で記録し、導出を `playwright.config.ts` に配線する** (#1871): Issue #1771 の env 注入（`CM_WORKTREE_ID` / `CM_WORKTREE_INDEX`）は v0.26.0 で出荷済みだが、**それを使う配線がどのリポジトリにも入っておらず、症状が消えたことが一度も確認されていなかった**（Epic #1848 の受入条件で唯一未達で残っていた 1 件）。2 つの linked worktree で e2e ゲートを同時に走らせ、実 exit code と**実際に LISTEN したポート**で記録した: 導出ポートでは `commandmate-e2e-probe-b` が **3219**（index 42）・`commandmate-e2e-probe-a` が **3220**（index 43）で**両方 PASS**（gate exit=0 / CLI exit=0。両ポートが同時に LISTEN していた秒を 11 秒観測しており、重なりは仮定ではない）。**対照実験**として同じ同時実行を `CM_E2E_PORT=3177` 固定で行うと後発が `[WebServer] Port 3177 is already in use` → `GATE e2e-fixed FAIL (exit=1, 3.9s)` / CLI exit=20 で落ちる ＝ **変更の欠陥とまったく同じ綴りの偽の赤**になることも記録した（両方緑では「注入が効いた」のか「そもそも重ならなかった」のか区別できないため、対照が落ちて初めて主張が成立する）。同じ機会に `mutex:` の直列化も確認し、`waited=0.0s` / `waited=14.3s` の 2 本と `duration=14.2s` / `12.8s` が**別々に立つ**こと（＝待ちを duration に足さない #1771 の契約）を実機で固定した。3 ラウンドの wall-clock 比較（導出 20s/20s ／ 固定 15s/5s(fail) ／ mutex 15s/**30s**）が「並列度を保てるのは env 注入だけ」という設計上の主張をそのまま数字にしている。配線は Issue が挙げた 2 案のうち **(b) `playwright.config.ts` 側で導出**を採った — verify 経由でなくても効くこと、`$((3177+${CM_WORKTREE_INDEX:-0}))` のシェル算術が不正値を黙って 0 に潰す（＝全 worktree が 3177 に戻り、まさに直そうとしている衝突が再発する）のを型のある場所で例外にできること、規則を `tests/e2e/fixtures/e2e-port.ts` へ分離すれば単体テストで固定できること（`playwright.config.ts` 自体は import 時に `~/.commandmate-e2e` を mkdir し git を起動するためテストから読めない）。優先順位は `CM_E2E_PORT`（明示）> `CM_WORKTREE_INDEX`（導出）> 3177（既定）で、**未設定・空文字だけがオフセット 0** ＝ #1871 以前の挙動と同一。**e2e ゲートは常設しない**と判断した: 宣言したゲートは既定で毎回走る（スキーマに「宣言はするが既定では走らない」フラグは無く、`gateIds` 省略時は work-evidence ＋ verify.yaml の全ゲートが選ばれる）ため、常設は `wait --verify` を 1 ワーカーあたり 5 分以上伸ばして並列オーケストレーションの裁定時間に直結する一方（CI 実績 E2E 5m16s〜5m39s）、フル e2e は `ci-pr.yml` が PR ごとに回しており verify ゲートはその複製ではない — 代わりにコストゼロの配線だけを常設し、必要なときの足し方を `.commandmate/verify.yaml` のコメントと設計書 §9.1 に残した。実測記録と再現手順は `docs/qa/1871-parallel-e2e-port-collision.md`。計測用 worktree（`commandmate-e2e-probe-a` / `-b`）は削除せず残してある。**`src/` は 1 バイトも変更していない**（#1771 の実装は出荷済みで、本件は配線と記録のみ）。副次観測として `~/.commandmate/worktree-index/` の 42 件中 40 件が実在しない `wt-*` ＝ `gate-runner.test.ts` / `gate-runner-timestamps.test.ts` / `hooks-agent-event.test.ts` が `CM_VERIFY_WORKTREE_INDEX_ROOT` を stub せず**開発者の HOME のレジストリに直接採番している**ことを確認したが、本 Issue のスコープ外として別 Issue 化を推奨する（本記録のポートが 3177+0,1 ではなく 3219/3220 になった理由でもある）

### Fixed

- **test(setup): unit スイートが開発者の実 `~/.commandmate/worktree-index/` に幻の採番を書き込むのを止める** (#1873): `executeRun` はコマンドゲートへ `CM_WORKTREE_INDEX` を渡すために `resolveWorktreeIndex(worktreeId)` を **`root` 無しで**呼ぶ（`src/lib/verification/gate-runner.ts`）ため、`CM_VERIFY_WORKTREE_INDEX_ROOT` を stub しないテストの `wt-*` フィクスチャが**マシン共有・意図的に恒久のレジストリ**に枠を取っていた（枠は削除しても解放しない設計なので、一度走ったフィクスチャの分だけ実在 worktree が使える番号が永久に減る）。実測: 起票時点の実レジストリは 45 件中 40 件が実在しない `wt-*`（`0 -> wt-window` 〜 `39 -> wt-counters-15`。実在は `40 -> commandmate-issue-1849` 以降の 5 件のみ）。**受入条件は「`test:unit` の前後でエントリ数が変わらないこと」では成立しない** — `resolveWorktreeIndex` は worktreeId で冪等（走査して owner が一致すれば既存枠を返す）なので、**既に汚染済みのレジストリでは修正の有無にかかわらず 2 回目以降は増えない**。そこで **`HOME` を使い捨てディレクトリに向けた子プロセス**で走らせ、実行後の `$HOME/.commandmate/worktree-index/` の**エントリ数を数えて**判定した: 修正前は 4 ファイル（`gate-runner` / `gate-runner-timestamps` / `hooks-agent-event` / `require-commit-conformance`）で **26 件**、修正後は **0 件**（どちらも vitest exit=0）。**対照実験**として setup の 3 行を外して同じ測定を行うと **20 件**（`gate-runner` と `hooks-agent-event` の 2 ファイルだけで）が再びクリーンな HOME に書かれ、新設ガードも 4 件中 3 件が赤になる ＝ **塞いだことが空振りでない**ことを確認している。塞ぎ方は**個別テストではなく共通 `tests/setup.ts`**（#1760 の `CODEX_HOME` と同型）に置いた — 危険なのは既定値のほうで、来月書かれるテストが穴を知らないまま継承できる場所でなければ再発するため。`??=` ではなく**未設定または空白のときだけ**埋める: `resolveWorktreeIndexRoot` 自身が空文字・空白を未設定として扱いhome へフォールバックするので、`??=` だと「export はされているが空」のシェルで塞いだつもりのまま実レジストリへ戻る。逆に**明示的に値が入っているときは尊重する**（この env は隔離ランナーのためにも存在する）。**Issue 本文の「どのテストも stub していない」は実測と食い違う**: 本文の `grep -rln "CM_VERIFY_WORKTREE_INDEX_ROOT" tests/` が 0 件だったのはリテラル文字列で検索したためで、`gate-mutex.test.ts` / `gate-flaky.test.ts` は**エクスポート定数 `WORKTREE_INDEX_ROOT_ENV` 経由で `vi.stubEnv` 済み**、`worktree-index.test.ts` は `{ root }` を明示的に渡している（いずれも今回の pin より優先されるので挙動は変わらない）。逆に本文が挙げていない `tests/unit/skills/cmate-verify/require-commit-conformance.test.ts` が **4 本目の漏らし元**だった（実レジストリの `wt-conformance-*` / `wt-counters-*` がこれ）。個別 stub を配って回る案を採らなかった理由でもある。再発防止に `tests/unit/verification/worktree-index-isolation.test.ts` を追加し、setup の綴りではなく**production コードが実際に読む実効ルート**（`resolveWorktreeIndexRoot()` を引数無しで）が home の外にあること・その主張が恒真でないこと（pin を外した既定は home 配下だと同時に検査する）・`root` 無しの実際の claim が pin 先に落ちて実レジストリの件数を変えないことを固定した。**実レジストリの既存エントリは 1 件も削除・変更していない**（幻エントリの掃除は別件。全測定は子プロセスの env としてのみ `HOME` を渡し、測定前後で実レジストリの全 45 行がバイト一致することを diff で確認済み）。**`src/` は 1 バイトも変更していない**
- **test(helpers): temp-dir のレース検証ハーネスを「負荷で成立しなかった競合」で赤にしない設計へ直す** (#1869): `tests/unit/helpers/temp-dir.test.ts` の `the writer never collided with the walk in 4 rounds` が**高負荷環境のフル `npm run test:unit` でのみ**落ちていた（実測: pristine な HEAD に 24 本の CPU バーナーを重ねてフル実行 3 連続 → 2 回赤。単独実行・無負荷フル実行・GitHub CI は緑）。**Issue 本文の仮説「writer worker がコアを取れず、main スレッドの walk が先に走り切る」は実測と食い違う**: ハーネスを計測して回すと、赤いラウンドでも writer は **101ms の walk の最中に 462 回の書き込みを成功させて**おり（4 ラウンドとも delta=462/672/913/571）、飢餓ではなかった。`startRacer` のフラグ待ちが先にタイムアウトしていたのでもなく（別メッセージになる）、テスト自体のタイムアウトでもない（3.3 秒で終わっていた）。真の機構は **Node の再帰 `rmSync` 自身が走査をやり直して再生成分を回収してしまう**ことで、ENOTEMPTY が外へ漏れるのは*内部リトライ梯子の間じゅう木が汚れ続けていた*ときだけ ＝ **writer が 1 スレッドだと、コアを失った 1 ミリ秒が walk にちょうど必要な隙間を与える**。同一条件の probe（同じ木・12 試行）での ENOTEMPTY 脱出率は writer 1 本が 無負荷 9/10・24 バーナー 11/12 に対し **64 バーナーで 0/12**、writer 8 本なら 12/12・12/12・**10/12**（96 バーナーでも木を 16→32→64 dir と大きくすれば 7/12→11/12→**12/12**）。したがって対処は閾値（ラウンド数・木のサイズ）の引き上げではなく、**(1) 競合を独立した 8 本の writer で staging する**（隙間を開けるには 8 本が同時にコアを失う必要がある）、**(2) ラウンドは木を大きくしながら wall-clock 予算内で回す**、**(3) それでも一度も重ならなかったら赤にせず、理由を stderr に出して skip する**（競合が成立しなかったことは被テストコードの欠陥ではない）。あわせて **スケジューリングに一切依存しない決定的テストを 2 本追加**し、PR #1660 が直した欠陥（`rmSync` の `maxRetries` は同じパスに `rmdir()` を再発行するだけで走査をやり直さないため、walk 中に再生成された子には空振りする）の検出力を負荷から切り離した: 読めない子ディレクトリ（`chmod 0o000`）で 1 回目の走査を確実に失敗させ（macOS/Node 24 では実機で親の `ENOTEMPTY` ＝ #1660 と同じコードが出る）、`onRetry` で障害物を外した 2 回目の走査だけが完了できること・障害物を外さなければ leak として stderr と `getLeakedTempDirs()` に載ることを検査する（0o000 を読めてしまう環境＝root 実行は probe して skip）。検出力は隔離 worktree での変異注入で確認済み（無変異=緑 7/7 ／ `attempts` を実質 1 に潰して再walkループを殺す変異=赤。**64 バーナー下 5 連続でも 5/5 赤**で、レース側が staging に失敗しても決定的テスト側が必ず捕まえる）。検証は 24 バーナー下で当該ファイル 10 連続 **10/10 exit 0**（skip 発生 0）・フル `test:unit` 6 連続で **temp-dir は 6/6 緑**（`app-version-display` / `tmux-capture-invalidation` の 5000ms タイムアウトは**修正前の pristine HEAD でも同条件で落ちる別件の負荷飢餓**であり本件の scope 外）。旧ハーネスと新ハーネスを同一負荷（24 バーナー＋フル `test:unit` 併走）で交互に 10 往復させた A/B では、**旧 1/10 が `the writer never collided with the walk in 4 rounds` で exit 1、新は 10/10 exit 0**（skip 0 ＝ 競合は毎回実際に成立している）。無負荷では `npm run lint` / `npx tsc --noEmit` / `npm run test:unit`（907 files / 16912 tests）すべて exit 0。**`tests/helpers/temp-dir.ts`（`removeTempDir` 本体）は 1 バイトも変更していない**
- **test(verification): gate-runner-timestamps の計測窓アサーションからスケジューリングジッタ依存を外す** (#1849): `does not let the cost of writing the row leak into the window` が単独実行では通るのにフル `npm run test:unit` でのみ落ちていた（実測: 24 本の CPU バーナー下で当該ファイルを 10 連続 → 3 回赤、`expected 463/470/482 to be less than 460`）。原因はロジックの回帰ではなく、上限 `GATE_SLEEP_MS + insertDelayMs = 400 + 60 = 460` が**`sleep 0.4` の spawn／wake／reap にかかる OS スケジューリングのジッタ 61〜82ms を許容できていなかった**こと（このテストは暗黙に「sleep が 15% 以上遅延しない」ことを前提にしていた）。上限を単に緩めるとこのテストの検出力そのものが消えるため、**書き込みコストの混入を絶対時間ではなく関係で表す**ように直した: INSERT のモックが自身の開始・終了時刻を観測し、`started_at` が**その書き込みが終わった後**であることを検査する（時間予算をまったく必要とせず、ジッタより小さい 1ms の混入でも赤くなる）。長さ側の混入を捕まえる上限は残したうえで注入コストと**一緒に設計し直し**、`INSERT_DELAY_MS` を 60 → 400ms（＝許容ジッタも 400ms、実測最悪値の約 5 倍）に引き上げた — 上限は注入コストそのものなので、**どう大きくしても混入は必ず全量が検出される**。注入待ちは busy-wait を `Atomics.wait` に変え（自分が測っている まさにそのプロセスと CPU を奪い合わないため）、対象ゲートの行だけが遅延を払うようにした。空振り防止として「注入が実際に払われたこと」も検査する。検出力は隔離 worktree での変異注入で確認済み（無変異=緑／`started_at` を書き込み時刻のまま残す・計測窓を INSERT 前から取る・`duration_ms` だけ膨らませる の 3 変異=いずれも赤。修正前のテストと同一の結果）。検証は 24 バーナー下 10 連続で 10/10 緑（修正前は同条件で 3/10 赤）。同ファイルの他の時間依存アサーション（`GATE_SLEEP_MS - 50` の 2 箇所・timeout ゲートの下限）は**いずれも下限＝負荷が強くするほど成立が固くなる向き**なので値は据え置き、その根拠をコメントに残した（timeout ゲートの `900` と `sleep 0.4` は設定値から導出するようにして、定数と実際に測る対象が乖離しないようにした）

## [0.26.0] - 2026-08-21

### Added

- **chore(skills): vendored な cmate-verify を上流と揃え、`mutex` / `retryOnFail` / `flakyIsPass` / `requireEnvClean` を受理させる** (#1861): v0.26.0 の verify.yaml parity は 3 リポジトリ位置・4 実装にまたがるが、#1771 / #1772 は `.claude/skills/sync-map.json` の sha256 pin を壊さないため vendored copy を意図的に触っておらず、**同じ verify.yaml が製品側（`commandmate verify`）では exit 0、vendored ランナー（`.claude/skills/cmate-verify/scripts/verify-run.sh`）では exit 2** に割れていた（実測 2026-08-20: `unknown gate key: retryOnFail` / `flakyIsPass` / `mutex` / `unknown options key: requireEnvClean` の 4 件で設定エラー）。上流 Kewton/commandmate-skills PR #225（`6faa33f`、skills #223 / #224）の `verify-run.sh`（554 → 963 行）を **`cmp` でバイト一致する逐語コピー**として取り込み、`.agents/skills/cmate-verify/` へもミラーした（同 verify.yaml の再実測で vendored も exit 0 / `GATE e2e PASS exit=0 duration=0s waited=0s` / `GATE env-clean SKIP reason=no-baseline` / `RESULT passed`）。`SKILL.md` は policy が `port-required` なので逐語コピーせず、キー表・ロック規約（`~/.commandmate/locks/<name>.lock` / `mkdir` / `owner` の pid・host・token / `CM_VERIFY_LOCK_ROOT`）・`waited` を `duration` に足さない契約・`CM_WORKTREE_INDEX` を standalone 側は設定しない理由を、CommandMate 側の Issue 番号（#1771 / #1772 / #1740）と相対パスに読み替えて書き直した。fixture は counterpart（`tests/fixtures/cmate-verify/fixtures/`）から 18 本を追加し、suite の assertion は 200 → **317**（`MIN_ASSERTIONS` は bash 側・vitest ラッパ側とも 300 に引き上げ、新セクションが黙って落ちても緑にならないようにした）。counterpart は fixture と run-tests.sh を package の外に置くため `skills-sync-map.mjs check --counterpart` が `scripts/tests/**` を MISSING と報告するが、これは**構造上の既知差**（vendored は Node の無い導入先でも suite を回せるよう同梱する）であり、その旨を sync-map のrationale に明記した
- **feat(cli): `wait` が「ターンが成立したか」を見るようにする** (#1839): 上流 API 障害でエージェントが何も実行せず composer に戻ると、`wait` は exit 0 を返し `--verify` は work-evidence ゼロ（exit 21）を返すため、呼び出し側が「ターンは成立したが成果物が無い」と誤読していた（実測 #1834: 529 × 13 に対し exit 21 が 12 回）。隔離環境の実測（2026-08-20 / stub 529 + 実 claude 2.1.236 / 実 API 不使用）で、崩れたターンでは **`Stop` hook が1 度も届かない**一方 `Notification(idle_prompt)` は +62 秒で届くことを確認し、`Stop` のみをターン終端とする判定を追加した（hooks が来ていないインスタンスの挙動は不変）。あわせて上流障害の署名を`src/lib/detection/upstream-faults.ts` に集約して `capture --json` の `upstreamFault` として公開し（canary の重複定義を解消）、opt-in の `wait --fail-on-upstream-fault` が exit 11 を返すようにした。`wait` の完了行には判定根拠（`basis=hook_stop`/`session_gone`/`scraper_ready`）が付く
- **feat(verification): FLAKY を一級の outcome にする（gate 単位 opt-in の同一 tree 再実行）** (#1772): ランナーの結果は PASS / FAIL しか無く、「この 1 件だけ赤ならまず再実行」は**人間の部族知識**だった（実測 2026-08-10 / Kewton/BorderFreeKidsMap: unit ゲートの禁止語検査 `not.toContain("fac-")` が**乱数 UUID の `9fac-` に一致して fail**し、同一 tree で再実行したら pass ＝ 1 fail 52 pass → 53 pass）。オーケストレーション配下ではワーカーもオペレータも赤の原因を自分の変更に求めて時間を焼く。gate 単位の opt-in `retryOnFail: 1` を追加し、**fail したゲートを同一 tree でもう 1 回だけ**再実行して、fail→pass を `FLAKY` として**両ランの exit code と duration ごと**記録するようにした。**値域は 0 か 1 のみ**（2 以上は設定エラー ＝ 十分な回数を回せばどんな赤も緑になるので上限そのものが機能の中身）、**2 回とも fail は FAIL のまま**、再実行するのは非ゼロ終了だけ（TIMEOUT は予算を使い切っており 2 回目が実時間を倍にする／mutex 待ちの SKIP と起動失敗はコマンドが 1 度も走っていない）、2 回目が裁定に到達しなければ**1 回目の FAIL が立つ**（2 回目を採ると work を裁定したゲートが exit 99 に化けて判定が弱くなる）。裁定上の扱いは `flakyIsPass` で選び、**既定は「FLAKY は fail 扱い」＝ ゲートは 1 bit も弱くならない**（`retryOnFail: 1` が買うのは「何が起きたか」に名前が付くことだけ）。**`flakyIsPass` は gate 単位**とした（skills #224 はこちらを正とすること） — `retryOnFail` が gate 単位である以上ゲート宣言 1 つで裁定まで読めるべきであり、`unit` の乱数 fail と `e2e` の実レースを1 つの答えに強制せずに済み、options 単位だと**決して発火しない宣言**（`retryOnFail` 無しのゲートに対する宣言）が正当な設定として通ってしまうため。`flakyIsPass: true` を `retryOnFail: 1` 無しで書くのは設定エラー。`verification_gate_results` に列が無く DB マイグレーションは scope 外なので、両ランの数値は #1771 の `waited` と同じ**`log_tail` の行頭アンカー** `[flaky] runs=2 outcome=flaky|fail exit=1,0 duration=45.0s,44.0s verdict=pass|fail` で運ぶ（`outcome=fail` でもアンカーを書く ＝ 2 回落ちは flakiness への反証であり advisor の分母。両ランのログ全文も残す ＝ 「2 回で何が違ったか」がこの機能の唯一の問い）。列に入るのは**その裁定を出したラン**の status/exit なので `status=failed` の隣に `exit=0` が並ぶ行は作らず、`duration_ms` は両ランの和で #1625 の `finished_at - started_at === duration_ms` も不変。GATE 行の確定綴りは `docs/design/verification-config.md` §9.3 の表（standalone `GATE unit FLAKY exit=1,0 duration=45s,44s` / CommandMate `GATE unit FLAKY (exit=1,0, 45.0s,44.0s)`。**`flakyIsPass` の値で綴りは変わらない** — pass と数えた FLAKY を `PASS` と綴ると本機能が可視化する唯一の事実が消える）で、仕様は同 §10。`verify show` と `verify --json` / `verify show --json`（`gates[].flaky`）から履歴として読み戻せる（`verify history` の一覧行はゲート要約に `log_tail` を含まない設計のため出ない）。**`retryOnFail` を宣言しないゲートの出力は 1 バイトも変わらない**
- **feat(verification): ゲートに worktree ごとの env 注入と gate 単位の `mutex` を宣言できるようにする** (#1771): verify.yaml のゲートはコマンドと timeout しか宣言できず、「このゲートはマシン上で同時に 1 つしか走れない」（固定ポート・ローカル DB・エミュレータ）を表現できなかった。並列 worktree で重なると後発が資源衝突で即 fail し、記録は `GATE e2e FAIL exit=1` だけ ＝ **変更の欠陥と環境の衝突が区別できない**（実測: BorderFreeKidsMap で planner が 9 wave を計算したのに e2e ゲートが 60303 番ポートを専有するため 16 回の直列 dispatch に開き直した）。対処は 2 段構えで、**並列度を保てるのは 1 つ目だけ**。(1) コマンド系ゲートの実行 env に `CM_WORKTREE_ID` / `CM_WORKTREE_INDEX` を注入し、`E2E_PORT=$((60400+CM_WORKTREE_INDEX))` で**衝突自体を無くせる**ようにした。**CommandMate は worktree を採番していない**（Issue 本文の前提は実測と異なる — id は basename 由来の TEXT 主キーで順序列も作成時刻も無く、唯一の並びは `updated_at DESC`）ため番号は新設のレジストリ `~/.commandmate/worktree-index/<n>` が `O_EXCL` で払い出す（同じ worktree は毎回同じ番号／同時に走る 2 worktree は必ず別番号。ハッシュ案は 30 worktree で約 35% 衝突するため fallback に留めた）。(2) `gates[].mutex: <name>` を追加し、同名を宣言したゲートを `~/.commandmate/locks/<name>.lock`（`mkdir` 方式。macOS に `flock(1)` が無い）でマシン全体で 1 つに直列化する。**待ち時間は `duration` に足さず `waited=` として別に記録する**（混ぜると timeout 調整と advisor の入力が歪む）。ロックが `timeoutSec` の間空かなければ **TIMEOUT ではなく `SKIP reason=mutex-wait`** で run は `error`（exit 99 ＝ 判定不能）＝ 20（不合格）ではない。lock path 規約・GATE 行の綴り・両ランナーが受理すべきキー集合は `docs/design/verification-config.md` §9 に確定した形で記載（skills 側 #223 がこれを正として実装する）。**`mutex` を宣言しないゲートの出力は 1 バイトも変わらない**
- **feat(polling): プロンプト dedup のスキップを `capture --json` に露出する** (#1695): 重複抑止で落としたプロンプトの累積回数と最終スキップ時刻を `promptDedup`（`skippedCount` / `lastSkippedAt`）として公開し、「プロンプトが出たはずなのに保存されていない」ときに dedup が原因か検出漏れ（#1676）かを CLI から判別できるようにした。あわせて response 側 dedup（`isDuplicateResponse`、#1268）に `duplicate-response-skipped` ログを追加（従来ログすら無かった）
- **feat(verify): scope ゲートに「何がどの allow パターンで許可されたか」の証跡を残す** (#1841): scope ゲートは違反 path しか報告せず、`allow` が完全一致 path だった頃は「パターン＝ファイル」で足りていたが、#1546 で `src/**` のような glob が正式化された後は**その run で実際に何が許可されたのか**が契約からも log からも読めなくなっていた。`log_tail` に `admitted:` 節を足し、合否を問わず「許可された変更 path ← それを許可した allow パターン」を残す。記録するのは**宣言順で最初に一致した**パターン（`allow: ["src/**", "src/lib/**"]` なら `src/lib/a.ts` は `src/**`。最後に一致を名指すと「消しても判定が変わらないルール」を読者に提示することになる）、`allow` に無いのに許可された path は `(exempt: .commandmate/)` / `(exempt: contract path)` と括弧付きで名乗り（契約を grep しても見つからないのが事実だから）、`deny` で落ちた path は `admitted:` に入らず `out of scope:` 側に**拒否した deny パターン**が付く（「revert する」と「allow を広げる」の切り分け）。両節とも 100 件（`MAX_REPORTED_VIOLATIONS`）で切り、切ったことを `  ... (+N more)` と名乗る — **切り詰めは表示規則であり、判定は全ファイルに対して行われる**（切った分の違反も exit に反映される）。`admitted:` を `out of scope:` より前に置いたのは、CLI が不合格ゲートの log を末尾 40 行しか表示しないため（後ろに置くと違反一覧とガイダンスが画面外へ流れる）。あわせて `verify --json` / `verify show --json` の scope ゲート結果に機械可読の `scope`（`admitted: [{path, pattern}]` / `violations: [path]` / `totals: {changed, admitted, violations}`）を足した（**既存フィールドは 1 つも変えていない**）。`totals` を別に持つのは 2 配列がレポートと同じ 100 件で切れるためで、「scope 外が在るか」は `violations.length` ではなく `totals.violations` で見る。**pass / fail の裁定は 1 バイトも変えていない**: `ScopeMatcher.isViolation()` は新しい `classify()` の否定に委譲するので、判定と証跡が食い違う経路そのものが無く、既存の scope-gate テスト 47 件は無改変で緑
- **feat(cli): stop-pattern が何にマッチしたかを `capture --json` に露出する** (#1694): `--stop-pattern` の発火は `autoYes.stopReason` で分かるが、何にマッチしたかはどの層にも出ておらず、ビルドログがパターン文字列を含んだだけの誤爆（#1678 A-5）と正当な停止を運用者が切り分けられなかった。マッチ行＋前後 1 行の抜粋を `autoYes.stopMatchedText` として露出する。抜粋は文字数ではなく **UTF-8 バイト**で 400 バイトに切り詰め（日本語フレームは 1 文字 3 バイトのため）、切り詰めたときだけ末尾に `…[truncated]` を付ける。抜粋は発火時のみ記録し、expired や手動 disable では持ち越さない（起きていない発火として読まれるため）
- **test(hooks): Auto-Yes v2（`PermissionRequest` 裁定）の実 TUI 検証を canary シナリオとして固定する** (#1847): #1724 の手動検証 3 項目のうち未記録だった 2 項目を、実 `claude` を回す検出カナリア（#1727）に `permission-hook-allow` / `permission-hook-no-decision` として固定した。本番の `buildClaudeLaunchCommand` が書いた `--settings` をカナリア内の受け口（`127.0.0.1:0` の ephemeral ポート）へ向け、裁定は本体の `resolvePermissionRequest` をそのまま呼ぶ（DB を要する契約読み出しと allow 監査の 2 箇所だけ `PermissionDecisionDeps` で差し替え）。`allow` でダイアログが出ずツールが走ること・`denyPatterns` 一致の no-decision でダイアログが出て `autoYes.lastSuppression` に理由が載ることを、pane と本番同一 getter で組んだ `structuredEvents` の両方で確認する。非空振りは新フラグ `--mutate-verdict`（受け口が逆の裁定を返す）で証明する。あわせて **Claude Code 2.1.236 で既定の permission mode が auto mode になった**ため承認ダイアログ自体が描画されなくなっていた問題に対処し、全カナリアセッションを `--permission-mode manual` で起動するようにした（2 本目以降のセッションだけが起動タイムアウトで落ちる形で表面化していた）

### Changed

- **refactor(hooks): `AgentEventSource` の I/F 申し送り 5 件を裁定する** (#1846): #1759 の抽象は 6 ツールを I/F 変更ゼロで受け止めたが、その過程で 5 件の申し送りが**報告だけされて未裁定**のまま残っていた。7 本目のツールが同じ回避策を書く前に、全件に採用／不採用を付けて `docs/design/agent-event-source-interface.md` §3.3 に残した（**不採用の理由も残す** — 同じ申し送りが 3 回目に来ないようにするため）。線は 1 本: **2 実装以上が独立に同じ回避策へ到達したものだけ I/F に入れる**。**採用 2 件**: ①`prepareLaunch` の引数を `AgentLaunchContext{target, executablePath, worktreePath}` へ（`worktreePath` は必須）。gemini の `injectGeminiHookSettings()` 別 export（#1762 の回避策。`cli-tools/gemini.ts` が 2 回呼んでいた）が消え、6 ソースとも設定書き出しが `prepareLaunch` 1 箇所に揃う。`AgentInstanceRef` は**キー**なので 3 フィールドのまま ②`AgentLaunchPlan.env`（必須）と `renderAgentLaunchCommand`。codex / copilot / gemini / antigravity の**4 実装が独立に** `NAME=value ` を `command` へ前置しており（宣言されていない前提＝「起動側はシェルである」に 4 箇所が乗っていた）、これを剥がして適用を 1 箇所に集約した。**ペインに送られるバイト列は 1 バイトも変えていない**。**不採用 3 件**: ③`NoDecisionBehavior` への `denies` 追加 — 前提が失効している。「agy は `blocks` で近似」は #1762 時点の話で、#1779 が agy 1.1.12 を実測して `proceeds` に直しており（`src/lib/hooks/sources/antigravity/source.ts:181`）、`{}` を送るのは CommandMate ではない ④`supportedEvents` の `emittable`/`delivered` 分割 — **「届く語」である**と型 doc に明記するに留めた。分割すると消費層がどちらを見るか選ばされ、`emittable` を選ぶと copilot の `pre_tool_use` と gemini の `BeforeTool` でちょうど永久に待つ ⑤`definePullEventSource` への turn-gate 内蔵 — 状態機械は汎用でもフレーム語彙が完全に opencode 固有なので、**pull 型を足すときの必須手順**（§4 手順 6′ / §5）にした。裁定は不採用分も含め `tests/unit/hooks/sources/launch-contract-1846.test.ts` が固定する

### Documentation

- **docs(cli): `capture --json` の各フィールドの意味論を明文化する** (#1840):
  `docs/user-guide/cli-operations-guide.md`（および `docs/en/` の対応節）の capture 節に、
  `content` / `realtimeSnippet` / `lineCount` / `isRunning` /
  `sessionStatus`・`sessionStatusReason` / `structuredEvents`・`lastStopEventAt` の 6 行表を追加した。
  監視スクリプトが実際に踏んでいた 2 つの誤読を名指しで潰している:
  **`content` は `lastCapturedLine` 以降の差分**なのでポーラーが先に保存していれば正常時でも空
  （`src/lib/session/current-output-builder.ts:535-556`）、
  **`isRunning` は tmux セッションが存在して healthy という意味だけ**でターン進行中ではない
  （`src/lib/session/claude-session.ts:543-556`）。画面が空かどうかは
  `realtimeSnippet.trim() === ''` と `lineCount` で見る。あわせて wait 節に、完了判定が
  `sessionStatus === 'ready'`（未分類フレームでない）またはセッション消滅であって
  **ターンの成立は見ていない**ことを明記した（`src/cli/commands/wait.ts:356`）

### Fixed

- **chore(skills): vendored な cmate-verify が run の途中で自分の `$WORKDIR` を消していた欠陥を上流から取り込む** (#1864): `.claude/skills/cmate-verify/scripts/verify-run.sh` は `.claude/skills/sync-map.json` の sha256 で counterpart に pin されているため、#1861 でバイト一致させた直後に上流 Kewton/commandmate-skills #228（PR #230 = `9604e8f`）が欠陥を修正した結果、**vendored copy だけが欠陥を抱えたまま**になっていた。欠陥は「速いゲートほど確実に踏む」もので、ゲートが watchdog の fork より先に終わると `wait` が即座に返り、その直後の `kill -TERM "$rga_wpid"`（timeout watchdog の後始末）が **fork 直後の subshell** に届く —— bash は fork した子で signal handler は reset するが **EXIT trap の文字列は残す**ので、子が自分の signal disposition を戻す前に catch 可能な signal を受けると `termsig_handler() → run_exit_trap()` が親から継いだ `rm -rf "$WORKDIR"` を実行し、**まだ走っている run の作業 directory** が消える。以降のゲートは `verify-run.sh: line 734: /tmp/cmate-verify.XXXXXX/gate-<id>.log: No such file or directory` を出したうえで `FAIL exit=1 duration=0s`（出力なし）＝ **何も裁定していない不合格**を返していた。修正は上流の逐語コピー（963 → **993 行**、counterpart と `cmp` でバイト一致）で、引き金（`kill -s KILL` ＝ SIGKILL は catch できないので死ぬプロセスの中で shell の code が 1 命令も走らない）と結果（EXIT trap を `cleanup_workdir()` にし、`BASH_SUBSHELL` が 0 ＝ top-level shell でなければ何もしない）の**両方**を塞ぐ。回帰は counterpart から取り込んだ fixture `workdir-lifetime.yaml`（48 ゲートすべてが即座に fail するので runner は全ゲートの log tail を出さねばならない）を 12 回回す run-tests.sh の case 23（4 assertion。48×12 は上流の変異実測で「修正を全戻しすると 20 回中 20 回赤」になる最小単位で、24×6 では 20 回中 15 回しか赤にならない ＝ 4 回に 1 回見逃す回帰テストになる）。あわせて #225 から在った**別の flake** —— `duration=3s` の literal 一致に依存した mutex assertion（duration は `date +%s` の秒単位計測なので 3 秒の hold が秒境界をまたぐと 4 と読める）を「`waited` はちょうど 0」と「duration は 3 秒以上」の 2 つに分割 —— も同じ移植で取り込んだ。suite の assertion は 317 → **322**。`.agents/skills/cmate-verify/` へもミラーし（`diff -r` 無差分）、sync-map の pin を 59 files へ張り直した（counterpart は fixture と run-tests.sh を package の外に置くため `check --counterpart` が `scripts/tests/**` を MISSING と報告するのは従来どおり**構造上の既知差**）。**実測（macOS 26.6 / bash 3.2 / arm64）: `bash .claude/skills/cmate-verify/scripts/tests/run-tests.sh` を 20 回連続で回して **20/20 緑**（毎回 322 passed, 0 failed）。`No such file or directory` と `no output captured` の署名はどの run にも 0 件、`not ok` 行も 0 件**。これを受けて #1863 が `test-unit` だけ `ubuntu-latest` に固定していた `ci-pr.yml` の TEMPORARY EXCEPTION を外し、他 9 ジョブと同じ fork フォールバック付き `self-hosted` 条件式へ戻した（ARM64 の self-hosted runner は本欠陥を毎 run 再現させていた唯一の環境で、固定はその再現環境を失わせていた）
- **ci(e2e): Playwright インストールのハングを実測に基づき apt 側で塞ぎ、ブラウザは解決後バージョンでキャッシュする** (#1844): `test-e2e` の `npx playwright install --with-deps chromium` が繰り返しハングしていた（2026-08-19 だけで 88 分 / 3h55m / 3h48m、その後 #1830 のステップ上限 20 分に当たって run `32248871561` が赤）。Issue は `~/.cache/ms-playwright` のキャッシュを最優先の主因対策として挙げていたが、当日の E2E ジョブ 6 本のステップログを `Downloading Chrome for Testing` 行で二分して実測すると、**ブラウザのダウンロードは全サンプルで 0.09〜0.11 分と一定**で、バラつきもタイムアウトも 100% apt 側だった（apt フェーズ 0.20m / 3.14m / 7.63m / 9.22m / 10.44m / タイムアウト）。ubuntu-24.04 ランナーでは Chromium の実ライブラリは全て導入済みで、`--with-deps` が実際に取得するのは**フォント 9 パッケージ 21.1 MB だけ**（azure.archive.ubuntu.com が 14〜21 kB/s に落ちるのが原因）。`tests/e2e` に画素比較（`toHaveScreenshot` / `toMatchSnapshot`）は 1 件も無く、スクリーンショットは失敗時の調査用のみなので、このフォントが合否を変えることはない。よって 1 ステップを分割し、(1) システム依存 `playwright install-deps` は 6 分予算の `continue-on-error`（超過時は `::warning` を出して続行、本当に必要なライブラリが欠ければ `Run E2E tests` が Playwright 自身のエラーで落ちる）、(2) ブラウザは `actions/cache` で `~/.cache/ms-playwright` をキャッシュし、キーは `package.json` の `^1.56.1` ではなく**解決後の実バージョン**（`playwright-core/package.json` の `version`）に紐付け、古いブラウザでのヒットを避けるため `restore-keys` は付けない。キャッシュヒット時はダウンロードステップ自体をスキップする
- **fix(cli): `wait` の抑止通知が全ての reason を「契約由来」と名乗る** (#1843): `formatSuppressionNotice` の前置きが `by contract policy` 固定だったため、#1829 が追加した `agent-launch-dialog`（codex の起動ダイアログはツール自身の起動シーケンスに任せるという**製品側の判断**。契約は一切関与しない）まで契約の仕業として表示され、契約を使っていない worktree の運用者が存在しない `denyPatterns` を探す羽目になっていた。reason ごとに前置きを出し分け（契約由来の 4 種＝`mode-off` / `deny-pattern` / `deny-pattern-unusable` / `type-not-allowed` は従来文言のまま、`agent-launch-dialog` は「起動ダイアログ表示中」と述べる）、**未知の reason は契約由来を騙らずそのまま名指しする**。出し分けは `Record<AutoYesSuppressionReason, string>` なので reason を足して文言を決め忘れると `tsc` が落ち、CLI 側のミラー型がサーバ側の union から離れた場合も `tests/unit/cli/config/cross-validation.test.ts` の型アサーションで `tsc` が落ちる。`wait --json` の `autoYesSuppression.reason` は不変

## [0.25.0] - 2026-08-19

> **Highlight**: 公開面（LP・README・チュートリアル・concept）を **Vibe Engineering** の軸へ据え替えた回（Epic #1807、子 Issue 10 件）。あわせて収録基盤 `demo-video` が worktree ID の path 由来化に追従できておらず**実収録が必ず失敗する**状態を復旧し、さらに `fake-agent.sh` が承認フレームを自動応答してしまい **`wait` が「起きていない作業」に `Completed` を返す**欠陥を修正した。これを直さないまま撮っていたら、全デモが「検証を通ったことになっている」だけの映像になっていた。製品側では実行契約と検証結果を Web UI に露出し（#1816）、codex 起動ダイアログへの Auto-Yes 誤応答（#1829）と CI のハング放置（#1830）を塞いだ。

### Added

- **feat(demo-video): 新シーン・code card・静止画生成を追加する** (#1810): `contract-verify`（tmux pane を収録し、`send --contract` → `wait --verify` の `GATE` / `RESULT` / 終了コードを**実ゲートの実 exit code のまま**映す）・`attention-badge`・`review-screen`・`slash-palette`・`install-skill` の 5 シーン、絵コンテの `type: code`（ファイルを組版する静止カード。`source` は絵コンテのディレクトリ配下に閉じることを解決後のパスで検証）、および LP / README 用の静止画 5 点を同じ隔離環境から機械生成する `stills.ts`（バイト予算はゲートで、収まらなければ**書かずに落ちる**）


- **feat(ui): 実行契約と検証結果を Web UI に露出する** (#1816)
  - **worktree 詳細ヘッダに状態チップを追加。** task 行を持つ worktree に限り、直近 task の
    title・TaskStatus・直近検証ランの `RESULT` を表示する。判定の**理由**（不合格ゲートの ID
    一覧まで）を `aria-label` と `title` の両方に出すため、ポインタでもスクリーンリーダーでも
    ペインを開かずに読める（`docs/design/discoverability-principle.md` 実装規約 1）
  - **Activity Bar に「Verification」ペインを追加**（スマホは Tools タブの「検証」サブタブ）。
    上段=現在の契約（title / goal 冒頭 / `scope.allow` / `verify.gates` / `autoYes.mode`）、
    中段=検証ラン一覧＋「再検証」、下段=選択ランのゲート表（gate id / PASS・FAIL・TIMEOUT・SKIP /
    exit code / duration / logTail 末尾 40 行＝CLI の `MAX_PRINTED_LOG_TAIL_LINES` と同値）。
    契約が無い worktree には `commandmate send --contract` と Skill `cmate-task-contract` を案内する
    空状態文を出す
  - **新しい API は 1 つも追加していない。** #1542 / #1543 / #1545 で既に在った
    `GET /api/worktrees/:id/tasks`、`GET|POST /verify`、`GET /verify/runs[/:runId]` の配線のみ
  - **独自のポーリングタイマーを増やしていない。** worktree 詳細が既に回している 2s/5s の
    ポーリング末尾で `pollTick` を上げ、`useWorktreeVerification` がそれに相乗りする
    （通常は 15s スロットル、`running` ラン中はティックごと）。ヘッダチップと Verification ペインは
    同じフックの 1 インスタンスを共有するので、2 面同時表示でも要求は倍にならない
  - en の `RESULT` / `GATE` 語彙は `docs/design/verification-config.md` §3.4 に合わせた
    （`passed` / `failed` / `not_started`、`PASS` / `FAIL` / `TIMEOUT` / `SKIP`）。
    tests/unit/i18n/verification-keys-1816.test.ts が en/ja のキー等価と語彙一致を固定する
  - `docs/design/discoverability-principle.md` の「運用者が読む層」に Web UI を追加し、
    実装規約に「新しい判定は CLI と Web UI の両方に出す」を追加

### Changed

- **ci: 全ワークフローの全ジョブに `timeout-minutes` を設定する** (#1830): GitHub Actions の既定タイムアウトは 360 分（6 時間）で、`ci-pr.yml`（11 ジョブ）/ `pages.yml` / `publish.yml` には `timeout-minutes` が 1 つも無かった。2026-08-19 に develop の run `32218070769` で `E2E Tests` が `Install Playwright browser` のまま **88 分**ハングし、手動キャンセル → `gh run rerun --failed` で 6 分 47 秒で success（CDN 由来の一過性）。値は直近 12 ランの成功ジョブの実測（median / max）から **`max × 2`・最低 10 分**で決め、根拠は各ジョブのコメントに残した（E2E 6.2m/16.2m → 30、Unit Tests 12.3m/13.2m → 30、他は 10）。`publish.yml` は実測 median 14.3m / max 16.0m（n=10）が存在したため Issue 記載の 20 分ではなく **30 分**とした。あわせて、自前で外部からバイトを取得するステップ（`npm ci` / `npx playwright install` / `apt-get install` / `npm install` / `npm audit` / `npm publish`）にステップ単位の `timeout-minutes` を付け、タイムアウト時に「どのステップで詰まったか」がログから読めるようにした。`tests/unit/guards/workflow-timeouts.test.ts` が、ジョブの付け漏れ・360 分以上の無意味な値・ジョブ上限以上の死んだステップ上限・未設定のインストールステップを赤にする

### Documentation

- **docs(tutorial): 契約 → 検証ループを体験する構成へ改稿し、GIF 8 本を v0.24 の UI で撮り直す** (#1813): ja / en のチュートリアルを Fork → 登録 → Skill 導入 → **ゲートを赤で確認（exit 20）** → 契約を渡して判定（exit 0）→ 2 契約を並列 → 証跡 の 8 ステップへ改稿し、各ステップに「エンジニアならここで何を気にするか」を 1 行添えた。旧 §1.5 の誤記（「Skill は同じ場所へ入れ直せない」＝ #1243 / #1244 以降は誤り、install 先が 1 ディレクトリ）を、更新フロー・`.agents/skills` と `.claude/skills` の 2 ディレクトリ・再起動が要る理由に置き換えた。GIF は 8 本 × ja / en を隔離環境で撮り直し（旧 5 本 × 2 は削除）、絵コンテを `docs/images/tutorial/storyboards/01…08-*.yaml` に差し替えた。demo-video スキルには `verify-red` と `evidence` の 2 シーン（`cli-scene.sh --mode`）を追加している。掲載する出力はすべて実機の実測値で、`commandmate verify <id>`（ゲート無指定）が work-evidence で **exit 21** を返すこと、`wait --verify` は**開いている契約**に対してのみ契約ゲートで判定することも本文に明記した

- **LP（`website/`）を Vibe Engineering 軸の v2 へ作り替え** (#1812): 文言は `docs/design/public-messaging.md` からコピーし（hero H1・定義文・4 カード・With / Without 7 行・キャプション・footer タグライン）、独自に言い換えていない。hero の静止画は**ループ図の inline SVG**（要求 → CommandMate → Coding Agent → 検証された成果物、色はすべて CSS 変数で light / dark 追従、`role="img"` ＋ `aria-label`）へ差し替え、ダッシュボード静止画は Gallery 先頭へ移した（og:image は引き続き同ファイル。SVG は social preview に描画されないため）。契約 → 実行 → 検証の 4 拍を実物のコード片（`Kewton/commandmate-tutorial` の `verify.yaml` / `tasks/fix-shout.yaml`、`GATE` / `RESULT` / `exit 0`）で見せる `#loop` 節を新設。競合 4 製品名の比較表（`#comparison`）は `#with-without` へ置換し、ナビも差し替えた。デモは `docs/images/features/` の `cm-11` / `cm-03` / `cm-01` / `cm-12` の en 版を **byte-for-byte コピー**した 4 本に入れ替え（`cmp` で確認、旧 3 本は削除）、Track A のセットアップ質問を実装どおり 5 項目（`CM_BROWSE_ROOTS` を含む）に、チュートリアル導線を 15 分・fork してから・契約 → 検証へ直した。ガードは `website/**` からの禁止語一掃・定義文の逐語一致・`#with-without` 7 行・byte-for-byte・hero SVG の色がすべて CSS 変数であること、を追加した
- **README のデモ GIF 2 本を隔離環境の素材へ差し替え、旧 `demo-*.mp4` を削除** (#1815): `docs/images/demo-desktop.gif` は `cm-11-contract-verify.en.mp4` の 0〜18 秒（title カード → 契約 YAML → `verify.yaml` → 実ゲートの `GATE` 3 行・`RESULT passed`・`0`。outro の URL カードは README では冗長なので落とした）、`docs/images/demo-mobile.gif` は `cm-03-never-miss-waiting.en.mp4` の `respond-from-mobile`（14〜18 秒）を 1280x800 の合成から **520x800 に切り抜いた**もの。切り抜き幅はスマホ枠（実測 x=455..824 の 370px）ではなく**テロップ帯の文字幅**で決めた — 枠幅で切ると "Answer from your phone." が途中で切れ、帯の全幅（x=343..935 の 594px）で切るとスマホが 187px まで縮んで画面の字が読めなくなる（3 案を出力解像度のまま描画して比較した）。生成は `.claude/skills/video-to-gif/scripts/to-gif.sh` に**現行バイト数をそのまま予算として渡し**（desktop 1,929,059 / mobile 4,230,486）、両方とも rung 1（600px / 300px・10fps・256 色）で収まった: **desktop 909,922 バイト（現行の 47%）・mobile 180,521 バイト（同 4%）**、どちらも GIF89a。旧素材に映っていた私有情報（私有リポジトリ名 6 件・LAN IP `192.168.11.6:3001`・旧製品名）は隔離環境の seed（`cmdemo-app` / `wt-dark-mode` / `feature/demo-dark-mode`）に置き換わっている。確認は代表フレームの目視だけで止めず、**出荷される GIF から全 220 フレーム（desktop 180 / mobile 40）を復号して tesseract で OCR し**、私有リポジトリ名・個人パス（`/Users/`）・プライベート IP・旧製品名・ポート番号のパターンに 1 件もヒットしないことを実測した。未参照のまま残っていた旧 `demo-desktop.mp4`（22,674,969 バイト）/ `demo-mobile.mp4`（47,195,161 バイト）は削除し、`git ls-files docs/images | grep demo-` を GIF 2 本だけにした。README（EN / JA）の `alt` は "CommandMate Desktop Demo" のような何も説明しない文字列をやめ、`docs/design/public-messaging.md` §5 / §6 の確定語彙に合わせて映像の内容を書いた

- **特徴デモ 12 本を新シーンで撮り直し、product-highlights を Vibe Engineering 軸へ更新** (#1811): 絵コンテ 12 本（`cm-11-contract-verify` / `cm-12-install-skill` を新設）を書き直し、48 ファイル（12 × ja/en × gif/mp4）を隔離環境から一度に撮り直した。旧 10 本は同一 4 シーンの使い回しで、`cm-01` と `cm-08` の 9 秒地点が SSIM 0.970（ほぼ同一フレーム）だったのに対し、新しい 5 本（`cm-01` / `cm-03` / `cm-09` / `cm-11` / `cm-12`）は代表フレームの総当たり SSIM が最大 0.828・最小 0.080 まで離れている。`cm-11` は tmux ペインを収録し、実ゲートの `GATE work-evidence / scope / unit PASS` ・ `RESULT passed` ・ `0` をそのまま映す。product-highlights（ja / en）は "control plane" を除いて `docs/design/public-messaging.md` の定義文と 4 段の梯子に差し替え、11・12 を先頭に置いた 12 見出し構成（ja / en 一致）にし、「デモが映している範囲」を実際のシーン構成へ更新した

- **cm-11（contract-verify）のテロップ帯が GATE 行に重なっていたのを直し、ja / en を再収録** (#1811): 端末シーンのペインを 32 行から **26 行**に下げ、`cli-scene.sh` が `send --contract` と 1 回目の `wait` の**機械可読な stdout**（task id ・ プロンプト JSON、合わせて 8 行）をファイルへ逃がすようにした（バナーはリダイレクトごと表示するので、ペインは実行していないコマンドを映さない）。帯の位置（`telop.html` の `margin-bottom: 7.5%`）は他の 11 本のレイアウトを動かさないよう据え置き。あわせて **黙って切り詰められたテイクが合成を通ってしまう穴**を塞いだ: `respond` 後の同期プローブが「生成中」だけを待っていたため、カセットが先に完走した回はプローブが 90 回空振りしてペインを収録途中で殺し、`Response sent.` で終わる映像がそのまま cut になっていた（実測: ja 版のテイクが 138 秒・GATE ブロックなし）。プローブは「プロンプトに留まっている / 生成中 / 応答なしで静止」の 3 状態を返すようにし、静止は capture キャッシュ（5s）を跨ぐ 6 回連続で受理する。`recordTerminalScene` は最終フレームに `RESULT passed` が無ければテイクを失敗させる

- **README（EN / JA）の hero・Key Features・ワークフロー節・比較表を Vibe Engineering 軸へ整合** (#1814): hero を `docs/design/public-messaging.md` の H1 ＋定義文に差し替え、Key Features 先頭に Task Contract / Verification Gates / Evidence & Metrics / Skills Catalog / 入力待ち通知の 5 行を追加し、Multi-Agent 行を 7 CLI（`CLI_TOOL_IDS` 実数）へ更新した。「Optional Workflow Layer」は `## Vibe Engineering workflow` へ昇格して "optional, not required" を削除し、公式 Catalog Skill と `send --contract` → `wait --verify` の最小コマンド列で説明する構成に変えた（`.claude/commands` 表はこのリポジトリ限定である旨を明記して 1 行リンクへ縮退）。競合 4 製品名の比較表は With / Without CommandMate 表に置換。ガード `tests/unit/docs/public-messaging.test.ts` の対象に両 README を追加した

- **Mission / Vision を `docs/concept.md` / `docs/en/concept.md` に正本化し、公開面の文言表 `docs/design/public-messaging.md` を新設** (#1808): hero・定義文・4 カード・With / Without 表・デモのキャプションとテロップ・チュートリアル導入文・footer タグライン・禁止語リストを ja / en 両方で確定した。軸語 "Vibe Engineering" の一次情報（Simon Willison, 2025-10-07）を実際に確認し出典として記録。禁止語リストはガードテスト `tests/unit/docs/public-messaging.test.ts` の配列と一致していることを固定している

- **docs(en): verify / task / skills / hooks の英語ドキュメントを JA と同構成に整備** (#1817) — `docs/en/user-guide/cli-operations-guide.md` に `sync` / `verify` / `task`（実行契約・`gateDefinitions`・無人実行テンプレート）/ 読むモード / `instances` / マルチセッション / `skill` / `report metrics` の各節を追加し、`docs/en/user-guide/skills.md` と `docs/en/user-guide/agent-event-hooks.md` を新規作成。EN `commands-guide.md` に「このリポジトリ限定」の明記と全 27 コマンド表を追加し、`tests/unit/docs/ja-en-heading-parity.test.ts` が 4 対の ja/en で `##` 見出し数の一致を固定する

### Removed

- **refactor(review): 未使用の `ReviewCard.tsx` と 8 tests を削除する** (#1824): `src/components/review/ReviewCard.tsx`（91 行）は `#600`（`ed612bcf`）で `/review` が `ReviewTab` へ移行した時点から呼び出し元がゼロで、`tests/unit/ReviewCard.test.tsx` の 8 tests は出荷 UI を何も保証しないまま緑を出し続けていた（実際 #1810 の `review-screen` シーンはこの testid を同期点に据えて起票され、収録が空振りした）。`ReviewCard` 固有の 4 挙動（`?pane=terminal` 付きリンク / `nextAction` 行 / 行ごとの `ReviewStatus` バッジ / インライン返信の `children` スロット）は `ReviewTab` の現行 UI で代替済みか、統合すると出荷中の UX 変更になるため取り込まない。どこも読まなくなった `review.status.done` を en / ja の `locales/*/review.json` と `tests/unit/i18n/review-keys.test.ts` の `RUNTIME_KEYS` から外し、i18n ガードが「実際に解決されるキー」だけを固定する状態へ戻した

### Fixed

- **fix(codex): Auto-Yes が codex の起動ダイアログを勝手に確定してセッションが hooks レビュー画面で固着する** (#1829): Auto-Yes は既定ルールで「既定の選択肢＝option 1」を送るため、codex の `Hooks need review` に `1. Review hooks`、update 通知に `1. Update now` を撃っていた。前者は #1760 の `3`（trust せず継続）を無効化して `t`/`esc` しか出口の無いレビュー画面へ、後者は #890 が防いでいた `npm install -g @openai/codex`（＝codex プロセス死）へ繋がる。これらの画面の応答は `CodexTool.waitForReady` の担当だが、waitForReady は `startSession` 中しか見張らず Auto-Yes ポーラーはセッションと無関係に 2s で回り続けるため、**先に見た方が勝つレース**になっていた（起動後にダイアログが再出現した実セッション 2 本が固着）。修正は 3 点。**(1) auto-answer 層のみで抑止** — `getCodexLifecycleDialog`（`detection/cli-patterns.ts`）が非 null の間、ポーラーは何も送らない。検出層は無変更で、`detectPrompt` はこれまで通り画面をプロンプトとして報告する（検出層で潰すと人間にも提示されなくなる）。抑止は `capture --json` の `autoYes.lastSuppression`（`reason: agent-launch-dialog`）に出る。**(2) 固着からの復帰** — `waitForReady` が hooks 画面2/3 を検出したら `Escape` を最大 4 回まで送って上位へ戻す（`t`＝trust は送らない）。**(3) 誤表示の解消** — 画面2/3 は選択肢も confirm フッタも thinking マーカーも持たず `running` 既定に落ちていたので、`STATUS_REASON.CODEX_HOOKS_REVIEW` として `waiting` を返し NavigationButtons を出す。fixture は codex-cli 0.148.0 の実キャプチャ（3 画面）へ更新した

- **fix(demo-video): worktree ID の path 由来化に追従し、収録パイプラインを復旧する** (#1809)
  - **`demo-video` スキルは #1621 / #1644（v0.20.0）以降、実収録が必ずタイムアウトしていた。**
    worktree ID が `<repo>-<branch>` から `sanitize(basename(path))`（`deriveWorktreeId`）に
    変わったのに、harness 側が旧規則の ID を定数で持っていたため。サーバが探す tmux セッション名は
    `mcbd-claude-wt-dark-mode` なのに harness は別名のセッションを作り、`isSessionRunning` が
    永久に false のまま全シーンが個別のタイムアウトで死んでいた（警告も出ない）
  - **ID を定数で持つのをやめ、`env-up.sh` が seed ディレクトリから導出して `state.env` に書く。**
    `CM_DEMO_PRIMARY_WORKTREE_ID` / `CM_DEMO_WORKTREE_ID` / `CM_DEMO_LOGIN_WORKTREE_ID` /
    `CM_DEMO_UNSYNCED_WORKTREE_ID` と、それぞれの `*_PATH`。`record-scenes.ts` の
    `DEFAULT_WORKTREE_ID` / `UNSYNCED_WORKTREE_ID` は**削除**し、引数・環境変数・`state.env` の
    いずれも与えなければブラウザを開く前に停止する（黙って旧値に落ちない）
  - **二重の安全策**: 録画開始前とシーンごとの `prepare` で `/api/worktrees` の `path` と
    `CM_DEMO_WORKTREE_PATH` を突き合わせ、同じディレクトリが別 ID で登録されていたら
    **その場で** ID と path の両方を出して落ちる。ID はパス単位で初回登録時に凍結されるため、
    待っても直らない条件をタイムアウトまで待たない
  - **後片付けは記録駆動にした**。`fake-agent.sh --record-to` が作成したセッション名を
    `$CM_DEMO_SESSIONS_FILE` に追記し、`env-down.sh` はその記録と `state.env` の ID から組んだ
    `mcbd-<tool>-<id>[-<suffix>]` だけを kill する。旧実装の `grep -- '-cmdemo-app-'` は
    新 ID の `mcbd-claude-wt-dark-mode` に一致せず、偽エージェントを取り残していた
  - **依存チェックに `claude` を追加**。`POST /api/worktrees/[id]/send` は
    `cliTool.isInstalled()`（実体は `which claude`）が false だと 503 を返すため、未導入だと
    依存チェックではなく録画の途中でテイクが死ぬ。欠けていれば導入方法を出して収録前に止まる
  - **テストは製品の規則を固定する形に置き換えた**。旧テストは stale な定数どうしを突き合わせて
    いたので #1621 を素通りしていた。`deriveWorktreeId` を import して seed ディレクトリ名から
    ID を導き、`env-scripts.test.ts` は `tmux` スタブを介して「kill する名前」を実測する
    （実 tmux は触らない）
  - 隔離環境（`HOME` 差し替え・ポート 3466・`$HOME/.commandmate-demo`）で
    `demo-video.sh --locale en` を通しで完走させ、尺検証ゲートの通過を確認済み


## [0.24.0] - 2026-08-16

> **Highlight**: エージェントの**入力待ちを見逃さないための経路を一通り揃えた**リリース。WS 即時配信・要対応バッジ・クロス画面 Toast に加え、タブタイトル / favicon / App Badge / 通知音でブラウザ外へ、さらに waiting エッジ駆動の push 通知でデバイス外へ伝わるようになった（方針 A / D / E）。あわせて稼働中の**モデルと reasoning effort** を hooks の構造化イベントと tmux capture の両経路から取得し、UI と CLI (`instances` / `capture --json`) に露出した。External Apps のプロキシは**末尾スラッシュとクエリ文字列を生バイトのまま**転送するようになり、Next.js static export のアプリが CommandMate 経由で開けなかった問題（`/proxy/<app>/try/` と `/assets/` が 404）が解消している。

### Fixed

- **fix(proxy): クエリ文字列を生バイトのまま上流へ転送する** (#1804)
  - **#1802 でクエリは転送されるようになったが、バイト完全一致ではなかった。**
    `?q=a%20b&n=1` は上流に `?q=a+b&n=1` として、`?bare` は `?bare=` として届いていた。
    `application/x-www-form-urlencoded` の意味論では `+` と `%20` は同じ空白にデコードされるため
    大半のアプリでは実害が無いが、**クエリのバイト列に対して署名を検証する上流**
    （HMAC 署名つき URL / presigned URL / OAuth 1.0a）では署名検証に失敗する
  - **原因は Next.js が route handler に渡す前に `request.url` を再構成していること。**
    `%20`→`+` と `?bare`→`?bare=` は `URLSearchParams` で再シリアライズした時の署名であり、
    App Router の route handler の内側からは触れない層で起きる
  - **修正は「Next.js を迂回する」のではなく「生 URL を一段手前で退避する」方式。**
    `server.ts` の `requestHandler` は Next.js に渡す前に生の `req.url`（Node の request target）を
    持っているので、これを `x-cm-raw-url` ヘッダへ退避し、
    `src/app/proxy/[...path]/route.ts` が読み戻す。ヘッダが無い場合（`next dev` 単体・unit test）は
    従来どおり `request.url` にフォールバックするため #1802 の挙動を維持する
  - **`/proxy/*` を `server.ts` で横取りする案（起票時の方針）は採用しなかった。**
    `/proxy/...` は現在 `src/middleware.ts` の認証と IP 制限を通っており、
    `AUTH_EXCLUDED_PATHS` は完全一致判定なので除外されていない。Next.js を迂回すると
    **External Apps から認証と IP 制限が丸ごと外れる**（Cloudflare Tunnel 配下では外部公開に直結）。
    `next.config.js` の `headers()`（CSP 等）も失われる。この性質を
    `tests/unit/proxy/proxy-auth-guard.test.ts` で固定した
  - **偽装防止**: `server.ts` は `x-cm-raw-url` を**無条件に `delete` してから**
    `/proxy/` の時だけ `set` する。クライアントが付けてきた値は経路を問わず必ず捨てられる。
    内部用ヘッダなので `filterHeaders()` で剥がしており**上流へは転送されない**
  - **`server.ts` 側は inline 4 行、import は 1 つも追加していない**（#1428 の再発防止）。
    top-level に内部モジュールの静的 import を足すと `tsx server.ts` 下で Next の
    AsyncLocalStorage bootstrap が壊れ、最初のリクエストでクラッシュする。
    この故障は unit / integration / build / lint をすべてすり抜け E2E だけで落ちる
  - **実機計測（隔離 DB・ポート 3805・エコー上流 3806、生 TCP でバイト単位送信）**:
    `?q=a%20b&n=1` / `?bare` / `?q=a%2Bb` / `?q=a%26b` / `?sig=aGVsbG8%3D` /
    `?q=%E6%97%A5%E6%9C%AC` / `?q=a+b` / `?empty=` / `?a=1&a=2` がすべてバイト一致で上流着。
    #1802 のパス保存（`/try/` と `/try` の区別・`a%2Fb`・`a%20b`・多バイト・素の `+`・深い階層）と
    HEAD / POST / PUT / PATCH / DELETE に回帰なし。認証有効時は未認証 `/proxy/...` が 307（/login）、
    不正 Bearer が 401、正規 Cookie が 200 でクエリもバイト一致
  - **既知の制限（実測により起票時の想定と乖離）**: `?` 単独（`/search/?`）は依然として落ちる。
    ただし原因は `new URL()` ではなく **Node の `fetch()`（undici）**である。
    生文字列を最初の `?` で分割する実装により `?` は `buildUpstreamUrl()` まで保持され、
    `new URL(...).href` も `?` を保つが、undici は request target を `pathname + search` で組み立て、
    present-but-empty なクエリでは `search` が `''` になるため送信時に落ちる
    （`fetch('http://127.0.0.1:3806/a/?')` の上流受信が `/a/` であることを実測）。
    解消には proxy の transport を `http.request` に置き換える必要があり、
    undici の gzip 透過処理（`content-encoding` 剥がし）も自前で作り直すことになるため、
    空クエリを表す区切り文字 1 バイトの代償としては割に合わないと判断した
- **fix(proxy): 上流転送で末尾スラッシュとクエリ文字列を保持する** (#1802)
  - **External Apps のプロキシがルート画面（`/proxy/<app>/`）だけ 200 で、配下（`/proxy/<app>/try/`,
    `/proxy/<app>/assets/`）が 404 になっていた。** Next.js static export のようにディレクトリ URL に
    末尾 `/` を要求する上流では、`/try/` と `/try` は**別の URL**であり、上流は後者を 404 にする
  - **原因は `src/app/proxy/[...path]/route.ts` の `'/proxy/' + pathSegments.join('/')`。**
    Next.js の catch-all params は「区切り文字を落とした percent-decode 済みの配列」なので、
    配列から join で URL を再構築する方式では**構造的に 3 つの情報が失われる**:
    ①末尾スラッシュ ②クエリ文字列（`buildUpstreamUrl()` の JSDoc は "including query string" と
    書いてあるのに呼び出し側が一度も search を渡していなかった）③percent-encode
    （`%20` が素の空白、`%2F` が区切りの `/` に化ける）
  - **修正は `new URL(request.url)` の `pathname` + `search` をそのまま連結して転送する形に変えた。**
    `pathSegments` は `pathPrefix` の検索用途（DB の `pathPrefix` は decode 済みの素の文字列）にのみ残した
  - **保存されるのはパスであり、クエリは route handler 到達前に Next.js が正規化する（実機計測）。**
    エコー上流を立てて実サーバ経由で計測した結果は以下のとおり:
    - パス: **バイト列がそのまま保存される** — `/try/` は `/try/`、`a%20b` / `a%2Fb` /
      `%E6%97%A5%E6%9C%AC` / 素の `+` すべて無変換で上流へ届く
    - クエリ: **バイト完全一致は達成できない** — `?q=a%20b&n=1` は `?q=a+b&n=1` に、
      `?bare` は `?bare=` になる（`URLSearchParams` で再シリアライズした時の署名）。
      `%2B` / `%26` / `%3D` / percent-encode 済みマルチバイト値は保存される。
      これは App Router の route handler からは触れない層での正規化であり、
      本 Issue のコード（`new URL()` も `fetch()` も無改変であることを node で切り分け済み）が
      原因ではなく、本 Issue の範囲では解消できない。既知の制限として、
      `?` 単独の空クエリも WHATWG URL の仕様上 `search` が空文字になるため落ちる（`/x?` → `/x`）
  - **ログには query string を載せない（Issue #395 の方針）。** クエリにトークンが載りうるため、
    転送用 path（`pathname + search`）とログ用 path（`pathname` のみ）を分離した。
    `/proxy/` 単体での 400、WebSocket フォールバックの 426 は挙動を変えていない
    （`next.config.js` の `skipTrailingSlashRedirect: true`（#671）と、
    `src/lib/ws-server.ts` が `request.url` を生のまま渡す upgrade 経路には手を入れていない）
- **fix(session): 並列開発で宙に浮いた 2 つの配線を繋いだ（`reasoningEffort` が永久に null／詳細ヘッダに指示待ち表現が無い）** (#1785, #1787, #1784)
  - **どちらも「実装されていなかった」のではなく「着地済みの実装同士が繋がれていなかった」。**
    Phase 2（#1784・保持層）と Phase 3（#1785・露出）、および #1787（waiting 視認性）が**同時並行で開発され、
    それぞれのテストは緑のまま**着地したため、境界の穴を CI が一度も検出できなかった。
    同じ穴を再発させないための記録として、原因を「片方の Issue のバグ」ではなく**並列開発の配線漏れ**として残す
  - **`commandmate capture <id> --json | jq '.reasoningEffort'` と `commandmate instances` の `EFFORT` 列が、
    effort を実際に検出できているセッションでも永久に `null` / 空欄だった。**
    #1785 が「#1784 未着地でも動くように」置いた `resolveReasoningEffort()` seam（`return null` 固定）を
    誰も差し替えなかったのが原因。#1785 のテストは #1784 の着地で赤にならないよう
    **値ではなくスキーマ（`null` 許容）で**書かれていたので、両 Issue のテストが緑のまま穴が残った
  - **修正は `getResolvedAgentModelInfo()` 1 回の呼び出しに集約した（`getLastKnownAgentEffort()` ではなく）。**
    effort 値そのものはどちらでも同じ（後者は前者の `.effort` を返す薄いラッパ）だが、
    `model` と `reasoningEffort` を**別々の reader から読むと不整合な payload を publish しうる** —
    `model` を hooks 専用 latch（`getLastKnownAgentModel`）から読んだままだと、
    最初の `SessionStart` hook が届く前にバナーを scrape 済みの claude セッションで
    **model が null なのに effort だけ載る行**（`buildModelByInstance` が "unreachable through the API" と
    明記している形）が `EFFORT` 列に出る。1 回の解決に統一することで、antigravity の
    「effort は model id 末尾から導出」規則も自動的に効く
  - **オーケストレーターの前提と実測が食い違った点（実測を正とした）**: ①同ファイル内の `model` は
    「既に保持層から解決されている」とされていたが、実際は `getLastKnownAgentModel`（hooks 専用 latch）で、
    `worktree-status-helper`（Web UI 側）が使う `getResolvedAgentModelInfo` と**別の答えを返していた**。
    上記のとおり両者を後者に統一した。これは #1783 が「サーバ再起動後の claude の穴は Phase 2 が埋める」と
    明記した設計の未完了部分でもある（値は厳密に上位互換 — hooks があれば同値、無いときだけ capture が穴を埋める）。
    ②`commandmate instances` の `EFFORT` 列は「保持層と無関係に空欄」ではなく、
    `instances` は `worktree-status-helper` ではなく **current-output エンドポイントを instance ごとに叩く**ので、
    同じ 1 箇所の修正で両 CLI 面が同時に直る（Web UI の pill ツールチップは #1784 時点で既に正しく出ていた）
  - **未稼働セッション（`running=no`）が `null` を返す規則は変えていない。** 保持層は意図的に期限切れしない
    （8 時間走るターンは最後まで同じモデル・同じ effort）ので、停止済み行が前プロセスの値を名乗らないよう
    落とすのは**サーバー側だけ**。effort も model と同じ扱いにした
  - **#1787 受入条件 4 が部分未達だった** — `awaitingInstruction`（エージェントが「ターンを終えた」と自己申告した状態）の
    セカンダリ表現は、サイドバー行（`BranchListItem`）と `WorktreeCard` には出ていたが、
    **worktree 詳細ヘッダ（`DesktopHeader`）に無かった**。同ファイルが #1787 の契約 scope 外だったため。
    ブランチ一覧では緑バッジが出ているのに、そのブランチを開くと消える状態だった
  - **サイドバーと同一の表現・同一トークン・同一 i18n キー**（`worktree.awaitingInstruction.badge` / `.label`）を
    再利用した（新しいデザインを発明しない／重複キーを作らない）。`success`（緑）系で、
    waiting の `warning`（amber）系とは**決して混同されない**ことが唯一の必須要件
  - **バッジは pill ごとではなく行に 1 つ**（worktree 単位）。サイドバー行が既にその粒度で出しており
    （`branch.awaitingInstruction` は `deriveWorktreeWaitingDetail` による全インスタンスの畳み込み）、
    かつこの行は `MAX_HEADER_AGENT_PILLS` で幅を配給しているため、pill ごとに文字列を足すと
    **稼働中のインスタンスが「+N」に押し出される**（#1783 が model をツールチップに留めたのと同じ理由）。
    「+N」トリガーの**後ろ**に置いて pill の幅予算を一切消費せず、既存の表示は 1 バイトも削っていない
  - **空振り緑の反証（変異注入で実測）**: ①`buildCurrentOutput` の `reasoningEffort` を `null` に戻す →
    新規 `current-output-effort-wiring-1784` の **9 件中 7 件が赤**（残り 2 件は `null` を期待する規則そのもの）。
    ②詳細ヘッダの `awaitingInstruction` 描画を外す → `WorktreeDetailSubComponents` の **4 件が赤**。
    変異は復元し `git status` で確認済み
### Changed

- **feat(push): 入力待ち通知を waiting エッジ駆動にし、種別の細分化とエスカレーションを追加した（入力待ち可視化 方針E）** (#1790)
  - **通知トリガーを #1786 の waiting エッジ（`onWaitingTransition`）に載せた**。`src/lib/push/waiting-push-notifier.ts` は
    #1788 の `waiting-broadcast.ts` と同じく**購読するだけ**で、検出器・pane capture・独自の「前回 waiting だったか」を持たない。
    これにより **poller 非稼働・同一ターン 2 個目のプロンプト・`MAX_POLLING_DURATION` 超過・
    selection list / pager / 構造化のみの待ち**が通知されるようになった
  - **poller 内の発火は残した（Issue 本文の推奨から逸脱。実測に基づく判断）**。
    本文は「エッジ経路へ一本化し poller 内は削除」を推奨していたが、**`observeWaitingEdge` の呼び出し元は
    `worktree-status-helper` 1 箇所＝ worktree 一覧 / 詳細 API の probe のみ**で、サーバ側の周期スキャンは存在しない
    （`grep -rn observeWaitingEdge src` で確認）。つまりエッジは**クライアントが画面を開いているときにしか観測されない**ため、
    一本化すると「アプリを閉じて離席している」＝スマホ通知が最も要る状況で無通知になる。
    よって両経路を残し、`response-checker` が prompt 検出時に `observeWaitingEdge(waiting:true)` で
    **同じ episode を開く**ことで二重送信を構造的に潰した（順序も意図的で、prompt の質問文を持っている
    poller 側を先に送り、後続のエッジ経路は dedup で黙る）
  - **dedup を episode 化した**。`shouldSendWaitingPush()`（key = worktreeId + instanceId + `waitingSince`）が
    「1 つの待ちにつき 1 通」を保証する。content hash 30 秒は**同一ターン 2 個目の同文プロンプトを落としつつ、
    長い待ちには同じ質問を再送し得る**という逆向きの誤りを両方持っていた。completion 経路は現行維持
  - **応答保存時に `observeWaitingEdge(waiting:false)` で episode を閉じる**。これが無いと poller が開いた待ちが
    ブラウザの probe が来るまで開きっぱなしになり、以降のプロンプトが全部その古い episode に畳まれて無音になる
  - **通知文を `waitingKind` で出し分ける**。`prompt`→「応答待ちです」／`menu`・`unclassified`→「端末の確認が必要です」／
    エスカレーション→「まだ応答待ちです（N分経過）」。両言語を `locales/{en,ja}/notifications.json` に追加した。
    payload の `waitingKind` は**待ちのときだけ付く**ので、#1125 の completion payload は 1 バイトも変わらない。
    `tag` も据え置き＝再通知は最初の通知を置換する（同じ待ちで通知カードが 2 枚積まれない）
  - **エスカレーション（再通知）を追加した**。既定 10 分・1 episode 1 回・`NotificationsSettings` で変更/オフ可能。
    **相乗りできる既存の周期処理が無かった**（`global-session-poller` は assistant chat 専用、`resource-cleanup` は別責務）ため
    60 秒 interval を新設したが、**待ちがある間だけ**張る（pending 0 で `clearInterval`、`unref()` 済み）。
    生存判定は自前の pending ではなく `getWaitingEpisode()` ＝ #1786 のストアが権威なので、
    別画面で答えられた待ちにも閉じるエッジを取りこぼした待ちにも再通知しない
  - **設定はインストール単位（`app_settings` v27 に相乗り、migration なし）**。#1788 の in-app トグルと違い
    localStorage を使えない — 判定するのは request も browser も無い background timer だから。
    読みは全経路 total（行なし／壊れた JSON／範囲外／DB 不通 → 既定値）で、正規化はフィールド独立
    （不正な threshold が `enabled` を巻き添えにしない）
  - **VAPID 未設定環境では待ちを記録すらしない**。`isPushConfigured()` が偽なら timer も DB 参照も発生しない
    （「静かなだけ」ではなく完全に不活性）。既存 prompt トグルはそのまま新経路に効く（`kind` は `'prompt'` のまま）。
    `awaitingInstruction` は仕様どおりスコープ外
  - **Issue 本文との食い違い（実測を正とした）は 1 点のみ**: 本文の「エッジ = poller 非依存」は正しいが、
    **クライアント非依存ではない**（`observeWaitingEdge` の呼び出し元は一覧 / 詳細 API の probe だけ）。
    これが「poller 内は削除」を採らなかった理由。**本文の file:line はすべて実測と一致**していた
    （`response-checker.ts:612`＝`kind:'prompt'` / `:723`＝`kind:'completion'` の 2 箇所のみ、
    `notification-dedup.ts:23`＝30 秒窓、`response-poller-core.ts:29`＝`MAX_POLLING_DURATION = 30 分`、
    `public/sw.js` の push / notificationclick、`NotificationEvent` の kind 2 種）
  - **Auto-Yes との競合に猶予は入れなかった**。本文は「数秒後にまだ waiting なら送る」を検討可としていたが、
    **現行でも poller は Auto-Yes の有無に関係なくプロンプト検出時点で通知している**
    （`tests/integration/auto-yes-policy-escalation.test.ts` の「escalation does not depend on the policy」が固定している）ため、
    通知量は本 Issue で増えない。一方で猶予を入れると**すべての正当なプロンプト通知が数秒遅れる**
  - **既存テストの期待値変更は 1 件**: `tests/unit/i18n/notifications-push-keys.test.ts` の
    「pre-i18n の日本語文言を byte-for-byte 保持」を `toEqual` → `toMatchObject` に緩めた。
    #1308 の 4 文言は引き続き byte 単位で固定しており、網羅性は同ファイル内の
    「`push` のキー集合＝`PUSH_KEYS` と完全一致」テスト（新キー 4 件を追加済み）が担保する
  - **空振り緑の反証（変異注入で実測）**:
    ① `startWaitingPushNotifier` の購読を no-op listener に潰す → 14 件が赤
    （`notifies on an edge nothing but the status probe observed` /
    `notifies for a wait no prompt detector could classify` /
    `notifies a second instance of the same worktree independently` /
    `notifies again once the wait ended and a new one began` /
    `renders prompt|menu|unclassified in both locales` /
    `re-notifies once, and only once, past the threshold` /
    `says "check the terminal" when that is what the wait needs` /
    `does not re-notify a wait that has been answered` /
    `does not re-notify when the closing edge was never seen but the wait is over` /
    `sends nothing when the reminder is switched off` / `honours a threshold the user shortened` /
    `is driven by an interval that exists only while something is waiting`）
    ② `shouldSendWaitingPush` を常時 true に潰す → 6 件が赤
    （`opens the episode the status probe would have opened` /
    `sends nothing extra when the status probe then reports the same wait` /
    `closes the episode on a reply, so the next prompt notifies again` /
    `does not double-send when the poller and the edge both report it` /
    `suppresses a repeat of the same episode however often it is reported` /
    `keys the guard on the episode, not on the content`）
    ③ エスカレーションの閾値判定を常に不成立にする → 4 件が赤
    （`re-notifies once, and only once, past the threshold` /
    `says "check the terminal" when that is what the wait needs` /
    `honours a threshold the user shortened` /
    `is driven by an interval that exists only while something is waiting`）
    変異は 3 件とも復元し、`grep -rn MUTATION src` が空・全ゲート緑に復帰することを確認した

### Added

- **feat(pwa): 入力待ちをタブタイトル・favicon・App Badge・通知音でブラウザ外に伝える（入力待ち可視化 方針D）** (#1789)
  - **件数は #1788 の `useAttentionCount` をそのまま使う（新設なし・二重実装なし）。** タブタイトル／favicon／App Badge／
    通知音の 4 面すべてが同じ値を読むので、サイドバーのバッジや `/review?filter=approval` の一覧と食い違いようがない。
    カウント規則（**waiting な worktree を 1 件と数える** = instance が 3 つ待機でも 1）も #1788 のまま変更していない
  - **タブタイトル**: N > 0 で `(N) <現行タイトル>`、0 で原状復帰。変換は **strip→prepend** なので冪等で、
    同じ effect が 2 回走っても `(1) (1) Foo` にならない。Next のページ遷移は title を上書きする（`<title>` 要素ごと
    差し替わることもある）ので順序に賭けず `document.head` の MutationObserver で観測して再適用する
  - **favicon**: canvas 合成を **data URL** で差し替え（SW の cache-first `/favicon.ico`・`/icons/` とも、
    ブラウザ固有の favicon キャッシュとも交差しない）。**`href` だけ差し替え、`sizes` / `type` は Next が出したまま**。
    0 件と unmount で原状復帰する。数字は潰さず描く判断とした（バッジ円がタイル辺の約 68% を占め、16px 縮小でも
    1 グリフは読める）。桁溢れは `9+` で、その状態のときだけ amber → red に変える
  - **App Badge**: `navigator.setAppBadge` / `clearAppBadge` を feature detect のうえ呼ぶ。**未対応・reject・throw を
    すべて黙殺し、ログも出さない**（未対応ブラウザで status 変化ごとに warning が出るコンソールは読まれなくなる）
  - **通知音（既定 OFF・オプトイン）**: #1788 の WS waiting エッジで 1 episode 1 回。音源は **Web Audio の合成 2 音**で
    **外部リソース一切なし**。autoplay 制約は初回ジェスチャ（`pointerdown`/`touchstart`/`keydown`）での
    `unlockWaitingSound()` で解錠し、**鳴らせなければ黙って諦める**（リトライループもトーストも console 出力もなし）。
    トーストと違って既定 OFF なのは、音は端末の外へ出る（会議中・共有オフィス）ため — 頼まれていない音はタブごと
    ミュートされる最短路で、それは #1788 のトーストまで道連れにする。バイブ（任意項目）は実装していない
  - **タブ非表示中の更新停止は許容仕様として明記**した（`useWorktreesCache` の visibilitychange による poll 停止。
    #1788 の WS が生きている間は push で追随するので、通常はタブが裏でも追いつく）
  - **Issue 本文の現状記述はコードで裏取り済み**（`document.title` の動的変更なし／`setAppBadge`・`new Audio`・
    `AudioContext`・`navigator.vibrate` のヒット 0／`public/sw.js:161` の `badge` は通知アイコンで本件と別物 —
    いずれも本文どおり）。**本文と実装の差は 1 点**: `<link rel="icon">` はソースに literal では存在せず、
    App Router の file convention（`src/app/icon.png` / `icon1.png` / `icon2.png`）から**複数**生成される。
    そのため「既存 link の href を替える」実装は**全件**に対して行い、1 件も無い文書では link を生成して復帰時に除去する
  - **空タイトルでの無限書き戻しを実装中に発見して塞いだ**: `document.title` の getter は空白を strip/collapse するため
    `"(2) "` を書くと `"(2)"` で読み戻る。差分検知が永久に「変わった」と言い続け、title 監視が回り続ける。
    プレフィクスは空タイトル時に末尾スペースを出さず、strip 正規表現も `(?:\s+|$)` で `"(2)"` 単体を剥がす
  - **空振り緑の反証（変異注入で実測）**: ①`formatTitleWithBadge` のプレフィクス付与を潰す → `attention-badge-1789` /
    `useAttentionBadge-1789` の 10 件が赤（`prefixes one, several, and more than nine` / `is idempotent: applying it
    twice cannot produce "(1) (1) Foo"` / `replaces a stale badge rather than stacking on it` / `emits no trailing space
    when there is no title to prefix` / `prefixes the count, and drops the prefix again at zero` / `replaces the prefix
    on a count change rather than stacking one` / `stays single-prefixed when the effect runs again for the same count` /
    `re-applies after a navigation rewrites the title` / `settles on a page with no title at all, instead of re-writing
    forever` / `restores the plain title on unmount`）。②`restoreFavicons` の復帰を潰す → 6 件が赤
    (`restores every original href` / `never records a data URL as the original, however many times it re-applies` /
    `creates a link when the document has none, and removes it again` / `restores the authored icon at zero` /
    `restores the authored icon on unmount` / `survives a count change without ever losing the authored href`)。
    ③音のトグル判定を常に true にする → 2 件が赤（`stays silent while the toggle is off (the default)` /
    `stays silent when the toggle is explicitly off`）。3 変異とも復元して全緑に復帰（`git status` で確認）
- **feat(cli): モデル / reasoning effort を `instances` と `capture --json` に露出した（モデル/effort 可視化 Phase 3）** (#1785)
  - `CurrentOutputResponse`（`current-output-builder`）に **`model` / `reasoningEffort`（ともに `string | null`）** を追加した。
    値は Phase 1（#1783）の保持層そのままで、**CLI 側でのモデル名の解釈・整形はしない** —
    `capture --json | jq '.model'` の値を `/status` や `agy models` の表示とそのまま突き合わせられるようにするため
  - `commandmate instances <id>` の表に **`MODEL` / `EFFORT` 列**、`--json` に `model` / `reasoningEffort` を追加した。
    列は**末尾に追加**なので、`INSTANCE_ID`〜`AUTO_YES` を列位置で読んでいるスクリプトはそのまま動く
  - **未稼働セッションは `null` / 空欄。** 保持層は意図的に期限切れしない（8時間走るターンは最後まで同じモデル）ので、
    そのまま返すと `RUNNING no` の行が前プロセスのモデルを名乗る。落とすのは**サーバー側だけ**で、
    CLI に同じ規則をもう 1 つ置かない（2 箇所に持つと食い違う）
  - **既存フィールドは追加のみで一切変えていない。** `capture --json` の `content` / `realtimeSnippet` /
    `sessionStatus` / `sessionStatusReason` は orchestrate-monitor 等の既存消費者が依存しており、
    テキスト出力（既定）も byte 単位で不変（回帰テストで固定）
  - **`reasoningEffort` は現状すべて `null`。** effort はどのエージェントの hooks payload にも無く、
    抽出は Phase 2（#1784）の担当。`resolveReasoningEffort()` という named seam を置いてあるので、
    #1784 着地時はこの関数の本体を差し替えるだけで済み、payload 形状・CLI・テスト期待値は動かない
    （テストは値ではなく **null 許容のスキーマ検証**で書いてある）
  - **空振り緑の反証（変異注入で実測）**: `buildCurrentOutput` の `model` 解決を `null` に潰すと
    `current-output-model-1785` の 3 件（`publishes the model the agent reported about itself` /
    `publishes it verbatim` / `publishes null for a stopped session even after a model was latched`）が赤になる。
    変異は復元して全緑に復帰
- **feat(detection): tmux capture から model / reasoning effort を抽出して補完する（モデル/effort 可視化 Phase 2）** (#1784)
  - **reasoning effort はどのツールの hooks payload にも存在しない**（`tests/fixtures/hooks/` 全件で確認）。
    唯一の情報源は TUI が自分で描く chrome なので、`src/lib/detection/model-info-extractor.ts` を新設して
    `extractModelInfo(cliToolId, captureText) → {model, effort}` で読む。Phase 1（#1783）が埋められなかった
    **サーバ再起動後の claude の model**（claude は `SessionStart` にしか model を載せない）も同じ経路で埋まる
  - **既存の detection パターンは 1 バイトも変更していない。** `CODEX_STATUS_BAR_PATTERN` は codex の
    running/idle 判定の境界（#1150）、`CLAUDE_MODEL_OVERLAY_FOOTER_PATTERN` は Auto-Yes が `/model` ピッカーを
    誤確定して**ユーザーのグローバル既定モデルを書き換える**のを防ぐガード（#1495）。前者はフッタ行の**特定にだけ**
    read-only で再利用し、値の読み出しは新規パターンで行う
  - **実測で確定させた形式**（2026-08-15、隔離 socket `tmux -L cm1784probe` ＋ 200x60 の捨てセッション。
    fixture は `tests/fixtures/model-info-captures.ts`）:
    codex 0.147.0 `gpt-5.6-sol xhigh · ~/…`（legacy `gpt-5.4 high · 21% left · ~/…` と effort 無しの
    `  o4-mini  50% left · /path` も同一パターンで解ける — 最初の `·` より前を切ってから読む形にしたため。
    位置で読むと legacy の `50%` が effort として出てしまう）／
    claude 2.1.232 `▝▜█████▛▘  Opus 5 (1M context) with xhigh effort · Claude Max`／
    agy 1.1.13 `? for shortcuts … Gemini 3.7 Flash · hig`
  - **Issue 本文と食い違った実測を 2 件、実測を正として実装した**:
    ①**agy のステータスバーは右寄せの最終 1 桁が欠ける**（`high` が `hig` として届く。200 桁でも 120 桁でも再現＝
    capture ではなく agy 1.1.13 のレンダラ側）。Issue 本文の `Gemini 3.5 Flash · medium` はそのままでは取れないので、
    1 文字欠けを**一意に復元できるときだけ**復元する（`hig`→`high` / `lo`→`low` / `mediu`→`medium`）。
    復元できない末尾トークンはその行ごと捨てる — さもないと effort 無しモデルの名前が 1 文字削れて出る。
    ②Issue 本文は `gpt-oss-120b-medium` を「サフィックス無し」に分類しつつ規則を `-low|-medium|-high$` と書いており
    自己矛盾している。書かれた規則どおり `medium` と読む（UI に出る model は hooks の id そのままなので実害なし）
  - **マージ規則**: model は **hooks > capture**（食い違えば hooks。agy は `Gemini 3.7 Flash` と表示するが
    id は `gemini-3.7-flash-high`）、effort は codex/claude が capture、antigravity は **modelName 末尾サフィックス導出 >
    capture**。保持は hooks 由来（`__agentEventLastModel`）と capture 由来（`__agentCapturedModelInfo`）を
    **別 Map** に持つ（同一 Map に混ぜると scrape した表示名が id を後書きで潰し、復元手段が無くなる）
  - `CliToolSessionStatus.reasoningEffort?` を追加し `sessionStatusByInstance` 経由で API へ。**未知のときはキー自体を
    出さない**（#1783 が model に決めた規約と同じ。`toEqual` で全体比較している既存スイートを壊さないため）。
    UI は #1783 のモデル表示に `· <effort>` を追記する形で、effort 不明なら表示は #1783 と 1 バイトも変わらない。
    DesktopHeader の status pill は幅配給の都合で**ツールチップのみ**（#1783 の制約を維持）
  - **この機能のための tmux capture は 1 回も増やしていない** — ステータス検出ポーラが既に取った capture テキストに
    相乗りする（`captureSessionOutput` の呼び出し回数をテストで固定）
  - **空振り緑の反証（変異注入で実測）**: ①`resolveEffortToken` が常に null を返すよう変異＝effort 抽出を無効化 →
    **41 テストが赤**（extractor 27・retention 9・join 5。UI スイートは緑のまま＝表示ロジックは抽出に依らないことの裏取り）。
    ②ステータス検出ポーラから `recordCapturedModelInfo(...extractModelInfo(...))` の呼び出しを外す → **join の 6 テストが赤**
    （`「antigravity は modelName 導出」だけは緑のまま`＝capture 非依存の経路であることの裏取り）。
    2 変異とも復元し `git status` で確認、全緑に復帰
- **feat(realtime): 入力待ちを WS 配信・要対応バッジ・クロス画面 Toast で即時に知らせる (#1788)**
  - **WS 配信は #1786 の `onWaitingTransition` を購読するだけ**（`src/lib/realtime/waiting-broadcast.ts`）。
    検出器を新設していないので、hooks 由来（構造化イベントだけが見えるダイアログ）でもスクレイパー由来でも
    同じように飛び、response poller には依存しない。**発火はエッジのみ**（21 回の poll で 1 フレーム）
  - **`SessionStatusEvent` は追加のみ**（`isWaitingForResponse?` / `waitingKind?` / `waitingSince?`）。
    ただし **`isRunning` は optional 化**した。`observeWaitingEdge` はセッションが消えた probe でも
    `waiting:false` で呼ばれるため waiting フレームはセッション存在を答えられず、`true` を送れば
    kill 済みセッションが sidebar で蘇り `false` を送れば生存中を殺す。既存 2 消費者
    （`useTerminalPanePolling` / `useSplitMessages`）は `isRunning !== false` で守られているので不在は安全
  - **Issue 本文の `broadcastToWorktree` は実在しない**（実測）。ws-server の room ブロードキャストは
    `broadcast` / 内部 `handleBroadcast`。後者を `setupWebSocket` から注入し、`closeWebSocket` で解除する
    （import 循環回避＋テストで実サーバ不要）。room は認証済み subscribe でしか入れないので認可は迂回しない
  - **バッジ件数は `src/hooks/useAttentionCount.ts` の単一セレクタ**（`selectAttentionCount` /
    `selectAttentionWorktrees` / `useAttentionCount`）。**方針D (#1789) のタブタイトル・favicon・App Badge は
    ここを import すること。** カウント規則は「**waiting な worktree を 1 件**（instance が 3 つ待機でも 1）」＝
    この数字は `/review?filter=approval` へのリンクで、その一覧の述語と同一だから
  - PC はサイドバーヘッダのピル、モバイルは `GlobalMobileNav` の Review タブのバブル（0 件で非表示、
    99 超は `99+`、件数>0 のときタップ先が approval フィルタ）。Home の Waiting 統計もリンク化し、
    同じセレクタで数えるようにした（**旧ローカル集計は `isSessionRunning` も要求しており approval 一覧より
    1 件少なく出得た**ので意図的な挙動変更）
  - **クロス画面 Toast**（`WaitingToastListener`、AppProviders に単一マウント）: 表示中の worktree では出さない／
    `waitingSince` を dedup キーに 1 episode 1 回／トグルで無効化可。Toast 本文は実 `<button>` にした
    （hover 依存の表現はタッチ端末で恒久的に不可視になるため）
  - **アプリ内通知トグルは push カードの外・上に置いた**。`NotificationsSettings` の本体は Push API 非対応 /
    iOS 未インストール / VAPID 未設定で早期 return する — **アプリ内 Toast が唯一の通知になるのは
    まさにその環境**なので、その内側に置くと最も必要な場所で設定が消える
  - **ポーリングは廃止していない**（間隔も不変）。WS 未接続クライアントが従来どおり poll で waiting を知る
    回帰テストつき
  - **空振り緑の反証（変異注入で実測・全て復元済み）**: ①エッジ購読を無効化 → `waiting-broadcast-1788` が
    **7 件赤**（`broadcasts the extended frame when a wait begins` ほか）②episode dedup を無効化 →
    `fires once per episode however many frames repeat it` が赤（`expected [...] to have a length of 1 but got 3`）
    ③兄弟 instance の再計算を無効化 → `keeps the worktree waiting while a SIBLING instance still is` が赤

- **feat(verification): 実行契約が Issue 固有のゲート定義を運べるようにした（#1756 案 B）** (#1791)
  - 契約に **`verify.gateDefinitions`（`[{id, command, timeoutSec}]`）** を追加した。`verify.gates` の意味は変えていない
    （宣言済みゲートからの**選択**）。`gates` 省略時は「verify.yaml の全ゲート ＋ この契約の定義全部」
  - **`.commandmate/verify.yaml` は読むだけで 1 バイトも書かない。** orchestrator が Issue 固有ゲートを渡すのに
    verify.yaml を書き換えるしかなかったのが問題だった — verify.yaml は work-evidence の変更集合に**残る**ので
    （除外は `.commandmate/tasks/` だけ）、**追記を置いただけの worktree が「作業済み」に見えて `exit 21` が意味を失う**。
    契約は既に `tasks.contract_json` へ snapshot 済みで変更集合からも除外済みなので、新しい改竄面を作らずに済む。
    work-evidence / scope の除外規則（`CONTRACT_DIR_PREFIX`）は変更していない
  - **形と検証は verify.yaml の `gates[]` と同一実装。** verify-config の gate エントリ検証を
    `validateGateEntries` として切り出して両方から呼ぶので、id パターン・予約 id 禁止・重複禁止・
    timeout の整数と範囲が「同じ制約」であることがコメントではなく事実になる
  - **送信時に fail-closed で拒否（exit 2）**: 予約 id（`work-evidence`/`scope`/`env-clean`）との衝突、
    **verify.yaml の既存 gate id との衝突**、`gates` がどこにも無い id を名指し、verify.yaml が無いのに定義がある。
    id 衝突を黙って上書きにしないのは、リポジトリ自身が宣言した合格の定義を委任単位で差し替えられ、
    しかもレポート上は同じ id なので**差し替えたことが読み取れない**ため（override が要るなら別 Issue で明示構文を設計する）
  - **裁定の出所を記録する（migration v56: `verification_gate_results.source`）**: `builtin` / `verify.yaml` / `contract`。
    `verify --json` / `verify show`（`src=<source>`）/ `verify history --json` から読め、
    `verify` と `wait --verify` の GATE 行は `contract` のときだけ末尾に ` [contract]` を付ける。
    **どの裁定がリポジトリの合格定義でどれが Issue 固有かが report から読めないと、この分離は
    「静かな 2 つ目の verify.yaml」になる。** v56 以前の行は `null` で backfill しない（履歴は書き換えない）
  - 実行順は **verify.yaml の宣言順 → 契約の宣言順**。マージ元は**このランが結び付いた task の契約だけ**で、
    未接続の契約（`findDetachedContract`）からは読まない。id が verify.yaml と衝突する契約が届いた場合は
    マージせず run を `error` にする（送信時に弾いているので旧ビルド由来のみ）
  - **`gates` を書いたのに定義したゲートを選ばないのは契約エラー**にした（Issue 本文にない追加規則）。
    契約が唯一の宣言元なので、選ばれなければ永久に走らない＝「チェックを足したつもりで足していない」契約になる
  - **空振り緑の反証（変異注入で実測）**: ①契約ゲートをマージから外す → 失敗するはずの Issue ゲートを持つ run が
    **`passed` を返し**（実測 `PROBE run.status=passed repro=absent`）6 テストが赤 ②verify.yaml との id 衝突検証を外す →
    **送信が 201 で通り**（`expected 201 to be 400`）2 テストが赤 ③予約 id 検証を外す → 10 テストが赤
    （契約側 6・verify.yaml 側 4＝共有バリデータが両方を守っていることの裏取り）。3 変異とも復元して全緑に復帰

- **feat(session): 入力待ちの構造化合成と `waitingKind`/`waitingSince`/`awaitingInstruction` を一覧 API に露出（入力待ち可視化 方針A・基盤）** (#1786)
  - **一覧 API（`/api/worktrees`・`/api/worktrees/[id]`）が構造化イベントを見るようになった。** これまで per-instance の状態は `detectSessionStatus()`（スクレイパー）だけで決めており、hooks が正確に知っている待ち（#1725 の `prompt_waiting`）は**サイドバー / Home / Sessions / Review / CommandPalette のどのドットにも出ていなかった**。`checkCliToolStatus` で `peekPromptWaiting()` を通し `isWaitingForResponse` を OR で広げる
  - **副作用の無い read-only 変種（`peekPromptWaiting`）を新設して一覧側はそれを使う。** `resolvePromptWaiting` は corroborate/clear の副作用を持つが、一覧側は (a) `STATUS_DETECTION_CAPTURE_LINES` の狭い窓で検出するため「プロンプトは無い」の証拠が解除規則の想定より弱い、(b) 同じ記録を `blocksSend` が読むので read エンドポイントの誤解除が **send ガードを黙って解除する**（#1708 の穴の再来）、(c) 開いているタブの数で状態機械の結果が変わる、の 3 点から書き手にしない。corroborate を張る側（`buildCurrentOutput` / send ガード）は無変更で、`blocksSend` の意味・挙動も変えていない
  - **`isWaitingForResponse = resolution.waiting`（Issue 本文の指定）は採らず OR にした。** コードで裏取りした食い違い: `resolution.waiting` は `hasActivePrompt || 構造化` だが、一覧のフラグは `sessionStatusToActivityFlags(status)`＝`status === 'waiting'` で**厳密に広い**（selection list と codex pager は `hasActivePrompt: false` の `waiting`）。そのまま代入すると**サイドバーの選択リストがオレンジから緑に落ちる**回帰になり、本 Issue の非機能要件（ドットを悪化させない）に反する。OR は広げるだけで狭めない
  - `CliToolSessionStatus` に `waitingKind`（`'prompt'｜'menu'｜'unclassified'｜null`）/ `waitingSince`（epoch ms）/ `awaitingInstruction` を追加し、`sessionStatusByCli` / `sessionStatusByInstance` 経由で露出。per-CLI 集約は kind=優先度（prompt>menu>unclassified）・since=最小値（最長の待ち）・awaiting=OR。クライアント型（`types/models.ts`）は `SessionWaitingDetail` として同期し**全フィールド optional**（既存 fixture・古いサーバの応答がそのまま型検査を通る）。**UI は変更していない**（方針 B/C の担当）
  - `deriveWaitingKind()` を純関数（`session/waiting-kind.ts`）として切り出した。`menu` の判定式は `current-output-builder` の `isSelectionListActive` と同一で、`SELECTION_LIST_REASONS` の membership を二重に持たない
  - **待ちエッジの観測点を 1 箇所に閉じた（`session/waiting-episode-state.ts`）。** `observeWaitingEdge()` が false→true / true→false を検出し、`onWaitingTransition()` が**#1788（WS 配信）と #1790（push 発火）の差し込み口**になる（ポーリング回数ではなく交差 1 回につき 1 発火。購読解除関数を返す）。`since` はエピソード中不変で、構造化 episode の `at` を優先する（エージェントは描画と同時に post、scraper は 5 秒キャッシュ越しなので必ず遅れる）。listener の例外は握り潰す（一覧 API の hot path で通知 sink の故障がステータス読みを落としてはならない）。#1736 の規約どおり `globalThis` 保持で、module-identity テストにケースを追加した
  - **`notification(idle_prompt)` を第 3 の状態にした。** `agent-event-state` に `awaiting_instruction` を併設し、`user_prompt_submit` / `session_start` / `session_end` / 世代交代まで保持する。**`SessionStatus` の 4 値は変更していない** — `idle_prompt` は `ready` のままで、`ready`＝「送信できる」の意味を全消費者に再判断させないため boolean を足す形にした。`stop` では立てない（中間ターンの終了は指示待ちではない）。**この状態にだけ齢の上限を掛けていない**（解除が composer 入力＝`UserPromptSubmit` とセッション終了という取りこぼしようのないイベントで、6 時間 idle のエージェントは実際にまだ指示待ちだから）
  - 追加の tmux capture は発行しない（構造化状態は in-memory 参照。エッジ記録は try/catch の外で 1 回だけ呼び、未起動・capture 失敗も「待っていない」として開いていたエピソードを閉じる）
  - **空振り緑の反証**: 構造化合成（`|| peek.waiting`）を無効化する変異を注入し、**4 テストが赤**になることを実測（`waits when the scraper says \`ready\` and the agent reported an open dialog` ほか）。変異は戻して `git status` で確認済み
- **feat(hooks): エージェントの実モデル名を構造化イベントから取得し UI に表示する（モデル/effort 可視化 Phase 1/3）** (#1783)
  - **モデル名は最初から payload に載っていて、正規化層で捨てられていた。** `NormalizedAgentEvent` に `model: string | null` を追加し、worktree 詳細画面の分割ペインタイトル・ヘッダの status pill・ロスター（PC / モバイル）に表示する。**effort の取得（#1784）と CLI 露出（#1785）は本 Issue のスコープ外**
  - **抽出は `define-source.ts` の `buildNormalizedEvent` に一元化し、ツール差は spec の宣言に閉じた。** フラットキー用の `modelFields?: readonly string[]`（claude / codex = `model`、antigravity = `modelName`）と、フラットでは届かない形のための `extractModel?: (payload) => string | null`（opencode）の**併用**。片方だけにしなかった理由は、`conversationIdFields` が既に同じ 2 段構え（宣言 ＋ 逃がし弁）で、model だけ別の作法にすると「どちらを見ればいいか」がツールごとに変わるから。両方あるときは関数が勝つ
  - **Issue 本文の記述と食い違った点（実測を正とした）: opencode の model キーは 1 つではなく 2 つある。** 本文は `model.modelID` だけを挙げていたが、捕捉済み fixture では `message.updated` が `properties.info.model.modelID`、**`session.created` / `session.deleted` は `properties.info.model.id`**。`modelID` だけを読む実装は `session_start` — 購読を張った直後に必ず来る唯一のフレーム — で model を取り逃す。両方読む（`modelID` → `id` の順）。`providerID` は連結しない（他ツールは素のモデル名を返すので、opencode だけ `github-copilot/claude-sonnet-4.6` になる）
  - **`lastAgentEvent` はレコードごと置換されるので、model 専用の Map を別に持った。** claude は `SessionStart` にしか model を載せない（fixture 13 件中 1 件）ため、最新イベントから読むと最初のプロンプト送信で表示が消える。`getLastKnownAgentModel()` は**最後に観測した非 null 値を latch し、null のイベントは既知の値を消さない**。`/clear`（`session_end` → `session_start`）では保持し、破棄するのは世代交代（`beginAgentEventGeneration` ＝別プロセス）と `discardAgentEventState` のときだけ
  - **齢による失効（`STRUCTURED_STATE_MAX_AGE_MS`）は付けていない。** あの 30 分は「`Stop` を取りこぼした status が `running` に貼り付く」を防ぐためのもので、model はそういう種類の主張ではない（8 時間走るターンも最初と最後で同じモデル）。失効させると一番役に立つ長時間セッションで表示が消える
  - **モデル未報告時は `sessionStatusByInstance` にキー自体を出さない。** `model: null` を常設すると `worktree-status-helper-status-mapping.test.ts` の `toEqual` 比較が落ちるうえ、不在が言うこと以上を言わない。UI 側も**null のときは何も描画しない** — gemini / copilot は payload に model を持たず、hooks 未設定のセッションも同様なので、「不明」バッジは全行に出る恒久的なノイズになる
  - **DesktopHeader はツールチップのみにした（表示面の判断）。** あの行は `MAX_HEADER_AGENT_PILLS` で幅を配給していて余剰は「+N」に畳まれるため、pill ごとに 2 本目の文字列を足すと**稼働中のインスタンスがモデル名のために overflow に押し出される**。model は既存の hover / `aria-label` に載せ、見えている pill のテキストは 1 バイトも変えていない。分割ペインのタイトルバー（最優先の表示面）とロスター行は実テキストで表示する
  - 保持は in-memory のみで **DB（`session_states`）には永続化しない**。サーバ再起動後、codex / antigravity は次イベントで復活し、claude は次の `SessionStart` まで不明になる。この穴は Phase 2（#1784）の capture フォールバックが埋める設計
  - **gemini / copilot は対象外（model: null のまま）。** copilot は payload に model キーが無く、gemini の `BeforeModel`（唯一 model を持つ payload）は `GEMINI_HOOK_EVENT_NAMES` に無く unknown-event として捨てられる。語彙追加が要るので別 Issue
  - `CLAUDE_MODEL_OVERLAY_FOOTER_PATTERN`（#1495 の `/model` ピッカー誤確定ガード）には触れていない
  - **空振り緑の反証**: 6 変異を注入して赤になることを実測（ベースラインは 4 ファイル 63 テスト緑）。①`buildNormalizedEvent` の model 抽出を `null` 固定 → **20 赤** ②`recordAgentEvent` の latch を外す → **12 赤** ③`worktree-status-helper` で model を載せない → **2 赤** ④`TerminalSplitPane` の null ガードを外す → **3 赤**（「何も描画しない」側の 3 ケースだけが落ちる） ⑤opencode の `model.id` フォールバックを削る → **2 赤**（`session.created` / `session.deleted`。Issue 本文どおり `modelID` だけを読む実装が落ちる） ⑥DesktopHeader の tooltip を model 抜きに戻す → **2 赤**。すべて戻して 63/63 緑・`git status` で復元を確認

## [0.23.0] - 2026-08-14

> **Highlight**: Epic #1720 Phase 4 を完了し、**機械判断の一次ソースを TUI スクレイピングから CLI 自身が申告する構造化イベントへ移す作業を全 6 ツール**（claude / codex / copilot / gemini / antigravity / opencode）**に広げた**。#1759 で `AgentEventSource` 抽象を切り出して「1 ファイル ＋ レジストリ 1 行でツールが 1 つ増える」形にし、#1760〜#1763 / #1779 で 5 ツール分を実装している。**スクレイパは 2 層目のフォールバックとして残るため、構造化イベントが無い環境の挙動は変わらない。**あわせて、この作業中に CI を **5 時間 31 分 57 秒**沈黙させた `/proc` への recursive mkdir 無限ループ（Linux 限定・同期スピンのため `try/catch` にも `testTimeout` にも到達せず OOM も残らない）を、製品コード側の 5 経路でも塞いだ（#1774）。

### Added

- **feat(hooks): antigravity に承認裁定経路を張り、受け口の fail-closed な早期 return を塞いだ（Phase 4-4 残作業）** (#1779)
  - agy の `PreToolUse` を登録し、**専用の裁定コマンド**（stdout が裁定）を `/api/hooks/permission-request` に向けた。codex の `PermissionRequest` / copilot の `PreToolUse` と同じ形で、**中継スクリプト `scripts/hooks/cmate-agent-event.sh` は 1 バイトも変更していない**（`curl … >/dev/null` で応答ボディを捨てるため裁定に使えない）。他 5 ツールの配送挙動は無変更
  - **受け口の潜在欠陥を塞いだ。** `permission-request/route.ts` は `getAgentEventSource()` を呼ぶ**前**にハードコードした `{}` を返す経路を 2 つ持っていた（worktree 未解決 / catch-all）。他ツールでは `{}`＝「意見なし」だが **agy では `{}`＝拒否**なので、`PreToolUse` を張った瞬間に「worktree が消えた」「想定外の例外」で agy のツール呼び出しが黙って拒否される。両経路を `source.encodeVerdict({kind:'abstain'})` 経由にし、**他ツールの出力が `{}` のままであること**をテストで固定した
  - **`badRequest()` の 4xx は 4xx のままにした（実測に基づく判断）。** 裁定コマンドは `curl -f` を使うので 4xx はボディごと捨てられ、コマンド自身の fallback に落ちる。400 が裁定として agy に届くことはないので、検証エラーを正直に返す現状のままでよい
  - **失敗経路の既定出力は `{"decision":"ask"}` にした。Issue 本文の指定（`{"decision":"allow"}`）から意図的に変えている。** agy の `decision` は `allow`/`deny`/`ask`/`force_ask` の 4 値で、**`ask` が「通常の承認フローへ」＝abstain そのもの**。設定ファイルは `~/.gemini/config/hooks.json` の**マシン 1 本**なので、`allow` フォールバックは「CommandMate を止めるとマシン上の**全** agy セッションが全ツール呼び出しを無承認で実行する」を意味する（CommandMate が起動していないセッションを含む＝失敗経路 5 がまさにそれ）。`ask` なら「CommandMate が入っていない機械と同じ挙動」になり、Issue の狙い（agy を壊さない）を穴を開けずに満たす。**Issue 本文の手動受入条件「Auto-Yes 無効時は従来どおりダイアログが出ること」も `allow` では満たせない**
  - **サーバ不達 / タイムアウト / 非 2xx / JSON でない or `decision` の無いボディ / `CM_PERMISSION_HOOK_URL` 未設定** の 5 経路すべてで `{"decision":"ask"}` を stdout に出す。`curl -m 4` を handler の `timeout: 5` の内側に置き、**agy に殺されて部分出力になる経路自体を作らない**
  - `parsePermissionRequest` を実装した（`toolCall.name` / `toolCall.args`）。`()=>null` のままだと `unknown-payload` で常に abstain＝**「動いている Auto-Yes に承認するものが無い」と見分けがつかない**
  - `noDecision` を `{kind:'blocks'}` → **`{kind:'proceeds'}`** に変えた。**`encodeVerdict` と対で読むこと** — 安全なのは abstain を `ask` と綴っているからで、`{}` に戻すと宣言だけが嘘になる。`blocks` のままだと Auto-Yes 無効時の全ツール呼び出しで `permission-request-abstain-blocks-agent` が warn され、起きていないことを報告し続ける
  - `capabilities.supportedEvents` に **`pre_tool_use` は足していない**（Issue 本文の実装範囲 4 からの逸脱）。**copilot と同じ理由** — 登録先は permission receiver なので `pre_tool_use` の `NormalizedAgentEvent` は 1 件も生成されず、載せると「待っても来ない語」を約束することになる（`copilot/source.ts` が同じ判断を明記している）
  - **実測で覆した Issue 本文 / #1762 の前提 2 点**（いずれも agy **1.1.12**・隔離 HOME・専用 tmux socket `cmate-i1779`・対話 TUI）
    - **stdout が空（exit 0・無出力）は `{}` とは別物で fail-open。** 通常の承認ダイアログが出る。「中継のまま `PreToolUse` を張るとマシン上の全ツール呼び出しが止まる」は成立しない（止まるのは `{}` を返したときで、`{}` は `⚠ Tool call denied by pre-tool hook:` を出す＝#1757 P10 を再現）。中継を使わない判断自体は変わらない（裁定を返せないため）
    - **`{"decision":"allow"}` は対話 TUI の承認ダイアログを抑止しない。** `permissionOverrides:["command(*)"]` を添えても、リダイレクトの無い `ls -a` でも同じ。`--print`（headless）では効く（#1757 §5.4.4）。**したがって対話セッションの Auto-Yes は従来どおり TUI 応答経路（#988）が担う** — 本 Issue が追加したのは「abstain が安全になったこと」と「裁定を表現できるようになったこと」であって、ダイアログの消滅ではない。裁定は agy の文書どおりの綴りで正直に出している
  - **実機検証**: 生成した `hooks.json` をそのまま隔離 HOME に置き、実 agy 1.1.12 で ①**CommandMate 停止状態（ポート未 listen）→ 通常ダイアログ → `1. Yes` でコマンドが実際に実行された**（最重要条件）／②受け口スタブが `{"decision":"ask"}` → 通常ダイアログ、**リクエストは `?tool=antigravity&worktreeId=…&instanceId=…` 付きで到達**し payload は `toolCall.name`/`toolCall.args` ／③スタブが 500 → 通常ダイアログ。**ユーザーの実 `~/.gemini/` は 3507 ファイルの sha256 マニフェストが前後一致**（検証は複製 HOME で実施）。`kill-server` は使っていない
  - **空振り緑の反証**: ①失敗経路の既定出力を「無出力」に変える ②受け口の早期 return を `{}` のハードコードに戻す ③`encodeVerdict` の abstain を `{}` に変える、の 3 変異を注入して赤になることを実測した（順に **9・2・11** テストが赤。すべて戻して 155/155 緑に復帰）
  - **`AgentEventSource` I/F（`types.ts`）は 1 行も変更していない。** `NoDecisionBehavior` に「裁定しない＝拒否される」を表す値が無い件は、本 Issue では**表現する必要がなくなった**（abstain を `ask` と綴るので `proceeds` が実態と一致する）。ただし**表現できない状態が消えたわけではない** — `encodeVerdict` が `{}` を返す実装に戻れば `noDecision` は再び嘘になり、型はそれを防げない。申し送りとして残す
  - **既存テストの期待値を変えた 4 箇所とその理由**（いずれも本 Issue が挙動を変えた点そのもの）: `noDecision` を `blocks`→`proceeds` ／ `isAbstainSafe` を `false`→`true`（gemini との対比を「逆」→「理由の違う一致」に書き換え） ／ abstain の encode を `{decision:'allow'}`→`{decision:'ask'}` ／ `buildAntigravityHookConfig` の `PreToolUse` を「未登録であること」→「**中継宛でないこと**」（主張の芯＝中継は裁定を返せない、は不変）。`cli-tools/antigravity.test.ts` の起動コマンド正規表現は `CM_PERMISSION_HOOK_URL` を含むよう更新（`expect` 行ではない）

- **feat(hooks): copilot に構造化イベントと承認裁定を横展開した（Phase 4-3）** (#1761)
  - `src/lib/hooks/sources/copilot/` を追加し、`registry.ts` に 1 行登録した。copilot セッションの `sessionStatus` / `wait` の完了判定 / Auto-Yes が、TUI スクレイピングではなく copilot 自身の hooks から決まるようになる（スクレイパは #1723 の 2 層目として残る）
  - **Issue 本文冒頭の「hooks が実在するか未確認。実在しなければ取り下げ」は事実と逆だった。** #1757 のスパイクが実在を確定させており、payload は 4 ツール中もっとも Claude Code に近い。取り下げていない
  - **設定の書き先は `~/.copilot/settings.json`。** `copilot help config` は `config.json` に書けると言うが、copilot は起動時に `hooks` を settings.json へ移送し config.json を機械管理形式で書き戻すため、**config.json に書くと次回起動で消える**（#1757 P2）
  - **ユーザー設定は置換せずマージする。** マーカー `cmate-copilot-agent-hooks` を含む自分のエントリだけを差し替え、他のキーと他のハンドラ（grouped 形 / flat 形の両方）はそのまま保持する。パースできない設定ファイルには**触らず**、素の `gh copilot` で起動する（イベントを失うのは回復できるが、手編集された設定の上書きは回復できない）
  - **相関キーは起動コマンドの環境変数に載せた。** copilot に `--settings` 相当は無く設定は**マシン全体で 1 本**なので、Claude のように URL へ焼き込むと 2 番目のインスタンスが 1 番目の名前でイベントを送ることになる。`CM_AGENT_WORKTREE_ID` / `CM_AGENT_INSTANCE_ID` を起動コマンドのプレフィックスとして与え、hook が発火時に読む
  - **グローバル設定なので、CommandMate が起動していない copilot では無効になるようにした。** 全コマンドが `CM_AGENT_WORKTREE_ID` 未設定で無音終了する。これが無いとオペレータが自分の端末で起動した copilot の `Stop` が cwd 解決で当たり、**誰のエージェントも終わっていないのに `commandmate wait` が返る**
  - **裁定は `hookSpecificOutput.permissionDecision`**（Claude の `decision.behavior` ではない）。copilot は `deny` ＋理由文字列も解釈するため Claude 実装より広いが、`permission-decision-service` は deny を出さないので能力の記述にとどまる。`{}` は fail-safe（通常の承認フローに落ちる）
  - **`decisionTimeoutSeconds` は 10**（Claude は 600）。Claude の感覚で組むと裁定が届かない。コマンド側は `curl -m 4` で 10 秒の内側から打ち切る（エージェントの timeout に判定を任せると「遅れて届いた裁定が黙って捨てられる」ケースと区別できない）
  - `supportedEvents` は 5 語。**`notification` は #1757 で発火実績ゼロ**、**`pre_tool_use` は承認ゲートそのもので permission receiver 宛**＝イベントストアに入らないため、どちらも約束しない（mapper は綴りを知っているので手設定の hook からは読める）
  - **本 Issue で新たに実測した 3 点**（`docs/design/copilot-agent-hooks-injection.md`）: hook コマンドは**シェル経由**で実行される／copilot プロセスの**環境変数が hook に継承される**／`PreToolUse` の **stdout が裁定として解釈され、`permissionDecision:"allow"` は `--allow-all-tools` 無しでもプロンプトを出さずに実行する**（#1757 は deny と `{}` のみ実測で allow は未計測だった）
  - **実機検証（copilot 1.0.79、受け口はスタブ。本番 port 3000 には送っていない）**: 相関 env ありで 6 イベント全件が `worktreeId` / `instanceId` 正で到達し裁定 `allow` が効いた／相関 env なしで**受信 0 件**／`CM_AGENT_INSTANCE_ID` 未設定は primary に落ちる／**受け口停止でもセッションは正常完了（fail-open）**／`~/.copilot/` は前後で **sha256 一致**。裁定の往復は **≈110ms**（予算 ≈10s に対して約 90 倍の余裕）、受け口停止時は 133ms で `{}`
  - **空振り緑の反証**: ①レジストリから copilot を外す ②イベント名の写像を 1 つ壊す（`Stop`→`session_start`）③設定の書き先を `config.json` に変える ④`beginAgentSession()` の呼び出しを消す、の 4 変異を注入して赤になることを実測した（順に 8・4・4・4 テストが赤。すべて戻して 82/82 緑に復帰）
  - `AgentEventSource` I/F は 1 行も変更していない。`if (tool === 'copilot')` 型の抜け道も追加していない
- **feat(hooks): opencode に server API / SSE 経由の構造化イベントと承認裁定を横展開した（Phase 4-5）** (#1763)
  - opencode セッションの機械判断（`sessionStatus` / `wait` の完了判定 / プロンプト待ち / Auto-Yes）を、TUI スクレイピングから **opencode server の構造化イベント**に移した。scraper は 2 層目のフォールバックとして残り、**構造化イベントが無い環境の挙動は 1 バイトも変わらない**
  - **Issue 本文の実装範囲 1・2 は実測で覆っている。** 本文は「`opencode serve` を別プロセスで立て tmux 内で `opencode attach <url>` する」「serve プロセスのライフサイクル管理（起動・ポート割当・停止・孤児回収）」を求めていたが、#1758 §5.1.2 が **素の `opencode` TUI 自身が同じ HTTP サーバを内蔵している**ことを実測している（`opencode --port <N>` で起動した TUI に対し `/global/health` / `/event` / `GET /permission` / `POST /session/:id/permissions/:permissionID` がすべて serve と同一に応答）。**したがって起動経路の変更は `'opencode'` → `'opencode --port <N> --hostname 127.0.0.1'` だけ**であり、`killSession`（`/exit` 送出）・初期化待ちループ・`reconcileExistingSession` は無変更、**serve プロセスのライフサイクル管理と孤児回収は実装していない**（サーバの寿命 = TUI プロセスの寿命なので、そもそも孤児になりえない）。Issue の「既知の罠」1 番目（`/exit` が TUI だけ閉じて serve が残る）も起きない
  - 新設 `src/lib/hooks/sources/opencode/`: 述語つき写像（`mappers.ts`）／**完了の冪等化**（`turn-gate.ts`）／SSE・REST クライアント（`client.ts`）／ポート割当と永続化（`ports.ts`）／`globalThis` 経由の購読レジストリ（`subscription.ts`）／payload パーサ（`payloads.ts`）／状態反映（`ingest.ts`）／起動側の 3 点接続（`runtime.ts`）。**`AgentEventSource` I/F は 1 行も変えていない** — #1759 の `definePullEventSource` がそのまま使え、`if (tool === 'opencode')` の類は 1 箇所も足していない
  - **`noDecision: { kind: 'blocks' }`（実測）。** #1758 §5.5.3 は承認要求を **10 分 19 秒**放置しても pending のままであることを計測しており、**タイムアウトは存在しない**。「応答しなければ TUI 承認に落ちる」というフォールバックは無く、TUI ダイアログと REST は**先に答えた方が勝つレース**である。したがって「判断できないときは黙る」は opencode でだけ安全側に倒れない ので、**裁定を見送ったときは `permission-request-abstain-blocks-agent` を必ず warn する**（黙って落ちるとセッションが静かに止まり、考え込んでいる agent と区別がつかない）
  - **`session.idle` を `wait` の完了判定に使えるようにしたが、数えてはいない。** 承認待ちの 10 分間に当該セッションの idle は 1 件も出ない（§5.3.1）ので `Stop` と同義だが、**error / abort 経路では 1 ターンで 2 回発火し**（19ms 差）、payload は `sessionID` のみでターン識別子が無い（§5.3.2 / §5.3.3）。**`session.status(busy)` を観測してから武装 → 最初の `session.idle` だけ完了 → 以降は破棄**する状態機械を置いた。`session.status(idle)` は `session.idle` と同一ミリ秒の同じ signal なので**写像しない**
  - **実機検証で新たに判明: `message.updated`（`role: user`）も 1 ターンに複数回、しかも `session.idle` の**後**に再送される**（1.18.3 実測、2026-08-13）。2 通は byte 単位で同一（`time` は `created` のみ）で payload では区別できない。`user_prompt_submit` には専用イベントが無くこのフレームが唯一の供給源なので、素直に 1:1 で写すと**完了したターンの最新イベントが `user_prompt_submit` になり `status-mapping` が `running` と読む** → `commandmate wait` が 30 分の staleness bound まで返らない。同じ状態機械で **message id 単位に初回だけ通す**ようにした（再接続では武装状態は捨てるが**announce 済み id は保持する** — 新しいプロンプトは必ず新しい id なので保持しても取りこぼさず、再接続がターン終端と末尾再送のあいだに入る窓を塞げる）。**#1758 のスパイクでも Issue 本文でも指摘されていなかった欠陥で、実機ドライブでのみ発見した**
  - **ポートは CommandMate 側で明示割当する（4200-4299）。** `--port 0` は「OS に空きを訊く」ではなく「まず 4096、埋まっていたら ephemeral」であり（§5.9.1）、実ポートを知る手段は stdout 1 行か `lsof` しかない（ポートファイルは書かれない、§5.9.2）。割当は `~/.commandmate/opencode-ports.json`（`CM_OPENCODE_PORT_FILE` で差替可）に記録し、**CommandMate 再起動後の購読復帰は推測ではなく記録 ＋ `/global/health` ＋ worktree パス照合**で行う（ハッシュ再導出だけだと、衝突した 2 インスタンスが互いのサーバに繋がって別 worktree のイベントを取り違える）
  - **購読状態はすべて `globalThis` 経由**（#1736 の前例: dev モードでバンドルが分かれ、書いた側と読む側が別マップになって無言で壊れた）。未知の `type` では throw せず数えるだけにした — `server.heartbeat` は 10 秒ごとに届くのに**サーバ自身の OpenAPI Event union に載っていない**（§5.2.1 / D5）
  - **縮退は全経路 fail-open。** ポート枯渇・サーバ不達（`--port` を知らない旧版 opencode）・SSE 断・CommandMate 再起動のいずれでも scraper に落ちて動き続ける。`CM_AGENT_HOOKS_INJECT=0` で起動が #1763 前の素の `opencode` に戻る
  - 承認応答は **`POST /permission/:requestID/reply`（`{reply, message?}`）に固定**した。per-session 版の `POST /session/:id/permissions/:permissionID` はボディのキーが `response` で**拒否理由を渡せない**が、こちらは渡した文字列がそのまま tool part の `state.error` に出る（§5.5.2）。`question.asked` は選択肢が構造化されて届くので `recordAskUserQuestion()` に流している（Claude では scraper に残さざるを得なかった `AskUserQuestion` 相当）
  - **実機検証（opencode 1.18.3 / 隔離 HOME / 専用 tmux socket `cmate-p45-oc`）**: 素の TUI に `--port` を付けて起動 → `/global/health` 応答・`lsof` で TUI プロセス自身が listen することを確認／`bash` の外部ディレクトリ書き込みで `permission.asked` → `listPending` が **callID 相関でツール名 `bash` を解決** → `POST /permission/:id/reply {"reply":"once"}` → **ダイアログが消えてコマンドが実際に実行された**（marker ファイルが生成された）／1 ターンにつき `stop` はちょうど 1 件、かつ**最後のイベントが `stop`**（上記の末尾再送修正後）／**CommandMate 再起動相当**（in-memory 状態ゼロの別プロセス）から `opencode-port-recovered` で購読が復帰／**TUI を kill すると liveness が `lost`（`fetch failed`）・`probeActivity` が null になり scraper 判定に落ちる**／**2 インスタンス（ポート 4296 / 4295）でイベントの取り違えゼロ**（別 sessionID・各 1 ターン）／**`--port` 無しで起動した TUI は listener を持たない**ため health check で弾かれ従来どおり scraper のみで動く。**ユーザーの `~/.config/opencode/opencode.jsonc` と `~/.local/share/opencode/` は sha256 一致・ディレクトリ構成 diff 空・mtime も検証開始より前のまま**（auth.json は mode 600 で複製したのみ）。ユーザーの `mcbd-*` tmux セッションは全て健在（`kill-server` 不使用）
  - **空振り緑の反証**: ①レジストリから opencode 登録を外す ②`session.idle` → `stop` の写像を壊す ③**`noDecision` を `proceeds` に変える** ④idle の冪等化を外す ⑤`beginAgentSession()` の呼び出しを消す ⑥`user_prompt_submit` の再送抑止を外す、の 6 変異を注入して赤になることを実測した（順に 7・9・2・2・1・1 テストが赤。全変異を戻して 202 テスト全緑に復帰することも確認）
  - **fix(test): develop 時点のテスト 2 箇所が `opencode` を「未登録ツールの例」に使っていたので直した。** `pull-source-contract.test.ts` の `finally` と `hooks-permission-request-source-1759.test.ts` の `afterEach` が `unregisterAgentEventSource('opencode')` を呼んでおり、**本 Issue が登録した本物のソースを削除するのに assert は通る**（＝緑のままレジストリが汚れる）。CI は `fileParallelism: false` で全ファイルが 1 プロセスを共有するため、削除は以降の全ファイルに波及する（ローカルの並列実行では不可視）。前者は unregister ではなく**元のソースを復元**するようにし、後者の stub は恒久的にスコープ外の **`vibe-local`** へ移した。期待値（`expect` 行）の意味は変えていない

- **feat(hooks): codex に構造化イベントと承認裁定を横展開した（Phase 4-2）** (#1760)
  - #1759 の `AgentEventSource` に codex 実装（`src/lib/hooks/sources/codex/`）を足し、レジストリに 1 行登録した。**I/F の変更も codex 固有の抜け道（`if (tool === 'codex')` 等）も無い。** `wait` / `capture --prompts` / Auto-Yes への反映は消費層がツール非依存なので自動的に付いてくる
  - **設定は `$CODEX_HOME/hooks.json` 1 本、内容は静的。相関キーは起動コマンド行の環境変数で渡す。** codex には `--settings` 相当が無く 1 ファイルが全セッション共有になるため、`worktreeId` / `instanceId` をファイルに焼き込めない。本 Issue で **hook の `command` が POSIX シェルで実行され、hook プロセスが codex を起動したシェルの環境を継承すること**を実測したので、`CM_AGENT_WORKTREE_ID` / `CM_AGENT_INSTANCE_ID` / 受け口 URL / `CODEX_HOME` を起動行に置く方式にした。**同一 worktree の `codex` と `codex-2` が実機で正しく振り分けられることを確認済み**（`cwd` は両者同一なので他に手段が無い）
  - **`CODEX_HOME` を起動行で pin する。** tmux セッションは tmux **サーバ**の環境を継ぐため、`CODEX_HOME` を設定して起動したサーバが書いた hooks.json を、起動された codex が読まない（`~/.codex` を見る）という無言の食い違いが起きる。実測して修正した（症状はエラー無しの「イベント 0 件」）
  - **登録は 5 イベント。** `SessionStart` / `UserPromptSubmit` / `Stop` / `SessionEnd` ＋ `PermissionRequest`。**`Notification` は codex に存在しない**（レビュー画面が列挙する 11 イベントに無い）。`Pre/PostToolUse` は消費側が無く 1 ツール呼び出しにつき 2 POST になるだけなので登録せず、`capabilities.supportedEvents` からも外した（待つ側が永久に待たないように）。`SessionEnd` の timeout は **3 秒**（codex がクランプし TUI に警告を常時表示するため）
  - **`PermissionRequest` だけインライン `curl`。** 応答ボディがそのまま裁定になるため、ボディを捨てる中継スクリプトは使えない。`{}` → 通常の承認ダイアログ（fail-safe）、`decision.behavior=allow` → ダイアログ無しで実行、**受け口停止中も fail-open**（セッションは止まらない）を実機で確認した
  - **trust は CommandMate が与えない。** codex の hooks は人間が trust するまで**完全に無言で skip**され、trust は**ユーザーの `~/.codex/config.toml`** に書かれる。既定で `--dangerously-bypass-hook-trust` を使わないのは、このフラグが**作業対象リポジトリ内の `.codex/hooks.json` まで無審査で実行させる**ため（悪意あるリポジトリを開いた瞬間に任意コマンドが走る）。既定は「設定は書く・trust は人間が codex 自身のレビュー画面で 1 回与える」。自動化向けに `CM_CODEX_HOOK_TRUST=bypass` を opt-in で用意した。**作業前後で `~/.codex/config.toml` は sha256 一致（`notify` を含め非汚染）**
  - **起動時の「Hooks need review」ダイアログを `cli-tools/codex.ts` が処理する（`3`＝trust せず継続）。** `getCodexActiveDialog` はこの画面を `null` に分類し `isCodexPromptReady` も false を返すため、放置すると 30 回ポーリングし切ってダイアログのまま `sendMessage` に渡る（実測）。**hooks.json を置くだけで codex の起動が壊れる**ということなので、注入とセットで入れた
  - **ユーザーの既存 hooks 設定は置換せずマージする。** `$CODEX_HOME/hooks.json` はユーザー自身の codex hooks が置ける唯一の場所でもある。`# commandmate:agent-hooks` マーカーで自分のハンドラだけを置換し、内容が一致するときはファイルを開かず（trust を無駄にしない）、JSON として読めないファイルは上書きせず注入を諦める
  - 世代フェンス（#1723 / S8）を `CodexTool.startSession` の生成パスに追加した。無いと前プロセスの `user_prompt_submit` を新セッションのものと読んで**起動直後に `running` を publish する**（単体テストは緑のまま壊れる型）
  - **空振り緑の反証**: ①レジストリから codex 登録を外す ②`Stop` の写像を壊す ③`noDecision` を実測値と違う値にする ④`beginAgentSession()` を消す、の 4 変異を注入して赤になることを実測し、戻して緑に復帰することも確認した
  - **`CM_AGENT_HOOKS_INJECT=0` で注入をスキップし、起動コマンドが #1760 以前と 1 バイト同一になる**ことをテストで固定した
  - test: `tests/setup.ts` に `CODEX_HOME` の既定を temp dir に pin した。pin が無いと codex セッションを起動するテストが**開発者の実 `~/.codex/hooks.json` を書き換える**（実際に起きたので追加した）
  - test: #1759 が「未登録ツールの例」として使っていた `'codex'` を `'vibe-local'` に差し替えた（`agent-event-source.test.ts` / `agent-session-lifecycle-1759.test.ts`）。特に register→`finally` unregister するケースは、**本物の codex source を消しながら assert は通る**＝緑のまま registry が壊れる（CI は `fileParallelism: false` で全ファイルが 1 プロセスを共有するため以降の全ファイルに波及する）
  - 設計と実測は [`docs/design/codex-agent-event-source.md`](./docs/design/codex-agent-event-source.md)

- **docs/test: codex / copilot / gemini / antigravity の hooks 実機挙動を検証し、実 payload を fixture として収集** (#1757)
  - Epic #1720 Phase 4 の全下流 Issue（#1759 / #1760 / #1761 / #1762）が前提にする外部 CLI 4 種の hooks 挙動を実機で確定した。**`src/` の変更はゼロ**（スパイク）。成果物は [`docs/design/agent-hooks-phase4-live-verification.md`](./docs/design/agent-hooks-phase4-live-verification.md) と `tests/fixtures/hooks/{codex,copilot,gemini,antigravity}/*.json`（24 payload）
  - **Issue 本文の「copilot に hooks は無いかもしれない（無ければ #1761 は取り下げ）」という前提は誤りだった。** `copilot --help` に hook の語が無いのは事実だが、`copilot help config` が `hooks` / `disableAllHooks` を、`copilot plugin --help` が「Plugins extend Copilot CLI with additional skills, agents, **hooks**, …」を明記しており、実際に 6 イベントが発火した。payload は 4 ツール中もっとも Claude Code に近い。**4 ツールすべてに hooks が実在したため、横展開 Issue の取り下げ提案は 1 件も無い**
  - **最重要の安全性所見: antigravity (`agy`) だけ no-decision が fail-CLOSED。** Claude / codex / copilot は hook が空応答を返すと通常の承認フローに戻る（fail-safe）が、agy は `decision` を欠いた `{}` を返すと `run_command` / `list_dir` / `search_web` すべてを拒否する（hooks を外した対照実験で裏取り済み）。一方 **timeout（ハンドラ無応答）は fail-open** なので、**「無応答」と「空応答」で挙動が真逆**になる。Auto-Yes v2 が「判断できないときは黙る」実装だと agy ではエージェントが全停止する
  - **`type:"http"` は 4 ツールすべてで使えない**（Claude だけの機能）。codex は `hooks.json` に http を 1 つ書いただけで `unknown variant 'http', expected one of 'command', 'prompt', 'agent'` となり **hooks.json 全体が捨てられ全イベントが死ぬ**。警告は stderr 1 行のみで TUI には出ない
  - **codex の未 trust hooks は `codex exec` で完全に無言で skip される**（stderr / stdout / ログいずれにも出力なし）。trust はユーザーの `~/.codex/config.toml` に `[hooks.state."<path>:<event>:0:0"] trusted_hash` として書き込まれるため、**ユーザー設定を汚さずに hooks を有効化する経路は `--dangerously-bypass-hook-trust` か `CODEX_HOME` 差し替えしかない**
  - ライフサイクルの意味論が Claude と揃っていない: **codex の `SessionStart` は最初のターン送信時**に出る（TUI 起動 08:05:15 → SessionStart 08:06:23）。**copilot は `UserPromptSubmit` が `SessionStart` より先**。codex は強制終了時に `SessionEnd` を出さない。**`session_start` を起動完了 signal にしてはいけない**
  - timeout はいずれも fail-open だが既定値が 2 桁違う: codex 600s / **copilot ≈10s**（実測）/ agy 30s。裁定を返す受け口は copilot に合わせて 10 秒以内に応答する必要がある
  - `AGENT_EVENT_TYPES` の 7 語が 4 ツールすべてで揃うわけではない。**共通なのは `session_start` / `pre_tool_use` / `post_tool_use` / `stop` の 4 語だけ**。`notification` は codex / agy に存在せず、`session_end` / `user_prompt_submit` は agy に存在しない。gemini は語彙自体が別（`BeforeTool` / `BeforeAgent` / `PreCompress` ほか）でツール名もリマップされる（`Bash → run_shell_command`）
  - **agy の payload にはイベント名も cwd も無い**（`hook_event_name` 相当のフィールドが存在せず、`workspacePaths` は空配列）。イベント種別と worktree ID は中継コマンドの引数に焼き込む以外に手段が無い。キーも 1 ツールだけ camelCase（protojson）
  - **`scripts/hooks/cmate-agent-event.sh` は 4 ツールのどれにも使えなかった**ためスパイクはダンプサーバ直で回避した。`--event` の allowlist が 5 語しかなく（`pre_tool_use` / `post_tool_use` で `die`）、`map_event_name` は `PreToolUse` / `PostToolUse` も gemini/agy の語も知らない。**修正は #1759 の担当**なので本 Issue では触っていない
  - **ユーザーのグローバル CLI 設定は 1 バイトも変更していない**: `~/.codex/config.toml`（`notify` の Computer Use 行を含む）/ `~/.gemini/settings.json` / `~/.copilot/{config,settings}.json` / `~/.gemini/antigravity-cli/settings.json` はいずれも検証前後で diff 空・sha256 一致。ツールごとに `CODEX_HOME` / `COPILOT_HOME` / `GEMINI_CLI_HOME` / `HOME` 差し替えで隔離し、tmux は専用 socket `-L cmate-p4spike` のみを使用（`kill-server` 不使用、ユーザーの `mcbd-*` セッション 11 本は全て健在）
  - **報告**: 設定は無変更だが、**3 ツールが検証中に自身の auto-update で版を上げた**（gemini 0.42.0→0.55.1、copilot 1.0.77→1.0.79、agy 1.1.7→1.1.12。agy は `AGY_CLI_DISABLE_AUTO_UPDATE=1` を付けていても更新された）。外部 CLI の版は実質固定できないため、下流はパーサを「未知フィールドは無視」で組むこと
  - **未計測（理由つき）**: gemini の項目 6（timeout）/ 7（承認裁定）と `BeforeTool` / `AfterTool` / `AfterAgent` / `AfterModel` / `Notification` の payload。この環境の Google アカウントが `IneligibleTierError`（*This client is no longer supported for Gemini Code Assist for individuals*）でモデル呼び出しに到達できず、ツール実行を伴うターンを 1 度も成立させられなかったため。**「確認できなかった」であって「実在しない」ではない**（hooks 機構自体は実在し `SessionStart` ほか 5 イベントを実採取済み）。#1762 が gemini 分を進めるには有効な `GEMINI_API_KEY` が要る
- **docs/test: opencode の server API / SSE による構造化イベントと承認裁定を実機検証した（Phase 4-0b スパイク、コード変更なし）** (#1758)
  - `docs/design/opencode-server-live-verification.md` と `tests/fixtures/hooks/opencode/*.json`（19 件）を追加。opencode **1.18.3** を隔離 HOME・専用 tmux socket（`cmate-p4spike-oc`）で動かし、`GET /event` の SSE 471 フレームと `GET /doc`（OpenAPI 3.1.0 / Event union 89 種）を一次証拠として検証項目 1〜10 を実測した
  - **項目 1 は Go。ただし Issue が前提にしていた `opencode serve` + `opencode attach` 構成は採らない** — **素の `opencode` TUI 自身が同じ HTTP サーバを内蔵している**ことを実測した。`opencode --port 4791` で起動した TUI に対して `/global/health` / `/event` / `GET /permission` / `POST /session/:id/permissions/:permissionID` のすべてが serve と同一に応答し、REST 承認でダイアログが消えてコマンドが実行された。これにより #1763 の起動経路変更は `src/lib/cli-tools/opencode.ts:136` の `'opencode'` → `'opencode --port <N>'` だけで足り、`killSession`（`/exit` 送出）・初期化待ちループ・`reconcileExistingSession` は変更不要。Issue の「既知の罠」1 番目は問題にならない。同時に「serve が居なければ scraper に落ちる」という縮退設計も意味が変わる（サーバは TUI と同一プロセスなので中間状態が存在しない。縮退が必要なのは `--port` 無しで起動された既存セッションに対してのみ）
  - **項目 3（`session.idle` の意味）は `wait` の完了判定に使ってよい。** 承認待ち **10 分 19 秒**・質問待ち 40 秒のあいだ、当該セッションに `session.idle` は 1 件も出ず `session.status` も `busy` のままだった（`GET /session/status` も `busy`）。つまり Claude の `Stop` と同義の「ターンが終わった」であり「セッションが暇」ではない。ただし **error / abort 経路では 1 ターンで 2 回発火**し（`MessageAbortedError` → idle → 19ms 後に idle を実測）、payload は `sessionID` **のみ**でターン識別子が無いため、`wait` は「busy を観測してから武装 → 最初の idle で完了 → 以降を無視」＋ `session.error` の併読が必須
  - **項目 5（no-decision）は hooks と挙動が逆。** 「応答しなければ通常の TUI 承認へ落ちる」というフォールバック段階は**存在しない** — TUI ダイアログは `permission.asked` と同時に無条件で描かれ、REST と TUI は最初から並行しており先に答えた方が勝つレースである。そして**タイムアウトが無い**（10 分 19 秒放置して自動裁定・タイムアウトイベントとも 0 件）。したがって **Auto-Yes は fail-open しない**: Claude は「黙る＝安全（fail-open）」だったが opencode は「黙る＝エージェントが無限停止」で、逆に誤って allow を返すと人間が読む前にダイアログが消える。#1763 は裁定を見送ったことを利用者に見せる必要がある
  - **項目 6 / 9**: 1 サーバに複数 session を載せられる（2 session 同時 busy を実測）が、**`GET /session` は「このサーバの session」ではなく同一 HOME / project の全 session を返す**（別ポートの serve が作った session まで見えた＝ `opencode.db` 共有）ため instance 一覧として使ってはいけない。推奨は **1 インスタンス = 1 TUI プロセス = 1 ポート**（当該ポートの `session.created` が一意に自分のものになる）。`POST /session` → `-s <sessionID>` による事前バインドも実測で成立。**`--port 0` は「OS に空きを訊く」ではなく「まず 4096、埋まっていたら ephemeral」**（1 本目 4096 / 2 本目 58153 を実測）で、実ポートを知る手段は stdout 1 行か `lsof` だけ（ポートファイルは書かれない）→ CommandMate 側で明示割当するのが唯一の安全策
  - **項目 10: plugin は採用しない。** ローカル JS plugin は動作し `init` / `event` / `tool.execute.before` / `tool.execute.after` が発火したが、`event` の語彙は SSE と完全に同一で情報が増えず、**承認を裁定する plugin フックが存在しない**（`"permission.ask"` という文字列自体が 1.18.3 のバイナリに無く、hook 面は `event` / `tool.execute.*` / `command.execute.before` のみ）。Phase 4-5 の中核が plugin では実装できない
  - **Issue 本文・`--help` と実測の食い違いを 6 件記録**（うち D1「serve/attach 不要」と D2「no-decision フォールバック不在」は設計の形を変える）。加えて **`server.heartbeat`（10 秒周期・死活監視の signal）がサーバ自身の OpenAPI Event union に載っていない**、**`/api/event` は 1 ターンの先頭 3 件で無言に沈黙する**（独立に 2 回再現）、**`GET /api/session/:id/event?after=<seq>` は 1 バイトも返さない**（durable replay による再接続は使えない）ため、購読は legacy `/event` 一本に決めた
  - **`question.asked` が質問文・ヘッダ・選択肢を構造化して配り、`POST /question/:id/reply` で答えられる**ことを実測した。Claude では scraper に残さざるを得なかった `AskUserQuestion`（#1708 / #1726）が opencode では完全に構造化イベントで扱える
  - **最重要成果物として §9 に Phase 4-1（#1759）への要求事項**を、実測から導いた 8 つの制約（到着方向・裁定経路・fail 方向・7 語への非 1:1 写像・相関キー・接続健全性・再同期・未知 type）と具体的な型シグネチャ案（`AgentEventTransport` / `NoDecisionBehavior` / `Verdict` / `decide()` / `listPending()` / `liveness()`）として記載した。`AgentEventSource` が push 型（hooks）だけでなく pull 型（SSE 購読 + REST 応答）も表現できる形でなければならないという制約の根拠がここにある
  - **非汚染の証拠**: `~/.config/opencode/opencode.jsonc` の before/after diff は空（sha256 `4e901f9e…` 不変）、`~/.local/share/opencode/` の構成 diff も空、`opencode.db`（58MB）と `auth.json` の mtime は検証開始前のまま。`tmux -L cmate-p4spike-oc` 専用 socket のみ使用し `kill-server` は未使用（ユーザーの `mcbd-*` 10 本は健在）、本番サーバ（port 3000）へは 1 リクエストも送っていない、立てた serve は PID 指定で個別 kill（広域 `pkill` 未使用）。**`src/` の変更は 0 件**
- **slash-commands: カタログを claude docs へリコンサイルし、未反映の 3 コマンドを追加** (#1767)
  - `/agents` `/import` `/list-agents`（いずれも claude のみ）。`code.claude.com/docs/en/commands.md` の実行（2026-08-13）で 3 件とも実在する行であることを確認済み。カタログ総数 159 → 162、claude 可視数 97 → 100（codex 53 / opencode 10 / antigravity 13 は変化なし）
  - **`/agents` と `/import` は claude 専用の説明キーを持つ**（Issue #1704 の tool-scoped key）。`/agents` は opencode の「利用可能なエージェントを一覧・管理」、`/import` は codex の「Claude Code から設定…を取り込み」という**別の意味の説明を共有していた**ため、そのままでは claude のパレットに他ツール向けの誤った説明が出る。`slashCommands.descriptions.{agents,import}` を tool 別オブジェクトへ分割し、既存ツールの文面は 1 文字も変えずにそれぞれのキーへ移した
  - `/schedule`（#1488 のキュレーション判断）・`/ultraplan`（#1503 の幻コマンド）・`/pr-comments` `/vim`（上流で削除済み）・`/cost` `/stats`（`/usage` のエイリアス）は**従来どおり追加していない**

### Changed

- **feat(ui): 入力待ちの画面内視認性を強化した（入力待ち可視化 方針B）** (#1787)
  - **`waiting` が `running` より目立たない逆転を解消した。** `waiting` は opacity 1→0.45 だけの
    `animate-status-blink` で、放置してよい `running` の `animate-status-glow`（box-shadow 拡張 + リング）
    より弱かった。amber の `animate-status-attention`（1.4s・box-shadow 12px/4px＝glow の 2.4s・8px/2px より
    速く広い）を `globals.css` の `@theme` に追加して既定にし、**`animate-status-blink` は
    StatusDot の waiting 以外に利用箇所が無かったため削除した**（死んだ CSS を残さない。
    `motion-foundation.test.ts` に「復活していないこと」のガードを追加）
  - **reduced-motion 時も `waiting` が識別できる。** 従来は無地 amber ドットに退化していた。
    `running` と同じパターンで**モーション非依存の amber リング**（強調時 `ring-4 ring-warning/50` /
    中強調 `ring-2 ring-warning/40`）を持たせ、アニメが凍結されても `ready` と同形にならない
  - **`waitingKind`（#1786）で強調を出し分ける。** `'prompt'`（アプリから答えられる）＝最強調、
    `'menu'`/`'unclassified'`（端末操作が必要）＝中強調（`animate-status-glow` + `ring-2`）。
    **フィールドが無い/null なら一律で最強調にフォールバックする** — #1786 以前のサーバ応答は
    kind を持たず、「人間が要る」状態の安全側は過小強調ではなく過剰強調だから
  - **サイドバーを二段ソートにした。** `sortBranches()` に「waiting 先頭固定」の前段を足した
    （`SidebarContext` の `SortKey` 型・`DEFAULT_SORT_KEY` は不変）。判定 `isWaitingBranch()` は
    行が描く 1 つのドットと同じ**集約ステータス**を見るので、alias インスタンスだけが待っている
    ブランチも浮上する。前段は **direction 乗算より前に return** するため `asc` でも下へ沈まない。
    `sortKey === 'status'` のときは前段を掛けない（`STATUS_PRIORITY` が既に waiting 優先で、
    降順＝「idle を先に」が表現不能になるため）。grouped 表示はリポジトリ束を保ったまま各群内で適用
  - **`nextAction` を i18n 化した。** `getNextAction()` は英語リテラルではなく `worktree` 名前空間の
    辞書キー（`nextAction.start`/`sendMessage`/`approveReject`/`replyToPrompt`/`checkStalled`/`running`）を
    返す。**旧サーバが送る英語リテラルは `isNextActionKey()` で弾いてそのまま描画する** — next-intl は
    未知キーをキーパス文字列として描画するので、素通しすると `worktree.Approve / Reject` が画面に出る。
    SessionStatus の exhaustive check は維持
  - **次アクションはサイドバー行に「インライン」表示する**（`waiting` と `awaitingInstruction` のときのみ）。
    hover 限定の表現はタッチ端末で永久に不可視になるため、hover に頼らない。それ以外のステータスは
    ツールチップ（`Next: …`）にのみ出す — 全行に「Running...」を出すのは、目立たせたい 2 行を
    かえって埋もれさせるノイズになる
  - **`awaitingInstruction`（#1786 の `idle_prompt`）は緑バッジ**（`awaitingInstruction.badge`）で
    サイドバー行と `WorktreeCard` に出す。amber と混同されないことが要件なので、`success` トークン系で
    固定した。**worktree 詳細ヘッダ（`WorktreeDetailSubComponents.tsx`）は実行契約の `scope.allow` 外
    だったため未実装**（waiting ドットの強調は `StatusDot` 経由で自動的に効いている）
  - `RecentSessionsList` の生 `bg-warning` 静的ドットを `StatusDot` に統一した（`deriveCliStatus` 経由なので
    「起動中だが処理していない」は従来どおり静的な緑 `ready` のまま）。`Terminal.tsx` の
    `bg-yellow-500` をトークン `bg-warning` へ置換（同ファイルの他 3 色は常時ダーク島として現状維持）
  - **空振り緑の反証（変異注入で実測）**: ①`sortBranches` の waiting 前段を外す → 二段ソートの
    5 テストが赤 ②`waiting` の `animate-status-attention` を旧 `animate-status-blink` に戻す →
    StatusDot / BranchStatusIndicator / BranchListItem / RecentSessionsList / DesktopHeader の
    9 テストが赤。両変異とも復元して全緑に復帰（詳細は PR 本文）

- **feat(hooks): gemini / antigravity に構造化イベントを横展開した（Phase 4-4）** (#1762)
  - `docs/design/agent-event-source-interface.md` §4 の手順 1〜8 を 2 ツール分実行した。新設 `src/lib/hooks/sources/gemini/`（`tool-id` / `event-vocabulary` / `settings-generator` / `shared-config-tree` / `source`）と `src/lib/hooks/sources/antigravity/`（`tool-id` / `hooks-config` / `source`）、`registry.ts` に 2 行、`index.ts` に re-export、`cli-tools/{gemini,antigravity}.ts` の `startSession` に世代フェンスと注入。**`AgentEventSource` I/F は変更していない／`if (tool === '…')` 型の抜け道も入れていない／`hook-event-vocabulary.ts` の共有表に gemini・agy の綴りを足していない**（判断根拠は [`docs/design/agent-hooks-gemini-antigravity-integration.md`](./docs/design/agent-hooks-gemini-antigravity-integration.md)）
  - **実機検証で Issue 本文・#1757 の記載と食い違った点（実測を正とした）**
    - **gemini の hook `timeout` はミリ秒。** #1757 §8.2 R13 は「単位はすべて秒」としていたが誤り。他ツールと同じ `timeout: 5` を書いた実 v0.55.1 セッションで `Hook execution error: Hook timed out after 5ms` となり、**hook は登録され開示バナーにも出て起動もしているのに curl が socket を開く前に殺され、全イベントが無言で失われた**。バンドルの `DEFAULT_HOOK_TIMEOUT = 6e4`（=60 秒）とメッセージ `Hook timed out after ${timeout}ms` で裏取り。`GEMINI_HOOK_TIMEOUT_MS = HOOK_TIMEOUT_SECONDS * 1000` に修正し、ms/秒それぞれをテストで固定した（agy は doc どおり秒。実測でも `timeout: 5` で 3 イベント配送成功）
    - **gemini の項目 6/7（#1757 §5.3.6 で未計測）を出荷バイナリの実装読みで確定した。** `DefaultHookOutput.isBlockingDecision()` は `decision === 'block'|'deny'`、`isAskDecision()` は `=== 'ask'`、`shouldStopExecution()` は `continue === false` ＝**空応答にはどのフィールドも無いので no-decision は fail-OPEN**。計測（「そのとき止まらなかった」）より強い根拠（「止められる分岐が無い」）
    - **gemini の `Notification` の subtype は `ToolPermission` の 1 種のみ**（`NotificationType` の唯一のメンバ）。意味は Claude の `permission_prompt` と同一
    - agy の `Stop` は `--print`（headless）モードでは発火しないケースを確認した（ツール承認が auto-deny で終わった実行では CommandMate の hook もユーザー自身の hook も動かなかった）。ツールを使わない普通のターンでは発火する
  - **gemini の Policy Engine と hooks の優先順位（Issue の必須確認事項）— Auto-Yes の意味は一意である。** scheduler の実装は `evaluateBeforeToolHook()` → `checkPolicy()` → `if (hookDecision === 'ask') decision = ASK_USER` の順。**hook にできるのは (a) `deny`/`block` で即座にツールを落とす (b) `continue:false` で停止させる (c) `ask` でダイアログへ引き上げる の 3 つだけで、`checkPolicy` の裁定を「承認」に変える分岐は存在しない**（`'allow'` を hook 出力から読む箇所も無い）。したがって **gemini の承認は Policy Engine（`--approval-mode` / `--policy` / `-y`）専任**であり、CommandMate は `encodeVerdict()` で常に `{}` を返し、Policy Engine のフラグも一切渡さない（**hooks を注入しても gemini セッションの権限は広がらない**）。gemini の Auto-Yes は従来どおり TUI 経路のみで、hooks 側に第 2 の承認経路が生まれないため二重定義にならない
  - **agy のグローバル設定 1 本を複数 worktree でどう扱うか（Issue の必須確認事項）— 相関を設定ファイルから追い出した。** agy が読むのは `~/.gemini/config/hooks.json` **ただ 1 本**（doc の `<workspace>/.agents/hooks.json` は読まれない）、payload に `cwd` も `workspacePaths` も無く、hook の cwd は `~/.gemini/config`。よって**設定ファイルには worktree も instance も書かず**、起動コマンドの `CM_HOOK_URL='…?tool=antigravity&worktreeId=…&instanceId=…'` に相関を載せた（中継スクリプトは `CM_HOOK_URL` を自分で読むので hook コマンド内のシェル展開に依存しない）。**1 本の設定で N worktree × M instance が同時に成立**し、CommandMate 外で起動された agy は cwd が worktree に解決できず 202 で捨てられる（誤紐付けは起きない）。`HOME` 差し替えは gemini の OAuth 資格情報ごと巻き添えにするため採らなかった
  - **agy の `PreToolUse` は張っていない。** `decision` 必須の fail-CLOSED（`{}` で全ツール拒否＝#1757 P10）で、中継スクリプトは stdout に何も書かないため、張った瞬間にマシン全体のツール呼び出しが止まる。中継に裁定を返す機能を足すのは `scripts/hooks/**` の変更＝本 Issue のスコープ外なので、**agy の承認裁定（Auto-Yes v2 経路）は本 Issue では実装していない**（`encodeVerdict` は正しい wire 形を実装済みで、中継が対応した時点で `PreToolUse` を登録すれば有効になる）。`PostToolUse` / `Stop` は doc と実測の両方で空応答が安全
  - **登録イベント**: gemini = `SessionStart` / `BeforeAgent` / `AfterAgent` / `Notification` / `SessionEnd`（`BeforeTool`/`AfterTool` は**写像だけ持ち登録しない** — 同期実行でツール呼び出しごとに 2 往復ブロックする一方、`running` は `BeforeAgent` が既に立てている）。agy = `SessionStart` / `PostToolUse`(matcher `*`) / `Stop`（agy には `user_prompt_submit` が無いため `PostToolUse` が唯一の「実行中」signal）
  - **共有 config ツリーの非破壊**: `~/.gemini/` には gemini の `settings.json` と **OAuth 資格情報**、agy の `config/hooks.json` と `antigravity*` が同居する。書き込みは常にマージ（gemini は `hooks` 内の自分のエントリだけ差し替え、agy は名前つき hook `commandmate` の 1 キーだけを占有）。新規作成時のみ file 0600 / dir 0700 で、**既存ファイルの permission は変えない**。両方向の非破壊を sha256 でテスト固定した（最悪ケースとして「worktree の `.gemini` が共有ツリーそのもの」でも検証）
  - **消費層の subtype 語彙が Claude のままだった点への対処**: `status-mapping.ts` / `agent-event-state.ts` は `detail === 'permission_prompt'` というリテラルを直接比較する。#1759 が抽象化したのはイベント*名*だけなので、gemini の `ToolPermission` をそのまま publish すると**イベントは正しく届いて記録もされるのに永久に `waiting` にならない**。ソース側（`extractDetail`）で翻訳した
  - **`AgentEventSource` I/F で表現できなかったもの（#1759 への報告。抜け道は作っていない）**: (G1) `AgentInstanceRef` に worktree の**パス**が無く、`configScope:'per-worktree'` の gemini は `prepareLaunch` だけでは設定を書けない → `injectGeminiHookSettings(worktreePath, target)` を別 export し `cli-tools/gemini.ts` から呼ぶ（`settingsPath` は null）。(G2) `NoDecisionBehavior` に「裁定しない＝**拒否される**」が無い（`proceeds`/`blocks`/`blocksUntil` の 3 値）→ agy は `blocks` を選択（`describeAbstain().safe === false` になる唯一の値で、拒否は待機より悪いので危険側に倒れる）。summary の文面は機構としては不正確。(G3) subtype 語彙が共通化されていない（上記）
  - **実機検証（本番サーバ port 3000 には 1 件も飛ばしていない。ローカルのダンプサーバ 3762 とツール専用 tmux socket `cmate-p44-gem` のみ使用）**
    - gemini: `session_start` / `user_prompt_submit` / `session_end` の 3 種が実 v0.55.1 から受け口まで到達（クエリ `tool=gemini&worktreeId=wt-live&instanceId=gemini-2`、body に `cwd` / `sessionId` / `detail`）。`AfterAgent` と `Notification` は**このマシンのアカウントが `IneligibleTierError`（`UNSUPPORTED_CLIENT`）でモデル呼び出しに到達できず未計測**（#1757 §5.3.6 と同じ制約。「確認できなかった」であって「実在しない」ではない — 綴りは CLI 自身の `HookEventName` enum と `hooks migrate` の変換表で確定済み）。ユーザーの `security.auth` キーを含む既存 settings.json がマージ後も残ることを実ファイルで確認
    - agy: `session_start` / `post_tool_use`(×6) / `stop` が実 v1.1.12 から到達（クエリ `instanceId=antigravity-2`、`cwd` は予告どおり `~/.gemini/config`）。**同じ `hooks.json` に置いたユーザー自身の名前つき hook (`user-probe`) も同時に発火**＝併存を実機で確認。`Stop` に空応答を返しても**エージェントは正常に停止した**（fail-safe を実測）
    - **fail-open**: 受け口を落とした状態で両ツールを実行し、gemini は hook 失敗ログ 0 件・agy は通常どおり応答（どちらも停止しない）
    - **ユーザー設定の before/after**: `~/.gemini/settings.json` / `~/.gemini/config/*.json` / `~/.gemini/antigravity-cli/settings.json` の **sha256 が全一致・diff 空**。検証用に作成した `~/.gemini/config/hooks.json` は検証前が「ファイル無し」だったので削除して原状復帰済み
  - **空振り緑の反証**: 10 変異すべてが赤になることを実測し、戻して緑に復帰することを確認した（括弧内は赤になったテスト数）— registry から gemini を外す(7) / antigravity を外す(3) / gemini の `AfterAgent→stop` を壊す(4) / agy の設定に焼く `--event stop` を壊す(1) / **agy の `noDecision` を `proceeds` にする(2)** / gemini の設定書き込みをマージ→置換にする(5) / agy の同(2) / gemini の `beginAgentSession` を消す(4) / agy の同(2) / gemini の timeout を ms→秒に戻す(1)
  - **品質ゲート実測**（`cmd > log; echo $?`）: `npm run lint` 0 / `npx tsc --noEmit` 0 / `CI=true npm run test:unit` 0（827 files・15175 tests）/ `CI=true npm run test:integration` 0（80 files・1147 passed・2 skipped）。**並列モードの `npm run test:unit` では実行ごとに違う無関係ファイルが 5s timeout で落ちた**（1 回目 `gate-runner-timestamps`、2 回目 `hooks-claude-done-delegation` ほか 2 件。単独実行ではいずれも緑、CI モードでは全緑）＝負荷起因で本変更とは無関係
  - 既存テストの期待値は削除していない。`tests/unit/cli-tools/antigravity.test.ts` のみ、`startSession` が実 `~/.gemini/config/hooks.json` を書かないよう **HOME を一時ディレクトリに退避**し、`sendKeys` の 4 件を `CM_HOOK_URL` プレフィックスつきの形に更新した（#989 の `--model` クォート検証は維持）

- **refactor(hooks): `AgentEventSource` 抽象を抽出し、Claude 固有の継ぎ目をツール別実装に分離した（Phase 4-1）** (#1759)
  - Epic #1720 の Phase 4-2〜4-5 が「1 ファイル足せば 1 ツール増える」形になるための土台。**Claude の挙動は 1 バイトも変えていない**（`buildAgentHookSettings` の出力・`PermissionRequest` の応答ボディ・注入される `--settings` の内容はすべて develop と同一であることを実測で確認済み）
  - 新設 `src/lib/hooks/sources/`: I/F（`types.ts`）／述語つきマッパ（`event-mapper.ts`）／`definePushHookSource`・`definePullEventSource`（`define-source.ts`）／裁定スロット（`pending-decisions.ts`）／`describeAbstain`（`abstain.ts`）／`globalThis` 経由のレジストリ（`registry.ts`）／未対応ツール用の互換ソース（`legacy-relay.ts`）／Claude 実装（`claude/`）。ツール追加手順は [`docs/design/agent-event-source-interface.md`](./docs/design/agent-event-source-interface.md)
  - **`scripts/hooks/cmate-agent-event.sh` の語彙不足を修正した（Phase 4 全体のハードブロッカー）。** `type:"http"` は Claude 専用で他 4 ツールは使えない（#1757）ため、この中継が唯一の配送路である。にもかかわらず `--event` は 5 語しか受けず、#1726 で `AGENT_EVENT_TYPES` に入った `pre_tool_use` / `post_tool_use` を渡すと exit 2 していた。加えて `map_event_name` は `PreToolUse` / `PostToolUse` も gemini の `BeforeTool` / `AfterTool` / `BeforeAgent` / `AfterAgent` も知らなかった。**7 語すべて ＋ 5 ツールの native 名**に対応させ、session id の抽出に `conversationId`（antigravity）/ `turn_id`（codex）を追加し、`--detail` を新設した（bash 3.2 互換を維持）
  - **`NoDecisionBehavior` を型として持たせた（実測 C3）。**「裁定しない＝安全」は成り立たない: Claude / codex / copilot は無応答で通常フローへ進むが、**antigravity は空応答を「拒否」と解釈してツールを全停止**し、**opencode はタイムアウト無しで無限待ちする**（10 分 19 秒の実測）。`/api/hooks/permission-request` は `abstain` かつ `noDecision.kind !== 'proceeds'` のとき `permission-request-abstain-blocks-agent` を warn するようにした。どちらの失敗も**セッションが無言で止まる**（考え込んでいる agent と区別がつかない）ため、記録が唯一の手がかりになる
  - **イベント写像を「名前の表」から「述語つきマッパ」に変えた（C4）。** `Record<string, AgentEventType>` では opencode を写せない — `message.part.updated` は `part.state.status` によって `pre_tool_use` と `post_tool_use` に割れ、`user_prompt_submit` には専用イベントが無く（`message.updated` の `info.role`）、`notification` は 3 つの別イベントの束である
  - **未知イベントで throw しないことを型と実装の両方で固定した（C8）。** opencode の `server.heartbeat` はサーバ自身の `/doc` に型定義が無いのに 10 秒ごとに届く。未知は `null` を返して数える（`getUnknownEventTally()`）
  - **世代フェンス（S8）を共通ヘルパ化した。** `beginAgentEventGeneration` の呼び出しは全コードベースで `claude-session.ts` の 1 箇所だけだった＝**他ツールにはフェンスが無い**。`src/lib/session/agent-session-lifecycle.ts` の `beginAgentSession()` に集約し、Claude の既存呼び出しをそれ経由に置き換えた。Phase 4-2 以降は各 `startSession` からこの 1 行を呼ぶ
  - S1/S2（イベント名の綴りと subtype 抽出）を `agent-event-types.ts` から `hooks/sources/hook-event-vocabulary.ts` へ移した。`agent-event-types.ts` に残るのは 7 語だけになり、**ツール非依存の共有モジュールに 1 ツールの綴りが同居する状態を解消した**（次のツールが同じ表に追記される導線を断つのが目的）
  - **I/F が pull 型（SSE 購読 ＋ REST 応答）を表現できることを、#1758 §9.4 のチェックリスト 11 項目に照らして検証した**（`tests/unit/hooks/sources/pull-source-contract.test.ts` が opencode の実 SSE fixture でソースを実際に組み立てて確認する）。**実際の opencode 対応は #1763 のままスコープ外**
  - **空振り緑の反証**: レジストリから claude を外す／`Stop`→`stop` の写像を 1 つ壊す／`noDecision` を全ソース `proceeds` に固定する／`describeAbstain` を常に safe にする、の 4 変異を注入して赤になることを実測した（順に 11・26・2・6 テストが赤）
  - **fix(test): `/proc` 配下を env var に代入する fixture が Linux CI を 5h31m ハングさせたため差し替えた**（PR #1773 の postmortem）。`CM_AGENT_HOOKS_DIR = '/proc/…'` が製品コードの `mkdirSync(dir,{recursive:true})` に届き、**procfs は存在し得ない子への mkdir に EPERM ではなく ENOENT を返す**ため Node の recursive 実装が「親が無い＝作って再試行」と解釈して **C++ 内で同期無限ループ**になる（コンテナ実測: 25 秒経っても返らず CPU 100.4%・メモリ 12.66MiB で平坦）。同期ループなのでイベントループが止まり **vitest の testTimeout すら発火しない**（OOM 痕跡も残らず、ログが無音になるだけ）。**macOS では `/proc` が存在せず即 throw → 緑になるので、原理的にローカル再現しない**。fixture を「親が通常ファイルであるパス」に変更した（通常ファイルは子を持てないので全 OS で即 ENOTDIR。macOS/node 24 0ms・Linux/node 18 1ms）。**テストの意図（fail-open の検証）と `expect` 行は不変**
  - 再発防止に `tests/unit/guards/no-procfs-env-fixtures.test.ts` を追加した。`tests/` 全体を走査し **env var への `/proc` `/sys` `/dev` 配下パスの代入**（`process.env.X = …` / `process.env['X'] = …` / `vi.stubEnv(…)`）を禁じる。#1760〜#1763 の 4 ワーカーが当該ファイルを雛形にするため、コメントではなく赤いテストで止める。**文字列としての `/proc` 参照は対象外**（`system-directories.test.ts` / `db-migration-path.test.ts` / `git-workflow.test.ts` は実 fs に触れない）。`/dev/null` 等の終端デバイスノードは完全一致で許可（`GIT_CONFIG_GLOBAL=/dev/null` は既存の正当な idiom）
  - 既存テストの期待値（`expect` 行）は 1 つも削除・変更していない。`tests/unit/scripts/cmate-agent-event.test.ts` の 2 ケースだけ**入力値**を差し替えた（`PreToolUse` は #1726 以降「対応語の無いイベント」ではなくなったため、その役を `PreCompact` に交代させた。期待値は同一）

### Fixed

- **fix(security): 設定パスが `/proc` `/sys` `/dev` 配下でもサーバが停止しないようにした** (#1774)
  - **`/proc` への recursive mkdir は失敗せず「返らない」。** procfs は存在し得ない子への `mkdir` に EPERM ではなく **ENOENT** を返し、Node の recursive mkdir はそれを「親が無い」と解釈して親を作って再試行する。親（`/proc`）の作成は EEXIST で成功扱いになるので **1 階層でもループに入る**。**同期版はイベントループごと停止**（`try/catch` は書いてあっても**呼び出しが返らないので到達しない**）、**非同期版は promise が永久に settle せず libuv スレッドプールを 1 本恒久占有**する（既定 4 本）。**エラーログも OOM も残らない** — PR #1773 の `Unit Tests` は fixture が `CM_AGENT_HOOKS_DIR` に `/proc/…` を入れたことでこの状態に入り、**5 時間 31 分 57 秒、出力ゼロ**で走った（同期スピンなので vitest の `testTimeout` も発火できない）
  - **Linux / コンテナ限定。** macOS は `/proc` が無いため即 throw して fail-open になり、ローカルでは構造的に再現しない
  - **共有ヘルパ 1 つを各 resolver に通す形にした**（`src/config/safe-directory.ts` の `resolveSafeDirectory(candidate, fallback, source)`）。**Issue 本文は `CM_AGENT_HOOKS_DIR` / `CM_LOG_DIR` の 2 経路と書いているが、develop `3e8a6192` 時点の実測は 5 経路**（Phase 4 の #1760 / #1761 / #1763 が `CODEX_HOME` / `COPILOT_HOME` / `CM_OPENCODE_PORT_FILE` を同型で追加していた）。「2 箇所に足す」ではなく resolver 側に集約したので、6 個目のツールは既存の resolver を呼ぶだけで守られる。`gemini/shared-config-tree.writeJsonObjectFile()`（`~/.gemini` ツリーの共通 writer）は**引数でパスを受け取り代替既定値が無い**ので、フォールバックではなく **throw で拒否**する（呼び出し元 2 つは既に throw を「hooks 無しで起動」として扱う＝fail-open の形は不変）
  - **`isSystemDirectory()` をそのまま適用するのは誤りで、実測で退けた（Issue 本文の「提案する対処 1.」からの意図的な逸脱）。** 同関数は `/tmp` と `/var` も弾くが、そこは**ハングしない普通の書き込み可能ディレクトリ**であり、`os.tmpdir()` は Linux で `/tmp`・macOS で `/var/folders/…` と**両方その配下**にある。適用すると `tests/setup.ts:15` の `CODEX_HOME` 隔離と `tests/helpers/agent-hooks-dir.ts` が既定値に落ちて**テストがユーザーの実 `~/.codex` と `~/.commandmate/hooks` を書き換え**、コンテナ運用の `CM_LOG_DIR=/var/log/commandmate` も黙って化ける。**ハングを防げないうえに正常な構成を壊す**ので、`VIRTUAL_FILESYSTEM_ROOTS`（`/proc` `/sys` `/dev`）を名前付き部分集合として切り出し、判定機構（lexical/physical 両解決＋境界一致）は既存のものを共有した。`VIRTUAL_FILESYSTEM_ROOTS ⊂ SYSTEM_DIRECTORIES` はテストで固定してある
  - **throw しない。** ログディレクトリで throw するとロギング自体が死に、hooks は既に fail-open が設計方針。既定値へフォールバックして `logger.warn` を出す。警告は `(source, candidate)` ごとに 1 回だけ（`getLogDir()` は全ログ書き込みの経路上にあるため、無条件だと 1 つの設定ミスがログ洪水になる）
  - **テストは fs にも env にも触れない。** `tests/unit/guards/no-procfs-env-fixtures.test.ts` が env 代入を機械的に赤にするので、①述語と resolver は**素の文字列引数**で全分岐を固定 ②5 設定の配線は**述語を mock した無害な sentinel パス**で end-to-end に確認 ③引数を取る入口（`HookSettingsOptions.directory` / `CodexHookOptions.codexHome` / `writeJsonObjectFile`）だけ**実 `/proc` 文字列**で fail-open まで通す、の 3 段に分けた
  - **空振り緑の反証**: 10 変異を 1 つずつ注入して**全部赤**になることを実測（経路ごとのガード除去 8 種＝順に **2・3・2・2・3・2・2・3** テスト赤／`isVirtualFilesystemPath` を常に false＝**32** 赤／フォールバックを候補値そのままに変更＝**23** 赤）。すべて戻して 136/136 緑に復帰
  - **実機検証**: ①**実 Linux コンテナ（`node:24-bookworm`）でガード無しの `mkdirSync('/proc/x/y',{recursive:true})` が 15 秒間 CPU 100.4% / メモリ平坦のまま返らないことを再現**し、②**同じコンテナで実コードをバンドルして走らせると 1ms で既定値へフォールバックし `/proc/x` は作られない**ことを確認（`/tmp` `/var/log` `~/.codex` 相対パス `/procfs` `/devices` は素通し）。③macOS 側は隔離環境（**ポート 3774・隔離 DB**、本番 3000 は無停止）で `CM_LOG_DIR=/proc/definitely-not-writable/cmate-1774` を与えて**サーバが起動し `GET /` が 200**、`/api/worktrees/<id>/logs` が 200 で `<cwd>/data/logs` にフォールバックし、**6 回叩いても警告は 1 回**であることを実測。`~/.commandmate/` `~/.codex/` `~/.copilot/` `~/.gemini/` は前後で sha256 マニフェスト一致（差分は develop 由来の既存テスト `agent-session-lifecycle-1759.test.ts` が `CM_AGENT_HOOKS_DIR` を隔離せず書く 1 ファイルのみで、内容は `CM_PORT` から決まる＝本変更とは無関係。同一環境の 2 回連続実行で同一ハッシュを実測して確認）
  - **`grep -rn "mkdirSync(\|mkdir(" src/ | grep recursive` の全 25 件を 1 件ずつ判定**し、安全だったものも根拠つきで `docs/design/virtual-filesystem-directory-guard.md` §4 に記録した（DB 系 3 件は `isSystemDirectory` 済み、skills 系 6 件は検証済み root 配下、`file-operations` 3 件は `checkPathSafety` で worktree 内に限定、CLI 4 件と `tmux/read-mode` は `homedir()` 定数、ほか）。**残存リスクとして「これらの安全は `HOME` が正気であることに依存する」を明記**

## [0.22.2] - 2026-08-09

> **Highlight**: サーバーを 2 つ動かしている環境で、**`commandmate ls` などが `~/.commandmate/.env` を読まず既定ポート 3000 の別サーバーに繋いでいた**問題を修正する（#1743）。`.env` を読んでいたのは `status` だけだったため「どのサーバーに繋がっているか分からない」状態になり、`cmate-orchestrate` の dispatch は正しく作成・登録した worktree を「無い」と誤判定して run を 1 回無駄に消費していた。解決順を **シェルで export した `CM_PORT` > `~/.commandmate/.env` > 3000** に統一し、`ls` だけでなく `ApiClient` を使う全 subcommand が同じ経路で解決するようにした。**接続先ホストは `localhost` から `127.0.0.1` に変わる**（`status` が報告するアドレスと一致させるため）。あわせて、リリース PR の CI を断続的に落としていた `manager.test.ts` の実プロセス起動（1 ファイルで 20 回以上）を排除し、実行時間を 1.28s → **357ms**（うち tests 7ms）に短縮した（#1752）。

### Fixed

- **test: `tests/unit/cli-tools/manager.test.ts` が CI で断続的にタイムアウトで落ちる問題を修正** (#1752)
  - このファイルは `child_process` をモックしておらず、`getToolInfo` / `getAllToolsInfo` / `getInstalledTools` を呼ぶたびに 7 ツール分の**実プロセス**を起動していた。`BaseCLITool.isInstalled()` は `which <cmd>`（timeout 5000ms）、`CopilotTool.isInstalled()` は `gh --version` → `gh copilot --help` の **2 段直列**（最悪 5000 + 5000 = 10,000ms）。一方 `vitest.config.ts` は `testTimeout` 未設定＝既定 5000ms なので、**内側の予算が外側を構造的に超えており**、copilot の内側タイムアウトは一度も観測されえない。GitHub Actions ランナーには `gh` がプリインストールされているため stage 1 は必ず成功し、stage 2 が必ず実行される。v0.22.0 の同一コミット・同一ジョブが pull_request run では success、push run では failure に割れた（run 31151127023 / 31151080694）のはこのため（アサーション不一致ではなくタイムアウト）
  - `vi.mock('child_process')` で `exec` / `execFile` を差し替えて実プロセス起動を排除した。**`testTimeout` を広げる対処は採っていない**（遅さの原因が残るうえ、全体既定の変更は他 816 ファイルに波及する）
  - あわせて空振りの assertion を潰した。以前は `expect(typeof info.installed).toBe('boolean')` しか見ておらず、**true でも false でも緑**になっていた。`installed` を true / false の両方で固定し、copilot の 2 段チェックは「stage 1 失敗で stage 2 を呼ばない」「stage 1 成功 → stage 2 失敗で false」を個別のテストとして分離した
  - `stopPollers` の委譲先である `@/lib/polling/response-poller` もモックした（この責務は `manager-stop-pollers.test.ts` が持つ）。依存グラフの import だけで 500ms 以上かかっていたため
  - **変異注入で非空振りを証明済み**（2026-08-08）: (a) `getAllToolsInfo()` の `Promise.all` を直列 for ループへ変えると `should issue every probe before any of them resolves (checks run concurrently)` が赤（発行済み probe が `['which claude']` の 1 本だけになる）、(b) `CopilotTool.isInstalled()` の stage 2 を削ると 3 件が赤（copilot の 2 段テスト 2 件と `getInstalledTools` の `copilot` 混入）。変異はいずれも元に戻し、`src/` の diff が空であることを確認済み
  - **実測**: 23 tests / `Duration 357ms`（tests 7ms）、`CI=true` でも 364ms。修正前は 17 tests / 1.28s（tests 216ms、実プロセス起動あり）。なお開発機では 6 ツールすべてと `gh copilot` が実際にインストールされているが、テストは `installed: false` を期待して緑になる — 実バイナリを参照していないことの実測的な裏付け
- **cli: `ApiClient` が `~/.commandmate/.env` を読まず、`ls` 等が既定ポート 3000 の別サーバーに繋いでいた問題を修正** (#1743)
  - **解決順は「シェルで export した `CM_PORT` > `~/.commandmate/.env` の `CM_PORT` > 3000」**（`options.baseUrl` が渡された場合は従来どおり最優先）。修正前の `ApiClient` constructor は `process.env.CM_PORT || '3000'` として `process.env` だけから解決しており、`.env` を一切読まなかった
  - **対象は `ls` だけではない**。`ApiClient` を使う全 subcommand（`ls` / `send` / `wait` / `capture` / `respond` / `sync` / `verify` / `auto-yes` / `task` / `instances` / `report` / `skill` / `update`）が同じ欠陥を共有していた。生成箇所はいずれも `baseUrl` を渡していないため、constructor の解決を直すことで全部が直る
  - 実害: サーバーを 2 つ動かしている環境で `commandmate status` は `.env` の `CM_PORT`（例 60301）を報告する一方、`commandmate ls --json` は 3000 の別サーバーの worktree 一覧を返していた。`cmate-orchestrate` の dispatch runner は `ls --json` の branch 一致だけで worktree を解決するため、**正しく作成・登録された worktree が「無い」と判定され run を 1 回無駄に消費する**
  - **`status` と同じ解決を使い回すのではなく、順序を反転させた**。`status` 側の `loadEffectiveEnv()` は「サーバーが実際にどこにいるか」を答えるもので、`daemon.start()` が子プロセスへ `{...process.env, ...parsed}` を渡す事実に合わせて `.env` を `process.env` の**上**に重ねる。これをクライアント側に流用すると、ドキュメント記載の `CM_PORT=3011 commandmate ls`（その 1 回の呼び出しの接続先を呼び出し側が指定する運用）が `.env` に上書きされて無効化される。そのため新設した `loadClientEnv()` は `.env` を `process.env` の**下**に敷く（標準的な dotenv の優先順位）。両者がなぜ違う順序なのかはコード中のコメントに記載してある。Issue が要求した統一は「**両方とも `.env` を参照する**」ことであり、それは満たしている
  - あわせて、ハードコードされていた `http://localhost:${port}` をやめ `resolveServerEndpoint()`（Issue #1266）に揃えた。これにより `CM_BIND`（`0.0.0.0` は `127.0.0.1` へダイヤル）と、`CM_HTTPS_CERT` / `CM_HTTPS_KEY` の**両方**が揃うときだけ https という既存規則が CLI の接続先にも効く。ホストは `localhost` ではなく `127.0.0.1` になり、`status` が報告するアドレスと一致する
  - dotenv の読み取りは `quiet: true`（バナーが **stdout** に出るため `ls --json` の出力を壊す）と `processEnv: {}`（読み取り専用の解決であり、`.env` の値を `process.env` に注入すると以後 file 値が「export された値」として振る舞い、この優先順位自体を壊す）で行う
  - 回帰テスト: `tests/unit/cli/utils/api-client.test.ts` に解決順の 9 ケース（`.env` のみ／シェル優先／`options.baseUrl` 最優先／`.env` 不在で `parsed` が undefined／`CM_BIND`・`0.0.0.0`・https の cert+key・cert のみ）、`tests/unit/cli/utils/server-url.test.ts` に `loadClientEnv()` の 5 ケース。`.env` の読み取りは dotenv と `getEnvPath()` をモックして実ファイルに依存させない
  - **変異注入で非空振りを証明済み**（2026-08-08）: (1) constructor を `process.env.CM_PORT || '3000'` / `http://localhost:${port}` に戻すと api-client の 9 テストが赤（`dials the CM_PORT from ~/.commandmate/.env when the shell exports none` は `expected 'http://localhost:3000/api/worktrees' to be 'http://127.0.0.1:60301/api/worktrees'` ＝ Issue の症状そのもの）。(2) `quiet: true` を外すと `loadClientEnv > should print nothing to stdout` が赤（dotenv は `console.log` でバナーを出すことを実測済み）

## [0.22.1] - 2026-08-07

> **Highlight**: Skill 一覧が**古いバージョンをインストール済みとして表示し、そこからの更新が必ず失敗する**問題を修正する（#1753）。一覧 API は索引を、更新 API は receipt を真実として読んでおり、両者が食い違うと UI は旧版を出して更新導線を描き、押すと `SKILL_UPDATE_VERSION_NOT_ELIGIBLE` を返していた。エラー文言は利用者に「もう最新です」としか読めず、UI に索引を作り直す導線も無いため、**一度ずれると回復できない**状態だった。読み取り時の索引修復を「欠落行の復元」から「receipt と食い違う行の収束」まで広げ、コストは索引が既に持つ `receipt_sha256` との比較で抑えている（一致する行は parse も書き込みもしない）。**このリリースを適用すると、ずれている索引は一覧を開いた時点で自動的に直る。**

### Fixed

- **skills: 一覧 API が古い版を表示し、そこからの更新が必ず `SKILL_UPDATE_VERSION_NOT_ELIGIBLE` で失敗する問題を修正** (#1753)
  - `GET /api/worktrees/[id]/skills` は応答前に `restoreSkillInstallationIndex` で索引を修復するが、これは `gapsOnly: true` で呼ばれており、**行が既にある skill を receipt を読む前に除外**していた。したがって「行が無い」（#1709 が対象にしたもの）は直るが、**「行はあるが version が古い」は構造的に永久に直らない**。一方 `update-plan` は receipt を正とするため、**同一サーバ内で一覧 API は索引を、更新 API は receipt を真実としていた**。実機では 3 件（`cmate-task-contract` 0.1.0/0.2.2、`cmate-verify-advisor` 0.1.1/0.2.0、`cmate-verify` 0.3.1/0.4.2）が不一致で、その 3 件だけが更新に失敗していた。利用者にはエラー文言が「もう最新です」としか読めないため表示が古いことに気づけず、UI に rebuild の導線も無い
  - 読み取りが行を**挿入**はするのに**更新**はしない非対称に独立した根拠が無いため、read-through を「欠落行の復元」から「receipt と食い違う行の収束」まで広げた。**`prune` は #1709 の判断どおり維持する**（行を消すことはドリフトを隠すが、古い版を新しい版に直すことは何も隠さない）
  - **コスト設計**: 索引行が既に持つ `receipt_sha256` と、disk の receipt bytes の sha256 を比較する。一致する行は **parse も DB 書き込みもしない**（呼び出し回数で検証済み）。receipt 全体の digest なので version だけでなく source commit・artifact digest・root 集合（#1460）の drift も同じ 1 回の検査で捕まる。mtime/size を索引に持つ案は migration が必要なうえ、実機の 3 件は receipt mtime が同一秒だったため証拠として弱い。TTL 間引きは「一覧を開いて更新を押す」という失敗する操作が窓の内側で完結するため却下した
  - **実測**（macOS / `:memory:` DB / 実 receipt 相当 3KB / 両 root、200 回平均）: 修正前 N=11 `0.103ms` → 修正後 `0.367ms`、N=100（scanner の worktree 毎上限）`0.425ms` → `2.452ms`。全件 parse+write に倒した場合は N=11 `0.737ms` / N=100 `6.087ms` なので digest gate はその約 1/2.5。導入数 1 件あたり約 32µs で、既に dashboard の `status-scanner` が導入済み全**ファイル**を hash していることを踏まえれば読み取り経路の追加として妥当
  - `update-plan` の判定ロジックは変更なし（receipt を正とするのは正しい）。エラーメッセージのみ、要求された版と receipt が記録している版の**両方を示す**ようにした
  - **#1709 が現行挙動を pin していた 2 件のテストは削除せず期待値を反転して残した**（`reindex.test.ts` の `leaves a row the index already has exactly as it was` → `converges a row the index has onto the receipt that disagrees with it`、`worktree-skills-readthrough.test.ts` の `keeps serving the indexed version when the receipt on disk disagrees` → `serves the version on disk when the receipt disagrees with the index`）。何を決め、なぜ覆したかを本文に残してある。`prune` を固定するテスト（`never deletes an index row whose payload is absent` 等）は緑のまま
  - 回帰テスト: `tests/unit/lib/skills/reindex-drift-cost.test.ts`（新規、一致行の parse/upsert 呼び出し回数が 0 であること・drift/欠落は 1 回だけであること）、`tests/integration/skills-update.test.ts` に実 route での再現（install → update → **行だけ巻き戻す**ことで実機の「索引=旧版 / disk=新版」を再現 → 一覧が receipt の版を返し `hasSkillUpdate` が false になる）
  - **変異注入で非空振りを証明済み**（2026-08-07）: digest 比較を `indexedDigest !== null` に戻す（＝#1709 の「行があれば正しい」仮定）と unit 6 件＋integration 1 件が赤。エラーメッセージを旧文言に戻すと integration 1 件が赤
  - `npm run test:unit` exit 0（817 files / 14948 tests）、`npm run test:integration` exit 0（79 files / 1135 passed・2 skipped）を `cmd > log; echo $?` で実測

## [0.22.0] - 2026-08-07

> **Highlight**: 検出層を TUI 画面スクレイピングから **CLI 自身が申告する構造化イベント**へ移す基盤を入れた（Epic #1720）。発端は、claude のタスクパネル見出し `7 tasks (0 done, 1 in progress, 6 open)` が直上の選択肢プロンプトに「option 7」として紛れ込み、worker が無言で timeout する不具合である（#1708）。正規表現をもう 1 本足す対症療法ではなく、`PermissionRequest` / `PreToolUse` / `Stop` hook で**プロンプトの有無を CLI 自身に申告させる**経路を新設し、スクレイパと OR 合成した（どちらか一方が「プロンプトあり」と言えばプロンプトあり。互いの false は相手の true を打ち消さない）。あわせて、委任ワーカーが `pkill -f` で本番サーバを巻き込み停止させた事故と、環境変数の継承で本番 DB に書き込んだ事故を受け、`permissions.deny` の注入（#1739）と `env-clean` ゲート（#1740）で機構的に塞いだ。

### Fixed

- **session: `send` の prompt-waiting ガードが scraper しか見ておらず、構造化イベントだけが見ているダイアログへ打ち込めた問題を修正** (#1737)
  - `isPromptWaiting()`（#1708）は `buildCurrentOutput()` を通らず `detectSessionStatus()` を直接呼んでいたため、#1725 が入れた OR 合成（`scraperPromptWaiting || promptWaiting !== null`）を経由していなかった。**同じ「プロンプト待ちか」という問いに 2 実装があり、サーバは `isPromptWaiting: true` を publish しながら同じ瞬間の `send` を 201 で受けていた** — #1708 の実害（ダイアログの入力欄にテキストが溜まり、次の `respond` が残留テキストごと「メッセージ」として送られる）が、#1708 が塞ぐために作られた経路にだけ残っていた
  - 合成を `src/lib/session/prompt-waiting-composition.ts` に抽出し、`buildCurrentOutput` とガードの**両方がこれを呼ぶ**。OR 規則と scraper の非対称な解除規則（一度 `waiting` を見たフレームだけが「消えた」と言える）はこの 1 モジュールにしか無い。原因が「2 実装」なので、直し方が実装を増やすものであってはならない
  - **単に OR にするだけでは閉じない**。構造化 waiting の解除イベント（`Stop`/`PostToolUse`/`user_prompt_submit`/`idle_prompt`）は hooks が全経路 fail-open なので届かない事故がありえ、しかも「scraper に見えないダイアログ」はその scraper に解除させることもできない。貼り付いた記録が `send` を拒否し続けると、**そのセッションは誰も（運用者自身も）書き込めなくなる** — #1725 のワーカーが構造化側をガードに繋がなかった判断はこの点で妥当だった。よって fail-open を構造化側にも適用する: (1) 報告から **5 分**（`STRUCTURED_SEND_BLOCK_MAX_AGE_MS`）で send 拒否だけが失効、(2) `commandmate send --ignore-structured-prompt` で 1 回だけ迂回、(3) `CM_STRUCTURED_SEND_GUARD=off` でサーバ全体を無効化。**拒否メッセージにこの 3 つを書く**（画面に何も見えない状態で「プロンプトに答えろ」とだけ言われた運用者は詰む）
  - **上限が掛かるのは `send` の拒否だけで、`isPromptWaiting` の publish には掛からない**。誤った publish のコストはパネル 1 枚と `wait` の早期 exit 10 だが、誤った拒否のコストはセッションの書き込み不能であり、両者は同じ重みではない。5 分を過ぎても UI と `wait` はダイアログを報告し続ける（完了と誤読させない）
  - 画面に見えているプロンプトは**どの迂回手段でも拒否されたまま**（それは `respond` で答えられる本物で、打ち込むこと自体が #1708 の実害）。scraper 側には齢の上限も掛けない（毎回ライブのフレームを読み直すので自分で解除される）
  - 回帰テスト: `tests/unit/session/send-guard-structured-1737.test.ts`（20 ケース）と `tests/integration/api-send-structured-prompt-1737.test.ts`（10 ケース、実 hook fixture を実 route へ POST）。構造化 waiting のみで拒否／解除イベント後に通る／解除が来なくても TTL 経過後は通る／capture 例外で fail-open の 4 パターンに加え、**否定対照**（同じフレームでイベントが無ければ拒否しない・上限の内側では拒否する）を対にしてある
  - **変異注入で非空振りを証明済み**（2026-08-07）。7 変異すべてで対応するテストが赤: ガードを scraper 単独へ戻す（unit 8 / integ 6 失敗＝本 Issue の欠陥そのものを再現）、TTL 撤去（各 1）、TTL を 0 に（6/6）、per-send 迂回を無視（各 1）、OR を AND に（10/6）、scraper 解除規則の撤去（unit 3）、迂回を画面上のプロンプトにも広げる（各 1）
  - **production build の実機で確認済み**（2026-08-07、隔離ポート 3779・隔離 DB。dev モードでは #1736 により構造化イベントが機能しないため production build 必須）: 実 hook fixture を POST → `/current-output` が `isPromptWaiting=true, hook_permission_prompt` → 同状態の `send` が **409 `PROMPT_WAITING`** → `--ignore-structured-prompt` 相当のボディで **201** → `Stop` 投函後に **201**。5 分の上限も実時間で確認（t+0s と t+150s は 409、t+330s は `isPromptWaiting=true` のまま **201**）
- **types: `promptData` の縮退値 (`unclassified`) を hooks / reducer 連鎖の型が表現していなかった問題を修正** (#1738)
  - #1725 以降 `/current-output` は `promptData` に縮退値 `StructuredPromptWaitingData`（`type: 'unclassified'`、選択肢ゼロ、番号で答えられない）を載せて返すが、値が通る層は `PromptData` 単独のままだった。広げてあったのは**連鎖の末端 `PromptPanel` の prop だけ**で、WebSocket スナップショット・ポーリング hooks・UI reducer・Auto-Yes hook は「自分の型では存在しえない値」を握ったまま通していた。実害は出ていなかったが、危険なのは次に触る人が型を信じて `options` を参照したときで、**型検査は通り `unclassified` のときだけ実行時に壊れる**
  - 共有 union `LivePromptData` と型ガード `isAnswerablePromptData()` を `src/types/models.ts` に**1 箇所だけ**定義し、`TerminalSnapshotEvent` / `PanePromptState` / `PromptState` / `SHOW_PROMPT` action / `UseAutoYesParams` / `MobilePromptSheetProps` / `CurrentOutputResponse`（hooks 2 本）をそこへ差し替えた。`PromptPanel` のローカル `PanelPromptData` は共有型への alias に変更（定義の重複なし）
  - **`StructuredPromptWaitingData` は `PromptData` union に入れていない。** union の外に置いてあるのは意図的な設計判断で（`UNCLASSIFIED_PROMPT_TYPE` の注記）、閉じたのは union ではなく**値が通る経路の型**である。回帰テストに `@ts-expect-error` を置いてあるので、union を広げた瞬間 `tsc --noEmit` が「未使用の ts-expect-error」で落ちる
  - **調査で本文にない受け取り側を 2 つ発見して同時に修正した**: (1) `src/lib/realtime/types.ts` の `TerminalSnapshotEvent.promptData` — WS push 経路。`RealtimeEvent` の catch-all メンバが object literal を吸収するため broadcast 地点で型エラーにならず、不一致が一度も表面化していなかった。(2) `ChatMessage.promptData` — `chat_messages.prompt_data` は #1708 / #1725 の監査レコード（`UnclassifiedFrameRecord` / `StructuredPromptHistoryRecord`）と**同じ列を共有**しており、書き手が `as unknown as PromptData` で押し込んでいた。`StoredPromptData` を定義してこのキャストを不要にした
  - **`POST /api/worktrees/:id/respond` の実害を 1 件塞いだ**: 保存済みの `unclassified` 監査行を messageId 指定で「回答」すると、multiple_choice 分岐を素通りして yes/no 分岐に落ち、**誰も読めなかったダイアログに対して任意文字列を pane へ打ち込んでいた**。400 で拒否する（現行 UI からは到達不能 — ボタンが yes_no / multiple_choice でしか描画されないため）
  - CLI 側（`src/cli/types/api-responses.ts`）は `type: string` / `options?: unknown[]` の**意図的に緩いミラー**で縮退値を既に表現できていた。型変更は不要と実測で確認し、将来サーバ union へ締め上げて穴を再導入しないよう注記を追加した
  - 回帰テスト `tests/unit/prompt-data-type-gap-1738.test.tsx`（12 ケース）: 各層の型に実物の縮退値を代入する型ピン＋`/current-output` レスポンス → `useTerminalPanePolling` → `PromptPanel` の縮退表示までを 1 本で通す。`tests/integration/api-prompt-handling.test.ts` に respond 拒否 2 ケースを追加。**変異注入で非空振りを確認済み**（下記コミットメッセージ参照）
- **hooks: dev モードで構造化イベントが一切機能しなかった問題を修正（`agent-event-state` を `globalThis` 経由に）** (#1736)
  - `src/lib/session/agent-event-state.ts` が 6 つの Map を素のモジュールスコープで持っていた。`next dev`（`commandmate start --dev` / `tsx server.ts`）は route handler を**個別にバンドルする**ため、`POST /api/hooks/agent-event` が書いた Map と `GET /api/worktrees/:id/current-output` が読む Map が別物になり、`structuredEvents` が**常に全 null**に縮退していた。production build ではモジュールが共有されるので影響なし＝ CI もリリースも一度も見ていない
  - Epic #1720 の構造化状態**すべて**（#1549 の `lastStopEventAt` / #1722 の `lastAgentEvent` / #1723 の `sessionStatus` 2 層化 / #1724 の抑止記録 / #1725 の prompt_waiting / #1726 の AskUserQuestion）が同時に無効化されていた。**しかも無言** — エラーも警告も出ず payload は整形式のまま「イベントは来ていない」と言い続けるので、「hooks を設定したのに何も起きない」という #1720 が塞ごうとしている当の失敗様式になる
  - **実測で確認**（2026-08-07、隔離ポート 3779 の `tsx server.ts` / 隔離 DB）: POST が `agent-event-received` をログに出した直後の GET が `structuredEvents.lastEventType: null` を返した。修正後は同じ手順で `"user_prompt_submit"` を返す
  - `src/lib/polling/auto-yes-suppression-state.ts`（#1684）も**同型の分断**を受けていたので同時に修正した。書き手は `/api/hooks/permission-request`（`permission-decision-service` 経由）と Auto-Yes ポーラ、読み手は `buildCurrentOutput` で、常に別 route。ポリシー抑止で止まった worker の理由を CLI に出す機能そのものが dev で無効だった
  - 修正は `auto-yes-state.ts`（#153）が確立していた `globalThis.__x ?? (globalThis.__x = new Map())` パターンをそのまま踏襲。**このパターンは既に repo 内 17 モジュールで使われていたのに、どこにも明文化されていなかった**ため、`docs/module-reference.md` 冒頭に規約として追加した（適用対象／非適用対象＝派生キャッシュ・ポーラループ内で完結する状態、の線引きつき）
  - 回帰テスト `tests/unit/session/agent-event-state-module-identity.test.ts`: `vi.resetModules()` でモジュールを 2 回ロードし、片方が書いた状態をもう片方から読めることを 7 ケースで固定。**変異注入で非空振りを証明済み** — 7 つの Map を 1 つずつ素のモジュールスコープに戻すと、いずれも対応するケースが赤になることを実測（全戻しでは 7/7 赤）
- **skills(orchestrate-monitor): `hooks-git.sh` が現行の worktree id を 1 件も解決できず、`commits` / `uncommitted` が恒久的に 0 になる問題を修正** (#1728)
  - `mh_worktree_path()` は worktree を**ブランチ名**でしか突合していなかったが、CommandMate が id を採番する規則は #1621 以降**ディレクトリ名**（`deriveWorktreeId()` ＝ `sanitize(basename(path))`、初回登録時に確定）である。`commandmate-issue-1728` / `fix/1728-…` のようにディレクトリを Issue 番号で採番するリポジトリでは**1 件も一致せず、メイン worktree すら解決できなかった**。`slug(basename(<path>))` を第 1 候補として追加し、ブランチ由来の旧 2 規則は残した（旧 id もそのまま解決できる）
  - **最も重い影響は STARTED ガードの不活性化**。`verify-completion.sh` は `commits=0 && uncommitted=0` を「タスクが composer から出ていない」の署名として読むため、恒久 0 のもとでは「未起動 idle を COMPLETE と誤報しない」ガードが**誰も測っていない数字**で裁定していた。#1614 が塞いだのは git コマンドが失敗する経路で、これは**git は成功して突合が外れる**別経路である
  - 突合はディレクトリ優先（稼働中サーバが配る id が 1 なので、両規則が別 checkout に当たったときは 1 が勝つ）。`branch` レコードを持たない detached HEAD も解決できるようになった。ディレクトリ名が衝突する 2 checkout は区別できないので、最初の 1 件を数えたうえで `WARN` を出す
  - **診断行に `ERROR` / `WARN` のレベル語を付けた**。従来の `monitor hooks: …` は `WARN` も `ERROR` も含まないため、運用でよく使う `2>&1 | grep -Ei "…|ERROR|FAIL"` で**1 行残らず消えていた**。この欠陥が 25 分間気付かれなかった直接の理由がこれである。`ERROR` = 両カウンタとも測れていない／`WARN` = 片方だけ劣化
  - 回帰テストは **ディレクトリ名 ≠ ブランチ名の repo** を fixture にする（`hooks-git-resolution.test.ts`）。既存テストの fixture は `myrepo-x` / `feature/x` / id `myrepo-feature-x` ＝ 旧規則で組まれており、この穴を構造的に検知できなかった

- **skills(orchestrate-monitor): `monitor.sh` が黙って死に、ワーカーが無監視のまま走り続ける問題に可観測性を追加** (#1728)
  - 起動行 1 行だけを出した監視が約 25 分後に **exit 144** で沈黙終了し、その間ワーカー 2 本は正常稼働のまま無監視だった（2026-08-06）。健全な沈黙と死んだ沈黙が区別できないのが本体である
  - HUP / INT / QUIT / PIPE / TERM を trap して `monitor: ERROR caught SIG<name>` を stderr へ出し `128+n` で終了する。SIGURG（macOS の signal 16 ＝ 144 - 128）は**致死化せず** `WARN` を出して監視を続ける（既定動作が無視のため）
  - 正常終端（全 COMPLETE / `--max-polls` 到達）**以外**の全終了で `monitor: ERROR exiting on poll round <r> with <d>/<n> worker(s) complete` を出す。EXIT trap にぶら下げてあるので個別に trap していない死に方でも出る。引数検証で落ちる経路は trap 設置前なので従来どおり
  - `--heartbeat N`（既定 10、`0` で無効）で `monitor: alive (poll=N, complete=d/total)` を定期出力する。既定の運用ストリーム（介入・終局判定）は byte 単位で従来どおり
  - **再現条件は未特定**。144 はパイプライン（`monitor.sh … | grep …`）の `$?` ＝ grep の終了コードでもありうるため、`monitor.sh` 自身が signal 16 で死んだとは断定していない。次に起きたときに原因がログへ残るようにした修正である
  - **上記 2 件は公開版 skill `cmate-orchestrate-monitor` にも移植済み**（[commandmate-skills#110](https://github.com/Kewton/commandmate-skills/pull/110)、skills 0.7.0）。`sync-map.json` の `port-required` エントリ 3 件は両側反映済みとして記録してある

- **detection: claude のタスクパネルが直上のプロンプトを飲み、worker が無言で timeout する問題を修正** (#1708)
  - タスクパネルはペイン最下部に固定描画されるため、実運用の 200x1000 ペインではダイアログが上部・パネルが約 880 行下に来る。空行が潰されるとパネルが Pass 2 の走査窓に入り、ヘッダ `N tasks (X done, …)` と折り畳み行 `… +N completed` が**それぞれ独立に**選択肢として拾われて本物の選択肢を弾いていた（実キャプチャの 1 行削除実験で確認。片方だけ直しても未検出のまま）。パネルを**ブロックごと** skip する
  - 検出漏れは `isPromptWaiting: false` を意味し、それが唯一の「人間待ち」信号なので、auto-yes も `wait --on-prompt agent` の exit 10 も契約の `autoYes` ポリシーも同時に無効化されていた
  - パネル行の判定グリフは**実測した `◼ ◻` のみ**。`☐ ☑ ☒` を含めると multiSelect の選択肢行をパネルと誤認してプロンプトごと消すことを実測したため、形が似ているという理由で広げない
  - fixture は claude 2.1.223 の実 tmux capture。120x40 ではパネルとダイアログが同一画面に載らず**再現しない**
  - **直っていないこと**: 2026-08-05 の元報告（Bash 承認プロンプト）の分岐点は再現できていない。その形のフレームは修正の有無にかかわらず検出成功する。実測して直したのは 2026-08-06 追記分（AskUserQuestion の確認ステップ）のみ

- **wait: 未分類フレームの degraded 形 `ready`/`no_recent_output` を「完了」と誤報しなくなった** (#1708)
  - `isUnclassifiedActive` は `(running && default) || (ready && no_recent_output)` の 2 状態で立つ。後者は**読めないオーバーレイが劣化した姿**で（Auto-Yes ポーラが `lastServerResponseTimestamp` を打つと約 5 秒で反転、#1497）、完了ではない。停滞中の worker に `Completed` を返していたのは、Issue が問題視した timeout(124) より悪い（124 はパイプラインを止めるが 0 はマージまで進む）
  - フレームが読めない間は完了判定を抑止し、dwell は 2 状態をまたいで継続する。本物の完了 `ready`/`input_prompt` はフラグを立てないので従来どおり初回ポーリングで exit 0

### Added
- **hooks: 注入 settings に `permissions.deny` を追加し、パターン一括 kill を機構で塞ぐ** (#1739)
  - 2026-08-06、委任ワーカーが隔離サーバ 1 本を再起動するつもりで `pkill -f "node dist/server/server.js"` を実行し、**ユーザーの本番サーバ（port 3000）と global インスタンス（port 60301）を巻き込んで停止**させた。#1722 が全 Claude セッションへ注入している `--settings` に `"deny": ["Bash(pkill:*)","Bash(killall:*)","Bash(kill -9:*)"]` を同居させる
  - **この層でなければ止まらない。** `permissions.deny` は**ダイアログが存在する前に**拒否するので `PermissionRequest` が発火せず、**Auto-Yes に裁定の機会が来ない**。事故当時は実際にダイアログが出て Auto-Yes がそれを承認していた。契約文（対象ベースの禁止＝助言）と契約 `autoYes.denyPatterns`（人間へのエスカレーション）はどちらもすり抜けられている
  - **禁じるのは対象ではなく手段** — 3 ルールはいずれも「プロセスをパターンで選ぶ書き方」を指す。**PID 指定は従来どおり通る**（`kill "$(cat uat.pid)"` / `kill 4242` / `kill -TERM 4242`）。自分が起動したプロセスの止め方は docs/user-guide/agent-event-hooks.md §0.7 に明記した
  - **実測**（claude 2.1.223、docs/design/agent-hooks-permission-deny-verification.md）: 無条件 allow を返す `PermissionRequest` hook（＝現実の Auto-Yes より強い）を置いた状態で、deny 対象は **hook 0 回**で拒否され、承認が要る別コマンドでは同じ hook が**確かに 1 回発火して allow した**（空振り防止の対照実験）。`--settings` の権限は独立宛先 `flagSettings` に **Adding** され置換ではない。**deny は優先度が上の `settings.local.json` の `allow` にも勝つ**ためユーザー設定の `permissions.allow` で開け直せない。前方一致は**フラグまで含めて**照合されるので `Bash(kill -9:*)` は `kill <pid>` に当たらない。`cd x && …` / `… | cat` / `echo x; …` と合成しても拒否される
  - 危険なペイロードは一度も実行していない。実ルールは載せたまま、同じルール形の無害な stand-in（`sw_vers` = 素の前方一致、`uname -a` = フラグつき前方一致）で照合器を測っている
  - ロールバックは既存の `CM_AGENT_HOOKS_INJECT=0`（注入全体）。deny だけを外すスイッチは設けない — 構造化イベントごと失う方が「機構は入っているが黙って外されている」より事故を見つけやすい

- **verify: 実行契約に環境不変条件ゲート `env-clean` を追加し、リポジトリ外の副作用を裁定する** (#1740)
  - `scope` は `scope.allow` / `scope.deny` で**リポジトリ内のファイル変更**を裁定するが、プロセス・ポート・tmux セッション・`$HOME` を裁定する仕組みが 1 つも無かった。2026-08-06 の 4 件（本番サーバの停止 #1739 / `~/.commandmate-uat-1726` の放置 / 隔離サーバ 3779 の残存 / `~/.commandmate/hooks` の汚染 #1722）は**すべて `scope` を PASS する**。task 作成時にスナップショットを取り、検証時に差分を取る
  - スナップショット 4 項目: CommandMate 関連の TCP listener（`lsof` × `ps` で絞り、key は `tcp/<port>`）／`mcbd-*` tmux セッション／`$HOME` 直下／`~/.commandmate` 直下
  - **fail-open にしない（本ゲートで最も重要な設計判断）**: probe は `ok` / `unavailable` を必ず名乗り、**「取れなかった」を「空だった」に潰さない**。ベースライン不在、または片側の probe が `unavailable` なら **UNKNOWN**（gate `error` → run `failed`）で、決して `passed` にはならない。`skipped` も使わない（「判定すべき宣言が無かった」と読まれるため）。`lsof` の exit 1、tmux の `no server running`、`~/.commandmate` の ENOENT は**実測されたゼロ**なので `ok` として区別する
  - **偽陽性の抑制は非対称ルール**: 減ったものは誰のものであれ常に違反（#1739 / #1624）、増えたものは**他ワーカーに帰属できる場合だけ免除**。帰属は tmux がセッション名 `mcbd-<cli>-<worktreeId>`、listener がプロセスの cwd（自 worktree 配下＝自分 / **兄弟ディレクトリ＝他ワーカーとユーザの本番 checkout** / 不明＝厳しい側）。`$HOME` と `~/.commandmate` は所有者が無いので常に判定対象
  - **既定は無効**。`options.requireEnvClean`（verify.yaml、リポジトリ単位）と `success.requireEnvClean`（契約、委任単位）の **OR** で有効化し、両方省略時は**ゲート行も probe もベースラインファイルも一切生じない**。ベースラインの記録自体が opt-in に従うため、off の既定は副作用ゼロ
  - **未着地**: `success.requireEnvClean` は `TaskContractSuccess` / `SUCCESS_KEYS`（`src/lib/tasks/contract-parser.ts`、本委任の scope 外）が閉じた集合のため**契約 YAML にはまだ書けない**。parser 側 2 行で開き、検証側は resolver が `success` を構造的に読むので無改修で効く（挙動はテストで先に固定済み）。`verify.gates: [env-clean]` は `contract-message.ts` の 1 行、`commandmate status --json` のヘルスチェック拡張は `src/cli/commands/status.ts` が scope 外で未着手。詳細は docs/design/task-contract.md §2.6
- **detection: AskUserQuestion の選択肢を `PreToolUse` の payload から取り、`respond` を送信前に検証する（Phase 3）** (#1726)
  - 画面から regex で復元していた選択肢を、エージェント自身が送ってくる `tool_input` で置き換える。`PreToolUse`（matcher `AskUserQuestion`）を注入し、質問文・選択肢ラベル・**各選択肢の説明文**を受け取る。説明文は picker が独立した行に描くもので、scraper は継続行として捨てているため（そうしないと別の選択肢として解析される）**構造化でしか取れない情報**
  - **役割分担**: 画面が開いている／閉じたの**検出は scraper**（#1708 が担当）、開いていると判ったあとの**正確な選択肢の提供が本 Issue**。この記録は `sessionStatus` を一切決めず、#1725 の OR 合成にも #1723 の「scraper の `waiting` が常に勝つ」規則にも触れていない
  - **payload と画面は同じではない**（実測）。画面には payload に無い `Type something.` / `Chat about this` が付き、最終ステップは `1. Submit answers / 2. Cancel` に化ける。そこで選択肢は**位置で照合**し、1 つでも合わなければ**丸ごと諦めて scraper の解析結果を残す**。番号は常に画面のもの。「Review your answers」や確認ステップは照合が成立しないので自動的に対象外
  - **幻の選択肢に対する第 2 の防御**: payload が説明せず picker 既知の 2 つでもない選択肢は落とす。2026-08-06 に `7 tasks (0 done, 1 in progress, 6 open)` が「選択肢 7」として拾われた事故に対して、パネルの文言を知らなくても効く
  - **`respond` の送信前検証**: 範囲外の番号は `answer_out_of_range`（CLI exit **2**）で拒否、ラベル一致は番号へ解決（`respond <id> T5` → 選択肢 2）、不一致・曖昧は `unresolvable_answer` で拒否。`yes` / `no` は**必ず拒否**する — cursor 移動式の picker では打った文字は選択にならず、続く Enter が強調表示中の選択肢を選ぶため承認に化けうる（#1681）。構造化選択肢が無い場合（hooks 未設定・他ツール・照合不成立）は**従来どおり**
  - **Auto-Yes の面は広げていない**。`AskUserQuestion` は #1724 のまま常に no-decision で、画面ベース経路にも自動応答を追加していない
  - **実機検証**（v2.1.223 / production build / 隔離サーバ）: タスクパネル `6 tasks (0 done, 1 in progress, 5 open)` が出た状態の picker で、UI に正確な 3 選択肢＋説明文と picker 既知の 2 件が出て幻の選択肢は混入せず、`respond 99` は exit 2 で送信されず、`respond T5` が選択肢 2 に解決して完了した

- **detection: `PostToolUse` を解除 signal として採用（#1721 の「発火しない」を実測で訂正）** (#1726)
  - #1721 は `PostToolUse` を「登録済み・0 回」と記録していたが、matcher を `AskUserQuestion` に絞って実測すると**回答確定の直後に発火する**（2026-08-06: `PreToolUse` 15:36:04.112 → `PostToolUse` 15:36:28.643 → `Stop` 15:36:29.992）。payload は `tool_response.answers` に選ばれたラベルまで持つ。fixture を追加した
  - `Stop`＝「ターンが終わった」に対し `PostToolUse`＝「そのツール呼び出しが終わった」で、**「人間が答えた」に最も近い唯一のイベント**。回答後もエージェントが働き続けるケースでは `Stop` は数分後になる。`Stop` は取りこぼし用の backstop として併用する（hooks は全経路 fail-open）
  - あわせて #1725 の「ダイアログが開いている」状態も `PostToolUse` で解除するようにした（従来は `Stop` か scraper の観測待ち）
  - **`Notification(permission_prompt)` は AskUserQuestion でも発火する**（選択画面が出たまま約 6 秒後）。#1721 §5.6 の「表示中は無音」は計測窓の外で起きていた事象を取りこぼしており、「イベントが来た＝画面が閉じた」と読むと**機能が 6 秒で自分を消す**（実機で発生させて修正した）。§5.6 に訂正を追記

- **detection: プロンプト待ちを構造化イベントで検出する（`isPromptWaiting` / `wait` exit 10 / `capture --prompts`、Phase 2）** (#1725)
  - Claude が `Notification(notification_type=permission_prompt)` を出す承認ダイアログを、画面解析とは独立に「人間待ち」として publish する。#1708 の**元の報告事例そのもの**をイベント側から塞ぐ
  - **合成規則は OR**。`isPromptWaiting = scraper が見た || 構造化が見た`。`promptData` は scraper の解析済みプロンプトを優先し、無ければ縮退形（`type:'unclassified'`／options 空／エージェントの `message` を原文表示）を返す。片方の false がもう片方の true を打ち消さないのが要点で、構造化イベントが 1 件も出ない画面（AskUserQuestion の選択・確認、trust dialog、`/login`・`/model` overlay）は scraper だけが見えるため
  - **解除は実測にもとづく**: `Stop`（AskUserQuestion 回答確定後の発火を #1721 が実測）／`user_prompt_submit`／`session_start`・`session_end`（世代交代）／`notification(idle_prompt)`／**scraper がプロンプトの消滅を観測したとき**。ただし scraper の解除は**一度そのプロンプトを見た場合に限る** — 見えなかった層の沈黙を証拠に使うと、この機能が存在する理由そのものの状況で検出が消える
  - **`PostToolUse` は使っていない**。Issue 本文は解除条件の候補に挙げていたが、#1721 のスパイクで一度も観測されておらず、受信 route も lifecycle event に写像していない。実測のある `Stop` だけを採用した（**#1726 で訂正**: matcher を絞って実測すると発火する。#1726 が解除 signal として採用した）
  - **`Notification` の機械判断は `notification_type` のみ**（#1721 D3）。`message`（"Claude needs your permission"）は人間向け文言なので表示にだけ使う
  - Auto-Yes v2 が `PermissionRequest` を no-decision で返したときも「これからダイアログが出る」として記録する（`Notification` より約 6 秒早い）。ただしこれは観測ではなく**予測**なので、20 秒以内に `Notification` か scraper の裏取りが無ければ失効する。貼り付いた場合のコストは健全なセッションでの `wait` exit 10（ワーカーの誤停止）であり、それを避けるための期限
  - `wait --on-prompt agent` は構造化由来のプロンプトでも即 exit 10（#1708 の 60 秒 dwell を待たない）。`--on-prompt human` は従来どおり待機継続
  - `capture --prompts` に `[unclassified:hook-notification]` として残る。「エージェントは教えたのに検出層には見えなかった」は `[unclassified:detection-failed]`（誰も見えなかった）と別の事実なので区別して表示する。**scraper がプロンプトを publish した回には書かない**（既存の記録者と二重計上になる）
  - PromptPanel は選択肢の無い縮退プロンプトを操作 UI 無しで表示し、「**番号で**応答する」よう案内する（`respond <id> yes` は番号つきダイアログでは Enter=既定選択に化ける＝#1681）。文言は `locales/{en,ja}/prompt.json`
  - **スコープ外（構造化イベントが存在しないため原理的に不可能）**: AskUserQuestion の選択・確認画面。#1721 の実測で、表示中・回答操作中とも hooks の受信件数は 23 → 23 で 1 件も発火しない。この画面の検出は scraper 側（#1708 / #1726）に残る。起票時の受入基準のうち当該項目は撤回済み
  - 実機検証（Claude Code v2.1.223 / 隔離 DB・別ポートの production サーバ）: 承認ダイアログで `PermissionRequest`(13:12:53) → `Notification(permission_prompt)`(13:12:59) が到着し `promptWaitingSince` は前者の時刻＝予測が観測に昇格しても「人間が止まった時刻」を保つ。`wait --on-prompt agent` は exit 10。ダイアログに応答すると `Stop` を待たずに解除された（**scraper 観測による解除が実際に効いた**）。scraper が何も見ていない状態に実 payload を投函すると `waiting`/`hook_permission_prompt` ＋ 縮退 promptData ＋ `wait` exit 10（type=`unclassified`）となり、日英両 locale で PromptPanel の縮退表示を確認

- **auto-yes: Claude の承認を `PermissionRequest` hook で構造化裁定する（Auto-Yes v2 / Phase 2）** (#1724)
  - 画面を regex で読んでキーを注入する代わりに、Claude が**ダイアログを描く前に**同期 POST してくる `PermissionRequest` を裁く。新設 `POST /api/hooks/permission-request`（`/api/hooks/agent-event` は 202 の fire-and-forget で性格が逆なので分離）
  - 裁定: 未 parse → no-decision ／ `AskUserQuestion` → 常に no-decision（#1726 の担当。`allow` を返しても選択画面は出るので突破もできない）／ Auto-Yes 無効・期限切れ → no-decision ／ 契約ポリシー抑止 → no-decision ＋ `lastSuppression` 記録 ／ それ以外 → `allow`
  - **`deny` は返さない**。現行 Auto-Yes の抑止は「自動応答しない」であって「拒否する」ではなく、deny 化はフィールドにある既存契約の意味を変える
  - **判定不能は必ず no-decision**。空応答 `{}` は TUI ダイアログにフォールバックする（#1721 D5 の実測）ので、fail-safe 側が「現状維持」になる。誤 allow はコマンド実行を意味するため、この非対称性が全分岐の設計原則
  - **#1699 の scrollback 汚染は構造的に起きない**: denyPatterns の照合対象は当該リクエストの `tool_input` のみ（Bash は command＋description、他ツールは主要引数、未知ツール／想定外 shape は input 全体へ fail-safe）。画面もスクロールバックも入力に無い。「一度 allow した `rm -rf` が以後の無関係な承認を抑止しない」ことを直接テストで固定した
  - ポリシー評価は poller と `evaluatePolicyAgainstTexts()` を共有し、promptType は `multiple_choice`（画面上の承認ダイアログの分類）。**hook が poller より緩くなる余地を作らない**ためで、`mode: safe` は hook 側でも抑止する
  - 相関は **`prompt_id` + `tool_name` + `tool_input`**。実 payload に `tool_use_id` は無く、公式ドキュメントの `permission_requirements` も無い（#1721 D2。代わりに `permission_suggestions`）。応答スキーマとリクエスト形は `tests/fixtures/hooks/claude/permission-request*.json` の実データに突合している
  - **allow のときだけ** prompt 履歴に answered 行を作る（ダイアログが出ない＝他に記録者が居ない）。no-decision 側は画面経路が従来どおり記録するので二重にならない。`pending` 行を作らないのは `recordAnsweredPrompt` が人間の応答をその行に刻んでしまうため
  - hook は **Auto-Yes トグルと独立に常時注入**（注入は起動時 1 回きり、Auto-Yes は途中で入る）。timeout 5 秒（http の既定は 600 秒で `async` も無い）。応答時間を毎回ログし 500ms 超で warn
  - **画面ベース Auto-Yes 経路（`detectPrompt` 直呼び）は削除も変更もしていない** — hooks 非対応環境と Claude 以外のフォールバック

- **detection: 構造化イベントを `sessionStatus` 判定に優先適用する 2 層化** (#1723)
  - #1722 で届くようになった hooks イベントを第一級ソースに昇格した。`user_prompt_submit` → `running`/`hook_prompt_submit`、`stop` → `ready`/`hook_stop`。イベントが届く環境では「thinking/ready の regex 誤判定」（#805 / #1150 / #1154 / #1497）が**判定の根拠ごと**消える
  - **`detectSessionStatus()` は 1 文字も触っていない**。merge は builder 層（`mergeStructuredStatus()`）に置いた。検出器は端末フレームの純粋関数のままで、#1708 の回帰テストを含む fixture 資産がそのまま効く
  - **scraper が `waiting` のときは常に scraper が勝つ**。AskUserQuestion の選択画面と「Ready to submit your answers?」確認画面では hooks が 1 件も発火しない（#1721 §5.6 実測）ため、その画面での最新の構造化事実は turn 冒頭の `user_prompt_submit`＝`running` になる。上書きしていたら #1708 の停滞をそのまま再現していた
  - **`notification(permission_prompt)` は記録のみで適用しない**。`isPromptWaiting` / `promptData` / `isSelectionListActive` は本 Issue では scraper のまま（#1725 の担当）。加えて「プロンプトが回答された」ことを示すイベントが存在しないので、適用すると次の `Stop` まで `waiting` が貼り付く
  - **信頼範囲を 3 つで縛る**: 世代（`startClaudeSession()` の新規作成パスと `session_start` イベントで切る。key を再作成セッションが再利用するため、無いと前プロセスのイベントが新セッションの判定になる）／齢（30 分。hooks は全経路 fail-open なので `Stop` が届かない事故がありえ、無制限だと `wait` が `--timeout` まで回る）／生存（tmux セッションが無ければ従来どおり `session_not_running`）
  - `isUnclassifiedActive` は**構造化 `ready` × scraper `running` のときだけ** false にする。`wait` の完了条件が `ready && isUnclassifiedActive !== true` なので、ここを落とさないと構造化 `ready` は何も変えない。逆向き（構造化 `running`）では立てたまま残す — イベントを出さない画面に対する exit 10 の最後の逃げ道と、`/help` オーバーレイのナビゲーションハッチ（#1497）を潰さないため
  - 乖離は `logger.info('detection-divergence')` を 1 行（両判定＋`applied`）。一致時は無言。scraper がどれだけ間違っていたかを実地データで定量化する材料で、**適用しなかった食い違いも残す**（後続 Issue の判断材料）
  - **`wait` と Auto-Yes ポーラーは 1 行も変えていない**。どちらも current-output 経由で状態を読むため恩恵が自動的に届く。統合テストで「同じキャプチャに `Stop` を投げると `wait` が exit 0 になり、投げなければ待ち続ける」対照を固定した
  - **未設定環境の非影響**: イベントが 1 件も無ければ `getStructuredSessionState()` が null を返し `mergeStructuredStatus()` が scraper をそのまま返す。既存テストは無変更で全緑
- **wait: 分類できない対話フレームが 60 秒続いたら停止事由にする** (#1708)
  - `isUnclassifiedActive` は #1120 以降ペイロードに載っていたが `CurrentOutputResponse` に型が無く、`wait` は一度も読んでいなかった。検出をすり抜けたダイアログは「何も起きていない」扱いで `--timeout` まで放置される
  - **新しい exit code は作らない**。既存の exit 10 に `type: 'unclassified'` を載せる（#1628 の `selection_list` と同じ前例。新設すると既存の 10 分岐がインフラ障害と読む）。`--on-prompt human` では待機を継続する
  - 瞬間値では止めない（再描画中のキャプチャで 1 回だけ立つことがある）。分類できた時点で滞留カウンタはリセットされる
  - dwell は定数でフラグを持たない。`--timeout` / `--stall-timeout` が 60 秒未満なら常にそちらが勝つ（長い待ちを先回りするための仕組みで、短い待ちを延ばすものではない）
- **capture --prompts: 検出できなかったフレームも監査証跡に残す** (#1708)
  - 書き込み口が 2 つとも `isPrompt === true` でゲートされていたため、検出漏れはどこにも残らなかった（900 秒停止した worker に対して `No prompt history.` を返していた）
  - `[unclassified:detection-failed]` として**検出できたプロンプトと区別して**表示する。滞留中に行が増えることはない（1 停滞につき 1 行）
  - `status` を `pending` にしないことで `markPendingPromptsAsAnswered()` の掃引対象から外している。誰も読めなかったフレームに「回答済み」は付かない
  - **記録は観測駆動**（`wait` のポーリング／ブラウザ／`capture --json`）。サーバ側 Auto-Yes ポーラ単独では書かれない
- **send: プロンプト待ちのセッションへの送信を拒否する** (#1708)
  - ダイアログ表示中のキー入力はエージェントに届かず入力欄に溜まるだけで、後続の `respond` が残留テキストごと「メッセージ」として送られる危険がある（停滞 worker への nudge が状態を悪化させた実例）
  - 409 `PROMPT_WAITING` / CLI は exit 2。**`respond` / 特殊キー / `prompt-response` は拒否しない**（塞ぐと回答手段が無くなる）
  - ガードは送信サービス層（`sendUserMessage`）に置いたので、**タイマー送信も同じく拒否される**（`[prompt_waiting] …` を失敗理由として記録）。ルート層に置くとスケジュール送信がダイアログへ直撃したままだった
  - 拒否が効くのは**検出できているときだけ**。すり抜けたフレームは上記 `wait` の `unclassified` が受け持つ。ペインが読めないときは fail-open するので、**取りこぼしを減らすガードであって保証ではない**
- **hooks: Claude セッション起動時の hooks 自動注入と instance 相関・イベント語彙拡張** (#1722)
  - `src/lib/hooks/hook-settings-generator.ts` — (worktreeId, instanceId) ごとの hooks 設定を生成し `claude --settings <file>` で渡す。#1549 で作った受け口・サービス・状態・中継スクリプトの拡張であり、新規に作り直していない。**構造化イベントが「設定した人の環境にしか存在しない」制約が解消**された
  - **`SessionStart` だけ `type:"command"`**。Claude Code は `SessionStart` の http hook を**黙って skip する**（#1721 D1。debug ログにしか出ず stdout / TUI は無音）。本実装でも実機で反証を取った — http で組んだ対照セッションは `Skipping HTTP hook … not supported for SessionStart` を出し配送 0 件、TUI には何も出ない。残る 4 イベント（`UserPromptSubmit` / `Stop` / `Notification` / `SessionEnd`）は http
  - **instance 相関**。`cwd` は worktree は特定できるがインスタンスは特定できない（同一 worktree の `claude` と `claude-2` は cwd が同じ）ため、注入 URL に `worktreeId` / `instanceId` を焼き込む。`route.ts` の `applyAgentStopEvent(db, worktree, tool, tool)` primary 固定を解消した。**`session_id` は相関キーにしない** — `/clear` は `SessionEnd(reason=clear)` → `SessionStart(source=clear)` を発火し `session_id` が変わる（実機で確認）
  - 受け口が **Claude のネイティブ payload も受ける**ようになった。`type:"http"` はボディを加工できないため。型とテストは `tests/fixtures/hooks/claude/*.json`（#1721 の実採取 12 件）に合わせてある。イベント語彙に `user_prompt_submit` / `session_end` を追加し、`Notification` は `notification_type`（`message` ではない）をサブタイプとして保持する
  - **手動設定との共存**を実測で確定した。`--settings` の hooks はユーザー設定と**連結**されるので #1549 の手動 Stop hook を残していると同じターンが 2 回届き、`lastStopEventAt` は冪等でも `task_events` の `agent_idle` は 2 行になる。`(worktree, tool, instance, event, sessionId)` が一致するイベントを 3 秒以内は 1 回として扱う。`sessionId` を持たない呼び出しは畳まない（区別材料が無く、重複を許すほうが実イベント取りこぼしより安い）
  - `headers` の `$CM_AUTH_TOKEN` は `allowedEnvVars` 併記がないと展開されない（#1721 D7）ため、生成器は常に対で出力する。実機で `Bearer live-1722-token` に展開されることを確認した
  - **観測のみ**。`structuredEvents`（`lastEventType` / `lastEventAt` / `lastEventDetail`）を `current-output` に露出するだけで、`sessionStatus` / `wait` / Auto-Yes の判定には一切入れていない（#1723 の担当）。**hook 到着を起動完了の signal にもしない** — 未 trust ディレクトリでは trust ダイアログに答えるまで `SessionStart` すら来ない（本実装の実機検証でも再現）
  - ロールバックは `CM_AGENT_HOOKS_INJECT=0`（起動コマンドが #1722 以前と完全に同一になる）。`~/.claude/settings.json` は書き換えない（実機で before/after の sha256 一致を確認）
  - 実機検証: 隔離 tmux socket ＋ 使い捨てダンプサーバで 5 イベントすべての配送を確認し、**採取した実バイト列を本番 route に流し直して** 202・`claude-2` への帰属・primary 非汚染まで検証した
- **detection: Claude Code hooks の実機検証レポートと実 payload fixture** (#1721)
  - `docs/design/agent-hooks-live-verification.md` — Epic #1720 の全下流 Issue が前提にする hooks の挙動を v2.1.223 で実測した。隔離 HOME ＋ 専用 tmux socket ＋ 使い捨てダンプサーバで再現可能な形にしてある。コード変更なし（スパイク）
  - `tests/fixtures/hooks/claude/*.json` — `PermissionRequest` / `PreToolUse(AskUserQuestion)` / `Notification(permission_prompt, idle_prompt)` / `Stop` / `UserPromptSubmit` / `SessionStart` / `SessionEnd` の実 payload 12 件。環境固有値はプレースホルダに置換済み
  - **公式ドキュメントとの食い違いを 3 件検出**した。(1) `SessionStart` では `type:"http"` が**黙って skip される**（debug ログにしか出ない。`type:"command"` 必須）、(2) `PermissionRequest` の実 payload には `permission_requirements` も `tool_use_id` も無く、代わりに `permission_suggestions` が入る、(3) TUI で承認を拒否しても `PermissionDenied` は発火しない
  - **Auto-Yes v2 (#1724) の安全性の根拠を実測で固定**した。hook が空応答を返すと従来どおり TUI 承認ダイアログにフォールバックし、timeout も接続不能もすべて fail-open。一方 `AskUserQuestion` は `allow` を返しても選択画面が出るため、一律 allow では突破できない
- **detection: 実 TUI カナリアで Claude 新バージョンの検出回帰を検知する** (#1727)
  - `npm run canary` で実 `claude` を使い捨て tmux セッションに起動し、5 シナリオ（idle / 許可ダイアログ / AskUserQuestion＋タスクパネル併存 / `/model` オーバーレイ / 生成中）の capture を**本番と同じ 2 経路**に食わせて assert する。ステータス経路（`detectSessionStatus`）と Auto-Yes 経路（`detectPrompt` 直呼び）を**独立に**検証する — #1495 は Auto-Yes 側だけで発火した欠陥だった
  - **隔離を仕組みで強制**。tmux は全呼び出しが `-L cmate-canary-*` を経由し、`kill-server` は専用メソッド以外から到達できない（`-L` 無しの `kill-server` が稼働中の全 `mcbd-*` を消した前例がある）。HOME は使い捨てにしたうえで `show-environment` で**転送されたことを assert** し、実 `~/.claude/settings.json` の sha256 と `mcbd-*` 一覧を各シナリオの前後で再検証する（違反は exit 3）
  - **ハーネス自身の非空振りを `--mutate` で証明する**。各シナリオが持つ「もっともらしいが誤った期待値」で走らせ、全部赤にならなければ自己テスト失敗として扱う（実測 5/5 赤）
  - **上流障害と検出回帰を区別する**。`529 Overloaded · Retrying in …` が写っている間は最大 180 秒シナリオの時計を止め、到達できなければ `blocked`（exit 4）として報告する。判定パターンは「usage limit reached」等のエラー文言に限定した — 単に `usage limit` を見る実装は Claude の販促バナー（"weekly usage limit on Fable 5"）に誤爆し、緑の実行を全件 blocked にした
  - 各シナリオの実フレームを `tests/fixtures/canary/` に毎回保存するので、赤が出たときは**新バージョンの実キャプチャがそのまま修正用 fixture** になる。純関数部分は `tests/unit/canary/` が commit 済み fixture で固定し、CI では tmux も課金も不要
  - claude 2.1.223 で 5 シナリオ緑（約 29 秒）。手順・費用の目安・CI 組み込み案 A/B は [docs/qa/detection-canary.md](docs/qa/detection-canary.md)

## [0.21.5] - 2026-08-06

> **Highlight**: スラッシュコマンドカタログのリコンサイルを「運用として成立する」状態にした（Epic #1707）。従来はリコンサイルツールが**過去に人間が何を除外したかを知らない**ため、同じ 3 件を毎リリース提案し続け、適用するとガードテストが赤くなり、人間が過去 Issue を読み直して手で消す、というループになっていた。除外判断をデータ化したことで提案は **3 件 → 1 件**に減り、残る 1 件は「未決の判断が存在する」という正しい signal として機能する。あわせて、`--write` が必ず生成する `[要レビュー]` プレースホルダの流出をテストで止め、ドリフトの週次検知と手順の skill 化を入れた。

### Added

- **slash-commands: カタログのドリフトを週次で検知し単一の追跡 Issue に集約** (#1705)
  - 週次 cron（`workflow_dispatch` でも手動起動可）で `catalog:refresh --check` を実行し、結果を 1 本の追跡 Issue に集約する。#1503 以降リコンサイルされず 104 件まで溜まった原因は「誰も `--check` を打っていなかった」ことで、3 件のうちに気づけば 10 分で終わる作業だった
  - **exit code では判定しない。** `--check` はドリフトがあっても exit 0 を返すため（106 件検出時も exit 0）、`check-report.ts` が**出力をパース**して drift / clean / inconclusive を判定する
  - **「0 件」と「調べられなかった」を区別する。** ソース到達不能時は fail-soft で exit 0 になるため、これを健全と読むと上流が落ちている間ずっと緑になる。警告は allowlist 方式で、`antigravity provider not implemented yet` のみ既知状態として無視し、他はすべて inconclusive とする
  - 毎週新規 Issue を作らず 1 本を更新・再 open し、clean かつ警告なしのときだけ close する。権限は `issues: write` のみで、誰の PR も止めない

- **skills: `/catalog-reconcile` skill** (#1706)
  - v0.21.2 のリコンサイルで実行者がその場で発見した手順を固定した。規模による別 PR 切り出しの判断、翻訳の文体規約、説明衝突の解消、上流ソースでの裏取り、ガードテストの更新範囲、品質ゲートの実測方法を含む
  - 実測に基づく注意（primary checkout で `npm run build` を実行しない／件数の数え方が claude と codex で述語が違う／説明に `<...>` を含めない／`--check` は exit 0 を返す）も明記

### Changed

- **slash-commands: カタログの除外判断をデータ化し、説明衝突をツール別に保持** (#1704)
  - `src/config/slash-commands-exclusions.json` を新設し、reconcile engine が**既定で**尊重する（`options.exclusions` を渡し忘れてもガードが効く）。除外の意思はこれまでガードテストのアサーションにしか無く、ツールから参照できなかった
  - **`kind` を `phantom` / `out-of-scope` の 2 値で型分離**した。前者は上流が変われば自動的に決着し、後者は人間の再判断でしか消えない。再判断コストが桁違いなので `reason` の散文に混ぜない
  - **`cliTools` 必須で名前一括禁止を表現できない**ようにした。v0.21.2 で `/vim` の禁止を「名前」から「claude」へ狭めた実例があり、名前で禁止すると codex 0.146.0 の実在コマンドを隠す
  - `descriptionKey` を name 由来の固定値ではなく**上書き可能**にし、同一 pass 内で tool 間の en が食い違ったら `slashCommands.descriptions.<name>.<tool>` へ**両側とも**分割する。前リリースで翻訳済みのキーは分割せず報告のみ（分割すると人手 ja 訳を代替なしに孤児化するため）
  - これに伴い #1603 の「衝突時は中立 placeholder に落とす」を変更した。**その placeholder 動作こそが v0.21.2 でパレットに `/btw — btw` を出した欠陥**であり、「どちらの文も共有キーに載せない」という不変条件は維持したままキーを分けて両方の文を残す形にした

### Fixed

- **slash-commands: 未翻訳の `[要レビュー]` プレースホルダ流出をテストで止める** (#1703)
  - `catalog:refresh --write` は新規 ja description を必ず `[要レビュー]` プレースホルダ（中身は英文）で埋めるが、**この状態で lint / tsc / test:unit はすべて緑**だった。v0.21.2 では人手で diff を読んで初めて 86 件に気づいた
  - 既存の #1306 ガードは en / ja 両方にキーが存在することを検証するが、**キーは存在する**ので通ってしまい、中身が未翻訳であることは誰も見ていなかった
  - `JA_REVIEW_PREFIX` を export し `hasReviewMarker()` を追加して**生成側とガード側で同じ定数を参照する**ようにした（将来マーカーを変えてもガードが黙って無効化されない）。ガードは locale 名前空間全体を走査し、失敗時は残存キーを列挙する

## [0.21.4] - 2026-08-06

> **Highlight**: Worktree の Skills ペインで、Catalog セクションのカードが **skill ID の一致だけ**でバッジを決めていたため、数バージョン遅れた導入でも単に `Installed` と表示していた。同じ画面の上のセクションは `Update available` を出しており、同一 Skill に相反する状態語が並んでいた。判定を 1 箇所に集約し、両セクションが同じ結果を読む形にして解消した。

### Fixed

- **skills: カタログカードのバッジを導入版とカタログ版の比較で出し分ける** (#1712)
  - 判定を `updateAvailableById` に**一本化**し、導入済み行と Catalog カードの**両方が同じ Map を読む**ようにした。2 箇所が別々に比較する構造自体を無くしたので、**表記の食い違いが構造的に起きない**
  - 比較は既存の `hasSkillUpdate`（受領版 vs catalog latest）を**そのまま再利用**。新しい比較関数は追加していない（判定が 2 系統に割れると、また食い違うため）
  - Catalog カードのバッジは **未導入=バッジなし / 旧版=`Update available` / 最新=`Installed`** の 3 状態になった
  - バッジの裏付けとなる数値が 1 つも表示されていなかった Catalog カードに **catalog latest を表示**した
  - 文言は既存の `worktreePane.updateBadge` / `installedBadge` / `version` を再利用したため i18n の追加は不要。2 セクションが同一キーを使う

## [0.21.3] - 2026-08-06

> **Highlight**: install した Skill が、サービスを起動しているインスタンス／端末が異なると未インストール扱いになっていた。インストールの真実は worktree 内の receipt にありリポジトリ相対で正しく共有されるが、Skill 一覧 API は DB 単位の索引しか読んでおらず、**キャッシュを真実として扱っていた**ため「未インストール」と「未索引」を区別できなかった。一覧 API を索引の read-through キャッシュにして解消した。

### Fixed

- **skills: Skill 一覧 API を索引の read-through キャッシュにする** (#1709)
  - `GET /api/worktrees/<id>/skills` が応答前に対象 worktree の install root から receipt を読み、索引に行が無いものを復元してから返すようにした。別インスタンス・別端末・DB 再作成のいずれでも、再起動も手動操作もなしに導入済み Skill が見えるようになる
  - 復元は**欠落分のみ**（`prune: false`／索引済み行は書き換えない）。読み取り経路が索引を prune すると、別の書き手と競合したときに正しい行を消しかねないため
  - **索引済み Skill の receipt は開かない**（`collectReceipts` の accept filter）。索引が完備な worktree の追加コストは root ごとの `readdir` のみで、一覧が「安い読み取り」である性質を保つ
  - **復元の失敗は warn ログのみで読み取りを継続する**（修復の失敗が読み取りを落とさない）
  - 復元したときだけ `invalidateSkillStatusScanCache()` を呼ぶ。ダッシュボードの 5 秒キャッシュが復元済みの install を `unmanaged` のまま出さないため
  - receipt が無い・壊れている・他 Skill 宛の payload は従来どおり索引せず `unmanaged` に留める（裏付けの無い provenance を主張しない）
  - 複数 root（#1460）は receipt の `install_roots` をそのまま採用する
  - 全件版 API（`POST /api/skills/reindex`）の挙動は変更なし

## [0.21.2] - 2026-08-05

> **Highlight**: スラッシュコマンドのカタログを各 CLI の権威ソースへリコンサイルした。#1503 以降更新されておらず、カタログ 56 件に対して実コマンドが 104 件不足していた（パレットに出ないだけで実害は小さいが、放置するほど一度に流し込む量が増えレビュー不能になる）。機械が決められない 3 点 — ja 訳 86 件がプレースホルダ、claude と codex で説明が食い違う 6 件、過去に意図的に除外したものの再混入 — を人手でレビューして確定した。

### Changed

- **slash-commands: カタログを claude docs / codex 0.146.0 へリコンサイル** (#1489)
  - 実在コマンド 104 件を追加（56 → 159）。claude 97 件 / codex 53 件 / opencode 10 件 / antigravity 13 件
  - ja 訳 86 件を全件翻訳。`catalog:refresh --write` は `[要レビュー]` プレフィックス付きの英文プレースホルダを生成するため、そのまま出すと利用者に英文と作業マーカーが見える
  - claude と codex が同名で別の説明を持つ 6 件（`/btw` `/copy` `/ide` `/rename` `/stop` `/theme`）は descriptionKey を共有するため、ツールは説明をコマンド名そのものに落としていた（`/btw — btw`）。両ツールの意味を含む 1 文へ書き直し、codex 由来の小文字断片 21 件も既存の文体へ正規化した
  - **過去の curation 判断の再混入を除去**（リコンサイルツールは除外の履歴を知らない）: `/ultraplan`（claude docs の説明が "Removed" マーカー。#1502 / #1503 で除去した幻コマンドと同型）、`/schedule`（#1488 で対象外と判断済み）、`/agents` の claude entry（#1503 が除去した "(removed)" スタブ）
  - `/vim` の禁止を「名前で禁止」から「claude に出さない」へ狭めた。codex 0.146.0 の `codex-rs/tui/src/slash_command.rs` が `SlashCommand::Vim => "toggle Vim mode for the composer"` を宣言しており、名前で禁じると実在する codex コマンドを隠すため
  - `/sandbox-add-read-dir` の説明が `<absolute_path>` を含み、説明の安全ガード（`/<[^>]+>/`）に掛かっていたため角括弧表記へ変更
  - `verifiedAgainst.codex`: 0.144.6 → 0.146.0

## [0.21.1] - 2026-08-05

> **Highlight**: 契約の `autoYes.denyPatterns` が、そのプロンプトとは無関係な**既に承認済みの過去のコマンド**にマッチし続け、以後のプロンプトを恒久的に抑止していた。照合面が「今このプロンプトが何を承認しようとしているか」ではなく「直近の画面に何が映っているか」だったためで、一度 `rm -rf` を承認すると、その行がペインから流れ出るまで無関係な編集確認まで止まり続けた。実運用では並列委任のワーカー 2 台が停止し、片方は約 1 時間 1 行も書けていない。判定用の `approvalTarget` を表示用の `instructionText` から分離して解決した。

### Fixed

- **auto-yes: deny pattern の照合面を現在のプロンプトに限定** (#1699)
  - `collectDenyMatchTexts()` の照合面を `promptData.instructionText` から新設の `approvalTarget` へ変更した。`instructionText` は**人間が文脈を読むためのペイン窓**（multiple_choice は質問行の 19 行上から、yes_no はペイン末尾 20 行まるごと）であり、過去のターンのコマンドとその出力を日常的に含む。これを判定入力にしていたことが、承認済みコマンドによる恒久抑止の原因だった
  - `instructionText` は表示用（`PromptPanel` / `MobilePromptSheet`）としてそのまま維持する。**判定面と表示面を分離**したので、人間向けの文脈情報は削られていない
  - `findApprovalContextStart()` が質問行から上へ走査し、**直前ターンの transcript マーカー**（`⏺⎿●○•✔✓✖✗✘›»❯└├>` 始まり・区切り線）の直下を上端とする。マーカーが射程内に無い場合のみ `APPROVAL_TARGET_MAX_LOOKBACK=12` で打ち切る。`stripBoxDrawing()` が枠線（`╭──╮`）も枠内の空行（`│  │`）も等しく空行へ潰すため、**空行では panel の上端を判定できない**ことが実測で判明したことによる
  - yes_no 経路も同時に修正した。`instructionText: rawContent`（ペイン末尾 20 行）は multiple_choice より広く、片方だけの修正では穴が残る
  - `approvalTarget` を持たない旧データ（DB から再生された古い行）は question ＋選択肢ラベルのみで判定される
  - **抑止の可視化**: `commandmate wait` が `--on-prompt human` の待機ループで抑止の reason / mode / promptType / pattern を stderr に出し、agent モードでは exit 10 の payload に `autoYesSuppression` と `approvalTarget` を載せる。従来は "Waiting for human response" しか出ず、正常な待機と抑止による停止を区別できなかった（これが発見を遅らせた）
  - CLI ミラー追従: `src/cli/types/api-responses.ts` と `capture --prompts` の whitelist に `approvalTarget` を追加

## [0.21.0] - 2026-08-05

> **Highlight**: 導入済み Skill を GUI / CLI から**更新**できるようになった。これまで update の手段が無く、一度 uninstall してから install し直す（間に Skill 不在の窓が空き、確認も履歴も 2 回に割れる）しかなかった。#1243 が old receipt / 現行 filesystem / candidate artifact の 3-way 差分と local 変更 guard を備えた update plan を提供し、#1244 がその plan を入力に、同一 filesystem の rename 1 点を commit point として old→new を切り替える（失敗しても旧版・新版が混在しない）。あわせて実運用フィードバック #1678 のうち CommandMate 側 6 件（`commandmate sync` の新設、`respond yes/no` の誤承認修正、scope 違反 path の表示、Auto-Yes 抑止の可視化、プロンプト監査証跡、discoverability 原則の明文化）を反映した。

### Added

- **Skills: local 変更 guard つき atomic Skill update（apply）** (#1244)
  - `POST /api/worktrees/[id]/skills/[skillId]/update` を追加。#1243 の update plan が固定した old receipt / old tree / new package / new receipt exact bytes / branch / HEAD / expiry を apply 入力として確定させ、plan token を単回消費して導入済み Skill を新 exact version へ切り替える
  - **local 変更があれば 1 件でも zero-write で拒否**（`SKILL_UPDATE_LOCAL_CHANGES`）。modified / unknown / missing / irregular を uninstall guard で適用直前に再検査し、receipt digest・tree hash が plan の binding と一致しない場合も `SKILL_UPDATE_DRIFT` / `SKILL_PLAN_STALE` で旧版・新版のどちらも書き換えない
  - **old→new の commit point を 1 点に定義**: new payload は install と同じ staging primitive（`O_EXCL|O_NOFOLLOW` write・digest/mode 再検証・tree hash gate・same-filesystem 検査）で destination と同一 filesystem の worktree-local staging へ materialize し、root ごとに「旧 directory を aside へ rename → staging を publish rename」の 2 段で切り替える。**primary root の publish rename が唯一の commit point**で、それ以前の失敗は in-process で aside を戻して worktree を 1 byte も変えず、それ以後の失敗は新 receipt から前方収束のみ（旧版・新版が混在した状態にならない）
  - `.agents/skills` と `.claude/skills` の**両 root を 1 つの journaled operation として扱う**（#1460）。secondary root の切替が失敗した場合は committed primary から前方収束させ（`completeSecondarySkillUpdateRoots`）、local 変更のある secondary は上書きせず skip として報告する
  - **journal replay 契約（#1552）に `update` の述語を追加**: 「commit を主張する entry の主張が今も真か」を new receipt の実在＋digest 一致で判定する `mayReplaySkillUpdate` を定義し、rollback や再 install で receipt が入れ替わった worktree に対して古い outcome を replay しない。起動時 reconciliation は crash 収束（aside の復元 / 完全検証済み staging の採用）を経てから commit 有無を答える
  - 切替前に **old payload を digest 検証つきで service-owned root（`~/.commandmate/skills/backups/<operationId>/`）へ退避**する。リポジトリ内には置かない。retention と復元操作は #1245 の verified backup 契約へ引き渡すインターフェイス境界のみを定義する
  - operation audit に source（origin/repository/ref/commit/artifact sha256）・old version・new version・actor・result を記録（`skill_operations.from_version` / `to_version`）。token・signed URL・絶対 path は通常 log にも error にも含めない
  - update だけで script / hook を実行しない（archive 由来の mode も honour しない）
  - UI: `SkillUpdateDialog` に適用ボタンを追加。updatable な plan にのみ表示し、high-risk 候補と risk 上昇はそれぞれ独立した同意 checkbox を必須にする（fail closed）。適用後は次アクション・Agent reload 案内・rollback 可否（保存済み backup の旧 version）を表示
  - CLI: `commandmate skill update <skill-id> --worktree <id> [--version <v>] [--range <r>] [--dry-run] [--yes] [--ack-risk <id>@<version>] [--ack-risk-increase] [--json]` を追加。非TTY は `--yes` 必須、high-risk は `--ack-risk`、risk 上昇は `--ack-risk-increase` を追加で要求し、blocked は exit 11 / 未確認は exit 12 / committed_reconciling は exit 13
  - rollback 操作・backup retention UI（#1245）、複数 version 連続 skip policy・自動 commit/PR・external source は非対象

- **Skills: 更新検知・version 選択・更新差分・local 変更 guard（update plan）** (#1243)
  - `POST /api/worktrees/[id]/skills/[skillId]/update-plan` を追加。installed exact version は on-disk receipt から読み、Catalog の候補 version（installed より厳密に新しい exact version のみ。stable/prerelease opt-in・`range` filter・CommandMate 互換性判定つき）へ解決し、candidate artifact を install と同一の source/checksum/archive 検証（#1229/#1230）に通したうえで、current receipt / 現行 filesystem / candidate artifact の 3-way inventory を返す
  - add/update/remove/unchanged の file diff（unified diff 本文つき）と、risk（declared/computed/effective）・permissions・scripts/executables・requirements・changelog・Agent 互換性の security diff を 1 つの plan で提示。effective risk が上がる更新は通常確認とは別の追加確認を要求する契約（`riskIncreased`）を返す
  - modified / unknown / missing / irregular な path が 1 件でもあれば `SKILL_UPDATE_LOCAL_CHANGES` として update 不可（fail closed）。receipt の `install_roots` に記録された全 root（`.agents/skills` / `.claude/skills`）を検査し、root 間で receipt が食い違う install も拒否する
  - plan は #1233 と同じ server-side token 契約（TTL 10 分・single-use・LRU）で candidate artifact / current tree / branch / HEAD を固定し、apply（#1244）時の drift は `SKILL_PLAN_STALE`（409）で拒否される consume API を提供
  - UI: worktree 詳細 Skills pane の導入済み一覧に update badge、詳細ビューに version picker・更新差分・block 理由と解決手順を一画面表示する `SkillUpdateDialog` を追加（plan-only、apply ボタンなし）
  - CLI: `commandmate skill update-plan <skill-id> --worktree <id> [--version <v>] [--range <r>] [--prerelease] [--json]` を追加（blocked 時 exit 11）
  - update の apply・rollback は非対象（#1244 / #1245 の範囲）

- **設計原則文書: 判定の可観測性（discoverability 原則）を明文化** (#1686): 「サーバー側が下した判定・抑止・自動アクションは、理由コードつきで運用者が読む層（`capture --json` / `wait` / `task show`）に露出する」を `docs/design/discoverability-principle.md` として明文化し、既存判定点の棚卸し（露出済み: #1682〜#1685・skills#47 / 未露出の対応候補: stop-pattern のマッチ内容、プロンプト dedup スキップ）を記録した。あわせて cli-operations-guide.md に無人実行の推奨契約テンプレートを掲載し、誤用されやすいフラグ（`wait --on-prompt` / `send --auto-yes`）の `--help` にクロスリファレンスを追記、設計レビュー（/multi-stage-design-review Stage 1）の観点に discoverability を追加した

- **verify / wait --verify: scope 不合格の logTail 末尾に定型ガイダンスを付与** (#1683): 違反 path 一覧の直後に「意図した差分なら契約の `scope.allow`（＝Issue の対象ファイル）へ path を追加し `send --contract` で送り直す（scope は送信時スナップショットで裁定）／`deny:` に一致する path は差し戻す」旨のガイダンスを追加。列挙漏れ起因の scope 不合格（#1678 B-2）を worker / 監督側が出力だけで自己解決できるようにする
- **CLI: `commandmate sync` — サーバーの worktree 再スキャンを CLI から実行** (#1680)
  - GUI の worktree 同期ボタンと同じ `POST /api/repositories/sync` を呼ぶ薄いサブコマンド。`git worktree add` で作成した worktree を GUI を開かずに `commandmate ls` へ反映でき、worktree 作成 → dispatch が CLI だけで完結する（#1678 A-1）
  - `--json` で同期結果（worktreeCount / repositoryCount / repositories / deletedCount / cleanupWarnings）を API レスポンス相当のまま出力
  - サーバー未起動時は既存コマンドと同じ接続エラー（exit 1）。リポジトリ未設定の 400 はサーバーの文言（WORKTREE_REPOS / CM_ROOT_DIR の案内）を素通しして exit 2
- **CLI: `respond <worktree-id> --default`** — 検出中プロンプトの default 選択肢（❯ ハイライト位置）を明示的に選択する（#1681）
- **実行契約の Auto-Yes ポリシー抑止を CLI から観測可能に** (#1684): 抑止はこれまでサーバーログ（`poller:auto-yes-suppressed-by-policy`）にしか出ず、無人実行のワーカーが `mode: safe` の対象外プロンプト（Claude の編集確認は `multiple_choice` 型）で停止しても理由を判別できなかった。最後の抑止をセッション単位で記録し、`commandmate capture --json` の `autoYes.lastSuppression`（reason / mode / promptType / pattern / at）として露出する。あわせて task-contract 仕様書と CLI 運用ガイドに「無人実行は `allow-listed` ＋ `denyPatterns` を使う」推奨レシピを明記した
- **CLI: auto-yes が解決したプロンプトの監査証跡（#1685）**: `commandmate capture <worktree-id> --prompts [--limit N] [--json]` で、解決済みプロンプトの question / options / answer / 応答種別（`answeredBy`: `auto`＝サーバ側 auto-yes / `human`＝respond API・チャット UI / `terminal`＝ターミナル直接応答の推定）を事後に取得できるようになった。auto-yes が `wait` のポーリング間隔内に応答してプロンプトが一度も pending 保存されないケースでも、応答送出時に answered 済みのプロンプト行をチャット履歴へ作成して証跡を残す（`GET /api/worktrees/[id]/messages?messageType=prompt` を追加）

### Changed

- **`--stop-pattern` の照合対象と限界をヘルプ・ガイドに明記** (#1682): `--stop-pattern` はターミナル出力のデルタへの正規表現照合であり、エージェントが実行するコマンドの抑止には使えない（ビルドログに `rm -rf` 等の文字列が表示されただけでも発火して Auto-Yes が停止する実害が #1678 で発生）。`auto-yes` / `send` の `--help`、`commandmate docs agent-operations`、`docs/user-guide/cli-operations-guide.md` に「ターミナル出力への照合。コマンド抑止には実行契約の `autoYes.denyPatterns` を使う」旨を追記した。あわせて同ガイドに「worker 稼働中の worktree で監督側が検証・ビルドをしない（生成物ディレクトリ共有で双方のビルドが破損する）」の注意項を追加した
- **verify / wait --verify: 不合格ゲートの logTail 表示に行数上限** (#1683): stderr への logTail 表示を末尾 40 行までにし、超過分は `... (+N more lines; run \`commandmate verify show <run-id>\` for the full log)` の 1 行に畳む。保存側（`options.maxLogTailBytes`、最大 1MB）は従来どおりで、`--json` / `verify show` は全文を返す

### Fixed

- **CLI**: `respond` の `yes` / `no` を multiple_choice プロンプトの選択肢ラベルへ意味解決してから送信するように修正（#1681）。従来は非数値回答をテキスト+Enter で送るだけで、カーソルナビ型メニュー（claude / antigravity）では文字入力が無視され Enter が default 選択肢の選択に化けていた（3 択への `respond no` が default の "Yes" を選ぶ = 否認のつもりが承認）。肯定候補が複数ある場合は最小番号（= 最小権限）を選択し、解決不能な場合は何も送信せず `unresolvable_answer` でエラー終了する。あわせて default 選択肢を明示的に選ぶ `respond --default` と、解決結果（選択した番号・ラベル）の stdout 出力（監査用）を追加

## [0.20.0] - 2026-08-04

> **Highlight**: worktree ID を「一度採番したら動かない値」に作り替えたリリース。ブランチ由来だった ID をディレクトリ由来へ変え（#1644）、既存行も migration v54 で一括で振り直し、旧 ID は alias として API・ページ・CLI の 3 面で解決し続ける（#1645）。この移行中に**同一 git リポジトリを 2 つの scan root として登録していると sync のたびに ID が 8 hex ずつ伸び、稼働中セッションが UI から消える**回帰（#1659）を本番で踏んだため、churn を塞ぎ（migration v55 で伸びた ID を圧縮）、原因となる構成に気付ける警告（#1662）と、リポジトリを**非破壊で走査対象から外す** GUI（#1658）を追加した。あわせて Auto-Yes が Claude in Chrome の許可ダイアログに応答しない問題（#1676）など、実運用で踏んだ不具合を 12 件修正している。
>
> **DB マイグレーションあり**: `CURRENT_SCHEMA_VERSION` 52 → 55。次回起動時に自動で実行される。**worktree 行・チャット履歴・タスク・検証実行は 1 行も削除しない**（v54/v55 の ID 振り直しは `renameWorktreeIdPreservingChildren` で子データを引き連れる）。削除されるのは、この同じリリースで導入された内部の**旧 ID → 新 ID リダイレクト表（`worktree_aliases`）の中間行だけ**である — churn で `a` → `a-1234abcd` → `a-1234abcd5678ef90` と伸びた梯子の途中段は、圧縮後には到達経路として不要になるため落とす。利用者から見える旧 URL（振り直し前の実 ID）は alias として残るので `/worktrees/<旧ID>` は 308 で解決し続ける。

### Added

- **同一 git リポジトリを指す scan root が複数登録されていることに気付けるようになった** (#1662): `CommandAgent` と `CommandAgent-develop` のように**同一 git リポジトリの 2 つの worktree**が両方 scan root として登録されていると、`git worktree list` はどちらから叩いても同じパス集合を返すため、sync のたびに同じ worktree が 2 回 upsert され `worktrees.repository_path` が実行ごとに入れ替わる。これが #1659 の ID churn（sync ごとに worktree ID が 8 hex 伸び、稼働中セッションが UI から消える）の前提条件だった。#1660 で churn 自体は塞いだが、**「なぜ 2 つ登録されているのか」に利用者が気付ける導線は無いまま**だったのでそれを作った。判定は `git rev-parse --git-common-dir` の**実パス**比較（`src/lib/git/git-common-dir.ts`）。正規化は 2 段とも必須で、出力は **linked worktree では絶対・main checkout では相対（`.git`）**（git 2.49 で実測）、さらに macOS の `/tmp`→`/private/tmp` は字句比較で取り逃がす（#1659 の worktree 群がまさにそこ）。**登録時**: `POST /api/repositories/validate-path` が `duplicateScanRoots` を返し、入力中に警告行が出る。送信時は確認ダイアログを挟む。**ブロックはしない** — 実際に登録する `POST /api/repositories/scan` は 1 行も変えておらず、`valid` も変えないのでサーバ側に拒否する経路が無い（同一リポジトリの複数 worktree を独立管理したい正当なユースケースを締め出さないため）。デバウンス前に急いで送信しても警告が出るよう送信直前に照合し直すが、**400ms の締め切り**を付けてある（検出は助言であり、応答しないエンドポイントが "Scan & Add" を固まらせてよい理由が無い。溢れた分は一覧のバッジ側が後から拾う）。**登録済み**: `GET /api/repositories` の各行に `duplicateOf`（同じリポジトリである他の scan root のパス）が付き、Repositories 画面の Name セルにバッジが出る。バッジは**ボタン**で、押すとその行の #1658 **Scan トグルにフォーカスが移る** — 対処手段を自分で探させる警告は無視されるため。判定対象は **enabled な行だけ**（無効化済みの root は走査されないので二重走査を作らず、数えると「誤検知しない」条件を自分で破る）。副次的に、片方を Scan トグルで外すと残った行のバッジが消えるので remedy が効いたことが画面で分かる。`is_env_managed` では区別しない（#1659 の実害はまさに env 由来側で出た。env 由来の root でも Scan トグルは効くことをコードで確認済み）。git が答えられないパス（非 git リポジトリ・削除済み・timeout）は判定をスキップするだけで登録フローを阻害しない。テストは**実 git リポジトリを砂箱に作って**走らせ（`execFile` モックでは「git が実際に何を出力するか」という主張を検証できない）、UI は Playwright の実ブラウザでも往復を実測した。空振りでないことは**変異 12 種を注入して全て赤になること**で確認済み。判断と根拠は `docs/design/duplicate-scan-root-warning.md`
- **リポジトリを「走査対象から外す」だけの非破壊な無効化が GUI から行えるようになった** (#1658): Repositories 画面のトグルは `visible`（サイドバー表示）しか変えず、`enabled`（走査対象）を落とす GUI が存在しなかった。そのため `enabled = 0` へ至る唯一の経路が `DELETE /api/repositories` = **除外 + purge**（配下 worktree の tmux セッションを kill し、worktree 行を削除 → chat history / memos / todos / timers / schedules / execution logs / tasks / verification_runs も道連れ）で、「片方の scan root の走査を止めたいだけ」の利用者に「履歴を捨てて稼働セッションを殺す」以外の道が無かった（#1659 の ID churn に遭った利用者が実際にこれで詰まった）。一覧の "Status" 列を **Scan トグル**に変え、`PUT /api/repositories/[id]` が `enabled` を受けるようにした。無効化は `UPDATE repositories SET enabled = 0` の 1 文だけで、**worktree 行も子データも稼働中セッションも一切触らない**（PUT ルートは `session-cleanup` を import すらしない。テストが「呼ばれないこと」を固定）。`enabled` と `visible` は #690 の分離を維持して**直交のまま**にしたので、無効化しても worktree はサイドバーに残る — 確認ダイアログがそれを明示し、消したい場合は Visibility トグルへ誘導する。再有効化は呼び出し元ゼロだった `PUT /api/repositories/restore` に配線し、フラグを戻すと同時に再 scan して worktree をその場で戻す。`All / Disabled` フィルタで無効化中の一覧と復元が画面内で完結する。**prune は誘発しない**: `syncWorktreesToDB` の per-repo prune は scan に現れたリポジトリのグループしか回らず、`pruneStaleRepositoryWorktrees` はディレクトリが消えたときだけ削除するため、無効化は削除条件を満たさない（#1659 の発端そのもの＝同一 git repo を指す 2 つの scan root の片方を無効化するケースもテストで固定）。`MAX_DISABLED_REPOSITORIES`（SEC-SF-004）は新経路にも効かせ、超過時は 409。破壊的な `DELETE` は挙動を変えず、GUI にも露出させていない（画面には非破壊の操作しか無いので取り違えようがない）。UI は jsdom だけでなく **Playwright の実ブラウザ**でも往復を実測した（portal + focus trap + 退出アニメーション付きの実 `Modal`、実辞書、実 fetch。`tests/e2e/repository-scan-toggle.spec.ts`）。判断と根拠、および **`server.ts` の起動時 purge に残っていた危険（`WORKTREE_REPOS` 列挙のリポジトリを無効化するとサーバ再起動時に worktree 行が削除されセッションが kill される。本 Issue の scope 外のため未修正 → #1666 で解消）** は `docs/design/repository-disable-gui.md` に記録した

- **`/worktrees/<旧ID>` が本物の HTTP 308 を返すようになった（#1644 からの宿題）** (#1645): #1644 はページを layout の `permanentRedirect` で救済したが、**実測では HTTP 301 ではなく HTTP 200 + `<meta http-equiv="refresh">`** だった。これは App Router の仕様で、layout の第 1 文に無条件 `permanentRedirect` を置いても同じ 200 になる（真の 3xx を返すのは Route Handler / Server Action / middleware だけ）。ブラウザは meta refresh に従うので着地はするが、ステータスコードが買うもの（ブックマークの自動書き換え、非ブラウザクライアントの追従）は得られず、**サブパスも失われていた**（layout は自分より下のパスを知らないので `/worktrees/<旧ID>/terminal` が worktree 詳細に着地する）。旧 ID が実際に飛んでくるのは既存行を振り直す本 Issue からなので、ここで解決した。`middleware.ts` は edge runtime で alias 解決に要る SQLite を引けないため**不可**で、`server.ts` が Next へ渡す前に傍受する形にした（`src/lib/git/worktree-redirect.ts`）。**サブパス（`/terminal` / `/files/...`）とクエリ（`?_rsc=` を含む）は byte-for-byte 保持**するので、ターミナル画面のブックマークはターミナル画面に着地する。**301 ではなく 308** — `/worktrees/<id>` は今はページルートだが Server Action はページ自身の URL へ POST するため、301 が歴史的に許す GET 化は避けたい。**併せて `Cache-Control: no-store`** — 「旧 ID → この worktree」は永続的だが永遠ではなく、worktree を削除すると alias は CASCADE で消え、後から同じ basename のディレクトリがその ID を **live** として採番されうる（解決では live が alias に優先）。恒久リダイレクトをキャッシュしたクライアントは二度と問い合わせず永久に間違った worktree へ着地するので、ステータスは「移動した」と言い続けつつその答えのキャッシュだけを断る。`server.ts` へは**`await import()` で遅延読込**（top-level 静的 import は `tsx server.ts` 下で Next の AsyncLocalStorage bootstrap を壊し、最初のリクエストで落ちる前科がある）。**ステータスコードは単体テストでは主張できない**（`next/navigation` をモックしたテストは 200 でも緑になる。#1644 が実際に踏んだ）ので、隔離環境（ポート 3199 / 専用 DB / スクラッチ repo）の実サーバに `curl` を当てて **dev・production の両方で 308 を実測**し、`docs/design/worktree-id-migration-uat.md` に記録した。同ドキュメントには Phase 3/4 の実機 UAT も記録している — 旧 ID 名で本物の `claude` を起動した状態で migration を当て、**ペイン PID 94761 が前後で同一**（プロセスは殺されていない）・スクロールバック保持・旧名は即座に解決不能・一時セッション残留 0・孤児行 0 を確認。ブランチ切替→sync では ID 不変・セッション継続（同一 PID）・**Auto-Yes は `expiresAt` まで同一のまま継続**・履歴/タスク/検証履歴/roster すべて引き継ぎを確認した

- **既存 worktree の ID をパス由来へ一括で振り直した（migration v54）** (#1645, Phase 4): #1644 は ID が**勝手に動かない**ようにしただけで、既に DB にある行には触れていない — それらは今も `sanitize(repoName)-sanitize(branch)` を持っており、単に凍結されたブランチ由来 ID である。#1621 が挙げた破断が本当に消えるのは、保存されている ID がディレクトリ由来になった後。migration v54 が全行を採番し直し、旧 ID を `worktree_aliases` に残す。**採番規則の肝は「他の行が空ける ID を絶対に再利用しない」こと**: 退役した ID は消えるのではなく alias になり、解決では live worktree が alias に優先する。だから worktree B に「A が退役させた `x`」を渡すと、A の `x` を指すブックマークが黙って B に着地する。taken 集合には**全 worktree の現 ID と既存 alias 全部**を入れ（自分自身の ID だけ除外＝そのまま維持できる）、ぶつかった候補は同一 basename の衝突と同じく `basename-<sha256(path)[0..8]>` に落とす。**適用は `old → cmate-mig54-<n> → new` の 2 段**。`renameWorktreeIdPreservingChildren` の衝突分岐は「destination に source をマージして source 行を DELETE する」破壊的経路なので、そこへ入る余地を構造的に消す（採番規則のおかげで今は到達しないが、規則の側だけに安全性を預けない）。stage 2 が書く `temp → new` の alias 行は最後に削除する（残すと ID を永久に占有する＝採番器は alias を taken 扱いするため）。子行は `getWorktreeChildTables` の列挙（**FK 宣言ではなく `worktree_id` 列**）で追従するので `tasks`(#1548) / `verification_runs`(#1544) / alias 自身も付いてくる。**`skill_operations` だけは付いてこない**: `BEFORE UPDATE ... RAISE(ABORT)` の追記専用台帳（#1234）で、書き換えようとすると migration ごと abort する。監査行は「その時点の identity」を記録するものなので旧 ID のままが正で、alias があるので解決もできる。tmux セッションとインメモリ状態は migration からは触れないため、起動時に `server.ts` が `reconcileWorktreeSessionsFromAliases(db)`（Phase 3）を**動的 import**で呼んで追従させる — alias 表が「動いた ID の一覧」そのものなので、何も無ければ `tmux list-sessions` 1 回で終わる冪等な pass になる。`down()` も alias から逆算して用意した（ロールバック可能）。実装都合として、ID 採番の純粋部分を `src/lib/git/worktree-id.ts` へ、主キー移送を `src/lib/db/migrations/worktree-id-rename.ts` へ切り出した — migration が `@/lib/git/worktrees`（`@/lib/db` 経由で循環）や `@/lib/db/worktree-db`（suite 中の `vi.mock` を `runMigrations` が被る。v52 が実測で踏んだ罠）を import できないため。公開 API と import パスは不変。空振り検証は変異注入 4 件で確認済み（子テーブル列挙を FK メタデータのみに戻す→1件赤 / 採番の reserve を外す→3件赤 / temp alias を残す→3件赤 / alias 記録を止める→5件赤）

- **worktree ID が動いたとき、稼働中のセッションと実行時状態が追従するようにした** (#1645, Phase 3): `reconcileWorktreeSessions(db, oldId, newId)`（バッチ形 `(db, renames[])` もあり）を新設した。`migrateWorktreeIdPreservingChildren` は DB の行を移すが、**ID から導出されているだけで保存されていないもの**は触れない — tmux セッション名 `mcbd-{cli}-{worktreeId}[-{suffix}]`（`cli-tools/base.ts` の導出値。稼働中のエージェントがプロセスは生きたまま UI から消え、同じディレクトリに 2 体目を起動できてしまう #1621 (a)）と、Auto-Yes / レスポンスポーラー / control-mode attach / WS ルームの 4 つのインメモリキー（#1621 (f)）。**このうち 1 つでも落とすと「セッションは生きているのに指示が届かない」という同型の壊れ方**をするので、すべて無効化ではなく**キー移送**にした。**2 段階リネーム**: 一括振り直しでは ある worktree の新名が別 worktree の旧名になりうる（設計の例＝`commandmate-main` は現行 `mycodebranchdesk-main` の新名）ため、A→B / B→A のスワップには正しい単発順序が存在しない。全セッションを一時名（`cmate-renaming-*`。`mcbd-` 接頭辞を**避ける**ので読むモードの `#{m:mcbd-*}` ガードに拾われず、`tmux ls` を見た人間にも一過性だと分かる）へ退避してから本名へ入れる。インメモリの移送側も同様に「全件 detach → 全件 write」の 2 相で、スワップが自己衝突しない。**対象列挙は roster 駆動**（`agent_instances` × CLI ツール登録 ＋ 全ツールの primary instance）で、生存判定はセッション名の**完全一致**、tmux 操作は `exactTarget()` — `mcbd-claude-<wt>` は `mcbd-claude-<wt>-2` の接頭辞なので前方一致は別インスタンスを巻き込む（#1156）。roster は新旧**両方**の ID で引く（DB 移行の前後どちらから呼ばれても効くようにするため）。移送の内訳: Auto-Yes は state を deadline / stopPattern ごと移し、**動いていたポーラーだけ**新 ID で再起動する（poller の timer chain が worktreeId をクロージャに掴んでいるため、map の付け替えだけでは旧セッションをポーリングし続ける）。レスポンスポーラーは `activePollers` / `pollingStartTimes`（**turn の実開始時刻**を維持するので MAX_POLLING_DURATION の 30 分が移行でリセットされない）／prompt・response の dedup ハッシュを持ち越し、新 ID で再スケジュールする。control-mode は `TmuxControlRegistry` のキーを差し替えるだけ（`rename-session` は attach を切らない＝子プロセス・パイプ・スクロールバックがそのまま生き残るので、張り直すより re-key のほうが安全。entry がイベントハンドラと idle timer に読ませる名前を entry 自身に持たせ、クロージャが旧名を掴んだままにならないようにした）。WS はルームと各クライアントの購読集合、さらに**ターミナル購読がキャッシュしている sessionName** を移す（後者を落とすと `terminal_input` が消えたセッション名へ飛ぶ）＋購読者へ `worktree_renamed` を通知する。capture キャッシュは `renameSession` が新旧両名を破棄する。起動時は `reconcileWorktreeSessionsFromAliases(db)` が `worktree_aliases` を「旧 ID の一覧」として使い、旧名で残っているセッションだけを拾う（何も無ければ `tmux list-sessions` 1 回で終わる冪等な no-op）。**移送しなかったもの 1 件（scope 制約）**: TUI accumulator（opencode / copilot の途中バッファ）は新キーで空初期化する。`src/lib/tui-accumulator.ts` にバッファを書き戻す API が無く、同ファイルは本 Issue の `scope.allow` 外のため。移行境界を跨いだ 1 応答が途中で切れうるが、次の turn からは正常に蓄積する。空振り検証は変異注入 7 件で確認済み（一時名を経由しない単発リネーム → 6 件赤 / Auto-Yes state を移送せず破棄 → 4 件赤 / dedup を移送せず clear → 1 件赤 / WS ルームを移送せず破棄 → 2 件赤 / roster 列挙を前方一致 sweep に置換 → 1 件赤 / Auto-Yes ポーラーを再起動しない → 1 件赤 / ターミナル購読の sessionName を据え置き → 1 件赤）

- **読むモードの「非対応 tmux では no-op」を、実際に古い tmux を動かして実証した** (#1641): #1623 は受入条件「`display-popup` 非対応 tmux（<3.2）で no-op となり、案B が代替として動作すること」を**未検証のままクローズ**していた（手元が 3.5a しか無かったため）。単体テストは capability プローブの戻り値を**モックして両分岐を通していただけ**で、モックは「プローブが tmux に正しい質問をしているか」を何も保証しない。docker で tmux **2.8 / 3.1c / 3.3a**（対照）を用意し、**出荷している `src/lib/tmux/{read-mode,tmux,transcript-squeeze}.ts` を esbuild で束ねてそのまま実行**して裏を取った（書き写した再実装は使っていない）。結果は 2.8 / 3.1c で `outcome=unsupported-tmux`・`prefix+g` は未バインド・同一サーバの他セッションも既定ソケットも無傷、3.3a では `installed`。案B（`capturePane` + `squeezeTranscript`）は 3 版すべてで 1003 → 52 行・マーカー検出と**同一の結果**で、tmux バージョン非依存であることが実測で確認できた。**実測で分かった新事実 2 件**: (1) プローブが正解する理由はバージョンで違う — 3.1c は「引数は受けるが未知の名前には**無出力で exit 0**」、2.8 / 3.0a は「`list-commands` がそもそも**コマンド引数を取らない**」ため実在する `capture-pane` にも同じ usage エラーを返す。したがって出力判定は両方を正しく捌く唯一の形である一方、`supportsDisplayPopup` の形を**他コマンドの capability 判定へ流用してはいけない**（3.1 未満の全 tmux で偽陰性）。(2) 衝突検査に使う `list-keys` の**キー引数も 3.1 から**で、3.0 以下では `readExistingBinding` が常に「キーは空き」を返す劣化状態になる。これが無害なのは capability プローブが先に short-circuit していて 3.0 以下がそこへ到達しないからで、**ガードの順序が load-bearing** だと判明したため単体テストで固定した（「非対応 tmux では `list-keys` を一度も撃たない」）。ハーネスは `scripts/verify-legacy-tmux-readmode.sh` + `scripts/legacy-tmux-probe/`。**ホスト側ドライバは tmux を 1 行も呼ばない**（2026-08-02 に「隔離したつもりの `kill-server` で稼働中の全 `mcbd-*` セッションを消した」事故があるため、構造として不可能にした）。コンテナ側は既定ソケットに囮セッションを置き、ソケット引数を取らない本番コードを `$TMUX` で `-L` 私設サーバへ向けたうえで、**転送が効いていなければ実行を拒否**する。CI ジョブ `legacy-tmux-readmode`（`container: node:18-bullseye` = tmux 3.1c）を追加し、**ベースイメージが将来 3.2 以上になったらジョブ自身を失敗させる**（何も検証していない緑を防ぐ）。空振り検証は `CM1641_INVERT_EXPECT=1` で全行の期待値を反転させ 3 行とも正しく落ちることを確認、単体テストは 2 変異（プローブを exit-code 型へ戻す / 衝突検査を capability プローブより前へ移す）で赤を確認済み

- **bash 参照実装 `verify-run.sh` を `options.requireCommit` に対応させた** (#1639): 同じ `.commandmate/verify.yaml` を読む 2 つのランナー（製品エンジンと、CommandMate サーバも Node も無い環境のための Phase 0 参照実装）のうち、bash 側だけが `options.requireCommit`（#1628）を知らなかった。**Issue 本文は「宣言を無視して commit 無しでも合格する」としているが、実測では合格していない** — awk パーサの options キーが閉じた集合だったため `line 7: unknown options key: requireCommit` で **exit 2 の設定エラー**になり、設定を書いたリポジトリでは bash 版が一切走らなかった（黙って無視はしていないが、宣言を書くと使えなくなるという別の壊れ方をしていた）。awk パーサにキーを追加し、`true`/`false` 検証と、`commits=0` を FAIL（`RESULT not_started` / exit 21）にする判定を実装した。ゲート行には `requireCommit=true` が付き（false のときは付かないので既定の出力は不変）、`commits=0 uncommitted=3` は「作業が在る」とも読めて FAIL の理由が行から読み取れない唯一のケースなので、理由行を stderr に出す。**2 実装の drift は conformance テストで固定した**（`tests/unit/skills/cmate-verify/require-commit-conformance.test.ts`）— 同一の git サンドボックスに両ランナーを当て、7 セルの行列（キー省略 / `false` / `true` × 未 commit のみ / commit 済み / commit+追加変更 / 作業ゼロ）で work-evidence と run の判定が一致することを見る。**既知の差分も同じファイルに明示的に pin した**: (1) TS は `.commandmate/tasks/` を作業証跡から除外する（#1580）が **bash 版は除外しない**ため、契約ファイルだけが変更された worktree で判定が食い違う（bash が PASS / TS が not_started。bash が緩い向きで requireCommit と同種の欠陥だが、work-evidence が「何を数えるか」の変更なので follow-up 扱い）、(2) 未追跡ディレクトリを TS は `-uall` でファイル単位・bash は 1 エントリで数える（**数字だけが違い判定は一致する**）。**bash 版は実行契約を読まない**（スタンドアロンランナーであり、シェルから起動したランはどの委任にも紐付かない）ことを、スクリプト冒頭・SKILL.md・仕様書に明記した — 両方のランナーで効かせたい要求は、2 実装が共に読む唯一のファイルである verify.yaml に書く。skill 実体は `.claude/skills` / `.agents/skills` の両ルートに byte-identical で置き（Claude は前者、Codex / Antigravity は後者しか読まない）、`sync-map.json` の pin も更新済み。**`Kewton/commandmate-skills` への移植は未了**（pin を更新したので対応表からは移植済みと区別が付かない状態になっている点を sync-map.json の note に明記した）。空振り検証は変異注入で確認済み（判定分岐の除去 → bash suite 5 件 + conformance 1 件が赤 / awk が再びキーを拒否 → 15 件赤 / `requireCommit=true` を無条件出力 → 1 件赤 / TS 側の判定除去 → conformance 1 件赤）
- **実行契約に `success.requireCommit` を追加し、契約が宣言した commit 義務を機械が検査するようにした** (#1642): `send --contract` の前文は以前から「作業完了後は必ず commit すること（未 commit の作業は未完了とみなされる）」と**固定文言で**宣言していたが、work-evidence は `commits=0, uncommitted=1` で `passed` を返していた — **契約が宣言したルールを機械が一度も検査していない**（#1628 D-4）。Epic #1585 の受入実測では、Codex ワーカーが未コミットのまま `wait --verify` で exit 0 / `RESULT passed` を受け取っている。#1628 で入れた `verify.yaml` の `options.requireCommit` はリポジトリ単位のスイッチなので、「ワーカー委任には commit を要求したい」と「手元の対話的 verify では要求されたくない」が両立しない（**work-evidence が落ちると後続ゲートは全て `skipped`** になり、未コミット状態では lint / typecheck / unit の結果が一切返らなくなる）。契約側に置くことで委任単位で効くようにした。**優先順位は OR（PM 決定）** — `options.requireCommit` と `success.requireCommit` の**どちらか一方が true なら true**で、契約が verify.yaml を緩めることはできない。「契約が勝つ」にすると、リポジトリが立てた要求を個々の委任契約が黙って外せることになり同じ穴が委任単位で再発するため、**締める方向にしか効かない**合成を採った。裁定の理由行はどちらの宣言が要求したかを名指しする。**既定は false**（`requireWorkEvidence` は省略時 true だが、`requireCommit` を true にすると既存の全契約の判定が変わるため）。**前文と work-evidence のラベルは固定文言をやめ、実際に効く規則へ追従させた** — 宣言と裁定が食い違わないことが本 Issue の目的なので、false のときは「commit の有無そのものは検査されない」と正直に書く。`requireCommit: true` かつ `requireWorkEvidence: false` は契約エラーにした（裁定するゲートを契約のゲート集合から外す組み合わせで、受理すると同じ「宣言だけあって見る機械が無い」状態が別の形で復活する。`requireScopeClean` × 空 `scope.allow` と同型の規則）。**未接続の契約（#1620 の `findDetachedContract`）からはフラグを読まない** — そのランはその契約についてのランではないため（未接続であること自体は従来どおり scope の `skipped` として集計に残り run は `error`）。空振り検証として 4 変異（OR を「契約が勝つ」へ／前文を固定文言へ戻す／gate-runner が契約を無視する／`requireWorkEvidence: false` との併用を許す）を注入し、いずれも赤になることを確認済み
- **npx 自己更新時に、残置したグローバル導入を警告** (#1633): サーバは npx 経由の自己更新（`update --relaunch-npx`）で更新され続ける一方、`npm install -g` で入れた CLI は据え置かれるため、PATH 上の `commandmate` だけが何ヶ月も古いまま乖離しうる（実際に 0.18.0 サーバ + 0.2.4 グローバル CLI という環境が生まれ、#1632 が誰にも気付かれない原因になった）。npx 自己更新経路の冒頭で `npm root -g` からグローバル導入を検出し、その版・パス・`npm install -g commandmate@latest` / `npm uninstall -g commandmate` の案内をコンソールと `~/.commandmate/update.log` の両方に記録する。**警告は助言に徹する**: グローバル導入が無ければ何も出さず、npm 不在・`npm root -g` の失敗・package.json が読めない等の検出失敗は警告をスキップするだけで update 本体は一切阻害しない（package.json が読めない場合は版を `unknown version` として警告自体は出す）

### Changed

- **旧 worktree ID を alias として解決し続けるようにした（API・ページ・CLI の 3 面）** (#1644, Phase 2): worktree ID は採番された瞬間に DB の外へ漏れる — 開いているタブ、スマホ、PWA ショートカット、ブックマーク、誰かのスクリプトの `commandmate send <id>`。Phase 1 で ID は動かなくなったが、旧方式で書かれた既存行は #1645 が振り直すため、その移行を跨いで**旧 ID が引き続き答える**必要がある。migration v53 で `worktree_aliases(old_id PK, worktree_id → worktrees(id) ON DELETE CASCADE, created_at)` を追加し、**alias の記録を rename 操作そのものの性質にした** — `migrateWorktreeIdPreservingChildren` が記録するので、sync も #1645 の一括移行も将来のディレクトリ移動も、呼び出し側が覚えていなくても旧 URL が生き残る。解決規則は **live worktree が alias に優先**（退役名を後から実在の worktree が取った場合は実在側が正）で、A→B→C は A→C の 1 hop に畳む（chain を歩かないので循環しえない）。`deriveWorktreeId` の taken 集合にも alias ID を入れ、新規 worktree が alias の転送先を覆い隠さないようにした。**「片面だけ直す」失敗を避けるため、route 境界で ID を写す**: `src/app/api/worktrees/[id]/**` の全 route（69 ファイル・89 箇所）が `params` 展開直後に `canonicalWorktreeId()` を通す。route は worktree の存在確認を 1 回するだけで、その後は生の URL セグメントを子テーブル参照・tmux セッション名・poller / Auto-Yes キー・WS broadcast に使い回しているため、**存在確認だけ写すと 404 が「履歴が空で返る」「旧名で 2 体目のエージェントを起動する」に化ける**（この half-fix を変異注入で赤にして固定した）。`canonicalWorktreeId` は全経路を try で包んだ total 関数で、不正形式・未知 ID・DB 失敗はすべて要求 ID をそのまま返す（route 単体テストが path-validator や `@/lib/db` を部分モックするため、throw すると alias と無関係な route が 500 になる。実測で `files-download` が 500 化したため修正）。CLI（`send` / `wait` / `capture` / `respond` / `auto-yes` / `instances` / `verify`）は全て HTTP 経由なので、この 1 箇所で旧 ID を受理するようになる。`ls --id` の前方一致は従来どおり**現在の ID に対して**行う（旧 ID は完全一致でのみ解決）。**Issue 本文との食い違い 1 件（実測）**: ページ `/worktrees/<旧ID>` は **301 にならない**。隔離 DB の実サーバ（`tsx server.ts`, NODE_ENV=production）で計測したところ、`permanentRedirect` は **HTTP 200 + `<meta id="__next-page-redirect" http-equiv="refresh">`** を返す。これは App Router の仕様で、layout の第 1 文に無条件 `permanentRedirect` を置いても（`loading.tsx` の有無に依らず）同じ 200 になる — 真の 3xx を返すのは Route Handler / Server Action / middleware だけである。ブラウザは meta refresh に従うので「開いたままのタブ・スマホ・PWA・ブックマークが現行 worktree に着地する」という目的は達成されるが、ステータスコードが買うもの（ブックマークの自動書き換え、非ブラウザクライアントの追従）は得られない。真の 3xx には `middleware.ts` か `server.ts` が要り、どちらも本 Issue の scope 外（かつ middleware は edge runtime で SQLite 不可）なので、旧 ID が実際に飛んでくる瞬間を所有する #1645 の follow-up とする。**この食い違いはモックした単体テストが緑のまま実サーバが 200 を返していたので、テストは「どの URL へ転送するか」だけを主張し、ステータスは実測値として doc に固定した。** 空振り検証は変異注入で確認済み（`canonicalWorktreeId` の alias 解決除去 → 5 件赤 / rename の alias 記録除去 → 3 件赤 / taken 集合から alias 除去 → 1 件赤 / alias を live より優先 → 4 件赤 / half-fix（存在確認だけ写す）→ 1 件赤）

- **worktree ID をブランチ由来からディレクトリ由来へ変え、一度採番したら動かない値にした** (#1644, Phase 1): ID は `sanitize(repoName)-sanitize(branch)` で導出されていたため、**git worktree を使わず同一ディレクトリでブランチを切り替えると同じディレクトリの ID が別物になっていた**（detached HEAD ではコミットのたびに変わる）。#1151 で「履歴が CASCADE 削除される」データ損失は解消済みだが、ID に紐づく **DB の外側**（tmux セッション名 `mcbd-{cli}-{worktreeId}`、開いているタブ・ブックマーク、ポーラー / Auto-Yes のキー）は追従しないままだった。`deriveWorktreeId(resolvedPath, takenIds)` を新設し（`sanitize(basename(path))`、衝突時のみ `-{sha256(path).slice(0,8)}`、桁を伸ばす決定論的な再試行つき）、`generateWorktreeId` は `@deprecated` にした。**効いているのは導出規則ではなく「再導出しない」こと** — `syncWorktreesToDB` が**パスで既存行を引き、ヒットすれば既存 ID をそのまま維持**し、無い場合にだけ採番する。したがって ID はブランチ切替でも detached HEAD の前進でも、将来この導出規則を変えても動かない。`worktrees.name` の意味は「表示用のブランチ名」に固定し、毎 sync で実ブランチへ更新する（`branch` カラムは #1003 のまま）。**Issue 本文との食い違い 1 件**: 本文は「`scanWorktrees` は ID を確定させない（`{path, branch, name, repositoryPath, repositoryName}` を返す）」としているが、`scanWorktrees` の戻り値は `POST /api/repositories/scan` / `restore` と `syncWorktreesAndCleanup`（`src/lib/session-cleanup.ts`）が `Worktree[]` 前提で受けており、いずれも本 Issue の scope 外のため型を落とせない。**`id` は「暫定値（provisional）」として残し、確定は `syncWorktreesToDB` が行う**形にした（優先順位＝既存パスの ID ＞ 呼び出し側の提案 ID（未使用の場合のみ）＞ `deriveWorktreeId`）。ID は全リポジトリ横断のグローバル主キーなので、衝突判定の taken 集合も `getAllWorktreeIds` で横断的に取る（`/a/main` と `/b/main` の同名ディレクトリが両方 `main` を主張すると 2 件目が `UNIQUE(path)` で落ちる）。**本 Issue のマージ時点で既存 worktree の ID は変わらない**（新規登録分のみ新方式。既存行の一括移行は #1645）。空振り検証は変異注入で確認済み（既存パスの ID 維持を外す → 5 件赤 / taken 集合をリポジトリ内に狭める → 1 件赤 / `name` のブランチ追従を外す → 1 件赤）

- **送り先エージェントの指定を `--instance` 単独形へ統一（ドキュメント・ヘルプ文言）** (#1638): `--agent` を受け付けるのは `send` / `respond` / `capture` / `auto-yes` だけで、`wait` は `unknown option` で exit 1 になる。この非対称が実害になるのは**「`send` にだけエージェントを書いて `wait` には書かない」**ときで、`wait` は worktree の**既定エージェント**を見るため、Codex 用に切った worktree で黙って Claude Code の完了を待つ（#1629 の実測）。**`--agent` は廃止せずエイリアスとして存置**し、位置づけだけを「roster に無いインスタンスのアドホック起動の補助」へ降格させた — 削除は出荷済み CLI・既存スクリプト・埋め込みドキュメントを壊す代償に見合わず、加えて `send --register` は roster 外のID（例 `codex-3`）から CLI ツールを推論できないため `--agent` でしか指定できない（**削除は不可能**であって、単に非推奨なのではない）。**判定ロジック（#1629 の優先順位: roster が正本、矛盾は exit 2）は一切変更していない**。整合させた 4 面は (1) `send`/`respond`/`capture`/`auto-yes` の `.option()` 説明文（`src/cli/config/agent-target-options.ts` を単一ソース化し、存置の根拠を doc コメントに記載）、(2) `wait --instance` の説明文（「`wait` に `--agent` は無い」を明記）、(3) `commandmate docs` の埋め込み文書 `src/cli/docs/agent-operations.ts`、(4) `docs/user-guide/cli-operations-guide.md` と `CLAUDE.md` の例。**Issue 本文との食い違い 1 件**: 「`--agent codex --instance codex-2` 形が残存」は `docs/user-guide/cli-operations-guide.md` にも 6 箇所残っていた（#1629 で対応済みなのは「マルチセッション使用例」節のみ）。副次的に、並列 worktree のサンプルが誤りだったことが判明したので直している — **1 回の `wait` に指定できる `--instance` は 1 つで引数の全 worktree に適用される**ため、`send --agent codex` した WT2 を含む `wait "$WT1" "$WT2"` は WT2 の既定エージェントを見ており、Issue の症状そのものをサンプルが教えていた（インスタンスの異なる worktree は `wait` を分ける）。空振り検証として 3 変異（send の `--agent` 説明文を旧文言へ戻す／`wait` に `--agent` を生やす／埋め込み文書に `--agent codex --instance codex-2` を戻す）を注入し、いずれも赤になることを確認済み。`wait --agent` の新設は #1629 の結論どおり不採用。**第2弾で英語版ドキュメントまで揃えた**: `docs/en/user-guide/cli-operations-guide.md` は要約版で `--instance` に一度も言及しておらず（489 行 対 日本語 1220 行、マルチセッション節そのものが無い）、**`--agent` 形だけを教えている状態**だったため、逐語訳ではなく「推奨形と事実」（推奨形・`--agent` の位置づけ・`wait` に `--agent` が無いこと・`--register` に必須である理由）を英語版の粒度で追加した。日英の `workflow-examples.md` の契約送信例（`send --agent claude` → 素の `wait`）も `--instance claude` 形へ統一。あわせて**日英ともドキュメントの markdown を検査する退行ガードを追加**した（`wait --agent` の用例が無いこと・`--agent` の用例が `instances add` か `--register` に限られること・各 locale の cli-operations-guide が推奨形と非対称を明記していることを固定）。**第3弾で `README.md` を揃え、退行ガードの走査を列挙から自動発見へ切り替えた**: 走査対象が「docs は自動発見・root は列挙」という非対称な形だったため、README.md が 2 回続けて取りこぼされていた（1 回目は scope 外、2 回目は列挙漏れ）。root markdown と `docs/**` を丸ごと自動発見し、**記録文書（`CHANGELOG.md` / `docs/**/design/` / `docs/**/internal/`）のみを名前で除外**する形に変更（記録を後から書き換えさせるガードは有害なため。実際 `docs/design/1623-tmux-reading-mode.md` は `capture --pane [--agent X] [--instance Y]` を当時の決定として正しく記録している）。**さらに用例の抽出がテーブルセル内のインラインコードを読めていなかった**問題も修正した — README は**全用例をテーブルセルに書いており**、行頭アンカーの走査では「用例ゼロ」と読まれて**素通りする**。これが README.md が 2 回とも無検査だった構造的な理由である。空振り検証として 2 変異（README のテーブルセルに `wait --agent` を復活／インラインコード抽出を外す）を注入し、いずれも赤を確認（後者は前者の offender を他のガードが検出できないことも同時に示している）。走査対象は 69 ファイル（`docs/ja/README.md` を含む）

### Fixed

- **Auto-Yes が Claude in Chrome の許可ダイアログに応答しない問題を修正** (#1676): `Claude in Chrome wants to run JavaScript on localhost:8787` ＋ `❯ 1. Allow / 2. … / 3. Deny (esc)` 型の許可ダイアログを `detectMultipleChoicePrompt()` の Layer 5（SEC-001 質問行バリデーション）が「プロンプトではない」と判定していた。ヘッダが**疑問文でなく宣言文**で、`?` も `QUESTION_KEYWORD_PATTERN` のキーワードも含まないため（実測 8 操作中 6 つが MISS。`type`/`select` だけ偶然キーワードに一致して通るため「効きが悪い」体感になる）。検出器 1 箇所の沈黙が共有パイプラインの 5 経路（Auto-Yes / PromptPanel / Web Push・Message History / `commandmate wait` exit 10 / `commandmate respond` の送信前再検証）へ同時に波及していた。**修正は Layer 5 の適用条件に `!hasDefaultIndicator` を追加した 1 行**: ❯ の実在を Pass 2 で確認できたフレームは質問行バリデーションを免除する（FP 防御はカーソル実在チェックで足りており、codex / gemini は `requireDefaultIndicator: true` で最初から同じ意味論。claude だけが #193 の ❯ 欠落対応の副作用で非対称だった）。❯ が無いフレームは従来どおり SEC-001a/b を通るため #193 の capture artifact 耐性は不変。同型の FN だった**和文命令形 AskUserQuestion**（「実装方針を選んでください」＝ `？` もキーワードも無い）も同時に解消。FP ガード 3 種（散文の番号付きリスト / #1495 model オーバーレイ / composer ❯ バリア）と `detectSessionStatus` 経由の `hasActivePrompt` を回帰テストで固定し、`fake-agent.test.ts` の mutation test は新セマンティクス（質問行と ❯ の**両方**を消して初めて waiting を失う）へ更新した
- **ターミナル出力が 1MB を超えると末尾（最新）が捨てられ、画面に古い側だけが残る問題を修正** (#1674): 稼働中の codex セッション（`mcbd-codex-commandagent-develop`）で、composer 行も Codex の最終メッセージ（`Goal blocked (/goal resume)`）も描画されず、画面の最終行が JSON 差分の途中で切れて `+2;205;214;2` という文字列で終わっていた。**原因は `sanitizeTerminalOutput()` の `validated.slice(0, MAX_TERMINAL_OUTPUT_LENGTH)`**。ターミナルは下から読むものなので意味があるのは末尾（いま何が起きているか）だが、この切り詰めは**先頭を残して末尾を捨てていた**。実測 capture は 1,182,902 文字で上限 1,048,576 を 134,326 文字超えており、**その 134,326 文字がまるごと最新側**だった。加えて切断が**文字数ちょうど**で行われるため ANSI エスケープの内部に落ち、`ansi-to-html` がシーケンスのパラメータバイトをそのまま文字として出力していた（画面末尾の `+2;205;214;2` の正体。実 capture の切断点は `…43m+\x1b[38;2;205;214;2` ｜ `44m    \x1b[38;2;147;15` で、Issue 本文の実測値と**バイト単位で一致することを確認済み**）。**直したのは 3 点。** (1) `truncateTerminalOutput()` を新設し**末尾を残して先頭を捨てる**（同リポジトリの `truncateMessage()`（`src/lib/response-cleaner.ts`）が同じ理由で先行実装している形に揃えた。marker つき・サロゲートペアガードつき）。(2) **切断を行境界に合わせた** — ANSI エスケープは改行をまたがないので、残す末尾を改行の直後から始めればシーケンス内部で切れることは原理的に無い。行境界が 64KB 以内に見つからない病的な入力（1 行が巨大）にはエスケープ境界を認識するフォールバックを置いた。(3) **切り捨てを画面に出す** — 無言で消えると「出力がそこで終わっている」と読め、実際に本件は「Codex が途中で止まった」と誤診されたので、`TERMINAL_TRUNCATION_MARKER`（`[... 古い出力を省略しました / older output truncated ...]`）を先頭に出す。**対になる経路も点検した**: `sanitizeTerminalOutput()` の呼び出し元は `TerminalDisplay.tsx` の 4 箇所（初期描画 / coalesce / append チャンク / replace）で、**append チャンク経路だけ入力が全体でなく差分**である。差分が上限を超えると末尾保持は**その差分の先頭**を落とし、既描画チャンクと新チャンクの間に虫食いを作る（旧実装の先頭保持でも同じ位置に穴が空いたが、末尾保持では穴が marker で可視化されるぶん誤読しやすい）。そこで**上限超えの append は replace へフォールバック**させ、描画中の DOM が常に出力の連続した suffix であることを保つようにした。`terminal-display-normalizer.ts`（#1172 の compaction）は sanitize の**前段**で縮めるだけなので変更不要。**上限値 1,048,576 は据え置き**（本件は向きと切り方の欠陥であって容量不足ではない）。定数は `src/config/terminal-output-config.ts` へ集約した。**顕在化した理由は #1624（v0.19.0）**: それ以前は `history-limit` が pane 生成後に設定されて実際には効かず pane は tmux 既定の 2000 行しか保持していなかったため、capture は約 240KB 止まりで 1MB 上限に一度も届いていなかった（#1624 は正しい修正であり、同じ pane に 3 つの上限問題を同時に露出させた。保存側 #1670・検知側 #1671・描画側が本件）。テストは実測値と同じ 1,182,902 文字・切断点が SGR シーケンス内部に落ちる fixture で「末尾が描画され先頭が落ちること」「切断が行境界であること（残った部分が入力の純粋な suffix で、その直前が改行であること）」「シーケンスのパラメータバイトが HTML に漏れないこと」「marker が出ること」「上限以下は 1 バイトも変わらないこと」「上限＋1 文字」「行境界の無い入力」「サロゲートペア」を固定し、`TerminalDisplay` 側で「上限超え append が replace へ落ちること」「通常の append は従来どおり追記されること」を固定した。空振りでないことは変異注入 3 件で確認済み（切る向きを先頭保持へ戻す → 8 件赤／行境界合わせを外して文字数ちょうどで切る → 4 件赤／append のフォールバックを殺す → 1 件赤、しかも失敗メッセージが `FIRST-FRAME-LINE` の直後に marker が来る虫食いそのものを示す）。修正後の実 capture（1,182,902 文字）を通して marker・`Goal blocked (/goal resume)`・漏れなしの 3 点を実機データで確認している

- **tmux の scrollback が capture 窓（10000 行）を超えると、inline レンダリング系ツールの応答が永久に保存されなくなる問題を修正** (#1670): 2026-08-04、稼働中の codex セッション（`mcbd-codex-commandagent-develop`、`history_size` 10908）で Message History が **10:02:22 JST で止まった**。エージェントは 10:44 まで動き続けターミナルには全部出ていたが履歴には 1 件も入らず、`logs/server.log` には `already-saved-up-to-line` が繰り返し出ていた。**原因はこの app の capture が「末尾 N 行のスライディング窓」であること。** `captureSessionOutput()` は tmux に `-S -CACHE_MAX_CAPTURE_LINES` を要求し `sliceOutput()` が末尾 N 行へ切り詰めるので、返る行数は `min(pane 行数, 窓幅)`。pane が窓より小さいうちは行数が伸びるので `session_states.last_captured_line` は「どこまで読んだか」のカーソルとして機能するが、**pane が窓を超えた瞬間に行数は窓幅へ張り付き、以後は窓が滑るだけ**になる。カーソルはもう追い越せず `result.lineCount <= lastCapturedLine` が恒久的に真になって毎回応答が捨てられる。バッファリセット検知（`bufferShrank` / `sessionRestarted`）は**縮んだときしか働かない**ため自力復帰の経路が無かった。これは **#1268 が alternate-screen 系（claude / opencode / copilot）に対して直したのと同型の欠陥**で、あちらは pane 高で飽和し `usesAlternateScreen` という**ツール属性**で除外できたのに対し、こちらは scrollback を実際に持つツール（codex / gemini / vibe-local / antigravity）が**窓を超えた時点から**同じ状態になるため、除外は属性ではなく**実行時条件**でなければならない。**直したのは 4 点。** (1) `isCaptureWindowSaturated(capturedLineCount, windowLines)` を `tmux-capture-cache.ts` に置き、`extractResponse()` が **trailing blank を落とす前の raw 行数**で判定して `ExtractionResult.captureWindowSaturated` に載せる（切り詰めは `sliceOutput()` で起きるので、判定できるのは未トリムの行数だけ）。(2) `checkForResponse()` の重複判定を `lineCountIsCursor = !usesAlternateScreen(cliToolId) && !result.captureWindowSaturated` に変更（3 つの行数ゲートと race 再チェックが同時に効かなくなる）。(3) **内容ハッシュ dedup の分岐を `usesAlternateScreen` から `!lineCountIsCursor` へ広げた** — カーソルを止めるだけでは再保存を抑えるものが無くなり、完了済みの同じ応答を 2 秒ごとに追記して**バグより悪くなる**。(4) `resolveExtractionStartIndex()` に branch 2a''（飽和時は直近の user echo をアンカーにし、未検出なら窓全体）を追加。ゲートだけ直しても codex は branch 2b で `lastCapturedLine` から切り出すため、長い応答の**末尾数行だけ**が保存される。**対になる経路も点検した**: `current-output-builder.ts` の `lines.slice(lastCapturedLine)` も同じ前提に立っており、飽和時に `content` が 1〜2 行へ潰れて **`commandmate capture <id>`（`data.content` を出力）が実質空を返していた**ので、飽和時はカーソルを無視して全行返すようにした（窓は前へしか滑らないので 0 が唯一安全なクランプ、結果は superset で新規出力を落とさない）。`checkForResponse()` の `captureSessionOutput(..., 10000, ...)` というリテラルも定数へ寄せた（要求幅と判定基準が黙って乖離しうる）。**`CACHE_MAX_CAPTURE_LINES` は引き上げていない** — 飽和の原因は「バッファが伸びなくなること」自体なので、20000 に上げても pane 側が `TMUX_HISTORY_LIMIT = 20000` で飽和した時点で同じことが起きる。窓幅を引数で受ける形にしたうえで、小さい窓・`CACHE_MAX_CAPTURE_LINES`・`TMUX_HISTORY_LIMIT` の 3 つで同じ再発と同じ回復をテストで固定した。**顕在化した理由は #1624（v0.19.0）**: それ以前は `history-limit` が pane 生成後に設定されて実際には効かず、pane は tmux 既定の 2000 行しか保持していなかった。#1624 が生成前設定に直して 20000 行が本当に確保されたことで、長寿命の inline セッションが初めて 10000 行の窓を越えられるようになった（**#1624 は正しい修正であり、上限の不整合を露出させただけ**）。テストは実 `checkForResponse()` を駆動し、4 ツールそれぞれの実 pane 形（live `capture-pane` から採取）で「窓が張り付いたまま 3 ターン連続で保存されること」「**手で DB を直さずに**張り付いた `last_captured_line`（実測値 9999 を含む）から復帰すること」「同一ターン内の再 poll では重複保存しないこと」「次ターンの同一内容は保存すること」「**窓の下では行数カーソルが従来どおり効くこと**（`updateSessionState` が呼ばれないことで、拒否したのが行数ゲートであって空応答パスでないことまで特定）」を固定した。空振りでないことは変異注入 4 件で確認済み（飽和判定を殺す → 19 件赤／`lineCountIsCursor` を旧式へ戻す → 12 件赤／内容 dedup の分岐を `usesAlternateScreen` へ戻す → 2 件赤／branch 2a'' を殺す → 7 件赤）。**#1268 の回帰テスト（`response-checker-alternate-screen.test.ts`）は 1 行も変えずに実行し緑**。**Issue 本文との食い違い 1 件**: 本文は「`response-checker.ts:512` のガードが恒久的に真になる」を単独原因として挙げているが、実測では**ゲートを外すだけでは直らない** — codex は branch 2b で `lastCapturedLine` を開始位置に使うため、飽和状態では応答の末尾断片しか取れない（変異注入で赤になることを確認）。ゲートと抽出アンカーは**両方**必要で、加えて内容 dedup を広げないと再保存の暴走を招く。本件と #1671（完了判定が末尾 20 行の `• Ran` を活動中と誤認）は同じセッションで併発しており、本修正だけでは #1671 は残る

- **codex の完了判定が末尾 20 行に残る `• Ran` を活動中と誤認し、短い最終メッセージで終わったターンの応答が保存されなかった問題を修正** (#1671): `mcbd-codex-commandagent-develop` は 10:44 にターンを終えて idle になっていたのに、`checkForResponse()` が毎回 `!result.isComplete` で返り続け、その応答が Message History に永久に載らなかった。原因は `extractResponse()` の `isThinking` が `CODEX_THINKING_PATTERN` を**末尾 20 行固定の窓**に当てていたこと。codex は inline 描画（`alternate_on=0`）なので出力したステップ行は pane の scrollback に残り続け、**過去形の記録である `• Ran <cmd>` が窓から出て行かない**。結果、`hasPrompt = true` / `isThinking = true` → `isPromptBasedComplete = false` が固定する。最終メッセージが 20 行を超えたターンでは記録が窓の外へ押し出されて保存されるので、**応答が保存されるかどうかが最終メッセージの長さに依存していた**。**Issue 本文の根本原因の帰属は実測で 2 点訂正した。** (1) 本文は「実行中は `• Running` なので `Running` は活動中の指標として正しく、`Ran` だけを alternation から外せばよい」としていたが、**`• Running <cmd>` も同じく scrollback に残る記録である**（報告された pane の 11,000 行に `• Ran` 396 件・`• Running` 11 件、いずれも終了済みステップ）。`Ran` を落とすだけでは、背景コマンドの `• Running` 記録の直後に短い最終メッセージで終わったターンで同じ欠陥が再現する。(2) 実行中に codex が出す活動表示は `• Running` ではなく、composer の直上に固定される**ライブ行 `• Working (13s • esc to interrupt) · …`** である。そこで **`Ran` の削除ではなく、活動の判定そのものを「残留する記録」から「ライブ行」へ移した**: `isCodexTurnActive()`（`src/lib/detection/cli-patterns.ts`）が (a) 窓内の `esc to interrupt`、(b) composer 直上 `THINKING_TAIL_LINE_COUNT` 行内の活動マーカー、の 2 系統で判定する。(a) は使い捨て codex-cli 0.146.0 セッションの生成中フレーム 21 枚すべてに存在し、11,000 行の idle capture には**0 件**（in-place で再描画され、ターン終了と同時に消える。Claude の `CLAUDE_INTERRUPT_HINT_PATTERN` と同じ性質）。(b) は `esc to interrupt` の文言が変わった codex ビルド向けの版非依存の保険で、記録行が届かないよう狭く取ってある。composer が画面に無いフレーム（オーバーレイ表示中・再描画中）では従来どおり窓全体のマーカー照合へフォールバックし、「まだ活動中」側に倒す。**`CODEX_THINKING_PATTERN` 自体は変えていない** — `detectThinking()` 経由の status-detector / auto-yes-poller / submit-verified-sender と codex の `skipPatterns` は無変更（**対になる経路も点検した**: status-detector は同じ pane に対して既に `ready` と答えており、ポーラーだけが「思考中」と答え続けていた。両者の答えが一致するようになった）。#1670 の担当範囲（`lineCountIsCursor` 周りの dedup ガード・`response-extractor.ts`）には触れていない。テストは**使い捨てセッションの実 TUI capture をそのまま fixture 化**して固定した（`tests/unit/lib/detection/fixtures/codex-live-1671/`。稼働中のワーカーセッションは composer に入力途中のテキストが残るため使えない）: 実行中フレーム・短い最終メッセージで終わったフレーム・報告された本番 pane の末尾の 3 枚で、実 `checkForResponse()` を通した保存の成否、ポーリング継続時に同一内容を 1 回しか保存しないこと、実行中を完了と誤認しないことを固定している。fixture が空振りでないことは前提ガード（記録行が本当に窓内に残っているか等）で守り、変異注入 4 件で全て赤になることを確認済み（呼び出し元を元の窓照合へ戻す → 4 件赤 / ライブ行の判定を殺す → 1 件赤 / composer 直上の窓を 20 行へ広げる → 5 件赤 / composer 不在時のフォールバックを殺す → 1 件赤）
- **起動時の除外リポジトリ purge が、非破壊で無効化したはずの worktree を再起動のたびに消していた問題を修正** (#1666): #1658 が入れた「走査対象から外すだけ」の無効化は `UPDATE repositories SET enabled = 0` の 1 文で、worktree 行にも子データにも稼働セッションにも触らない。ところが `server.ts` の `initializeWorktrees()`（起動時に無条件で走る）が `excludedPaths` を回して `cleanupMultipleWorktrees()` で tmux セッションを kill し `deleteWorktreesByIds()` で行を削除していたため、**非破壊なのは次にサーバを再起動するまで**だった。露出するのは **`WORKTREE_REPOS` に列挙されたリポジトリだけ** — DB 登録のみのリポジトリは無効化すると `dbEnabledPaths` から外れて `allPaths` にも `excludedPaths` にも入らないが、env 由来のものは `allPaths` に残って絞り込みで落ち `excludedPaths` に入る。つまり**同じトグルが、リポジトリをどこで設定したかによって破壊的だったりそうでなかったりし、被害はクリックから 1 再起動ぶん離れて現れる**（#1658/#1659 の発端＝`CommandAgent` と `CommandAgent-develop` を両方 scan root に登録した形がまさに後者）。この purge は #202「除外したリポジトリの worktree をサイドバーから消す」の実装で、当時は `enabled = 0` に至る唯一の経路が purge 済みの `DELETE /api/repositories` だったため実質 no-op のガードだった。**監査ログ（`[excluded] <path>`）は残し、purge ループだけを落とした。** #202 の要件は捨てていない — **「見せない」は `visible`（#690 が概念分離として導入。サイドバーの絞り込みは `src/lib/sidebar-utils.ts` で `visible` のみを見る）、「走査しない」は `enabled` という分離に沿って、実装手段を行削除から `visible` へ移した**。除外されたリポジトリは scan されないので `syncWorktreesToDB` が行を作り直すこともなく、行削除は表示フィルタを履歴の破棄で実装したうえ再有効化で取り消せない。#1658 の確認ダイアログが既に「無効化しても worktree はサイドバーに残る／消したいなら Visibility トグル」と約束しているので導線も揃っている。**対になる経路も点検した**: `excludedPaths` を受け取る呼び出し元は `server.ts` と `POST /api/repositories/sync` の 2 つだけで、後者は `filteredPaths` しか分解代入しておらず元から破壊しない。起動時に走るもう 1 つの削除経路（`syncWorktreesToDB` の per-repo prune）は scan に現れた `repositoryPath` のグループしか回らないので無効化リポジトリには届かず、`pruneStaleRepositoryWorktrees` は sync ルート専用で起動時には走らない。`DELETE /api/repositories`（除外 + purge）は 1 行も変えていない。テストは **`server.ts` を import して実 `initializeWorktrees()` を走らせる**（`tests/unit/lib/startup-excluded-repository-purge.test.ts`）— 既存の `server-startup-exclusion-filter.test.ts` は同じ primitives をテスト側で手組みしており、**purge ループがそのすぐ下にあっても緑のままだった**ため。stub したのはプロセス境界（Next / HTTP サーバ / tmux トランスポート / `await import()` される 4 つの fail-open reconciler）だけで、再起動 1 回でも 3 回でも worktree 行・`chat_messages`・`tasks`・`verification_runs` が 1 行も減らないこと、`cleanupMultipleWorktrees`・`killWorktreeSession`・tmux の `killSession` に届かないこと、監査ログが出続けること、無効化パスが scan に渡らないこと、起動が `enabled` を戻さないこと、DB 登録のみの経路も無傷なこと、そして**実際に消えた worktree の prune は従来どおり効くこと**を固定した。空振りでないことは変異注入 4 件で確認済み（`git show HEAD:server.ts` で purge を忠実に復元 → 3 件赤 / 監査ログを落とす → 1 件赤 / `scanMultipleRepositories(filteredPaths)` を `allPaths` へ戻す → 1 件赤 / per-repo prune を無効化 → 1 件赤）。**Issue 本文と設計書 §4 の記述は実測で 2 点訂正した。** (1) 「`cleanupMultipleWorktrees` は他でも使われている」はリポジトリ全体では真だが **`server.ts` 内では偽**で、この import も削除が必要だった。(2) 「lint が未使用 import を弾く」は**偽** — `npm run lint` は `eslint src --ext …` で `server.ts` を対象にせず、`tsconfig.json` に `noUnusedLocals` も無い。実際に未使用 import を足して両ゲートを回し**どちらも exit 0** であることを確認したので、5 つの import は目視で落とした。`npm run test:integration` も exit 0 で実測（72 files / 1067 passed）。判断と根拠は `docs/design/repository-disable-gui.md` §6 に記録した
- **砂箱の後始末が `ENOTEMPTY` で落ち、無関係な PR の CI をランダムに赤くしていた問題を修正** (#1663): 落ちていたのはアサーションではなく `afterEach` の `rmSync(dir, { recursive: true, force: true })` で、PR #1660 では触ってもいない `gate-runner.test.ts` が `rmdir '/tmp/gate-runner-UwYY3F/.git/objects'` で落ち、再実行だけで緑になった。再帰削除は「ディレクトリを読む→見えた分を消す→自身を `rmdir`」なので、**読んだ後に書き戻しが起きると最後の `rmdir` が `ENOTEMPTY` を漏らす**（実 git を spawn するテストは git が `.git/objects` へ書くのと競合し、I/O の遅い CI ほど窓が広い）。**Node の `maxRetries`/`retryDelay` は必要だが不足**で、あのリトライは同じパスへ `rmdir` を再発行するだけで**走査をやり直さない**ため、走査済みディレクトリが中身つきで再生成されると全リトライが同じ理由で落ちる（変異注入で実証）。共通ヘルパ `tests/helpers/temp-dir.ts` の `removeTempDir()` が**再帰削除そのものを最大 4 回やり直し**（各回が木を読み直す）、内側の `maxRetries` は一過性の EBUSY/EPERM 用に併用する。**後始末の失敗は throw しない**（終わったテストの assertion は残骸で無効にならず、`afterEach` から投げること自体が直したい flake そのもの）代わりに、残骸パスを stderr（`[temp-dir] left behind sandbox:`）と `getLeakedTempDirs()` に出して黙って消し残さない。tests 配下の `{ recursive: true, force: true }` 削除 **135 箇所 / 69 ファイル**を機械的に置換した（Issue 記載の「68 箇所」は実測と食い違う）。再現テストは実 git に依存せず、worker_threads の実書き込みを走査に衝突させる（衝突しなかったラウンドは何も証明しないので破棄し、木を大きくして再試行する）
- **起動時 reconcile が「予測できなかったセッション」を数えずに成功として報告していた問題を修正** (#1661): 2026-08-03 の本番適用で `reconcile:complete {"renames":51,"renamedSessions":20,"skipped":0,"errors":0}` と報告されながら、稼働中の 2 セッションが旧名のまま UI から消えた（プロセスは生存）。`skipped: 0` は「取りこぼし 0」ではなく、**列挙されなかったものは数えられない**というだけだった。対象名を `agent_instances` × CLI ツール登録から**予測**して完全一致で照合する設計上、予測が再現しない名前は構造的に見えない。**「実在するセッション名から逆引きする」経路を足した。** 生存セッション名を `mcbd-<cli>-<id>[-<suffix>]` として読み、`<id>` を **DB が知っている ID の完全一致集合**（`worktrees` ∪ `worktree_aliases.old_id` ∪ その pass の pair）に**長い ID から**突き合わせる。前方一致には戻していない（#1156）— `<wt>-2` 自体が登録済み worktree なら `mcbd-claude-<wt>-2` は**その worktree** に解決して `<wt>` のリネームに巻き込まれず、登録が無ければ `<wt>` の 2 番目のインスタンスとして `mcbd-claude-<new>-2` へ追従する（`mcbd-claude-<new>` に乗ることは両方の読みで起こらない）。これが効くのは roster が実態を語らない場合で、**本番 DB では 70 worktree 中 45 件が `agent_instances` を 1 行も持たない**。あわせて**報告を分離した**: `planSources.predicted`（予測して実在を確認した数）/ `planSources.discovered`（逆引きでしか見つからなかった数）/ `unaccountedSessions`（実在するがどの既知 ID にも紐付かない `mcbd-*` セッション名の一覧）。最後の 1 つは 0 でなければ WARN として名前ごと出す（`server.ts` の起動ログにも出る）。**Issue 本文の原因記述は実測で 2 点訂正した。** (1) 「roster が空なので何も探さない」は誤り — `collectInstanceTargets` は**全 CLI ツールの primary instance を無条件に追加**しており（同ファイル、既存テスト `covers the primary instance of every CLI tool without any roster row` が固定）、`mcbd-claude-<oldId>` は roster が空でも予測される。roster の空白が効くのは**suffix 付きインスタンス**だけである。(2) 2 セッションが取り残された時点は**起動時 pass ではなく sync 経路**だった — 本番 DB の `schema_version` は v54 が 21:52:58、v55（#1658 の修正）が 23:48:59 で、その間の約 2 時間は #1658 未修正のビルドが動いており、`upsertWorktree` → `migrateWorktreeIdPreservingChildren` が sync のたびに当該 5 worktree の ID を伸ばしていた。この経路は alias を記録するが**セッション追従を一度も呼ばない**（`reconcileWorktreeSessions*` の呼び出しは `server.ts:294` の 1 箇所のみ）。21:52 の pass 自体は、当時の pair（`commandagent-develop-develop` → `commandagent-develop`）に対してセッションが既に**移行先の名前**だったため動くものが無かっただけで、報告は正しかった。**呼び出し点は増やしていない**（判断）: ID が起動時以外に動くのは `upsertWorktree` の中で、これは better-sqlite3 の**同期トランザクション**（`db.transaction()`）であり、tmux サブプロセスを起こす非同期の reconcile を await できない。正しい形は commit 後フックを持つ sync 側（`src/lib/git/worktrees.ts`）だが本 Issue の `scope.allow` 外のため、呼び出し元を持たない配線だけを足すことは避けた。**次回起動時に回復可能である**ことは alias 記録によって既に担保されており、本修正はその回復漏れ（roster 空白）を塞ぎ、回復できないものを WARN として可視化する。冪等性は維持している — 現行 ID を既に持つセッションは pair の**移行先**に解決し、移行先は source ではないので 2 回目の pass は何も計画しない（テストで固定）。検証は**本番 DB を read-only で開いて実コードを走らせ**（tmux は全面フェイク・リネームは 1 件も発行していない）、今日の収束済み状態では renames 0 / unaccounted 0、未記録世代のセッションを混ぜると WARN 2 件、roster に無い suffix 付きインスタンスを混ぜると `discovered: 1` で追従することを確認した。空振りでないことは変異注入 4 件で確認済み（逆引きプランを捨てる → 4 件赤 / unaccounted の記録を止める → 2 件赤 / 最長 ID 一致を最短一致にする → 3 件赤 / 既知 ID 集合を無視して素の前方一致にする → 7 件赤）。`npm run test:integration` も exit 0 で実測（72 files / 1067 passed）
- **同一 git リポジトリを 2 つの scan root として登録すると worktree ID が sync ごとに 8 hex 伸び続ける回帰を修正** (#1658): #1645（PR #1657）適用直後から、あるリポジトリの 5 worktree だけ ID が伸び続け、**81 文字**に達したところで ID から導出される tmux セッション名が実セッション名と乖離し **UI から稼働セッションが消えた**。原因は `syncWorktreesToDB` が既存 ID の引き当てを `getWorktreesByRepository`＝**`repository_path` スコープ**で行っていたこと。同一性キーは `path`（`worktrees.path` は `NOT NULL UNIQUE`）で、`repository_path` は「どの scan root が最後に upsert したか」しか表さない列である。`CommandAgent` と `CommandAgent-develop` は同一リポジトリの 2 worktree で両方が scan root に登録されており、`git worktree list` はどちらから叩いても同じ 5 パスを返す（実測）。1 回の sync が同じパスを 2 グループ分処理するため列が ping-pong し、後から回ったグループでは引き当てが 0 件 → 提案 ID も taken → `deriveWorktreeId` が走り、**自分の現 ID と自分の alias に衝突して digest の桁を 1 段ずつ伸ばす**（`foo` → `foo-2f4530fe` → `foo-2f4530fe1cf1f9f8` → …）。本番の alias 生成時刻（再起動直後 64 秒で 6 回・約 1 秒差で 2 件ずつ）と完全に一致する。**3 点を直した。** (1) **パスによる引き当てを横断化**（`getAllWorktreePathIds`）。同一 run 内で採番した ID も即マップへ載せるので、DB にまだ行が無い新規パスが 2 つ目の scan root から再訪されても再採番されない（初回 sync から発生していた）。(2) **再導出が自分の履歴に衝突しない**（`deriveIdIgnoringOwnHistory`）。横断引き当てにより通常この分岐へは落ちないが、落ちても「その行の現 ID＋その行を指す alias」を taken から除くので**収束**する（従来は単調増加）。(3) **migration v55** が伸びた ID を basename 由来へ畳み直す。畳めるのは「自分の履歴を除いて再導出した結果が現 ID より短い」行だけで、他の worktree の ID / alias は絶対に取らない（v54 と同じ規則）。退役する現 ID は alias 化するので churn 中に配られた URL も解決し続け、**梯子の中間段（`isDerivedWorktreeId` が真かつ着地 ID より長い alias）は削除**する — どれも同じ worktree を指し数十秒で置き換わった上、残すと採番器がその ID を永久に占有するため。`commandagent-develop-develop` / `commandagent-develop-detached-1c64d87f` のような本物の旧名は形が違うので残る。**prune の生存判定も scan 全体のパス集合に広げた** — どれか 1 つの scan root が報告していれば on-disk であり、片方の scan から消えただけの行を消して次のグループが新規行として作り直す（＝ID も履歴も失う）経路を塞ぐ。削除対象の**行集合は従来どおり repo スコープ**なので他リポジトリには及ばない。検証は隔離 DB（`CM_DB_PATH` を worktree 配下へ差し替え、本番 `data/db.sqlite` は未オープン）で本番同型の状態を再現して実施 — churn 6 周で 61〜77 文字・alias 31 件まで育てた DB に v55 を当て、5 行すべてが basename へ復帰・**alias 31 → 6 件**（移行前 ID 5 件＋本物の旧名 1 件、中間段 25 件を削除）・旧 ID すべて解決可能・chat 履歴追従・**その後 3 回 sync しても 1 文字も動かない**ことを確認した。空振りでないことは変異注入で確認済み — 引き当てを repo スコープへ戻すと再現テスト 6 件、prune の生存判定を repo スコープへ戻すと 1 件、v55 の自分-alias 除外を外すと 7 件、梯子判定を長さだけにすると 3 件が赤
- **bash 参照実装 `verify-run.sh` が実行契約を作業証跡として数えていた問題を修正** (#1651): 製品エンジンは `.commandmate/tasks/`（実行契約）を work-evidence の両方のカウンタから除外している（#1580）が、bash 参照実装には除外が無かった。オーケストレーターが契約ファイルを 1 件置いただけの worktree で `bash: RESULT passed (exit 0)` / `TS: RESULT not_started (exit 21)` と判定が食い違い、**bash が緩い向き**＝「エージェントは 1 行も書いていないのに作業が在ると報告する」経路が開いていた（#1544 以降ずっと塞いできた「見ていないものを合格として報告する」欠陥で、#1639 の requireCommit が閉じたものと同じクラス）。契約ファイルは**オーケストレーターの証跡であってエージェントの証跡ではない**ため、両カウンタから除外するのが正である。commit 側は `git rev-list --count <base>..HEAD -- ':(top)' ':(exclude,top).commandmate/tasks/'`（`:(top)` は除外だけの pathspec にしないためと、両パターンを cwd ではなくリポジトリルートに固定するため。契約だけを載せた setup commit は 1 コミット分の作業として数えない）、未コミット側は `git status --porcelain -z --untracked-files=all` を **NUL 区切りのエントリ単位**で解析し、エントリ内のいずれかのパスが契約ファイルでなければ作業として数える（契約を実作業へ rename した場合・その逆向きも拾う）。`-z` / `-uall` は必須で、人間向けフォーマットは空白を含むパスを C クォートし、rename を ` -> ` で連結し、既定の untracked モードは新規の `.commandmate/tasks/` を `?? .commandmate/` の 1 エントリに畳む — いずれもパスでないものを判定に渡す。解析は bash 3.2（macOS 既定）で動く `while IFS= read -r -d ''` と `R`/`C` の 2 パス読みで書いた。**pathspec を付けた副作用として、ファイルを 1 つも変更しない commit（`--allow-empty`）も数えなくなる**（git の履歴単純化。製品実装も #1580 以降そう振る舞っており、bash 側の fixture がこれに依存していたので実ファイルの commit に直した）。両カウンタが 0 かつ変更自体は存在する場合は、除外が効いたことを stderr に 1 行出す（`FAIL commits=0 uncommitted=0` をゲートのバグと読ませないため。stdout の機械可読契約は不変）。**conformance テストの pin は「一致する」側へ書き換えた** — 契約除外の pin を削除して MATRIX へ 5 行（契約のみ / 契約だけの setup commit / 契約＋実作業 / 契約を実作業へ rename / requireCommit との合成）として移し、もう 1 件の既知差分（未追跡ディレクトリを TS は `-uall` でファイル単位・bash は 1 エントリ）は `-uall` の移植で自然に解消したので同じく畳んだ。差分が「両方 > 0 のまま数字だけズレる」形は verdict の比較では見えないため、同テストは `commits=N uncommitted=N` を**数値として**突き合わせる block を持つ。bash suite にも 32 件のアサーションを足し（`MIN_ASSERTIONS` は 150 → 200）、空振りでないことは変異注入で確認した（commit 側 pathspec 除去 → bash 6 件＋conformance 3 件赤 / 未コミット側除外の除去 → bash 9 件＋conformance 2 件赤 / `-uall` 除去 → 10 件赤 / rename の 2 パス目を見ない → 1 件赤 / `-z` をやめて人間向けフォーマットを行単位で読む → 21 件赤）。skill 実体は `.claude/skills` / `.agents/skills` の両ルートへ byte-identical に置き、`sync-map.json` の pin も更新済み。**`Kewton/commandmate-skills` への移植は未了**（pin を更新したので対応表からは移植済みと区別が付かなくなる点を、`verify-run.sh` / `run-tests.sh` / `SKILL.md` の note に「counterpart は 0.2.0 のまま＝未移植」と明記した。移植と version bump は PM が別途行う）
- **新規 worktree への初回 `send` が「原因不明のサーバエラー」で落ちていた問題を修正** (#1637): 症状は `Error: Server error. Check server logs for details.`（exit 99）だけで、tmux セッションも `claude` プロセスも 1 回目の時点で既に生きていた。**起動に失敗したのではなく、15 秒以内に prompt を観測できなかっただけ**である（本番ログに `Claude initialization timeout (15000ms)` が 6 件）。3 点を直した。(1) **コールドスタートの実測とタイムアウト値**: 専用 tmux socket（`-L`）と本番と同じ検出述語（`Yes, I trust this folder` / `CLAUDE_PROMPT_PATTERN`）で計測したところ、idle・trust 済みリポジトリで **1443 / 1470 ms**、idle・新規ディレクトリ（trust ダイアログあり）で **1885 / 1896 / 1902 ms**、**6 本同時起動で 2845 / 3450 / 3488 / 4206 / 4215 / 4850 ms** だった。健全なコールドスタートは idle 約 2 秒・6 並列で約 5 秒なので、15 秒は並列時に対して 4 倍未満の余裕しかなく、オーケストレーション中（複数エージェント＋テスト＋ビルド）はここを使い切る。Issue の再現手順（30 秒後の再送は成功）が実際の ready 時間を 15 秒超〜45 秒程度と示しているので **`CLAUDE_INIT_TIMEOUT` を 60 秒**にした（codex が既に持つ約 33 秒の窓と同じオーダー）。健全系の待ち時間は増えない（prompt を観測した瞬間に抜ける）。加えて、待つ時間を延ばした分の副作用を消すため、init ループでも `isSessionHealthy()` と同じ終端エラーパターン検査を行い、**成功しえない起動は 60 秒を待たず即座に失敗**させる。**既存セッションへの送信は別の予算**（`CLAUDE_SEND_PROMPT_WAIT_TIMEOUT` = 10 秒）で従来どおり。タイムアウト時に**セッションを kill しない**点も維持している（再送が安価なのはこのため）。(2) **CLI に原因が伝わらない（本 Issue の中心）**: `src/cli/utils/api-client.ts` が 5xx を一律 `Server error. Check server logs for details.` に潰していた。原因は常にレスポンス本文の `error` に入っており（このリポジトリの全ルートが `{ error }` を返す）、クライアントは `code` を読むために本文を既にパースしていた — `error` を使っていなかっただけである。`handleApiError(error, status, payload)` に本文を渡し、5xx は `Server error: <サーバの理由>` を出すようにした（本文が無ければ従来の文言のまま）。4xx は CLI 自身のより具体的な文言（`Check the worktree ID` 等）を据え置く。あわせてサーバ側も、起動中のセッションを **500 ではなく 503 + `code: SESSION_STARTING`** で返し、「再送すれば直る」ことと `commandmate capture <id>` で様子が見られることを本文に書く。文面は tool 名・tmux セッション名・数値だけで組み立てているのでパスも生出力も含まず、SEC-SF-002（詳細はサーバログ、クライアントには generic）の例外として安全に通せる。(3) **`--contract` 失敗時の孤児タスク**: `send --contract` は送信前にタスク行を作るため、送信が失敗すると誰も作業していない行が残る。**PM 判断（行は消さず、送信失敗時に終端させ、後続の scope 解決の対象から外す）**に従い、状態機械で **`pending` + `send_failed` → `cancelled`**（初回送信が一度も届いていない＝judge すべき作業が無い）、**`running` + `send_failed` → `failed`**（作業は在るので #1620 どおり再 judge 可能）と行き先を分けた。行と `task_events`（`send_failed` / from=`pending`）は残るので監査証跡は失われない。**`failed` のままにできない理由**: `VERIFIABLE_TASK_STATUSES` は #1620 で意図的に `failed` を含んでおり（赤いゲートの後の再実行が契約を引けるように）、`getVerifiableTask` は**最後に更新された**行を返す。#1623 ではコールドスタートで失敗した `cbb7fe71` と、再送で成功し `succeeded` になった `88280de0` が並存し、`succeeded` は解決対象外・孤児は対象内だったため、後の `wait --verify` が**孤児の古い scope スナップショット**に当たって現行契約が許可しているパスを違反として **exit 20** を返していた。`cancelled` は `ACTIVE_TASK_STATUSES` にも `VERIFIABLE_TASK_STATUSES` にも属さないので、この経路が閉じる。**対になる経路の点検結果**: 初期化タイムアウトで `startSession()` が throw するのは **claude だけ**だった。codex / gemini / copilot / antigravity の `waitForReady()` はタイムアウトを log して**そのまま return** し（codex の窓は 3s + 30×1s ≒ 33s）、opencode / vibe-local は固定 sleep のみで readiness を待たない。失敗は後段の `sendMessage()` 側の `waitForPrompt()` が throw して 500 の本文に載るため、(2) の修正でこれらのツールでも原因が CLI に出るようになる。よってツール側のコード変更は行っていない。空振り検証として 5 変異（孤児を `failed` へ戻す／5xx の潰しを戻す／タイムアウトを generic 文言へ戻す／ルートを 500 へ戻す／予算を 15s へ戻す）を注入し、いずれも赤になることを確認済み
- **稼働中のサーバを旧 CLI が "Stopped (no PID file)" と誤報する前方互換の欠落を修正** (#1632): #1354 で `~/.commandmate/.commandmate.pid` の中身を bare integer から JSON state へ変えた際、パスは据え置いたまま形式だけを変えたため、PATH に残った旧 CLI（`readPid()` が `parseInt(content, 10)`）は先頭の `{` で NaN → 「ファイル無し」と解釈していた（#1354 の後方互換は「新 CLI が旧形式を読む」片方向のみだった）。`writeState()` を **1 行目 bare PID / 2 行目 JSON** のハイブリッド形式に変更し、`parseInt` が先頭の数字で停止する性質を使って前方互換を回復した。`readState()` も同時にハイブリッド対応させている（片側だけ直すと JSON.parse が失敗して `{pid}` のみに縮退し、`version` が落ちて #1354 の CLI↔サーバ版不一致警告が黙って無効化される）。旧 3 形式（bare int / JSON 単体 / ハイブリッド）の読み取りと O_EXCL アトミック書き込み・#1358 のプロセス同一性検証は不変で、旧 CLI 相当の `parseInt` ロジックで PID が取れることを固定 fixture のテストで担保した
- **ロガーのキー名マスクが機密でないフィールドまで `[REDACTED]` にしていた問題を修正** (#1640): `SENSITIVE_KEY_PATTERN` に `key` が単体で入っていたため、名前に `key` を含むだけのフィールドが軒並みマスクされていた。実害の代表例が読むモードの起動ログ `read-mode:ready {"key":"[REDACTED]"}`（#1623）で、実際の値は `g` — **そのログを読む理由そのもの（どのキーがバインドされたか）が伏せられていた**。同ファイルの値パターン側は当初から `(token|secret|api_key|apikey|auth)` と `key` 単体を除いており、キー名パターンだけが広かった。緩める変更なので、先に `src/` 全体（865 ファイル / ロガー呼び出し 619 箇所 / 構造化フィールド名 134 種）を TypeScript AST で洗い出してから変更している。**緩んだのは実測で `key`（`read-mode.ts` / `clone-manager.ts`）と `compositeKey`（`auto-yes-poller.ts`）の 2 つだけ**で、新パターンで新たに露出する機密フィールドは 0 件だった（現時点の `src/` には `token` / `password` 等の名前を持つログフィールドがそもそも 1 つも無い）。新パターンは `password|secret|token|auth` ＋ 資格情報を運ぶ `*key` 複合語（`api` / `private` / `access` / `session` / `signing` / `encryption` / `ssh` / `gpg` / `deploy`、`-`/`_` 区切り可）で、`apiKey` / `API_KEY` / `x-api-key` / `privateKey` / `accessKey` / `sshKey` 等は従来どおりマスクされる。`public` は**意図的に含めていない**（VAPID 公開鍵のように公開が前提の値まで伏せてしまうため）。`auth` は部分一致のまま残した — `(?!or)` で `author` を避ける案は `authorization` まで外してしまうので採らない。**Issue 本文が誤マスクの実例として挙げた `keyName` / `bindKey` / `idempotencyKey` / `sortKey` / `publicKey` は、実測ではいずれもロガーへ渡っていない**（`idempotencyKey` は skill install API の DB 監査カラム、`sortKey` は UI state、`publicKey` は VAPID API のレスポンス）ため、実際に巻き込まれていたのは上記 2 フィールドである。動的キーが混入しうる経路も点検済みで、ロガーへ非リテラルを渡すのは `logSecurityEvent` 1 箇所（呼び出し 4 箇所の実フィールドは `targetPath` / `resolvedTarget` / `resolvedLinkTarget` / `currentPath` / `resolvedAncestor` / `value`）、スプレッド 2 箇所は閉じた型（`ProxyLogEntry` / `SkillPlanSweepResult`）で、いずれも該当なし。値パターン側は不変なので、`{ key: 'token=tok_live_123' }` のように**良性のキー名に埋まった秘密は引き続き値側で落ちる**ことも回帰に固定した。空振りでないことは変異注入で確認済み — 旧パターン（`key` 単体）へ戻すと 11 件、`*key` 複合語を落とすと 15 件が赤

## [0.19.0] - 2026-08-03

> **Highlight**: **tmux セッションを「読める」「取りこぼさない」状態にし、Codex ワーカーに対して検証ゲートが機能していなかった穴を塞いだリリース。** attach しても transcript が一行も見えなかった 200×1000 キャンバスに、ジオメトリを一切変えないオンデマンドの読むモード（`prefix+g` の popup ページャと `capture --pane`）を足した。あわせて、`history-limit` が一度も pane に適用されておらず全セッションが tmux 既定の 2000 行で動いていた欠陥（稼働中の codex セッションが 1977/2000 で古い履歴を捨て続けていた）と、`wait` が未起動セッションを完了扱いして `--verify` の exit 0 が完走を意味しなくなっていた欠陥を修正した。

### Added

- **attach しても一行も読めない tmux セッションに、ジオメトリ非破壊の「読むモード」を追加** (#1623): 200×1000 のキャンバス（#1163）でカーソルが 997 行目に居座るため、attach しても可視域は空白と入力欄だけになる（実測: 72 行のクライアントで transcript 可視 **0 行**）。`prefix+g` で `display-popup` にレイアウト空行を畳んだ transcript を出す**案A**と、attach も tmux 3.2+ も要らない `commandmate capture <id> --pane [--tail N] [--raw] [--json]`（**案B**、tmux <3.2 のフォールバック）の 2 本立てで解決した。**ジオメトリと `capture-pane` の要求 argv は一切変えない**（Auto-Yes / status-detector / 応答保存が依存しているため、変異注入で赤を確認したテストで固定）。`bind-key` はサーバグローバルなので、`display-popup` 能力プローブ・`list-keys` による衝突検査（他人のバインドは上書きしない）・`#{m:mcbd-*,#{session_name}}` によるセッション名ガードを必須にし、いずれかに引っかかれば `bind-key` を 1 回も発行しない。キーは `CM_READ_MODE_KEY`、無効化は `CM_READ_MODE=off`（**前回導入したバインドを削除する収束型**。複数サーバが 1 つの tmux サーバを共有するため停止時 unbind は行わない）。空行圧縮は #1172 の Web UI 正規化と同一ルールで、TS 版・popup が実行する awk 版・#1172 版の 3 実装が実 capture 3 本に対しバイト一致することを conformance テストで固定した。5 件の未解決事項の決定と実測（Issue 本文との食い違い 3 件を含む）は [docs/design/1623-tmux-reading-mode.md](./docs/design/1623-tmux-reading-mode.md)

### Fixed

- **tmux セッションの scrollback が意図の 1/25（tmux 既定の 2000 行）しか確保されていなかった問題を修正** (#1624): `history-limit` はセッションオプションだが、**pane は生成時点の値でスクロールバッファを一度だけ確保する**。`new-session`（この時点で window 0 と pane ができる）の**後**に `set-option` していたため、`show-options` は 50000 を返すのに pane の `#{history_limit}` は 2000 のままという乖離が生じていた（実測: 稼働中の `mcbd-codex-*` セッションが 1977/2000 行と使用率 98.85% で、古い履歴を落とし続けていた）。影響を受けるのは scrollback を持つ非 alternate-screen ツール（codex / gemini / vibe-local / antigravity）で、claude / opencode / copilot は `history_size=0` のため無関係。`set-option` → `new-window -k`（window 0 を index を保ったまま作り直す）の順序に変更し、新 window は `window-size manual` を継承しないためジオメトリ設定（#1163）はその後に当てる。`respawn-pane -k` は pane が既存バッファを再利用するため効かない（実測）。あわせて値を **50000 → `TMUX_HISTORY_LIMIT=20000`** に見直した — `capturePane` の `execFile maxBuffer` が 10MB で、50000 行の SGR 込みテキスト（実測 274B/行 ≒ 13MB）はこれを超えて **throw** するため、50000 行の深部はそもそもアプリから読めなかった（アプリが読む最深は既定 10000 行、他の呼び出しは 1000 行以下）。根拠は `src/config/tmux-pane-config.ts` の定数 doc コメントに実測値つきで残してある。**既存の稼働セッションには適用されない**（pane を作り直さない限り 2000 のまま）: 稼働中 pane の再生成は実行中のエージェントプロセスを kill するため自動適用は行わず、**次回のセッション作成時から適用**する。今すぐ深い履歴が必要な場合はセッションを停止して作り直すこと
- worktree の ID 変更・削除が FK 宣言の無い `tasks` / `verification_runs` を取りこぼし孤児行を残していた問題を修正し、既存の孤児を migration v52 で掃除（#1621）
- **Codex が承認プロンプトで止まっている間に `wait` が完了扱いになる経路を塞いだ** (#1628): codex は承認要求（`Would you like to run the following command?`）を `/model` メニューと同じ "Press enter to confirm" フッタで描くため、#622 の selection-list 分岐が先に掴んで `hasActivePrompt:false` を返しており、`wait --on-prompt agent` は exit 10 を上げられなかった（実 codex 0.146.0 の 120 フレーム実測。detectPrompt 自体は常に検出できていたので Auto-Yes だけが応答できていた）。あわせて `wait` の `isRunning=false` が「終了した」と「一度も動いていない」を同一視していた問題を直し（未観測なら `Completed` ではなく exit 21）、arrow-key メニュー（codex pager・agy 権限メニュー等）を exit 10 として上げるようにした。work-evidence には `commits=0 uncommitted=1` を不合格にする opt-in `options.requireCommit` を追加（既定 false）
- `send --instance <id>` が roster の CLI_TOOL を引かず worktree 既定のツールでセッションを起動していた問題を修正（`--instance codex` で `mcbd-claude-…-codex` が立っていた）。`respond` / `capture` / `auto-yes` の同型経路も併せて解決するようにした（#1629）

## [0.18.0] - 2026-08-02

> **Highlight**: **検証と監視が「見ていないもの」を合格・完了として報告していた経路を塞いだリリース。** v0.17.0 で導入した検証基盤は、ワーカー自身が `commandmate verify` を回してタスクを終端させると、続く `wait --verify` が契約を引けずに **scope ゲートを SKIP し、その SKIP を集計にも数えず `RESULT passed` / exit 0 を返していた** — 宣言した scope を一度も judge していない run が合格を返す経路である（#1620）。「契約は在るがこの run が attach されていない」を区別し、**exit 99（判定に到達せず）でタスク ID を名指しする**ようにした。あわせてゲートの `started_at` / `finished_at` が実行時刻ではなく**記録時刻**だった問題を直した（#1625） — live DB では 168 gate 中 145 が同値、**6 分 24 秒かかった unit ゲートの開始と終了が同一ミリ秒**だった。行を実行の前に開き、かつ計測値を明示的に運ぶ**両方**を採ることで `finished_at - started_at === duration_ms` がミリ秒単位で厳密に成立し、副次的に、実行中に落ちたゲートを記録する reconcile 経路が**初めて到達可能になった**（従来は行そのものが残らなかった）。監視側も同型の欠陥を潰しており、タスク台帳を引けなかったことを空（＝契約なし）と区別できず推定のまま健全な COMPLETE を出していた問題（#1613）と、`git` の失敗を「作業ゼロ」と読んで未起動ワーカーを COMPLETE と誤報していた問題（#1614）を、いずれも終了コードの確認で塞いだ。2 リポジトリに同じスクリプトの実体を持つことによるドリフトは、ネットワークも cross-repo トークンも使わない pin 方式の対応表で検知する（#1612）。

### Added

- **CommandMate ↔ commandmate-skills の同期対応表とドリフト検知を追加** (#1612): 同じスクリプトの実体を 2 リポジトリに持ちながら、対応関係を宣言した場所も、ずれを検知する仕組みも無かった。`.claude/skills/sync-map.json` に対応表を宣言し、`tests/unit/skills/sync-map.test.ts` が最後に同期した時点の sha256 と working tree を突き合わせる。**ネットワーク・submodule・cross-repo トークンを一切使わない**（skills は個人リポジトリで CI から書ける token を増やしたくない）。分類は Issue 本文が提案した `identical` / `adapted` の 2 分類ではなく **3 分類**にした — 本文どおり `adapted` を検知対象から外すと #1613 と同じドリフトが再発するためである。実測では `orchestrate-monitor/scripts/**` は**バイト一致ではない**（コメント中の Issue 番号が CommandMate #1581/#1601 ↔ skills #1589/#1602 と食い違う）が、**コメントを除いたコード差分は 8 ファイルすべて 0 行**で機能変更は必ず両側へ移植しなければならない。よって `byte-identical`（逐語コピー必須）/ `port-required`（移植必須・バイト不問。編集すれば必ず鳴る）/ `local-only`（対応先なし・検知対象外）とし、**「バイト一致を要求しない」と「検知対象から外す」を分離した**。赤くなったときは移植先の具体的なパスと、赤を消す 2 通り（移植して pin を更新する／分類を変えて根拠を書く）を出す。対応表自体の腐敗も固定してある: `.claude/skills/` 直下の全ディレクトリがちょうど 1 回分類されること、対応のあるパッケージは配下の全ファイルを列挙すること、列挙したパスが実在すること。既存の `.claude/skills` ↔ `.agents/skills` ガード（`dual-placement.test.ts` / `mirror.test.ts`）とは役割を分け、内容比較はせず「`.agents` 側に `.claude` の同名がある」ことだけを固定して網羅性を担保する。`scripts/skills-sync-map.mjs` は pin 更新（`update`）に加え、手元に counterpart の checkout があるときだけ実 diff を取る `check --counterpart <dir>` を持つ — pin 方式が構造的に捕まえられない skills → CommandMate 方向（#1613 の向き）はここでしか見えない。`.md` のみのパッケージを対応表に**含めない**根拠も実測つきで残した（同名の `.claude/commands/*.md` とは共通する非空行が数百行中 1〜2 行しかなく、コピー関係にない）。詳細は [docs/skills-sync-map.md](./docs/skills-sync-map.md)

### Fixed

- **検証ゲートの `started_at` / `finished_at` が実行時刻でなく記録時刻になっていた問題を修正** (#1625): `gate-runner.ts` の `record()` が `createGateResult`（started_at = now）→ 即 `finishGateResult`（finished_at = now）をゲート**完了後**に連続で呼んでいたため、両方の打刻が同一ミリ秒に落ち、`finished_at - started_at` は `duration_ms` と無関係だった（実測例: `durationMs: 4010` に対し started と finished が同一ミリ秒）。履歴 API を読む側は「いつ走ったか」「どれだけかかったか」を timestamp から復元できない。**素朴な 2 案のどちらか一方では足りないため両方を採った**。(1) **行を実行の前に開く**（案 A）: `createGateResult` を spawn の前に呼ぶので実行中は `status='running'` の行が観測でき、途中で死んだときに**どのゲートで死んだか**が残る。これは #1543 の起動時 reconcile が持つ「開いたままの gate 行を error で閉じる」ループを**初めて実際に到達可能にする** — 従来 create と finish が隣接していたため、gate-runner 由来の行がそのループに掛かる窓は事実上存在しなかった（案 B 単独ではこの経路は到達不能なまま）。(2) **計測値を明示的に運ぶ**（案 B）: 行を開いた時刻は「ゲートに入った」ことの仮置きで実際の spawn はその数ミリ秒後になるため、`GateOutcome` / `ScopeOutcome` に `startedAt` を足し、`finishGateResult` の `executionWindow` で `started_at` を計測開始時刻へ上書きする。これで `finished_at - started_at === duration_ms` が**ミリ秒単位で厳密に**成立する（案 A 単独では DB 書き込み分だけ区間が広がり、不変条件がロード依存の近似になる）。**実行しなかったゲート**（`skipped` と config 読み込み失敗の擬似ゲート `config`）は**判断した瞬間を指す長さ 0 の区間**とした — `started_at` は NOT NULL で `finished_at = NULL` は既に「まだ閉じていない」の意味なので、NULL に「実行していない」を兼ねさせると意図的な skip と孤児行が区別できなくなる。この扱いなら不変条件が全ステータスで成立する。**既存行は UPDATE しない**（履歴の改竄）。復元不能な過去行を読む側が判別できるよう、**導出値** `VerificationGateResult.timingsMeasured`（カラムではない）を返す。判定は不変条件そのもので両方向に健全である — 修正後の行は構成上必ず真、修正前の行は 2 つの書き込みが隣接していたため区間が常に ~0 で、真になりうるのは `duration_ms` も 0 のとき＝記録時刻と実行時刻が同一の瞬間であるときだけである。`false` は「この打刻を所要時間として読むな」を意味し、#1625 以前の行・実行中の行・reconcile で閉じた行を覆う。**マイグレーションは追加していない**（カラムを増やさず導出で足りる）。**消費者の実測**: `report metrics`（`vibe-metrics.ts` の gate fail breakdown）は gate を `gate_id` の COUNT にしか使わず期間の絞り込みは **run 側の** `r.started_at`、Web UI に検証履歴を読むコンポーネントは存在せず、CLI `verify show` は run の started/finished と gate の `durationMs` しか印字しない。gate の timestamp を外に出しているのは `--json` の `VerificationGateResultView` だけで、唯一の実消費者である commandmate-skills の `cmate-verify-advisor` は run 側の timestamp と gate の `durationMs` / `exitCode` / `status` しか読まない（`durationMs` だけを使う回避を実装済み）。よって **product 内に gate timestamp の消費者はいない**。**run レベルの打刻は壊れていない**ことも確認した（`createVerificationRun` は実行前・`finishVerificationRun` は実行後で、gate の区間を包含する。回帰として固定した）。**裁定は不変**: gate status も run status も exit code も timestamp を使っていない。変異注入で空振りでないことを確認済み — 打刻を record 時点へ戻す（元の `record()` 形へ復元）と 4 件が赤（区間 0ms vs duration 400ms / タイムアウト 0ms vs 1004ms / work-evidence 1ms vs 17ms / `running` 行が観測できない）、`executionWindow` だけを外して案 A のみに戻すと 2 件が赤、`timingsMeasured` を定数 true にすると 4 件が赤。なお案 A のみの変異は in-memory DB では書き込みが 1ms 未満で終わるため素の計測では取り逃す（幸運で緑になる）ので、gate 行の INSERT を 60ms 遅らせる Proxy を噛ませて**決定的に**赤くなるテストを足してある

- **ワーカーが自分で verify するとオーケストレーターの `scope` ゲートが黙って無効化される問題を修正** (#1620): 契約は「ゲートが通る状態にしてから終えろ」と要求しており、それに従ったワーカーが `commandmate verify` を回すと、その run が契約タスクを `succeeded`（終端）へ遷移させる。その後にオーケストレーターが回す `wait --verify` は `taskId` を渡していなかったため `getActiveTask` が null を返し、**契約なしの run として `scope` が SKIP され、SKIP は集計から除外される設計なので `RESULT passed` / exit 0 が返っていた**（#1614 の実運用で発生。実測では 6 ファイルすべて `allow` 内で違反は無かったが、**取り逃したのは違反ではなく違反を機械が見る機会**である）。修正は 3 点。(1) **`wait --verify` / `--require-work` は待ち始める時点＝タスクがまだ active なうちに** `GET /api/worktrees/<id>/tasks?limit=1` でタスク id を読み、完了検知後の run に `taskId` として渡す（`POST /verify` は `taskId` を受け取り UUID 形式を検証する）。時点が要点で、エージェントが待機中に自己 verify でタスクを閉じても id は生き残る。最新タスクが**開始時点で既に終端なら束ねない** — 別の委任の契約を拾う危険を避けるためで、これが「`resolveTask` を最新タスクへ寄せる」案を採らなかった理由である（`hooks-task.sh` のコメント自身が同じ前提を PRECONDITION として危ぶんでいる）。(2) **サーバ側の防御**: run がタスクに結び付かず、しかしその worktree に scope を宣言した終端タスクが存在するとき、`scope` の `log_tail` を「契約が最初から無い」場合と**別の文言**（タスク id と status を名指しする `scopeSkipDetachedContract()`）にし、その SKIP を**集計に数える**（run は `error`）。**素の `commandmate verify`（契約が 1 件も無い worktree）は従来どおり `passed`** で、`requireScopeClean: false` と `pending` も従来どおり無害な SKIP のままである。(3) **タスク解決を `failed` / `not_started` まで広げた**（`getVerifiableTask` / `VERIFIABLE_TASK_STATUSES`）。状態機械は `verify_started` をこの 2 つから受理する（再実行で正当に開き直る）のに、id を知らない呼び出し元はその task を**見つけられなかった** — つまり「ゲートが赤 → 直す → もう一度 verify」という最も普通の往復でも同じ穴が開いていた。`getActiveTask` は Auto-Yes・プロンプト事象用に active 3 状態のまま。**対になる経路の点検結果**: `task = null` のとき `resolveContractGateIds` は `gateIds` を undefined に落とすが、これは verify.yaml の**全ゲートが走る**＝コマンド系ゲートについては厳しくなる方向で、緩むのは scope の判定と `requireScopeClean` だけだった（`requireWorkEvidence` も既定選択では常に true なので緩まない）。`getActiveTaskForInstance` を使う Auto-Yes ポリシー（`src/lib/polling/auto-yes-policy.ts`）はタスクが閉じると契約の `denyPatterns` が外れるという同型の性質を持つが、これは契約なしセッションを縛らないための設計であり、本 Issue の scope 外として据え置いた

- **`orchestrate-monitor` が外部コマンドの失敗を「作業ゼロ」「判定なし」と取り違えていた問題を修正** (#1614): `hooks-git.sh` は `git ... | wc -l` で数えていたため **pipeline 後段の終了コードが採用され、`git` の失敗が `0` として出て**いた。`git worktree list --porcelain` に至ってはヒアドキュメント内の command substitution で終了コードが到達不能で、空の record 集合が「該当 worktree 無し」と区別できず **commit と uncommitted の両カウンタが同時に 0 へ沈む**。その結果、完走したワーカーが `NOT_STARTED` と報告され続け、オペレータは「git が失敗した」と「ワーカーが何もしていない」を区別できない。さらに `monitor.sh` は `capture` の終了コードだけを見ており、その 8 行下の `classify-state.sh` と完了判定の `verify-completion.sh` は見ていなかった。**起票時の影響評価 2 件は実測で覆った**: (1) 「誤 COMPLETE は起きない」は誤りで、`classify-state.sh` が落ちると空 state が `verify-completion.sh` へ渡り、生存信号とみなされずヒューリスティクスへ落ちる — `--started 1 --state '' --idle-streak 10 --idle-threshold 5 --commits 2` は **COMPLETE**（bash 3.2.57 実測）で、**稼働中のワーカーが COMPLETE と報告されうる**。(2) 現行の `wc -l` は過少計数して**いない**（0 件→0 / 1 件→1 / 2 件→2）。過少計数は「終了コードを見るために出力を先に変数へ受ける」修正形で初めて起きる（`$()` が末尾改行を落とすため 1 件→0）ので、数え方は `printf '%s' "$out" | grep -c . || true` を採用し、0 件 / 1 件 / 複数件の 3 サイズを回帰で固定した（`|| echo 0` は 0 件で `"0\n0"` になる）。失敗時のカウンタ値は 0 のまま（`commits=0 && uncommitted=0` は完了判定を COMPLETE を出さない側にしか倒さない）だが、**黙った 0 ではなく**原因ごとに **worker あたり 1 行**を stderr へ出す（毎ポーリングは出さない。既存の base-ref 警告と同じ粒度）。worktree-id が checkout へ解決できないケースも同じ粒度で報告する。`monitor.sh` は `CLASSIFY` / `VERIFY` の終了コードと空出力を `capture` と同じ扱いにし、前者はポーリングを捨て、後者は判定に使った入力ごと報告する（`case "$verdict"` に default が無く、従来は無言で素通りしていた）。**同じ欠陥がコード差分 0 のまま `Kewton/commandmate-skills` にも存在した**ため両リポジトリを同時に直し（skills は `cmate-orchestrate-monitor` 0.4.0）、#1612 の sync-map で pin が実際に赤くなってから移植し、移植後に update して緑に戻した — **この仕組みが空振りでないことの実運用での最初の証拠**である。空振り検証として 7 変異を実測（classify ガード削除で実際に `COMPLETE` が出ること、`git` 失敗と真の作業ゼロが**別テスト**で赤くなること、数え方を `wc -l` へ戻すと 1 件以上の計数が崩れることを含む）
- **`orchestrate-monitor` がタスク台帳の到達不能を検知できていなかった問題を修正** (#1613): `hooks-task.sh` の `read_task_status` は `$CM task list` を `head` にパイプしていたため終了コードが `head` のものに潰れ、**「台帳が答えた／この worktree に契約は無い」と「台帳に訊けなかった」が同じ空文字**になっていた。完了判定の一次ソースが丸ごと消えてもログは正常時と全く同じで、monitor は推定モードのまま COMPLETE を出し続ける。`commandmate-skills` の `cmate-orchestrate-monitor` 0.3.0 に入っていた 3 値化を移植し、`read_task_status` は `<status>` / `""` / `unavailable` を返すようにした。`unavailable` は **TaskStatus ではない**ので、この値を知らない `verify-completion.sh` に渡っても裁定に使われずヒューリスティクスに落ちる。`monitor.sh` は `unavailable` を worker ごとに 1 度だけ `FALLBACK MODE` として報告し、以降は空文字と同じ扱いにする（ポーリング自体は続くので、復帰したサーバは次の poll から拾える）。あわせて poll 行の `task=` は **値があるときだけ末尾に付く**ようにした（`task=-` は「読んでいないのに読んだ形をした値」であり、契約なし委任の poll 行を台帳導入前と 1 バイトも変えないため）。develop `a46845c7` 実測では、未知 worktree が exit 99 / `Resource not found.`、サーバ未起動が exit 1 / `Server is not running.`、**既知 worktree でタスク 0 件は exit 0 のまま stdout 空**であり、この最後の 1 つがあるため 「空 stdout = 異常」にはできない（判定は終了コードで行う）。既存テスト 2 件が現在の欠陥を固定していたので、`monitor-task-source.test.ts` の「非 0 終了も空」と `monitor-observability.test.ts` の `task=(\S+)` 必須 regex を新仕様側へ直した。コメントを除いたコード差分は 8 スクリプトすべてで 0 行（コメント中の Issue 番号と repo 文脈は CommandMate 側の表記を維持）
- **`cmate-verify` のゲート失敗理由が CI ログに一切残らない問題を修正** (#1607): `verify-run.test.ts` が CI で 1 度だけ赤くなったとき、残っていたのは `not ok - parsing: ...` の 3 行だけで、**なぜ落ちたのかを追う手段が無かった**。理由は 3 段で落ちていた — (1) `verify-run.sh` は失敗ログを stderr にしか出さず（stdout は machine-readable 契約）、**しかも log が空だと `emit_log_tail()` が無言で return する**、(2) `run-tests.sh` の `run_verify()` は stdout/stderr を `out.N` / `err.N` に分離するが assertion は `out.N` しか見ず、`err.N` は sandbox ごと EXIT trap で消える、(3) vitest ラッパが suite 出力を `not ok` 行だけに縮約していた。修正は主に harness 側で、`run_verify()` が **exit code ≠ 0 のときだけ** stderr を `out.N` に追記し（stdout/stderr の分離自体は契約なので維持）、失敗した assertion が `out.N` の path と中身を両方出し、vitest ラッパが suite 出力を**縮約せず**失敗メッセージに載せる。`verify-run.sh` 側では FAIL / TIMEOUT で**必ず理由行を出す**ようにし、出力ゼロなら `no output captured`、`maxLogTailBytes: 0` なら `log tail disabled` と明示する。出力ゼロで exit 126/127 のときは「コマンドが起動できていない可能性」を**手がかりとして**追記する（断定ではない）。stdout の契約が壊れていないことは `assert_stdout_contract`（stdout の全行が `GATE ...` / `RESULT ...` のいずれかであること）で固定した。**なお元の CI 失敗は再現していない**（parsing fixture を 4 burner 下で 100 回、`set -m`/pgid probe を 500 回で異常なし）。Issue 本文の仮説（`set -m` + watchdog レース）は実測と噛み合わないため実装から外している — parsing ゲートに `timeoutSec` は無く既定 600s だが CI の失敗は約 2.1s で起きており、`set -m` が効かない場合の劣化モードは「timeout 時に孫を取り逃す」側であって「瞬時に終わるゲートが false FAIL する」側ではない。本 PR の成果物は再現ではなく**次に起きたときに原因が読めること**である

- **`send --contract` が引数検証より先に task 行を作ってしまう問題を修正** (#1608): `commandmate send <id> --contract ... --auto-yes --duration 2h` は `Task created: <uuid>` を出したうえで `Error: Invalid duration. Must be one of: 1h, 3h, 8h` で exit 2 しており、**メッセージは送られていないのに task 行だけが `pending` で残っていた**。`send.ts` の action 冒頭には worktree ID / `--contract` と message の排他 / `--agent` / `--instance` / `--register` / `--stop-pattern` / `--model` の検証が並んでいるが、**`--duration` だけがそこに無く `enableAutoYes()` の中で検証されていた**。`--contract` の task 作成（`POST /api/worktrees/:id/tasks`）は `enableAutoYes()` より先に走るため、同ファイルが #1545 で掲げていた「副作用のあるものより前に検証する」原則から `--duration` だけが漏れていた。検証を `resolveAutoYesDurationMs()` として冒頭の検証群へ移し、`enableAutoYes()` は検証済みのミリ秒を受け取るだけにした（作成済み task を後から cancel する方式は状態機械が複雑になるため採らない）。`--stop-pattern` / `--model` と同様に **`--auto-yes` の有無に関わらず検証する**ため、`--duration 90m` のような値が黙って捨てられることもなくなった（従来は `--auto-yes` が無いと未検証のまま無視されていた）。送信前に判定できる他の引数（worktree ID / `--agent` / `--instance` / `--register` の `--instance`・`--agent` 要件 / `--stop-pattern` 長 / `--model` と agent の組み合わせ）は**すべて既に冒頭にあり修正不要**であることを確認し、9 ケースの表駆動テストで「不正なら HTTP リクエストを 1 本も出さずに exit 2」という対称性を固定した。既存の「契約が不正なら送信しない」挙動も回帰テストで固定している

- **`catalog:refresh` が削除済み行・alias 行をコマンドとして再追加する問題を修正** (#1603): claude docs の `| Command | Purpose |` 表は「現行 built-in の一覧」ではなく、**旧 CLI 向けの履歴行と alias 行が混在**している。パーサが min-version しか読まず max-version を無視していたため、`--check` が `/pr-comments`（"Removed in v2.1.91"）と `/vim`（"Removed in v2.1.92"）を**説明文が自身の削除告知であるコマンド**として追加候補に載せ、`/cost` `/stats`（`Alias for /usage`）も候補に含めていた（#1503 で消した幻コマンドの一部が復活する経路）。provider 出力を構造化し（`maxVersion` / `status` / `aliasOf` / `kind`）、engine 側で **active かつ canonical な行だけを auto-add** するようにした。判定は「セル**先頭**の max-version note」または「"Removed in vX" 文言」の二重シグナルで、`/agents` のように**セル途中**に max-version note を持つ現役コマンドは現役のまま残す（name だけの永久 denylist だと復活した `/agents` と旧 `/agents` を区別できない）。あわせて (1) MDX note 除去が残す先頭空白で badge 除去 regex が `^` に効かなくなり `/simplify` の説明が **"Skill" の 1 語**に潰れていた transform 順序バグを修正（除去→trim→badge）、(2) badge 残骸や `Removed in` / `Alias for` で始まる marker 的説明文は捨てて placeholder にする suspect-description ガードを追加、(3) **同一 `descriptionKey` に tool 間で異なる説明が来たときの先着勝ちを廃止**（provider 順が claude→codex 固定のため、claude の "Removed in v2.1.92" が codex の `/vim` の辞書エントリを汚染しうる）。`--check` は拒否理由を `removed-row` / `alias-row` / `suspect-description` / `description-conflict` の 4 カテゴリで出力する（実測: 履歴 2 件・alias 2 件を拒否し、`/ide` `/rename` `/btw` `/copy` `/theme` `/stop` の 6 件で claude と codex の説明食い違いを検出）。`src/config/slash-commands-catalog.json` 自体は変更していない（109 件の追加候補の選別は別作業）

- **orchestrate-monitor の介入が 1 回も届かず、しかも「送った」と記録されていた問題を修正** (#1601): `monitor.sh` の既定が `SESSION_PREFIX="cm"` だったため、承認 Enter / rate limit の `a` / リトライ枯渇後の再送は**すべて実在しないセッション `cm-<worktree-id>` 宛**に撃たれていた（実セッション名は `mcbd-<cliToolId>-<worktreeId>[-<instance suffix>]`）。3 箇所の `tmux send-keys` は `2>/dev/null || true` で失敗を握り潰し、ログは送信の**前**に「送った」と出し、承認カウンタも送信**前**に加算していたため、**空振りが成功として記録され、一度も承認していないのに `approvals=` が増える**という三重の隠蔽になっていた。既定値を変えるだけでは不十分（単一の固定 prefix は claude と codex の混在フリートにも `--instance codex-2` にも同時に一致しない）なので、**連結をやめて capture ペイロードの `cliToolId` からの導出に変更**した。`cliToolId` はそのポーリングでサーバが解決したツールそのものなので、**分類したペインへ介入するという不変条件が構造的に保たれる**。あわせて (1) 送信前に `tmux has-session` で存在を検証し、失敗を stderr へ `NOT delivered` として報告、(2) ログは送信の**結果**を書き、承認カウンタと再送予算は**配信できたときだけ**動かす、(3) 宛先を `=<name>:` の exact match（#1156）にして停止中 primary 宛の入力が `-2` インスタンスへ漏れるのを防止、(4) ワーカー指定に `<worktree-id>@<instance-id>` を追加し、capture 側（`--agent`/`--instance`）と送信先の両方を同じ instance で切り替え（状態とログのキーも `<id>@<instance>` に分離）、(5) worktree id / instance id を tmux へ渡す前に検証（不正なら exit 2）、を入れた。`--session-prefix` は後方互換として残し、明示時は導出された `mcbd-<cliToolId>` の頭のみを置換する（instance suffix は維持）。介入先はワーカーごとに 1 回 `intervention target = <session>` として stdout に出る（誤配送を「最初の介入が必要になる前」に可視化するため、既定出力に 1 行だけ追加）。緑が空振りでないことは 6 変異（既定を `cm` に戻す / 存在検証を外す / カウンタを送信前に戻す / ログを送信前に戻す / ツール id 一覧を欠落させる / exact match を外す）で確認済み。あわせて **`--session-prefix` に `mcbd-claude` を渡すよう案内していた既存ドキュメント 4 箇所を是正**した（`.claude/commands/orchestrate.md` の実行例と exit 21 切り分け手順、日英 `docs/**/user-guide/workflow-examples.md` の実行例）。prefix を渡すと `ml_session_name()` が `cliToolId` からの導出を丸ごとバイパスするため、**この案内に従うと codex / copilot のワーカーまで claude 扱いに固定され、#1601 が直したのと同型の誤配送になる**（`--session-prefix` は導出できないセッション向けの escape hatch であり、混在フリートでは使わない旨を明記した）。同じ 3 箇所に `<worktree-id>@<instance-id>` 指定の案内も追加している。

## [0.17.0] - 2026-07-31

> **Highlight**: **「完了したが壊れていた」の検出を、人間の目視から exit code へ移したリリース。** 実行契約（`.commandmate/tasks/*.yaml`）・検証ゲート（`commandmate verify` / `wait --verify` の exit 0/20/21）・TaskStatus 状態機械・Eval メトリクスという検証基盤一式を導入し（Epic #1539）、それを `/orchestrate` と `/work-plan` の委任経路へ配線して**既定で検証が走る**状態にした（#1580 / #1581 / #1582 / #1583 / #1593）。契約ファイル自身が「作業証跡」に数えられて未着手検出（exit 21）を殺す問題は、work-evidence の commits / uncommitted と scope の committed / uncommitted という**対になる 4 経路すべて**で塞いでいる — 隔離環境の実機 UAT で、契約・`verify.yaml`・実作業の 3 パスがある worktree に対し `changed=2`（契約のみ除外され `verify.yaml` は数えられる）となることを実測した。あわせてチュートリアル・LP・プロダクト紹介の動画/GIF 素材（#1553〜#1577）と Skill 配布まわりを揃えた。

### Added

- **ワーカー委任の標準経路を契約付き `send` + `wait --verify` に変更し、監視の完了判定をタスク状態に切り替え** (#1581): 検証基盤（#1539 で実機認定済み）は完成していたのに、委任レシピ（`.claude/commands/orchestrate.md` と orchestrate-monitor skill）は素の send + capture 解析のままで、**既定では検証機構が一度も使われなかった**。`orchestrate.md` の Phase 3 を「契約起案（Phase 2-4 で新設）→ `send --contract` → `wait --on-prompt human --verify` → exit code 分岐」へ書き換え、exit `0`/`20`/`21`/`10`/`124` の対応表と、20 の再指示上限 2 回・21 の切り分け手順（composer 未確定／権限プロンプト／未起動）を明文化した。Phase 5 の「ワーカーに lint/tsc/test を実行させて報告文を読む」も `commandmatedev verify --json` に置き換えている（報告文の解析こそ exit code が置き換えた当のもの）。`verify-completion.sh` は **完了判定の一次ソースをタスク状態に変更**し、capture 由来のヒューリスティクスをフォールバックへ降格した（#1539 設計原則 4）。**終局ステータスを 3 分岐にしたのが要点**で、`succeeded`→`COMPLETE` / `failed`・`cancelled`→**新トークン `VERIFY_FAILED`** / `not_started`→`NOT_STARTED`。ゲート不合格のワーカーは commit も idle streak も「完了」に見えるため、capture 由来の信号だけでは合格と区別できず、`COMPLETE` 一本ではマージ判断に使えなかった。**評価順は「生存ペイン → タスク状態 → capture ヒューリスティクス」**で、`GENERATING`/`PROMPT`/`RATE_LIMIT` をタスク状態より先に置いたのは `task list --limit 1` が最新タスクを返す以上、過去の契約のあとに素の send をした worktree では古い裁定を読みうるため（生成中のワーカーを COMPLETE と誤報する経路）。**未終局ステータス（`pending`/`running`/`waiting_input`/`verifying`）と空・未知は必ずフォールバックへ落とす** — 特に `running` は重要で、`send` は送信直後にタスクを running にするので composer に Enter が入らなかったケースが永久に running のまま残り、これで判定すると STARTED ガードの回帰（#1512）をそのまま戻すことになる。データ供給は既存の hooks 機構に合わせて `hooks-task.sh` を新設し、`--hooks` を**繰り返し指定可能**にした（作業量は hooks-git.sh、タスク状態は hooks-task.sh と、契約付き運用では両方要るため）。フックを渡さなければ既定出力は 1 バイトも変わらない。Issue 本文との差分 3 点を実測側に倒している: (1) 本文の「`scripts/tests/` の fixture テストを更新」は**誤り**で、`.claude/skills/orchestrate-monitor/scripts/tests/` は存在せず実際の置き場は `tests/unit/skills/orchestrate-monitor/`（`npm run test:unit` は `vitest run tests/unit` なので `.claude/skills/**` に置いたテストは CI で一度も走らない）、(2) 本文は一次ソースの参照手段として API しか挙げていないが **CLI の `task list` / `task show` が実在**し、シェルからは CLI が素直（base URL と認証トークンの解決を CLI が持っている）。**`task list <worktree-id>` は worktree だけで引ける**ので、`send --contract` が stdout に出す task id を監視ループへ渡す必要が無い — #1539 認定 worktree に対する実測で `succeeded` / `failed` / `not_started` の 3 行が新しい順に返り、タスクが無い worktree では stdout が空・通知は stderr であることも確認した（この「空 = 無回答」がフォールバックの入口になる）、(3) 本文は素の send 4 箇所（170/210/216/277 行）をすべて契約付きへ置き換えよとするが、**Phase 2.5（根本原因分析）は契約に載せられない** — `wait --verify` は `gateIds` 未指定で `selectGates()` が `runWorkEvidence: true` を返すため work-evidence が必ず走り、コードを変更しない分析依頼は**成功するほど exit 21 になる**。Phase 2.5 は素の send のまま残し、その理由を本文に 1 段落書いた。本文の行番号（170/210/216/277/181/236）は再検証して**すべて一致**していた。`hooks-task.sh` は `cut -f2` の結果を製品の `TASK_STATUSES` で allow-list してから返す（`cut` はタブが無い行では行全体を、列が入れ替われば別の列を返すので、旧 CLI のエラー文が「ステータス」として到着しうる）。日英ドキュメント（`docs/user-guide/workflow-examples.md` と `docs/en/user-guide/workflow-examples.md`）に契約付き並列開発フローを 1 節ずつ追加し、`.agents/skills/orchestrate-monitor` は存在しないためミラーは作っていない。**副次的に monitor.sh の既定 `--session-prefix cm` が実セッション名と一致しない**ことを実測で見つけた（`tmux ls` は `mcbd-claude-<worktree-id>`、生成元は `src/lib/session/claude-session.ts` の `getSessionName()`）。`tmux send-keys` の失敗は `2>/dev/null || true` で握り潰されるため、既定のまま回すと承認 Enter も rate limit の `a` も再送も**1 回も届かないまま監視だけが続く**。既定値の変更は #1581 のスコープ外（`monitor-resend.test.ts` が `cm-w1` を固定している）なので**振る舞いは変えず**、SKILL.md・orchestrate.md・日英ワークフロー例のすべての実行例に `--session-prefix mcbd-claude` を入れ、SKILL.md には実測して渡す理由を書いた。exit 21 の切り分け手順では `commandmatedev respond "$WT" ""` を書きかけたが、`respond.ts` が空文字を exit 2 で弾くことを実測して `tmux send-keys -t "mcbd-claude-$WT" Enter` に直している。全 8 本の .sh が `bash 3.2.57` で `bash -n` 通過（連想配列・mapfile 不使用、空配列は `${#arr[@]}` ガード経由でのみ展開）。タスク状態分岐の無効化・`failed`→`COMPLETE` 化・生存ペイン veto の順序戻し・allow-list 除去・`--hooks` の last-wins 化・poll 行からの `task=` 削除という 6 種の変異注入で、該当テストだけが赤くなることを実測済み（それぞれ 6 / 3 / 3 / 4 / 1 / 10 件）。

- **検証履歴の read API（`GET /api/verification/runs`・`/runs/:runId`）と `commandmate verify history` / `verify show`** (#1593): verify.yaml の継続改善（#1594）が前提とする一次データの供給口を作った。**Issue 本文の現状認識 1 点を実測側に倒している** — 本文は「現状の API は検証の起動と集計のみで、ラン単位・ゲート単位の履歴を外部から参照できない」とするが、`GET /api/worktrees/:id/verify/runs` と `GET /api/worktrees/:id/verify/runs/:runId` は #1543 で既に実在する。実際に欠けていたのは (1) **worktree 横断**の一覧、(2) 期間フィルタ、(3) 一覧レスポンスへのゲート verdict 同梱（既存の worktree 別一覧は gate results を一切返さない）、(4) CLI 経路の 4 点で、既存 2 本は据え置き新設 2 本を追加した（棲み分けは「この worktree で何が起きたか」対「このリポジトリで何が起きたか」で、verify.yaml のチューニングが実際に問うのは後者）。DB 層は `listVerificationRunsForPeriod(db,{worktreeId?,days?,limit?})` を追加し、順序契約は既存 `listVerificationRuns` と同じ `started_at DESC, id DESC` を踏襲した（本文記載の `getVerificationRun` 286 行 / `listVerificationRuns` 357 行は実測と一致）。**一覧は logTail を型からも SELECT 列からも外している** — `null` を返すのではなく**フィールドごと存在しない**ようにしたので、500 run 分のログ末尾（MB 級）が一覧に混ざることは SQL の段階で起こり得ない。この「含まれないこと」はレスポンス型の目視ではなく、`not.toHaveProperty('logTail')`・キー集合の完全一致・シリアライズ後の全文検索の 3 通りで DB 層と API 層の**両方**に固定した。`days` / `limit` は DB 層では**クランプ**（読み取り専用フィードで、10000 件要求は「取れるだけ欲しい」の意）、API 層では範囲外を **400**（ユーザのタイポは黙って丸めるより弾く方が親切）と非対称にしてある。`worktreeId` はパスではなく**フィルタ**なので該当なしは 404 ではなく空配列。CLI 側は本文のフィールド指定（日時 / worktree / trigger / status / 失敗ゲート名）に**先頭の `#<run-id>` を足した** — これが無いと一覧から `verify show` へ辿る手段が無く、一覧が読めても使えない。`history` / `show` は **20 / 21 を返さない**（この 2 つは「今のツリーが検証に落ちた」の意で、過去の run への問い合わせは現在のツリーへの判定ではない）ため、引数不正 2 / 404 は 99 / 該当 0 件は exit 0（人間向けは stderr に一行、`--json` では常に `[]`）に割り当てた。実装上の落とし穴を 1 つ踏んでいる: commander は同名フラグを**先に宣言した親**に束縛するため、`verify` が run モード用に持つ `--json` / `--token` が `verify history --json` の指定を吸い、サブコマンド側は既定値のまま human 出力を出す（root program の option scoping を変える `enablePositionalOptions()` は全コマンドの解析に波及するので採らず、`command.parent.opts()` へのフォールバックで局所解決した）。ログ本文の一覧への混入・親フラグ継承の切断・期間フィルタの無効化・`skipped` の失敗ゲート扱い・404 特別扱いの除去・limit 範囲検証の除去という 6 種の変異注入で、追加したテスト 90 件のうち該当分のみが赤くなる（4 件 / 7 件 / 8 件 / 1 件 / 4 件）ことを実測済み。`npm run lint` / `npx tsc --noEmit` / `npm run test:unit`（727 files・13003 tests）/ `npm run build:cli` / `npm run build` すべて exit 0。

- **/work-plan の成果物に実行契約（`.commandmate/tasks/issue-<N>.yaml`）の起案を組み込み** (#1582): 実行契約（正準仕様 `docs/design/task-contract.md`）は「達成条件・変更可能範囲・検証ゲートを着手前に宣言する」レビュー対象の成果物だが、`/work-plan`（`.claude/commands/work-plan.md`）は人間向けの計画テキストしか出さず、契約はどの工程でも作られていなかった。「8. 実行契約の起案」を新設し（キー別の書き方の表・契約エラーになる書き方・契約の置き場所と運用）、成果物チェックリスト／出力先に契約を追加、出力フォーマットに v1 の雛形 yaml を 1 本置いた。ja/en の `docs/user-guide/commands-guide.md` も /work-plan の出力内容・出力先を対で更新している。**Issue 本文の列挙から必須キー `title` が漏れていたため雛形と表に追加した** — `contract-parser.ts` の `validateText` は `title` を非空文字列として必須にしており、本文のフィールド列挙（goal / scope.allow / verify.gates / autoYes / success）だけを写した契約は `title: required` で契約エラーになる。**本文の「#1580 以降は未コミット可」も採用していない** — #1580 は未マージで、develop の work-evidence ゲート（`gate-runner.ts` の `git status --porcelain` 行数カウント）は未コミットの契約ファイル自体を作業証跡として数える。そのまま配布すると「エージェントが何もしていない」（`commandmate verify` の exit 21）を検出できなくなるため、運用は「送信前にコミットする」と書き、除外は #1580 で扱う旨だけ残した。あわせて scope ゲートは `.commandmate/` を常時許可する（`scope-gate.ts` の `ALWAYS_ALLOWED_PREFIX`）ので契約ファイル自身を `scope.allow` に書く必要はないことも明記した。雛形は「読んで大丈夫そう」ではなく実際に `parseTaskContract` へ通して検証しており（gates は `.commandmate/verify.yaml` に実在する lint / typecheck / unit に解決）、`tests/unit/tasks/work-plan-contract-template.test.ts` が同じ検査を CI で恒久化する。このガードは 5 種の変異注入（未知キー追加・`verify.gates: []`・実在しないゲート id・仕様書参照の削除・`scope.allow: []`）で当該テストが赤くなることを実測済み。`.agents/commands/` は存在しないためミラーは作っていない。

- **`report metrics` をリリース前チェックと進捗報告の定点に組み込み** (#1583): #1551 の Eval メトリクスは実装済みだが**見る工程**がどこにも定義されていなかったため、`.claude/skills/release/SKILL.md`（Phase 1 に「1-4. Vibe メトリクス定点観測」）・`docs/release-guide.md`（事前準備 5）・`.claude/commands/progress-report.md`（レポート内容 4「検証メトリクス」）に取得手順を追加した。ドキュメント／レシピのみの変更で `src/` の製品コードは触っていない。**Issue 本文の 2 点を実測側に倒している**: (1) 本文は `--days` が「1..90 にクランプされる」とするが、**クランプは起きない** — `computeVibeMetrics()` は内部で clamp するものの CLI も API もそこへ到達せず、CLI は範囲外・非整数を `Error: --days must be an integer between 1 and 90.` で **exit 2**（`ExitCode.CONFIG_ERROR`）、route は 400 を返す（`--days 0` / `91` / `abc` を実行して exit 2 を実測）。したがって手順側に「呼ぶ前に 1..90 へ丸める」shell 計算を明記した。(2) 本文は「サーバ未稼働・データ 0 件（`successRate: null`）」を同一の degrade として扱うが、**この 2 つは別事象**である — サーバ未稼働は **exit 1**（`ExitCode.DEPENDENCY_ERROR`、`Server is not running.`）で **JSON が一切出ず**、`> file 2>&1` するとファイルにエラー文が入るためパースは失敗する。データ 0 件は exit 0 かつ `tasks.total === 0` の帰結。よって**判定は exit code で行い、JSON をパースしてから判断してはいけない**ことを 3 文書すべてに書いた。degrade は「メトリクスなし」と明記してスキップし、**リリースも進捗レポート生成もブロックしない**。取得コマンドは exit code を失わない `> ファイル 2>&1; echo $?` の形で書き、`| grep` に繋がないことをテストで固定した（パイプすると exit code が grep のものに化ける）。**Issue が名指ししていた `.claude/commands/progress-report.md` は目次にすぎず**、実際にレポートを生成するのは `.claude/prompts/progress-report-core.md`（スラッシュコマンド／サブエージェント両モードが読む共通プロンプト）なので、そちらの Phase 3 と出力テンプレートにも節を追加し、`.claude/agents/progress-report-agent.md` の Report Structure も合わせた（片方だけ直すとサブエージェント経路＝`pm-auto-dev` が使う経路で無効になる）。省略条件は日次レポートの `buildMetricsSection()` と同じく `tasks.total` / `verification.runs` / `intervention.humanResponds` / `intervention.autoAnswered` が全ゼロのときで、`null` を `0%` と書かないことも明記した。`.agents/skills/release` は**存在せず、ミラーも作っていない**（このリポジトリのミラー方針は skill 単位で、`demo-video` / `video-to-gif` / `cmate-verify` の 3 つのみが両ルートに置かれる）。新設した `tests/unit/docs/release-metrics-checkpoints.test.ts` は文書の数値を散文で繰り返さず **`MAX_METRICS_DAYS` / `GATE_FAIL_BREAKDOWN_LIMIT` / `ExitCode` を import して突き合わせる**ので、定数を動かすと文書側が落ちる。`MAX_METRICS_DAYS` の変更・`| grep` への差し替え・`; echo $?` の除去・サーバ未稼働 exit code の改竄・「ブロックしない」の反転・`GATE_FAIL_BREAKDOWN_LIMIT` の変更・`.agents/skills/release` の新設という 7 種の変異注入で、追加したテスト 37 件のうち該当分が実際に赤くなり、復元で緑に戻ることを確認済み。

- **work-evidence / scope ゲートの変更集合から契約ファイル（`.commandmate/tasks/**`）を除外** (#1580): オーケストレータが worktree に契約を置いてすぐ `send` する軽量フローが成立するようにした。従来は契約ファイル自身が作業証跡として数えられ、**何もしなかったエージェントと作業したエージェントが区別できず** `wait --verify` の exit 21（作業証跡ゼロ）が検出できなかったため、「契約を base ブランチへ先にマージする」「セットアップコミットを作って `options.baseRef` をタグへ固定する」運用が必須だった。除外は `CONTRACT_DIR_PREFIX`（`src/lib/verification/scope-gate.ts`）1 箇所に集約し、**対になる 4 経路すべて**に入れている: work-evidence の commits（`rev-list --count <base>..HEAD -- ':(top)' ':(exclude,top).commandmate/tasks/'`。`:(top)` は「除外だけの pathspec」を避けつつ cwd ではなくリポジトリルートに固定する）と uncommitted、scope の committed 側（`git diff`）と uncommitted 側（`git status`）。**work-evidence の `git status` を `-z --untracked-files=all` に変えた** — 従来は素の porcelain を行数で数えており、新規の `.commandmate/tasks/` が `?? .commandmate/tasks/` の 1 ディレクトリエントリに畳まれるため、パス単位の除外が「パスでないもの」を判定することになる（空白入りパスの C クォート、rename の `old -> new` 連結も同じ理由で外せない）。porcelain のパーサは scope-gate と共有し、**エントリ単位の `string[][]`** を返すよう変えた上で「どのパスも契約ファイルであるエントリ」だけを数えない — rename は 1 エントリが 2 パスを持つため（`R  <new>NUL<old>`）、契約を作業ディレクトリへ持ち出す変更を落とさないためである。**`.commandmate/verify.yaml` は除外していない**: 契約本体は送信時に `tasks.contract_json` へスナップショットされる（`src/lib/db/tasks-db.ts`）ので後編集が判定に影響せず tasks/ の除外は改竄安全だが、verify.yaml のゲート定義は毎ラン読み直されるため、エージェントが自分のゲートを弱めた場合に scope の `deny` で検出できる状態を残す。この非対称の理由はコードコメントにも 1 行残した。Issue 本文との差分 2 点を実測側に倒している: (1) 本文は「契約の `scope.allow` に `.commandmate/tasks/**` を書かない限りスコープ違反で不合格になる」とするが、`ALWAYS_ALLOWED_PREFIX = '.commandmate/'` が既に `allow` の要求から除外しており**この記述は成立しない** — 実際に残っていた穴は `changed=N` に契約が混じることと、契約が `deny` を宣言した場合に契約ファイル自身が違反に数えられることの 2 点だった、(2) 本文の受入条件「既存テストが無修正で green」も成立せず、`does not count the contract directory against the scope` が `changed=2` を期待していたため `changed=1` への更新が要る（除外の結果として正しい値）。本文のファイルパス・行番号（gate-runner.ts 385-395 / scope-gate.ts 281 / tasks-db.ts 6-8・79-80）は再検証して一致を確認した。rev-list の pathspec 除去・uncommitted フィルタ除去・`some`→`every`（rename 分岐）・committed 側のみ除外・uncommitted 側のみ除外・プレフィックスの `.commandmate/` への拡大・`-z -uall` の差し戻しという 7 種の変異注入で、追加した 11 件のテストが**該当するものだけ**赤くなることを実測済み。

- **チュートリアルに操作 GIF 10 本を埋め込み、Step 3 に「承認待ち」の節を新設** (#1576): `docs/user-guide/tutorial.md` と `docs/en/user-guide/tutorial.md` は画像が 1 枚も無く、「**リポジトリを追加** をクリック」等の UI 指示がすべて文字だけだったため、#1575 の GIF 10 本（5 シナリオ × ja/en）を Step と 1:1 で埋め込み、各所に「映っているもの」の一文と冒頭の録画方法の注記（隔離環境・private リポジトリ名やソースを含まない・実 LLM ではなくキャプチャ済み端末出力の再生）を添えた。キャプションは **`docs/images/tutorial/storyboards/*.yaml` が宣言するシーンとテロップ、および `record-scenes.ts` の `SCENES` が実際に撮る操作だけ**を根拠に書いており、映像に無いことは主張していない。**Step 3 の「承認待ち」は埋め込みのついでではなく本文側の実在する穴**で、現在の Step 3 は指示文から結果へ飛び、エージェントが承認を求めて停止しうることに一切触れていなかった（`cm-t3-approve-prompt` の置き場所が本文に無いこと自体が証拠）。新節では停止時の状態表示・PC とスマホ幅それぞれの応答場所・Auto Yes の存在（有効化はしない）を書き、「このチュートリアルで体験すること」の表にも 1 行足した。Issue 本文との差分 4 点を実測側に倒している: (1) 停止中の一覧表示は本文の「**待機中**」ではなく **`common.status.waiting` の「応答待ち」**（`SIDEBAR_STATUS_CONFIG.waiting.labelKey`）で、「待機中」は `home.waiting` すなわち **概要** 画面の集計側の語なので両方を書き分けた、(2) `cm-t1-add-repository` の映像が到達するのは本文の「セッションとして一覧に現れる」ではなく **リポジトリ一覧の行**（シーンは `/api/repositories` に path が載ったあと `repository-row-*` を待って終わる）、(3) UI のラベルは docs で使われてきた「Auto-Yes」ではなく **`autoYes.label` の「Auto Yes」**（ハイフン無し）なので UI 名で書いた、(4) GIF 10 本の実測合計は本文の見積り約 4.5MB ではなく **3,184,627 バイト（3.04MB）**（`to-gif.sh --report` 実測。480x300 / 10〜12 秒 / 80〜96 フレーム）。`cm-t1-add-repository` は**本文の手順と一致しない**ことをキャプションに明記した — 本文 Step 1-2 は **クローン URL** タブから取り込むが、録画環境がネットワークに出られないためデモは **ローカルパス** タブでローカルのリポジトリを追加しており（`UrlNormalizer.getUrlType` が返すのは `https://` / `git@` / `ssh://` の 3 形式だけで、ローカルパスは `null` になりクローン URL として通らない）、隠すと本文と映像の食い違いに読者が先に気づく。`cm-t5-review-changes` は「再起動して初めて画面が変わる」の直前に置くにあたり、見出しの無い裸の画像を節の途中に落とさず独立した `###` 節にした（既存見出しは 1 つも改名していないので被リンクは切れない）。**Step 番号の振り直し（`Step 1.5` の解消）はスコープ外**として手を付けていない。10 本すべてが各ページからの相対パスで実在すること（ja は `../images/`、en は 1 階層深い `../../images/`）、ja ページに `.en.gif` 参照が 0 件・en ページに `.ja.gif` 参照が 0 件であること、全 10 本が複数フレーム（80〜96）を持ち先頭フレームで静止しないことを実測で確認済み。

- **チュートリアル操作シナリオのデモ 5 本（ja/en の GIF 10 本）と、絵コンテを「実装の部分集合」に緩める変更** (#1575): `docs/images/tutorial/` に Step と 1:1 対応する GIF 10 本と絵コンテ 5 本を追加し、`record-scenes.ts` に `add-repository` / `sync-worktrees` / `review-diff` の 3 シーンを実装した。**着手の前提として絵コンテ検証を変えている**: `storyboard.ts` は record id と `SCENES` の**両方向**一致を要求していたため、1 つの絵コンテがすべての実装済みシーンを含まねばならず、シーンを 3 本足すと既存 12 個の絵コンテが即座に検証エラーになった（既存 10 本がどれも同じ 4 カットなのはこの制約の帰結）。`unused` 側を errors から外し、代わりに `demo-video.sh` が絵コンテの record id から `--scene` を組み立てて渡す形にした — 「撮った映像を黙って捨てる」ことは**構造的に起きなくなる**ので、制約を緩めたのではなく制約が守ろうとしていたものを設計で保証する形に置き換えている（`missing` 側は録画時に実際に落ちるので維持）。既存 12 個の絵コンテが無変更で通り続けることは回帰テストで固定した。Issue 本文との差分を 3 点、実測側に倒している: (1) パス指定の登録先は本文の `POST /api/repositories` ではなく **`POST /api/repositories/scan`**（`repositories/route.ts` は `GET` と `DELETE` しか export していない。`validate-path` は入力中のヒント表示専用で登録経路ではない）、(2) `review-diff` の同期点は本文の `git/diff` では**成立しない** — あれはコミット指定専用で `commit` が 7〜40 桁 hash でなければ 400 を返し作業ツリーの変更を一切扱えないため、Git ペイン自身が読む **`git/staged` の `unstaged`** に変えた（`git/status` の `isDirty` も不可: untracked だけでも true になり、シーンがクリックする `git-unstaged-list` が空のままテイクが始まる）、(3) 絵コンテ 3 は本文では `respond-from-mobile` 単独だが、カセットの行が `@input` で送信を待つため承認フレームが描画されず prepare がタイムアウトするので **`send-and-generate` を手前に置いた**（シーンが部分集合として選べるようになったことで露出した依存で、この順序はテストで固定した）。リポジトリ追加・同期の UI には `data-testid` が 1 つも無く、ローカライズされた文言か CSS クラス連鎖でしか掴めなかったため `add-repository-button` / `sync-all-button` / `repository-path-input` / `repository-scan-submit` を付与した。サーバレンダリング済みボタンは React が `onClick` を貼る前に Playwright の actionability を満たすので、最初のクリックが黙って捨てられ 30 秒後に無関係な要素のタイムアウトとして現れる（実際に踏んだ）— `clickUntilEffective` が観測可能な結果が出るまでクリックし直す。隔離の不変条件は維持（専用ポート 3399・`CM_DB_PATH` は $HOME 配下・`WORKTREE_REPOS` は使い捨て seed のみ・停止は記録 PID 経由・clone URL 不使用でネットワークに出ない）。`unused` の復活・`$SCENE_ARGS` の削除・awk の全行選択・plan 生成順の入替・`staged`/`unstaged` の取り違え・seed ブランチ名の drift・clone タブの使用・viewport の不一致・未実装 id の配置という 9 種の変異注入で、追加したテストが実際に赤くなることを確認済み。

- **LP に特徴デモ 4 本を掲載し、#1272 のメディアガードを出所基準へ作り替えた** (#1577): `website/` は `.github/workflows/pages.yml` がビルド無しで素の HTML として配信するため markdown サニタイザを通らず、docs で GIF が必須だった制約は当てはまらない。#1574 の英語版デモから 4 本（`parallel-worktrees` / `status-at-a-glance` / `approve-from-phone` / `tmux-in-browser`）を `website/assets/media/` へ**コピー**し（Pages は `website/` しかデプロイしないので `docs/` 参照は本番で 404 する）、poster webp つきで gallery 直前の新セクションに置いた。ヒーローには置いていない — `screenshot-desktop.webp` が LCP 要素かつ `og:image` で、100KB 予算と eager 読み込みのテストが付いている。`website/` の増加は **wc -c 実測で 2,567,022 バイト**（mp4 4 本 2,422,299 + poster 4 枚 138,728 + テキスト差分 5,995）。同じ 20 秒素材の GIF は 1 本 1.3MB なので mp4 の方が軽い。ガードは **`<video>` 全面禁止・動画拡張子全面禁止の 2 件を、場所と許可リストによる規則へ書き替えた** — #1272 が守ろうとしたのは「個人環境で撮った映像が公開ページに載らないこと」であって**コンテナ形式ではない**のに形式で縛っていたため、同一フッテージの GIF が全チェックを素通りした（`docs/images/demo-mobile.gif` は現に存在する）。HEAD 時点のガードに 1.4MB の GIF を 1 枚置いて**旧テスト 30 件が全部緑のまま**であることを実測して穴を確認し、新ガードでは同じ GIF が落ちることを確認している。新しい規則は「動くものは `website/assets/media/` 配下だけ」「そこに置けるのは `ALLOWED_MEDIA` に名前があるファイルだけ」（増やす＝テストを編集する＝隔離環境で撮ったかを人間が判断する地点）「許可リストに載っているのに実在しないファイルがあれば落ちる」（リストが名ばかりに腐るのを防ぐ）で、旧素材名の参照禁止・5MB 上限・`og:image` 固定は維持した。`preload="none"` の黒板を避ける `poster` の実在、iOS Safari が autoplay に要求する `muted` / `playsinline`、レイアウトシフトを防ぐ `width` / `height` も固定している。`prefers-reduced-motion: reduce` では `main.js` が `autoplay` を外して `controls` を出す（CSS では autoplay を止められない）。Issue 本文との差分 2 点を実測側に倒した: (1) 本文は「5MB 上限は現在動画拡張子にしか掛かっていない」とするが、当該テストは `walk(website/)` の**全ファイル**をサイズで見ており拡張子非依存なので GIF にも元から掛かっていた（穴は拡張子リストを持つ「動画ファイル禁止」テストの側だけ）、(2) 掲載位置は本文指定の gallery セクション内ではなく**その直前の独立セクション**にした（"On desktop and on mobile" という見出しの下に特徴デモ 4 本は乗らない。ヒーローに置かないという制約は満たしている）。Chromium 実機で 4 本とも autoplay・ループすること、`reducedMotion: 'reduce'` コンテキストでは 4 本とも `paused` かつ `controls` で `currentTime` が 0 のままであることを Playwright で確認済み。許可リスト外メディアの設置・6MB GIF・`assets/media/` 外への動画設置・`muted` 除去・`playsinline` 除去・poster の docs 参照化・デモ 3 本化・ヒーローへの `<video>` 混入・reduced-motion 処理の差し戻し・poster ファイル削除の計 11 種の変異注入で、追加・改訂したテスト 38 件が実際に赤くなることを確認済み。

- **`video-to-gif` スキル**: 録画済みの動画を、GitHub の markdown ビューアが実際に再生できる GIF に変換する `.claude/skills/video-to-gif/scripts/to-gif.sh` を追加した（`.agents/skills/` にも byte-identical で配置）。既存の `demo-video` の `compose.sh --gif` は合成パイプラインの途中でしか発火せず 720px/12fps/`sierra2_4a` 固定だったため、完成済み mp4 から docs 用の GIF を作る経路が無く、その都度使い捨てスクリプトを書いていた。**既定の dither を切った** — 同一素材（20 秒 / 1280x800 の UI キャプチャ）を無劣化リファレンスに対する SSIM で実測したところ、`colors=256 dither=none` が 1,073,725 バイト / SSIM 0.99653、従来の `colors=128 dither=sierra2_4a` が 1,271,671 バイト / SSIM 0.99160 で、**ディザは 2 軸とも悪化させる**（空間ノイズが GIF の LZW run を壊し、画面録画の大半を占める平坦な UI パネルには均すべきグラデーションが無い）。`colors=64` + `sierra2_4a` が 1,472,301 バイトと `colors=128` の同ディザより大きくなる逆転も併せて確認しており、パレットが粗いほど誤差拡散が遠くまで広がるためである。`--max-bytes`（既定 1.5M）を満たすまで**幅・fps・パレットを 3 軸ラウンドロビンで一段ずつ**落として再試行し（fps を底まで落としてから解像度に手を付ける順序にはしない — 4fps 等倍も 360px 30fps も中間の妥協より読めない）、底まで行っても収まらなければ **exit 1 でファイルを書かない**（`--allow-oversize` で書けるが exit 1 は維持）。サイズは一貫して `wc -c` で測る — APFS では `du -h` が 1,536,216 バイトのファイルを 2.3M と報告し、実際にこの差で総量を 38MB と 25.8MB に読み違えかけた。`--ladder` は **ffmpeg を一切呼ばずに**再試行の段取りだけを出すので、CI ランナー（ffmpeg 無し）でも降下の算術と引数ゲートを実行できる。トリムは `-ss` / `-t` をいずれも**入力オプションとして `-i` の前に**置く — 引数列の末尾に足すとパレット入力の入力オプションとして解釈され、`--duration 6` が 16 秒の GIF を吐いた。幅の縮小率・fps 下限の無視・ラダーの打ち切り・パレット半減の無効化・`du` での計測・引数検証順序の入替を含む変異注入で、追加したテスト 43 件が実際に赤くなることを確認済み。

- **Eval メトリクス（タスク成功率・検証合格率・人間介入回数）の集計と API / CLI / 日次レポート統合** (#1551): 「ハーネスが Vibe Engineering を成立させている度合い」を、Phase 1〜3 が残した実記録（`tasks` / `verification_runs` / `verification_gate_results` / `task_events`）から集計する `src/lib/metrics/vibe-metrics.ts`、`GET /api/metrics/vibe?days=7`、`commandmate report metrics [--days N] [--json]`、日次レポートプロンプトの `<verification_metrics>` セクションを追加した。**読み取り専用で migration は追加していない**。**分母ゼロの比率は `null` であって 0 ではない** — 「12件中0件成功」と「そもそも0件」を `0.0%` という同じ文字列で報告するのは嘘になるため、CLI もプロンプトも `n/a` と描く。集計元テーブルは毎回 `sqlite_master` で存在確認してからクエリするので、v49〜v51 未適用の旧 DB ではセクション単位でゼロに degrade する（日次レポート生成が、誰も要求していない機能のせいで旧 DB で落ちることを避けるため）。`gateFailBreakdown` は `failed` / `timeout` のみ計上し `skipped` / `error` は除外する（意図的スキップも実行前エラーも作業への判定ではなく、数えると「失敗していないゲートが失敗として並ぶ」）。再指示ループ数は `message_sent`（from_status が `failed` / `not_started`）を分子、その期間に不合格へ入った **distinct task 数**を分母とし、両方を `task_events` 単独から取る（`tasks` と join すると v51 以前の履歴が分母にだけ効いて平均が歪む）。介入回数は**状態機械に拒否されたイベントも数える** — 検証中に届いたプロンプトへ人間が答えれば機械は遷移を拒否するが、人間は現に手を止めて答えているのであって、それがここで測っている費用そのもの。`suppressedByPolicy` は Phase 2-3 の抑止ログが DB 化されていないため **v1 は null 固定**（数値を入れると発明になる）。日次レポートの window は `Date.now()` ではなく**対象日**に固定した（過去日のレポートが「直近24時間」を語ってしまうため）。プロンプト側は活動ゼロの日にセクションごと省略し、gate id は verify.yaml 由来のため `sanitizeMessage` でタグをエスケープする（`</verification_metrics>` を含む gate id でセクションを閉じられないこと、および長さフォールバック時に落ちるのが metrics ではなく user_data 側であることをテストで固定）。テストは **seed から手計算した literal を期待値**にしており（実装と同じ式で導出すると同じ誤りに両方が同意する）、日次レポートのテストは prompt builder も集計器もモックせず実 DB の行が**実数としてプロンプト文字列に入ること**を assert する（キー名だけの一致は空セクションでも通るため）。境界（`since` は含み `until` は含まない）・分母ゼロの null・`skipped` の除外・初回 `message_sent` を再指示に数えない・テーブル不在時 degrade・日次 window の固定など計 28 種の変異注入で、追加したテストが実際に赤くなることを確認済み。

- **構造化イベント受け口 `POST /api/hooks/agent-event` と Claude / Codex 配線を追加** (#1549): エージェントの完了検知を tmux 画面の文字列解析だけに頼らず、エージェント CLI 自身が発するイベント（Claude Code の Stop hook、Codex の notify）を第一級ソースにする。文字列解析は**廃止せずフォールバックとして残す**（hook は設定した人の環境にしか無いので、未設定機で黙って何もしない完了検知は、どこでも不正確な完了検知より悪い）。worktree の解決キーは `cwd` で、`..` を含むパスは**正規化せず 400 で拒否**する（`resolve()` を通すと検証時と使用時で値の意味が変わり、それが traversal 検査の破られ方そのもの）。percent-decode 後も再検査し、実在する worktree に解決される traversal 表記も拒否することをテストで固定した。解決成功も失敗も **202 `{accepted:true}` で同一ボディ**を返す（外部から叩ける経路なので、応答差が「登録済みディレクトリの探索器」になる）。`event: stop` は active task に `agent_idle`（payload `{source:'hook'}`）を記録し、契約に **`success.autoVerifyOnStop: true`**（契約 v1 に追加。**既定 false** — 他 2 つの success フラグが「判定基準」なのに対しこれだけサーバに動作を起こさせるフラグで、本フィールド以前の契約が Stop hook 設定だけで検証ランを走らせ始めてはならない）があれば `startVerification(trigger='task')` を起動する。`claude-done` は message 記録の従来動作をそのまま保ち、末尾で同じ stop 処理へ委譲する。`lastStopEventAt` を `CurrentOutputPayload` に**露出するのみ**とし、wait / ポーラー / Auto-Yes の完了判定は一切変更していない（二重ソースを実測前に切り替えるのは「既知の不正確さ」を「未知の失敗モード」と交換することになるため、判定への組込みは後続 Issue）。同梱スクリプト `scripts/hooks/cmate-agent-event.sh` は bash 3.2 互換で、POST 失敗でも exit 0 で終わる（サーバ停止でエージェントのセッションを壊さない）。設定手順は `docs/user-guide/agent-event-hooks.md`。Issue 本文との差分 1 点を実測側に倒した: 本文は終端タスクへの stop も「拒否として記録される」ことを含意するが、`getActiveTaskForInstance` が active status（running / waiting_input / verifying）しか解決しないため **`succeeded` などの終端タスクでは state machine に到達せず行も残らない**（拒否行が残るのは `verifying` 中の stop）。両者を別テストとして固定した。traversal 検査除去・`source` payload 除去・`autoVerifyOnStop` 既定反転・auth 除外リストへの追加・202 ボディの情報漏れ・stop 効果の無効化・委譲の削除・露出の削除・bash4 構文混入の計 9 種の変異注入で、追加したテスト 59 件が実際に赤くなることを確認済み。

- **TaskStatus 状態機械と `task_events` 追記専用イベントログを追加** (#1548): Phase 2-1 では各所が `updateTaskStatus` に次の status を自分で決めて渡していたため、遷移規則が 6 箇所に分散し互いに一致しているのは偶然でしかなかった。純関数 `src/lib/tasks/task-state-machine.ts` に規則を集約し、`src/lib/tasks/task-transition-service.ts` の `applyTaskEvent` を **`tasks.status` の唯一の writer** として、`updateTaskStatus` / `insertTaskEvent` は `@/lib/db` バレルから re-export しない形に閉じた。migration **v51** の `task_events` は status の変更ではなく**変更しようとした試み**を記録する追記専用ログで、Phase 4 Eval の「介入回数」「再指示ループ回数」はこの表から数える（最新値しか持たない status 列からはどちらも答えられない）。**不正遷移は throw せず `to_status = NULL` の行として記録**する — 検証中のプロンプト検出は競合であってバグではなく throw するとポーラが落ちるが、黙って捨てると配線バグと競合が区別できなくなる。UPDATE と INSERT は同一トランザクション（status だけ動いてイベントが無い／その逆は、どちらもログが表を説明できなくなる）。発火点は `send --contract`（message_sent）・`response-checker` のプロンプト保存（prompt_detected）・`auto-yes-poller` の応答成功（prompt_answered_auto）・`/respond` と `/prompt-response` の両 route（prompt_answered_human）・`gate-runner` の run 開始／終了（verify_*）・新規 `POST /api/tasks/:taskId/cancel`（cancel）で、いずれも **active task が無ければ何もしない**（契約なし運用への影響ゼロ。回帰テストで固定）。Issue 本文との差分 3 点を実測側に倒した: (1) migration 番号は本文の v50 ではなく **v51**（v50 は #1545 が使用済み）、(2) 本文のイベント表に無い **`send_failed`** を追加 — `send --contract` の配送失敗報告は Phase 2-1 で既に動いており、直接 UPDATE を閉じる際に落とすとタスクが永久に `pending` に残る、(3) respond route は候補が 2 つ実在し**どちらも人間の応答経路**（`/respond` は chat の prompt ボタン専用、`/prompt-response` は端末プロンプト UI と `commandmate respond` CLI）なので**両方に配線**した。`gate-runner` の終端 status 事前チェックは廃止し可否を状態機械に委ねた — `succeeded`/`cancelled` は機械が拒否する一方、再実行で正当に開き直る `failed`/`not_started` を status チェックでは区別できなかった。遷移表は 8 status × 11 event の**全 88 セル**を、実装から導出せず literal な期待表として有効・無効の両方で固定し、`satisfies never` で列挙追加時にビルドが落ちるようにした。トランザクション除去・UPDATE/INSERT 順序入替・発火点削除の変異注入で、追加したテストが実際に赤くなることを確認済み。

- **スコープ検証（git diff × scope glob）を組み込みゲート `scope` として追加** (#1546): 実行契約の `scope.allow` / `scope.deny` に対して実際の変更ファイル集合を突き合わせ、ワーカーが担当範囲外（共有設定・無関係モジュール）を触る事故を機械検出する。`src/lib/verification/scope-gate.ts` を `work-evidence` の直後・コマンド系ゲートの前に実行し、`success.requireScopeClean` が true の契約では `verify.gates` に書かなくても自動で走る（書いてあるのに走らないと「スコープを守る」と宣言して誰も確認しない契約が成立する）。判定対象は `git diff --name-only -z --no-renames <merge-base> HEAD` と `git status --porcelain -z --untracked-files=all` の**和集合**で、未追跡ファイルと rename の両パスを含む。git のオプションはいずれも偽判定を避けるために必要である — 人間向け書式は空白入りパスを C クォートし rename を `old -> new` に繋ぐので分割すると**存在しないファイル**が生まれ、`-uall` が無いと新規ディレクトリが `?? dir/` に畳まれてゲートがファイルでなくディレクトリ名を判定し、`--no-renames` が無いと移動元ディレクトリが空になった事実が消える。glob は**自前解釈の小さな部分集合**とし、`[` `]` を**リテラル**にした — Next.js の `src/app/proxy/[...path]/` を文字クラスと解釈すると当該ディレクトリを指すパターンが何にもマッチせず無関係なパスにマッチする。また**ディレクトリを指すパターンはその配下すべてにマッチ**する（`src/lib` ≡ `src/lib/**`）。この規則が無いと、契約作者がディレクトリを書く最も自然な表記が中の全ファイルを違反にしてしまう。`.commandmate/` 配下と契約ファイル自身は `allow` の要求から除外するが、**明示的な `deny` は効く**。`scope` の `skipped` は `gateIds` で名指しされたときだけ run 集計に数える — 既定ゲート集合に常に含まれるので、`skipped` を一律 `error` に倒す既存規則をそのまま適用すると契約を使っていないリポジトリの検証がすべて `error` になる（名指し＝「断った」／契約なし＝「判定すべき宣言が無い」）。glob ライブラリは**直接依存に追加しなかった** — `picomatch` / `minimatch` はいずれも推移依存のみで型定義も無く、この worktree の `node_modules` は兄弟 worktree と 14 本の hardlink を共有しているため、並列ワーカー稼働中の再展開は他の作業を壊しうる（判断理由は `docs/design/task-contract.md` §2.2.5）。glob 解釈・git 呼び出し・allow/deny 優先順位・ゲート集計・契約解決の計 32 種の変異注入で、追加したテストが実際に赤くなることを確認済み。

- **実行契約（Task Contract）を導入** (#1545): `.commandmate/tasks/<name>.yaml` v1（正準仕様 `docs/design/task-contract.md`）・migration **v50** の `tasks` テーブル・契約パーサ `src/lib/tasks/contract-parser.ts`・`commandmate send --contract` / `commandmate task list|show`・`GET|POST /api/worktrees/:id/tasks` / `GET|PATCH /api/tasks/:taskId` を追加。送信メッセージは契約前文＋goal で、完了条件は verify.yaml の `gates[].command` を解決した実コマンドで書かれる。`startVerification` は `taskId` 未指定でも active task を解決して契約の `verify.gates` を既定ゲートにし、run 結果で task を `succeeded` / `failed` / `not_started` へ遷移させる（`wait --verify` は CLI 変更なしで契約検証になる）。契約は本フェーズでは**宣言**であって強制ではない（scope ゲートは #1546、autoYes enforcement は #1547）。未知キーは Issue 本文の「無視」ではなく **`verify-config.ts` の実測作法どおり拒否**する（`allowPromtTypes` の綴り間違いが黙って通ると「縛っているように見えて縛っていない契約」が生まれる）。`denyPatterns` は正規表現としてコンパイル可能であることを検証し 200 文字上限（ReDoS 対策）。`succeeded` はクライアントから報告できない（API が 400 で拒否）— 「エージェントが完了と言った」を合格として受け入れないため。契約ゲート既定の削除・run 結果マッピングの常時 succeeded 化の 2 種の変異注入でテストが実際に赤くなることを確認済み。

- **`.commandmate/tasks/*.yaml`（実行契約）を Git 追跡対象にし、追跡ポリシーを可視化** (#1545 の前提整備): `.commandmate/` はランタイムデータ置き場のため全体を除外しているが、その中の**設定**（`verify.yaml`・実行契約）はチームで共有すべきものなので追跡する必要がある。Phase 2-1 が契約を `.commandmate/tasks/<name>.yaml` に置く設計のため、着手前に規則を整えた。**負パターンを 1 行足すだけでは効かない** — git は除外されたディレクトリの中を走査しないので、ディレクトリを除外解除 → 中身を再除外 → 拡張子で許可、の 2 段構えが要る（#1540 で verify.yaml が踏んだ罠と同型）。利用者が状態を知る手段として `scripts/check-commandmate-tracking.sh`（`npm run check:tracking`）を追加し、追跡されるべきファイルと隣に置かれうる無視されるべきファイルの両方を一覧で報告する。規則を壊すと正しい書き方のヒントつきで exit 1 で落ちる。CI ガード `tests/unit/config/commandmate-tracking.test.ts` と設計文書 `docs/design/commandmate-directory-tracking.md` も追加した。判定には **`git check-ignore --no-index`** を使う — 既定では index が参照され、**すでに追跡済みのファイルはルールに関係なく「無視されない」と報告される**ため、`verify.yaml` の例外行を削除する変異を注入してもテストが緑のままだった（空振り緑）。`--no-index` 追加後は当該変異を含む 3 種の変異注入すべてでテストが実際に赤くなることを確認済み。


- **検証ゲート Skill `cmate-verify` と `.commandmate/verify.yaml` v1 仕様を追加** (#1540): 検証ゲートの設定形式を製品実装（Phase 1）より先に実地検証するための先行 Skill。`docs/design/verification-config.md` を正準仕様とし、`.claude/skills/cmate-verify/` と `.agents/skills/cmate-verify/` へ byte-identical に配置（Claude は前者、Codex / Antigravity は後者しか読まない）。ランナーは bash 3.2 互換で、ゲートを定義順に逐次実行し**失敗しても残りを実行して全結果を報告**、判定は必ず実 exit code で行う（出力の grep は `$?` を隠す）。macOS に `timeout(1)` が無い前提で、job control による**プロセスグループ単位**の timeout kill を実装（直接の子だけを kill すると孫が生き残る／signal 送出前に pgid が pid と一致することを確認して無関係なプロセスグループを巻き込まない）。組み込みゲート `work-evidence` が「作業の痕跡ゼロ」を `not_started` として弾き、`skipInPrimaryCheckout` がメイン checkout でのコマンド実行を止める（全 skip は `passed` ではなく `skipped`）。fixture ベースの自己完結テスト 123 アサーション（vitest 非依存）＋ vitest ラッパで CI からも実行。

- **`.commandmate/verify.yaml` の型安全なローダ／バリデータを追加** (#1541): 正準仕様 `docs/design/verification-config.md` を製品コード側で実装した `src/lib/verification/verify-config.ts`（`yaml` パッケージを dependencies に追加）。`loadVerifyConfig(repoPath)` はファイルが無ければ `null`、パース／検証に失敗すれば **全違反を `issues` に集約した単一の `VerifyConfigError`** を throw する（1件目で打ち切るとエージェントが直すたびに次の1件が出て往復が増えるため）。既定値は仕様どおり `timeoutSec` 600 / `maxLogTailBytes` 8192 / `skipInPrimaryCheckout` true、`baseRef` は `null`（デフォルトブランチ解決は利用側の責務）。**未知キーはトップレベル / gate / options とも設定エラーとして拒否する** — Issue 本文は「前方互換のため無視」としているが、仕様 §2.1「未知のトップレベルキーは設定エラー」・§8「v1 は閉じた集合」と Phase 0 参照実装（`verify-run.sh` の `unknown top-level key` / `unknown gate key` / `unknown options key`）の**双方**がこれを拒否しており、黙って読み飛ばすと「設定したつもりのゲートが走っていないのに passed」になるため、仕様と実測を正とした。bash 参照実装は awk パース前に外側クォートを剥がすため `timeoutSec: "900"` を 900 と解釈する。**同じ verify.yaml が Skill と製品の両方で読めること**が仕様 §1 の目的なので、整数・真偽値の正準リテラルに限りクォート形も受理する。既定 `maxLogTailBytes` を 32768（リポジトリ自身の明示上書き値）に変える／未知キーを無視する／違反1件目で打ち切る／予約 ID を空にする／ファイル無しで throw する等 7 種の変異注入で、追加したテスト 55 件が実際に赤くなることを確認済み。リポジトリ自身の `.commandmate/verify.yaml` が実際に読めることも受入テストで固定した。

- **検証ゲートの実行結果を永続化する `verification_runs` / `verification_gate_results` テーブルと DB アクセサを追加** (#1542): exit code を持つ実行記録は `execution_logs`（スケジュール実行）と `assistant_executions`（非対話アシスタント）にしか無く、インタラクティブなエージェント作業は `chat_messages` しか残らないため「終わった」と「要求を満たした」を区別できなかった。migration **v49** で 1 検証試行 = `verification_runs` 1行 / その中の 1 コマンド = `verification_gate_results` 1行として記録する。gate results は run に `ON DELETE CASCADE`（run 抜きの gate 行は記録ではなくノイズであるため）。status / trigger の語彙は writer 側の検証だけでなく DB の CHECK 制約で固定した — この表の存在意義は語彙が区別する内容そのものであり、typo が新しい status 値として着地すると誰も query しないバケツが黙って生まれる。run の `not_started`（作業証跡ゼロでそもそも検証対象が無い）は `failed`（判定した上で不合格）と別値、`error` はゲート実行以前の内部エラー、gate の `skipped` は意図的スキップで理由を `log_tail` に残す（スキップが PASS と読まれないため）。`task_id` は Phase 2（#1545）の `tasks` 到着まで FK を張らない自由カラムとした（存在しない表への REFERENCES は `foreign_keys` ON 下で全 INSERT を失敗させる）。アクセサ `src/lib/db/verification-db.ts` は create* が `running` で開き finish* が閉じる二段構成とし（途中クラッシュを recoverable な `running` 行として残すため）、finish* は対象行が無ければ throw する（黙って no-op にすると、記録していない verdict を記録したと呼び出し側が信じる — まさにこの表が防ぐべき失敗）。`listVerificationRuns` は `started_at DESC, id DESC` で、同一 ms の tie でも順序が全順序になるよう id を tiebreak に使う。id tiebreak 削除・`?? null` を `||` 化（exit code 0 が NULL に化ける）・finish* の存在チェック削除・CHECK 制約削除・CASCADE 削除・index 削除・feed の ORDER BY 差し替え 3種・gate の run スコープ喪失、計 11 種の変異注入でテストが実際に赤くなることを確認済み。

- **検証ゲート実行エンジン `gate-runner` と検証 API を追加** (#1543): `.commandmate/verify.yaml` のゲートを worktree の cwd で逐次実行し、判定を実 exit code で下して `verification_runs` / `verification_gate_results` に永続化する。`POST /api/worktrees/:id/verify` は 202 で `runId` だけ返し（ゲートはテストスイートなので接続を数分保持しない）、`GET /verify/runs` / `GET /verify/runs/:runId` で証跡を読む。組み込み `work-evidence` が「コミットも未コミット変更も無い」を `not_started` として弾き、以降のゲートを `skipped` にする。`skipInPrimaryCheckout`（既定 true）は worktreePath の realpath がサーバプロセスの `process.cwd()` と一致したらコマンド系ゲートを実行しない — 稼働サーバの足元で build を回して配信中の chunk を壊した事故が実際に 2 回あったため。**`skipped` が 1 つでもあれば run は `passed` にならず `error`** とし、「チェックしなかった」が「チェックして問題なかった」に化けないようにした。失敗したゲートで run を打ち切らず全ゲートを実行する（1 往復ごとに問題が 1 件ずつ出るのを避けるため）。timeout はプロセスグループへ SIGTERM→5 秒→SIGKILL（`shell: true` の子だけを kill すると孫が worktree を掴んだまま残る）。log_tail はチャンク境界に依存しないバイト厳密な末尾 `maxLogTailBytes` — 当初のチャンク単位破棄は「4KB 書込＋改行 1 バイト」で改行だけを tail として残す欠陥があり、変異注入テストで発見して修正した。同一 worktree の多重実行は 409、全体同時実行は 2 本のセマフォで待たせる。再起動で孤児化した `running` 行は起動時 reconcile が `error` に倒す（放置するとその worktree が永久に 409 で塞がる）。gate-runner 14 種・API/reconciler 15 種の変異注入で、追加したテストが実際に赤くなることを確認済み。

- **デモ動画収録スキル `demo-video` の基盤を追加** (#1553): 隔離デモ環境（使い捨て seed repo・専用ポート・$HOME 配下 DB・自前プロセスグループ）、キャプチャ済み ANSI カセットを tmux pane へ再生してサーバの status-detector／response poller／UI を実物のまま駆動する偽エージェント（LLM のみ差し替え・モックゼロ）、@playwright/test をライブラリとして使う scene 単位 webm 録画の 3 点。`.claude/skills` と `.agents/skills` へ byte-identical 配置。


- **`demo-video` に絵コンテ・日英テロップ・ffmpeg 合成・30 秒尺検証ゲートを追加** (#1554): `demo-video.sh` 一発で `demo-30s.ja.mp4` / `demo-30s.en.mp4` が出る。文言の編集点は `storyboard/default.yaml` だけで、シーンの尺もテロップの in/out も合成の切り貼りもそこから機械算出する（手書きタイムコードは無い）。ロケールはフル録画方式で、UI ごと切り替えて 2 回撮り、遷移ごとに `<html lang>` を実測して不一致ならテイクを失敗させる（「UI 言語がテロップ言語と一致」を目視でなく機械で担保）。テロップは HTML→透過 PNG→ffmpeg overlay で焼き込み（drawtext の日本語 fontfile／エスケープ問題を回避し意匠を CSS 1 箇所に集約、文字列は `textContent` 注入なので絵コンテがマークアップを注入できない）。尺は `ffprobe` 実測が 30.0±0.5s を外れたら **exit 1**。承認シーン用にカセットへ実キャプチャ由来の承認プロンプトを追加し、`{{TASK}}` 置換（承認後も元の指示を echo し続ける）と `Scene.prepare`（API 待ちを録画開始前に行う）を導入した。生成物はリポジトリ外に出しコミットしない（配布は Release アセット）。

- **実行契約の `autoYes` ポリシーを Auto-Yes リゾルバへ enforcement** (#1547): `resolveAutoAnswer()` は「デフォルト選択肢に常に応答する」素朴実装で、契約に何を書いても自動応答は制約されなかった。`resolveAutoAnswerWithPolicy()` が `off` / `safe` / `allow-listed` / `denyPatterns` を評価し、`auto-yes-poller.ts` の `detectAndRespondToPrompt` が応答直前に active task の契約を引き当てて渡す（Auto-Yes は status-detector を経由せず `detectPrompt` を直接呼ぶため、ここが唯一の enforcement 点）。**ポリシーは抑止しかしない** — 従来ルールが答えを出さないプロンプトを応答に変えることはなく、契約なし・`policy=null`・`mode:null` は従来動作と完全一致（回帰テストで固定）。`denyPatterns` は `mode:null` でも効かせる（列挙したのに何も守らないのは契約の最悪の失敗モード）。マッチ対象は質問文＋`instructionText`＋全選択肢ラベル（Claude は承認対象のコマンドを質問文の上に置くため質問文だけでは効かない）。パターンは `validateStopPattern`（長さ・safe-regex2・構文）で審査し**評価不能なパターンは抑止側に倒す**、マッチ対象テキストは 20,000 文字までの決定的な境界で切る（壁時計 timeout に判定を委ねない）。`getActiveTaskForInstance()` を追加 — primary インスタンスは `instance_id` が NULL と tool id の両方で記録され `= ?` ではどちらも確実に引けないため、`codex-2` の契約が `codex` を縛る事故を防ぐ。ポリシーは 5 秒 TTL でキャッシュする（抑止されたプロンプトはポーラーの重複ガードに載らず毎 poll 再評価されるため）が、DB 失敗時は従来動作へ倒す（契約を持たない既存ユーザーを巻き込まないため）。抑止時は `poller:auto-yes-suppressed-by-policy` を理由付きで記録し、人間への通知は既存の prompt→WS broadcast→Web Push 経路が担う（この依存関係も統合テストで固定）。ポリシー無視・評価不能パターンの fail-open 化・マッチ対象の縮小・テキスト境界の撤去・インスタンス絞り込みの喪失、計 7 種の変異注入でテストが実際に赤くなることを確認済み。

- **`commandmate verify` コマンドと `wait --verify` / `--require-work` を追加** (#1544): 検証ゲートを CLI から起動し、`wait` の成功条件を「エージェントが止まった」から「検証に合格した」へ引き上げる。exit code は 合格 0 / ゲート不合格 20 / 作業証跡ゼロ 21 / タイムアウト 124 で、判定不能（`error`・`cancelled`）は 20 ではなく 99 に倒す（「判定できなかった」を「判定してダメだった」と読ませないため）。検証は**完了検知できた worktree だけ**に走り、プロンプト検出(10)やタイムアウト(124)はそのまま返す。複数 worktree では完了検知は並行・検証は直列（サーバ側が同時実行数 2 に制限しているため並行させても queue するだけ）、集約の優先順位は 10 > 20 > 21 > 124。直列実行の並行化・`not_started`→0 への写像・優先順位の入れ替え・プロンプト時のガード除去・timeout 判定を終端 status 判定より前に置く、の 5 種の変異注入でテストが実際に赤くなることを確認済み。

### Changed

- **セッション状態語彙の変換を `src/lib/session/status-mapping.ts` へ一元化** (#1550): `SessionStatus`（検出）・boolean 三つ組（`isRunning` / `isWaitingForResponse` / `isProcessing`）・`BranchStatus`（表示）の相互変換が 3 ファイルに散在していたため、変換だけを 1 モジュールへ移して対応表をゴールデンテストで固定した（挙動変更ゼロ）。`deriveCliStatus` は `@/types/sidebar` から移設し同名で re-export（既存 import と既存テストは無修正）、`worktree-status-helper.ts` の `status === 'waiting'` / `=== 'running'` インライン式は `sessionStatusToActivityFlags()`（`satisfies never` で exhaustive）に置換、`src/app/api/worktrees/route.ts` に private 定義されていた**逆方向**の `deriveSessionStatus`（三つ組 → SessionStatus）も同モジュールへ移した。`UIPhase` は `waiting → receiving → complete` が履歴依存のシーケンスであり `SessionStatus` の写像ではないので、唯一の表引き（プロンプト検出 → `prompt`）を持つ `worktreeUIReducer` に残し、本モジュールには写像関数を作っていない。既存の `worktree-status-helper.test.ts` は検出器を常に `status: 'ready'` でモックしており移設対象の `running` / `waiting` 分岐を一度も通らないため、SessionStatus 全値を helper 経由で駆動する回帰テストを別ファイルで追加した。マッピング 4 種＋ helper 配線 1 種の変異注入で、追加したテストが実際に赤くなることを確認済み。

## [0.16.0] - 2026-07-29

> **Highlight**: **Skill 配布 MVP を「入れられる」から「運用できる」へ引き上げたリリース。** 導入先 Agent の対応状況を manifest の申告だけでなく CommandMate 側の実測で裏付ける互換 matrix（#1246）、どの worktree に何が入っていて導入時のままかを横断確認する監査 dashboard と receipt からの reindex（#1248、DB migration v48）、Skill 導入を review 可能な commit / draft PR に載せる専用 git workflow（#1247）を追加した。あわせて、uninstall した Skill を再 install すると **exit 0 で「Installed」と報告しながら 1 バイトも書かれない** journal replay の欠陥（#1552）を修正し、対になる uninstall 経路の同型欠陥も同時に塞いだ。

### Added

- **Agent 別 discovery 互換 matrix・support evidence・reload guidance を追加** (#1246): Agent 対応状況が manifest の申告 4 値（`native` / `commandmate_runtime` / `unsupported` / `unknown`）＋自由記述の `evidence` しか無く、CommandMate 側が実測した結果を保持する場所も、それを申告と突き合わせる仕組みも無かった。install は #1460 以降 `.agents/skills/<id>` と `.claude/skills/<id>` の両方へ byte-identical に配置するが、**どの Agent がどちらの root を読むか**はコード上どこにも表現されていなかった（`SKILL_INSTALL_ROOT_PREFIXES` と slash loader 3 本の `cliTools` 上書きに暗黙分散していた）ため、片方だけ編集しても「install 済みなのに見えない」形でしか露見しなかった。(1) `src/lib/skills/compatibility-matrix.ts` を新設し、2026-07-26 の隔離環境実測（#1513 G4）を **発見（discovery）と呼出（slash command 露出）の 2 軸**で記録した。Codex CLI 0.145.0 は発見のみ成立するため単一の native/unsupported 値では表現できない、というのが 2 軸にした理由そのものである。証跡の強さ（機械的 / Agent の自己申告 / 実測なし）、実測 version・計測日・証跡 URL・既知制約・reload 手順を各行に持ち、`CLI_TOOL_IDS` 全 7 件を網羅する（未計測 Agent は行を省かず `unknown` ＋ skip 理由。行が無いと「言及が無い」が「たぶん大丈夫」と読まれるため）。support 値は discovery 軸だけで決まり、Codex の palette 非露出は known limitation として併記する（呼出できないことは「動かない」ではない）。(2) `compatibility.ts` の `reconcileAgentSupport()` が申告を実測で**下方向にのみ**制限する（`capSupportByMeasurement()`）。実測が弱ければ実測値を表示して `RESTRICTED`、強ければ申告のまま `STALE_DECLARATION`（package が何を対応と主張するかを決めるのは提供元であるため引き上げない）、実測が無ければ `UNVERIFIED`。これが「evidence 無しに native と表示しない」受入条件の実装である。staleness は `now` を明示引数で受け取り、180 日超で経過日数つき警告を出す。(3) `CompatibilityEvidence` を追加し、詳細画面の Agent 対応欄と install 前サマリ（UX-01）へ、申告・実測 2 軸・version/計測日/証跡・制約・reload 手順・未計測の skip 理由を表示する。(4) matrix の discovery root と CommandMate 自身の slash loader の整合を `tests/unit/lib/skills/agent-discovery-regression.test.ts` で固定した（両 root へ byte-identical に install した fixture を実際に `loadSkills()` / `loadAgentsSkills()` / `loadCodexSkills()` に通し、`filterCommandsByCliTool()` まで含めて検証。legacy `.codex/skills` の回帰と二重表示防止も含む）。matrix→loader の一方向のみ主張する（`.agents/skills` が antigravity にも供給される #1504 は CommandMate によるコマンド注入であって Agent の native discovery ではないため evidence にしない）。(5) 実 CLI の再計測は `CM_SKILL_DISCOVERY_PROBE=1` 指定時のみ走る opt-in プローブとし、`<cli> --version` の差分検出に限定した（対話 TUI の自動操作は無関係な global 設定を書き換える事故の実績があるため行わない）。CLI 未導入は failure でも compatible でもなく `unknown` ＋ skip 理由として記録し、その規則自体は CLI の無い CI でも常時テストされる。(6) `docs/reference/skill-agent-compatibility.md` を新設し、doc の表が code の matrix から乖離しないようテストで固定した。変異注入（matrix の root 差し替え／loader の `cliTools` 差し替え）で両方向とも実際に赤くなることを確認済み。
- **Skill 導入監査履歴と適用状態 dashboard を追加** (#1248): 「どの worktree に何が入っていて、それが導入時のままか」を横断確認する手段が無く、DB 記録だけを真実とすると手動変更や DB 再作成でずれ、filesystem 走査だけでは actor・失敗・取得元を追えなかった。(A) `status-scanner.ts` を新設し、全登録 worktree を横断して `installed`/`modified`/`missing`/`unmanaged`/`update_available` を算出する。**走査対象 root は receipt の `install_roots` を正とし、install root 集合（`.agents/skills` / `.claude/skills`、#1460）の全 root を見る** — 片側 root だけを走査すると `.claude/skills` 側の削除・改変を「健全」と誤報告するため、この画面の存在意義そのものが失われる（`install_roots` を持たない旧 receipt は単一 root として読むので half-missing にはならない）。判定は既存 `assessSkillUninstall` の per-file 照合を再利用するので symlink 非追従・走査上限・receipt の自己 fold-in がそのまま効く。走査は同期 I/O のため promise pool は並列化に寄与しないと判断し、**上限＋worktree 毎の event loop yield＋短期 TTL cache** で保護した上で、打ち切りを `truncated` として黙らず報告する。(B) `reindex.ts` を新設し、receipt から `skill_installations` を再構築する。DB 全削除後も復旧でき、**復元後の root 集合は receipt の `install_roots` と一致する**。receipt 不在/破損/他 Skill 宛のディレクトリは index せず理由付きで報告し（勝手に index すると裏付けの無い provenance を主張することになる）、payload にも append-only log にも一切書かない。(C) `operation-audit.ts` の読み取りを拡張し、worktree 省略で横断、operation/result/期間で絞り込み、`(recordedAt, id)` 複合 cursor で改ページできるようにした（同一 ms の tie でも重複・欠落なし）。(D) DB migration **v48** で `skill_operations` に `from_version`/`to_version` と横断 feed 用 index 2 本を追加（`ALTER TABLE` なので既存行は NULL 遷移で読める。append-only trigger は維持）。遷移は journal から導出するため既存の書き込み経路に変更は無い。(E) API 3 route（`GET /api/skills/installations` / `GET /api/skills/operations` / `POST /api/skills/reindex`）と `/skills/installed` 画面、`commandmate skill reindex` を追加。Catalog 不達は 500 にせず `catalogAvailable:false` として更新判定のみ無効化し（走査結果は receipt 由来なので依然有効）、走査失敗を空一覧に退化させず、`result=faild` のような打ち間違いは 400 で拒否する（黙って全件返すと「失敗ゼロ」に見えるため）。監査は書き込み時 redaction 済みのため署名付き URL や絶対 path は保存されず、応答にも machine-absolute path を含まない。単一 root 走査・receipt 無視の 2 種の変異注入でテストが実際に赤くなることを確認済み。
- **Skill 導入専用の branch・scoped commit・draft PR workflow を追加** (#1247): Skill を install しても、その導入を review 可能な形（commit / PR）に載せる手段が無かった。`git add .` や既存 index を使う実装は無関係な作業中ファイル（secret を含みうる）を巻き込むため、**index を入力として一切使わない**設計にした。(A) `src/lib/skills/git-workflow.ts` を新設。stage する pathspec は **receipt の `install_roots` から導出**する（#1460 以降 install は `.agents/skills/<id>` と `.claude/skills/<id>` の**両方**へ byte-identical に配置されるため、`.agents/skills` だけを pathspec にすると PR に導入内容の半分しか載らない。旧 receipt は単一 root として読む後方互換も維持）。stage 後に `git diff --cached --name-status -z` を読み直し、owned root 外のパスと receipt inventory に無い追加/変更を fail closed で拒否する（削除は旧版の残骸が消えるケースなので root 内であれば許容）。(B) branch 確定は **Install Plan 生成より前**に行う `prepare` phase に分離した。plan は生成時の branch/HEAD に束縛されるため（#1233）、plan 生成後に checkout すると `SKILL_PLAN_STALE` が例外ではなく既定の結末になる。`dedicated_branch` は現在 HEAD から `skills/install-<id>-v<version>` を作って switch し（HEAD 起点なので working tree のファイルは 1 バイトも動かない）、**稼働中の Agent session がある worktree では拒否**する。開始条件は「既存 staged 変更が無いこと」で、unstaged/untracked の作業中ファイルは巻き込まずそのまま残す。(C) push は force 禁止・default branch 拒否・remote 未設定は install 前の `prepare` 時点で拒否。`gh` 呼び出しは `src/lib/skills/pull-request-service.ts` に閉じ込め、argv 配列のみ（shell 無し）で draft PR を作る。PR 本文には能力・期待効果・risk・宣言 permissions・scripts・提供元・source commit・artifact SHA-256・検証結果・変更ファイル一覧・Agent 互換性を載せ、diff 本文は載せない。machine-absolute path や token は publisher 由来の自由文を含め field 単位で除去する。(D) API は `POST /api/worktrees/[id]/skills/[skillId]/git-workflow`（prepare / apply）。apply は branch でも path でもなく **server 発行 token だけ**を受け取り、`branch` / `paths` / `commitMessage` / `force` 等の client 指定は明示的に 400 で拒否する。install 済み・commit 済み・push 済み・PR 未作成が別々の状態として区別でき、apply は再試行しても二重 commit / 二重 PR にならない。(E) CLI を薄い client として配線: `commandmate skill install <id> --git <current|dedicated> [--push] [--pr]`。`--git` に既定値は無く（commit 先は利用者が明示する対象）、`--push` / `--pr` 単独はエラー、`--dry-run` では branch を作らない。承認後に prepare → **plan を破棄して再生成** → install → apply の順で進む。実 git リポジトリ（unit）と実 bare remote への実 push（integration）で検証し、単一 root pathspec化・inventory 検証の削除・clean-index 前提の削除・再 plan の省略という 4 種の変異注入でテストが実際に赤くなることを確認済み。

- **Skill 配布 MVP の実ブラウザ E2E（Catalog 閲覧・install/uninstall）を追加** (#1242): 承認 UI の検証が component test（`fetch` モック＋React tree）止まりで、「実際のページで、実際の viewport で、利用者が何を見て承認しているか」を確認する自動テストが無かった。`tests/e2e/skills-catalog.spec.ts` と `tests/e2e/skills-install.spec.ts` を追加し、隔離構成（port 3177・専用 DB・空の非 git scan root）の実ブラウザで固定した: (1) target の repository/branch と **install root 両方**（#1460）が承認前に提示される、(2) permissions・requirements・scripts・per-file diff・stats が preview に出る、(3) high-risk は承諾チェックまで apply request が**ブラウザから出ない**（request log による negative 検証。「押せなかった」ではなく「送っていない」を主張する）、(4) blocker つき plan が「何も書かれていない＋何が阻んでいるか」として描画される、(5) Catalog 取得失敗が空 Catalog に退化せず stale が stale として出る、(6) 390px mobile で承認ボタンが column 内に収まり click でき、横スクロールが発生しない。Catalog と書き込み route は `page.route` で browser 側 stub（E2E サーバは上流 Catalog へ到達できない）。server 側の fail-closed と on-disk allowlist は既存 `tests/integration/skills-mvp-*.test.ts` の担当で、範囲が重ならないよう分けてある。あわせて「manifest が言及しない Agent の互換 view を生成しない」不変条件を `compatibility.test.ts` に追加（未計測を `unsupported` と表示すれば行っていない計測の主張、`commandmate_runtime` と表示すれば Phase 1 に無い機能の主張になる）。変異注入で非空振りを確認済み。

- **orchestrate-monitor に per-poll 状態ログと完了フック配線を追加** (#1533): 監視ループを回しても「総ポーリング数・状態分類の分布・完了判定の根拠」がログに残らず、#1513 G2（誤報 0 の実運用証明）の証拠採取ができなかった。さらに `count_commits` / `count_uncommitted` はスタブ（常に 0）のままで外から供給する手段が無く、`verify-completion.sh` が `commits=0 && uncommitted=0` を「タスク未送信」と読む STARTED ガードにより **COMPLETE 分岐が実運用で一度も発火しない**（完走した worker まで NOT_STARTED と記録される）状態だった。(A) `--verbose` を追加し、1 ポーリング 1 行の固定フォーマット `monitor[<wid>]: poll <N> -> <STATE> started= streak= commits= uncommitted= verdict=` を出力する。verdict だけでなく判定に渡した入力を並べるので「なぜ COMPLETE にならないか」が読める。**opt-in で、既定の stdout は 1 バイトも変わらない**（変更前の `monitor.sh` と 5 fixture で stdout を実 diff して同一を確認し、テストでも既定出力を byte 単位で pin した）。(B) `--hooks <file>` / `MONITOR_HOOKS` env で任意のファイルをスタブ定義の**後に** source し、定義された関数だけを上書きする（未指定時はスタブのまま、片方だけ定義したファイルでももう片方はスタブのまま）。指定したファイルが存在しない場合は黙ってスタブに落ちず exit 2 で失敗する。実運用でそのまま使える参考実装 `hooks-git.sh` を同梱（worktree-id を `git worktree list --porcelain` から実 checkout に解決し `git log --oneline <base>..HEAD` / `git status --porcelain` で数える。base ref が解決できなければ起動時に stderr へ警告）。(C) SKILL.md に A/B と #1513 G2 の証拠採取レシピ（どのオプションで回せば 4 項目が 1 本のログに揃うか、各項目の取り出しコマンド付き）を追記した。判定ロジック（`classify-state.sh` / `verify-completion.sh` / 介入条件）は不変、bash 3.2 互換と #1527 の決定論的テスト設計も維持。「フック有りで COMPLETE 到達／無しで到達不能」を両方向で固定し、5 種の変異注入（既定 verbose ON・フックを先に source・`--hooks` 無視・poll 行の書式変更・参考フックの commit 数 0 固定）でテストが実際に赤くなることを確認済み。

### Fixed

- **uninstall した Skill を再 install すると exit 0 のままファイルが1つも書かれない問題を修正** (#1552): CLI は per-request の idempotency key を送らないため、journal は key を binding（actor / operation / worktreeId / skillId / version / plan hash）から導出する。uninstall するとその入力は**すべて元の値に戻る**（install root が消えるので `currentTreeHash` も、receipt が決定的なので `receiptDigest` も初回と一致する）ため、次の install は初回とまったく同じ key を導出し、`beginSkillOperation` が初回の SUCCEEDED entry を replay として返していた。結果、CLI は `Installed …` と表示して exit 0 で終わるのに 1 バイトも書かれず、`skill status` は `installed:false` を返す（成功報告と status が矛盾する）。replay 応答は index 由来で、uninstall 済みなので `install: null` → CLI が plan 側の単一 root にフォールバックし、成功メッセージの install root が 2 個から 1 個に減るのが唯一の外形的な兆候だった。journal retention は 7 日なので、一度 uninstall した Skill は当該 entry が消えるまで再 install できない。**`uninstall/route.ts` にも同じ欠陥があることを実測で確認した**（uninstall plan の binding は snapshotId を含まず全項目が決定的なので、install → uninstall → install → uninstall の 2 回目の uninstall が初回の記録を replay し、`Removed …` と報告しながらファイルを 1 つも消さない）。対策として `src/lib/skills/operation-replay.ts` を新設し、**filesystem commit を主張する entry に限り、その主張が今も worktree に対して真かを replay 前に照合する**: install は primary root の receipt が実在し digest が記録と一致すること、uninstall はその receipt が存在しないこと。偽になった entry は supersede（削除して新規 operation を開始）し、両 route の client-key 分岐と `beginSkillOperation` の両方に適用した。commit 前の entry（PREPARING / rollback 済み failure）は on-disk の主張を持たないため従来どおり in-progress / failed として replay され、**PREPARING は predicate に関わらず supersede しない**（実行中の operation の crash recovery 記録を落とさないため）。「同一リクエストのネットワーク再送は 1 回しか実行されない」という replay 本来の意図は既存テストごと維持されている。Issue 本文は根本原因を install route の client-key 分岐（323-328 行）と記述しているが、**CLI はそもそも key を送らないためその分岐は通らず、実際の発生点は `begun.replayed` 側（374-376 行）である**（不具合時に journal entry が新規作成されないという本文の観察とも一致する）。対策案 2（uninstall 成功時に対になる install entry を無効化）は採らなかった: uninstall route は install plan の hash を持たないため対の key を導出できず journal 全走査が必要になるうえ、手動削除で payload が消えた場合を救えないため、on-disk 照合が両方を同時に扱える。install route のみ・uninstall route のみ・guard を常時 false にする 3 種の変異注入で、追加した回帰テストと既存 replay テストがそれぞれ実際に赤くなることを確認済み。
- **Skill ドキュメントの手動 rollback 手順が install root を1つしか消しておらず、実行すると復旧できない状態になる問題を修正** (#1242): `docs/user-guide/skills.md` が #1460 以前の単一 root 前提（`.agents/skills` のみ）のまま残っていた。§4-2 の手順どおり `rm -rf <worktree>/.agents/skills/<id>` だけを実行すると、`.claude/skills/<id>` が残るため **Claude Code からは Skill が見え続ける一方、再 install は残った側の destination が既存であるため `SKILL_INSTALL_DESTINATION_EXISTS`（409）で拒否される**という、利用者が自力で抜けられない状態になっていた。両 root を消す手順へ訂正し、正確な root 一覧を receipt の `install_roots` で確認する方法を併記した。あわせて support matrix（install 先・変更範囲の保証・残留物の掃除・`committed_reconciling` からの復旧・worktree 再作成後の復旧）を両 root へ訂正し、UI 導線を「未接続」・導入済み一覧を「未提供」と書いたまま §3-1 の記述と自己矛盾していた箇所を #1431 / #1440 の実態へ、Agent 対応状況を 2026-07-26 の実機実測（Claude Code 2.1.220 は `.claude/skills` を読み `.agents/skills` は読まない／Codex CLI 0.145.0 は `.agents/skills` を読むが slash command としては露出しない／Gemini・OpenCode・vibe-local は未計測）へ更新した。`docs/qa/skills-mvp-uat-report.md` も第2回判定として、人手検証3件のうち実機ブラウザ UAT を自動 e2e で充足・実 Agent discovery を実測済みへ降格し、残る保留を初見参加者 UX 調査1件に絞った。
- **orchestrate-monitor の `monitor-resend.test.ts` が壁時計 timeout に判定を委ねていた問題を修正** (#1527): ループが COMPLETE 以外で終わらないため、テストは `spawnSync` の 2.5 秒 timeout で監視ループを kill し、その時点までに何ポーリング進めたかで判定していた。マシン負荷次第で 2 回目のポーリングに届かず「`resend budget spent` を含むこと」が低頻度で落ちる一方、否定的アサーション2件（`expect(tmuxCalls).toEqual([])`）は**ループが0回でも無条件で PASS** する偽の緑だった。(1) `monitor.sh` に `--max-polls N`（既定 0 = 従来どおり全ワーカー COMPLETE まで継続）を追加し、ループが内側から決定論的に exit 0 できるようにした。停止条件のみの追加で状態判定・介入条件は不変、bash 3.2 互換も維持。(2) テスト側は `--interval 0` ＋ `--idle-threshold 1` ＋ ケースごとに必要なポーリング回数を定数化し、**launcher shim の呼び出し回数・exit 0・`--max-polls` 到達ログを検証してからでないと空を主張しない** gate を通す。ループを1回で打ち切る／必ず介入する変異を注入すると当該テストが実際に赤くなることを確認済み。実行時間も 12.5s → 2.8s に短縮した。

## [0.15.0] - 2026-07-26

> **Highlight**: モバイルとリポジトリ登録まわりの体験を厚くしたリリース。**リポジトリ登録の Local Path を GUI で選べる**ようになり（`CM_BROWSE_ROOTS` 新設、認証必須のディレクトリ一覧 API 込み）、**Markdown 編集で Tab インデント**が効くようになり、**モバイルの Markdown 閲覧/編集が1画面に統合**された。あわせて GitPane の ahead/behind が「なぜ数字が出ないのか」を説明するようになり（🔄 が実際に `git fetch` するよう変更、最終 fetch 時刻とバッジを追加）、新規ブランチの既定エージェントを実際に使う3件へ絞った。並列オーケストレーション運用中に発見した監視 Skill の欠陥5件と、モバイル統合の回帰1件も同時に修正している。

### Added

- **orchestrate 監視レシピを実行可能 Skill 化** (#1512): `/orchestrate` 運用で実証済みの監視ノウハウ（capture 解析・状態判定・介入判断・完了/スコープ検証）を、セッションメモリ依存から `.claude/skills/orchestrate-monitor/`（SKILL.md＋bash 3.2 互換スクリプト群）へ資産化した。判定ロジックを fixture ベースで単体テスト化し、既知の誤報2パターン（未起動 idle の COMPLETE 誤報／検証ガード自身の偽陽性）を回帰テストで固定。CI で `bash -n` 構文チェックを回す。#1452 Harness Pack の移植元となる自家用 Skill（公式カタログ配布は後続 #1513）。
- **Markdown/テキスト編集で Tab インデント・Shift+Tab アウトデントを可能に** (#1518): 素の `<textarea>` に自前実装した。インデント計算は純関数 `src/lib/editor/indent.ts`（複数行選択は各行を字下げして選択を維持、単一行はタブストップ揃え、CRLF の `\r` を保持、空行はスキップ）。挿入は常に **2 スペース固定**でタブ文字を入れない（同じエディタが YAML を編集するため）が、アウトデントは既存ファイル中の先頭タブも 1 単位として除去する。適用は `document.execCommand('insertText')` を第一手にして **Ctrl+Z 1 手で戻る**ようにし、非対応環境では React state ＋ `setSelectionRange()` 復元へフォールバックする。`handleKeyDown` が textarea とルート div の両方に張られて 1 打鍵で 2 回発火していた既存不具合をガードで解消（副産物として Ctrl+S の二重発火も解消）。キーボードトラップ回避として **Ctrl+M**（Cmd+M は macOS のウィンドウ最小化と衝突するため不採用）で Tab をフォーカス移動へ戻すトグルを追加し、no-op な Shift+Tab は既定動作に委ねる。モバイル向けに `MarkdownToolbar` へ 44px のインデント/アウトデントボタンを追加し、`keyboard-shortcuts` に `editor` scope を新設（未登録だった Ctrl+S / Ctrl+Shift+F も登録）。
- **リポジトリ登録の Local Path を GUI フォルダ選択に対応（`CM_BROWSE_ROOTS` 導入）** (#1517): 絶対パスの手入力しか無かった Local Path に「参照…」を追加した。ブラウザの `showDirectoryPicker()` は絶対パスを返さず選択対象もサーバ側 FS のため、**サーバサイドのディレクトリ一覧 API ＋ 自前 picker** で実現している。(A-0) `scan` の 400 に許可ルートを含め、`localPathExample` を許可ルートから動的生成し、`POST /api/repositories/validate-path` で入力中に「git リポジトリ / worktree N 件 / 許可ルート外」を即時フィードバックする。(A-1) `GET /api/fs/browse`（**認証必須**）を新設し、許可ルート集合（`CM_BROWSE_ROOTS` ∪ `CM_ROOT_DIR`）を**単一の共通リゾルバ**で評価する。browse・scan・validate-path が同じリゾルバを通るため「picker で選べるのに登録は 400」という不整合が構造的に起きない。ディレクトリのみ返しファイル名は返さず、dotfile 非表示・エントリ上限 500・レート制限（browse 120/分、validate-path 180/分、429 ＋ `Retry-After`）・`resolveAndValidateRealPath()` による symlink 脱出防止を備え、拒否ログは理由 enum のみ記録する。(A-2) `DirectoryPickerModal`（パンくず＋1階層リスト＋「ここを選択」、モバイルは全画面シート）を追加し、最近使ったパスを `app_settings` に保存する。**パスの手入力欄は従来どおり残す**（別ホスト運用・上級者向け）。clone 先は `CM_ROOT_DIR` のまま（#1328 の思想を維持）。
- **モバイルの Markdown 閲覧/編集を1画面に統合** (#1519): 検索 / 内容コピー / パスコピー / ダウンロード / ビュワー⇄編集切替が 2 つのモーダルに分断されていたのを `FileViewer` の中へ集約した。モバイルには**レンダリング済み Markdown ビュワーが存在せず**生ソースのテーブル表示に落ちていたが、PC split と同じ `MarkdownPreview` を再利用することで解消（mermaid #100 / コードブロックコピー #981 / 相対リンク遷移 #505 がそのまま効く）。ビュワー⇄編集は**相互**に切り替え可能になり（従来は鉛筆からの片道で、閉じると Files ツリーに戻っていた）、content を `FileViewer` が 単一の source of truth として保持するため**モード切替で再 fetch しない**。4 機能は `MobileTerminalActionsSheet`（#1080）に倣ったボトムシートへ、**最大化はシートに入れずツールバー常設のワンタップ**に統一した。あわせて操作要素を 44px 以上（#1127 準拠）にし、回転に追従しなかった `isMobilePortrait` を `matchMedia('(orientation: portrait)')` ベースの `useIsPortrait` へ置き換えた。モバイル TOC（P2）は見送り。

### Changed

- **ブランチ追加時のデフォルトエージェントを claude / codex / antigravity の3件に変更** (#1516): `DEFAULT_SELECTED_AGENTS` から gemini / opencode / copilot を外し、新規ブランチのエージェントタブが3つになるようにした。選択可能プール（`CLI_TOOL_IDS`）は変更していないので、外した3つも設定画面から後から選べる。効果があるのは `selected_agents` が NULL かつ `agent_instances` 行が無い worktree のみで、ユーザーが明示設定済みの worktree とロスター保持済みの worktree は従来どおり（既存分を揃えるマイグレーションは別 Issue）。

### Fixed

- **モバイルの Markdown アクションシートが本文の裏に描画され全アクションがタップできない不具合を修正** (#1528): #1519 の回帰。`MobileFileActionsSheet` を `markdown-file-screen`（`position:fixed` / `Z_INDEX.MAXIMIZED_EDITOR`=55 / 不透明背景）の**兄弟**として描画していたため、シート自身の `z-50` が常に負け、検索・内容コピー・パスコピー・ダウンロードの**4アクションすべて**が「見えない・押せない」状態だった（`elementFromPoint` は各行の中心で本文の `<LI>`/`<CODE>`/`<H2>` を返す）。あわせて `actionsOpen` を閉じられなくなるため Escape ラダーも無効化されていた。シートを screen の**内側**へ移して stacking context を共有させることで解消する（グローバルな z 階層は増やさない）。jsdom にはレイアウトも描画順も無く、Testing Library の click は hit-test を経由しないため単体テストでは検出できない。回帰は実ブラウザの e2e（`tests/e2e/mobile-file-actions-sheet.spec.ts`）で固定し、修正を戻すと 3 件とも失敗することを確認済み。
- **GitPane の ahead/behind が「リモート先行なのに ↓0」「チップごと消える」問題を修正** (#1515): 原因は実装バグではなく、アプリがリモートを一度も見に行っていなかったこと（自動 `git fetch` が不在で `@{upstream}` が古いまま）と、`getAheadBehind` が全失敗を `null` に潰して UI がチップを丸ごと隠していたこと。(A-1) Current Status の 🔄 を「fetch → status 再取得」に変更し、実行中はスピナー＋非活性化。(A-3) `lastFetchAt` を payload に追加し「最終 fetch: ◯分前」を併記（linked worktree では `.git/worktrees/<name>/FETCH_HEAD` と共有 gitdir の新しい方を採用）。(B) `aheadBehindReason`（`no_upstream` / `upstream_gone` / `detached` / `error`）を API に追加し、未プッシュ／リモート削除済み／detached をバッジで説明する（stderr は分類後に破棄し、enum 以外はクライアントへ出さない）。(D-1) ahead/behind ツールチップに「最後に fetch した時点との比較」である旨を ja/en 双方で明記。(E-1) `execGitNetworkAware` に `GIT_TERMINAL_PROMPT=0` を設定し、認証情報の無い HTTPS remote で fetch が端末プロンプト待ちにならないようにした。自動 fetch（A-2）・導線変更（C-1）・ブランチ一覧への描画（D-2）は本 Issue のスコープ外。
- **orchestrate-monitor の状態判定が実セッションで機能しない問題を修正** (#1522): #1512 で追加した監視 Skill は単体テストが全緑のまま**実機では一度も生成中を検知できていなかった**。根本原因は正規表現ではなく **fixture** で、ANSI を剥がした手書き payload をテストしていたため「製品が出力しない形」を検証していた。実 TUI は `↓` と数値の間に色リセットを挟むので `↓ [0-9]` は永久に一致しない。(1) `ml_strip_ansi` を追加してアンカー照合を ANSI 除去後に行う。(2) トークン出力前でも生成中を検知できるよう `esc to interrupt`（ターン実行中のみ出るフッタ）をアンカーに追加。(3) `ml_is_retrying` を追加し、CLI 自身の 5xx バックオフ中は生存扱いにする（介入しても再開せず stray メッセージが queue されるだけのため）。(4) リトライ枯渇死（terminal API error ＋ idle プロンプト）を検知して再送する経路を追加。(5) `ml_has_rate_limit` の裸の `rate.?limit` が**ワーカーの表示中ソースや作業指示文に誤マッチ**して健全なセッションへ入力を注入していたため、バナー固有の言い回しに限定し、`RATE_LIMIT` は生成中を否定してから最後に評価する。あわせて fixture を**実機採取の ANSI 付き payload**へ差し替え、`fixture-fidelity.test.ts` で「live fixture は ANSI を保持し、素朴なアンカーでは一致しないこと」を固定して同じ盲点の再生産を防ぐ。

## [0.14.1] - 2026-07-24

### Fixed

- **端末オーバーレイの矢印ナビを検出非依存化（デスクトップ＋モバイル）** (#1494, #1496): `/help`・`/model` 等の未分類 TUI オーバーレイで ESC しか送れず ←/→/↑/↓/Enter が送れなかった問題を、`TerminalEscapeHatch` を Esc 専用から汎用ナビパッド（←/↑/↓/→/Enter/Esc、Codex は追加で `q`）へ拡張して解消した。`isUnclassifiedActive` ゲートは従来どおりで、選択リスト／プロンプト検出時は非表示。モバイルパスは `MobileTerminalTab` を独立モジュール化し、デスクトップと同一ゲート（`isUnclassifiedActive && !prompt.visible`）でハッチを描画してデスクトップと同等の到達性を与えた。
- **Auto-Yes が Claude `/model` オーバーレイを誤って自動応答しデフォルトモデルを変更する不具合を修正** (#1495): `/model` の番号付きモデル一覧を `detectMultipleChoicePrompt` が本物の multiple_choice と誤検出し、Auto-Yes が Enter 確定して既定モデルを無断変更していた。実機 Claude Code v2.1.218 のフッタ「Enter to set as default …」を検出したら `detectPrompt` を非プロンプト扱いにして Auto-Yes を停止し、あわせて `CLAUDE_SELECTION_LIST_FOOTER` に同フッタを追加して `/model` を Claude selection list（NavigationButtons＋ESC ハッチ／`hasActivePrompt=false`）へ再分類する。権限確認・trust ダイアログ・AskUserQuestion・Gemini `/model` 等の本物のプロンプトは非回帰（実キャプチャ fixture で検証）。
- **未分類 TUI が5秒静止でナビハッチ消滅する不具合を修正** (#1497): 未分類オーバーレイ（`/help` 等）が静止すると Auto-Yes の `lastServerResponseTimestamp` 更新後に `ready`/`no_recent_output` へ降格し、`isUnclassifiedActive` が落ちてナビハッチ（#1017/#1494）が消えていた。真の idle プロンプト（`❯`）は降格前に `input_prompt` として分類されるため、`no_recent_output` フォールバックは未分類フレームでしか起きない。よって `current-output-builder` の `isUnclassifiedActive` ゲートを `ready`/`no_recent_output` も含めるよう緩和し、静止中もハッチを表示し続ける。実キャプチャ fixture ＋ stale timestamp で単体テスト（真の idle 非回帰込み）。
- **slash-commands カタログの antigravity 幻コマンド3件を除去＋実在コマンド追補** (#1502): agy 1.1.3 に存在しない `/compact`・`/status`・`/review` を antigravity スコープから除去（`/status`→`/statusline`・`/review`→`/teamwork-preview` の別コマンド誤実行を防止）。あわせて実在する `/help`・`/usage`・`/mcp`・`/hooks`・`/diff`・`/fork`・`/plan`・`/rewind`・`/tasks` を追補し、`frequentlyUsed.antigravity` を新設。en/ja 辞書に不足していた `tasks` の説明を追加。claude/codex のカタログは非回帰。
- **antigravity セッションで skills がパレットに出ない不具合を修正** (#1504): `.agents/skills` 由来 entry を codex 専用扱い（`cliTools: ['codex']`）していたため、agy（`.agents/skills` を読む）のパレットに skill が一切出なかった。`loadAgentsSkills` を `['codex', 'antigravity']` に広げ、挿入トリガ `getSlashCommandTrigger(command, cliToolId)` を拡張して antigravity では `/name`（codex は従来どおり `$name`）を挿入。cliTools 拡張で dedup キーが割れ codex セッションで `.codex/skills` と `.agents/skills` の同名 skill が二重表示する副作用を `mergeCodexFamilySkills`（同名は `.agents/skills` 優先で collapse）で解消。claude は `.agents/skills` を読まない前提を維持（非表示）。
- **submit-verified-sender が TUI 補完置換を誤判定して別コマンド実行／残留する不具合を修正** (#1501): 存在しないスラッシュコマンド送信時、TUI ポップアップが入力を別コマンドへ置換（`/status`→`/statusline`、`/review`→`/teamwork-preview`）するのを検証ループが判別できず、Enter 再送で別コマンド誤実行（フレーバーA）または残留（フレーバーB）していた。判定を submitted/pending/replaced の3値化（`classifySubmit`）し、入力行が body の前方一致でない `/…` コマンドに置換されたら Enter を再送せず `clearInputLine`（内部専用 `C-u`、special-keys API 非露出）で入力行をクリアして throw する。正当な typed-but-unsent 回復（body 前方一致→Enter 再送）は非回帰。
- **グローバル `~/.claude/skills` がパレットに出ない非対称を修正** (#1505): codex のグローバル skills（`~/.codex/skills`・`~/.agents/skills`）は表示されるのに claude のグローバル skills（`~/.claude/skills`）を読む経路が無く、claude セッションのパレットに worktree 配下しか出なかった。route に `loadSkills(os.homedir())` を追加し `~/.claude/skills` を `source:'skill'`（cliTools 未定義＝claude のみ）としてマージ。worktree の同名 skill が優先されるよう global グループを worktree より前に置き（`mergeCommandGroups` は後勝ち）二重表示を防止。codex/antigravity には非表示、`$HOME` 側 dir 不在でもエラーにならない。
- **slash-commands カタログの claude/codex 幻コマンド計7件を除去** (#1503): `verifiedAgainst` と同一版の実機で不在を確認した claude の `/cost`・`/lazy`・`/todos`・`/pr-comments`・（`(removed)` スタブの）`/agents` と codex の `/approvals`・`/undo` をカタログから削除（`agents` の opencode 版は無関係なので保持）。未使用化した `descriptionKey` を en/ja 辞書から削除し、`frequentlyUsed` からも除去。隠しコマンド `/clear`・`/quit`・`/subagents`（codex）は「完全入力で一致する実在コマンド」なので誤削除しないことをテストで担保。再発防止として `/release` の確認手順（`missingFromSource` の目視）を SKILL.md に追記。

## [0.14.0] - 2026-07-24

### Added

- **スラッシュコマンドカタログの自動最新化エンジン** (#1489): 権威ソース（claude=公式 docs `commands.md` / codex=OSS `slash_command.rs` enum）からコマンドを列挙し、bundled カタログとの差分を検出・適用する reconcile 層（`src/lib/slash-command-reconcile/` の engine / fetch / sanitize / providers）と CLI（`scripts/refresh-slash-command-catalog.ts` / `npm run catalog:refresh`、`--check`/`--write`）、`/release` skill への統合フックを新設した。取得は fail-soft、名前 allowlist 検証・サニタイズ、`verifiedAgainst` は照合した版のときのみ更新する。antigravity は Phase 2 のインターフェースのみ（fail-soft で据え置き）。
- **スラッシュコマンドカタログに claude 組み込みコマンド（/loop 等9件）を追補** (#1488): 公式 docs を正として `/loop` 等を bundled カタログへ追加し、Claude Code で候補に表示されるようにした。あわせて `verifiedAgainst` の意味を「内容照合済みの版」に是正した。

### Changed

- **削除操作に確認ダイアログを一貫導入** (#1487): 確認なしで即削除していた Note / ToDo（worktree・Home）/ エージェントインスタンス削除に、既存の `useConfirm`（ConfirmDialog）を適用した。独自確認を持つ操作（External App / Git / Skill uninstall 等）は現状維持。

## [0.13.0] - 2026-07-24

### Added

- **組み込みスラッシュコマンドのカタログ・データファイル化＋ユーザー拡張＋陳腐化検知** (#1476): ハードコードだった `STANDARD_COMMANDS` を同梱 JSON カタログ（`src/config/slash-commands-catalog.json`）へ外部化し、`~/.commandmate/slash-commands/*.json`（グローバル install 時）でユーザーがコマンドを追記・上書きできるようにした（`source: user-catalog`、同名同スコープはユーザー定義優先、壊れたファイルは警告＋スキップで一覧継続）。claude / codex / antigravity の実 CLI 版を取得し `verifiedAgainst` と比較して、カタログが古い場合に API レスポンス（`catalogStaleness`）と UI へ非侵襲に表出する。
- **Skills ペインでスキル概要を表示** (#1479): worktree の Skills ペイン（PC アクティビティバー／モバイル Tools）で、Catalog 節・Installed 節の各スキルに概要（summary）を表示するようにした。
- **リポジトリ追加に fork（gh repo fork）オプションを追加** (#1480): Clone URL での追加時に「Fork before adding」を選ぶと、認証済み GitHub CLI で自分のアカウントへ fork してからクローンし、origin=自分の fork / upstream=元リポジトリに設定する。push 先が自分の fork になり upstream を汚さない。

### Fixed

- **スキルインストール後、リロードせずスラッシュコマンドパレットへ反映** (#1477): サーバは常に最新を返すのにクライアント（`useSlashCommands`）が install 後に再取得しなかった問題を、`skill:installed` CustomEvent（worktreeId スコープ）→ `refresh()` の配線と fetch の `{cache:'no-store'}` 化で解消した。表示テストは実 DOM に新スキル候補が出るところまで検証する。

### Changed

- **チュートリアルを fork 前提＋Skills 活用シナリオへ改修** (#1478): サンプルリポジトリを先に fork してからクローンする手順に変更し（upstream 非汚染）、Skills を UI から install して使う体験を追加した（ja / en 対訳）。

## [0.12.1] - 2026-07-24

### Fixed

- **`commandmate send`（および Timer / Web UI チャット / terminal API）で長文・単一行メッセージが submit されず worker が起動しない問題を修正** (#1469, #1470, #1471): tmux `send-keys` が本文と Enter(`C-m`) を単一コマンドで送ると、Claude Code 等の ink/React TUI が本文を bracketed paste として扱い、直後の `C-m` を貼り付けバッファ内の改行として消費するため、メッセージが入力欄に置かれたまま submit されない（typed-but-unsent）。既存の貼り付け回復ロジックは (1) `message.includes('\n')` ゲートで単一行を対象外、(2) Claude 固有・版依存の `[Pasted text #\d+` 文字列照合に依存、(3) 送信後の submit 未検証（fire-and-forget）という3点で穴があった。`src/lib/cli-tools/submit-verified-sender.ts` を新設し、本文と Enter を分離送信（本文→遅延→`sendSpecialKeys(['Enter'])`）、`\n` ゲートを撤廃して全メッセージへ貼り付け回復を適用、read-back で submit を検証（入力欄が空 or generating へ遷移を確認、未 submit なら Enter 再送、確定不能なら明示エラー）、版依存パターンへの依存を排除した。claude（`session-key-sender.ts`）・codex/gemini/copilot/opencode/vibe-local/antigravity の各 `sendMessage()`・terminal route（`terminal/route.ts`）へ一貫適用し、7 箇所に複製されていた `\n` ゲートを共通ヘルパへ集約した。ツール固有挙動（vibe-local の二重 Enter、copilot の選択リスト分岐・改行潰し）は維持。#212 の pasted-text 検出の不完全修正の再燃を解消。

## [0.12.0] - 2026-07-22

### Added

- **Agent Skills 配布契約（Skill manifest・Catalog・receipt・脅威モデル）を定義** (#1228): SKILL.md との互換性を保ったまま、CommandMate 固有の配布・Runtime metadata を同一 Skill root の `commandmate.skill.yaml` に分離する契約を確定した。`src/types/skills.ts` に4文書（manifest / Catalog / 検査結果 / installed receipt）の型、`src/lib/skills/` に schema_version 1 の fail-closed validator・厳格 SemVer 2.0・公開 JSON Schema・エラーコードを追加。Skill ID は lowercase ASCII slug（最大64文字・予約名・case/Unicode 衝突検出）、artifact は `tar.gz` / `<skill-id>-<version>.tar.gz` / `application/gzip` に固定（archive root は root 省略・`<skill-id>`・`<skill-id>-<version>` の3形のみ受理）、artifact 全体の SHA-256 は Catalog、個別 payload file の digest は manifest が持ち manifest 自身の digest は要求しない。tag ではなく resolved commit SHA を必須とし、receipt は timestamp・actor・machine absolute path・signed URL を持たない決定的な文書とした。権限は宣言であって enforcement ではないことを命名（`declared_permissions` / `declared_risk`）と UI 注記で区別し、実効 risk は宣言と算出の高い方とする。決定表と脅威モデルは [docs/design/agent-skills-distribution.md](./docs/design/agent-skills-distribution.md)、valid/invalid fixture は `tests/fixtures/skills/contract/` に置いた。本 Issue は契約定義のみで、Catalog 取得・download・install・UI は含まない。
- **公式Skill Catalog・artifact の安全な取得と snapshot 管理** (#1229): 公式 allowlist の Catalog/artifact だけを stream 取得し、immutable SHA・checksum・容量を検証した read-only snapshot として TTL・参照数・quota 付きで管理する層を追加した。`redirect: 'manual'` で各 hop の scheme/host/path を再検証し origin 変更時に credential header を除去、Content-Type / Content-Length / 実測 size を検証して上限超過は転送途中で abort する。snapshot は 0700 の service-owned data root 配下に 0400 で保存し opaque ID でのみ参照でき、使用中は evict しない。archive 展開は行わない（#1230）。
- **Skill package の完全照合・安全な検査・展開基盤** (#1230): 検証済み snapshot を read-only 入力として全 entry を先に解析し、#1228 の package 契約と完全一致した場合だけ 0700 staging へ `O_EXCL|O_NOFOLLOW` で materialize する層を追加した。tar.gz を自前解析して symlink / hardlink / device / FIFO / contiguous / pax / GNU 拡張を typeflag と link field の二重 guard で拒否、setuid/setgid/sticky を拒否し uid/gid/mtime を破棄、path・duplicate・case/Unicode collision・file 数・展開 size・compression ratio を全 entry へ適用する。`SKILL_YAML_SAFE_PROFILE` を満たす YAML 部分集合 parser（anchor/alias/merge key/custom tag/duplicate key/prototype key を拒否）を新規依存なしで実装。manifest と package を path/size/digest/kind/executable/script の全軸で双方向照合し、未宣言 file/script/executable を拒否する。検査・展開のいずれでも archive 内 script を実行しない。悪性 corpus 59 件をコードで構築し、guard 破壊 mutation 12 件すべてがテストで検知されることを確認した。
- **公式Skill Catalog client・cache・API と CommandMate 互換性判定** (#1231): 固定 endpoint からの Catalog 取得・厳格検証・cache・version resolution・互換性判定を server-side の単一 domain service に集約し、`GET /api/skills` と `GET /api/skills/[id]` を追加した。cache は schema 検証を通過した document でしか置換せず、fetch 失敗・oversized・JSON 不正・schema 違反は last-known-good を残して `stale=true` と理由 code を返す。互換性は compatible / incompatible / unknown の 3 値で、range 解釈不能・host version 不明はいずれも unknown へ fail close する。artifact URL は response に含めない。endpoint allow-list は前方一致ではなく完全一致とする。
- **Skill Catalog 一覧・検索・詳細画面** (#1232): `/skills` と `/skills/[skillId]` を追加し、能力・期待効果・version・provider・互換性・risk・changelog を一貫した語彙で表示する。互換性 unknown を compatible として描画せず、Catalog の stale/offline は理由コードと timestamp 付きで警告表示する。publisher 宣言 risk と CommandMate 算出 risk を区別し、permission が宣言であって enforcement ではないことを常時表示する。changelog は rehype-sanitize に加えて `stripRemoteMedia()` で image/iframe/video/audio/embed を除去し、Catalog 閲覧が外部ホストへリクエストを出さないようにした（共有 sanitize schema が `img[src]` の http(s) を許可するため）。More 画面と Command Palette に導線を追加し、`locales/{en,ja}/skills.json` を新設した。
- **Skill 操作の排他・journal・最小監査・reconciliation 基盤** (#1234): install/uninstall が crash 後も一意の結果へ収束するための共通基盤を追加した。(worktree, skillId) 単位の O_EXCL lock は owner nonce / PID / host / process generation / lease heartbeat を持ち、lease 失効後も owner が生存していれば reclaim しない。journal は PREPARING / FS_COMMITTED / INDEXED / SUCCEEDED / FAILED_RECONCILABLE の typed transition を持ち、filesystem atomic rename を commit point として commit 後の失敗を rollback と偽らず前進のみ許す。idempotency key を actor / operation / target / planHash へ bind し replay を同一結果に収束させる。append-only `skill_operations` テーブル（migration v44）は BEFORE UPDATE/DELETE trigger で追記専用を DB 側から強制する。
- **対象worktree選択とInstall Plan・Git差分preview** (#1233): `worktreeId` だけを入力に、live branch/HEAD と検証済み artifact snapshot を固定した期限付き Install Plan を生成する `POST /api/worktrees/[id]/skills/[skillId]/plan` を追加した。request に filesystem path・artifact URL・file list・checksum を受け取らず（含まれる場合は 400 で明示的に拒否）、DB の trusted path から解決する。既存 file は receipt の digest と一致する場合のみ managed とし、それ以外は conflict / unmanaged として `installable: false` にする（暗黙 overwrite の経路を作らない）。`.commandmate-receipt.json` の exact bytes を plan 時に確定し inventory・virtual diff・planned tree hash へ含める。plan token は server-side state（TTL 10分・1回性・LRU）へ bind し、apply 時の drift は 409 `SKILL_PLAN_STALE` で拒否する。detached/unborn HEAD、dirty working tree、git ignore、binary、truncation、CRLF/mixed line ending を個別の warning code で明示する。
- **単一worktreeへのatomic installとdeterministic receipt** (#1235): #1233 の plan と #1234 の operation 基盤を合流させ、検証済み plan を preview と同一 byte 列のまま worktree へ commit する `POST .../install` を追加した。payload write は `O_CREAT|O_EXCL|O_NOFOLLOW` + write 後の mode/nlink/size/digest 再確認で、symlink や既存 file を通り抜けて書くことが表現不能。staging は destination と同一 filesystem の予約 namespace `.agents/skills/.commandmate-staging/<operation-id>/` に置き、rename 直前に ancestor の lstat 連鎖と worktree realpath identity を再確認して destination 不存在を自前で証明する（`rename(2)` は空 directory を黙って置換するため syscall に委ねない）。receipt は plan が固定した bytes をそのまま書き、staged tree の hash が planned tree hash と一致しなければ publish しない。script/hook は一切実行しない。rename 後の失敗は rollback と偽らず `committed_reconciling` として返す。migration v45 で `skill_installations` index を追加。
- **安全なuninstallとunmanaged・local change保護** (#1236): receipt ownership と全 file digest を照合し、modified / unknown / missing / unmanaged / irregular が1つでもあれば何も削除せず停止する zero-delete fail closed な uninstall を追加した（`POST .../uninstall-plan` と `POST .../uninstall`）。unlink 直前に install root からの directory 全 component を `lstat`、対象の symlink / 非 regular / `nlink !== 1` を拒否、mode 照合、bytes 再読込と digest 照合を経てから削除する（scan 結果は過ぎた瞬間の証拠でしかないため syscall 直前に取り直す）。directory は `rmdir(2)` のみ使用し、receipt の file 一覧から導出した directory だけを対象とするためユーザーが作った空 directory は回収しない。receipt は最後に削除し、途中失敗時に journal からも人間からも reconcile できる状態を保つ。`force` / `recursive` は無視ではなく明示的に拒否する。
- **`commandmate skill` 管理コマンド** (#1237): `skill list/info/plan/install/uninstall/status` を既存 Skill API の thin client として追加した。CLI 側では download / extract / write / delete を一切行わず、server が発行した plan token をそのまま apply へ渡し、file list・checksum・path・artifact URL を再構成しない。書き込み系は必ず plan を表示してから確認し、`--dry-run` は plan で停止、**非TTY では明示 `--yes` が無い限り write せず**、**high-risk は `--yes` とは別に `--ack-risk <skill-id>@<version>` の完全一致を要求する**（`--yes` 単独でも TTY 承諾でも通らない）。typed API error を安定した exit code（1 到達不可 / 2 引数・不在 / 11 worktree 側拒否 / 12 未確認 / 13 reconciliation 待ち）へ mapping し、plan summary・確認・警告・エラーは stderr、`--json` の stdout は失敗時に空とする。`ApiClient` に typed error payload（`code` / `error` / `blockers`）を追加した。

- **Skill MVP の統合・security regression・UAT 自動検証** (#1242): Phase 1 の出荷判定 gate として、各 Issue が個別に mock していた層を実物のまま繋いだ統合 suite を追加した（新規 114 test）。実 git リポジトリ・実 snapshot store・実 package reader/validator・実 filesystem write を通し、stub は「network を踏まないための Catalog / download」「server の DB」「throwaway な config root」の3点のみに限定する。悪性 corpus 59 件は #1230 の unit test（reader が拒否すること）に加えて **install 経路全体で拒否され、worktree が byte 単位で不変であり、lock・staging・snapshot 参照を残さないこと**を検証する。UI と CLI を同一 route handler・同一 fixture Catalog へ通し（`fetch` を handler へ dispatch するため socket を開かず、稼働中の port 3000 へ誤接続しない）、plan token の channel binding・非TTY での `--yes` 必須・drift・期限切れ・単回性・同時 install・high-risk 未承諾を固定した。実 release の redirect chain（`github.com` → `release-assets.githubusercontent.com` / `application/octet-stream`）は fixture として既定 CI に含め、実 Catalog を叩く検証は `CM_SKILLS_E2E_REAL_CATALOG=1` の opt-in とした。support matrix・MVP 既知制約・rollback 手順を [docs/user-guide/skills.md](./docs/user-guide/skills.md)、Go/No-Go と人手検証の未実施項目を [docs/qa/skills-mvp-uat-report.md](./docs/qa/skills-mvp-uat-report.md) に記載（自動検証分は Go、人手検証分は保留）。
- **設計文書 D-5 の archive root 規定を実装に合わせて修正** (#1242): D-5 は archive root を「`<skill-id>/` の1ディレクトリのみ」と規定していたが、`package-reader` の `resolveRootName()` は **root 省略・`<skill-id>`・`<skill-id>-<version>` の3形**を受理する（既存 unit test でも 2 形が固定済み）。実装が正であり、`tar -czf x.tar.gz -C dir .` と `tar -czf x.tar.gz dir` の差異を許容しつつ「Catalog が名指ししていない名前で install される」ことは防ぐという意図も実装側にある。D-5・脅威モデル T-1・完全一致条件を実装に合わせ、Content-Type が download 層では `application/octet-stream` も受理することを併記した。
- **起動時 reconciliation 配線と journal retention** (#1428): #1234 が実装しながら production の起動経路から呼ばれていなかった crash recovery を配線した。`server.ts` が migration 完了後に `runSkillStartupReconciliation()` を実行し（`await import()` による遅延読込。top-level 静的 import は `tsx server.ts` 下で Next の AsyncLocalStorage bootstrap を壊すため）、`committed_reconciling` で終わった install/uninstall を receipt から SUCCEEDED へ収束させ、owner 確認済み orphan lock を解放する。operation journal に retention（`SKILL_JOURNAL_RETENTION_MS` 7日）を追加し、無限成長と「失敗した idempotency key が恒久 409 を返す」穴を塞いだ。pre-commit apply 失敗時の journal 削除を consume 失敗と一貫させた。Issue 前提の訂正: #1235 が提供したのは payload probe と upsert/delete のみで receipt からの reindex 関数は存在しなかったため本 Issue で実装した。
- **install / uninstall UI 導線接続** (#1431): #1233 で作られながらどの画面にもマウントされていなかった `SkillTargetSelector` を production へ配線し、Catalog 閲覧専用だった UI からブラウザで install / uninstall できるようにした。`SkillDetailView` に `SkillInstallPanel`（target 選択 → plan → preview → 確認 → apply）と `SkillPlanPreview`（plan-response の facts のみ描画）をマウントし、`skills-client.ts` に書き込み系 4 client（`createSkillInstallPlan` / `applySkillInstall` / `createSkillUninstallPlan` / `applySkillUninstall`）を typed error code 伝搬つきで追加した。high-risk Skill は確認チェックボックスが未チェックの間 request をブラウザから送出させない。書き込み系の型は route module からの type-only re-export とし契約 drift を型検査で捕捉する。ナビ構成は不変（#1232 の設計判断どおり）。
- **worktree 導入済み Skill 一覧 API** (#1440): worktree 単位で導入済み Skill を列挙する `GET /api/worktrees/[id]/skills` を新設し、実装済みだが production 呼び出し元ゼロだった `listSkillInstallations()` を配線した（§3-2 既知制約の解消）。`resolveWorktreeOr404` で worktree を解決し、receipt / index 由来の DTO（skill_id / version / installed_at / source commit / artifact sha256 / effective_risk 等）を返す。**installRoot は repository-relative のみで、machine-absolute path・artifact URL は返さない**。`skills-client.ts` に `fetchWorktreeInstalledSkills` を追加。後続 #1441 / #1442 の worktree-scoped UI が消費する読み取り面。
- **worktree 詳細画面から Skill を管理（PC アクティビティバー）** (#1441): worktree 詳細の VS Code 風アクティビティバーに 8 個目「Skills」を追加し、その worktree に対する導入済み一覧・install・uninstall をペインで管理できるようにした。`skills/` 配下に再利用可能な `WorktreeSkillsPane`（Catalog 一覧 ＋ 導入済み一覧 ＋ install/uninstall）を新設し、`SkillInstallPanel` に worktreeId 固定 prop を追加（未指定時は既存 `/skills` の picker 挙動を維持）。導入済み一覧は #1440 の `fetchWorktreeInstalledSkills` を呼ぶ。worktree が確定しているため target 選択が不要で、既存グローバル `/skills`（Catalog 閲覧）と役割分担する。
- **モバイル Tools に Skills サブタブ追加・横スライド化** (#1442): モバイルの worktree 詳細「Tools」（`NotesAndLogsPane`）のサブタブに「Skills」を追加し、Note/Schedules/Agent/Timer/ToDo/Skills の 6 個を横スクロール（`overflow-x-auto scrollbar-hide` + `flex-shrink-0 whitespace-nowrap`、既存 agent-instance タブ行のパターン流用・新規ライブラリなし）で選べるようにした。従来の `flex-1` 5 等分では 6 個目で潰れるための変更。Skills サブタブは **#1441 の `WorktreeSkillsPane` を再利用**（新規作成せず、この画面の worktreeId を渡す）。サブタブは hover 非依存で、狭幅（320px 相当）でも横スクロールで全タブへ到達できる。
- **Harness Pack 共通契約・移植方針 ADR を定義** (#1447): 実績ハーネス（orchestrate / worktree-setup / worktree-cleanup）を公式 Skill（`cmate-*`）へ移植するための共通契約を [docs/design/harness-pack-contract.md](./docs/design/harness-pack-contract.md) に確定した。source artifact を実物調査で **7 件**（CommandMate 3 slash command＋CommandAgent 3 Skill＋`codex_orchestrate.py` 523行）と確定し behavior matrix で共通/固有/廃止を分類、CommandAgent のパス・行数・worktree-setup Skill 不在などの前提誤りを訂正した。決定事項: runner 言語 = **Node（.mjs）**、worktree 同期 = **`commandmate sync` CLI 新設**（暫定 API・optional）、Phase 5 `cmate-parallel-issue-development` は **`cmate-orchestrate` へ ID 統一**（major version 昇格）、profile は Node/Rust のみ verified・未知 repository は実行前確認つき unverified、Phase 1B は明示承認つき PR/merge・回数上限つき UAT 修正ループまで含む。本 Issue は契約・matrix・schema・profile・ADR のみで、3 Skill の実装・release は含まない。

### Fixed

- **同一プロセス並行リクエストによる Skill 操作 lock の横取りを修正** (#1427): Next.js の route handler は全て同一プロセスで並行実行されるため、`evaluateSkillLock` の same-pid / same-generation ショートカットが、lease 30 秒経過後に **live な並行リクエストの lock を「自プロセスの放棄 lock」と誤判定**して reclaim を許していた。当該ショートカットを除去し、lease 失効後も owner が生存していれば `HELD_BY_LIVE_OWNER` として横取りを拒否する（後発リクエストは `SKILL_INSTALL_LOCKED` 409）。crash 後の orphan lock は process generation 不一致経路で従来どおり回収可能。
- **失効した Install Plan token が snapshot を解放しない問題を修正** (#1429): plan が pin した検証済み snapshot は `dropRecord` でしか解放されず、その到達経路が「次の plan 作成時の sweep」しか無かったため、放置された plan token が snapshot（最大 16MB/件）をプロセス終了まで pin し続けていた（TTL sweep・quota eviction は refcount 0 のみ対象で無効）。`plan-sweeper.ts` を追加し、両 plan cache と snapshot store を 60 秒ごと（`unref()` 済み timer）＋ token アクセス時に sweep する。未配線だった `sweepSkillSnapshots` を配線した。
- **worktree 削除時に skill_installations が残留し再作成後に導入不能になる問題を修正** (#1430): `skill_installations.worktree_id` に FK が無く、worktree 削除後も行が残留していた。同一 path に worktree を再作成すると新 UUID になるため「未導入」表示なのに disk に receipt が残り、再 install は `SKILL_INSTALL_DESTINATION_EXISTS`、uninstall も記録なしで実行不能という宙吊りになっていた。migration v46 で `FOREIGN KEY (worktree_id) REFERENCES worktrees(id) ON DELETE CASCADE` を付与（table rebuild、既存 dangling 行も SELECT 濾過で一掃）。FK 採用の決め手は `migrateWorktreeIdPreservingChildren` が `PRAGMA foreign_key_list` で子テーブルを動的発見するため、FK にして初めて同一 path の branch 切替で install が引き継がれる点。`worktree-db.ts` の CASCADE 対象 docstring（4→実際は8テーブルで古かった）も実体に更新。
- **`commandmate skill info/plan/install` の `--version <v>`（スペース形式）が無言 exit 0 になる問題を修正** (#1462): root program の `.version(pkg.version)` が定義する `--version` フラグが、commander の既定パースでは command 名より後ろに現れても消費されるため、`skill install X --version 0.1.0`（スペース形式）が **CLI 版数を表示して exit 0 で終了し subcommand 本体が実行されない**無言失敗になっていた（`--version=0.1.0` の等号形式は root の値なしフラグに束縛されず subcommand へ通るため正常だった）。root program に `enablePositionalOptions()` を付与し、root option を command 名の前だけで解釈して以降を subcommand へ委譲するよう修正（非破壊。スペース・等号の両形式が動作）。既存 skill テストは `createSkillCommand()` を直接呼び root の `.version()` を通らず本バグを見逃していたため、実 `buildProgram()` 経由で両形式を検証する回帰テストを追加した。

### Changed

- **Skill 操作コードの生 NUL バイトを `\x00` エスケープへ置換し制御文字 CI ガードを追加** (#1432): `operation-lock.ts` と `preview-diff.ts` の hash separator に埋まっていた生 NUL バイトを `\x00` エスケープへ置換した（同一バイトへ評価されるため hash 入力は不変）。生 NUL があると `grep` / `rg` が当該ファイルをバイナリ扱いで黙ってスキップし、cross-process lock と diff engine が監査・codemod の視界から外れていた。`scripts/check-control-chars.mjs` を追加し `ci-pr.yml` から実行、`src/` 配下の C0 制御文字混入を fail させる。

## [0.11.4] - 2026-07-20

> **Highlight**: **npx 起動サーバの GUI ワンクリック更新が「冷キャッシュ（対象版が未取得）」で失敗する問題を修正**。npx 起動サーバの cwd は npx キャッシュ内のパッケージ dir で、更新の warm（新版取得）時に npx がその dir を掃除/置換するため、続く再起動の npx 起動で `process.cwd()` が `ENOENT (uv_cwd)` を投げてクラッシュし、旧サーバ停止済みのまま再起動に失敗していた（対象版がキャッシュ済みの時のみ成功）。更新プロセスと npx サブ起動を安定 dir（homedir / ~/.commandmate）から実行するようにして解消した。

### Fixed

- **npx 自己更新の再起動段クラッシュ（`process.cwd()` ENOENT/uv_cwd）を修正** (#1410): npx 起動サーバは npx キャッシュ内のパッケージ dir（`~/.npm/_npx/<hash>/node_modules/commandmate`）を cwd に持ち、分離起動される更新プロセスがこれを継承する。`warmNpxLatest` の新版取得で npx がその dir を掃除/置換するため、続く `spawnNpxDaemon` の npx 起動で npm が `process.cwd()` を呼んだ瞬間 `ENOENT (uv_cwd)` でクラッシュし、旧サーバ停止済みのまま再起動に失敗していた。`npx-runner` の warm/relaunch spawn に安定 cwd（`homedir()`、`stableNpxCwd()`）を明示し、更新プロセス自体も `ensureConfigDir()`（`~/.commandmate`）から起動するようにして解消。再起動先の daemon は従来どおり自身の cwd を package root に設定するため、サーバの実行位置は不変。

## [0.11.3] - 2026-07-19

> **Highlight**: **History 表示上限が会話ペア数と一致しない問題を修正**。表示上限セレクタ（50/100/…）の値は生メッセージ行数の LIMIT として扱われていたため、codex のように 1 会話ターンあたり assistant 行を多数生成するエージェント（実測 assistant:user ≈ 6.8:1）では、50 を選んでも約 10 枚の会話ペアカードしか表示されなかった。取得単位を「会話ペア（ターン）」に変更し、表示カード枚数＝選択値に一致させた。

### Fixed

- **History 表示上限を会話ペア単位で数えるよう修正** (#1407): 表示上限は `messages` API の `limit`（生の chat 行数 LIMIT）として渡され、History は取得メッセージを会話ペア（user＋続く assistant 群）にまとめて表示するため、assistant 行が多いエージェント（codex 等）では選択値より大幅に少ないカードしか表示されなかった。`getMessages` に `limitUnit:'pairs'` を追加（最新 N 件の user メッセージの timestamp を cutoff に以降の全行を返す／既定の `messages` 単位は不変／user メッセージ無しのスコープはフォールバック）、`messages` route に `unit`（`messages`|`pairs`）パラメータを追加、History 取得系（`useSplitMessages` / `useWorktreeDetailController`）が `unit=pairs` を送るようにして、表示カード枚数＝セレクタ選択値に一致させた。

## [0.11.2] - 2026-07-19

> **Highlight**: **GUI アップデート後の client-side exception を解消**。`npx commandmate` の GUI アップデートでサーバが新ビルドに差し替わる一方、開いたままの旧タブが旧ハッシュの chunk / RSC を新サーバへ要求して `ChunkLoadError` になり、App Router のエラー境界が無いため `Application error: a client-side exception has occurred` の未処理クラッシュになっていた。#1404 で `error.tsx` / `global-error.tsx` を新設し、`ChunkLoadError` を検知したら 30 秒ガード付きで一度だけ自動リロードして自己回復する安全網を追加した（無限ループ防止・SSR / Safari プライベート安全）。

### Fixed

- **GUI アップデート後の client-side exception を解消** (#1404): 版入替で旧タブが旧ビルドの chunk / RSC を新サーバへ要求すると `ChunkLoadError` が発生するが、アプリに App Router のエラー境界が1つも無かったため未処理クラッシュ（`Application error: a client-side exception`）になっていた。`src/lib/error/chunk-reload.ts`（`ChunkLoadError` 検知＋ sessionStorage による 30 秒ガード付きの一度きり回復）と、`src/app/error.tsx`（セグメント境界、`next-intl` 対応）／`src/app/global-error.tsx`（root 境界、`<html>`/`<body>` 自前・Provider 非依存フォールバック辞書・inline スタイルでテーマ追従）を新設。ChunkLoadError 以外は自動リロードせず手動リロード導線を表示する。補強策（更新バナーの reload 条件拡張・`VersionMismatchBanner` の自動リロード・Service Worker の `/offline` バージョニング）は本リリースのスコープ外。

## [0.11.1] - 2026-07-19

> **Highlight**: **サイドバー同期トーストの見切れ修正と Toast のグローバル1本化**。サイドバーの同期ボタン押下時に表示されるトーストが、`transform` を持つ祖先（`AppShell` のサイドバー枠）の containing block に閉じ込められてビューポート右下ではなくサイドバー基準に配置され、左端が見切れていた問題を解消した。#1399 で `ToastContainer` を `document.body` への `createPortal` 化（`mounted` ガードで SSR 安全）して根本修正し、#1400 で散在していた `ToastContainer`/`useToast` を単一の `ToastProvider` ＋ 単一 Portal ホストへ統合して、描画位置がツリー構造に依存しなくなるようにし再発を構造的に防止した。

### Fixed

- **サイドバー同期トーストの見切れを修正** (#1399): 同期ボタンのトーストは `position: fixed` だが、描画元 `SyncButton` の祖先 `<aside data-testid="sidebar-container">`（`AppShell`）が `transform`（スライド演出）を持つため、CSS 仕様上その祖先が `fixed` の containing block となり、トーストがビューポートではなくサイドバー枠（既定幅 224px）基準に配置され、`min-w-[300px]` の左端が画面外へはみ出していた。`ToastContainer` を `createPortal(..., document.body)` で描画するよう変更（`mounted` ガードでクライアントマウント後のみ portal、`Modal`/`CommandPalette` と同パターン）し、呼び出し元のツリー位置に関わらず `fixed` がビューポート基準となるようにした。

### Changed

- **Toast をグローバル1本化（`ToastProvider` + 単一 Portal ホスト）** (#1400): 各コンポーネントでローカルに生成していた `ToastContainer`/`useToast` を、単一の `ToastProvider`（Context）＋ 1 箇所だけ描画する Portal ホストへ統合した。`useToast()` は共有 Context を返すフックに変更（Provider 外でもクラッシュしないフォールバック付き）。`Sidebar`・`CommandPalette`・`NotificationsSettings`・`worktree` 配下の各 consumer からローカルの `ToastContainer` を撤去し、共有 Context 経由に置き換え。fixed トーストホストが 1 つに集約され、位置の一貫性・スタッキング制御・重複排除を実現し、`transform` 祖先による見切れ等の再発を構造的に防止する。

## [0.11.0] - 2026-07-18

> **Highlight**: **npx 起動サーバの GUI アップデート対応**。`npx commandmate` で起動したサーバの GUI アップデート機能を2段で整備した。#1394 で npx を正しく検知して誤動作（「今すぐアップデート」が `202 started` を返すのに no-op → 5 分 timeout・`commandmate update` の誤案内）を解消し、#1395 で同ボタンから npx サーバをその場更新（新しい npx キャッシュ取得 → 旧デーモン停止 → 新デーモン起動 → GUI 自動リロード）できるようにした。停止前に版検証してダウンタイム0で fail-fast し、#1198 のセキュリティ不変条件（固定 argv・多重実行ロック・認証は middleware 任せ）を維持する。素の CLI `commandmate update`（npx）は従来どおり案内のみの no-op（#1319）。

### Added

- **npx 起動サーバの GUI ワンクリック更新** (#1395): `npx commandmate` で起動したサーバでも、アップデート通知バナーの「今すぐアップデート」ボタンからその場更新できるようにした。グローバル入替ではなく「新しい npx キャッシュを取得 → 旧デーモン停止 → 新デーモン起動 → GUI 自動リロード」方式。停止前に版検証を行い、stale/失敗時はダウンタイム0で abort。#1198 のセキュリティ不変条件（固定 argv・多重実行ロック・認証は middleware 任せ）を維持。素の CLI `commandmate update`（npx）は従来どおり案内のみの no-op（#1319）。

### Fixed

- **npx 起動時に GUI アップデートが誤動作する問題を修正** (#1394): #1319 で CLI に入れた npx ガードが GUI 経路（`update-check` / `update` route）に未反映で、npx 起動サーバが自身を global インストールと誤認していた。「今すぐアップデート」ボタンが `202 started` を返すのに実体は no-op（spawn した `commandmate update` が npx ゲートで即終了）となり、バナーは 5 分 timeout に陥り、案内コマンド `commandmate update` も npx では no-op という誤案内だった。両 route に `isNpxExecution()` ガードを追加し `installType: 'npx'` を新設。update route は `400 code:'npx'` で拒否し、バナーは更新ボタンを出さず `npx commandmate@latest` の正しい案内を表示する（この「正しく案内する」状態を #1395 が「実際に更新する」へ引き上げる）。

## [0.10.4] - 2026-07-18

> **Highlight**: **v0.10.3 以降に蓄積した 26 件のバグ修正をまとめたパッチリリース**。柱は4つ。① DB 整合性（`repositories`/`worktrees` 行のライフサイクル、幽霊行の掃除・同一 URL 再 clone 封鎖の解消、将来版スキーマの検知で起動停止、`busy_timeout`+WAL による `SQLITE_BUSY` 対策）。② 版アイデンティティ（サーバー `currentVersion` の実行時解決、デーモン state ファイルへの版・実効設定・プロセス同一性の記録、CLI/quickstart/status の版照合、旧タブ・WebSocket の版不一致検知とリロード導線）。③ clone / schedule / assistant / update が例外で `running`・ロック固着する不具合の一掃。④ フローティング UI（共有ツールチップ・ブランチツールチップ・checkout ドロップダウン・右クリックメニュー・残存フローティング要素）のビューポート clamp とポータル化。あわせて同名スキルが `.claude/skills`（Claude）/`.agents/skills`（Codex）で共存できずスラッシュ候補に出ない不具合を修正した。DB マイグレーション **v43**（`CM_ROOT_DIR` 由来の幽霊リポジトリ行の掃除、#1339）を含む。

### Fixed

- fix(slash): **同名スキルが `.claude/skills` と `.agents/skills` に併存すると Claude Code の候補に出ない不具合を修正** (#1380)。`deduplicateByName()`（キーは `name + cliTools`、#800）と `mergeCommandGroups()`（キーは `name` のみ）で重複排除の粒度が食い違い、マージ層で `.agents/skills` の Codex 版（`cliTools: ['codex']`）が `.claude/skills` の Claude 版（`cliTools` undefined）を同名で上書きしていたため、後段の `filterCommandsByCliTool(..., 'claude')` で Claude 版が消え候補が空になっていた（Codex 選択時のみ表示）。重複排除キー生成 `keyOf`（name + 正規化 cliTools スコープ、undefined/空は `claude` sentinel）を `command-merger.ts` に切り出し、両関数で共有（DRY）。これにより Claude 版と Codex 版が共存し、SF-1（worktree コマンドが同一 CLI tool scope の同名 standard を override）も従来どおり保たれる。`mergeCommandGroups()` の name 衝突（Claude vs Codex）を検証する回帰テストを追加
- fix(ui,realtime): **版不一致を検知してリロード導線を出す** (#1338, #1356)。サーバーを新版に入れ替えた後も開いたままの旧タブは、参照する `/_next/static/chunks/*` のハッシュが新サーバーに存在せず**黙って壊れる**（サイドバーが空・client-side exception 等、毎回「別のバグ」に化ける）。加えて WS リアルタイム通信には版ネゴシエーションが無く、版ずれ時に未知イベントを双方が黙殺してリアルタイム更新が無言で止まる（#1356）。両者は**版不一致検知＋リロード促し**という同一機構で解決する。WebSocket 接続時にクライアントが自分のバンドル版（`NEXT_PUBLIC_APP_VERSION`）を hello として送り（`useWebSocket` の `onopen`、再接続ごとに再送）、サーバーは実行時版（`getServerVersion()`＝実行時 package.json、#1359）と突き合わせて不一致なら `version_mismatch` イベントを返す（`ws-server` の新 `handleClientVersion`）。新規 `VersionMismatchBanner` を `AppShell`（アプリ全体でマウントされるトップレベル）に置き、このイベントを検知トリガーに**明示的なリロードボタン付きバナー**を永続表示する（#1337 の教訓に従い worktree 詳細内には載せない）。**自動リロードはしない**（入力中の内容を破壊しないため）。版が一致している間、および `0.0.0`/空などの未知版がどちらか一方にある間はバナーを出さない（`isVersionMismatch` が誤検知を防ぐ）。ユーザーが閉じた版は再接続で再提示せず、より新しいサーバー版が現れたときのみ再表示する。新エンドポイントは追加せず既存の WS 経路のみを使う。`version-checker.ts` は読み取りのみ（#1359 の関数は不変）
- fix(sync): **リポジトリ消滅時に stale worktree 行を剪定する** (#1349)。リポジトリのディレクトリ削除・非git化で `scanWorktrees` が git exit 128 により `[]` を返すと、そのリポジトリはスキャン結果から消え、`syncWorktreesToDB` の per-repo 剪定にも到達しないため worktree 行が DB に残置し、サイドバーに幽霊行として残っていた。`syncWorktreesToDB` のグローバル early-return は「**全**リポジトリが空のとき」しか効かず、健全なリポジトリに混じった単一の消滅リポジトリは永久に回収されなかった。全体スキャンの照合ステップとして `pruneStaleRepositoryWorktrees(db, liveWorktrees)` を追加。DB に worktree 行を持つ全 `repository_path` を列挙し、当該スキャンで worktree を産まなかったもののうち**ディレクトリ（または `.git`）が実際に消えている**場合のみ行を CASCADE 削除する。ディレクトリが実在するのに git がエラーを返しただけのケース（ロック中・ネットワークドライブの一時不可視等）は剪定しない側に倒し、一過性の失敗が履歴を破壊しないようにした（`repositoryExistsOnDisk`）。呼び出しは全リポジトリを対象とする `POST /api/repositories/sync` のみ。単一リポジトリを扱う scan/restore 経路は対象外リポジトリへの権限を持たないため実行しない。行キーは #1347 の正規化前提を踏襲し、`getRepositories` が返す `path.resolve()` 済みの `repository_path` を DB・ファイルシステム双方で一貫して用いる
- fix(cli): **API レスポンスをシェイプ検証し版照会で版ずれを警告する** (#1357)。CLI の `ApiClient.get<T>/post<T>/patch<T>` は受信 JSON を `as T` で無検証キャストしており、古いデーモンが返す形の違うレスポンスを黙って受け入れていた。特に `fetchAgentInstances()` の `worktree.agentInstances ?? []` は、roster API を持たない旧デーモンでフィールド欠落を**無音の空配列**に丸め、ユーザーには「インスタンスが無い」ように見えてしまっていた。対策として `assertResponseShape()`（必須フィールドの存在チェック）を追加し、`fetchAgentInstances()` は `agentInstances` の**欠落**（＝旧デーモン）を「サーバーが古い可能性」を示す `ApiError` として明示化する（現行デーモンは常に同フィールドを含め、空配列は「インスタンス無し」として正しく通す）。あわせて #1359 で信頼できる実行時版になった `GET /api/app/update-check` の `currentVersion` を読む `fetchDaemonVersion()` と、CLI 自身の版（`readPackageVersion()`）と食い違えば stderr に警告する `warnIfVersionSkew()` を追加（advisory・非 throw、版不明時は沈黙）。変更は `src/cli/utils/api-client.ts` と `src/cli/utils/agent-instances.ts` のみ。
- fix(cli): **quickstart で稼働デーモンと CLI の版を照合し警告する** (#1337)。`npx commandmate@latest` を叩いてもデーモンが稼働中なら `quickstart.ts` の `ensureServerRunning` は再起動せず既存 URL を返すだけで、公開済みの修正が黙って利用者に届かなかった。しかも `npx …@latest --version` は取得したての CLI 版を表示するため、利用者は「最新で動いている」と誤認する。#1354 でデーモンが状態ファイルに記録するようになった版（`getStatus().version`）と、`readPackageVersion()` が返す CLI 版を照合し、食い違う場合に**稼働中サーバーは更新されない旨と `commandmate update` への導線を警告表示**する（`status` コマンドの版照合と同じ仕組み）。自動再起動は稼働中セッションを巻き込むため行わず、既定は警告に留める。版を記録しない旧デーモンや CLI 版が解決できない場合は従来どおり無警告で URL を返す。担当は `quickstart.ts` のみ（`api-client.ts` は触らない）
- fix(api): **UNIQUE 制約違反を事前検証し 409 で返す（schedules 同名 / memos position）** (#1351)。2つの POST 経路が DB の UNIQUE 制約を事前チェックせず生 INSERT していたため、衝突が**原因不明の 500** として表面化していた。① `POST /api/worktrees/:id/schedules` は `scheduled_executions` の `UNIQUE(worktree_id, name)` を検査せず、同名スケジュールの作成が catch の一律 500 に落ちていた。② `POST /api/worktrees/:id/memos` は position を**明示指定した分岐**だけ空きチェックを通っておらず（自動採番分岐のみ `usedPositions` を見ていた）、`worktree_memos` の `UNIQUE(worktree_id, position)` 違反がやはり 500 になっていた（`createMemo` は素の INSERT）。両経路に INSERT 前の重複検証を追加し、schedules は `409 DUPLICATE_NAME`、memos は `409 DUPLICATE_POSITION` を明示的に返す。あわせて INSERT 側でも UNIQUE 違反を捕捉してエラーコードに変換する多重防御を入れた（`createMemo` は `src/lib/external-apps/db.ts` の `ExternalAppDbError('DUPLICATE')` に倣い `MemoDbError('DUPLICATE_POSITION')` を throw、schedules 経路は catch 内で `UNIQUE constraint` を検出）。事前チェックと INSERT の間の競合（同名/同 position を掴んだ並行リクエスト）でも 500 に戻らない。制約はいずれも worktree スコープのため、別 worktree での同名・同 position は従来どおり許可される。FOREIGN KEY 等その他の DB エラーは従来どおり素通しで 500 のまま

- fix(build): **サーバーの `currentVersion` を実行時 package.json から解決する** (#1359)。`update-check` が返す「現在版」（`currentVersion` / `hasUpdate` 判定）は `next.config.js` が `NEXT_PUBLIC_APP_VERSION: packageJson.version` として **`next build` 時に焼き込んだ値**で、`version-checker.getCurrentVersion()` はサーバー route もその環境変数を参照していた。このため `git pull` 後に `next build` だけ実行する（`build:all` を通さない）等の部分ビルド運用では、`.next` に焼き込まれた版と `dist/server` の実コード版がずれ、update-check の現在版が「最後に next build した時点の package.json」に固定されて実際に動いているコードの版を反映しなかった。#1337/#1338 の版照合はこの値を信頼の起点にするため、値自体の信頼性が前提になる。`getServerVersion()` を追加し、サーバー実行時版は `process.cwd()/package.json`（サーバーは `start.ts` が `cwd: packageRoot` で spawn するためインストールディレクトリの実 manifest）を**実行時に読む**方式へ変更した。解決順は ①ランタイム package.json（`name === "commandmate"` を検証）→ ②焼き込み `NEXT_PUBLIC_APP_VERSION` → ③`0.0.0` のフォールバックとし、`name` 検証により想定外の cwd（dev 起動でユーザーのプロジェクトディレクトリを指す等）が無関係な版を漏らすのを防ぐ。読み取り失敗・不正 JSON・版欠落・別パッケージ・環境変数未設定はいずれも安全側へフォールバックする。クライアント側の焼き込み版は「このページのバンドルの版」を表す値として正しいため `getClientVersion()` として分離し、`NEXT_PUBLIC_APP_VERSION` 参照のまま維持した（サーバー実行時版とクライアント焼き込み版の分離は #1338/#1356 の版不一致検知の土台になる）。`getCurrentVersion()` は後方互換のため残し `getServerVersion()` へ委譲する。なお `update.ts:74` のコメント（CLI 文脈で `getCurrentVersion()` が `0.0.0` になり使えない旨）は本修正後も有効: 平常の CLI では cwd が commandmate のパッケージルートでなく `name` 検証が外れて `0.0.0` にフォールバックするため、CLI は従来どおり `readInstalledVersion()`（`__dirname` 基準）を使う
- fix(db): **`busy_timeout` と WAL を設定し同一 DB の多重オープン時の即 `SQLITE_BUSY` を防ぐ** (#1360)。`getDbInstance()` の接続 pragma は `foreign_keys = ON` のみで、`busy_timeout`（既定 0 = ロック競合で即エラー）も `journal_mode`（既定のロールバックジャーナルは書き込み時に排他ロックを取る）も未設定だった。既定では main（`cm.db`）と worktree サーバー（`cm-<issue>.db`）は別ファイルなので通常は衝突しないが、worktree の `.env` が `CM_DB_PATH` を固定値でハードコードしている等の設定ミスで**2つのサーバープロセスが同一 DB ファイルを指すと、書き込み競合が散発的な 500（`SQLITE_BUSY`）**として現れ原因特定が難しかった。接続直後・マイグレーション前（migration の書き込みにも効かせるため）に `journal_mode = WAL`（読み取りと単一書き込みを共存させ排他ロックを避ける）と `busy_timeout = 5000`（競合時は即失敗せず最大 5 秒ロック解放を待つ）を追加した。`foreign_keys = ON`（#294、マイグレーション前必須）と #1353 のスキーマ検証後 singleton 代入の前後関係は不変。多重オープンの検知・拒否（PID 記録等）は Issue の優先度が低いため今回は見送り、極小コストの防御のみを入れる
- fix(api): **scan 経路で `repositories` 行を登録する** (#1348)。リポジトリ登録の3経路のうち scan（`POST /api/repositories/scan`）だけが `repositories` 行を作らず、`scanWorktrees` → `syncWorktreesAndCleanup` で **`worktrees` テーブルだけを更新**していた。リポジトリ一覧のデータソースは2系統あり、サイドバー（`getRepositories`）は worktrees 駆動なので scan 登録リポジトリも表示されるが、管理画面（`getAllRepositoriesWithWorktreeCount`）は repositories 駆動のため**行が無いと一切現れない**。結果、scan で登録したリポジトリは①管理画面に出ず無効化・表示切替の対象にできない、②`repository_todos` が `repositories.id` を参照するため Home ToDo も使えない、③次回 sync の対象集合（env ∪ DB 登録済み enabled パス）に入らず**以降 sync で更新も剪定もされない**、という状態に陥っていた。scan 成功時（worktree を検出したリポジトリごと）に `repositories` 行を upsert するようにし、clone 経路（`CloneManager.onCloneSuccess` → `createRepository`）と整合させた（`cloneSource: 'local'`, `enabled`/`visible` 既定 true）。`getRepositoryByPath()` で既存行を確認し、**存在する場合は上書きしない**（利用者の enabled/visible/disabled 設定を保持。`ensureEnvRepositoriesRegistered()` の冪等な挙動に倣う）。複数 worktree を持つ単一リポジトリでも `repositoryPath` で de-dup して1行のみ作成する。`db-repository.ts` の関数定義は変更せず、既存の `getRepositoryByPath` / `createRepository` をルートから呼び出す
- fix(ui): **BranchTooltip をビューポート内に clamp する** (#1361)。サイドバーのブランチ項目のツールチップは `createPortal` + `position: fixed` までは済んでいたが、座標が `setCoords({ top: rect.top, left: rect.right + 8 })` の固定計算で、**clamp・フリップ・衝突判定が一切無かった**。結果、①サイドバーを広げた場合（幅は 160〜480px 可変）に right≈488 + `max-w-sm`（384px）の展開が右端を突き抜ける、②`top: rect.top` 固定・下方向フリップ無しのため一覧下端の項目で高さ上限の無い `description` が下端で切れる、③**モバイルドロワー（`w-72`=288px / 375px 幅）では left≈296 からの 384px 展開が画面をほぼ完全に突き抜ける**（ホバーの無い端末でも `:focus-visible` で発火する）。表示時に bubble の実寸を `getBoundingClientRect()` で測り、水平は右側優先＋左側に余地がある場合のみフリップ、それ以外は両軸とも `clampAxis()` でビューポート内（8px マージン）に収める。**clamp だけでは 384px の bubble を 375px の画面に入れられない**ため、`maxWidth` も `min(384, innerWidth - 16)` で頭打ちにした（広い画面では従来どおり `max-w-sm`）。bubble がビューポートより大きい場合は開始側の端に寄せる（中間より先頭を見せる方が有用なため）。#1341 が `common/Tooltip.tsx` に入れた clamp と同じ考え方だが、並行修正の衝突を避けるため共通ユーティリティ化はせずコンポーネント内にローカル実装している
- fix(ui): **ブランチ checkout ドロップダウンがペインに切り取られ・画面下端からはみ出すのを修正** (#1363)。`BranchCheckoutDropdown` のメニューは `absolute left-0 top-full z-20` でコンポーネント自身の subtree 内に描画されていたため、3つの問題を同時に抱えていた。①**祖先による切り取り**: Git ペインは `overflow-y-auto` のスクロールコンテナであり、その外側へ張り出すメニューは（`z-index` に関係なく）クリップされる。②**下端はみ出し**: `top-full` から常に下方向へ開き、フリップが無いため最大 256px（`max-h-64`）のメニューがトリガー位置次第でビューポート下端を突き抜け、末尾のブランチが選べない。③**低い stacking**: `z-20` はペイン内の他のオーバーレイに負けうる。メニューを `createPortal(…, document.body)` で body 直下の `fixed` 要素として描画し、表示時に `getBoundingClientRect()` でトリガーとメニューの実寸を測って、下に入りきらず かつ 上の余白の方が大きいときのみ上方向へフリップする（通常の下開きは維持）。上下・左右とも 8px マージンでビューポート内へ clamp し、メニューがビューポートより大きい場合は開始辺（top / left）側を優先して到達可能にする。`z-index` はオーバーレイ相当（`z-50`）へ引き上げた。ポータル化によりメニューは Git ペインのスクロールに追従しなくなるため、`scroll`（capture: true）と `resize` で再測位してトリガーへのアンカーを保つ。座標確定までは画面外に退避させ (0,0) への一瞬の描画を防ぐ。ハンドラ・`data-testid`・`onCheckout` 契約は不変
- fix(assistant): **実行開始の失敗で Assistant Chat の会話が `running` 固着し送信不能になるのを防止** (#1344)。`startNonInteractiveAssistantExecution()` は会話を `running` に更新した後、`updateAssistantMessageStatus()` と `child.stdin.write()` / `child.stdin.end()` を **`try` の外**で実行していた。ここで同期 throw すると `stdin.end()` に到達せず子プロセスは stdin 待ちでハングして `'close'` を発火せず、呼び出し元 `terminal/route.ts` の `catch` は user message を `failed` にするだけで**会話の status を戻さない**。子プロセスは registry に**登録済み**のため、リカバリ機構 `reconcileAssistantConversationExecution()`（「`running` 実行かつ**未登録**プロセス」のみを `failed` 化）が発火せず、`status='ready'` を要求する terminal route はその会話への以降のメッセージを 409 で拒否し続ける（**自己修復しない**）。実行開始〜stdin 書き込みを `try` で包み、失敗時は子プロセスを kill + unregister して execution を `failed` / 会話を `ready` へ戻したうえで例外を呼び出し元へ再 throw する。ロールバック中の DB 書き込み自体が失敗しうる（DB 障害が元の throw の原因である場合）ため、各書き込みは個別に捕捉してログに落とし元のエラーを握り潰さない。unregister を先に行うため、この場合も次回 API アクセス時に reconciler が回収できる。あわせて `'close'` ハンドラ内の終端遷移も `try` で保護した（`parseExecutionOutput()` / `createAssistantMessage()` の throw で execution の `completed`/`failed` と会話の `ready` 復帰に到達しない経路。unregister 済みのため reconciler が自己修復するが、それまで会話は固着する）。終端遷移を書けるのはロールバック / `'error'` / `'close'` のうち**最初の1つだけ**とし、kill 後に遅れて届く `'close'` が、既に開始済みの新しい execution の状態を上書きするのを防ぐ
- fix(db): **将来版スキーマの DB を検知して起動を停止する** (#1353)。`runMigrations()` は `migration.version > currentVersion` で前進のみを見ており、DB の `MAX(schema_version)` が `CURRENT_SCHEMA_VERSION`（現在 43）を**超えていても「Schema is up to date」と判断してそのまま開いていた**。新版が DB を進めた後に旧ビルド（古い dev チェックアウト / PATH に残った旧 global / npx キャッシュ / `CM_DB_PATH` 共有の worktree サーバー）が同じ DB を開くと、起動は成功し、改名・削除済みカラム前提のクエリが**実行時に**診断困難な 500 として初めて表面化していた。版読み取り後・マイグレーション書き込み前にガードを置き、版・対応上限・復旧手段（`commandmate update`）を明示したエラーで起動を止める。あわせて `getDbInstance()` が **`runMigrations()` より前に singleton を代入していた**問題を修正した。マイグレーションが throw しても未検証の接続が module-level キャッシュに残るため、最初の呼び出し元だけがエラーを見て**以降の呼び出し元には同じ DB がエラーなしで返っており**、ガードは一度だけ発火してプロセスの残りの間バイパスされる状態だった。スキーマ検証後にのみ代入し、失敗時は接続を閉じて再 throw する
- fix(clone): **`executeClone` 冒頭の同期例外でクローンジョブが `running` のまま固着するのを防止** (#1342)。`executeClone` はジョブを `running` に更新した直後、`Promise` を生成する前に `mkdirSync`（親ディレクトリ作成）を同期実行していた。ここで throw すると（親ディレクトリの権限不足・ディスク障害等）、失敗は呼び出し元 `startCloneJob` の `.catch()`（ログ出力のみ）に吸われ、**ジョブは terminal state へ一切遷移しない**。利用者には「終わらないクローン」だけが見え、エラーは UI に出ない。準備処理を `try` で包み、例外時に `failed` / `CLONE_SETUP_FAILED`（category: `filesystem`）へ遷移させる。原因の詳細はパス情報を含むためサーバーログのみに出し（`clone:setup-failed`）、ジョブに載せる `errorMessage` は定型文とする（[D4-001] に準拠）。なお `updateCloneJob` 自身が throw する DB 障害時は `failed` の書き込みも成立しないため `pending` のまま残るが、二次例外で原因を握り潰さず構造化エラーとして呼び出し元へ伝える
- fix(scheduler): **`createExecutionLog` の例外でスケジュールが恒久停止するのを防止** (#1343)。`executeSchedule()` は `state.isExecuting = true` の直後、**`try` の外**で `createExecutionLog()`（DB INSERT）を実行していた。ここで throw すると `finally`（`isExecuting = false`）に到達せずフラグが `true` で固定され、以降そのスケジュールは冒頭のガードで**サーバー再起動まで恒久的に実行スキップ**される。呼び出しが `void executeSchedule(state)` のため rejection はログにも残らず、利用者からは「スケジュールが無言で動かなくなった」ようにしか見えない。起動時回収 `recoverRunningLogs()` は DB 側の `running` ログのみを回収するため、この in-memory フラグは救えなかった。`createExecutionLog()` を `try` 内へ移し、`logId` 未取得時は `catch` 側の `updateExecutionLog()` をスキップする。あわせて `schedule-manager` の `void executeSchedule(state)` に `.catch()` を追加し、エラーハンドリング自体が失敗した場合（'failed' ログ書き込み時も DB が落ちている等）の rejection が黙って未処理になるのを防ぐ
- fix(update): **ロック取得後の例外で update ロックが解放されないのを防止** (#1345)。`POST /api/app/update` は `acquireUpdateLock()` の成功後、spawn 失敗時に `releaseUpdateLock()` する `try` の**外**で `ensureConfigDir()`（ログパス解決）を実行していた。設定ディレクトリが書き込めない等でここが throw すると**ロックが解放されないまま例外がハンドラを抜け**、以降の update 要求は `UPDATE_LOCK_TIMEOUT_MS`（10分）の stale 再取得まで理由不明の 409 `in_progress` で拒否されていた。ロック取得後の処理全体を `try` に入れ、失敗時は必ずロックを解放して 500 `spawn_failed` を返す（成功時はロックを保持したままにする既存の設計は不変: 起動した update がこのプロセスを置き換えるため）。タイムアウトで自己修復するため実害は限定的だが、失敗直後の再試行が通らない
- fix(clone): **`onCloneSuccess` の失敗を握り潰さずジョブを `failed` に落とす** (#1340)。`git clone` が exit 0 で成功した後の後処理のうち、`createRepository()`（リポジトリ登録）だけが **`try` の外**にあった。`scanWorktrees` の失敗は握られている（[IA-MF-002] クローン成功を壊さない意図）のに、`createRepository` の throw は `updateCloneJob({status:'completed'})` に到達しないまま `onCloneSuccess` を抜ける。しかも `executeClone` はこれを `gitProcess.on('close', async …)` の中で `await` しており、**この async リスナーが返す Promise は誰も待っていない**。したがって throw は `startCloneJob` の `.catch()`（ログのみ）にすら届かず **unhandled rejection になり、`executeClone` の Promise は resolve も reject もされないまま残る**。結果、**ディスク上のクローンだけが成功し、ジョブは `running` で固着して UI には何も現れず、エラーも出ない**（#1334 の調査時、症状が「クローン成功なのにサイドバーに出ない」と区別できず実機データの取り寄せが必要になった）。`onCloneSuccess` 全体を `try` で包み、失敗時は #1342 が追加した `markJobFailed()` で `failed` / `CLONE_REGISTRATION_FAILED`（category: `system`）へ遷移させたうえで構造化エラーを throw し、`close` ハンドラ側でそれを拾って `reject()` する（worktree scan の内側の `try`/`catch` は従来どおり握り潰したまま）。原因の詳細はパス・SQL 文を含むためサーバーログのみに出し（`clone:registration-failed`）、ジョブに載せる `errorMessage` は定型文とする（[D4-001] に準拠）。あわせて、この throw の実際の発生源である **path 重複を事前検証**する。`repositories.path` は UNIQUE だが重複チェックは正規化 URL しか見ておらず、`disableRepository()` は行を消さず `enabled=0` で残す（行が無ければ `cloneUrl` を持たない `cloneSource:'local'` の行を新規作成する）ため、**clone URL を持たない行がその path を占有した状態**が成立しうる。ディレクトリ実体だけが手で消されているとクローンは開始され、完了後に UNIQUE 違反で throw していた。`startCloneJob` の既存ディレクトリチェックの直後に `getRepositoryByPath()` による検証を追加し、`DUPLICATE_REPOSITORY_PATH`（HTTP 409）として**クローン開始前に**明示的に返す
- fix(ui): **残るフローティング UI の見切れを解消する** (#1365)。#1341 が `common/Tooltip` をポータル化＋ clamp した後も、ビューポート端で見切れうるフローティング要素が5箇所残っていた。いずれもトリガーからの相対位置（`absolute right-0 top-full` / `bottom:100%`）だけで配置し、**実際にビューポートに収まるかを一切見ていない**。(1) `SlashCommandSelector` のデスクトップドロップダウン（`w-80` = 320px、メッセージ入力欄から**上方向**に開くためコマンド一覧が長いと上端を突き抜ける）、(2) `FilePanelTabs` のタブ溢れドロップダウン、(3) `SortSelectorBase` のソートメニュー、(4) `FileMetadataToggle` のメタデータ popover、(5) `TruncationTooltip`（**水平 clamp はあるが下方向が無く**、ファイルツリー下端の行で metadata 付きバブルが下に溢れる）。(1)〜(4) には開いた直後に `getBoundingClientRect()` で実測し、はみ出す分だけ `transform: translate()` で引き戻す1軸 clamp を各コンポーネント内にローカル実装した。ビューポートより大きい要素は**先頭側を優先**して残し、頭が画面外に押し出されないようにする。`SlashCommandSelector` は開いたまま絞り込みで一覧の高さが変わるため、フィルタ変更時にも再測する（既に適用済みの shift を引いてから測ることで再実行を冪等に保つ）。**ポータル化はしない**: (2)(3)(4) の外側クリック判定は「クリックがコンテナ ref の内側か」を見ており、`document.body` 直下へ出すと**メニュー自身へのクリックが「外側」と判定されて即座に閉じる**。(5) はバブルの高さがレンダー後にしか確定しないため、表示後の layout effect で実測し、下に溢れる場合はトリガーの上へ flip する（上にも入らない場合は下端にピン留めして頭を残す）。既存の水平 clamp は不変。`SlashCommandSelector` のモバイル（`fixed` のボトムシート）は常に画面内にあるため対象外
- fix(ui): **右クリック / ロングプレスで開くファイルツリーのコンテキストメニューをビューポート内に clamp** (#1362)。`ContextMenu` は `useContextMenu` が拾ったポインタ座標（`clientX`/`clientY`）を `position: fixed` の `left`/`top` にそのまま流していたため、ビューポート右端・下端付近で開くとメニューが画面外へはみ出していた。`fixed` 配置は祖先の overflow でクリップされない代わりに**スクロールで画面内へ戻すこともできない**ため、はみ出した項目（下端では危険操作の Delete を含む）は操作不能になる。とくに 375px 幅のモバイルではロングプレスでも同じ経路を通るため、右下での発生が顕著だった。表示前（`useLayoutEffect`）に `getBoundingClientRect()` でメニュー実寸を測り、各軸を「ビューポート内（端から 8px マージン）」へ clamp する。実測はアンカー位置ではなく原点で行う: `fixed` 要素の幅はビューポート端までの残り幅に shrink-to-fit するため、端の近くで測ると**本来必要な幅より狭い値**が返り clamp 後もはみ出しうる。測定パスは paint 前に完了するため利用者には見えない。メニューがビューポートより大きい場合は近い側の端に寄せ、先頭の項目が画面外へ押し出されるのを防ぐ。座標は測定対象（アンカー座標＋`targetType`。項目数が `targetType` で変わるため寸法も変わる）をキーに保持し、閉じるアニメーション中に原点へ戻らないようにしている
- fix(ui): **共有 `Tooltip` をポータル化しビューポート端で clamp する** (#1341, #1364)。`common/Tooltip` はバブルを `absolute` 配置の**子要素**として描画し、水平方向は `left-1/2 -translate-x-1/2` で中央寄せするだけだった。この方式には位置補正の余地がなく、**トリガーの中央から左右へバブル幅の半分がはみ出すことが構造的に避けられない**。サイドバー（既定幅 224px・最小 160px）のヘッダーアクションは幅の狭い祖先の中に置かれるため、`placement="bottom"` のツールチップは祖先の境界とビューポート端の両方で切れていた。最悪ケースは `layout/Sidebar.tsx` の ViewModeToggle（"Toggle view mode (grouped / flat)"）で、既定幅でも約 74px はみ出して全文が読めない。同様に `Sidebar` の Repositories / SyncButton、`sidebar/SortSelectorBase.tsx`（文字列が短く実害は軽微）、および **#1364 で追加報告された `worktree/WorktreeDetailSubComponents.tsx` のインスタンス切替タブ**（idle 時は 24px の丸ボタンに縮退し全ラベルをツールチップに委ねるため、切れると情報が失われる）が影響を受ける。既に**ポータル + 水平 clamp を実装済みの `common/TruncationTooltip`（#859, #975）に倣い**、バブルを `document.body` へ `createPortal` し、トリガーの矩形から算出した `position: fixed` 座標で配置したうえで、上下左右をビューポート内へ clamp する。位置計算は純関数 `computeTooltipPosition()` に切り出して export した（jsdom は矩形を常にゼロサイズで返すため、この分離がないと clamp をテストできない）。**衝突判定ライブラリ（Radix 等）は導入していない**: それらはトリガーへ ref を注入するため子要素の clone が必要になり、「子を clone せず wrapper がマウスイベントを受ける」「バブルは `role="tooltip"` + `aria-hidden="true"` とし、`aria-label` との二重読み上げを避けるため `aria-describedby` を子に張らない」という **#730 の a11y 設計と両立しない**。この設計は不変で、`worktree/ActivityBar.tsx`（`placement="right"`・最左列かつ垂直センタリングのため元から切れていない）も含め回帰なしを回帰テストで固定した。なお `absolute` 子から `position: fixed` へ移ったことでバブルはトリガーの移動に追従しなくなるため、表示中のみ `resize` と（祖先のスクロールコンテナを拾うため capture フェーズの）`scroll` を購読して再計算する
- fix(db): **`CM_ROOT_DIR` 由来の幽霊リポジトリ行を掃除する** (#1339)。#1328 以前の `getRepositoryPaths()` は `CM_ROOT_DIR` を**単一のリポジトリパス**として返しており、sync 時に `ensureEnvRepositoriesRegistered()` がそれを `is_env_managed=1` の行として `repositories` に登録していた。しかし `CM_ROOT_DIR` はリポジトリを**格納するコンテナ**であってリポジトリではないため、そこを cwd に `git worktree list` を実行しても 0 件で、**worktree 行は作られずリポジトリ行だけが残る**。#1328 は自動発見そのものは削除した（＝新しい幽霊はもう作られない）が、**既存行は「後方互換のため残す」と判断した**ため、既存利用者の DB にはリポジトリ管理画面に中身のない行（実機では `name: "repos"`, `worktreeCount: 0`）が残置されたままになっていた。サイドバーは `worktrees` 駆動（`worktree-db.ts:187`）のため出現せず実害は管理画面の表示に限定されるが、利用者からは消してよいのか判断できない。マイグレーション **v43** で削除する（`is_env_managed` は型定義と row マッピングにあるだけで**どこからも読まれていないデッドフラグ**だったため、本修正がその最初の読み手になる）。削除するのは**次のすべてを満たす行のみ**とし、判定はいずれも「残す」側に倒す: ① `CM_ROOT_DIR`（legacy `MCBD_ROOT_DIR`）が**明示的に設定されている** ② 解決済みパスが `WORKTREE_REPOS` のエントリに**含まれない** ③ その path を持つ `worktrees` 行が**1件も無い** ④ `is_env_managed = 1`。Issue が挙げていた案A（「`is_env_managed=1` かつ worktree 行を持たない行を削除」）を採らず `CM_ROOT_DIR` 完全一致に限定したのは、**正当な env 管理行の誤削除が無害ではない**ため: `ensureEnvRepositoriesRegistered()` は行が無ければ `enabled: true` で**再作成する**ので、利用者が意図的に無効化した `WORKTREE_REPOS` リポジトリを消すと**無効化が解除されて復活し**、`visible` / `display_name` も失われる（案Aは「一時的に worktree が 0 件のリポジトリ」でこれを踏む）。環境変数を `getEnv()` 経由で読まないのも同じ理由で、`getEnv()` は `CM_ROOT_DIR` 未設定時に `process.cwd()` へフォールバックする（`env.ts:218`）ため、DELETE の狙いが**サーバーの起動ディレクトリ**（実在のリポジトリでありうる）に向いてしまう。未設定は「対象なし」として skip する。`down` は no-op（削除した行は worktree も clone URL も持たない既定値のみの幽霊で復元すべき利用者データが無く、再挿入は本修正が直した不具合そのものを戻すため）。なお `disableRepository()` が作る **`is_env_managed=0`** の幽霊行は別個体であり、本修正の対象外（#1346）
- fix(db): **worktree 全滅後の幽霊リポジトリ行が同一 URL の再 clone を封鎖するのを解消する** (#1350)。clone 済みリポジトリのディレクトリを手で削除すると、`repositories` 行（`enabled=1` / worktree 0 件）が残る一方、**行を物理削除する経路が UI・API・DB 層のどこにも無かった**（DELETE API は `disableRepository()` による `enabled=0` 化のみ）。`startCloneJob()` の重複判定（`checkDuplicateRepository()` = 正規化 URL 一致、および #1340 が追加した `checkRepositoryAtPath()` = path 一致）は**ディレクトリの実在を問わず**既存行に当たれば拒否するため、同 URL の再 clone は「This repository is already registered as …」（`DUPLICATE_CLONE_URL`）で恒久的に弾かれ、利用者は DB を直接触る以外に復旧できないデッドロックに陥っていた。両重複チェックに `removeIfGhostRepository()` を挟み、**ディレクトリが実在せず かつ その path を持つ worktrees 行が 1 件も無い**行（幽霊）を検出したら物理削除して clone を許可する。逆に①ディレクトリが実在する（＝稼働中の実リポジトリ = 通常の重複）②worktrees 行が残っている（ディレクトリが一時的に不在なだけかもしれず、記録を黙って落とさない）場合は live とみなし従来どおり拒否する。この「worktree を持つ行は幽霊ではない」判定はマイグレーション v43（#1339）と同じ考え方で、幽霊の物理削除にのみ倒す。物理削除用に `deleteRepository(db, id)`、幽霊判定用に `countWorktreesByRepositoryPath(db, path)` を追加した（worktrees とのリンクは FK ではなく `worktrees.repository_path` の TEXT 一致のため削除は cascade しない）
- fix(db): **`createRepository()` の UNIQUE 未捕捉による並行 clone の TOCTOU を明示エラー化する** (#1352)。`repositories.path` は UNIQUE、`normalized_clone_url` は部分 UNIQUE だが、`createRepository()` は INSERT を try/catch で囲っておらず、同一 URL の clone を並行実行して両者が重複チェック（`clone-manager.ts` の active job チェックが大半を防ぐが、ジョブ登録前の短い窓が残る）を通過すると、後段 `onCloneSuccess()` の `createRepository()` が **raw な better-sqlite3 `SqliteError: UNIQUE constraint failed` を throw**していた。これは背景 clone 経路（#1340）でログのみに握られ、利用者には「成功したはずの clone が黙って失敗」として現れる。`external-apps/db.ts` に倣い INSERT を try/catch で包み、UNIQUE 違反を `RepositoryDbError('…', 'DUPLICATE', cause)` に、その他の DB エラーを `'DB_ERROR'` に変換する（元の `SqliteError` は `cause` に保持）。DB の UNIQUE 制約自体が登録の最終直列化を担い、本修正は衝突を防ぐのではなく **raw throw を型付きエラーに変える**ことで `onCloneSuccess()` の catch が構造化エラーとして扱えるようにする。あわせて、`is_env_managed` が #1328 の env 自動登録削除以降**書き込み専用のデッドフラグ**（読み手は v43 の #1339 掃除のみ）である旨を型定義に `@deprecated` として明記した（カラム削除は #1347/#1348 が周辺を参照しうるため見送り、非推奨コメントに留める）
- fix(api): **リポジトリ DELETE の 404 応答時に幽霊行を作らない** (#1346)。`DELETE /api/repositories` は `disableRepository()` を worktree 件数チェックの**前**に呼んでおり（#190 SF-C01: worktrees テーブルにレコードが無くても除外登録を保証する意図）、`disableRepository()` は未登録パスに対して行を**新規作成**する。このため worktree を持たない未登録パスを削除すると、利用者には 404「Repository not found」を返しながら `enabled=0, is_env_managed=false, worktree 0 件` の行だけが `repositories` テーブルに残り、リポジトリ管理画面（`getAllRepositoriesWithWorktreeCount()` は repositories 駆動）に「Disabled」の幽霊行として現れていた。restore しても worktree 0 件の `enabled=1` 行になるだけで消せない。#1339 の残置行と同型の行を**ランタイムで再生産する経路**であり、掃除しても再発する。新規作成を行わない `disableExistingRepository()` を追加し、404 経路では**登録済みの行がある場合のみ**無効化するようにした。#190 の意図は保たれる: Sync All が復活させうるリポジトリ（環境変数由来）はサーバー起動時の `initializeWorktrees()` と Sync All 自身が `registerAndFilterRepositories()` → `ensureEnvRepositoriesRegistered()` で `repositories` に**登録済み**であり、「未 sync（worktree 0 件）の環境変数リポジトリを削除 → 除外登録される」という SF-C01 の受入条件は行の更新として成立する。除外対象になりえない（＝どの経路からも復活しない）未登録パスに対してのみ行を作らない、という線引きになる。worktree を持つ未登録パスは復活の対象になりうるため、従来どおり `disableRepository()` で新規作成する。この経路では新規作成が発生しないため SEC-SF-004（`MAX_DISABLED_REPOSITORIES` 上限）の枯渇要因も1つ減る
- fix(cli): **デーモンの PID ファイルを「版・実効設定・プロセス同一性」を持つ state ファイルへ拡張する** (#1354, #1355, #1358)。従来 PID ファイルは `String(pid)` のみを記録しており、**稼働プロセスの実体を照会する手段がそもそも無かった**ため、3つの不具合が同根で成立していた。**(#1354)** `status` は Status/Port/Uptime/URL しか出さず**稼働デーモンの版を表示しない**。新 CLI を入れても旧デーモンが動き続けている状況（`update` の再起動失敗 / 手動 `npm i -g` のみ / worktree サーバーの再起動忘れ）で「Running」としか出ず、利用者は最新版が稼働中と誤認していた。**(#1355)** `start --port`/`--cert`/`--auth` の実効設定が永続化されず、`getStatus()` が URL を**現在の .env から都度再計算**していたため、`--port 4000` で起動しても `status` は .env 既定の :3000 を表示し、quickstart は死んだ :3000 をブラウザで開く（無警告）。**(#1358)** `isProcessRunning()` が `process.kill(pid,0)` のみで**同一プロセス検証をしていなかった**ため、クラッシュ後に OS が同 PID を無関係プロセスへ再割当てすると `status` が誤って「Running」を報告し、`stop` が**無関係プロセスへ SIGTERM/SIGKILL** を送り、`start` は「already running」で拒否され続けた。加えて別ユーザー所有プロセスへの再割当てで `process.kill` が **EPERM を throw** し、コマンド自体が予期せぬエラー終了していた。統合修正として PID ファイルを `{ pid, version, port, bind, protocol, auth, startedAt, startTime }` の JSON **state ファイル**へ拡張した（`PidManager.writeState()`/`readState()`、O_EXCL の atomic write は不変）。**後方互換**: 旧デーモンが書いた bare-integer 形式は `readState()` が `{ pid }` として読めるため、CLI 升级後も稼働中の旧デーモンを認識できる（この場合 version 等が無いので `getStatus()` は #1266 の .env 解決へフォールバックする）。`start()` は起動時に version（`readPackageVersion()`：`require` のモジュールキャッシュに版を固定させないためディスクから読む）・実効 port/bind/protocol/auth・および `ps -o lstart=` で採取したプロセス開始時刻（`process-inspector.ts`、macOS/Linux 両対応・取得失敗は null で best-effort）を state に記録する。`getStatus()` は state に実効設定があればそれを優先して port/URL/version/protocol/auth を返し（#1354/#1355）、`status` は版を表示し**インストール済み CLI と食い違えば警告**する。`isProcessRunning()` は `process.kill(pid,0)` 成功後に記録済み開始時刻と生プロセスの開始時刻を照合し、不一致（＝PID 再利用）を stale として弾く。これにより `stop` が無関係プロセスを kill せず、`start` の「already running」固着も解消する（#1358）。**EPERM は throw せず stale 扱い**へ変更した。開始時刻を取得できない環境では従来どおり best-effort で「running」を返す。GitHub Issue は原因箇所として `pid-manager.ts:63-85` を「PID のみ記録」と正しく指摘しているが、`daemon.ts:206` の `getStatus()` が .env から再計算する記述は #1266 で既に .env 優先へ修正済みの前提が必要で、本修正はそれを state 優先へ置き換える形になる（quickstart.ts の版照合は #1337 Wave2 の担当のため本コミットには含めない）
- fix(api): **リポジトリ DELETE のパスを正規化して worktree の残置を防ぐ** (#1347)。`DELETE /api/repositories` は冒頭で `validateRepositoryPath()` を呼び `validation.resolvedPath`（`path.resolve()` 済みの正規化パス）を算出していたが、**それを使わず生の `repositoryPath`（クライアント入力そのまま）**を `getWorktreeIdsByRepository()` / `deleteRepositoryWorktrees()` の WHERE キーに流していた。一方で `worktrees.repository_path` は sync 時（`scanWorktrees()` が `path.resolve(rootDir)`）に**正規化して格納**され、`disableRepository()` / `disableExistingRepository()`（#1346）も内部で `path.resolve()` してから照合する。このため末尾スラッシュ・相対パス・`..` を含む**非正規パスで削除要求が来ると、worktree の照合だけが空振り**し、ハンドラは「worktree 0 件」と判断して 404 を返しつつ、**該当リポジトリの worktree 行が DB に残置**される（除外登録は正規化側で成立するため「消せないのに Disabled 扱い」の不整合も生む）。ハンドラ冒頭で `const repositoryPath = validation.resolvedPath!` として以降のすべての DB 操作・ログ・broadcast を正規化パスに統一した。`validation.valid` が真のとき `resolvedPath` は必ず設定される。`worktrees.ts`（#1349 が並行修正）や DB 層の関数シグネチャは変えず、**呼び出し側で引数を正規化する**方針で最小差分に留めた

## [0.10.3] - 2026-07-17

> **Highlight**: **v0.10.2 で公開したチュートリアルの Step 1 が動作しない問題を修正するパッチリリース**。`npx commandmate@latest` で起動した環境では、リポジトリのクローンが `exit 128`（`fatal: Unable to read current working directory`）で必ず失敗していた。`CloneManager` が `cwd` を指定せずに git を spawn しており、**npm キャッシュ配下にあるサーバープロセスの cwd を継承**していたことが原因。LP からチュートリアルへ送客している状態で新規ユーザーの最初の操作が止まっていたため、緊急度が高い。DB マイグレーションなし。

### Fixed

- fix(clone): **git spawn に `cwd` を明示しクローン失敗（exit 128）を解消** (#1334)。`executeClone` が `cwd` 未指定で git を spawn していたため、子プロセスがサーバープロセスの cwd を継承していた。`npx` 起動時のサーバーの cwd は npm キャッシュ配下（`daemon.ts` の `cwd: packageRoot`）であり、`npx commandmate@latest` の再実行で `node_modules` が作り直されると削除済み inode を指したままになる。git は起動時に cwd を読もうとして失敗するため、**クローン先が絶対パスであっても関係なく落ちていた**。直前に存在を保証している `parentDir` を `cwd` として明示する。`src/lib/git/` の他の git 実行は `git-exec.ts` の `execFileAsync` に集約され全経路が `cwd` を渡しており、`clone-manager.ts` だけが生の `spawn` を直接呼ぶ唯一の例外だった。cwd 未指定の他の外部プロセス呼び出し（`ps` / `gh --version` / `tmux`）は親の cwd 消滅下でも成功することを実測で確認済みで、影響を受けるのは git clone のみ

## [0.10.2] - 2026-07-17

> **Highlight**: **新規ユーザーの導線を整えるリリース**。v0.10.1 で `npx commandmate@latest` を案内できるようにしたが、サーバーが起動した後に何をすればよいかが示されていなかった。**チュートリアル**（意図的にバグを仕込んだサンプルリポジトリ [Kewton/commandmate-tutorial](https://github.com/Kewton/commandmate-tutorial) を clone → エージェントに直させる → External Apps でブラウザ確認 → worktree で並列化）を新設し、LP から導線を繋いだ。あわせて **LP の Track A** が内部で何を自動実行するかを可視化。また `CM_ROOT_DIR` が**3つの役割を兼ねたまま1つが壊れていた**問題を整理し、「管理範囲」に定義を統一した。DB マイグレーションなし。

### Added

- feat(docs): **チュートリアルを新設**（`docs/user-guide/tutorial.md`、ja/en）。サンプルリポジトリ [Kewton/commandmate-tutorial](https://github.com/Kewton/commandmate-tutorial)（依存ゼロ・`npm install` 不要・意図的に2つのバグを仕込み済み）を clone し、clone → エージェントによる修正 → External Apps によるブラウザ確認 → worktree による並列化 の4ステップで主要機能を一通り体験できる。Claude Code / Codex 向けに `worktree-new` スキルを同梱（Antigravity では動作未確認のため代替の指示文を用意）。LP からも導線を追加 (#1329)
- feat(website): **LP の Track A に自動実行される内容を可視化**。`npx commandmate@latest` の1コマンドが内部で行うこと（依存チェック → セットアップ質問 → サーバー起動 → ブラウザ起動）を明示し、Track B と情報量を揃えた。copy 可能なコマンドは1つのまま（並べると誤実行を招くため） (#1327)

### Changed

- fix(config): **`CM_ROOT_DIR` の定義を「管理範囲」に統一**。`.env.example` / `concept.md` / `DEPLOYMENT.md`（ja/en）と `commandmate init` の案内文を、①UI からリポジトリを登録できる境界 ②クローン先の親ディレクトリ という実際の役割に合わせた。`init` の「Directory will be validated when adding repositories」は**存在しない後続検証**を指していたため削除 (#1328)
- docs: **リリース手順を実態に合わせて更新**（`/release` スキルと `docs/release-guide.md`、ja/en）。記述が v0.9.1 世代のままで、main 直 push を前提にしていた（pre-push フックが拒否する）、npm publish の記載が皆無だった（`publish.yml` が GitHub Release 契機で OIDC 自動 publish する）、squash による祖先切れを復元するマージバックが無かった、等の乖離を解消。ロールバック手順の「GitHub Release とタグを削除」は **npm 上のパッケージを消さない**ため誤りであり、publish 済みの場合は修正して次のパッチをリリースするのが正しい旨に訂正した (#1326)

### Fixed

- fix(config): **`CM_ROOT_DIR` の壊れた自動発見を削除** (#1328)。`CM_ROOT_DIR` は「①登録境界 ②クローン先 ③自動発見」の3役を兼ねていたが、③だけが `CM_ROOT_DIR` を**単一のリポジトリパス**として `git worktree list` の cwd に渡しており、①②が扱う**コンテナ**を指定すると常に 0 件を返していた（ディレクトリ走査は実装されていない）。両解釈は排他的で、アプリ全体が強制しているのは①②のため③を削除する。「コンテナを走査する」実装に直す案は、worktree を多用する実環境で**同一リポジトリの worktree 同士が別リポジトリとして二重登録される**ため却下した。`WORKTREE_REPOS`（リポジトリの明示列挙）は意味が一貫しているため維持。既存の `is_env_managed` 行は後方互換のため残す
- docs(tutorial): **チュートリアルの「ループ」が事実でなかった問題を修正** (#1332)。旧 Step 2/3 は修正してから起動する順序だったため「修正前 → 修正後」の変化を読者が観測できず、また `server.js` は `greet` をプロセス起動時に一度だけ import するため、先に起動した読者はコードを直しても画面が変わらない状況に必ず遭遇していた。起動を修正より前に置き、再起動を理由つきの明示的な手順にした

## [0.10.1] - 2026-07-17

> **Highlight**: **`npx` 導線の実効性を回復するパッチリリース**。v0.10.0 で新設したランディングページと README が案内していた `npx commandmate` は、**グローバル導入済みの環境では既存の binary を実行しレジストリを一切参照しない**ため、利用者が気づかないまま旧版を使い続けていた（実測: 最新 0.10.0 に対し 0.3.5 が実行された）。全案内を `npx commandmate@latest` に統一した。あわせて**公開パッケージから Next.js のビルドキャッシュ `.next/cache` を除外**し、配布サイズを **89.8MB → 5.5MB（−94%）／展開後 656.3MB → 24.4MB** に削減。quick start を「試す／常用する」の2トラックへ再構成し `commandmate init` / `start --daemon` / `stop` を copy 可能にした。`npx` 実行時に `update` がユーザーのグローバル導入を書き換えたうえで `UPDATE_FAILED` を返す不具合も修正している。

### Added

- feat(website): **quick start を2トラック化**し `commandmate init` / `start --daemon` / `stop` を copy 可能にした。`npx commandmate` は init も daemon 起動も自動実行するため、旧 step 2 の `commandmate init` は「グローバル導入派向けの分岐」にすぎず誤実行を招いていた。Track A（`npx commandmate@latest` の1コマンド）と Track B（グローバル導入して常用）に分離し、各コマンドが正しい文脈に収まる形にした。従来 LP に記載の無かった停止方法（`commandmate stop` / `status`）も追記 (#1317)

### Changed

- fix(docs): **README / wsl2-setup の npx 案内を `@latest` に統一**。あわせて WSL2 ガイドの主経路を clone+build からグローバル導入（`npm install -g commandmate`）へ変更し、clone+build は Development Mode セクションへ隔離。`npx` 実行時の daemon は npm キャッシュ配下から起動し、npx 再実行やキャッシュ削除で足元の `.next/` が消えるため、常駐用途はグローバル導入を案内する (#1318)

### Fixed

- fix: **公開パッケージから `.next/cache` を除外**。`files` が `.next/` を whitelist していたため Next.js の webpack ビルドキャッシュ（実行時には読まれない）が丸ごと publish され、`npx` 利用者が毎回 633MB を展開していた。`npm pack` 実測で 656.3MB → 22.8MB（unpacked）／89.8MB → 5.3MB（packed）。packed tarball を隔離環境へ導入して実起動を検証済み。npm は `files` を順序で解決し後勝ちで上書きするため、`'!.next/cache'` の位置をテストで固定した (#1315)
- fix(website): **LP の npx コマンドを `npx commandmate@latest` に統一**。bare `npx commandmate` はグローバル導入済みの環境で既存 binary を実行しレジストリを参照しないため、旧版が黙って使われ続けていた (#1316)
- fix(cli): **`npx` 実行時の `update` を検出して誤動作を防ぐ**。`isGlobalInstall()` は npx キャッシュのパスにも意図的に true を返す（#1195: config/DB を `~/.commandmate` に置くため）ため、`update` が global ブランチに入り、使い捨ての npx プロセスがユーザーのグローバル導入を書き換えたうえで、インストール後検証が npx キャッシュ側を読み直して `UPDATE_FAILED` (exit 5) になっていた。`isGlobalInstall()` は変更せず `isNpxExecution()` を別途追加して gate する (#1319)
- chore(website): **copy ボタンの timeout race を修正**。`setTimeout` が click 時に同期スケジュールされ clipboard promise の解決前にカウントを開始していたため、各 `.then` コールバック内へ移動した。参照されていない `data-copy-root` 属性も削除 (#1320)

## [0.10.0] - 2026-07-16

> **Highlight**: v0.9.1（フレームワーク基盤更新）に続く**アプリケーション層の充実リリース**。中心は**多言語対応（i18n）基盤の全面確立**で、`src/app` / `src/lib` / `src/config` および各種コンポーネント・パネル・ダイアログの英語ハードコード文言を next-intl 辞書（en/ja）へ全面移行し、namespace 方針を確定。EN をキー byte-identical に保つ実辞書ガードと、モジュールスコープ const の literal label を検出する ESLint ルールで規律を固定した。あわせて**インストール／アップデート／オンボーディング体験**を改善（`commandmate update` コマンド、引数なし実行のガイド付きクイックスタート、初回オンボーディング導線、アップデート通知バナーの更新ボタン）、**GitHub Pages ランディングページ**を新設、**堅牢性**を強化（better-sqlite3 の ABI mismatch 自動 rebuild、システムディレクトリ判定のパス境界＋symlink 解決、不正 `CM_DB_PATH` の fail-closed、Node 20 EOL に伴う `engines >=22` 引き上げ）。プッシュ通知のロケール対応に伴い **DB マイグレーション v42** を追加し `CURRENT_SCHEMA_VERSION` を 41→42 に更新した。

### Added

- feat(cli): **`commandmate update` コマンドを追加**。グローバルインストール時に 停止 → `npm install -g` → 再起動 で自己更新する。`--check`（更新有無の表示のみ）／`--yes`（非対話環境向けに確認スキップ）に対応 (#1194)
- feat(cli): **引数なし実行をガイド付きクイックスタート化**し `engines` を追加。初回利用者が `commandmate` だけで導入手順に到達できるようにした (#1195)
- feat(ui): **初回オンボーディング導線を追加**（空状態 CTA ＋ セットアップチェックリスト） (#1199)
- feat(ui): **アップデート通知バナーに「今すぐアップデート」ボタンを追加** (#1198)
- feat(lp): **GitHub Pages ランディングページを構築** (#1200)
- feat(db): **better-sqlite3 の ABI mismatch を検知して自動 rebuild** する起動時ガードを追加。Node 更新後の native モジュール不整合による起動失敗を自己修復する (#1263)
- feat(i18n): **プッシュ通知をロケール対応化**。購読時に locale を保存し、サーバサイド（React request scope 外のバックグラウンド送信）は `createTranslator` で解決する。DB マイグレーション v42 を追加し `CURRENT_SCHEMA_VERSION` を 42 に更新 (#1308)

### Changed

- feat(i18n): **アプリ全体の英語ハードコード文言を next-intl 辞書（en/ja）へ全面移行**。対象は Home/Repository (#1197)、Header/GlobalMobileNav (#1206)、RepositoryManager (#1219)、ui/common/sidebar/external-apps (#1273)、home/review/mobile/layout (#1274)、worktree ファイル閲覧・編集系 (#1275)、worktree セッション・メッセージ系 (#1276)、worktree パネル・ダイアログ系と git (#1277)、status-colors ラベル (#1304)、src/app（sessions/review/layout/offline）(#1305)、standard-commands のスラッシュコマンド description (#1306)、git/schedule の AI プロンプトテンプレート (#1307)。あわせて namespace 方針を確定し、EN をキー byte-identical に保つ実辞書ガード（テストのキー素通しモックでは検出できない欠落キーを捕捉）を導入
- chore(lint): **モジュールスコープ const の literal label を検出する ESLint ルールを追加**。`t()` を呼べない module scope での英語直書きを防止し、i18n 移行の後戻りを止める (#1271)
- chore(engines): **Node 20 EOL のため `engines` を `>=22.0.0` に引き上げ** (#1264)
- chore(build): **tsconfig の `include` を実ディレクトリ（src/tests/scripts）に限定**し、spike/生成物のスコープ混入を防止 (#1265)
- chore(deps): **package-lock.json の `engines` を package.json に同期** (#1293)
- docs: **ドキュメント間の矛盾を解消し README に Update セクションを追加** (#1196)
- research(db): **better-sqlite3 → node:sqlite 移行を調査**（判定: No-Go・時期尚早） (#1201)

### Fixed

- fix(polling): **Claude の応答が History に反映されない問題を修正** (#1268)
- fix(polling): **Claude のフッターを抽出時点で落とし、応答の重複保存を防止** (#1289)
- fix(polling): **起動バナーを assistant message として保存しない**よう修正 (#1292)
- fix(security): **`isSystemDirectory` をパス境界＋symlink 解決で判定**し、`/tmp` `/var` `/etc` 等の誤判定・バイパスを解消 (#1285)
- fix(config): **不正な `CM_DB_PATH` を黙って既定値に差し替えず、起動時に停止**（fail-closed） (#1267)
- fix(cli): **`status` が実際の起動ポートを報告**するよう `.env` の優先順位を是正 (#1266)
- fix(mobile): **下部ナビのラベルに折返し防止を追加**し、320px 日本語での 2 行折返しを解消 (#1211)
- fix(website): **LP から動画を外し、ヒーロー/og:image を隔離環境の素材へ差し替え** (#1272)
- test: **CI 限定でフレークするテストを複数修正**（UpdateNotificationBanner #1287、MessageInput #1222、MarkdownEditor TOC #1216、issue-288 Scenario 5 #1209、GitPane DR3-004 #1204）。あわせて start-issue/status-issue/stop-issue が実装を検証していない問題を修正 (#1269)

## [0.9.1] - 2026-07-15

> **Highlight**: **フレームワーク基盤の更新（#1129）** を中心としたメンテナンスリリース。**Next.js 14.2 → 15.5 / React 18.3 → 19.2**（#1177）で async request APIs に追随し `src/app/api` の 66 route を全件 `await params` へ移行、**Tailwind CSS 3.4 → 4.3**（#1178）で `tailwind.config.js` を廃止し CSS-first（`@theme inline`）へ移行した（いずれも見た目・挙動は不変）。あわせて **E2E スイートの drift 修復と CI 組込み**（#1180）を行い、ローカル実行が稼働中の本番サーバを再利用して**本番 DB を破壊し得た構成**を専用ポート 3177 ＋ スクラッチ DB ＋ リポジトリ外 `CM_ROOT_DIR` で隔離。**ルート遷移で偽の Home がちらつく問題**（#1184）を修正し、Next.js 15 で deprecated となった `next lint` を **ESLint CLI へ移行**（#1181）した。機能追加および DB マイグレーションはなし（`CURRENT_SCHEMA_VERSION` は 41 のまま）。

### Changed

- chore(deps): **Next.js 15 / React 19 アップグレード**（#1129 の 1/2）。Next.js 14.2.35 → 15.5.20 / React 18.3 → 19.2.7。async request APIs 対応として `src/app/api` の params 利用 66 route を全件 `await params` へ移行（移行前: 同期 54 / Promise 済 12）。名前衝突する 3 route（`git/stash/[index]` の rawIndex、schedules POST の worktreeId、todos PATCH の todoId）は個別にリネームして意味を保持。`terminal/page.tsx` はクライアントページのため `use(params)` で展開。React 19 型対応としてグローバル JSX 名前空間廃止 → `React.JSX.Element`、`useRef` 引数必須化、`RefObject<T | null>` への型拡幅、`img.src` の `string | Blob` 拡幅に伴う型ガード追加。テスト側はルートハンドラ呼び出し 484 箇所の params を `Promise.resolve()` でラップし、既存テストの削除・skip なし (Issue #1177)
- chore(deps): **Tailwind CSS 4 アップグレード**（#1129 の 2/2）。3.4.18 → 4.3.2。`tailwind.config.js` を廃止し `@theme inline` による CSS-first へ移行（`inline` 必須: 非 inline では utility が `var(--color-*)` を出力し `.dark` 再宣言が `:root` で固定されテーマ切替が壊れるため）。v4 は不透明度修飾子を `color-mix()` で合成するため `<alpha-value>` 方式を廃止し `rgb(var(--token))` で登録、`:root`/`.dark` の RGB トリプレット 43 トークンは無変更。`tailwindcss-animate`（v4 非対応）→ `tw-animate-css`（クラス面同一のポートのため呼び出し側の変更 0 件）。Preflight の border-color 既定が `currentColor` へ変わったため v3 の gray-200 を復元する互換シムを追加、`source(none)` ＋ 明示 `@source` で走査対象を v3 の content グロブと同一集合に固定。`bg-opacity-50` は v4 で削除のため `bg-black/50` へ（Modal.tsx）。生成 CSS を v3 実ビルドと比較し差分が想定内であることを確認 (Issue #1178)
- test(e2e): **E2E スイートの drift 修復と CI 組込み・本番 DB 汚染リスクの是正**。CI 未組込みのまま長期 drift し実行しても通らない状態（#1102 の integration 版と同構図）を修復し、`ci-pr.yml` へ E2E ジョブを追加。従来は `baseURL: localhost:3000` ＋ `reuseExistingServer: !CI` のため、ローカル実行で稼働中の本番サーバを再利用し作業ツリーではなく旧コードを検証したうえ本番 DB を破壊し得たため、専用ポート 3177（`CM_E2E_PORT` で上書き可、3000 は明示的に拒否）／`reuseExistingServer: false`／スクラッチ DB への `CM_DB_PATH` 固定／リポジトリ外への `CM_ROOT_DIR` 固定の 4 点で隔離。worktree スキャンは `CM_ROOT_DIR` を cwd とする `git worktree list` であり git は cwd から上方向へリポジトリを探索するため、スクラッチ根は `$HOME` 配下に置き `GIT_CEILING_DIRECTORIES` で探索を止め、リポジトリ内だった場合は config ロード時に fail closed するガードを追加。spec の drift 修復（locale-switcher の収集時 throw により全ファイルが 1 件も実行されていなかった問題、worktree-list の #1072 バナー撤去追随）と、成立していなかった Mobile Safari プロジェクトの削除を実施。結果: 41 passed / 32 skipped / 0 failed（skip 件数は増やさず） (Issue #1180)
- chore(lint): **`next lint` から ESLint CLI へ移行**。`next lint` は Next.js 15 で deprecated・Next.js 16 で削除されるため、lint スクリプトを ESLint CLI の直接呼び出しへ置換。`next lint` の内部既定値（対象 dir=src、拡張子 .js,.jsx,.ts,.tsx、useEslintrc=true）を CLI 引数として明示したため、lint 対象 702 ファイル・解決後ルールセットは移行前後で完全に同一。`@next/codemod` は eslint を ^9 へ強制 bump しスコープ外の major 移行を伴うため非適用とし、flat config 移行も見送って `.eslintrc.json` は無変更 (Issue #1181)
- chore(deps): **package-lock.json を再生成し orphaned autoprefixer を除去**。#1178 で autoprefixer を package.json から削除し `@tailwindcss/postcss` へ切り替えたが lock が再生成されておらず、`dependencies.autoprefixer` とその node_modules エントリが orphan として残っていた。`npm ci` は drift を許容するため CI は緑のままだったが、clean `npm install` のたびに 62 行の diff が再生成され誤コミットの risk があった。再生成により autoprefixer と推移的依存を除去（1080 → 1077 エントリ）。生成 CSS は byte-identical で、Tailwind 4 の Lightning CSS が既に vendor prefixing を担っていることを確認 (Issue #1188)
- test(sidebar): **scroll restore の完了を待ってから scrollTop を駆動**。Sidebar はブランチ一覧の初回描画後にスケジュールされる `requestAnimationFrame` 内で永続化済み scrollTop を復元するが、両 scroll テストがそのフレーム前に scrollTop を書いていたため、復元が空 localStorage の既定値 0 でテスト対象値を上書きしていた。リスト項目の描画を待って復元フレームを flush してから scrollTop を書くよう変更し、フレームの発火順序に依存しないようにした（CI は `fileParallelism: false` のため顕在化） (Issue #1182)
- chore: **UI 検証のデバッグ生成物と CommandMate 実行時データを ignore**。UI 検証（Playwright / MCP）がリポジトリ直下に吐き続けていたスクリーンショット・aria スナップショット 88 件を無視対象に追加（パターンは先頭 `/` で直下のみに限定し、`docs/images/` の正規スクリーンショットと `.github/workflows/*.yml` は追跡対象を維持）。`.md` は命名が一定しないため許可リスト方式を採用。`.commandmate/` はデバッグ生成物ではなくアプリの実行時データ（チャット添付画像の保存先）のため `dev-reports/` と同じく無視対象とした

### Fixed

- fix(ui): **ルート遷移で偽の Home がちらつく問題を修正**。7 つの `loading.tsx` が共有する `RouteLoading` が見出し＋横並び 2 カード（Home の bento グリッドと同じ輪郭）を描いていたため、ルートチャンクが未キャッシュの遷移（リビルド直後のサイドバーからのブランチ選択など）で「描きかけの Home」が一瞬表示され、遷移先を誤認させていた。共有フォールバックはどの画面が到着するか知り得ず、描く輪郭は他の 6 画面にとって必ず誤りとなるため、ページ輪郭を不確定な 3 点パルスのアクティビティインジケータへ置換（遷移先を主張せず「読み込み中」のみを伝える）。ビューポートを満たす挙動は維持し、実シェルへの入れ替えで空白やレイアウトシフトを起こさない #1118 の意図を保持。ドットは Skeleton プリミティブの `bg-muted`（大きなプレースホルダ用の色でドットサイズではライト `--background` 上で不可視）ではなく `bg-muted-foreground` を使用し、ConversationPairCard/ExternalAppStatus の既存 waiting-dot イディオムに合わせた。stagger の arbitrary `animation-delay` は #1050 のグローバル `prefers-reduced-motion` リセットで無効化される (Issue #1184)

## [0.9.0] - 2026-07-15

> **Highlight**: **UI/UX モダナイゼーション（#1040 系 Phase 1〜5）** を中心とした大型リリース。①**セマンティックデザイントークン基盤**（#1041）＋ `cn()`/cva によるバリアント管理（#1042）を導入し、生 gray/slate/chromatic 直書きを全面トークン化（#1061 群 A〜D / #1082 / #1116）して CI ガード（`token-discipline`）で規律を固定。②**lucide-react アイコン統一**（#1044）・**Geist フォント**（#1043）・**Radix ベースプリミティブ拡充**（#1046 / #1076）・**モーション基盤**（#1050）でビジュアル言語を刷新し、**テーマ既定を system 化**（#1071）してライト/ダーク双方を正式サポート。③**Home のダッシュボード（bento）化**（#1052）、**⌘K コマンドパレット**（#1053 / #1077）、**StatusDot への稼働ステータス一本化**（#1051 / #1078）を追加。④**リアルタイム化と性能**: ターミナル出力・セッションステータスの **WebSocket ストリーミング**（#1120）、**HistoryPane の仮想化**（#1123、1000 件で DOM 26,001→449 / 初期描画 289ms→24ms、250 件上限を撤廃）、**送信の Optimistic UI**（#1121）。⑤**モバイル/PWA**: **PWA 対応**（manifest + Service Worker、#1124）、**Web Push 通知**（#1125、migration v41）、ジェスチャー強化（#1128）、A11y 改善（#1127）。あわせて**同一ディレクトリのブランチ切替で会話履歴等が CASCADE 削除されるデータ損失**（#1151）、**tmux セッションターゲットのプレフィックス衝突漏洩**（#1156 / #1158）、**Codex v0.141 のステータス検出破綻**（#1150 / #1160）を修正した。DB マイグレーションは v39→v41、`CURRENT_SCHEMA_VERSION` を 39→41 に更新。

### Added
- feat(ui): **セマンティックデザイントークン基盤を導入**。`globals.css` に `:root`(light)/`.dark`(dark) の CSS 変数（background/foreground/surface/muted/border/input/ring/accent-50..700/success/warning/danger/info）を定義し、`tailwind.config.js` の primary(cyan)・cmd-bg-dark を semantic トークンへ置換。`layout.tsx` / `MainLayout.tsx` の body 背景を `bg-background` に統一。既存の実効値を写し取り視覚は不変（no-op）。`docs/design-system.md` を新設 (Issue #1041)
- feat(ui): **`cn()`/cva によるバリアント管理基盤とプリミティブ改修**。clsx + tailwind-merge の `cn()` ヘルパーと class-variance-authority を導入し、Button/Card/Badge/Modal を cva ベースへ移行。Button ghost バリアントの `dark:` 指定漏れ（ダークモードで視認性劣化）を修正。既存 API は完全互換 (Issue #1042)
- feat(ui): **アイコンを lucide-react に統一**。絵文字アイコン（🤖⚡✦💻）を廃止し lucide アイコンへ置換。共通レイアウト・ナビ（Header/GlobalMobileNav/MobileTabBar/ActivityBar/terminal page）および worktree 各所のインライン SVG を lucide に統一。`docs/design-system.md` にアイコンサイズ規約を追記 (Issue #1044)
- feat(ui): **next/font で Geist Sans/Mono を導入**。geist パッケージ（セルフホスト）で GeistSans/GeistMono の CSS 変数を `<html>` に適用し、tailwind fontFamily の sans/mono を「Geist → 日本語（Hiragino/Noto Sans JP）→ システム」フォールバックで構成。`Terminal.tsx`（xterm）の等幅も Geist Mono を先頭指定 (Issue #1043)
- feat(ui): **Radix ベース UI プリミティブを拡充**。Input/Textarea/Select/Tabs/Tooltip/DropdownMenu/Switch/Skeleton を追加（cva + cn、セマンティックトークン着色、ライト/ダーク対応）。Portal 系は `'use client'` + `Z_INDEX(POPOVER)` で Modal と階層整合。Sessions ページのフィルタ/ソートを新プリミティブへ移行（適用サンプル） (Issue #1046)
- feat(ui): **アクセント色を統一しセマンティックトークンへ置換**。cyan/blue 直書き（約 600 箇所 / 131 ファイル）を #1041 のトークンへ置換（インタラクティブ=accent / フォーカス=ring / 情報=info）。gray 系は surface/background/border/muted へ実効値を保って置換。例外（`Terminal.tsx` の xterm ANSI 配色 / CLI ブランド色 / `.scrollbar-thin` 等の固定装飾色）は維持 (Issue #1045)
- feat(ui): **主要ページを共通 UI プリミティブへ移行**。layout（Header/Sidebar の検索・トグル・言語）/ home / repositories / review / more / chat / login の生 button・手組みフォーム・コピペカードを `@/components/ui` プリミティブへ移行。機能・挙動（onClick/フォーム送信/バリデーション/キーボード）は維持。ネイティブ select・複合 textarea 入力バー・極小アイコントグルは意図的に残置 (Issue #1047)
- feat(ui): **`globals.css` の `@apply` クラスを廃止し cva プリミティブを自己完結化**。`.btn`/`.btn-*`/`.card`/`.card-hover`/`.badge*`/`.input` を削除し Button/Card/Badge の cva 定義へ実クラスを内挿（旧 `@apply` 定義と同値、視覚不変）。src/ 全体で削除クラスへの参照が 0 であることを確認。worktree の一部（WorktreeDetailRefactored/LogViewer/WorktreeList/ExternalAppForm）をプリミティブへ移行し、マジックナンバー入りインライン style を定数化 (Issue #1048)
- feat(ui): **サーフェス・奥行きを再設計しモダンダークテーマへ刷新**。`globals.css` の `:root`/`.dark` トークン値を刷新（深い base + 微リフト surface + ヘアライン border）。Header/GlobalMobileNav に `backdrop-blur`（`supports-[backdrop-filter]` フォールバック付）。Card に elevated/interactive variant、h1-h4 見出しタイポを調整。主要閲覧画面のコンテンツカード（sessions/home/review）を surface/border へ移行し背景反転による溶け込みを解消、ダーク入力を surface-2 で凹み表現。コントラストは WCAG AA 全 pass (Issue #1049)
- feat(ui): **モーション基盤とマイクロインタラクションを追加**。tailwindcss-animate を導入し、Modal/MobilePromptSheet の enter/exit、Radix data-state 連動（DropdownMenu/Select/Tooltip）、一覧の stagger、hover lift を統一適用。`prefers-reduced-motion` 対応（motion-safe 化）。ターミナル/仮想スクロールには非適用 (Issue #1050)
- feat(ui): **Home をダッシュボード（bento グリッド）化**。縦積みから bento グリッドへ再構成（統計/直近セッション/ToDo/クイックアクション）。PC は CSS Grid（grid-cols-12 + col-span）、モバイルは 1 カラム縦積み（`useIsMobile` の JS 分岐を増やさず Tailwind breakpoint）。既存 sessions 取得フック/API を再利用し新規 API なし。既存機能（ToDo 追加/チェック/コピー、セッションカウント）を維持、空状態対応 (Issue #1052)
- feat(ui): **コマンドパレット（⌘K）を追加**。cmdk で ⌘K(mac)/Ctrl+K(win) のパレットを追加（Navigation / Worktrees 検索 / Actions）。input/textarea/ターミナル入力中は非発火、SSR 安全（`'use client'`）、i18n（en/ja）、Modal 相当の z-index。モバイルは GlobalMobileNav に起動導線。open 時に入力へフォーカスしキーボード操作（type/矢印/Enter）を保証、worktree 一覧は共有キャッシュ context を再利用（失敗時 Navigation fallback）、Escape の preventDefault/stopPropagation と close 時のフォーカス復帰 (Issue #1053)
- feat(ui): **エージェント/セッションステータスの視覚を強化**。`StatusDot`（running/waiting/idle/error）を新設。running はグロー+パルス+静的リング halo、waiting は amber の弱点滅。サイドバー（BranchStatusIndicator）/ Home / Sessions を StatusDot 化。`prefers-reduced-motion` でパルス停止（静的リングで running≠ready を維持）、ポーリングで再発火しない CSS infinite アニメ (Issue #1051)
- feat(ui): **テーマ既定を system 化しヘッダーにトグルを追加**。next-themes を `defaultTheme="system" enableSystem` に変更し、ライト環境ユーザーへの強制ダークを解消。Header 右クラスタに `ThemeToggle` を追加（発見可能性向上）。`globals.css` に `color-scheme`（`:root`=light / `.dark`=dark）を宣言し、残存ネイティブコントロールの OS クローム事故（dark で白いドロップダウン等）を防止 (Issue #1071)
- feat(ui): **Home 第一フォールドを回収**（バナー削除・見出し降格・tabular-nums）。陳腐化した Welcome バナー（#600 のナビ再編告知）を削除。h1「CommandMate」を機能的見出し（`HomeHeading`: Overview + ライブサブライン）へ降格しヘッダーのワードマークとの同語反復を解消。Home の数値・相対時刻・サイドバーのブランチ数バッジに `tabular-nums` を導入。`HomeQuickActions` の inline SVG を lucide へ置換。相対時刻の短縮形は新設 date-utils、見出し文言は home i18n namespace（en/ja） (Issue #1072)
- feat(ui): **ライトモードのエレベーション階梯を反転**（グレー地+白カード+2 層影）。light を「白ページ+凹む灰カード」から Vercel/Linear 型の「グレー地ページ+白カード+2 層影」へ反転し、dark（#1049）と対のエレベーションモデルに。surface-2(740) < background(751) < surface(765) の「白カードが浮き、well が沈む」階梯（`.dark` は不変で回帰なし）。`tailwind.config.js` に 2 層 `boxShadow.sm` を追加、WCAG コントラスト検証テストを追加 (Issue #1074)
- feat(ui): **サイドバーを `--sidebar-*` トークン化しテーマ追従に**。`bg-gray-800 text-white` 固定でテーマ孤島だったサイドバーを、新設の `--sidebar` / `--sidebar-foreground` / `--sidebar-border` / `--sidebar-hover` / `--sidebar-muted` へ移行（light=slate-50 系の明るいパネル、dark=#141821）。standalone なリテラル RGB 値のため #1074 の `--surface` 反転が滲まない。Sidebar/BranchListItem/SortSelectorBase/検索 Input/LocaleSwitcher/ThemeToggle の直書きを全てトークンへ置換 (Issue #1073)
- feat(ui): **⌘K パレットを Raycast 級に強化**（アイコン/StatusDot/kbd/Recents/ヘッダー導線）。`ui/Kbd.tsx` を新設、NAV 行に lucide アイコン・worktree 行に GitBranch + StatusDot、キーボードガイドのフッター（↑↓/↵/esc）、Recent グループ（localStorage `cm.palette.recents`、MRU<=8、空クエリ時のみ）、worktree を isSessionRunning 優先→updatedAt 降順ソート。Actions 拡充（Sync repositories / 言語切替 / Open GitHub）、Header に ⌘K 検索ピル。#1053 の挙動契約（フォーカス/入力ガード/Escape/backdrop/data-testid）を維持 (Issue #1077)
- feat(ui): **ターミナルクロームを刷新**（全周枠廃止・カード化・CLI セレクタ DropdownMenu 化）。worktree ターミナルの全周枠を廃し surface-2 カード＋ヘアラインのカード化に統一。CLI インスタンスセレクタを native `<select>` から Radix DropdownMenu（StatusDot+alias+ChevronDown）へ置換し、value/onChange の単一選択セマンティクスと testid を保持。xterm の theme は意図的に固定ダークを維持 (Issue #1079)
- feat(ui): **worktree 詳細/Chat のダーク直書き島を surface トークン化しテーマ追従に**。HistoryPane / ConversationPairCard / AssistantMessageList / AssistantChatPanel / HistorySearchBar / CopyButton と `.assistant-md` の常時ダーク直書きを surface/foreground トークンへ移行。`.assistant-md` のリンクを accent-700 dark:accent-400、code/pre を明色地にし両テーマ AA≥4.5:1。コンテナ＋全子孫を移行し子の直書き light-on-dark を残さない。ConversationPairCard のツールバー hover-reveal 化に伴うタッチ端末での不可視化を `[@media(hover:none)]:opacity-100` で解消 (Issue #1075)
- feat(ui): **データ画面コントロールの意味論を整理**（Review/Repositories/More）。Review のフィルタを CTA 風ボタンから件数付きセグメンテッドコントロールへ（選択は `bg-accent-500/15`、件数は既存のフィルタ済み配列長から算出し新規 fetch なし）。Repositories の Enabled/Disabled バッジと可視性トグルの緑ピルを StatusDot 流の dot＋muted テキストへ、パスは truncate＋font-mono＋full-path tooltip、Edit は ghost な Pencil アイコンボタンへ。More は `ExternalAppsManager` 側の重複 h2 を削除。絞り込み・編集・削除・可視性トグルのロジックは不変 (Issue #1081)
- feat(ui): **コンポーザーをカード化しモバイル worktree コントロールを整理**。`MessageInput` をコンポーザーカード化（surface/border/shadow/focus-ring）し、送信ボタンを入力有無で filled/ghost に切替。Auto-Yes をコンポーザー下辺のメタ行へ統合（`ui/Switch` 化）、右側に Kbd キーヒント（#1077 の `ui/Kbd` 再利用）。`InterruptButton` のオレンジ直値を `text-danger` ghost へ。モバイル sticky 行をインスタンスタブ専用化し、検索/End を `MobileTerminalActionsSheet`（ボトムシート）へ移設。MobileTabBar を GlobalMobileNav 様式へ統一 (Issue #1080)
- feat(ui): **稼働ステータスを StatusDot 一本化し idle ノイズを縮退**。青スピナー（border-info）と生 span を全て統一 StatusDot に置換。Sessions は running/waiting のみラベル付きで idle は「+N idle」カウンタ、worktree ヘッダーは idle を StatusDot のみの円形ボタン+Tooltip、幅超過は「+N」DropdownMenu オーバーフロー。新規 `lib/agent-status-display.ts` に `classifyHeaderInstances` 等の導出を集約。`status-colors.ts` の `type:'spinner'`/border-info は `@deprecated` 化。「+N」オーバーフローに稼働中があれば集約 StatusDot グローを表示 (Issue #1078)
- feat(ui): **ネイティブ checkbox/radio を Radix プリミティブに統一**。OS 標準の白いフォームコントロールが dark に浮く問題を解消。`@radix-ui/react-checkbox` / `react-radio-group` ベースの `ui/Checkbox`・`ui/RadioGroup` を新設し、残存ネイティブ input（checkbox 12 箇所/11 ファイル・radio 6 箇所/4 ファイル）を全て移行。name/value/disabled/aria/data-testid とラベルクリックのトグルを保持。移行後 native `type="checkbox"`/`"radio"` は src/ 配下 0 件（grep 検証済） (Issue #1076)
- feat(ui): **トークン規律の確立**（生 gray/slate 置換・focus-visible 統一・CI ガード）。Button の secondary/ghost を muted/foreground・danger を bg-danger トークンへ、`focus:` → `focus-visible:` + `ring-offset-background`（dark の白ハロー解消）。app（worktrees を除く）/ ui / layout / home / review / repository / common の生 gray/slate をトークンへスイープ。`layout.tsx` に title template（`%s | CommandMate`）+ viewport themeColor を追加。`.github/workflows/ci-pr.yml` に `token-discipline` ジョブ（ホワイトリスト方式・移行済みディレクトリ限定 hard-fail）を追加 (Issue #1082)
- feat(timer): **Timer 履歴の詳細モーダル表示と失敗理由の記録**。Schedule 側の `execution_logs` 方式を Timer へ横展開。migration v40 で `timer_messages` に `error` 列（nullable）を追加（schema 39→40）し、timer-db で read/write 貫通・`updateTimerStatus` に optional error 引数・`recoverStuckSendingTimers` に固定リカバリ理由。timer-manager が送信失敗（stage/error）・例外（error.message）を error 列へ永続化（`no_session` は保存せず）。GET timers レスポンスに error を追加し、`TimerDetailModal` を新設して履歴行クリックで指示全文＋メタ＋失敗理由を表示（PC=Modal / mobile=FullScreenModal） (Issue #1107)
- feat(files): **Files ツリー展開状態の worktree 単位永続化と表示リセット**。新規 `useFileTreeExpandedState` が展開集合を worktree 単位 localStorage（キー `commandmate:file-tree-expanded:<worktreeId>`）に永続化（lazy-init 復元をマウント再フェッチに乗せ、空集合はキー削除、worktree 間の漏洩なし）。`useFileTabs` に CLOSE_ALL / `closeAllTabs()` を追加し、FileTreeView ツールバーに「表示をリセット」ボタン（更新ボタンの隣・常時可視）を追加。Controller/Desktop/Mobile/Refactored に `resetFileTreeView`（検索クリア・全タブ閉じ・モバイルビューア閉）を配線 (Issue #1108)
- feat(ui): **ステータスカラー tint トークン導入とダーク非対応フィードバック UI の移行**。success/warning/danger/info × subtle/border/foreground の 12 トークンを両テーマで追加（ライト `*-50` 面 + `*-800` 前景、ダーク `*-950` 面 + `*-300` 前景、全て WCAG AA 準拠）。Toast / DefaultErrorFallback / History・Prompt・ConnectionErrorFallback / ErrorDisplay / PromptPanel を新トークンへ移行し生パレット + `dark:` ペアを撤去（TerminalErrorFallback は常時ダーク島のため現状維持）。tint 面内のソリッドアクションボタンは反転 tint で両テーマ AA を確保 (Issue #1112)
- feat(ui): **ヘッダーナビのアクティブインジケータ実装と角丸スケール規約の導入**。Header ナビに CSS-only の下線インジケータ（after 疑似要素の scale-x トランジション、`--motion-ease-out` / duration-200 準拠、motion-safe ガード）を実装し、アクティブ項目に `aria-current="page"` を付与。`docs/design-system.md` に角丸スケール規約（コントロール=rounded-md / コンテナ=rounded-lg / ポップアップ=rounded-md / チップ=rounded-full / 小型インライン=rounded-sm、裸 rounded 原則禁止）を追記し、明確な逸脱のみ是正 (Issue #1119)
- feat(ui): **スケルトンローディング展開と Spinner 統一・loading.tsx 整備**。`ui/Spinner.tsx` を新設し手書きインライン SVG/border 系スピナー 43 箇所を共通プリミティブへ置換。主要画面（Home Session Overview/ToDo、Sessions 一覧、Repositories 一覧、HistoryPane、ファイルツリー、AssistantChatPanel、Review タブ群）にレイアウト整合スケルトンを実装し、初回ロードのみスケルトン表示（再 fetch 時は既存コンテンツ維持の非ブロッキングパターン）。主要 7 ルートに `loading.tsx` を追加、AssistantChatPanel のローディングを導出状態化し空状態フラッシュを解消 (Issue #1118)
- feat(ui): **View Transitions API によるページ遷移クロスフェードを導入**。主要ルート間（Home/Chat/Sessions/Repos/Review/More/worktree 詳細）のコンテンツ領域をクロスフェードするプログレッシブエンハンスメント。外部依存を追加せず自前の薄いラッパを採用（`src/lib/view-transitions`: supportsViewTransitions/prefersReducedMotion/startViewTransition、非対応・reduced-motion 時は即時遷移フォールバック）。`ViewTransitionsProvider` が App Router ナビゲーションへ橋渡し（`usePathname` のコミット監視、非コミット時は `COMMIT_SAFETY_TIMEOUT_MS=500` で settle）。永続シェル（ヘッダー/サイドバー/ボトムナビ）は root 固定で除外し、`::view-transition` 背景を `--background` にしてダークの白フラッシュを防止 (Issue #1122)
- feat(realtime): **ターミナル出力・セッションステータスを WebSocket ストリーミング化**。実装済みだが未接続だった WebSocket インフラをクライアントへ接続し、ポーリングをフォールバックとして残しつつサーバ→クライアントの一方向 push へ移行。`useWebSocket` を再設計（単一 WS 接続・指数バックオフ再接続 1s..30s・visibility 連携・room 購読再送）、`RealtimeProvider`/`useRealtime` で共有 1 本化＋listener fan-out＋購読 ref カウント。send 時に running 遷移を broadcast しサイドバー状態ドットを即時反映、response-poller tick から `terminal_snapshot` を push（購読者 0 で tmux capture をスキップ）。`computeTerminalUpdate` で追記/リセットを判定し TerminalDisplay を keyed chunk 追記化して全置換を廃止（テキスト選択を維持）。Cookie 自動付与で WS upgrade し認証失敗時は既存機構が接続拒否 (Issue #1120)
- feat(chat): **メッセージ送信の Optimistic UI を実装**。送信瞬間に pending 吹き出しを履歴末尾へ即時挿入し、サーバ echo で実データへ照合置換（重複表示なし）、失敗時はエラー表示＋再試行/破棄。`usePendingMessages` 層が serverMessages に pending をマージし `ChatMessage`（optimisticState 付き）として渡す（content 一致＋作成時 baseline 外＋`consumedServerIds` の一意消費で照合、API reject／timeout 30s で error→retry/discard）。`MessageInput` は `onOptimisticSend` 提供時に送信を委譲し composer を即時クリア。仮想化リストと整合し pending も pair 化されて最下部追従 (Issue #1121)
- feat(pwa): **PWA 対応**（manifest + Service Worker + インストール可能化）。Web App Manifest（`manifest.ts`）、手書き vanilla Service Worker、インストール可能化を実装しホーム画面から standalone 起動可能に。custom server（`server.ts`）が WebSocket upgrade を保持するため next-pwa/Serwist/Workbox は不採用。キャッシュは allowlist 方式（/api・/login・/proxy・非 GET・クロスオリジン → network-only、/_next/static・/icons・manifest/favicon → cache-first、navigation → offline-fallback）で `cache-policy.ts` を単一情報源とし `public/sw.js` が同定数を鏡写し、`sw-file.test.ts` で同期を担保。install 時は skipWaiting せず更新検知でトースト表示→リロードで SKIP_WAITING。本番のみ SW 登録、オフラインフォールバック画面（/offline）、iOS standalone 用 appleWebApp メタを追加 (Issue #1124)
- feat(mobile): **ジェスチャー強化**（スワイプタブ切替・pull-to-refresh・キーボード追従）。`useSwipeGesture` に axis/方向ロック/エッジ開始制限/onSwipeMove を後方互換で追加。worktree 詳細のモバイルタブを水平スワイプで切替（方向ロックで縦スクロール中は無効化、しきい値 60px、ターミナルタブはエッジ開始領域に限定）。Sessions/Repositories に pull-to-refresh を新設（`usePullToRefresh` + `PullToRefresh`、最上部のみ発火し `overscroll-behavior:contain` + preventDefault でネイティブ PTR 二重発火を防止）。`MessageInput` を `useVirtualKeyboard` に接続、入力要素へ enterKeyHint/inputMode を付与。MobilePromptSheet のアドホックスワイプを `useSwipeGesture` へ統合 (Issue #1128)
- feat(pwa): **エージェント状態の Web Push 通知**（プロンプト待ち/完了）。`push_subscriptions` テーブル（migration v41）と CRUD モジュールを追加。VAPID/web-push 送信層は種別フィルタ・デバウンス・410 自動削除を備え、機密（endpoint/秘密鍵）は非ログ。プロンプト検出/セッション完了時に response-checker からファンアウト（検出ロジックは不変・fire-and-forget）。購読登録/解除/種別設定/VAPID 公開鍵の認証必須 API、Service Worker の push/notificationclick ハンドラ（該当 worktree へ deep link・既存窓フォーカス）、More 画面に通知設定 UI（権限要求・種別トグル・この端末の解除・iOS 未インストール案内）。ペイロードは最小限（worktree 名+種別+短い抜粋、ターミナル全文は送らない） (Issue #1125)
- feat(ui): **コックピット画面ポリッシュ**（Agent Instances 表示改善・ショートカットヘルプ）。Agent Instances カードの操作（並び替え・削除）を Radix DropdownMenu ケバブに集約しエイリアス入力を全幅化、基底ツール名に TruncationTooltip を適用。カード枠をヘッダーピルと同系のアクセント枠へ統一。キーボードショートカット一元レジストリ（`src/config/keyboard-shortcuts.ts`）を新設し、`?` キーでショートカット一覧オーバーレイを表示（typing/IME ガード付き、Escape で閉じる、スコープ別グルーピング）。コマンドパレットに「Keyboard shortcuts」アクションを追加 (Issue #1130)
- feat(terminal): **Claude/Codex の 1000 行ペインで表示専用に空行を圧縮**。Claude/Codex は 1000 行固定 pane のため上部 prompt と下部 task panel の間が大量の空行で埋まり Web UI で数百行の上スクロールが必要だった。rawOutput は一切変更せず（status/prompt 検出・Auto-Yes・保存・transport・line count は従来どおり）、表示専用に圧縮する `normalizeTerminalOutputForDisplay`（pure/idempotent、先頭/末尾の可視空行を除去・内部 1〜2 空行は保持・3 行以上の空行 run を ANSI sequence 保持のまま 1 行へ圧縮）を新設。ANSI primitive（stripAnsi/extractAnsiSequences）を依存ゼロの `src/lib/detection/ansi.ts` へ切り出し（client バンドルへ server 依存を持ち込まない）。`TerminalDisplay` に `compactTuiLayoutPadding` prop を追加し、cliToolId が claude/codex のときのみ有効化 (Issue #1172)
- feat(terminal): **PC 各ターミナル split にセッション終了ボタンを追加**。各 `TerminalSplitPane` のタイトルバー（Dropdown 直後・検索前）に、その split 自身のセッションだけを終了する「×」ボタンを追加。押下時に (cliToolId, instanceId, alias 優先ラベル) を `SessionKillTarget` として値スナップショットし、確認ダイアログ経由でその対象 instance のみを終了（active/focus 状態から終了対象を推測せず、非対象 split の terminal/prompt/history は不変）。controller の `showKillConfirm` boolean を `killTarget|null` + `isKillPending` に置換し、二重 POST 防止・404 自然終了レース処理・失敗時 Toast＋対象保持リトライを実装。kill-session route は `clearLastUserMessage` を `recomputeLastUserMessage` に置換 (Issue #1171)

### Changed
- refactor(ui): **worktree/共通の生 gray/button をトークン・プリミティブへ**（#1061 群 A 1/4、21 ファイル）。生 gray/slate Tailwind クラスを #1041/#1082 のセマンティックトークンへ用途判定で置換、生 `<button>` を `ui/Button` へ。挙動・ハンドラ・testid は不変。群 A 担当ファイルの raw gray = 0 (Issue #1061)
- refactor(ui): **worktree 詳細/markdown/file の生 gray/button をトークンへ**（#1061 群 B 2/4、21 ファイル）。WorktreeDetailSubComponents/MarkdownToolbar/FileTreeView 等を移行。ターミナル出力表示面（TerminalSplitPaneContent）はダーク維持のため意図的に非トークン化 (Issue #1061)
- refactor(ui): **worktree/mobile/git の生 gray/button をトークンへ**（#1061 群 C 3/4、22 ファイル）。挙動・testid 不変、群 C 担当ファイルの raw gray = 0 (Issue #1061)
- refactor(ui): **worktree/git/todo の生 gray/button をトークンへ**（#1061 群 D 4/4、21 ファイル）。ターミナル出力表示面（TerminalSplitContainer/TerminalContainer）は xterm と同様ダーク維持のため意図的に非トークン化 (Issue #1061)
- ci(guard): **token-discipline ガードを worktree/mobile/external-apps へ拡大**。#1061 でトークン化が完了したため #1082 で導入した CI ガードの対象ディレクトリを拡大。ターミナル出力表示面（`*Terminal*` ソース）は xterm 固定ダーク（#1079）と同様の意図的ダーク島のため除外、`app/worktrees` も引き続き除外 (Issue #1061)
- refactor(ui): **`window.confirm` を共通 ConfirmDialog へ全面置換**。`ConfirmDialog`/`ConfirmProvider`/`useConfirm` を `src/components/ui/ConfirmDialog.tsx` に新設（variant default/danger、Escape/背景クリックでキャンセル、danger 時は cancel に初期フォーカス、クローズ後に呼び出し元へフォーカス復帰）し `AppProviders` にマウント。`window.confirm` 残存 11 箇所 + bare confirm 1 箇所を `useConfirm` へ置換し、confirm 文言を next-intl 辞書へ移動（review namespace 新設）。ESLint `no-restricted-globals`(confirm/alert) と `no-restricted-properties`(window.confirm) を追加 (Issue #1113)
- refactor(ui): **チャット履歴 UI を ConversationPairCard 系デザインへ統一**。MessageList/PromptMessage の視覚言語を ConversationPairCard に統一（構造・optimistic update ロジックは維持、見た目のみ刷新）。生 chromatic 色 21 箇所をステータス tint トークンへ移行し `dark:` ペアを撤去、インライン SVG を lucide-react へ統一。ユーザー/アシスタントメッセージを CPC 言語のセクション（accent 左ボーダー/surface-2 wash）+ hover-reveal コピーツールバー（`[@media(hover:none)]:opacity-100` タッチフォールバック付き）へ刷新。markdown 描画を prose→assistant-md へ移行（ANSI/コードブロックの常時ダーク島は現状維持）。ファイルパスリンク/プロンプト応答/ログリンクの機能パリティを維持 (Issue #1117)
- refactor(ui): **生 chromatic 色を tint トークンへ全面移行し CI ガードを拡大**。意味ベースで移行（red→danger / green→success / yellow・amber・orange→warning / blue・sky・purple・violet→info）。`ui/Badge.tsx`・`config/status-colors.ts` をトークン化、`error/` の常時ダーク島 TerminalErrorFallback を `*Terminal*` 名の別ファイルへ分離。CI ガードの grep パターンに chromatic 9 色を追加し `error/`・`auth/` を対象化。chromatic grep 残数は 254 行（71 ファイル）→ 19 行（サンクション済み例外のみ）、in-scope は 0 (Issue #1116)
- perf(ui): **HistoryPane を @tanstack/react-virtual で仮想化し 250 件上限を撤廃**。可視領域+オーバースキャンのみをマウントするよう変更し、描画コストを O(可視行) 化。`useVirtualizer` + `measureElement`（可変高）で ConversationPairCard を仮想描画し、展開/折りたたみ等の高さ変化は自動再計測。スクロール位置は最下部閲覧中（`isNearBottom`）のみ新規ペアを追従（follow/maintain を分離）、検索ジャンプは `scrollToIndex` で materialize してからハイライト適用。展開状態はリスト側/親で保持しカードのアンマウントで飛ばないように。`HISTORY_DISPLAY_LIMIT_OPTIONS` に 500/1000 を追加（`MAX_MESSAGES_LIMIT`=1000、API 取得上限も 1000 へ）。1000 件 fixture で マウントカード数 1000→16 / DOM ノード数 26,001→449 / 初期描画 289ms→24ms (Issue #1123)
- chore(ui): **UI 死コードを削除**（WorktreeList・放棄 infinite-scroll hooks・hasNewOutput 配線）。`WorktreeList.tsx`（production import ゼロの孤児コンポーネント）と barrel export を削除、放棄された無限スクロール実装（useInfiniteMessages/useScrollObserver/useScrollRestoration）と対応テスト 3 本・孤児化する `types/infinite-messages.ts` を削除。`WorktreeDetailRefactored.tsx` の `hasNewOutput={false}` 死配線を撤去、`useWebSocket.ts` に `@deprecated` 注記を付与、`docs/architecture.md`（ja/en）の stale 参照行を削除 (Issue #1115)
- test: **integration スイートの drift を解消**（モック/期待値追随・CI 追加）。CI 非対象で長期 drift していた integration スイート（41 failed）を修復。実装バグを隠さないよう `vi.mock` を importOriginal 方式へ書き換え欠落 export を補完、config ドリフト（アップロード上限 5MB→20MB 等）の期待値を現行定数準拠へ。再 drift 防止に `ci-pr.yml` へ Integration Tests ジョブを追加。結果: `test:integration` 643 passed / 1 skipped（0 failed） (Issue #1102)

### Fixed
- fix(ui): **サイドバーがヘッダーに遮蔽される左上レイアウト破綻を修正**。`showGlobalNav` 時に固定サイドバーを `top-16 h-[calc(100vh-4rem)]` にオフセットし、半透明ヘッダー（z-50, backdrop-blur）がサイドバー先頭 64px（Branches 見出し+view/sort/sync ツールバー行）を遮蔽してクリック不能+灰色の滲みを生む問題を解消。あわせて `border-gray-200/dark:border-gray-600` を `border-border` にトークン化 (Issue #1070)
- fix(hooks): **`useIsMobile` を matchMedia ベースにし混成レイアウトバグを解消**。`window.innerWidth` 依存を `window.matchMedia('(max-width: ${breakpoint-1}px)')` に置換。innerWidth と CSS ビューポートが乖離する環境（実測 innerWidth=846 vs documentElement.clientWidth=390）では Tailwind の `md:`(min-width:768px) と JS 分岐が食い違い「CSS はモバイル・JS はデスクトップ」の混成レイアウトになっていた。change イベント購読+cleanup、SSR 初期値 false、`MOBILE_BREAKPOINT` export と breakpoint オプションは維持 (Issue #1069)
- fix(external-apps): **重複 name で 500 ではなく 409 を返す**。`route.ts` の catch を `message.includes('UNIQUE constraint')` の文字列判定から `ExternalAppDbError.code === 'DUPLICATE'` の型/コード判定へ変更し、DB 層のエラーラップ後もメッセージに依存せず 409 を正しく返す。#1102 で quarantine していた 409 duplicate name テストを un-skip (Issue #1104)
- fix(mobile): **`viewportFit:'cover'` を追加し iOS safe-area 対応を有効化**。iOS は `viewport-fit=cover` 指定時のみ `env(safe-area-inset-*)` に非 0 値を入れるため、既存の pt-safe/pb-safe 等の safe-area 対応が実効化されていなかった。`src/app/layout.tsx` の viewport エクスポートに `viewportFit: 'cover'` を追加し、GlobalMobileNav の未定義クラス `safe-area-bottom` を定義済みの `pb-safe` に修正 (Issue #1131)
- fix(ui): **未定義 `animate-fade-*` の定義と Modal/Toast/ContextMenu の exit アニメーション実装**。`usePromptAnimation` が発行していた `animate-fade-in/out` が未定義で no-op だったため `tailwind.config.js` にキーフレームを定義（duration/easing は #1050 モーショントークン準拠）、content globs に `src/hooks` を追加（フック発行クラスの purge 防止）。`useExitAnimation(open, duration)` を新設し閉要求後も duration ms だけマウントを維持して exit 再生を保証（render-phase 同期により開閉ともに 1 フレームの遅延なし）。Modal（fade+zoom-out 200ms、exit 中は backdrop クリック無効化）/ Toast（fade+slide-out 200ms 後に onClose 通知）/ ContextMenu（fade+zoom-out 100ms、exit 中は pointer-events-none）に適用。ConfirmProvider は pending クリア後の exit 再生中に内容がブランク表示されるドリフトを修正（直近 options を保持） (Issue #1114)
- fix(ui): **HistoryPane 仮想化のゼロ計測フォールバックで本文が消える問題を修正**。virtualizer がビューポート未計測でアイテム 0 件のとき（初回レンダー/SSR/jsdom 等のレイアウト 0 環境）、先頭 `HISTORY_FALLBACK_RENDER_COUNT` 件を通常フローで描画するフォールバックを追加。実ブラウザでは layout-effect の計測直後に仮想化リストへ切り替わるため本番の仮想化保証を損なわず、SSR のハイドレーション整合にも寄与する (Issue #1123)
- fix(realtime): **`useRealtimeConnection` 等の NUL バイト混入を除去**。room 購読キー生成で空白（0x20）が 2 箇所 NUL バイト（0x00）に化けており、git がバイナリ扱いし diff/レビュー不能になっていた。本来の `' '` 区切りへ復元（ロジックは不変）、`FileTreeView.tsx` のセンチネル `'\0unavailable'` からも NUL を除去 (Issue #1120)
- fix(mobile): **`useIsMobile` を描画前レイアウトエフェクトで解決し初回デスクトップ描画フリップを解消**。`useIsMobile` が SSR 安全のため初期値 false で始まり実際の検出を passive な `useEffect`（ペイント後実行）で行っていたため、モバイル実機のハードリロードで毎回デスクトップ UI が一瞬描画されてからモバイル UI へフリップしていた（AppShell の固定サイドバー / WorktreeDetail の分岐でのフラッシュ・CLS）。SSR/初回クライアントレンダリングは決定的に false を返し SSR HTML と一致させたまま（hydration mismatch 警告なし）、検出を isomorphic な `useLayoutEffect` で行い commit 後・ブラウザ描画前に flush することで補正後の値を最初のフレームへ反映。主ポーラーは分岐に依存しない単一の `useWorktreeDetailController` が一度だけ生成するため二重ポーリングは発生しない (Issue #1126)
- fix(mobile): **モバイル A11y 改善**（focus trap・44px タップターゲット・tablist キーボード）。focus trap を共通フック `useFocusTrap` に 1 実装集約し `ui/Modal`（role=dialog/aria-modal/aria-labelledby も付与）・MobilePromptSheet・MobileTerminalActionsSheet へ適用（初期フォーカス移動 / Tab・Shift+Tab の循環 / 閉時のフォーカス復帰。`autoFocus` 等で消費側が内部フォーカスを管理している場合は初期フォーカス奪取・復帰の両方をスキップし ConfirmDialog 互換を維持）。エージェントインスタンスタブ・History サブタブ・MobileTabBar のヒットエリアを 44px へ拡大（視覚サイズは不変）。MobileTabBar に ARIA tabs パターン（矢印キー＋Home/End・ラップアラウンド・roving tabindex）を実装。`touch-manipulation` を `ui/Button` とモバイル操作面へ付与、WorktreeCard のお気に入りトグルに `aria-label` を付与 (Issue #1127)
- fix(worktree): **同一ディレクトリのブランチ切替で履歴が CASCADE 削除される問題を修正**（データ損失）。worktree の ID がブランチ由来（`generateWorktreeId`）のため、同一ディレクトリで別ブランチに切り替えると ID が変化し、sync 時に旧行が「削除された」と誤判定され CASCADE で会話履歴・メモ・ToDo・タイマー・スケジュール・実行ログ・エージェントインスタンス・セッション状態が物理削除されていた。`syncWorktreesToDB` の prune 判定を「ブランチ由来 ID の不在」から「on-disk パスの不在」へ変更（`getWorktreesByRepository` を追加）し、真に削除された worktree のみ CASCADE 整理する。`upsertWorktree` は同一パス・別 ID の旧行を DELETE する代わりに、子テーブルの FK を張り替えて id を RENAME する `migrateWorktreeIdPreservingChildren` を導入（`PRAGMA defer_foreign_keys` でトランザクション内の FK 検査を COMMIT まで遅延させ、`ON UPDATE CASCADE` 無しでも親 PK と子 FK を原子的に更新。子テーブルはスキーマから動的に検出）。副次効果としてブランチ切替で tmux セッションが誤 kill されなくなる (Issue #1151)
- fix(detection): **Codex v0.141 のステータスバー陳腐化で処理中が ready 誤判定される問題を修正**。Codex CLI v0.141（gpt-5.5）がステータスバーから "N% left ·" トークンを削除したため `codexStatusBarPattern` がマッチせずフッター境界が -1 のままとなり、Codex 実行中検出ブロック（priority 2.7）全体がスキップされ生成中フレームが ready（静的緑ドット・グローなし）と誤判定されていた。`CODEX_STATUS_BAR_PATTERN`（`/^\s*\S.*·\s*~?\/\S*\s*$/`）を `cli-patterns.ts` に新設し旧バーと v0.141 バーの両方を「中黒 · + 末尾パス」構造で同定（`cliToolId==='codex'` ガードかつ末尾パス必須で誤検出防止）、重複インライン正規表現を共有定数へ置換。あわせてステータスバー非依存のフォールバック D 分岐（15 行フッター窓で Codex thinking マーカーを検出し running を返す）を追加 (Issue #1150)
- fix(worktree): **ヘッダーのインスタンス切替をターミナル split に配線（PC）**。ヘッダーのインスタンス切替ピルが `activeInstanceId` のみを更新し `useTerminalSplits` の `split.instanceId` に未配線だったため、claude を選んでも split が保持する claude-2 の表示・送信が続く配線バグを修正。DesktopHeader の選択をトークン付き `headerInstanceSelection` として primary split(0) に反映する経路（`setSplitInstance`）を追加し、トークンで 1 クリック 1 適用に限定して split0→active ミラー / ドラッグ&ドロップ / roster reconcile / localStorage 復元による変化と区別。衝突ポリシー（対象インスタンスが別 split に存在する場合はフォーカス移動、非破壊）を維持 (Issue #1152)
- fix(tmux): **セッションターゲットを `=` 厳密一致にしプレフィックス衝突インスタンスへの漏洩を防止**。複数エージェントインスタンス（primary と -2 等）でセッション名がプレフィックス衝突し（`mcbd-<cli>-<wt>` は `mcbd-<cli>-<wt>-2` のプレフィックス）、tmux の `-t <name>` は厳密一致が無いとプレフィックスマッチするため、primary 未起動時に primary への has-session/capture/send/kill が -2 に漏洩していた。全 `-t` 指定を `exactTarget(sessionName)` に集約（tmux.ts の has-session/set-option/send-keys/capture-pane/kill-session/special-keys、tmux-control-client.ts の control-mode attach-session、opencode.ts の resize-window） (Issue #1156)
- fix(tmux): **`exactTarget` を `=name:` にし pane ターゲット（capture-pane/send-keys）の解決失敗を修正**。#1156 の `exactTarget` が返す `=name` は session ターゲット（has-session/kill-session/set-option）では機能する一方、pane/window ターゲット（capture-pane/send-keys、opencode の resize-window）では tmux が「can't find pane: =name」を返して失敗し、全セッションの状態・出力が取得できず送信も効かない本番リグレッションが発生していた。`exactTarget` を `=name` → `=name:`（末尾コロン）に変更し、session/pane 両ターゲットで有効かつ厳密一致（#1156 の不変条件）を維持。#1156 のモックが `=name` を全コマンドで有効と甘くモデル化していたため CI をすり抜けており、モックの `resolveTarget` を実 tmux 忠実化して退行を検知できるようにした (Issue #1158)
- fix(detection): **codex の回答済み承認プロンプト陳腐化で waiting 固着する問題を修正**。codex は Claude と異なり回答済みの承認/番号プロンプトをトランスクリプト（historyLimit 50000）に残すため、`detectPrompt` の末尾 50 行窓が古いプロンプトにマッチし続け優先度 1 が `waiting` を返して優先度 2.7 の処理中検出に到達せず、ユーザーが回答して codex が処理を再開してもサイドバーのステータスドットがオレンジのまま固着していた。位置ベースのガード `isCodexStalePrompt()` を追加し、codex の検出プロンプトを「最下部のインタラクティブ要素であるときのみアクティブ」と扱う（プロンプトブロックより下に処理中インジケータ（• Working / • Ran）があれば古いプロンプトと判定し検出を無効化して優先度 2.7 へフォールスルー）。未回答の承認プロンプトは従来どおり `waiting` を返すため Auto-Yes に回帰なし (Issue #1160)
- fix(tmux): **TUI ペイン高さを window-size manual＋固定高さでピン留めし縮小を防止**。Claude Code 等の alt-screen TUI は表示行数=pane_height のため、tmux グローバルの `window-size latest` で小端末クライアントのアタッチ時にペインが縮み、capture-pane 由来のターミナル表示が数百行（≈72 行）に制限されていた。`createSession` で new-session 直後にセッション単位の `set-window-option window-size manual`＋`resize-window` を発行し固定の大きなペイン高さ（`TUI_PANE_HEIGHT=1000`）をピン留め（グローバル `window-size` には一切触れない）。新規 `src/config/tmux-pane-config.ts` に `TUI_PANE_HEIGHT`/`TUI_PANE_WIDTH` を定義し、デフォルトペイン高さを 200→1000 に引き上げ。window-size/resize の失敗はセッション作成を中断しない非致命扱い (Issue #1163)
- fix(slash): **Codex 選択時に `.agents/skills` のスキルをスラッシュ候補へ追加スキャン**。現行 Codex CLI が読む `.agents/skills`（`{worktree}/.agents/skills` と `~/.agents/skills`）を新規 `loadAgentsSkills` で走査し `source:'codex-skill'` / `cliTools:['codex']` を付与、`getSlashCommandGroups()` と slash-commands API route に配線。既存 `.codex/skills` は残置（後方互換）し `deduplicateByName` で name 重複排除 (Issue #1165)
- fix(mobile): **キーボード表示時に入力欄が上部へ飛ぶ問題を visualViewport 高さ追従で解消**。Android Chrome（および同モデルの iOS Safari）でメッセージ入力欄にフォーカスすると composer がキーボード直上ではなく画面上部へ大きく浮き上がって離脱していた。根本原因は「`position:fixed` の入力バーを JS の translateY で持ち上げる」設計の基準ズレ（fixed の基準は縮まないレイアウトビューポート下端＝キーボードの裏）。fixed+translateY ハックを撤去し、モバイルシェルの高さを `visualViewport.height` に追従させ composer とタブバーを通常フロー最下段の `flex-shrink-0` 子として配置（FullScreenModal の実績パターンを横展開）。`useVirtualKeyboard` に `viewportHeight` を追加、MobileTabBar は inFlow で static レンダリングへ切替 (Issue #1166)
- fix(terminal): **1000 行ペインのプロンプト処理を安定化**。1000 行固定の tmux ペインで Claude の選択プロンプトと下部タスク表示の間に大量の空行が入り、プロンプト検出・Auto-Yes・画面更新が不安定になる問題を修正。原因は①検出処理が表示用の生出力を狭い tail 範囲で評価し上方に残った Claude プロンプトを取りこぼしていた、②下部のタスクパネルや古いフッターが現在の対話状態として誤認されていた、③既存 tmux セッションのウィンドウサイズが再利用時に調整されなかった、④応答・特殊キー操作後に最新スナップショットが即時配信されず WebSocket push 停止時も HTTP ポーリングの復帰が遅かった。1000 行 TUI 出力を対象に表示内容を変更しない検出専用フレーム正規化を追加し、Auto-Yes のキャプチャ範囲を 1000 行へ拡張、既存 tmux セッション再利用時にウィンドウ単位で geometry を調整、応答・特殊キー・Auto-Yes の成功後に端末スナップショットを即時配信（短時間の限定再試行付き）、WebSocket push の watchdog と HTTP ポーリング復帰・未分類状態のヒステリシスを追加。あわせて脱出キー表示を Claude では Esc のみ・Codex では Esc/q に是正 (Issue #1167)

## [0.8.4] - 2026-07-10

> **Highlight**: worktree（ブランチ）単位の **ToDo リスト（#1015）を大幅強化**（まとめて #1038）。①完了/未完了の 2 値から **未着手 / 仕掛 / 完了の 3 状態**へ拡張（`status` カラム、migration v38、#1032）、②各項目に **詳細フィールド**を追加し**項目クリックで件名・詳細を編集**できるモーダルを新設（`detail` カラム、migration v39、#1034）、③編集モーダルの**詳細本文にコピーボタン**を追加（#1036）。DB マイグレーションは v37→v39、`CURRENT_SCHEMA_VERSION` を 37→39 に更新。

### Added
- feat(todo): worktree（ブランチ）単位 ToDo を **完了/未完了の 2 値から未着手（todo）/ 仕掛（doing）/ 完了（done）の 3 状態**へ拡張。`worktree_todos` に `status` カラムを追加（migration v38、`done=1`→`'done'` へ backfill、`CURRENT_SCHEMA_VERSION` 37→38）し、DB 層は `status` を真実源に `done := status==='done'` を派生（後方互換維持、writer 整合）。API/クライアントは PATCH で `status ∈ {todo, doing, done}` を検証・適用（`done` 後方互換）。UI は 3 状態を巡回するチップ＋色バッジ＋状態別件数を追加し、`TodoPane` 全体を next-intl 化、`locales/{en,ja}/worktree.json` に `todo` namespace を追加。テストは既存 5 件更新＋ migration-v38（backfill 検証）を新規追加 (Issue #1032)
- feat(todo): worktree 単位 ToDo に **詳細フィールドを追加し、項目クリックで件名・詳細を編集**できるモーダルを新設。`worktree_todos` に `detail` カラム（`TEXT NOT NULL DEFAULT ''`、既存行は空詳細で移行）を追加（migration v39）し、`WorktreeTodo` に `detail` を追加して create/update で受理、API の POST/PATCH で `detail` を検証・適用（`MAX_TODO_DETAIL_LENGTH` 新設）。UI は項目クリックで編集モーダル（`Modal.tsx` 再利用）を開き件名＋詳細を編集でき、詳細ありインジケータを表示。`locales/{en,ja}/worktree.json` に詳細/編集の文言を追加。テストは既存 6 件更新＋ migration-v39 を新規追加、`docs/module-reference.md` を更新 (Issue #1034)
- feat(todo): worktree 単位 ToDo の**編集モーダルの詳細欄にコピーボタン**を追加し、詳細本文をクリップボードへコピー可能に（詳細が空のときは非表示）。既存の `src/components/common/CopyButton.tsx` / `clipboard-utils.ts` を再利用（スマホ HTTP 環境は `execCommand` フォールバック）、`locales/{en,ja}/worktree.json` に `todo.copyDetail` を追加。`TodoPane.test.tsx` にコピー導線テスト 3 件を追加（migration/DB/API 変更なし、UI のみ） (Issue #1036)

## [0.8.3] - 2026-07-09

> **Highlight**: **Timer 機能（#534）から送った指示が History（`chat_messages`）に残らない**不具合を修正（#1028 / #1030）。原因は `executeTimer` が `cliTool.sendMessage` だけを呼び、`createMessage` / `startPolling` をスキップしていたこと（#947 の委譲変更が起点）。send route L262-385 のインライン記録ロジックを HTTP 層非依存の共通関数 `sendUserMessage()`（`src/lib/session/send-user-message.ts`）として抽出し、send route POST と `timer-manager.executeTimer` の双方から共有することで、Timer 送信でも user メッセージと assistant 応答の両方が History に記録されるようにした。

### Fixed
- fix(session): **Timer 発火の送信を History に記録**（send ロジックを共有サービス化）。`executeTimer` が `cliTool.sendMessage` のみを呼び `createMessage` / `startPolling` をスキップしていたため Timer からの指示が `chat_messages` に残らなかった問題を修正（#947 の委譲変更が起点）。send route L262-385 のインライン記録ロジックを `src/lib/session/send-user-message.ts` の共通関数 `sendUserMessage()`（`savePendingAssistantResponse` → send（画像/Copilot 分岐含む）→ `createMessage` → `updateLastUserMessage`/orphan 処理 → `startPolling`）として抽出（HTTP 層非依存）。send route POST を `sendUserMessage()` 利用へリファクタ（挙動不変）し、`timer-manager.executeTimer` を `sendUserMessage()` 経由に変更（`timer_messages` の status 遷移 sending/sent/failed は維持）。これにより Timer 送信も user メッセージと assistant 応答の両方が History に残る。テスト新規 9 件（`sendUserMessage` / `executeTimer`）＋ timer 既存更新（計 26 件） (Issue #1028)

## [0.8.2] - 2026-07-06

> **Highlight**: スマホ版のファイルビューア（`FileViewer`）から**任意種別のファイルをダウンロード可能**にした（#1024 / #1026）。サーバ側は `files/[...path]` GET に download 分岐を追加し、生バイトを `Content-Type: application/octet-stream` ＋ `Content-Disposition: attachment` で返却（base64 JSON を経由しないためプレビュー上限を超える大容量にも対応）。filename は新設の content-disposition ヘルパーで RFC 準拠にサニタイズし、UI 側は FileViewer ツールバーにダウンロードボタンを追加した。

### Added
- feat(files): スマホ版のファイルビューア（`FileViewer`、#438 でモバイル専用化）から**任意種別のファイルをダウンロード可能**に。サーバ側は `src/app/api/worktrees/[id]/files/[...path]` GET に download 分岐を追加し、生バイトを `Content-Type: application/octet-stream` ＋ `Content-Disposition: attachment` で返却（既存 `getWorktreeAndValidatePath` でパス検証を再利用、base64 JSON を経由しないためプレビュー上限を超える大容量にも対応）。filename は新設の `src/lib/http/content-disposition` ヘルパーで RFC 準拠にサニタイズ（ASCII フォールバック ＋ `filename*=UTF-8''` パーセントエンコード、ヘッダインジェクション回避）。UI 側は `FileViewer` ツールバーにダウンロードボタンを追加し同一オリジンの download URL へ遷移（iOS Safari 含めネイティブ DL に対応）。テスト 29 本を新規追加（download API のヘッダ/パス検証/filename、content-disposition ヘルパー、FileViewer ボタン） (Issue #1024, #1026)

## [0.8.1] - 2026-07-05

> **Highlight**: worktree（ブランチ）単位の **ToDo リスト**を新設（PC=アクティビティバー / スマホ=Tools、PC/スマホ共通 `TodoPane`、`worktree_todos` テーブル + migration v37、#1015）。あわせて Codex の**ページャ/選択リスト状態で選択ウィンドウ（NavigationButtons）が表示されない不具合**を修正し、ページャキー（PgUp/PgDn/Home/End/q）と検出非依存の脱出ハッチ `TerminalEscapeHatch`（Esc/q）を追加（#1017）、**History パネルのヘッダー（Message History）を固定**してスクロールをヘッダーの下に限定した（#1019）。

### Added
- feat(worktree): worktree（ブランチ）単位の **ToDo リスト**を追加。PC 版はアクティビティバー、スマホ版は Tools（NotesAndLogsPane）から利用でき、PC/スマホ共通の `TodoPane` を共有。`worktree_todos` テーブル（migration v37、`worktree_id` FK・ON DELETE CASCADE）＋ `worktree-todo-db`（CRUD）、`/api/worktrees/[id]/todos`（GET/POST・PATCH/DELETE）、クライアント `todo-api`、i18n `todoTab`（en/ja パリティ）を追加。既存のリポジトリ単位 ToDo（`repository_todos`）とは独立して併存 (Issue #1015)

### Fixed
- fix(terminal): Codex が**ページャ/edit-previous モード**のとき選択ウィンドウ（NavigationButtons）が表示されず、読み取り専用ターミナルから操作・脱出できない問題を修正（複数インスタンス codex-2/codex-3 で顕在化）。`CODEX_PAGER_FOOTER_PATTERN` とステータスバー非依存のページャ検出分岐（`STATUS_REASON.CODEX_PAGER`、`/model` 等の "press enter to confirm/select" には非マッチでリグレッションなし）を追加し、NavigationButtons にページャキー（PgUp/PgDn/Home/End/q・PC分割＋モバイル）、共有 `useSpecialKeys` フックと検出非依存の脱出ハッチ `TerminalEscapeHatch`（Esc/q、未分類 interactive 状態のみ表示）を新設 (Issue #1017)
- fix(history): History パネルの「Message History」ヘッダーがスクロールコンテナ内で `sticky` だったため、メッセージがヘッダーの背後を通過する違和感を修正。固定ヘッダー行 ＋ 独立スクロール領域のレイアウトに変更（ヘッダー/検索バーを `flex-shrink-0`、メッセージを内側 `overflow-y-auto` へ、`scrollContainerRef` を内側 div へ移設、未使用の `STICKY_HEADER_HEIGHT` を撤去）。PC（`TerminalSplitPaneContent`）/モバイル（`WorktreeDetailMobile`）共用のため両方で検証 (Issue #1019)

## [0.8.0] - 2026-07-03

> **Highlight**: 新エージェント **Antigravity（agy）CLI 対応**が中心。inline TUI として `agy` を選択可能なエージェントに登録（Phase A #988）し、Auto-Yes（`--dangerously-skip-permissions`）／`--model` 起動フラグ（Phase B #989）、Assistant Chat・Schedule・日次レポート等すべての非インタラクティブ実行経路（`agy -p`、Phase C #990）まで一貫対応した。あわせて選択 TUI／権限承認メニューのステータス検出と Auto-Yes 応答の不具合を修正（#995 / #997 / #999）。CLI 側では **1 エージェント複数セッションの管理**（`instances` サブコマンド＋`send --instance --register`、#1000）、`ls --branch` を実ブランチ名で絞り込む修正（#1003）と `ls --id <prefix>` フィルタ（#1005）を追加。UI では **PC 版マークダウンビューワーおよび worktree 詳細インラインプレビューにサイド TOC（目次）** を追加した（#1007 / #1009）。

### Added
- feat(agent): 新エージェント **Antigravity（agy, v1.0.14）CLI を選択可能なエージェントとして登録**（Phase A / MVP）。`agy` は scrollback を保持する inline TUI（Codex 型、alternate-screen アプリではない）のため inline セッションモデルを再利用: `agy` 起動、初回の "Do you trust the contents of this project?" ダイアログを Enter で自動確定、"? for shortcuts" idle フッター検出後に送信、sendMessage/killSession で capture キャッシュを無効化。`CLI_TOOL_IDS` に `antigravity` と表示名 `Antigravity` を追加し `AntigravityTool` を登録、`ANTIGRAVITY_*` 検出パターンと inline ステータスブロックを追加（running はステータスバーの "esc to cancel" / "Generating" / braille スピナーで検出し常時表示の素の "> " 入力欄より優先、idle "> " は ready）。検出パターンは実 `agy` バイナリで確認済み (Issue #988)
- feat(agent): Antigravity（agy）に **Auto-Yes（`--dangerously-skip-permissions`）と `--model` サポート**を追加し他エージェントと機能同等に（Phase B）。`agy` はセッション内 `/model` コマンドを持たないため `--model` は起動フラグとして実装、モデル名に空白/括弧を含むため Copilot と別の専用検証パターン（新規 `antigravity-constants.ts` + `validateAntigravityModelName`）を導入。CMATE.md Schedule 機能の権限ハンドリング（schedule-config/cmate-parser/cmate-validator）、send.ts / send API の `--model` 受理（起動済みセッションのモデル変更は拒否）、`MAX_SELECTED_AGENTS` を 5→6 に拡大し `DEFAULT_SELECTED_AGENTS` に antigravity を追加、send/respond/capture/auto-yes の CLI ヘルプ更新を含む (Issue #989)
- feat(agent): Antigravity（`agy -p`）を **claude/codex と同様にすべての非インタラクティブ実行経路へ統合**（Phase C）。Assistant Chat（`ASSISTANT_ALLOWED_TOOLS` / `NON_INTERACTIVE_TOOLS` に追加、`non-interactive-runner` の `-p --dangerously-skip-permissions`＋prompt を stdin、`parseAntigravityPlainOutput` で agy -p のクリーンなプレーンテキストを ANSI 除去+trim）、Schedule / 日次レポート（`claude-executor` / `report.ts` の `ALLOWED_TOOLS` / `review-config` の `SUMMARY_ALLOWED_TOOLS`）、標準コマンド・ログ表示（`standard-commands` / logs route / `LogViewer` のフィルタ）に antigravity を追加 (Issue #990)
- feat(cli): **1 エージェント複数セッションの CLI 管理・ドキュメント整備**。`commandmate instances` サブコマンドで roster + 稼働状況を一覧・add/remove/alias/kill 操作可能にし、`send --instance <id> --register` でアドホックセッションを roster に自動登録。`ApiClient` に PATCH サポートを追加し `agentInstances` を型定義（`ls --json` 含む）、埋め込み docs/user-guide にマルチセッション節と `--instance` の ID 規約例を追記 (Issue #1000)
- feat(cli): 同一ブランチ名（develop 等）が複数リポジトリに存在する環境向けに **`ls --id <prefix>` で worktree ID の前方一致フィルタ**を追加。既存の `--branch` フィルタと独立した AND 条件として適用でき、特定リポジトリの worktree を一意に絞り込める (Issue #1005)
- feat(ui): 独立ファイルビューワーページ（`/worktrees/[id]/files/[...path]`）のマークダウン表示に **PC 幅限定のサイド TOC（目次）** を追加。`rehype-slug@^6` / `github-slugger@^2` を導入して見出しに id を付与し、純粋関数 `extractToc`（`src/lib/markdown-toc.ts`、ATX 見出しを抽出し rehype-slug と完全一致する id を生成、コードブロック除外・重複 suffix 対応、setext 非対応）と `MarkdownToc` コンポーネント（depth インデント・クリックでスムーズスクロール・IntersectionObserver によるスクロールスパイ）を新設。sticky サイドバー / 見出しへの scroll-margin-top / トグルボタン（`aria-pressed`、lg 未満は非表示）/ localStorage 永続化（`commandmate:md-toc-visible`）/ 見出し 0〜1 件は自動非表示、i18n `worktree.toc.*`（en/ja パリティ）を追加 (Issue #1007)
- feat(ui): **worktree 詳細ページのインライン Markdown プレビューにもサイド TOC** を追加。`MarkdownPreview` が `rehype-slug` を `rehype-sanitize` 後段で適用して見出しにプレーンな id を付与、`MarkdownToc` に `root` prop を追加してプレビューペイン内のスクロールコンテナ基準でスクロールスパイ、`MarkdownEditor` のプレビューペインに `ResizeObserver` でコンテナ幅を判定する TOC サイドバー＋トグルを追加。表示状態は #1007 と同じ localStorage キー（`commandmate:md-toc-visible`）で共有 (Issue #1009)

### Fixed
- fix(detection): agy の "Switch Model" 等の**選択 TUI が running/thinking と誤検出され NavigationButtons が表示されず ↑↓/Enter でのモデル選択が不能**だった問題を修正。選択画面の "esc to cancel" フッターを `ANTIGRAVITY_THINKING_PATTERN` が拾っていたため、`ANTIGRAVITY_SELECTION_LIST_PATTERN`（Switch Model ヘッダ / ↑↓ Navigate + enter Select）と `STATUS_REASON.ANTIGRAVITY_SELECTION_LIST` を追加し、status-detector で汎用 thinking 検出より前の優先度 0.9 で `waiting` を返す（Copilot 0 / Codex 0.8 と同様の early-detection 順序） (Issue #995)
- fix(detection): agy の**権限承認メニュー（"Do you want to proceed?"）を選択 TUI として検出できるよう `ANTIGRAVITY_SELECTION_LIST_PATTERN` を緩和**。権限メニューのフッターは "↑/↓ Navigate · tab Amend · …"（"enter Select" なし）で #995 のパターンが取りこぼしていたため、"↑/↓ Navigate" フッター単独で成立するよう変更（`.*enter Select` 除去で ReDoS 的にもより安全化）。Switch Model・権限承認メニュー・将来の agy 選択 TUI を `cliToolId === 'antigravity'` ガードで agy 限定のまま網羅 (Issue #997)
- fix(auto-yes): **Auto-Yes が agy の権限承認メニュー（"Do you want to proceed?"）に応答しない**問題（poller は動くが送信ゼロ）を修正。①検出: `buildDetectPromptOptions('antigravity')` が `requireDefaultIndicator=true` で undefined を返し Pass 1 gate がメニューを弾いていた（agy は既定を ASCII ">" で強調、フッターに "press enter to confirm" なし）ため `{ requireDefaultIndicator: false }` を返し（claude/opencode/copilot と同様）Pass 2 で選択肢を収集。②送信: `sendPromptAnswer` のカーソルキー操作が `cliToolId === 'claude'` に限定されていたため antigravity へ拡張（agy は矢印キー TUI で番号入力を無視、"Yes"=option 1 → offset 0 → 素の Enter で確定） (Issue #999)
- fix(cli): **`ls --branch` を実ブランチ名で絞り込む**よう修正（方針 A）。`worktrees` テーブルに `branch` カラムを追加（v36 マイグレーション、`CURRENT_SCHEMA_VERSION` 35→36）し sync 時に実ブランチ名を保存・API/型で伝播、`ls --branch` フィルタを `name` 直接参照から `(wt.branch ?? wt.name)` の前方一致へ変更（後方互換）。`Worktree` / `WorktreeItem` 型に `branch?` を追加、書込み（`scanWorktrees` / `upsertWorktree`、ON CONFLICT は COALESCE で非 sync writer の上書きを防止）・読み取り（`getWorktrees` / `getWorktreeById` の SELECT・マッピング）両パスに配線 (Issue #1003)
- fix(ui): worktree 詳細ページの**インライン Markdown プレビューで TOC が常に自動非表示になる**問題を修正。詳細ページの既定レイアウトではプレビューペインが約 551px 幅となり従来の TOC 表示しきい値 640px を下回っていたため、`TOC_SIDEBAR_MIN_WIDTH_PX` を 640→480 に下げ、TOC サイドバー幅を `w-56`(224px)→`w-48`(192px) に縮小して本文の可読幅を確保（全画面化せずとも目次を表示可能に） (Issue #1009)

## [0.7.5] - 2026-06-30

> **Highlight**: worktree 詳細画面の UI 改善が中心。Files ツリーにメタデータ列（size / created / modified）のトグル表示を追加（#969）し、ファイル行のメタデータと名前のツールチップを単一バブルに統合（#975）。マークダウンファイルプレビューのコードブロックにコピーボタンを追加（#981、inline code への誤付与を #983 で修正）。あわせて PaneResizer の仕切りを VS Code 風の控えめな 1px 細線化（#970）、PC ターミナルヘッダーのアクションバーボタンを左寄せ + 順序統一（#977）、サイドバーの横スクロールバーを truncate + hover ツールチップで除去（#971）し、狭幅時にヘッダーボタンを折り返して ActivityBar との重なりを解消（#976）した。

### Added
- feat(files): Files ツリーの各行に常時インライン表示されていた **size / created（birthtime）/ modified（mtime）のメタデータ列を個別にトグル表示**できるよう変更（既定は VS Code 流に size のみインライン、タイムスタンプは hover）。`readDirectory` が `mtime` を返すよう拡張し `TreeItem` に `mtime?` を追加（`ctime` は意図的に非採用）、新規 `useFileMetadataDisplay`（localStorage + CustomEvent でタブ間同期）、ツールバーに 3 チェックボックスのギアポップオーバー `FileMetadataToggle`、`TreeNode` が列を条件描画しつつ `formatMessageTimestamp` / `formatFileSize` でロケール対応の複数行 title ツールチップを構築。i18n `worktree.fileTree.metadata`（en/ja パリティ）を追加 (Issue #969)
- feat(markdown): マークダウンファイルプレビュー（PC / mobile 両レンダーパス）の **非 mermaid コードブロックにコピーボタンを追加**。`CopyButton` を `src/components/common/CopyButton.tsx` へ抽出して `AssistantMessageList`（挙動不変）と新規ラッパで共有、`CodeBlockWithCopy` が code/pre を relative group で包んで `CopyButton` をオーバーレイし `rehype-highlight` の React ツリーから再帰的にプレーンテキストを抽出してコピー。md+ では hover 表示・タッチ幅では常時表示、React レンダラ経由で付与し `rehype-sanitize` に落とされないようにした（mermaid 図 / inline code は不変） (Issue #981)

### Changed
- feat(ui): worktree 詳細画面の 4 つのドラッグ可能な仕切り（`PaneResizer`）を**太く濃い線から VS Code 風の控えめな 1px 細線**に変更。線色を `bg-gray-700` から `bg-gray-200 dark:bg-gray-700`（固定パネル枠線と同色）へ、hover 時の線幅拡大（`hover:w-2` / `hover:h-2`）を撤去して常時 1px を維持し hover/focus 時のみ accent 色（cyan-500）を表示。`darkMode: 'class'` で base の `dark:bg-gray-700` が specificity で勝つため `dark:hover:bg-cyan-500` とドラッグ時の `dark:bg-cyan-500` を明示、透明な `::before` 疑似要素でクリック判定を ±4px に拡張（見た目 1px でも掴みやすさ維持）、focus ring offset をテーマ対応化、ドラッグ中のみ線幅拡大 + accent をライブフィードバックとして維持 (Issue #970)
- feat(files): ファイル行の**2 つの独立ツールチップ（#969 のメタデータ native `title` と #859 の名前 `TruncationTooltip`）を単一のスタイル付きバブルに統合**。従来は遅延（native 約 0.5〜1s vs custom 200ms）とスタイルが異なっていた。`TruncationTooltip` に optional `metadata` prop を追加し「名前が省略表示 OR メタデータあり」のとき hover で名前 + メタデータ（複数行）を 1 つの portal バブルに描画、`TreeNode` は native `title` を撤去して整形済み size/created/modified を `metadata` で渡す（インライン列のトグル状態に関わらず hover で全項目を参照可能＝#969 の意図を保持）。サイドバー利用箇所は optional/additive のため無影響 (Issue #975)
- feat(terminal): PC ターミナルヘッダーのアクションバーボタンを**左寄せ + +Split → -Split → Equal widths → History → Files の順に統一**。+Split の `ml-auto`（バーを左右グループに分割していた）を撤去し JSX を並べ替えて全ボタンを左→右に整列。PC 専用（`TerminalSplitContainer` は `WorktreeDetailDesktop` のみで描画）でモバイル経路は無影響、ボタンの挙動・有効/無効条件・aria 状態は不変。順序検証の単体テストを追加 (Issue #977)

### Fixed
- fix(sidebar): 長いリポジトリ名がグループヘッダーをはみ出して生じる**サイドバーの横スクロールバーを除去**。グループヘッダーを `min-w-0` flex コンテナ化して既存の `truncate` を効かせ、リポジトリ名を `TruncationTooltip` で包んで省略時のみ hover でフルネーム表示（`BranchListItem` と同様）、ブランチリストに `overflow-x-hidden` を safeguard として追加、DnD sortable ラッパを `w-full min-w-0` で制約してドラッグ中の overflow を防止 (Issue #971)
- fix(sidebar): サイドバーを狭めた際に**ヘッダーの見出し + アクションボタン群（ViewModeToggle / SortSelector / SyncButton / Repositories）が横方向にあふれ隣接 ActivityBar と重なる**問題を修正。ヘッダー行が `flex-nowrap` + 既定 `overflow:visible` だったため、ヘッダー行に `flex-wrap` + `gap-y-2` を付与してボタン群を入りきらない時に改行、ボタン群自体にも `flex-wrap`、Branches 見出しに `min-w-0 truncate` を付与して縮小させた（下方向に開く Sort ドロップダウンが切れるため overflow clip は不使用） (Issue #976)
- fix(markdown): react-markdown v10 が `code` コンポーネントに `inline` prop を渡さなくなったため `MermaidCodeBlock` の inline 判定が常に undefined となり、**全ての inline code に誤ってコピーボタンが付き `as="span"` のブロッククラスで単独行に押し出される**問題（#981 で混入）を修正。コピーボタンの付与を `MarkdownPreview` の `pre` レンダラ（fenced/indented コードブロックでのみ発火、inline code では決して発火しない）へ移して誤検出を構造的に不可能化、mermaid ブロックはプレーン `<pre>`（ボタンなし）で不変、ファイルビューアページの壊れた `inline` 判定もクラスベース検出へ置換。inline code はボタンなし/改行なし、fenced ブロックは言語有無を問わずボタンが機能、mermaid 図はボタンなしを固定する回帰テストを追加 (Issue #983)

## [0.7.4] - 2026-06-25

> **Highlight**: モバイル Agent タブヘッダーの操作性改善が中心。タブを横スクロール可能化（#958）したうえで横スクロールバーを非表示化（#964）、ステータスを CLI ツール単位ではなくインスタンス単位で解決（#960）、kill-session 確認ダイアログにインスタンスのエイリアスを表示（#956）。あわせて Auto-Yes をカウントダウン 0 到達の正確なタイミングで無効化（#959）し、サイドバークリック→詳細表示の体感遅延を低減する perf クイックウィン 4 件（#965）を追加した。

### Fixed
- fix(worktree): モバイルヘッダーの Agent インスタンスタブを**横スクロール可能**に。Auto Yes トグルを左、検索 + End（kill session）ボタンを右にピン留めし、中央のタブ領域を `flex-1 min-w-0 overflow-x-auto` 化。従来は 3 つ以上のエージェントでタブと End ボタンが画面外に押し出されスクロール不能だった (Issue #958)
- fix(worktree): モバイル Agent タブヘッダーの**横スクロールバーを非表示**に（スワイプ/スクロールは維持）。新規 `.scrollbar-hide` ユーティリティを追加し当該 nav にのみ適用、表示領域の圧迫を解消（`.scrollbar-thin` は他 3 箇所で使用中のため不変） (Issue #964)
- fix(worktree): モバイル Agent タブの**ステータスを CLI ツール単位ではなくインスタンス単位で解決**。エイリアスインスタンスごとに正しい稼働ステータスがサイドバー/タブに反映されるよう修正 (Issue #960)
- fix(worktree): セッションクローズ確認ダイアログ（ヘッダー「✕ End」）のタイトルが CLI ツール名（Claude/Codex）を表示していた問題を修正。新規 `getActiveInstanceLabel()` で**インスタンスのエイリアスを優先表示**（未設定/stale 時は CLI 表示名へフォールバック＝後方互換） (Issue #956)
- fix(auto-yes): カウントダウンが 00:00 に到達した**正確なタイミングで Auto-Yes を無効化**。期限判定を `>` から `>=` に変更し、UI も次のサーバーポーリングを待たず即座に OFF 反映（`onExpire` コールバック追加、呼び出し側は無改修） (Issue #959)

### Performance
- perf(worktree): **サイドバークリック→worktree 詳細表示の体感遅延を低減**するクイックウィン 4 件。①一覧キャッシュから詳細を楽観的に即描画し `getById` はバックグラウンド反映（stale-while-revalidate、キャッシュミス時のみローディング）②ステータス検出用キャプチャ行数を表示用（10000）と分離し 1000 に削減（末尾空行トリム前提で #604 退行なし）③`/api/worktrees/[id]` で git status を listSessions と並走 ④tmux キャプチャキャッシュ TTL を 3000→5000ms に延長 (Issue #965)

## [0.7.3] - 2026-06-23

> **Highlight**: Timer / メモ / サイドバー周りの UX 改善が中心。Timer と Schedule を AgentInstance システム（#869）に追従させ登録済みインスタンスを選択可能に（#942）、Timer 入力を Schedule と同様の「+ Create Timer」ボタン + モーダル化（#945）、Activity Bar の Notes に並び替えを追加（#944）、サイドバーヘッダーのアクションアイコンを拡大（#946）。あわせて codex で Timer 送信が確定しない不具合を sendMessage 委譲で修正（#947）し、自動生成物（dev-reports 等）を untrack してリポジトリを軽量化（#953）した。

### Added
- feat(timer): **Timer と Schedule で登録済みエージェントインスタンスを選択可能**に。Timer（#534）/ Schedule（#824-827）は AgentInstance システム（#869）以前の実装で、エージェントセレクタが静的な `CLI_TOOL_IDS` に束縛され Agents パネルで登録したインスタンスを指定できなかった。**Timer はフルインスタンス対応**: migration v35 で nullable な `timer_messages.instance_id` 列を追加（`cli_tool_id` ＝ primary instance anchor で backfill）、`timer-db` / timers API が instanceId を通し（登録済みインスタンス + primary anchor に対して検証）、`timer-manager` が `isRunning` / `getSessionName(worktreeId, instanceId)` で当該インスタンスの tmux セッションへ実行をルーティング。`TimerPane` はセレクタを登録済みインスタンス（alias ラベル）から駆動し選択インスタンスを記録/表示（未登録時は全 CLI ツールの primary インスタンスへフォールバックし legacy 挙動を byte-for-byte 維持）。**Schedule は UI ラベルのみ**: `ScheduleEditDialog` がインスタンス alias を列挙しつつ永続化/実行は選択インスタンスの backing CLI ツール基準（Schedule は新規 `claude -p` プロセスを起動するため per-instance ルーティングは無意味、CMATE.md スキーマ変更なし）。`instances` を `WorktreeDetailDesktop`（PC）/ `NotesAndLogsPane`（mobile）経由で `TimerPane` / `ExecutionLogPane` / `ScheduleEditDialog` へ配線 (Issue #942)
- feat(timer): Timer 入力を常時表示のインラインフォームから **「+ Create Timer」空状態 CTA / 「+ New Timer」ボタン + モーダルダイアログ**化（PC=Modal、mobile=FullScreenModal）し Schedule UX に揃えた。`formatDelayLabel` を `timers/timer-format.ts` へ抽出しペインとダイアログで共有。一覧/ポーリング/キャンセル/履歴クリア/さらに読み込みは維持し public props も不変のため呼び出し側（`WorktreeDetailDesktop` / `NotesAndLogsPane`）は無改修 (Issue #945)
- feat(memo): **Activity Bar の Notes（メモ）に ↑↓ 並び替えボタンを追加**。`PATCH /api/worktrees/[id]/memos` が position の再採番を検証付きで実行（新規 `src/lib/memo-reorder-validator.ts` が件数/重複/未知 ID を pure に検証）、`memoApi.reorder()` クライアントメソッド、`MemoCard` の ↑↓ 移動ボタン（両端で disabled、後方互換 props）、`MemoPane` の `handleMove`（楽観更新 + ロールバック、検索中は無効化）、i18n `memoMoveUp` / `memoMoveDown`（en/ja）を追加 (Issue #944)
- feat(sidebar): サイドバーヘッダー上段の **アクションアイコン（view-mode toggle / sort / sort-direction / sync / Repositories リンク）を視認性向上のため 12px → 16px に拡大**。共有 `HEADER_ICON_CLASS`（`w-4 h-4`）を導入し 5 つのアイコンへ適用。`SortSelectorBase` に optional `iconClassName` prop（既定 `w-3 h-3`）を追加し Sessions ページなど他の利用箇所は従来サイズを維持 (Issue #946)

### Fixed
- fix(timer): Timer 発火時に **メッセージが入力欄に残ったまま送信されない**不具合（特に codex）を修正。発火処理が tmux に直接 `sendKeys(text+Enter 一括)` を投入していたため、codex の TUI がテキスト確定前に Enter を受け取っていた。恒久対策として `executeTimer` の送信を `cliTool.sendMessage(worktreeId, message, instanceId)` に委譲し、手動送信と完全に同じコードパス（CLI ツールごとのテキスト/Enter 分離・待機）を通して claude / codex / gemini すべてで Enter 確定を保証。セッション名は `sendMessage` 内で `(worktreeId, instanceId)` から解決されるため `timer-manager` 側の `getSessionName` / 直 `sendKeys` 呼び出しを削除 (Issue #947)

### Chore
- chore(repo): リポジトリ肥大化（追跡 8,481 ファイル中 7,136＝84% が `dev-reports/` の AI エージェント自動生成ログ）とローカル絶対パスのリークに対応。`git rm -r --cached` で **`dev-reports` / `workspace` / `.playwright-mcp` を追跡解除**（計 7,169 件、ローカル実ファイルは保持）、`.gitignore` に `/dev-reports/` を追加（既存の `/workspace/` `.playwright-mcp/` ルールは追跡済みで空振りしていたため追跡解除で実効化）、`tests/unit/prompt-detector.test.ts` のテストフィクスチャ内の絶対パスを汎用化（`/Users/maenokota` → `/Users/example`、検証ロジックは不変）。履歴の書き換えは行わず既存クローン/fork に無影響 (Issue #953)

## [0.7.2] - 2026-06-21

> **Highlight**: PC 版に表示サイズ切替（大/中/小/極小、既定=中）を追加（#915/#919）。本リリースは大きな機能追加よりも、God モジュール／God コンポーネント／God フックを per-concern に分解する**内部リファクタ**（#920-#923）と、旧リポジトリ名・環境変数表記・リンク・i18n パリティを揃える**ドキュメント整備**（#924-#929）が中心。いずれも振る舞い不変で、既存テストをセーフティネットに据えている。

### Added
- feat(display): PC 専用の**表示サイズ切替（大/中/小/極小、既定=中）**を rem カスケード（案A）で実装。`usePcDisplaySize`（localStorage `mcbd-pc-display-size`・検証付き永続化、サイズ係数表／ターミナル fontSize／root font-size のメタ定義）と `PcDisplaySizeContext`/Provider（単一の真実源、PC（`!isMobile`）時のみ `<html data-pc-size>` を付与し rem カスケード適用、モバイル/アンマウント時は除去）を新設。`globals.css` で `html[data-pc-size=...]` を 18/16/14/12.5px に切替、Header に表示サイズドロップダウンを追加、`AppShell` のサイドバー幅 MIN/MAX/表示幅をサイズ係数で連動（clamp 維持・往復で非破壊）、`Terminal` の `fontSize` を prop 化し変更時は `term.options.fontSize` 更新＋`fit()` で再接続なし再フィット。モバイル（<768px）は非適用 (Issue #915)

### Fixed
- fix(display): #915 で追加した表示サイズセレクタが **worktree 詳細ページ（`/worktrees/[id]`）で表示されない**問題（#917、`useLayoutConfig showGlobalNav:false` がグローバル Header を抑止）を、`DesktopHeader` トップバーにセレクタを surface して修正（PC 専用・モバイルは null）。あわせてセレクタのラベル（大/中/小/極小）と aria-label が**ハードコード日本語でロケール非追従**だった問題（#918）を、文言を i18n 辞書（`common.displaySize.*`）へ移し `useTranslations` 経由で消費するよう修正（英語では Large/Medium/Small/Extra small を表示、未使用化した `PC_DISPLAY_SIZE_META.label` を撤去して i18n を単一の真実源に統一）。回帰テストを追加 (Issue #919)

### Changed
- refactor(git): 2327 行・37 export の `src/lib/git/git-utils.ts` God モジュールを **per-concern モジュールに分割**（git-errors / git-exec / git-default-branch / git-status / git-log / git-diff / git-commit / git-branches / git-stash / git-reset / git-remote、循環依存なし）。`git-utils.ts` は後方互換の re-export barrel として残置し barrel 経由の全 caller を不変に保つ。public API / export signature は不変（振る舞い不変）、203 ケースのテストを 11 ファイルへ verbatim 分割 (Issue #921)
- refactor(worktree): 約 3.1k 行の `GitPane.tsx` God コンポーネントを、focused custom hooks（ロジック）と memo 化した panel コンポーネント（プレゼンテーション）を共有レイアウトで束ねる薄い coordinator へ**分解**。副作用を `useGitStatus`/`useCommitHistory`/`useChanges`/`useBranches`/`useStash`/`useDangerZone` に抽出（既存 `useGitPaneNetworkOps`/`useGitPaneTabState` に合流、refetch カスケードは callback 注入で疎結合）、プレゼンテーションを `git/panels/*` + `gitPaneShared` へ、レスポンシブ（mobile-tabs / desktop-grouping）を `GitPaneLayout` へ移設、ambient config を `GitPaneContext` で供給し prop-drilling を排除。external props / data-testid / 振る舞いは不変、112 件の既存テストをセーフティネットに据え新フック・context/layout の focused test を追加 (Issue #922)
- refactor(worktree): `useWorktreeDetailController` God フックの低リスク・無結合な 3 関心事を独立サブフックへ**抽出**（純構造リファクタ・振る舞い不変）: `useHistoryFilters`（historySubTab / showArchived / historyUserOnly / historyDisplayLimit + localStorage 同期）、`useDiffViewerState`（diffContent / diffFilePath + open/close、mobile は no-op）、`useVisibilityRecovery`（visibilitychange リスナ + スロットル復帰処理）。`fetchMessages` 結合用の ref ミラーは polling 関心として controller に残置。本体は 1671→1514 行に縮小、focused unit test 18 ケースを追加 (Issue #923)
- refactor(worktree): レンダーパスを持たない dead-code の **`WorktreeDetailHeader` コンポーネントを削除**（PC worktree 詳細トップバーの実体は `WorktreeDetailSubComponents.tsx` の `DesktopHeader`、参照は自身の unit test のみの test-backed dead code）。`WorktreeDetailHeader.tsx` とそのテストを削除し repo 全体で残参照ゼロを確認（barrel は未 export）、振る舞い不変 (Issue #920)

### Docs
- docs: 旧リポジトリ名 `Kewton/MyCodeBranchDesk` を `Kewton/CommandMate` に統一修正 (Issue #924)
- docs(architecture): 環境変数表記を `MCBD_` から `CM_` に統一 (Issue #925)
- docs: implementation-history の **design-policy リンク切れを修正** (Issue #926)
- docs: CLI ガイドに **report コマンドおよび start/stop/status フラグを追記** (Issue #927)
- docs: **CLAUDE.md の tree と module-reference.md を現状の `src/` に同期** (Issue #928)
- docs(i18n): `docs/` ↔ `docs/en/` の**英訳パリティ**を達成（英訳を追加） (Issue #929)

## [0.7.1] - 2026-06-20

> **Highlight**: リポジトリ別の軽量 ToDo 機能（#894）。Home に対象リポジトリを選択して書けるチェックボックス形式の ToDo / 備忘録ウィジェットを追加。さらに全リポジトリ横断表示（#908）・モバイルレイアウト最適化（#909）・リポジトリ名表示（#903）・即時反映の担保（#911）まで一連で拡張した。あわせてエイリアスインスタンス周りの Auto-Yes / terminal-split / codex 起動の修正を取り込んでいる。

### Added
- feat(home): Home に対象リポジトリを選択して書けるチェックボックス形式の**軽量 ToDo / 備忘録ウィジェット**を追加。新規 `repository_todos` テーブル（migration v34、FK→`repositories` ON DELETE CASCADE）と API（`/api/repositories/[id]/todos` GET/POST、`/[todoId]` PATCH/DELETE）、`todo-db`（CRUD）/ `todo-api`（client）/ `todo-config`（上限定数）を新設。`TodoWidget` はリポジトリ選択を localStorage に永続化し、完了トグルを楽観更新で反映。`page.tsx` に ToDo セクションを追加 (Issue #894)
- feat(todo): ホーム ToDo ウィジェットの一覧を選択リポジトリでフィルタせず**全リポジトリ横断**で表示するよう変更（#907 案A、登録時のリポジトリ選択は維持）。`getAllTodos(db)`（`TODO_SELECT` の WHERE 無し版、リポジトリ名→position→created_at→id の安定順）と新規 API `GET /api/todos`（`{ todos }` 形式）、`todoApi.listAll()` を追加。`TodoWidget` は一覧取得を `listAll()` に変更しドロップダウン変更で再フィルタせず（ドロップダウンは追加先選択専用）、toggle/delete を `selectedRepoId` → `todo.repositoryId` に変更して横断操作での 404 を回避 (Issue #908)
- feat(todo): ホーム ToDo ウィジェットを**モバイル向けに最適化**。リスト行を 2 段組化（<sm は checkbox+content / badge+delete の 2 段、>=sm は従来の 1 行を維持）、削除ボタンの hover 依存を解消（モバイルは常時表示、デスクトップのみ hover-reveal を維持）、チェックボックス／削除ボタンに min-h/min-w 44px のタップ領域を確保（>=sm はコンパクトに復帰）、セレクタ行を `flex-col sm:flex-row` でレスポンシブ化（狭幅は縦積み、select は全幅・>=sm で `max-w-[16rem]`）。機能ロジック（listAll/create/update/remove、#907 の横断表示）は不変 (Issue #909)

### Fixed
- fix(todo): ホーム ToDo ウィジェットが参照する `/api/todos` がビルド時に静的プリレンダリングされ、ToDo の追加/done 切替/削除がリロードするまで一覧へ反映されない問題を修正。`/api/worktrees` と同じ idiom で `export const dynamic = 'force-dynamic';` を追加しリクエスト毎にライブ DB を読むよう変更（build 後 `/api/todos` が `○`(Static) ではなく `ƒ`(Dynamic) になることを確認）。force-dynamic を保証する回帰テストを追加 (Issue #911)
- fix(todo): リポジトリ別 ToDo（#894）で各項目に**リポジトリ名が表示されない**問題（#900、名前解決の経路が UI/API/DB のどの層にも未実装）を修正。採用案（案2）はデータ境界での名前解決で、テーブルは正規化を維持（`repository_id` のみ保持）し read 時に `repositories` を JOIN。`getTodosByRepositoryId` / `getTodoById` のクエリに JOIN を追加し `repositoryName` / `repositoryDisplayName` を解決（`createTodo` は INSERT 後に再取得し GET と POST のレスポンスを一致）、`TodoItem` 型に両フィールドを追加、`TodoWidget` が各項目にリポジトリ名バッジを表示。リポジトリリネームにも追従 (Issue #903)
- fix(auto-yes): 複数の同一エージェントインスタンス（例 `claude` + `claude-2`）を 1 ブランチで起動した際、**Auto-Yes がプライマリインスタンスでしか効かない**問題を修正。state と poller が `worktreeId:cliToolId` のみでキー付けされ、poller の capture/`getSessionName` が instanceId を渡していなかったため常にプライマリの tmux セッションを解決していた。instanceId を composite key・state・poller・auto-yes/current-output API ルート・`worktree-status-helper`・CLI(send/auto-yes)・フロントエンド（controller/desktop pane）に通し、各インスタンスが独立した Auto-Yes state と poller を持つよう変更。キーはプライマリで 2-part（後方互換）、エイリアスで 3-part `worktreeId:cliToolId:instanceId` になる (Issue #896)
- fix(auto-yes): サイドバーからの worktree 遷移→復帰時に **Auto-Yes 表示がリセット**（特に alias instance が OFF 固定）する問題を、案1（根本）＋案2（過渡汚染遮断）の併用で修正。案1: worktreeId 変更時 or rosterReady 成立時に既存の `GET /api/worktrees/[id]/auto-yes`（cliToolId なし）を 1 回呼び、返る instances マップを `autoYesStateMap` 全体へ反映（primary も alias も一括復元、従来の current-output ポーリングは primary しか再シードしなかった）。案2: worktreeId 変更リセット effect で `autoYesStateMap` を破棄し旧 worktree の同名キー汚染を遮断。最新リクエストガード（`latestAutoYesRequestIdRef`）で高速な A→B→A 遷移でも古いレスポンスが新 map を汚染しないようにした (Issue #902)
- fix(terminal-split): split で同一 cliTool の複数 instance（例 claude / claude-2）が稼働中のとき、片方の Stop（interrupt）が**もう片方の split にも Escape を送ってしまう**問題を修正。原因は `InterruptButton` が body に instanceId を含めず POST し、API がブロードキャスト分岐に落ちて同一 cliTool の全 alias instance を宛先に追加していたこと（send / special-keys / prompt-response は instanceId を伝播済みで interrupt だけ漏れ）。`InterruptButton` に instanceId prop を追加し `instanceId !== cliToolId` のとき `{ cliToolId, instanceId }` を送信（primary は `{ cliToolId }` のみで完全後方互換、CLI のツール全体停止ブロードキャストも維持） (Issue #901)
- fix(terminal-split): split 復帰時に **2 個目以降のターミナル選択がドロップダウン先頭にリセット**される不具合（#898）を修正。根本原因は、実 roster（claude-2 等のエイリアスを含む）が API から届く前の過渡 roster に対し `useTerminalSplits` の reconcile が走り、永続化済みの claude-2 を evict して未使用 primary で補填していたこと。案A として実 roster 確定までは reconcile を抑止：`useWorktreeDetailController` に `rosterWorktreeId` を追加し fetchWorktree が実 roster を反映した時点で worktreeId をタグ付け、`rosterReady = (rosterWorktreeId === worktreeId)` を派生。`useTerminalSplits` は `rosterReady=false` の間 reconcile を抑止し永続化設定を保持、false→true で一度のみ reconcile。worktree 切替直後の永続化汚染も effect ガードで解消 (Issue #899)
- fix(file-tree): Files 表示中に**展開済みサブディレクトリ内に作成されたファイルが自動反映されない**問題を修正。対策A（監視範囲の是正）として、ツリー変更検知を `useWorktreeDetailController` から `FileTreeView` 内へ移設し、ルートに加え展開中の全サブディレクトリをディレクトリ単位の合成シグネチャ（path→items ハッシュの Map）で検知（検知範囲が `reloadTreeWithExpandedDirs()` の再描画範囲と一致）。両スナップショット共通ディレクトリの内容変化のみを変化と判定し新規展開/折り畳みでは誤再読込しない。有効化は `pollingEnabled` prop（PC: activeActivity==='files' / モバイル: files タブ）で既存 5 秒周期・visibilitychange 制御を流用。対策B として Files パネルヘッダーに更新ボタンを常設 (Issue #888)
- fix(codex): codex 初回起動（update あり）で**初期化が非決定的に失敗**する問題を修正。主因は番号選択を Enter 付きで送信していたこと — `waitForReady` の update skip('2') / trust('1') を `sendKeys(..., false)`（Enter なし）に変更（codex の選択ダイアログは番号キー単独で即確定し、末尾 Enter は次画面に当たる迷子キーで最悪 "Update now" 確定→npm install 暴発になっていた）。増幅要因として `CODEX_PROMPT_PATTERN` が選択肢行も拾うため `CODEX_DIALOG_PATTERN` / `isCodexPromptReady()` を追加し `waitForReady` / `waitForPrompt` 両方に適用（常駐バナー "Update available" は誤って常時 false 化するのを避けるため意図的に除外） (Issue #890)
- fix(codex): `capturePane(50)` が scrollback 込みで返すため、skip 済み update/trust ダイアログ行が live プロンプト上部に残り whole-window 判定が再発火し、**送信メッセージへの `222...` prefix / ready 検出の張り付き**が発生していた問題を修正。`isCodexPromptReady` を位置ベース化（本物プロンプト行が全ダイアログマーカーより下＝最下部アクティブ要素のとき ready）、`getCodexActiveDialog` を新設しプロンプトより下の active 領域のみで分類（scrollback 残存は null）。`waitForReady` の全分岐を位置ベース化し update に `updateDialogHandled` ガードを追加（'2' 再送防止）、`waitForPrompt` はタイムアウト時 throw（fall-through 廃止で検出失敗→誤入力を是正） (Issue #892)

## [0.7.0] - 2026-06-17

> **Highlight**: 別名インスタンス対応（1 エージェント複数セッション、Epic #866）。セッション識別を `(worktreeId, cliToolId)` から `(worktreeId, instanceId)` へ拡張し、1 つの CLI ツールが 1 worktree 内で複数の独立セッションを並行実行可能になった。エイリアス管理 UI（PC / Mobile）、サイドバー / ヘッダー / ターミナルでの per-instance ステータス表示まで一貫対応。

### Added
- feat(agent-instances): セッション識別を `(worktreeId, cliToolId)` から **`(worktreeId, instanceId)`** に一般化し、1 つの CLI ツールが 1 worktree 内で **複数の並行セッション**を tmux/DB/poller の衝突なく実行可能に（Epic #866 の中核）。安定 `instanceId` + alias を導入し同一 CLI ツールの複数インスタンスを `MAX_AGENT_INSTANCES=10` まで許可（id/tool validation + 重複 reject）。primary インスタンス（`instanceId === cliToolId`）は #868 以前の識別子（tmux session `mcbd-{tool}-{wt}` / poller key `{wt}:{tool}`）を完全維持し、追加インスタンスは `deriveSessionSuffix` で `-{suffix}` を付与（完全後方互換）。新規 `agent_instances` テーブル + DB migration v33（`CURRENT_SCHEMA_VERSION` 32→33、既存 `selectedAgents` を primary instance に backfill、`session_states` PK を `(worktree_id, instance_id)` へ再構築、`chat_messages.instance_id` 追加、fresh/既存 DB を 1 migration で self-heal）を追加。API（send/capture/respond/kill-session/special-keys/interrupt/current-output/prompt-response）と CLI（send/capture/wait/respond の `--instance <id>`）が optional `instanceId`（未指定時 primary）を受理 (Issue #871)
- feat(agents): CLI ツールのチェックボックス設定を **agent-instance マネージャ**に置換し、各インスタンスの **alias を header/terminal の全セッション表示に反映**。`AgentInstancesPane`（PC、add/rename/delete/reorder、`1..MAX_AGENT_INSTANCES`、`PATCH /api/worktrees/[id] { agentInstances }` で永続化、同一 CLI ツールの複数インスタンス対応）を追加。PC ターミナル split サブシステムを instance-key 化（split が `cliToolId` + `instanceId` を保持し、同一 CLI の 2 インスタンスを別 split で実行可能）。`getInstanceLabel`（alias 優先）が Header バッジ / Terminal agent タブ / Split CLI selector を駆動。サーバー側 `validateAgentInstancesInput` で bounds / id 一意性 / `id===cliTool` primary anchor / alias 長を guard。永続化状態を migrate（`activeCliTab-<wt>` → `activeInstanceId-<wt>`、`normalizeSplitConfig` が #869 以前の split payload に `instanceId=cliToolId` を導出） (Issue #869)
- feat(agents): **Mobile の Notes/Tools Agent タブからエイリアスインスタンスを管理**（add/rename/delete/reorder）でき、**Mobile ターミナルタブを per-agent-instance 化**して同一 CLI ツールの複数インスタンス（例 Claude×2）を alias で独立選択・利用可能に。折衷案として instance ROSTER（id/cliTool/alias/order）は PC と共有し DB 永続化（共有 `AgentInstancesPane` を `MobileAgentInstancesPane` ラッパで再利用）、**どのインスタンスをタブ表示するかは per-device の view preference として localStorage に保持**（`useMobileSelectedInstances`、DB 非書込、最低 1 インスタンス `MIN_VISIBLE_INSTANCES=1` を維持）。#837/#851 の「Mobile でのタブ絞り込みが PC 表示を縮小しない」意図を継承。`activeInstanceId` を Mobile terminal pane / MessageInput / NavigationButtons / prompt-respond / kill 経路に配線（PC リクエストは byte-identical、instance param は mobile-gated で `instanceId !== cliTool` 時のみ付与） (Issue #874)
- feat(sidebar): サイドバーでエージェント別に最大 5 個並んでいたステータスドットを、**最も重要なステータスを示す単一の `BranchStatusIndicator` に集約**。`aggregateCliStatus()`（優先度 waiting > running/generating > ready > idle）と内訳文字列を生成する `formatCliStatusBreakdown()` を `types/sidebar.ts` に追加し、`BranchListItem` の複数ドットループを集約アイコン 1 つに置換。ホバー/フォーカスで各エージェントの内訳（例 "Claude: running, Codex: idle"）を表示。既存ソート（`STATUS_PRIORITY`, waiting 優先）は `branch.status` 基準のため挙動不変 (Issue #867)
- feat(repositories): サイドバーヘッダーに **`/repositories` への Database アイコンリンク**を `SyncButton` の隣に追加（既存ダークテーマの hover/focus スタイル踏襲）。`/repositories` ページで `RepositoryManager`（Add Repository / Sync All アクション + フォーム）を `RepositoryList` の**上**に描画し、Add/Sync All ボタンを上部に配置 (Issue #880)
- feat(sidebar): サイドバーヘッダーの 4 ボタン（view-mode toggle / sort selector / sync / `/repositories` リンク）に**共有 `Tooltip`（100ms delay、placement bottom）を適用して hover tooltip を統一**。action-oriented な i18n テキスト（`tooltips.{viewMode,sort,sync,repositories}`）で「各ボタンが何をするか」を表示し、低速・名詞のみの native `title` 属性を撤去（`aria-label` は screen reader 用に維持＝二重読み上げ回避） (Issue #882)
- feat(terminal-split): ターミナル split 幅と Message History 幅を 1 アクションで均等化する **"Equal widths" アクションバーボタン**を追加。可視 split 幅を各 `1/n` に、split 共有 Message History 幅を default（40%）にリセット。`useTerminalSplits.resetWidths()`（length-preserving 1/n 均等化、splits/CLI 割当は不変、既存 localStorage effect で永続化）を追加し、terminal resizer の `PaneResizer` ダブルクリックで terminal 幅のみ均等化（VS Code 風、History 幅は据え置き）。`terminal.equalizeWidths` / `terminal.equalizeWidthsHint`（en/ja）を追加 (Issue #861)
- feat(file-tree): Files ツールバー（PC & Mobile）から **obsolete な CMATE ボタン（#294 由来の CMATE.md 手動セットアップ/検証）を撤去**。Schedules UX は `ScheduleEditDialog` / `/cmate/schedules` API / `ExecutionLogPane` へ移行済み。共有 `FileTreeView` から `onCmateSetup` prop / ツールバーボタン / 未使用 handler・props・import をクリーンアップ（cmate-validator は `ExecutionLogPane` で継続使用のため Schedules 機能は無影響、New File / New Directory は不変） (Issue #864)
- feat(activity-bar): **Activity Bar の開閉状態を worktree 単位で永続化**。従来は単一のグローバル localStorage キー（`commandmate.worktree.activeActivity`）に保存し closed（null）状態を永続化していなかったため、ブランチ（worktree）切替で detail view が再マウントされ「A で隠したペインが B 経由で A に戻ると再表示される」問題があった。`useActivityBarState(worktreeId)` 化して `commandmate.worktree.activeActivity-<id>`（per-worktree CLI タブキーと同型）に保存し、`ACTIVITY_CLOSED_SENTINEL` で closed 状態も永続化（未訪問 worktree は引き続き Files デフォルト）。`worktreeId` 変化時に re-hydrate（SSR-safe） (Issue #858)

### Fixed
- fix(db): migration v33（#868）が `worktrees` への FOREIGN KEY を持つ `session_states` を再構築する際、長期運用 DB（`foreign_keys=ON`）に蓄積した**孤立 `session_states` 行**（worktree 削除済み）で full-table copy が "FOREIGN KEY constraint failed" で中断し、`agent_instances` が未作成・worktrees API が破綻する問題を修正。`v33.up()` で worktree が現存する行のみコピー（`WHERE worktree_id IN (SELECT id FROM worktrees)`、孤立行は dead data）。あわせて `scripts/init-db.ts` が **`CM_DB_PATH` を尊重**（従来 `./db.sqlite` をハードコードしていたため `db:init` がサーバー実使用 DB を migrate しなかった）。`foreign_keys=ON` + 孤立行の回帰テストを追加 (Issue #873)
- fix(agents): #868/#869 でタブ/split identity を `instanceId` に移行した一方で **session-status 検出が per-cliTool のままだった**ため、エイリアスインスタンス（`instanceId !== cliToolId`）が PC でステータスアイコンも "✕ End" ボタンも表示しなかった問題を修正。`worktree-status-helper` が `getSessionName(worktreeId, instanceId)` で各インスタンスのセッションを独立検出し、un-aggregated な `sessionStatusByInstance`（instanceId キー）を返却。`sessionStatusByCli` は alias の稼働を logical-OR で畳み込みサイドバー（#867）/ ヘッダードットを正しく維持（primary インスタンスは byte-identical）。`DesktopHeader` / split pane がステータスドット・"End" ボタンを `sessionStatusByInstance[instanceId]` から解決（`sessionStatusByCli` に後方互換フォールバック）。`kill-session` が常に `instance=` を渡し alias 終了が当該インスタンスのみを終了 (Issue #875)
- fix(sidebar): サイドバーのブランチ左ステータスアイコンが **`selectedAgents` 外で起動したインスタンス（例 claude）やエイリアスインスタンス（claude-2）の稼働を反映しない**不具合を修正（#875 で詳細ヘッダーは per-instance 化済みだがサイドバー集約経路が取り残されていた）。`toBranchItem` を `sessionStatusByInstance` / `agentInstances` ロスターベースの per-instance 集約に変更し、`selectedAgents` に依存せずロスター + 稼働中の非ロスターインスタンスを union して `BranchStatus` を導出（`sessionStatusByInstance` 不在時は従来経路にフォールバック）。`aggregateCliStatus` / `formatCliStatusBreakdown` のキーを `CLIToolType` から instanceId（string）へ拡張し、一覧 API `GET /api/worktrees` が `agentInstances` を返すよう修正（共有 `resolveAgentInstances` を `src/lib/session/agent-instances-resolver.ts` へ抽出） (Issue #878)
- fix(worktree): MemoCard ヘッダーの **長いタイトルで insert/copy/delete ボタンがヘッダー行からはみ出る**問題を修正。タイトル `<input>` が `min-w-0` なしの `flex-1` で content intrinsic width（flex `min-width: auto`）により縮小できずボタンを押し出していたため、タイトル input に `min-w-0`（縮小許可）と各アクションボタンに `flex-shrink-0`（自然サイズ維持）を付与 (Issue #885)
- fix(file-tree): PC 版 Files のファイルツリーで、ファイル名 hover 時の**ツールチップ表示が遅い**（ブラウザ制御の native `title` 属性のため Chrome で約 0.5〜1 秒）問題を解消。新規 `TruncationTooltip`（省略表示＝`scrollWidth > clientWidth` 時のみ表示、遅延 200ms、`createPortal` で `document.body` に `position:fixed` 描画しスクロールコンテナでの見切れを回避、`role=tooltip` + `aria-hidden=true`）を追加し、`TreeNode` のファイル/ディレクトリ名 span の `title`（#852）を置換 (Issue #862)

## [0.6.4] - 2026-06-10

### Added
- feat(agents): PC `DesktopHeader` の per-agent status indicator のデフォルトを **3 → 5 エージェント**に拡張（claude/codex/gemini → claude/codex/gemini/opencode/copilot）。`selected-agents-validator` の `MAX_SELECTED_AGENTS` を 4 → 5、`DEFAULT_SELECTED_AGENTS` に opencode/copilot を追加し、`validateAgentsPair` を 2〜5 の一意 ID を受理（6 件以上は reject）するよう変更。`WorktreeDetailDesktop` の `AgentSettingsPane` を `maxAgents` 4 → 5 に拡大。stored `selectedAgents` を持つ既存 worktree は無改修（migration なし、新規 worktree のみ 5-agent デフォルト）、Mobile の `DEFAULT_MAX_AGENTS=2` は無影響 (Issue #836)
- feat(agents): Mobile の Agent タブの選択を **localStorage に分離し PC（DB `selectedAgents`）から独立**。従来 Mobile の選択が worktree の `selectedAgents` DB カラムを PATCH していたため、Mobile で 2 エージェントを選ぶと PC 側の DesktopHeader indicator も 2 に縮小していた。Option A として Mobile は preference を `commandmate:worktree:mobileAgents:<id>` に localStorage 永続化し DB を書かない（PC が単一の真実源を維持）。`useMobileSelectedAgents` フック / `AgentSettingsPane` の `availableAgents`・`persistToServer` props を追加し `NotesAndLogsPane` / `MobileContent` 経由で配線。PC 経路は無改修 (Issue #837)
- feat(agents): Mobile の Agent タブで **PC とは独立に全 6 CLI ツールから自由に選択可能**に。従来は localStorage preference を PC の DB 選択に対して解決し 2 件に capping していたため Claude/Codex しか選べなかった。`useMobileSelectedAgents` の解決対象を全 agent pool（`CLI_TOOL_IDS`）に変更し `MOBILE_MAX_AGENTS` を 6 へ、`MOBILE_DEFAULT_AGENTS=2`（初期タブ）を追加。`resolveMobileAgents(raw, pool)` で validate/dedupe/cap、未使用の `dbSelectedAgents` option を撤去。DB は引き続き書かない (Issue #851)
- feat(terminal-split-action-bar): `TerminalSplitContainer` の既存 +Split/-Split Action bar に **History / Files 表示トグルボタンを追加**（Phase 2）。「N / 3 splits」カウントと +Split コントロールの間に配置し split 数に関わらず常時表示。History トグルは `useHistoryPaneState().toggle()`、Files トグルは `useFilePanelState().toggle()` を呼び、両フックの broadcast により縦の collapse strip と単一の真実源を共有。active（可視）= cyan アクセント / inactive = グレー、`aria-pressed` で可視状態を反映、`aria-label`/`title` は Show/Hide 文言（`worktree.terminal` i18n キー再利用）を切替 (Issue #841)
- feat(mobile): Mobile 下部 tab bar の **'CMATE' タブ label を 'Notes' にリネーム**。PC Activity Bar の Notes activity と用語統一し、実体（`NotesAndLogsPane` の主要コンテンツ＝メモ）を正確に表す。`id='memo'` / icon / 内部 routing は不変（deep-link 影響なし） (Issue #838)
- feat(mobile): Mobile の **4 番目の tab label を 'Notes' → 'Tools' にリネーム**（より明確な intent）。内部 id（`'memo'`）と deep-link slug（`'notes'`）は既存 pane routing / deep-link 互換のため不変 (Issue #850)
- feat(file-tree): file tree（`TreeNode`）と `FilePanelContent` ツールバーの open-file path で CSS `truncate` により切り詰められた **ファイル/ディレクトリ名・パスを hover 時に title tooltip でフルネーム表示**。`TreeNode` の name span（PC/Mobile）と `FilePanelContent` の path span に native `title` 属性を追加 (Issue #852)
- perf(worktree-detail): `useWorktreeDetailController` の worktree/loading state を **共有 worktree リストキャッシュから prime**（stale-while-revalidate）し、キャッシュ済み worktree の詳細画面を開いた際に「Loading worktree info...」のフラッシュなく即座に描画。background `fetchWorktree()` は引き続き走り authoritative payload で上書きする。non-throwing `useOptionalWorktreesCacheContext()` を追加して #709 の single-poller 保証（2 つ目の `/api/worktrees` poller を作らない）を維持し provider 不在でも graceful degrade。cache miss は従来どおり loading-first（回帰なし） (Issue #839)

### Fixed
- fix(file-panel): PC History/File panel 可視性改善の Phase 1。file-panel の **折りたたみ状態を localStorage（`commandmate.worktree.filePanelCollapsed`）に永続化**（`useFilePanelState` フックを新設し `useHistoryPaneState` をミラー、`FilePanelSplit` の非永続 `useState(false)` を置換）し reload / re-mount を跨いで状態を保持。折りたたみバーを 24 → 36px に拡幅し FilePanel / History の collapsed bar に CSS `vertical-rl` の縦ラベル（"Files" / "History"）を追加。`HistoryPane` / `TerminalContainer` / `TerminalSplitPaneContent` の aria-label/title 文言を新 i18n キー `worktree.terminal.*`（en/ja）由来の "Show / Hide" に統一。既存の collapse/expand 挙動は不変 (Issue #840)
- fix(terminal-pane): エージェント終了（kill / 自然終了）後に **PC ターミナル split へ残留していた古い出力をクリア**。root cause は `useTerminalPanePolling` が「出力あり または セッション実行中」のときのみ出力をクリアしていたため、「空 + 停止」ケース（まさに kill / 終了ケース）で stale 出力が残っていたこと。`isRunning === false` になったら一度上書き（クリア）するよう修正（実行中セッションは無影響）。加えて `TerminalDisplay` に `attaching` prop を追加し、attaching 中は「読込中...」、active セッションが出力なしで非アクティブ化した際は「セッションは終了しました（メッセージ送信で再開できます）」の ended placeholder を表示（never-started / attaching pane には ended placeholder を出さない） (Issue #842)

## [0.6.3] - 2026-06-05

### Added
- feat(git-pane): **GitPane の UX を全 4 Phase でリデザイン**。情報設計の 2-tier 化からモバイル tab UI・AI 委任までを段階的に改善。
  - **Phase 1 — 2-tier information design (#815)**: GitPane を Core（常時表示: Current Status / Quick actions（Pull/Push のみ）+ 昇格した `BranchCheckoutDropdown` / Changes / Commit History）と「Advanced operations」グループ（`AdvancedSection`、デフォルト折り畳み・Fetch / Branches（create/delete のみ）/ Stash / Danger Zone を内包）に再編。開閉は `useLocalStorageState`（SSR-safe）で `commandmate:gitPane:advancedOpen` に永続化。Checkout を新規 core `BranchCheckoutDropdown`（confirm ダイアログ + S3-001/S3-002 警告 + force フラグを verbatim 移設、testid 同一）に抽出し、Fetch を `NetworkOperationsSection` の optional `onFetch` + dropdown 用 `extraActions` slot で Pull/Push から分離。全 handler / API 呼び出しは不変（純情報設計） (Issue #815)
  - **Phase 2 — action shortcuts (#816)**: core git workflow を短縮する 3 つのショートカットを追加。Changes に Commit 隣の「Commit + Push」複合ボタン（commit フローを `doCommit()` に切り出し成功時のみ push、push 失敗時は commit を保持＝rollback なし、既存の canCommit/amend ガードを継承）、Commit History の各行にインライン「View diff」ボタン（`GET /git/show` で file list をアコーディオン展開、`selectedCommit` 詳細経路とは独立 state で後方互換維持）、Changes の各ファイルに展開キャレット（unstaged/staged/untracked diff の先頭 20 行をインライン表示、既存「Diff」ボタンの全 diff 表示は維持）を追加 (Issue #816)
  - **Phase 3 — 'Ask AI' buttons (#817)**: Advanced グループの複雑な Git 操作に「Ask AI」ボタンを配置し、手動実行の代わりに active CLI agent へ委任可能に。クリックで context-rich な ja プロンプトを active CLI タブの `MessageInput` composer に下書き（auto-send なし＝送信前にレビュー/編集可）。既存 `pendingInsertTextMap` 経路（`handleInsertToMessage` / #728 / #744）を流用。新規 `src/lib/git-ai-prompt-templates.ts` を SSOT pure builder（branch create/delete・stash cleanup・stash pop/apply conflict・reset（hard-reset reflog 復旧 note 付き）・revert・force-push）として新設。`GitPane` に再利用可能な `AskAiButton` を追加し Branches / Stash / Danger Zone セクションへ配線（handler 未配線時は非表示でグレースフルデグレード、既存 execute 経路ボタンは不変） (Issue #817)
  - **Phase 4 — mobile tab UI + visual grouping + persistence (#818)**: Mobile は 4-tab UI（Status/Changes/History/Advanced、新規 `GitPaneMobileTabs`、active タブのみマウント＝非 active グループは unmount、最後のタブを永続化）。Desktop は read/write/advanced ブロックへの視覚的グルーピング（bg tint + accent border、セクション順序と overflow-hidden+flex-1 history レイアウトは不変）。永続化は active タブ + Commit History/Advanced 折り畳み状態を新規 `useGitPaneTabState` フック（`commandmate:gitPane:` namespace、Phase 1 `advancedOpen` キーを維持）に統合。`useIsMobile` / `isMobile` prop 経路・handler・API 呼び出しは不変 (Issue #818)
- feat(schedules): **Schedules ペインの UX を全 4 Phase でリデザイン**。CMATE.md 手編集なしでのスケジュール CRUD から、モバイル full-screen modal・AI 委任までを段階的に追加。
  - **Phase 1 — ScheduleEditDialog modal (#824)**: CMATE.md を手編集せずスケジュールを作成/編集できる Desktop/Mobile 共用 modal を追加。Option C（UI は CMATE.md のみ書き込み、既存 `schedule-manager` mtime watcher が DB を同期）を採用し DB の POST/PUT/DELETE を UI から呼ばない。`src/lib/cmate-writer.ts`（cmate-parser の対称版・section 順序/format を保持する pure upsert/remove/toggle 変換 + cell escaping + atomic 書き込み（tmp→rename）+ `validateScheduleInput`）、`ScheduleEditDialog.tsx`（name/cron（+presets）/CLI tool/model（copilot）/動的 Permission dropdown/message（counter）/enabled、inline validation）、API route `/api/worktrees/[id]/cmate/schedules`（POST upsert / PATCH toggle / DELETE remove、`syncSchedulesNow()` で即時反映）を新設。`getPermissionOptionsForTool`（動的 dropdown の単一ソース）を追加 (Issue #824)
  - **Phase 2 — mobile full-screen modal + section accordion + sticky footer (#825)**: `ScheduleEditDialog` を 3 アコーディオンセクション（Basic / Advanced / Message）に分割し、viewport で shell を切替。Mobile（<768px）は新規 `FullScreenModal`（slide-up・右上 close・sticky footer、accordion はデフォルトで先頭のみ open、`visualViewport` を追跡し focus 中の input をスクロールしてオンスクリーンキーボードに隠れないように）、Desktop（>=768px）は Phase 1 の中央 Modal を維持（3 セクション全展開）。各アコーディオンヘッダーに section icon + 動的サマリ（CLI tool · permission 等）を表示。`src/components/common/FullScreenModal.tsx` を新設、tailwind に slide-up keyframe を追加 (Issue #825)
  - **Phase 3 — empty-state CTA + Logs tab separation + inline row actions (#826)**: Schedules ペイン（`ExecutionLogPane`）を再編。Empty state に中央寄せ「Create Schedule」CTA（旧 4-step CMATE.md 手順は「Or edit CMATE.md manually」折り畳みトグル＝デフォルト closed の背後へ移動）、Execution Logs を in-pane tabs（「Schedules」/「Logs」）で分離（Logs は自身の展開/詳細取得 state を持つ `ExecutionLogsView` に抽出）、Schedule 行に inline enabled トグル（role=switch・1-click・modal なし）+ edit/delete アイコンボタン（aria-labelled）+ last-run/next-run/log timestamp を統一する共有 format helper を追加。CRUD 挙動と data-testid は不変 (Issue #826)
  - **Phase 4 — 'Ask AI' buttons for cron / message drafting (#827)**: `ScheduleEditDialog` の cron / message フィールドに「Ask AI」ボタンを追加。クリックで context-aware な ja プロンプトを active CLI タブ composer に下書き（auto-send なし）し modal を閉じて AI 応答を確認可能に。既存 #817（GitPane）と同じ `pendingInsertTextMap` 経路を流用。新規 `src/lib/schedule-ai-prompt-templates.ts`（cronPrompt / messageDraftPrompt の pure builder で ja プロンプトを SSOT 管理）、`ScheduleEditDialog` に `onInsertToMessage` prop + `AskAiButton`（未配線時は非表示でグレースフルデグレード）を追加 (Issue #827)

### Fixed
- fix(schedules): 無効化（`enabled=false`）されたスケジュールが Schedules ペインに表示されず UI から管理不能だった問題を修正。`/api/worktrees/[id]/schedules` GET クエリが `AND enabled = 1` をハードコードしており、ペインが read-only だった #294 時代は問題なかったが、#824 で create/edit/delete/toggle UI を追加した後は CMATE.md 内の disabled スケジュールが不可視となり、再有効化/編集/削除に CMATE.md 手編集が必要になっていた。SELECT から `AND enabled = 1` を除去（1 行修正）し、enabled/disabled 両方の行が返ること・SQL が filter を再導入しないことを検証する回帰テストを追加。Active Schedules セクション（実行中 cron job を filter する別 endpoint）・cron-parser の CMATE.md sync・soft-delete（削除時 `enabled=0`）ロジックは不変 (Issue #832)

## [0.6.2] - 2026-06-04

### Added
- feat(message-input): busy なセッションへメッセージを送信した際に **「queued (session busy)」warning toast** を表示。先行タスク処理中のセッションに送信すると API は 200 を返して CLI 側でメッセージをキューイングするため composer が空になり「何も起きない（no-op）」ように見えていた挙動を改善。`MessageInput` に `isProcessing` / `showToast` props を追加し、送信成功時に `isProcessing === true` なら「現在のタスクの後ろにキューされた」旨の warning toast を表示（idle 送信時は従来どおり toast なし）。`TerminalSplitPaneContent` は当該 split 自身の poller（`useTerminalPanePolling` の `terminal.isRunning`）から `isProcessing` を導出し、既存の `history.showToast` surface を再利用して両者を `MessageInput` へ配線 (Issue #806)

### Fixed
- fix(status-detector): `/pm-auto-dev` + subagent Task 実行中に Claude セッションが誤って "Ready"（`isProcessing: false`）と検出される問題を修正。footer 下部に subagent task panel（`⏺ main` / `◯ general-purpose ... 55s` 行）が描画されると、`✶ Running…` スピナー（footer 上部）と `esc to interrupt` status bar の両方が step 2（thinking 検出）の狭い 5 行 `THINKING_TAIL_LINE_COUNT` window の外へ押し出され、可視のままの `❯` input box が step 3 の input-prompt チェックに合致して `status='ready'` を返していたことが原因。input-prompt フォールバックの前に、より広い 15 行（`STATUS_CHECK_LINE_COUNT`）footer window 内で `esc to interrupt` status bar を照合する Claude 専用チェック（step 2.6 / `CLAUDE_INTERRUPT_HINT_PATTERN`）を追加。status bar は Claude が能動的に処理中のみ表示され live で再描画されるため（idle 時は `? for shortcuts`）、Issue #188 の spinner-summary 誤検出は再発しない (Issue #805)
- fix(prompt-detector): Claude Code v2.x の **AskUserQuestion picker** で auto-yes が 30 分以上沈黙する問題を修正。新 picker は `Enter to select · ↑/↓ to navigate · Esc to cancel` footer の**下**に overlay（`/pm-auto-dev` task panel、例 `6 tasks (4 done, 2 open)`）を描画するため、`NORMAL_OPTION_PATTERN` が `6 tasks …` 行を option 6 と誤マッチし逆方向スキャンが footer で停止、本来の `1./2./3.` picker options が収集されず検出が `no_prompt` を返していたことが原因。`CLAUDE_ASK_USER_QUESTION_FOOTER_PATTERN` を追加し `effectiveEnd` footer-trim（Issue #704 機構）を picker footer でもトリムするよう拡張（trailing panel をスキャン窓の外へ排除、`isAskUserQuestion` フラグ付与）。回答送信側（`prompt-answer-sender.ts`）は AskUserQuestion picker でハイライト済みデフォルト（`offset === 0`）選択時に Enter 前へ net-zero の Down+Up nudge を送り picker cursor を確実に engage（裸 Enter での commit 失敗を回避）。legacy footer / 旧フォーマット経路は byte-for-byte 不変 (Issue #807)

### Chore
- chore(docs): CLAUDE.md の肥大化を構造的に防止。CLAUDE.md からインライン module table（240 行）を削除（92,229 → ~15kB）し全 module detail を `docs/module-reference.md` へ集約、CLAUDE.md 冒頭に anti-pattern directive（モジュール詳細を書かない指示）を追加、CI に CLAUDE.md size の hard-cap（35,000 byte 上限・hard-fail）を追加して回帰を防止 (Issue #809)

## [0.6.1] - 2026-06-03

### Added
- feat(git): **GitPane に Git 操作機能を全 5 Phase で追加**。worktree 詳細の Git タブから status 確認〜stage/commit〜branch 操作〜stash/reset/revert〜push/pull/fetch までを UI 完結で実行可能に。
  - **Phase 1 — Current Status (#779)**: 既存内部実装 `getGitStatus` を API 化（`GET /api/worktrees/[id]/git/status`、`currentBranch` / `isDirty` / `aheadBehind` 等）し、GitPane 最上部に Current Status セクション（branch chip / dirty badge / ↑N ↓M / refresh、branch mismatch 警告、Mobile コンパクト版、visibilitychange 対応ポーリング）を追加 (Issue #779)
  - **Phase 2 — stage/unstage/commit (#780)**: ローカル完結の write 操作を追加。`git/staged`（Staged/Unstaged/Untracked）/ `git/stage` / `git/unstage` / `git/commit`（空 commit 拒否）/ `git/working-diff` の各 API と Changes セクション（3 折り畳みリスト＋ファイル単位 Diff/Stage/Unstage）を追加。書き込みは Map 直列化 + `index.lock`→409 で排他制御し、#779 の `getGitStatus` バイト不変性を厳守 (Issue #780)
  - **Phase 3 — branch list/checkout/create/delete (#781)**: `listBranches` / `checkoutBranch` / `createBranch` / `deleteBranch` と専用 typed error 6 種を追加。`git/branches` / `git/checkout`（remote は `switch -c --track` で detached HEAD 回避、`force` で dirty 破棄）/ `git/branch/create` / `git/branch/delete` の API、GitPane に Branches セクション（local/remote タブ、checkout/create/delete モーダル、dirty 時 checkout 警告・履歴喪失警告）を追加 (Issue #781)
  - **Phase 4 — stash + reset/revert (Danger Zone) (#782)**: `stashPush/Pop/Apply/Drop` / `gitReset` / `gitRevert` と conflict リカバリ（200 で `{conflict, conflictFiles}` 返却）を追加。default branch への hard reset はサーバー側で拒否（`GitResetDefaultBranchError`→409）。GitPane に Stash セクションと Danger Zone（赤・デフォルト折り畳み、Reset/Revert モーダル＋hard branch-confirm・履歴喪失/実行中セッション警告）を追加。pop/apply の conflict は専用 notice として表面化 (Issue #782)
  - **Phase 5 — push/pull/fetch + credential 処理 (#783)**: `gitFetch` / `gitPull` / `gitPush`、ネットワーク stderr 分類、credential 委譲（git credential helper / SSH-agent）、進捗 polling、abort semantics を追加。push は明示 refspec `${branch}:refs/heads/${branch}` で remote default 誤更新を封鎖、`main`/`develop` への force push は拒否し `forceWithLease` を推奨デフォルト化。logger に userinfo-URL redaction を追加し credential 付き URL の平文ログ漏洩を防止。force push は Danger Zone 内＋多段確認モーダル (Issue #783)
- feat(memo): メモ登録上限を **10 → 20** に拡張し、MemoPane に title+content の client-side テキスト検索（`useMemoSearch` / `MemoSearchBar`、indexOf ベースで ReDoS 回避、debounce 300ms・最小2文字・IME 対応、フィルタ＋next/prev スクロール）を追加 (Issue #787)
- feat(layout): PC版 `DesktopHeader` の per-agent status indicator を **HTML5 ネイティブ drag-and-drop** で terminal split にドロップして、その split の CLI tool を切り替え可能に。専用 MIME `application/x-commandmate-cli-tool` で cliId を publish、drop 先で allowed=cyan ring / forbidden=red ring を表示、同一 CLI 複数選択は reject＋warning toast。クリックでの `activeCliTab` 切替（#751）は維持、新規 props は全 optional で既存 call site 非破壊、Mobile 経路は非描画 (Issue #786)

### Fixed
- fix(layout): PC版でセッションを強制クローズする kill ボタンが消失していた問題を修正。#728（PC ターミナル 1-3 split 化）で Terminal header の kill ボタンを削除した際、#755（Desktop/Mobile 分割）で Mobile 経路のみ復活し Desktop 経路が復活漏れだった（#740 / #743 と同型の per-split 移行漏れパターン）。`DesktopHeader` に per-agent status row と worktree status dropdown の間へ kill button（赤・✕ icon・"End" label、表示条件 `sessionStatusByCli?.[activeCliTab]?.isRunning === true`、`data-testid="desktop-kill-session"`）を配置 (Issue #784)
- fix(slash-commands): Codex CLI は skill を `$NAME` 構文で起動し `.codex/prompts/` を読まないため、`codex-skill` ソースのコマンド表記を `$NAME` に変更（Claude/Copilot/Gemini は `/NAME` 維持）し、未使用の `.codex/prompts` ローダー（`loadCodexPrompts` 等）と `codex-prompt` invocation を削除 (Issue #790)
- fix(slash-commands): PC版 Codex タブの composer で先頭 `$` を入力しても slash command palette が開かなかった問題を修正（#790 で `$NAME` 表記化したが trigger 側が未対応だった）。`cliToolId === 'codex'` のときのみ先頭 `$` で palette を開くよう trigger 条件を拡張し、他タブでは `$` を通常文字として扱い誤発火を回避。既存 `/` trigger は不変 (Issue #799)
- fix(slash-commands): 同名の `.claude/commands/*.md`（`cliTools: undefined`）が `deduplicateByName` で Codex skill を上書きし、その後 `filterCommandsByCliTool` で Claude 専用エントリが Codex タブから除外されて Codex palette からスキルが消える問題を修正。dedup マップのキーを `name` 単独から **`name + cliTools`** に変更し、CLI tool スコープが異なるエントリは共存、name と cliTool スコープが完全一致する場合のみ重複排除（後勝ち）するよう変更 (Issue #800)

## [0.6.0] - 2026-06-02

### Added (v0.6.0 リリース準備)
- feat(branding): favicon を `apple-icon.png` ソースに 32/96/192 px 3 サイズ生成（タイトクロップ）。`src/app/icon.png` (32×32) のキャラクター描画領域が canvas の ~50% しか占めず透明パディングが多いためブラウザタブで小さく見える UX 問題を解消。方式A（ファイル規約のみ、`layout.tsx` 無改修）採用 — Next.js 14.2.35 では `metadata.icons` 設定が file-based icon を上書きするため `apple-touch-icon` 喪失リスクを回避 (Issue #753)
- feat(layout): PC版 `DesktopHeader` の per-agent indicator を **icon-only + hover Tooltip** から **インライン常時テキスト** `<icon> ${AgentName}: ${StatusLabel}` に変更（`● Claude: Ready  ⟳ Codex: Running`）。Tooltip wrapper と未使用 `import { Tooltip }` を撤去、dot/spinner icon をテキストの左に first child span として配置 (Issue #751)

### Refactored (v0.6.0 リリース準備)
- refactor(worktree): `WorktreeDetailRefactored.tsx` を責務別に分割（2205 → **610 行**、-1595）。`useWorktreeDetailController` (1489行) / `usePendingInsertText` (116行) hook と `WorktreeDetailDesktop.tsx` (696行) / `WorktreeDetailMobile.tsx` (368行) component に抽出。TODO:[D1-001] 解消、`useFileOperations.ts` の `MoveTarget` 型を export、`tests/integration/issue-278-acceptance.test.ts` pre-existing 2 FAIL を 10/10 に解消。新規 `usePendingInsertText.test.tsx` 10 tests pass (Issue #755)
- refactor(terminal): `TerminalSplitPaneContent` Props を **27 個 → 13 個**にドメイン別型分割。`src/types/terminal-split-pane.ts` 新設に `TerminalSplitPaneCoreProps` / `SplitAutoYesProps` / `HistoryPaneProps` を export、`autoYes` / `history` を nested 型で受け取り。`AutoYesToggleParams` を `src/types/auto-yes.ts` に抽出して TSX → 非 TSX module へ移動（`tsconfig.server.json` の TS6142 回避） (Issue #756)
- refactor(cli): `CLI_TOOL_IDS` 配列の重複定義を `src/lib/cli-tools/types.ts` の単一ソースに統合し、`src/cli/config/cli-tool-ids.ts` から re-export（参照同一性保証） (Issue #757)
- refactor(config): timeout/delay の magic number 約 44 箇所を新規 3 config (`cli-tool-timing-config.ts` / `ui-feedback-config.ts` / `external-apps-config.ts`) + 既存拡張に集約。値保存監査全 44 対で全件一致確認 (Issue #760)
- refactor(fullscreen): `useFullscreen.ts` の `@ts-expect-error` 19 個クラスタを `src/lib/browser-compat/fullscreen-api.ts` の互換ラッパー 4 関数に抽出 (Issue #763)

### Documentation (v0.6.0 リリース準備)
- docs(history): `docs/implementation-history.md` および `docs/en/implementation-history.md` に #723〜#754 の約 30 件のエントリを Issue 別テーブル形式で追記 (Issue #758)
- docs(architecture): `docs/architecture.md` および `docs/en/architecture.md` に §6 UI Layout Architecture (#727/#730) / §7.1 TerminalSplits Strategy (#728/#744) / §X Per-agent Status Architecture (#743/#749/#751) の主要章を追記（Mermaid 図 + Issue 内部リンク） (Issue #759)
- docs(cleanup): `docs/` 配下の過去 Issue 参照 (#4, #31, #69, #80, #600 等) を 3 分類で棚卸し。`DEFAULT_SELECTED_AGENTS` / `MAX_FILE_TABS` 5→30 をコードと整合、migration の「#80完了後」前提を除去、en/UI_UX_GUIDE を #730 後の 3 カラム構成へ同期、エージェント 2→2〜4 を MIN=2/MAX=4 に統一。markdown-link-check リンク切れ 0 (Issue #767)

### Chore (v0.6.0 リリース準備)
- chore(test): `tests/` 配下の `.skip` / `.only` を棚卸し（5 件復活 / 2 件削除）。`it.only` / `describe.only` 残留 0 件 (Issue #764)
- chore(lint): プロジェクト全体の `eslint-disable` コメントを棚卸し。`any` → `unknown` / 適切な型への置換、依存配列の明示化を 14 ファイルに適用。`.eslintrc.json` 調整。テスト 6778 pass (Issue #765)

### Fixed
- fix(terminal): PC版の各ターミナル split header に AIエージェント status indicator（dot/スピナー）を復活（#728 で per-split header 構造移行時に取りこぼされていた、#740 と同型の「移行漏れ」パターン）。`TerminalSplitPaneContent.tsx` に optional `cliStatus?: BranchStatus` prop（未指定時 `'idle'` フォールバック）を追加し、`SIDEBAR_STATUS_CONFIG[cliStatus]` から解決した status indicator を `useMemo`（依存 `statusConfig.type`/`className`/`label`/`splitIndex`）で生成して既存 `headerExtras` slot に配線。Mobile 正準（`WorktreeDetailRefactored.tsx:1947-1974`）と同じインライン span（spinner=`animate-spin border-2 border-t-transparent`、dot=`rounded-full`）・`title` のみの a11y・`data-testid="split-status-indicator-${splitIndex}"` を踏襲。データは親 `WorktreeDetailRefactored` の `renderSplitPane` で `deriveCliStatus(worktree?.sessionStatusByCli?.[paneCli])` を導出し、**memo 境界を越えるのは導出済み `BranchStatus` 文字列のみ**（status 不変のポーリング周期では split を再renderしない memo-safe 設計／S3-001）。Mobile 経路（L1947-1974）は無改修 (Issue #743)
- fix(terminal): PC版の各ターミナル split footer に `AutoYesToggle` を復活（#728 で per-split footer 移行時に取りこぼされていた）。CLI 単位で独立した Auto-Yes ON/OFF 操作を可能化。`WorktreeDetailRefactored.tsx` の `handleAutoYesToggle` を `makeAutoYesToggleHandler(cliToolId)`（`useCallback`、依存 `worktreeId` で安定参照）にパラメータ化し、API body の `cliToolId` と `setAutoYesStateMap` のキーを引数値に変更。Mobile 経路（L1897-1904）は `makeAutoYesToggleHandler(activeCliTab)` の薄いラッパで従来どおり動作。`TerminalSplitPaneContent` に `autoYesExpiresAt` / `lastAutoResponse` / `onAutoYesToggle` props を追加し footer 先頭で `<AutoYesToggle cliToolName={cliToolId} inline />` を描画。状態は親の per-CLI `autoYesStateMap` を単一の真実源とし、`renderSplitPane` で各 split に per-CLI 値を配布。client-side auto-response は per-split 化せず #501 サーバー poller に委譲。`showPrompt = prompt.visible && !autoYesEnabled` の既存挙動・split0→activeCliTab 同期は維持 (Issue #740)

### Added
- feat(layout): PC版 `DesktopHeader` 右側（worktree status dropdown の左）に **per-agent（CLI 単位）session status indicator row** を追加。`selectedAgents` 各エージェントの状態（idle=グレーdot / ready=緑dot / waiting=黄dot / running・generating=青スピナー、`SIDEBAR_STATUS_CONFIG` 準拠）を並べて表示し、3 split 表示中でも全 agent の状態を一目で把握可能に。クリックで `activeCliTab` を該当 CLI に切替（`onActiveCliTabChange(cliId)`）、active indicator は `bg-cyan-100 dark:bg-cyan-900/30` + `aria-pressed` で強調、hover で `Tooltip`（content=`${displayName}: ${label}`, placement=bottom）。`WorktreeDetailSubComponents.tsx` の `DesktopHeader` に 4 つの **optional** props（`sessionStatusByCli` / `selectedAgents` / `activeCliTab` / `onActiveCliTabChange`）を追加し、`WorktreeDetailRefactored.tsx` の呼び出しから配線。導出は既存 `deriveCliStatus`/`SIDEBAR_STATUS_CONFIG` を再利用（新規導出ロジックなし）、内側 status span は `title` のみ（`role="status"` なし＝ポーリング毎の多重読み上げ回避）。左側の worktree-level status dot（`DESKTOP_STATUS_CONFIG`）は無改修・別系統として併存。全 props optional のため既存呼び出し元・既存テストは無改修、props 未指定時（Mobile 経路含む）は row 非描画で後方互換（`data-testid="desktop-agent-status-row"` / `desktop-agent-status-${cliId}`） (Issue #749)
- feat(terminal): PC版で `HistoryPane` を各ターミナル split（1-3 split、#728）内に内包し、各 split がその split の `cliToolId` のメッセージのみを**同時に**表示（A=Claude / B=Codex で各々の履歴を並列表示）。新フック `src/hooks/useSplitMessages.ts` を新設し、各 split が自分の `cliToolId` で `/api/worktrees/[id]/messages?cliTool=<id>&limit=<n>&includeArchived=<bool>` を独立 fetch（`useTerminalPanePolling` 同型：requestId stale-guard ＋ visibilitychange pause ＋ `refresh()`、API/DB は既存対応で backend 変更なし）。`state.messages` は `fetchMessages` が activeCliTab でサーバ側フィルタ済みのため split 並列表示には流用不可、という制約への対応。検索ハイライトは `src/lib/terminal-highlight.ts` に `makeHistoryNamespace(splitIndex)` ファクトリを追加し `history-search-${splitIndex}` 等へ per-split 化（`CSS.highlights` グローバルレジストリの上書き衝突を回避）、`src/app/globals.css` に split 0-2 分の `::highlight()` rule を静的追加（MAX_SPLITS=3）。`HistoryPane` に additive な `splitIndex?` / `cliToolId?` props（splitIndex 指定時のみ per-split namespace 使用、未指定時は従来の `HISTORY_SEARCH_NAMESPACE` 動作）、`TerminalSplitPaneContent` に `onFilePathClick` / `showToast` / `onHistoryInsertToMessage`（splitIndex 直指定ルーティング／S3-005）/ `showArchived` / `historyDisplayLimit` / `historyUserOnly` 等の props を追加。メッセージ送信後はその split の `useSplitMessages.refresh()` を呼ぶ（S1-006）。`applyHistoryHighlights` / `clearHistoryHighlights` は optional `namespace` 引数を additive 追加（default=`HISTORY_SEARCH_NAMESPACE`）。全変更は additive（optional props）で Mobile 経路（`WorktreeDetailRefactored.tsx:1947-1974` 周辺）と既存テストを無改修維持 (Issue #744)
- test(e2e): #728 AC-27 を Playwright e2e で機械検証。`tests/e2e/terminal-split-resizer-cursor.spec.ts`（PaneResizer 複数インスタンス並存下での drag 後 cursor 非残留）と `tests/e2e/terminal-split-cross-worktree-persistence.spec.ts`（`commandmate:terminalSplits:{worktreeId}` の worktreeId スコープ永続化＝cross-worktree 分離）を新規追加。chromium 限定（`beforeEach` 内 `testInfo.project.name` self-skip で Mobile Safari を除外、`playwright.config.ts` は無変更）、`test.use` で 1920×1080 viewport を spec ローカル指定。フィクスチャ `tests/e2e/fixtures/terminal-split-helpers.ts` は `page.route` による worktree API モック（DB/git/tmux セッション非依存で split UI を描画）＋ sessionStorage ガード付き localStorage 隔離（一意 worktreeId `e2e-split-a/b`）を提供 (Issue #735)
- test(terminal): `src/components/worktree/TerminalContainer.tsx` の History 展開ボタン（`aria-label="Expand history panel"`）に `data-testid="history-pane-expand"` を付与（e2e 用、純 additive・ランタイム挙動不変） (Issue #735)
- feat(terminal): add PC terminal 1-3 horizontal split with per-split CLI selector and MessageInput (#728)
- Layout (PC): **カスタム Tooltip** コンポーネント `src/components/common/Tooltip.tsx` を新設。`TOOLTIP_DELAY_MS = 100` の即時表示、ダークテーマ（`bg-gray-900` / `text-gray-100`）、`placement=top/right/bottom/left`、`role="tooltip"` + `aria-hidden="true"`（`aria-label` 重複読み上げ回避）、wrapper `<span>` の `tabIndex={-1}`、`useEffect` cleanup で `clearTimeout`、`React.cloneElement` を使わず ref/onClick/onKeyDown を透過する設計 (Issue #730)
- Layout (PC): **TerminalContainer** コンポーネント `src/components/worktree/TerminalContainer.tsx` を新設。History + Terminal+FilePanel を内包する親コンテナ。`HISTORY_PANE_ID = 'worktree-history-pane'` を `WorktreeDesktopLayout` から移管・export。`useHistoryPaneState` で visible/width/toggle/setWidth を管理、可視時は History wrapper div + PaneResizer、非表示時は expand bar（`aria-controls=HISTORY_PANE_ID`）、History/Terminal をそれぞれ `ErrorBoundary` で包含 (Issue #730)
- Hook: `useHistoryPaneState` に `commandmate:historyPaneStateChange` CustomEvent broadcaster を追加。同一 window 内で `WorktreeDetailRefactored`（HistoryPane onCollapse 用）と `TerminalContainer`（render 用）の 2 instance の visible/width 状態を同期 (Issue #730)
- Layout (PC): VS Code 風 **Activity Bar** + History 独立カラムを導入。`ActivityBar.tsx` / `ActivityPane.tsx` / `useActivityBarState.ts` / `useHistoryPaneState.ts` / `activity-bar-config.ts` を新設。6 Activity（Files/Git/Notes/Schedules/Agent/Timer）、ArrowUp/Down/Home/End/Enter/Space キーボード対応、`role="tablist"` + `aria-orientation="vertical"` + `aria-selected` + `aria-label` + `aria-controls="worktree-activity-pane"`。History pane は `<` / `>` 折りたたみ + ドラッグリサイズ。`commandmate.worktree.activeActivity` / `historyVisible` / `historyWidth` を localStorage 永続化 (Issue #727)
- Deep link: `?pane=git|notes|logs|agent|timer|files|history` を新 Activity 体系へマッピングするため `useWorktreeTabState.toActivityId()` を追加。`logs → schedules` リネーム、`history/terminal/info → null` (Issue #727)
- API: `GET /api/worktrees/:id/files/:path?startLine=N&endLine=M` 行範囲モードを追加。行範囲モード時は `If-Modified-Since` をスキップして常に 200 を返す。レスポンス JSON に `totalLines` / `totalBytes` / `encoding` / `range` のオプショナルメタを追加（`FileContent` 型拡張、後方互換） (Issue #723)
- i18n: `fileTooLarge.editableLimit` / `fileTooLarge.viewerLimit` を `locales/ja/error.json` / `locales/en/error.json` に追加 (Issue #723)
- History: HistoryPaneヘッダーに「User only」フィルタトグルを追加。トグルON時はAssistantメッセージとorphanペアを非表示にし、検索もuser roleのみに絞る。localStorage（`commandmate:historyUserOnly`, `'true'`/`'false'`）で永続化、aria-pressed準拠、lucide-react `User`/`UserCheck` アイコン、PC/モバイル両経路（MobileContent）に対応 (Issue #725)

### Changed
- feat(layout): PC版のサイドバートグル（ハンバーガー ☰）を `DesktopHeader` 左端から **`ActivityBar` 最上部**へ移動（VS Code 風の「縦の ActivityBar 系操作＝サイドバー表示制御」メンタルモデルに統一）。`ActivityBar.tsx` は `useSidebarContext()` で `isOpen`/`toggle` を取得し、トグルを `role="tablist"` の**外側**に配置（既存の roving-tabindex Arrow/Home/End ナビと WAI-ARIA tab 数に非干渉）、`Tooltip content="Toggle sidebar"`・`data-testid="activity-bar-toggle-sidebar"`・`aria-label`/`aria-expanded`・separator を追加。`WorktreeDetailSubComponents.tsx` の `DesktopHeader` からハンバーガー＋区切り線を物理削除し `onMenuClick` を optional 化、`WorktreeDetailRefactored.tsx` から `onMenuClick={toggle}` と未使用化した `toggle` 分割代入を除去。モバイル経路（`MobileHeader`/`openMobileDrawer`）は無改修 (Issue #747)
- refactor(terminal): PC版で top-level の History カラムを撤去（History は各ターミナル split 内へ移管／Issue #744）。`TerminalContainer.tsx` の `history` prop を optional 化し、未指定時（PC default）は terminal エリアのみを描画（`useHistoryPaneState`/`HISTORY_PANE_ID`/expand bar・PaneResizer は history 提供時のみ＝後方互換）。`WorktreeDetailRefactored.tsx` から `historyPaneMemo` と `HistoryPane`/`useHistoryPaneState`(top-level) import を削除し、`<TerminalContainer terminal={rightPaneSplitMemo} />` へ簡素化。`renderSplitPane` で各 split に History 表示系 props（`historyUserOnly`/`historyDisplayLimit`/`showArchived` 共通値、`onFilePathClick`/`showToast`、splitIndex 直指定の `onHistoryInsertToMessage`）を配布。`#735` の `data-testid="history-pane-expand"` は history 提供時のみ残置（PC default では非描画）。Mobile 経路は `MobileContent` 内の HistoryPane を継続使用で無改修 (Issue #744)
- refactor(terminal): `state.terminal.*` reducer slice を完全削除し、Mobile 経路を `useTerminalPanePolling` に移行（#728 R3-007 + R3-010）。`WorktreeDetailSubComponents.tsx` に `MobileTerminalTab`（terminal タブ表示時のみ hook をマウント、cliToolId 変化で self-reset）を新設し、`MobileContent` の `terminalOutput`/`isTerminalActive`/`isThinking`/`autoScroll`/`onScrollChange` props を `cliToolId` 1 本に置換。`src/types/ui-state.ts` から `TerminalState` 型 / `initialTerminalState` / `WorktreeUIState.terminal`、`src/types/ui-actions.ts` から `SET_TERMINAL_OUTPUT`/`SET_TERMINAL_ACTIVE`/`SET_TERMINAL_THINKING`/`SET_AUTO_SCROLL` + 未使用の複合 action `START_WAITING_FOR_RESPONSE`/`RESPONSE_RECEIVED`/`SESSION_ENDED`、`useWorktreeUIState.ts` から対応する reducer case / action creator / `WorktreeUIActions` member を削除。`WorktreeDetailRefactored.tsx` 親側の terminal 参照を移行（親ポーリング cadence gate と `MessageInput isSessionRunning` を `worktree.sessionStatusByCli[activeCliTab].isRunning` 由来に切替、`fetchCurrentOutput` の terminal 書き込み除去・prompt/selection/Auto-Yes は維持、worktreeId reset / CLI タブ切替 / `handleKillConfirm` の terminal リセットと未使用 `handleAutoScrollChange` を除去）。PC 経路の挙動は不変。`WorktreeDetailRefactored-cli-tab-switching.test.tsx` を `useTerminalPanePolling` モックベースに完全書き直し（R3-010、CLI 切替時の hook re-key を明示検証）、`useWorktreeUIState.test.ts` の terminal slice / 複合 action assertion を削除・slice 不在の回帰テストを追加 (Issue #736)
- Layout (PC): `WorktreeDesktopLayout` を 4 カラム→**2 カラム**（ActivityPane + Right=TerminalContainer）に簡素化。`activityBar` / `historyPane` / `historyPaneCollapsed` / `onToggleHistoryPane` / `onHistoryPaneResize` / `historyPaneWidth` props を削除。`HISTORY_PANE_ID` は `TerminalContainer` に移管。dead code だった `MobileLayout` fallback（`useIsMobile=true` 時は `WorktreeDetailRefactored.tsx:1700` の `MobileContent` 分岐済みのため非経由）を削除。ファイル行数 437→145 (Issue #730)
- Layout (PC): `WorktreeDetailRefactored` の JSX 構造を再構成。`ActivityBar` を `WorktreeDesktopLayout` の外側に配置し、Header の下から画面下端まで貫通する VS Code 流レイアウトに変更。`WorktreeDesktopLayout` の `rightPane` に `<TerminalContainer history={historyPaneMemo} terminal={rightPaneMemo}/>` を渡す構造へ (Issue #730)
- Layout (PC): `ActivityBar` の各 `<button>` から `title` 属性を削除し、新しい `Tooltip` コンポーネントでラップ。`aria-label` は維持。`buttonRefs` は `<button>` への ref を継続付与（ref 透過のため `ArrowUp/Down/Home/End` キーボードナビは無変更で動作）(Issue #730)
- Hook: `useHistoryPaneState` の `DEFAULT_HISTORY_WIDTH` を **25 → 40** に変更。percent 基準が「`WorktreeDesktopLayout` 全体」から「`TerminalContainer` 内 (Right Pane)」に変わるための補正 (Issue #730)
- Layout (PC): `WorktreeDesktopLayout` を 2 カラム→**4 カラム**（`[ActivityBar 48px] + ActivityPane + History + Right`）に再構成。`leftPane` props を廃止し `activityBar` / `activityPane` / `historyPane` / `rightPane` 構造へ。`ResizableColumn` ヘルパーで activity/history カラム JSX を dedup。モバイル時は 2-pane swipe へ縮退 (Issue #727)
- WorktreeDetailRefactored: 旧 `leftPaneMemo`（38 deps、Issue #411 R3-007）を `activityBarMemo` / `activityContent` / `activityPaneMemo` / `historyPaneMemo` に分割。各 memo にメンテナンスコメント付与。`useFilePolling` の `enabled` 条件を `state.layout.leftPaneTab === 'files'` → `activeActivity === 'files'` に置換 (Issue #727)
- HistoryPane: `onCollapse` props 追加、ヘッダー右端に `<` 折りたたみボタン追加 (Issue #727)
- Config: `TEXT_MAX_SIZE_BYTES` を 1MB → **2MB** に引き上げ。`.md` / `.yaml` / `.yml` の PUT/GET 共通定数として一元化 (Issue #723)
- FileViewer: 検索ロジックを `useFileContentSearch` に統一（旧 `content.split('\n')` + 同期 `toLowerCase().includes` のインライン実装を撤去） (Issue #723)
- History: HistoryPaneのUser/Assistant視覚優先度を改善。Assistantメッセージのデフォルト折りたたみを2行/100文字に強化（COLLAPSED_MAX_LINES: 5→2、COLLAPSED_MAX_CHARS: 300→100）、Assistantスタイル弱化（text-xs/p-2/bg-gray-900/30、space-y-2）、User側コンテナに防御セット（`[word-break:break-word]` `max-w-full` `overflow-x-hidden`）追加 (Issue #725)

### Removed
- `WorktreeDesktopLayout.tsx` 内の `MobileLayout` コンポーネント定義と `HistoryExpandBar` を削除（dead code: `WorktreeDetailRefactored.tsx:1700` で `MobileContent` 分岐済みのため `WorktreeDesktopLayout` を経由しない）。関連テスト `tests/unit/components/WorktreeDesktopLayout.test.tsx` の Mobile fallback ブロックも削除 (Issue #730)
- `src/components/worktree/LeftPaneTabSwitcher.tsx` を削除（Activity Bar に置換）。関連テスト `tests/unit/components/worktree/LeftPaneTabSwitcher.test.tsx` / `tests/unit/types/left-pane-tab.test.ts` も削除 (Issue #727)
- PC 版 History ペイン内の `Message | Git` サブタブ UI を除去（Git は独立 Activity に昇格）。`historySubTab` ローカル state はモバイル経路 `MobileContent` props 伝播のため残置 (Issue #727)

### Performance
- FilePanel: 大規模ファイルでPC版がハングする問題に対するハイブリッド対応（行ベースAPI ＋ `@tanstack/react-virtual` 仮想化 ＋ 編集系2MBサイズ上限）。CodeViewer は `useVirtualizer` で可視範囲＋オーバースキャンのみマウントし、行範囲モード（`startLine`/`endLine` クエリ）でチャンク取得・ハイライトキャッシュを実装。サーバ側は `readFileLineRange` で `createReadStream`＋`readline` ストリーミング（メモリ O(チャンク)）。`useFileContentSearch` に debounce 300ms＋最小2文字、`useFileContentPolling` に大ファイル時無効化（`POLLING_DISABLED_THRESHOLD_BYTES = 1MB`）を追加 (Issue #723)

### Fixed
- Terminal (PC): ターミナル分割を `+Split` で増やした後 `-Split` で戻すと、本来全幅に戻るべきターミナルが 50% 幅で残り右側が空きスペースになる問題を修正（#728 follow-up）。`useTerminalSplits` の `removeSplit` が末尾 width を切り捨てるだけで再正規化せず合計が 1.0 未満（例 `[0.5,0.5]`→`[0.5]`）となり、CSS `flex-grow` 合計 < 1 で free space が配分されないことが原因。`normalizeWidths` ヘルパーを追加し `removeSplit` 後とロード時（`isValidSplitConfig` 通過後）に widths を比率保持のまま合計 1.0 へ正規化。既存ユーザーの localStorage に残った不正状態（`widths=[0.5]` 等）もロード時に自己回復。`widthsValid`/`isValidSplitConfig` の仕様・モバイル経路・公開 API は無変更 (Issue #739)
- Layout (PC): `min-w-0` 欠落により PC 版でファイル選択時に FilePanel が viewport 外へ押し出され隠れる問題を修正（#730 follow-up）。`WorktreeDetailRefactored.tsx` の外側 2 flex コンテナ（L1740 主因 / L1763 防御的補強）に `min-w-0` を追記し、Flexbox の `min-width: auto` 既定によって flex item がコンテンツ最小幅以下に縮まずレイアウトが viewport を超えて膨張する問題を解消。CSS クラス追記のみでロジック・props・公開API・モバイル経路は無変更 (Issue #732)

### Breaking Changes
- **Layout (PC) BREAKING (Issue #730)**: PC デスクトップで `ActivityBar` が `WorktreeDesktopLayout` の外側に出て VS Code 風に全高貫通（Header の下から画面下端まで）し、History が `TerminalContainer` 内の左サブパネルに移動します。視覚的な影響:
  - `?pane=history` deep link の History 表示位置が「画面中央の独立列」→「画面右端 Terminal 領域内」に変わります（表示の意味は維持されます）
  - `DEFAULT_HISTORY_WIDTH` の意味が「`WorktreeDesktopLayout` 全体に対する %」→「`TerminalContainer` 内 Right Pane に対する %」に変わり、既定値も 25 → **40** に変更。既存ユーザの localStorage 値（25 等）はそのまま使われ続けるため、初回は狭めに見える可能性あり
  - `WorktreeDesktopLayout` の props API が破壊的に変更: `activityBar` / `historyPane` / `historyPaneCollapsed` / `onToggleHistoryPane` / `onHistoryPaneResize` / `historyPaneWidth` の 6 props を削除。残る公開 props は `activityPane` / `rightPane` / `activityPaneWidth` / `onActivityPaneResize` / `minPaneWidth` / `maxPaneWidth`
  - モバイル経路は変更なし（`MobileContent` 経由のまま）。詳細仕様: Issue #730
- **Layout (PC) BREAKING**: PC デスクトップの左パネルが「History/Files/CMATE タブ式 2 カラム」から「Activity Bar + Activity Pane + History 独立カラム + Right の 4 カラム」へ視覚的に変更されます。モバイル経路（`GlobalMobileNav` / `WorktreeDetailSubComponents` / `NotesAndLogsPane`）は変更なし。旧 localStorage キー `commandmate.worktree.leftPaneCollapsed` は読み捨て（マイグレーション処理なし）。詳細仕様: Issue #727
- 編集系ファイルの GET 事前ガード追加: `.md` / `.yaml` / `.yml` の GET 上限が新規 **2MB** になりました。
  - 2MB 以下: 従来通り開け、保存も可能（改善: 旧来 1MB 超は PUT 失敗していたが 1〜2MB 帯が保存可能に）。
  - 2MB 超: GET 時点で `FILE_TOO_LARGE` (HTTP 413) を返却し、ファイルが開けなくなります。
  - 既にタブで開いている 2MB 超ファイルは、ポーリング再フェッチ時に 413 を受け取り、エラー表示に切り替わります。
  - HTML (`.html` / `.htm`) は本変更の対象外で、既存 5MB ガード（Issue #490）を維持します。
  - 2MB 超の編集系を扱う必要がある場合は、ファイル分割または将来の閲覧専用モードフォールバック（別 Issue で検討）をご利用ください (Issue #723)

## [0.5.8] - 2026-05-28

### Added
- History: Worktree詳細 HistoryPaneにメッセージテキスト検索機能を追加（名前空間分離CSS Custom Highlight API、debounce/最小2文字/最大500件） (Issue #716)
- History: 履歴(History)表示件数を50〜250件で選択可能にする（HistoryDisplayLimitセレクタ・localStorage永続化） (Issue #701)

### Fixed
- Executor: execFile maxBufferエラー（ERR_CHILD_PROCESS_STDIO_MAXBUFFER）の診断ログを改善し上限を10MBに引き上げ (Issue #719)
- Files: ファイルツリー再フェッチ時のスクロール位置を保持（非破壊的refetch indicator・retryボタン追加） (Issue #706)
- Detection: Claude Code v2.1.142 スキル承認プロンプトの末尾サマリ行（"… +1 pending"）の誤検出を修正（SUMMARY_LINE_PATTERN/フッタトリミングの多層防御） (Issue #704)

### Performance
- DB: chat_messagesにrole列を含む複合インデックス（idx_messages_worktree_role_archived_time）を追加し相関サブクエリの線形劣化を解消（Migration v32） (Issue #708)
- Sidebar: useWorktreesCacheをWorktreesCacheProvider Context経由に統合しポーリングの二重起動を解消 (Issue #709)
- Sidebar: active/idle遷移時のポーリング間隔（5s/30s）をアダプティブに更新するよう修正 (Issue #710)
- Sync: scanMultipleRepositoriesをPromise.allSettledで並列化しsync APIのスケーラビリティを改善 (Issue #711)

## [0.5.7] - 2026-05-11

### Added
- Worktree: PC版Worktree詳細ビューに左パネル折りたたみ機能を追加 (Issue #688)
- Repository: サイドバー表示制御用のリポジトリ可視性トグルを追加 (Issue #690)
- MessageHistory: メッセージタイムスタンプに日付+時刻を表示 (Issue #687)
- CLI: STANDARD_COMMANDSを最新のClaude CodeおよびCodexコマンドに更新 (Issue #689)

### Fixed
- Sidebar: ブランチホバー時のリスト並び替えフラッシュを解消（useDeferredValue + ref-only freeze方式） (Issue #699)
- Sidebar: リポジトリグループ順序をキャッシュしてホバー時の並び替えを防止 (Issue #699)
- Sidebar: ブランチクリック後のツールチップ表示によるリスト再描画チラつきを抑制 (Issue #699)
- Sidebar: startTransitionでポーリング更新をラップしフラッシュを防止 (Issue #699)
- Sidebar: ドキュメントクリック時に古いツールチップを閉じるよう修正 (Issue #699)
- Sidebar: 選択済みブランチのスタックしたツールチップをリセット (Issue #699)
- Worktree: 狭い幅でのパネルトグルUXを改善しファイルパネル折りたたみを追加 (Issue #698)
- HtmlPreview: 未使用のonDirtyChange propを除去しリグレッションテストを追加 (Issue #681)
- Tests: クロステスト汚染によるBranchListItemツールチップテスト失敗を修正

### Refactored
- FileTab: useFileTabsの戻り値を[state, actions]タプル形式に変更 (Issue #683)
- Sidebar: サイドバー可視性ヘルパーを抽出しact()警告を修正 (Issue #690)

## [0.5.6] - 2026-04-27

### Added
- PDF: PDFファイルプレビュー機能を追加（Blob URL + iframe sandbox方式） (Issue #673)

### Fixed
- PDF: 実際のChrome（デスクトップ・モバイル）でPDFプレビューが動作するよう修正 (Issue #673)
- Sidebar: ブランチ切り替え時にツールチップが固定表示される問題を修正 (Issue #676)
- Worktree: 再レンダリングループによってworktree URL更新がブロックされる問題を修正 (Issue #675)
- Proxy: External AppsへのWebSocket upgradeをプロキシで中継するよう修正 (Issue #671)
- Proxy: プロキシ応答から `content-encoding` / `content-length` ヘッダを除去

### Refactored
- PDF: `normalizeExtension` の共有化と冗長コメントの整理 (Issue #673)

## [0.5.5] - 2026-04-17

### Added
- Assistant: Home画面に非インタラクティブなClaude/Codex対応のアシスタントチャット機能を追加 (Issue #649)
- Assistant: 専用Chatタブを追加し、commandmate CLI起動とスクリプト起動をコンテキストで区別 (Issue #649)
- Sidebar: PC用サイドバーをw-56にコンパクト化しツールチップで詳細表示 (Issue #651)
- Sidebar: ブランチ間ナビゲーション時にスクロール位置を保持 (Issue #651)
- Sidebar: ブランチツールチップで説明文全文を表示 (Issue #651)
- Sidebar: サイドバー背景の差別化とDnDによるグループ並び替えを追加 (Issue #651)
- Memo: CMATE Notesの上限を5件から10件に拡張 (Issue #652)

### Fixed
- Assistant: ドロップダウンの高さを揃えコントロール配置を修正 (Issue #649)
- Sidebar: コンパクト化後のリサイズ・ツールチップ・オーバーフロー問題を修正 (Issue #651)
- Sidebar: ドラッグリサイズのラグとグループヘッダー下線を除去 (Issue #651)
- Sidebar: ブランチ高速クリック時のフルページリロードを防止 (Issue #651)
- Sidebar: アンマウント時にフォールバックタイマーをキャンセル (Issue #651)
- Sidebar: フルページリロードを誘発していたフォールバックタイマーを除去 (Issue #651)
- Sidebar: group-orderルートに dynamic export を追加し静的キャッシュを回避 (Issue #651)

### Refactored
- Assistant: インストール済みツールAPIを追加しCLIツールセレクタのUXを改善 (Issue #649)
- Sidebar: BranchTooltipサブコンポーネントを抽出し保守性コメントを整理 (Issue #651)
- Memo: MemoPaneのimport順を統一 (Issue #652)

### Style
- Assistant: AssistantChatPanelのUIレイアウトとビジュアルデザインを調整 (Issue #649)

### Tests
- Assistant: Chatタブおよびcontext-builder変更に合わせて既存テストを更新 (Issue #649)

## [0.5.4] - 2026-04-12

### Added
- Editor: YAMLファイル編集と拡張子選択ダイアログを追加 (Issue #646)
- DB: リポジトリにdisplay_name（カスタム別名）を追加 (Issue #642)
- Markdown: HTML imgタグの相対パスとwidth/height属性をサポート
- Upload: 画像アップロード上限を20MBに引き上げ、マークダウンビューアで相対画像パスを解決

### Fixed
- Detection: React error #31 と Claude `/model` 選択リスト検出を修正 (Issue #648)

### Refactored
- Editor: ファイル編集機能のコード品質改善 (Issue #646)
- Repository: display_name保存時のエラーメッセージ解決ロジックの重複排除 (Issue #644)

### Tests
- Test: ファイルサイズテストを5MBから20MBに更新し設定変更に追従

## [0.5.3] - 2026-04-05

### Added
- Report: レポート生成ステータスをUIとCLIで可視化 (Issue #638)
- CLI: `report` コマンドを追加（日次レポートの生成・表示・一覧表示） (Issue #636)
- Report: 日次レポートのプロンプトにGitHub Issueコンテキストを追加 (Issue #630)
- Report: 日次レポート生成にコミットログ収集を追加 (Issue #627)

### Fixed
- Report: ステータスエンドポイントのdynamic renderingを強制 (Issue #638)
- Report: セクション別プロンプト長制限でcommit_logとissue_contextを保持 (Issue #634)
- Report: コミットログ収集前に無効なリポジトリをフィルタリング (Issue #632)
- Codex: daily summary生成にツール固有パーミッションを使用 (Issue #626)

### Refactored
- Utils: JSDocの関連付け修正とタイムアウトユーティリティの整理 (Issue #627)

## [0.5.2] - 2026-04-04

### Added
- Review: レポートテンプレート機能を追加し、CRUD API と 3 モード生成UIを実装 (Issue #618)
- Report: レポート本文のコピーボタンを追加

### Fixed
- Codex: `/model` Step 1 のモデル選択UIを selection list として検出 (Issue #622)
- Codex: `/model` 選択UIを waiting status として検出 (Issue #619)
- Detection: Codex Reasoning Level UI を `multiple_choice` prompt と `submitMode` 対応で処理

### Refactored
- Template API: 共有ヘルパーを抽出して重複を削減 (Issue #618)
- Prompt handling: `SubmitMode` バリデーションヘルパーを抽出して重複を削減 (Issue #616)

## [0.5.1] - 2026-04-02

### Added
- Report: ユーザー指示入力とUI改善 (Issue #612)
- Daily Summary: デイリーサマリー機能の実装 (Issue #607)
- Sessions: ソートオプションとメッセージプレビューを追加 (Issue #606)

### Fixed
- Sessions: デフォルトソートを「最終送信（新しい順）」に変更
- Sessions: 表示順をリポジトリ名→ブランチ名の順に変更
- Sidebar: セッションフラグからworktreeステータスを導出し、適応型ポーリングを追加 (Issue #608)
- Status: キャプチャ行数統一によりスピナーがreadyで停止する問題を修正 (Issue #604)

### Refactored
- Daily Summary / Sessions: ヘルパー関数を抽出し重複を削減
- Sessions: sanitizePreviewを共有configモジュールに抽出

## [0.5.0] - 2026-04-02

### Added
- UX Refresh: 5画面構成（Home / Sessions / Repositories / Review / More）への全面リニューアル (Issue #600)
  - Phase 1: Foundation（共通フック、キャッシュプロバイダー、レイアウト設定）
  - Phase 2: Screen framework（Sessions / Repositories / Review / More画面、モバイルグローバルナビ）
  - Phase 3: Deep link、API拡張、Review stalled検出
  - Phase 4: 統合・デモGIF更新・動画アップロード上限100MB
- UX: ステータスシステム刷新とReviewページフィルター (Issue #600)
- UI: WorktreeDetailHeaderにPC用Homeリンクを追加 (Issue #600)

### Fixed
- Worktree: stale CLI tab responsesのガード処理 (Issue #602)
- Gemini: ステータススピナーの不一致を修正
- Gemini: スラッシュコマンドの復元
- Commands: Codex共有スラッシュコマンドの表示修正
- CI: lint/テストエラーの修正 (Issue #600)

### Docs
- UX Refresh設計レポート・CLAUDE.md更新 (Issue #600)

## [0.4.16] - 2026-04-01

### Added
- Navigation: add Left/Right keys to NavigationButtons for Copilot TUI (Issue #592)

## [0.4.15] - 2026-03-31

### Added
- Schedule: allow Copilot model selection in CMATE schedule CLI Tool column (Issue #588)
- Schedule: add Copilot CLI permission flag support for CMATE schedules (Issue #584)
- Schedule: expose active schedule state
- Commands: add current-situation, cause-analysis commands and update orchestrate for bug workflow
- Commands: add Codex cross-review to multi-stage review commands

### Fixed
- Slash commands: prevent Copilot builtins from overriding Claude standard commands (Issue #586)
- Schedule: recover inactive schedule cron jobs
- Schedule: stop cron job when schedule is disabled via Enabled=false
- Commands: correct agent assignment rules in orchestrate command
- Scripts: add .env auto-loading to all shell scripts
- Schedule: add missing new files for Copilot model selection (Issue #588)

### Docs
- Add Copilot model selection syntax to CMATE schedules guide (ja/en)

## [0.4.14] - 2026-03-29

### Added
- CLI: `--model` option for `send` command to support Copilot model switching (Issue #576)
- Copilot: TUI response handling with deduplication and accumulated content saving (Issue #565)
  - `extractCopilotContentLines` / `normalizeCopilotLine` in tui-accumulator
  - Copilot-specific branching in response-extractor
  - Prompt deduplication with SHA-256 hash cache (`prompt-dedup.ts`)
  - Copilot timing constants (`copilot-constants.ts`)
- WSL2: Windows environment support with setup guide and troubleshooting (Issue #551)

### Fixed
- Copilot: extract latest response only in `cleanCopilotResponse` (Issue #571)
- Copilot: clean up History redundant display (Issue #571)
- Copilot: add TUI decoration skip patterns to `COPILOT_SKIP_PATTERNS` (Issue #565)
- Copilot: fix message sending, selection list detection, and pane size (Issue #565)
- tmux: set explicit window size on session creation to fix TUI display (Issue #565)
- Timer: show all tools including copilot in agent selector
- CLI: add copilot to `--agent` help text in send/respond/capture/auto-yes commands
- Test: mock `sendSpecialKey` in base.test.ts to prevent unhandled rejection

### Refactored
- Module split: split large modules into sub-files, Phase 1 (Issue #575)
- Security: unify security comment identifiers and strengthen input sanitization (Issue #574)
- Type safety: remove dangerous type casts and improve silent failure handling (Issue #573)
- DB: remove deprecated forwarding files and unify import paths (Issue #550)
- Copilot: improve naming clarity and remove redundant code
- Test: fix assertion format and indentation in ip-restriction tests
- Test: remove unused imports in db-toValidAppType test
- Test: use `vi.stubGlobal` for NODE_ENV assignment in api-client test

### Changed
- chore: bump vitest 4.1.1 → 4.1.2

## [0.4.13] - 2026-03-28

### Added
- Copilot: GitHub Copilot CLI tool support with gh-based command and 2-stage install check (Issue #545)
  - CopilotTool class, CLI_TOOL_IDS/display names updated to 6 tools
  - Copilot patterns, response cleaning, and completion detection
  - GH_DEBUG added to env-sanitizer sensitive keys
- Copilot: builtin slash commands (46 commands) and selection list detection (Issue #547)
  - COPILOT_SELECTION_LIST_PATTERN for detecting selection UIs
  - getCopilotBuiltinCommands() with 'builtin' source type
  - SELECTION_LIST_REASONS Set for unified selection list handling
- Worktree info: copy-to-clipboard for Path and Repository Path fields (Issue #552)
- Mobile: default to preview tab in mobile markdown viewer (Issue #549)

### Fixed
- Copilot: delegate slash commands to sendMessage for prompt-aware execution (Issue #559)
- Copilot: use sendKeys directly in terminal and send APIs to avoid waitForPrompt blocking
- Copilot: fix prompt detection pattern to match "❯ " with trailing hint text
- Copilot: improve thinking detection ("Esc to cancel") and selection list patterns
- Copilot: prevent /model text leaking into selection list search field
- Mobile: enable vertical scrolling on mobile file list (Issue #548)
- Mobile: fix file list overflow hidden behind input bar with increased paddingBottom
- Navigation: improve selection list button responsiveness with immediate refresh after key send

### Refactored
- Test: improve mobile overflow test robustness with MobileContent-anchored regex matching

## [0.4.12] - 2026-03-24

### Added
- Timer: delayed message sending feature with configurable delay times (Issue #534)
  - `timer-constants.ts` with dynamic delay generation
  - `timer-db.ts` with full CRUD operations and cursor-based pagination
  - `timer-manager.ts` with globalThis singleton and setTimeout management
  - Timer API route (POST/GET/DELETE) with security validations
  - `TimerPane.tsx` with countdown, polling, and visibilitychange support
  - Timer sub-tab in NotesAndLogsPane
- Timer: session check before timer execution with NO_SESSION status (Issue #539)
  - `isRunning()` check to detect no-session state
  - Session warning in POST API response and UI
- Timer: history limit, pagination, and automatic cleanup (Issue #540)
  - Cursor-based pagination with configurable limits
  - Automatic cleanup of old timers on startup (30-day retention)
  - Recovery of stuck sending timers
  - "Load more" and "Clear history" UI controls

### Fixed
- Timer: add agent selector to TimerPane registration form (#538)
- Timer: fix flaky cleanupOldTimers boundary test with fixed timestamps

### Refactored
- Timer: extract MAX_TIMER_MESSAGE_LENGTH and TIMER_COLUMNS constants for DRY compliance
- Timer: optimize stopTimersForWorktree to use in-memory map instead of DB query
- Timer: extract startIntervals/stopIntervals helpers in TimerPane to eliminate duplication

## [0.4.11] - 2026-03-21

### Added
- Auto-Yes: per-agent composite key support for independent Auto-Yes control per agent (Issue #525)
- Auto-Yes: per-agent UI controls with agent name display in AutoYesToggle
- Session history: retain message history after session clear with archived toggle (Issue #168)
  - Logical deletion (archived column) instead of physical DELETE
  - `showArchived` toggle in HistoryPane with localStorage persistence
- CLI: `/orchestrate` command for parallel issue development lifecycle
- CLI: `/pr-merge-pipeline` command for PR creation through merge automation
- CLI: `/uat-fix-loop` command for UAT failure repair cycle automation

### Fixed
- Sync: clean up orphaned tmux sessions when worktrees are deleted during sync (Issue #526)
- Auto-Yes: separate per-agent auto-yes state in UI to avoid stale display on tab switch
- Auto-Yes: fix disable-all to properly disable all agents (not just default claude)
- Test: make session-cleanup tests resilient to mock reset timing in CI
- bin/commandmate.js: add execute permission

### Refactored
- Logging: standardize logger action strings to `module:action` format
- Auto-Yes: extract `filterCompositeKeysByWorktree` shared utility for DRY compliance
- Auto-Yes: rename state/poller ID functions to `CompositeKeys` for naming clarity
- Release skill: use git worktree + commandmatedev delegation

## [0.4.10] - 2026-03-19

### Added
- CLI: implement base commands for agent orchestration — ls, send, wait, respond, capture, auto-yes (Issue #518)
- CLI: add sessionStatus to wait completion detection (Issue #520)
- Docs: CLI operations guide (Japanese and English)

### Fixed
- MARP: prevent slide reset on file content polling
- CLI: improve timeout and elapsed time display

## [0.4.9] - 2026-03-16

### Added
- Sidebar: branch sync button to sidebar header (Issue #506)
- Sidebar: colored folder icons for repository group headers (Issue #504)
- File panel: in-file link navigation and tab UI improvements (Issue #505)
- Mobile: open external links from HTML preview in new browser tab (Issue #505)

### Fixed
- Auto-Yes: prioritize prompt detection over thinking check
- Auto-Yes: prevent dual response and status instability (Issue #501)
- Auto-Yes: prevent client-side duplicate response when server poller is active
- File panel: tab overflow, dropdown click, and link handling issues (Issue #505)
- Markdown preview: stabilize DOM to make links clickable (Issue #505)
- Message list: stabilize ReactMarkdown plugin arrays and callback refs
- Sidebar: replace color dot with colored folder icon for repository identification
- Sync: include DB-registered repositories in worktree sync

### Performance
- Auto-Yes: implement 7-item polling performance improvements (Issue #499)

### Refactored
- Sidebar: improve parseGroupCollapsed testability and add comprehensive tests

## [0.4.8] - 2026-03-14

### Added
- HTML file rendering in file panel with sandboxed iframe preview (Issue #490)
  - `HtmlPreview` component with configurable sandbox levels
  - HTML extension detection config
- Insert-to-message from history and memo cards (Issue #485)
  - Copy content directly into message input from ConversationPairCard and MemoCard
- Codex custom skills loader from `.codex/skills/` directory (Issue #166)
  - Codex custom prompts and `.system` skills support
  - Slash command format utility

### Fixed
- Prompt detector: detect long confirmation prompts with commit messages
- Prompt detector: prevent diff line numbers from corrupting Codex prompt detection
- Status detector: detect Codex TUI idle prompt above padding gap
- Codex: improve TUI status detection and prompt detection
- HTML preview: force iframe re-mount on sandbox level change

## [0.4.7] - 2026-03-13

### Added
- OpenCode TUI selection list navigation support (Issue #473)
  - Detect prompt state in OpenCode TUI content area
  - NavigationButtons for TUI selection lists
- Image file attachment for message input (Issue #474)
  - Image attachment UI integrated into MessageInput
  - Mobile: split message input into two rows
- Claude CLI selection list prompt detection with NavigationButtons

### Fixed
- OpenCode: selection list pattern, mobile layout overlap, and button responsiveness
- Build: remove logger imports from auth.ts and selected-agents-validator (client bundle compatibility)
- Logger: fix remaining console.error in conversation-logger

### Refactored
- Logger: migrate console.log/warn/error to structured logger (#480)
- TODO/FIXME markers cleanup (#482)
- Large file splitting into smaller modules (Issue #479)
  - Phase 1: split schedule-manager, FileTreeView, MarkdownEditor
  - Phase 2: split 5 large files into smaller modules
  - Phase 3: split db.ts and response-poller.ts
- lib/ directory restructuring (Issue #481)
  - Phase 1-7: reorganize into db/, tmux/, security/, detection/, session/, polling/, git/ groups
  - Add @deprecated compatibility layer for old import paths

## [0.4.6] - 2026-03-11

### Added
- File auto-update polling for external change detection (Issue #469)
  - `useFilePolling` hook with visibility-change lifecycle management
  - `useFileContentPolling` hook with If-Modified-Since/304 support
  - `useFileContentSearch` shared search hook
  - `FileSearchBar` shared component
  - `file-polling-config.ts` for polling interval constants
  - File tree and content auto-refresh when agent modifies files

### Fixed
- Auto-Yes: add retry expiry to prevent permanent duplicate prompt blocking
- Codex: detect approval prompts with wrapped preview lines
- Codex: handle long wrapped approval options
- Sidebar: add fallback navigation when Next.js router.push silently fails

### Refactored
- File panel: extract duplicated search logic into shared hook and component

## [0.4.5] - 2026-03-10

### Added
- Persist active CLI tool tab selection via localStorage

### Fixed
- Codex: detect approval prompts by expanding detection window and skipping collapsed lines
- Codex: skip update notification instead of triggering npm install
- Codex: polling-based init with trust dialog and update notification handling

### Performance
- Parallelize CLI tool status detection, git commands, and initial data fetch

## [0.4.4] - 2026-03-10

### Added
- tmux control mode transport for live terminal interaction (Issue #460)
  - `SessionTransport` interface abstraction
  - `PollingTmuxTransport` wrapping existing send-keys/capture-pane
  - `ControlModeTmuxTransport` with live output streaming via WebSocket
  - `TmuxControlClient`, `TmuxControlParser`, `TmuxControlRegistry`
  - Terminal page migration to control-mode streaming
  - Feature flag (`tmux-control-mode-flags.ts`) and metrics tracking

### Fixed
- Gemini CLI model selection dialog detection with description lines between options
- Codex prompt detection: skip unreasonably large option numbers
- OpenCode: use full output for prompt detection to support long prompts
- OpenCode: strip scrollbar character in stripBoxDrawing for status detection
- Gemini CLI: strip ANSI codes and wait for prompt before sending messages
- Prompt detector: tolerate garbage prefix and single-gap in option detection
- CLI patterns: support new Gemini CLI prompt format with placeholder text
- Prompt detector: tolerate garbage chars between indicator and option number
- Prompt detector: handle missing period in tmux capture-pane option lines

### Changed
- docs: reposition CommandMate as "a local control plane for agent CLIs" instead of "IDE for issue-driven AI development" (#457)
  - Updated README.md hero copy, sub copy, and section ordering
  - Updated docs/ja/README.md with corresponding Japanese translations
  - Updated package.json description and keywords
  - Updated src/app/page.tsx hero copy

## [0.4.3] - 2026-03-08

### Fixed
- Reset hljs padding in CodeViewer to fix line height issue

## [0.4.2] - 2026-03-08

### Added
- Terminal text search with highlight and navigation (Issue #47)
  - TerminalSearchBar component with match count and prev/next buttons
  - File content search with line highlighting in file panels
  - Mobile search UX with overlay highlight and header buttons
- Git tab with commit history and diff viewer (Issue #447)
  - GitPane with commit log, diff display, and collapsible sections
  - Git API endpoints (log, diff, show)
- Sidebar repository-based grouping with collapse/expand (Issue #449)
  - useLocalStorageSync hook extraction
- File content search in PC file panel (Issue #47)
- Default selected agents changed to include Gemini (claude, codex, gemini)

### Fixed
- Sidebar branch name alignment regardless of agent count
- Mobile CLI tool tabs limited to 2 agents
- Mobile agent selection clamped to maxAgents (max 2)
- File viewer line number alignment on mobile with table layout

### Changed
- Detailed module descriptions extracted from CLAUDE.md to docs/module-reference.md
- Branch strategy documentation updated to include develop branch

## [0.4.1] - 2026-03-06

### Added
- Tabbed split file panel replacing desktop file viewer modal (Issue #438)
  - Code highlighting, MARP slide rendering, fullscreen mode, path copy
  - Line numbers in code viewers and markdown editor
  - File tab persistence to localStorage per worktree
  - Content copy buttons for file panels
- Show description next to branch name in PC header
- Persist draft message input across worktree switches
- Allow up to 4 agents on PC, keep 2 on mobile

### Fixed
- File panel XSS, sandbox escape, and edge case hardening (Issue #438)
- Encode file paths and reset MARP slide state
- Center placeholder text vertically in message input

### Changed
- Move CLI tool tabs into terminal pane header (Issue #438)
- Move AutoYesToggle to CLI tool tab bar (Issue #438)
- Narrow left pane initial width for 1:2:2 layout ratio (Issue #438)
- Add --port option and stop guidance to rebuild skill

## [0.4.0] - 2026-03-05

### Added
- Comprehensive dark mode support (Issue #424)
  - Dark mode foundation with cyan accent migration
  - Mobile header, tab bar, detail views, sidebar, editor components
  - AutoYes toggle/confirm dialog, home, CMATE tabs, slash commands, navigation
- Resource leak prevention for long-running servers (Issue #404)
- Tmux capture cache with TTL, singleflight, and N+1 elimination (Issue #405)
- Schedule sync performance with mtime caching and batch upsert (Issue #409)
- Server log rotation in build-and-start.sh (Issue #403)

### Changed
- README repositioned around issue-driven AI development messaging (Issue #433)

### Fixed
- Process stop logic hardened with PID validation and graceful shutdown (Issue #401)
- Dark mode text contrast in AutoYes confirm dialog (Issue #424)
- Dark mode support for MobilePromptSheet

### Performance
- Async-ify CMATE parser synchronous I/O to unblock event loop (Issue #406)
- Dynamic import for TerminalComponent and MarkdownEditor (Issue #410)
- React memo/useCallback/useMemo to prevent unnecessary re-renders (Issue #411)
- Suppress duplicate prompt-detector log output (Issue #402)
- Status detector promptDetection caching (Issue #408)

## [0.3.6] - 2026-03-03

### Added
- LM Studio provider support for OpenCode configuration (Issue #398)
  - Parallel model fetching from Ollama and LM Studio
  - Dynamic provider configuration with zero-provider skip
- Auto-save mode toggle for Markdown editor (Issue #389)
  - 3-second debounce, save state indicator, error fallback

### Fixed
- Prevent credential leakage and same-origin trust break in proxy (Issue #395)
  - Sensitive request/response header filtering (cookie, authorization, CORS, CSP, etc.)
  - Internal URL information removal from WebSocket messages
- Prevent RCE/shell injection in terminal and capture APIs (Issue #393)
  - `exec()` → `execFile()` migration in tmux module (all 9 functions, 11 call sites)
  - Input validation for terminal/capture API endpoints
  - `sendSpecialKey()` with allowlist-based runtime validation
- Prevent symlink traversal in file APIs (Issue #394)
  - `resolveAndValidateRealPath()` with realpathSync-based defense
  - `checkPathSafety()` DRY helper for dual validation
- Prevent relative path bypass in clone customTargetPath validation (Issue #392)
  - `resolveCustomTargetPath()` wrapper with validateWorktreePath integration
- Polling overwriting checkbox state during agent settings editing (Issue #391)
  - `isEditing` state guard and `selectedAgentsRef` same-value skip
- Dark background fallback for unspecified-language code blocks (Issue #390)

## [0.3.5] - 2026-03-01

### Added
- OpenCode as 5th CLI tool with ICLITool implementation (Issue #379)
  - 2-layer TUI response capture for complete output (alternate screen handling)
  - ANSI/box-drawing stripping and extraction start fix
  - Slash commands, status detection, and response saving
  - Scroll to top button for terminal pane
  - `disableAutoFollow` for TUI-based tools
- QR code login for mobile access via ngrok (Issue #383)
  - `QrCodeGenerator` component with URL fragment-based token delivery
  - `useFragmentLogin` hook for automatic token extraction
  - Security hardening for QR login flow

### Fixed
- OpenCode response detection, `┃` stripping, and duplicate prevention
- OpenCode terminal scroll issues with TUI tools
- QR code S001 bypass, autoLoginError clearing, and URL trailing slash

## [0.3.4] - 2026-02-28

### Added
- vibe-local `--context-window` setting for Ollama context window size (Issue #374)
- AGENTS.md for Codex workflow guidance
- Cache-Control: no-store header to API routes

### Fixed
- Proxy route pathPrefix preservation for basePath-configured apps (Issue #376)
- Codex CLI prompt detection support (U+203A `›` indicator) (Issue #373)
  - Early prompt detection for Codex in response-poller
  - Prompt detection result carried through ExtractionResult to avoid truncated re-detection
  - TUI indentation and buffer reset handling
- Mobile safe-area-inset-top in fixed elements
- Mobile main content padding-top increased for header visibility
- Mobile CMATE tab header visibility on worktree page

## [0.3.3] - 2026-02-26

### Added
- Agent settings feature with multi-CLI tool support (Issue #368)
  - `AgentSettingsPane` component with checkbox UI for selecting up to 2 CLI tools
  - Gemini CLI support with interactive REPL mode and trust folder auto-handling
  - vibe-local (Ollama) CLI support with interactive REPL mode and model selection
  - `selected-agents-validator.ts` for agent selection validation
  - Dynamic terminal tabs based on selected agents
  - DB migration #19: `selected_agents` column in worktrees table
  - PATCH API for persisting agent selection per worktree
  - Ollama model list API (`/api/ollama/models`)
  - CMATE schedule execution support for Gemini and vibe-local
  - `stripBoxDrawing()` for Gemini CLI box-bordered prompt detection
  - CLI tool display names centralized via `getCliToolDisplayName()`

### Fixed
- Cache-Control: no-store header added to API routes
- Worktree patch validation and agent settings sync hardened
- Gemini CLI box-bordered prompt detection with `stripBoxDrawing()`

### Changed
- README optimized for GitHub star conversion
- Feature comparison tables updated with Token Authentication, Scheduled Execution, and Remote Control

## [0.3.2] - 2026-02-24

### Added
- CMATE schedule execution feature (Issue #294)
  - CMATE.md-based schedule definition with cron syntax
  - Claude CLI executor with permission support (`--permission-mode`)
  - Execution log viewer with Message/Response detail and schedule name display
  - CMATE setup/validate button in FileTreeView toolbar
  - Step-by-step setup guide for empty schedules state
  - Environment variable sanitization for secure execution
  - i18n support (en/ja) for schedule UI
  - CMATE schedules user guide documentation (ja/en)
- Mobile tab renamed from "Notes" to "CMATE"

### Fixed
- CLAUDE_PERMISSIONS corrected to match `claude` CLI `--permission-mode` values
- Disabled schedules now filtered from active execution
- Header column validation added to CMATE.md validator
- Tree API response parsing fixed (object instead of array)
- Executor hanging prevention with CLI-specific args support

## [0.3.1] - 2026-02-23

### Fixed
- False negative in `isSessionHealthy()` for recovered sessions (Issue #354)
  - Prevent healthy sessions from being incorrectly marked as unhealthy after recovery

## [0.3.0] - 2026-02-22

### Added
- Token authentication and HTTPS support (Issue #331)
  - `CM_AUTH_TOKEN` for bearer token authentication
  - HTTPS with self-signed or custom certificate support
  - Login page UI with token input
  - AuthContext and middleware for Edge Runtime compatibility
  - Logout button with server-side auth status
  - Security documentation for token auth and HTTPS setup
- IP address/CIDR restriction for HTTP and WebSocket access (Issue #332)
  - `CM_ALLOWED_IPS` environment variable for IP whitelist
  - CIDR notation support for subnet ranges
  - 401 redirect handling in API client with polling stop
- Skills loader: display `.claude/skills` in slash command selector (Issue #343)
  - YAML frontmatter parsing with regex fallback
  - JSDoc documentation and TODO annotations per design policy

### Changed
- Auto-yes-manager refactored: decomposed `pollAutoYes()` into focused functions (Issue #323)
  - Removed misleading type assertion in test
- README rewritten with pain-first narrative elevator pitch
- vitest updated to 4.0.16

### Fixed
- SKILL.md YAML frontmatter parse errors with quoted values (Issue #351)
- Auth redirect handling in API client and polling stop on 401
- Login page flicker eliminated by using AuthContext instead of async status fetch
- LogoutButton flicker eliminated by using server-side auth status
- next-intl v4 SSR timeZone configuration
- Middleware made Edge Runtime compatible
- Server TypeError prevention in handleRequestImpl on Node.js 19+
- Slash command regex fallback for YAML-unfriendly SKILL.md frontmatter

## [0.2.13] - 2026-02-20

### Added
- Memo card copy to clipboard functionality (Issue #321)

### Fixed
- Prompt response extraction limited to `lastCapturedLine` onwards to prevent stale data (Issue #326)

## [0.2.12] - 2026-02-20

### Added
- Auto-Yes stop condition with regex pattern matching (Issue #314)
  - Custom regex pattern input to auto-stop when output matches
  - Regex tips tooltip for pattern guidance
  - Delta-based stop condition check to prevent false triggers
  - `AutoYesStopReason` moved to shared config
- Desktop demo GIF, mobile FAQ, and Cloudflare Tunnel guide in README

### Fixed
- Test environment NODE_ENV isolation (Issue #304)
  - `NODE_ENV=test` enforced in vitest config and test scripts
  - Infinite re-render loop fix in `useLocalStorageState`
  - `process.env` cast to avoid read-only NODE_ENV type error

### Changed
- README rewritten with "Mobile Dev Cockpit" positioning

## [0.2.11] - 2026-02-19

### Added
- MP4 video file upload and browser playback support (Issue #302)
  - Video security validation aligned with image upload pattern
- Root-level file/directory creation toolbar (Issue #300)
  - Dark mode support for empty state buttons
  - Path encoding fix for special characters
- Session stability improvements with duplicate prevention (Issue #306)
  - JSDoc improvements, constant extraction, DRY/ISP principles applied
- npm keywords for package discoverability

### Fixed
- Clone basePath now uses `CM_ROOT_DIR` instead of hardcoded `/tmp/repos` (Issue #308)
- iPad layout: unified z-index system, swipe/scroll separation, layout fixes (Issue #299)
  - Unreachable code fix in MarkdownEditor

## [0.2.10] - 2026-02-17

### Fixed
- Prompt-response API fallback for promptType mismatch (Issue #287)
  - `promptType` / `defaultOptionNumber` sent from client for server-side re-verification fallback
  - `isClaudeMultiChoice` broadened for type mismatch edge cases
  - User input prompt barrier to prevent false positive detection
  - `prompt-answer-sender.ts` shared module to eliminate cursor-key logic duplication
  - `prompt-response-body-builder.ts` shared utility for DRY request body construction
- Slash command selector re-display during free input mode (Issue #288)
  - `isFreeInputMode` flag prevents selector from re-appearing after custom command input
  - Enter key interception fix and filter text carry-over to free input mode
  - Mobile send button guard during free input mode

### Changed
- README improved as project landing page with complete CLI command reference (Issue #286)

## [0.2.9] - 2026-02-15

### Added
- File move/rename feature with `MoveDialog` component (Issue #162)
  - Context menu "Move/Rename" option for files and directories
  - Path validation and overwrite prevention
- File creation date (birthtime) display in `FileViewer` header and mobile view (Issue #162)
  - `date-utils.ts` with locale-aware formatting
- Content copy button in `MarkdownEditor` toolbar (Issue #162)
  - `useFileOperations` hook for file operation logic extraction

## [0.2.8] - 2026-02-14

### Fixed
- Update check API fetch caching issue with `cache: 'no-store'` (Issue #278)
- Update notification indicator dot on Info tab and mobile tab bar (Issue #278)
  - `NotificationDot` reusable component for visual update alerts

## [0.2.7] - 2026-02-14

### Fixed
- Claude CLI session recovery: cache invalidation, health check, and CLAUDECODE env removal (Issue #265)
  - `clearCachedClaudePath()` for automatic recovery on CLI update
  - `isSessionHealthy()` / `ensureHealthySession()` for broken session detection and recreation
  - `sanitizeSessionEnvironment()` to remove CLAUDECODE environment variable
  - `getCleanPaneOutput()` common helper and `isValidClaudePath()` validation
  - Session error pattern detection via `CLAUDE_SESSION_ERROR_PATTERNS` / `CLAUDE_SESSION_ERROR_REGEX_PATTERNS`
- Preserve input content on browser tab visibility change (Issue #266)
  - Input field content no longer cleared when switching browser tabs

### Changed
- Refactored `WorktreeDetailRefactored` component for DRY compliance (Issue #266)
  - Extracted shared hooks and components

## [0.2.6] - 2026-02-14

### Fixed
- Update-check API route static prerender error (Issue #270)
  - Added `force-dynamic` export to prevent Next.js static generation at build time

## [0.2.5] - 2026-02-14

### Added
- User feedback links in Info modal (Issue #264)
  - `FeedbackSection` component with bug report, feature request, question links
  - Desktop (InfoModal) and mobile (MobileInfoContent) support
  - i18n support (en/ja)
- `commandmate issue` CLI command with gh CLI integration (Issue #264)
  - `commandmate issue create --bug/--feature/--question` for templated issue creation
  - `commandmate issue search <query>` for issue search
  - `commandmate issue list` for issue listing
- `commandmate docs` CLI command for RAG-like documentation access (Issue #264)
  - `commandmate docs --section <name>` for specific documentation sections
  - `commandmate docs --search <query>` for documentation search
  - `commandmate docs --all` for full documentation output
- AI tool integration guide displayed after `commandmate init` (Issue #264)
- GitHub URL constants centralized in `src/config/github-links.ts` (Issue #264)

### Fixed
- docs-reader path resolution for built CLI (Issue #264)

## [0.2.4] - 2026-02-13

### Added
- Version update notification feature (Issue #257)
  - `UpdateNotificationBanner` component for new version alerts
  - `VersionSection` component for Info screen
  - `useUpdateCheck` hook and `version-checker.ts` library
  - `/api/app/update-check` API endpoint

### Fixed
- Multiple choice prompt detection for wrapped questions (Issue #256)
  - `isQuestionLikeLine()` now handles multi-line question wrapping (trailing `。` / `.`)
  - Keyword-based detection for non-question prompts (model selection, etc.)
  - Added `questionBlockScan()` for multi-line question block analysis
- Mobile background resume error "Error loading worktree" (Issue #246)
  - Added `visibilitychange` event listener for automatic data recovery
  - Error state reset and data re-fetch on page visibility restore

## [0.2.3] - 2026-02-13

### Added
- i18n support with next-intl for English and Japanese (Issue #124)
  - Locale-based routing (`/en`, `/ja`)
  - Document translations and integration/e2e tests
- Log export feature with LogViewer (Issue #11)
  - `LogViewer` component in Info screen (desktop modal & mobile)
  - `withLogging()` API logger middleware applied to log routes
  - `log-config.ts` for centralized LOG_DIR constant
  - Log-manager regression tests
- Prompt instructionText display in active prompt UI (Issue #235)
  - `PromptPanel` and `MobilePromptSheet` show instruction text
  - Complete prompt output preserved with `rawContent` field

### Fixed
- Full prompt block included in instructionText for multiple_choice prompts (Issue #235)
- Full output passed to detectPrompt in status-detector for long prompts (Issue #235)
- next-intl middleware removed to fix redirect loop with custom server (Issue #124)
- Image and document links corrected in README files (Issue #124)
- Rebuild skill branch specification to prevent worktree misexecution

### Removed
- Dead code: claude-poller, terminal-websocket, WorktreeDetail legacy code, simple-terminal (Issue #237)

## [0.2.2] - 2026-02-10

_No changes recorded._

## [0.2.1] - 2026-02-10

_No changes recorded._

## [0.2.0] - 2026-02-08

### Changed
- **BREAKING**: Removed `CM_AUTH_TOKEN` authentication mechanism (Issue #179)
  - `src/middleware.ts` deleted (Next.js authentication middleware)
  - `CM_AUTH_TOKEN`, `NEXT_PUBLIC_CM_AUTH_TOKEN`, `MCBD_AUTH_TOKEN` environment variables are no longer used
  - Existing AUTH_TOKEN settings are silently ignored (no errors, no effect)
  - External access now requires reverse proxy authentication (Nginx + Basic Auth, Cloudflare Access, Tailscale)
  - `commandmate init` and `commandmate start` show reverse proxy warning when `CM_BIND=0.0.0.0`
  - ENV_MAPPING reduced from 8 to 7 entries
  - Client-side `api-client.ts` no longer sends Authorization header

### Added
- Codex CLI support (Issue #4)
  - Codex tab in WorktreeDetail
  - Per-CLI tool status indicators in sidebar and tabs
  - Individual session termination with confirmation dialog
  - Mobile CLI tab switcher inline with Auto Yes toggle
  - CLI tool-specific slash command filtering (Claude: 16, Codex: 10)
  - Response saving fix for tmux buffer empty line padding
- Multiline message support via tmux `paste-buffer` (Issue #163)
  - `sendTextViaBuffer()` for accurate multiline text delivery
  - Single-line uses `sendKeys`, multiline uses `paste-buffer`
- App version display in info tab (Issue #159)
  - Desktop (InfoModal) and mobile (MobileInfoContent) support
  - Build-time `NEXT_PUBLIC_APP_VERSION` from `package.json`
- New security guide: `docs/security-guide.md` (Issue #179)
  - Threat model for localhost vs external access
  - Nginx + Basic Auth configuration example
  - Cloudflare Access and Tailscale setup instructions
  - Migration steps from CM_AUTH_TOKEN
  - Security checklist for external deployment
- `src/cli/config/security-messages.ts` with shared REVERSE_PROXY_WARNING constant (Issue #179)

### Fixed
- Auto-Yes false positive detection of numbered lists as multiple_choice prompts (Issue #161)
  - Two-pass `❯` detection to prevent misidentification
  - Thinking state pre-check skips prompt detection
  - Consecutive number validation as defensive measure
  - Prompt re-verification before sendKeys in prompt-response API
- Status display inconsistency: UI showing "running"/"waiting" when CLI is idle (Issue #180)
  - Consolidated inline logic into `detectSessionStatus()` in `status-detector.ts`
  - 15-line windowing to prevent past prompt false positives
- Multiline option text detection in multiple choice prompts (Issue #181)
- Deleted repositories reappearing after Sync All (Issue #190)
  - `enabled=0` exclusion marking on delete
  - Excluded repository list UI with restore button
  - New APIs: `GET /api/repositories/excluded`, `PUT /api/repositories/restore`
- File tree directory expand state lost after file operations

### Removed
- `CM_AUTH_TOKEN` / `MCBD_AUTH_TOKEN` environment variable support (Issue #179)
- `NEXT_PUBLIC_CM_AUTH_TOKEN` / `NEXT_PUBLIC_MCBD_AUTH_TOKEN` client-side token support (Issue #179)
- `isAuthRequired()` function from `src/lib/env.ts` (Issue #179)
- `generateAuthToken()` method from `EnvSetup` class (Issue #179)
- `CM_AUTH_TOKEN` masking patterns from logger and security-logger (Issue #179)

### Security
- Removed broken authentication that exposed tokens in client-side JavaScript (Issue #179)
- Added reverse proxy authentication recommendation for external deployments (Issue #179)

## [0.1.12] - 2026-02-04

_No changes recorded._

## [0.1.11] - 2026-02-04

### Added
- Server-side Auto-Yes polling feature (Issue #138)
  - `src/lib/auto-yes-manager.ts` for centralized polling management
  - Background polling when browser tab is inactive
  - Exponential backoff after 5 consecutive errors (max 60s)
  - Duplicate response prevention with `lastServerResponseTimestamp`
  - MAX_CONCURRENT_POLLERS=50 limit for DoS prevention
- Git Worktree parallel development environment (Issue #136)
  - `commandmate start --issue {issueNo} [--auto-port]` for issue-specific servers
  - `commandmate stop/status --issue {issueNo}` for worktree management
  - Port range 3001-3100 (main server uses 3000)
  - Issue-specific DB: `~/.commandmate/data/cm-{issueNo}.db`
  - `/worktree-setup` and `/worktree-cleanup` skills
- DB path resolution fix for global installs (Issue #135)
  - Consistent DB path via `getEnv().CM_DB_PATH`
  - Auto-migration from legacy DB paths
  - System directory protection

### Fixed
- Terminal scroll behavior on worktree switch (Issue #131)
  - Uses instant scroll for worktree changes
  - Smooth scroll only for new messages in same worktree
- Empty state now shows New File/New Directory buttons (Issue #139)
- Ready status detection for prompts with recommended commands (Issue #141)
- Worktree sync now removes deleted worktrees from DB

### Security
- worktreeID format validation (command injection prevention)
- Issue number validation (1-999999 range)
- Branch name whitelist validation (`[a-zA-Z0-9_/-]`)
- Graceful shutdown stops all auto-yes pollers

## [0.1.10] - 2026-02-02

### Added
- Git branch visualization feature (Issue #111)
  - Display current branch name in worktree detail header
  - Show warning when current branch differs from session start branch
  - Mobile support for branch information display
  - Automatic refresh (active: 2s, idle: 5s)
  - Migration #15: added `initial_branch` column to worktrees table
  - New `src/lib/git-utils.ts` module with `getGitStatus()` function
  - `BranchMismatchAlert` component for branch mismatch warnings

### Fixed
- Repository filter UI now displays even when only one repository exists (Issue #129)

### Security
- Branch visualization uses `execFile` instead of `exec` to prevent command injection
- 1 second timeout for git commands to prevent DoS
- React auto-escaping for XSS prevention in branch name display

## [0.1.9] - 2026-02-02

### Fixed
- Foreground mode (`commandmate start`) now loads .env file (Issue #125 follow-up)
  - v0.1.8 only fixed daemon mode, foreground mode was missing .env loading
  - Now both modes load .env from `~/.commandmate/.env` for global installs
  - Security warnings for external access also added to foreground mode

## [0.1.8] - 2026-02-02

### Fixed
- Global install CLI commands now load .env from correct location (Issue #125)
  - `commandmate start/stop/status` use `getEnvPath()` and `getPidFilePath()`
  - .env loaded from `~/.commandmate/.env` for global installs
  - PID file created at `~/.commandmate/.commandmate.pid`
  - Path traversal protection with symlink resolution
  - Security warnings for external network access (CM_BIND=0.0.0.0)
  - Fallback to process.env when .env loading fails

### Security
- Added path traversal protection in getConfigDir() (OWASP A01:2021)
- Security warning when server is exposed externally without authentication (OWASP A05:2021)

## [0.1.7] - 2026-02-02

### Added
- Interactive mode for `commandmate init` command (Issue #119)
  - TTY detection for automatic interactive/non-interactive mode selection
  - Prompts for CM_ROOT_DIR, CM_PORT, external access, CM_DB_PATH
  - `--defaults` flag for CI/CD environments (non-interactive)
  - Tilde expansion for paths (`~/repos` → `/Users/xxx/repos`)
  - Configuration summary display after setup
  - Global install: `.env` saved to `~/.commandmate/`
  - Local install: `.env` saved to current directory

## [0.1.6] - 2026-02-02

### Added
- Documentation updated to use `npm install -g commandmate` as primary setup method (Issue #114)
  - New CLI setup guide at `docs/user-guide/cli-setup-guide.md`
  - README.md Quick Start uses npm global install
  - git clone method moved to "Developer Setup" section
  - `--port` option documented in CLI commands table

### Fixed
- iPad fullscreen mode now uses Portal to cover full viewport (Issue #104)
- Test z-index expectations updated from 40 to 55 to match Z_INDEX.MAXIMIZED_EDITOR

### Changed
- Sidebar toggle animation uses transform instead of width for GPU acceleration (Issue #112)
  - Improves performance on iPad
  - Added SIDEBAR constant (30) to z-index.ts
- Pre-built JS compilation for server.ts enables npm CLI without TypeScript compilation (Issue #113)

## [0.1.5] - 2026-02-01

### Fixed
- Added `repository` field to package.json for npm provenance verification

## [0.1.4] - 2026-02-01

### Fixed
- Re-enabled `environment: npm-publish` in publish workflow
  - npm Trusted Publisher requires exact match of environment name

## [0.1.3] - 2026-02-01

### Fixed
- npm publish workflow now upgrades npm to ^11.5.1 for OIDC Trusted Publishers support
  - Node 20 ships with npm 10.8.2, but Trusted Publishers requires npm >= 11.5.1

## [0.1.2] - 2026-02-01

### Added
- Security audit job in PR CI workflow (ci-pr.yml)
  - Catches vulnerabilities before merge/release

### Changed
- Updated Next.js to 14.2.35 (latest 14.x patch)
- Updated eslint-config-next to 14.2.35
- Changed audit-level from `high` to `critical` in CI/publish workflows
  - Allows high-severity vulnerabilities that require breaking changes to fix
  - Next.js 15+ migration tracked separately

### Security
- Added npm audit to PR checks to catch vulnerabilities early

## [0.1.1] - 2026-02-01

### Added
- npm CLI support (`npm install -g commandmate`) (Issue #96)
  - `commandmate init` - Initialize configuration
  - `commandmate start` - Start server (foreground or daemon mode)
  - `commandmate stop` - Stop server
  - `commandmate status` - Show server status
- File tree search functionality (Issue #21)
  - Name search with real-time filtering (300ms debounce)
  - Content search via server API (5s timeout)
  - Search result highlighting
  - Auto-expand parent directories of matched files
  - Desktop/Mobile responsive design
- Mermaid diagram rendering in markdown preview (Issue #100)
- Image file viewer with security validation (Issue #95)
- File upload feature with security validation (Issue #94)
- Markdown editor with XSS protection (Issue #49)
- Markdown editor display improvements (Issue #99)
- pm-auto-design2dev slash command for automated workflow

### Fixed
- CLI now uses package directory instead of cwd for npm run
- Search filtering applied to nested tree items
- File tree refresh after operations
- Markdown preview code block styling

### Security
- ReDoS prevention (no regex on server-side search)
- Relative paths only in search results
- Magic byte validation for file uploads
- SVG XSS protection for image viewer
- Mermaid securityLevel='strict' setting

### Added
- Preflight check script `scripts/preflight-check.sh` for dependency validation (Issue #92)
  - Checks Node.js (v20+), npm, tmux, git, openssl
  - Claude CLI check with warning (optional)
  - Help option (`-h`/`--help`)
- Interactive environment setup script `scripts/setup-env.sh` (Issue #92)
  - Generates `.env` with CM_* variables
  - Auto-generates auth token for external access
  - Backs up existing `.env` to `.env.backup.{timestamp}`
  - Help option (`-h`/`--help`)

### Changed
- `scripts/build-and-start.sh` now includes database initialization (Issue #92)
  - Creates data directory
  - Runs `npm run db:init` before build
  - Help option (`-h`/`--help`)
- `scripts/setup.sh` now uses preflight-check.sh, setup-env.sh, and build-and-start.sh (Issue #92)
  - Integrated dependency checking
  - Interactive environment configuration
  - Streamlined 4-step setup process (preflight → npm install → env → build & start)
  - Application starts automatically after setup
- `.env.production.example` updated to use CM_* variables (Issue #92)
  - Migrated from MCBD_* to CM_* format
  - Added logging configuration options
  - Added legacy support documentation
- Updated README.md Quick Start with simplified setup (Issue #92)
- Updated docs/DEPLOYMENT.md with new setup scripts (Issue #92)
- Updated docs/internal/PRODUCTION_CHECKLIST.md with CM_* variables (Issue #92)

## [0.1.0] - 2026-01-30

### Changed
- **BREAKING**: GitHub repository renamed from `Kewton/MyCodeBranchDesk` to `Kewton/CommandMate` (Issue #80)
- All documentation links updated to new repository URL (Issue #80)
- Project branding updated from MyCodeBranchDesk to CommandMate (Issue #75)
- UI titles and headers now display "CommandMate"
- Documentation updated with new branding terminology
- Removed "chat" terminology that caused confusion (now uses "Message/Console/History")
- **BREAKING**: package.json name changed from `mycodebranch-desk` to `commandmate` (Issue #77)
- **BREAKING**: Env interface properties renamed from `MCBD_*` to `CM_*` (Issue #77)
  - `MCBD_ROOT_DIR` -> `CM_ROOT_DIR`
  - `MCBD_PORT` -> `CM_PORT`
  - `MCBD_BIND` -> `CM_BIND`
  - `MCBD_AUTH_TOKEN` -> `CM_AUTH_TOKEN`
  - `DATABASE_PATH` -> `CM_DB_PATH`
- .env.example updated to use CM_* environment variables as primary (Issue #77)
- All shell scripts updated to use CommandMate branding and CM_* variables (Issue #77)
- E2E tests updated to test for CommandMate heading (Issue #77)

### Added
- Migration guide for existing users (`docs/migration-to-commandmate.md`) (Issue #79)
  - Complete environment variable mapping (9 variables)
  - systemd service migration instructions
  - Claude Code settings update instructions
  - Docker environment migration guide
  - Troubleshooting section
- Environment variable fallback support for backwards compatibility (Issue #76)
  - New `CM_*` prefix supported alongside legacy `MCBD_*` prefix
  - Deprecation warnings logged when legacy names are used (once per key)
  - All 8 environment variables support fallback:
    - `CM_ROOT_DIR` / `MCBD_ROOT_DIR`
    - `CM_PORT` / `MCBD_PORT`
    - `CM_BIND` / `MCBD_BIND`
    - `CM_AUTH_TOKEN` / `MCBD_AUTH_TOKEN`
    - `CM_LOG_LEVEL` / `MCBD_LOG_LEVEL`
    - `CM_LOG_FORMAT` / `MCBD_LOG_FORMAT`
    - `CM_LOG_DIR` / `MCBD_LOG_DIR`
    - `CM_DB_PATH` / `MCBD_DB_PATH`
  - Client-side fallback for `NEXT_PUBLIC_CM_AUTH_TOKEN` / `NEXT_PUBLIC_MCBD_AUTH_TOKEN`
- `CM_AUTH_TOKEN` masking pattern in logger for security
- Unit tests for environment variable fallback functionality

### Deprecated
- `MCBD_*` environment variables - use `CM_*` instead (will be removed in next major version)
  - `MCBD_ROOT_DIR` -> `CM_ROOT_DIR`
  - `MCBD_PORT` -> `CM_PORT`
  - `MCBD_BIND` -> `CM_BIND`
  - `MCBD_AUTH_TOKEN` -> `CM_AUTH_TOKEN`
  - `MCBD_LOG_LEVEL` -> `CM_LOG_LEVEL`
  - `MCBD_LOG_FORMAT` -> `CM_LOG_FORMAT`
  - `MCBD_LOG_DIR` -> `CM_LOG_DIR`
  - `MCBD_DB_PATH` -> `CM_DB_PATH`
- `NEXT_PUBLIC_MCBD_AUTH_TOKEN` -> `NEXT_PUBLIC_CM_AUTH_TOKEN`

[unreleased]: https://github.com/Kewton/CommandMate/compare/v0.5.2...HEAD
[0.5.2]: https://github.com/Kewton/CommandMate/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/Kewton/CommandMate/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/Kewton/CommandMate/compare/v0.4.16...v0.5.0
[0.4.16]: https://github.com/Kewton/CommandMate/compare/v0.4.15...v0.4.16
[0.4.15]: https://github.com/Kewton/CommandMate/compare/v0.4.14...v0.4.15
[0.4.14]: https://github.com/Kewton/CommandMate/compare/v0.4.13...v0.4.14
[0.4.13]: https://github.com/Kewton/CommandMate/compare/v0.4.12...v0.4.13
[0.4.12]: https://github.com/Kewton/CommandMate/compare/v0.4.11...v0.4.12
[0.4.11]: https://github.com/Kewton/CommandMate/compare/v0.4.10...v0.4.11
[0.4.10]: https://github.com/Kewton/CommandMate/compare/v0.4.9...v0.4.10
[0.4.9]: https://github.com/Kewton/CommandMate/compare/v0.4.8...v0.4.9
[0.4.8]: https://github.com/Kewton/CommandMate/compare/v0.4.7...v0.4.8
[0.4.7]: https://github.com/Kewton/CommandMate/compare/v0.4.6...v0.4.7
[0.4.6]: https://github.com/Kewton/CommandMate/compare/v0.4.5...v0.4.6
[0.4.5]: https://github.com/Kewton/CommandMate/compare/v0.4.4...v0.4.5
[0.4.4]: https://github.com/Kewton/CommandMate/compare/v0.4.3...v0.4.4
[0.4.3]: https://github.com/Kewton/CommandMate/compare/v0.4.2...v0.4.3
[0.4.2]: https://github.com/Kewton/CommandMate/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/Kewton/CommandMate/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/Kewton/CommandMate/compare/v0.3.6...v0.4.0
[0.3.6]: https://github.com/Kewton/CommandMate/compare/v0.3.5...v0.3.6
[0.3.5]: https://github.com/Kewton/CommandMate/compare/v0.3.4...v0.3.5
[0.3.4]: https://github.com/Kewton/CommandMate/compare/v0.3.3...v0.3.4
[0.3.3]: https://github.com/Kewton/CommandMate/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/Kewton/CommandMate/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/Kewton/CommandMate/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/Kewton/CommandMate/compare/v0.2.13...v0.3.0
[0.2.13]: https://github.com/Kewton/CommandMate/compare/v0.2.12...v0.2.13
[0.2.12]: https://github.com/Kewton/CommandMate/compare/v0.2.11...v0.2.12
[0.2.11]: https://github.com/Kewton/CommandMate/compare/v0.2.10...v0.2.11
[0.2.10]: https://github.com/Kewton/CommandMate/compare/v0.2.9...v0.2.10
[0.2.9]: https://github.com/Kewton/CommandMate/compare/v0.2.8...v0.2.9
[0.2.8]: https://github.com/Kewton/CommandMate/compare/v0.2.7...v0.2.8
[0.2.7]: https://github.com/Kewton/CommandMate/compare/v0.2.6...v0.2.7
[0.2.6]: https://github.com/Kewton/CommandMate/compare/v0.2.5...v0.2.6
[0.2.5]: https://github.com/Kewton/CommandMate/compare/v0.2.4...v0.2.5
[0.2.4]: https://github.com/Kewton/CommandMate/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/Kewton/CommandMate/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/Kewton/CommandMate/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/Kewton/CommandMate/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/Kewton/CommandMate/compare/v0.1.12...v0.2.0
[0.1.12]: https://github.com/Kewton/CommandMate/compare/v0.1.11...v0.1.12
[0.1.11]: https://github.com/Kewton/CommandMate/compare/v0.1.10...v0.1.11
[0.1.10]: https://github.com/Kewton/CommandMate/compare/v0.1.9...v0.1.10
[0.1.9]: https://github.com/Kewton/CommandMate/compare/v0.1.8...v0.1.9
[0.1.8]: https://github.com/Kewton/CommandMate/compare/v0.1.7...v0.1.8
[0.1.7]: https://github.com/Kewton/CommandMate/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/Kewton/CommandMate/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/Kewton/CommandMate/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/Kewton/CommandMate/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/Kewton/CommandMate/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/Kewton/CommandMate/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/Kewton/CommandMate/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Kewton/CommandMate/releases/tag/v0.1.0
