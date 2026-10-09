# exit code ごとの対処

本体の 3-1・3-4 から、exit code ごとの詳しい対処を移した（#3481）。いつ読むかは本体の各節に書いてある。

## 3-1 冷間起動の失敗 exit 99

```bash
SCREEN=$(commandmatedev capture "$WT" --instance "$AGENT" --pane --tail 30)
```

| 画面 | 対応 |
|---|---|
| 信頼ダイアログ（`Do you trust the contents of this project?`） | `tmux send-keys -t "=mcbd-<agent>-<worktree-id>:" Enter` で確定 → **待たずに再送** |
| 既にプロンプト（入力欄の枠が出ている） | **待たずに再送**（送信枠に間に合わなかっただけ） |
| まだ起動中（バナーも入力欄も無い） | 約 2 分待ってから 1 回だけ再送する |

再送では task が作り直されるので、tasks.tsv の task id を差し替える。
再送も exit 99 なら、もう一度画面を見る（同じ表で分岐する）。再指示回数には数えない（3-4）。

## 3-4 20 の対応

- **ワーカー起因**: `lint` / `typecheck` / `unit` など宣言ゲートの失敗、`scope` 違反、`work-evidence` の不足、
  および `env-clean` の違反のうちワーカーのコマンドが作ったもの
- **ワーカー起因ではない**: 宣言ゲートが落ちたが、**そのゲートの出力で失敗したテストが 0 件**のもの
  （ティアダウンの race。`Test Files N passed / Tests M passed` なのに exit 1 で、原因が
  `EnvironmentTeardownError` などの未処理 rejection 1 件だけ）。**負荷が下がってから
  `commandmatedev verify "$WT" --task "$TASK_ID" --gates <落ちたゲート>` で単独再実行し、再現しなければワーカー起因ではない**（契約で定義したゲートは task に紐づかないと見つからないので `--task` を付ける）
  （2026-09-20 の #2771 で実測。原因は 2-4-2 の「差し替えの条件」にある mutex の非対称）
- **ワーカー起因ではない**: `scope` の違反が、すべて同じブランチの前の契約のコミットで入ったファイルであるもの
  （契約の書き方の誤り。`git show --name-only <この契約のコミット>` がすべて allow の中なら、ワーカー起因ではない。2-4 の和集合を参照）
- **ワーカー起因ではない**: `env-clean` の違反のうち、ワーカーの作業と結び付かないもの。
  2026-09-17 のパイロットでは、`env-clean` だけが FAIL して exit 20 になった。違反は次の 3 件で、いずれもワーカーと無関係だった:
  - 別リポジトリの orchestrate が消した `mcbd-*` セッション（`-`）
  - 別プロセスの TCP listener（`-`）
  - ワーカーの最初のツール呼び出しより前の時刻が名前に入った `~/.commandmate-test-<ms>`（`+`）

  `~/.commandmate-demo-vitest-<pid>`（`+`）は、#3479 より前のコードの `env-scripts.test.ts` だけが作る
  （#3479 から作業場所は OS の一時ディレクトリで、`$HOME` には作らない）。base が #3479 より古いブランチの
  テストが並行で動いていると現れ、このワーカー起因ではないことがある（2026-09-28 の 2 本並行の run。別の worktree の
  生きたテストのものは #2954 で `other` に分かれる）。`[unattributed]` で残ったら、
  `commandmatedev verify "$WT" --task "$TASK_ID" --gates env-clean` を再実行して、その項目が消えていれば合格として扱う。

  帰属は次の 3 つで確かめる:
  - ワーカーが実行したコマンド: `capture --prompts --limit 100` の `Run this command?` と、そこに書かれた `start with '<cmd>'`
  - 最初のツール呼び出しの時刻
  - 違反項目の時刻（`~/.commandmate-test-<ms>` の `<ms>` など）

  ワーカー起因でないと判定した場合の扱い:
  - 残りのゲートがすべて PASS なら、オーケストレーターの裁定で合格として扱う
  - 裁定の根拠は PR の Test plan と summary に書く
  - ワーカーには再指示しない

**合図の前に始まった検証**（Antigravity 担当。3-3 の「完了の合図」）で `env-clean` だけが落ちたとき:

- 違反は、ワーカー自身がまだ動かしていたもの（バックグラウンドのテスト実行の listener `[self]`、
  テストが作って後で消す `$HOME` 直下のエントリなど）であることが多い。`~/.commandmate-demo-vitest-*` は
  #3479 から作られない（#3395 はこの形で、ワーカー自身のまだ動いていたテストが作ったものだった）
- 合図の後に `commandmatedev verify "$WT" --task "$TASK_ID" --gates env-clean` を再実行する
  （`work-evidence` と `scope` も一緒に走る）
- 再実行が PASS で、かつ 3-3 の確認で「最後のコミットが検証の開始より前・作業ツリーに変更なし」なら、合格として扱う。
  **再指示・切替の回数には数えない**。裁定の根拠は PR の Test plan と summary に書く
- 再実行でも落ちたら、残っている違反について、下のワーカー起因の判定に戻る
- #2605 がこの形だった: 検証の開始は 01:28、合図は 01:33。再実行は PASS で、コミットも変わっていなかった

## 3-4 再指示の後に 2 段で裁定する理由

理由:
- `wait --verify` は進行中（running / waiting_input / verifying）の task にしか紐づかない（`IN_FLIGHT_TASK_STATUSES`）。1 回目の検証で task は終了済みになる
- 紐づかないと scope は SKIP、env-clean は「ベースライン無し」の ERROR で exit 20 になり、ゲートも契約ではなく verify.yaml 全部になる
- 2026-10-03 #3099 の実測: 宣言ゲートは unit 全体 1283 秒を含めて全 PASS なのに exit 20 になった

## 3-4 21 の対応

- **composer に本文が残っている** → Enter 未確定。`tmux send-keys -t "mcbd-${AGENT}-$WT" Enter` で確定させる
  （`commandmatedev respond` は空文字を受け付けず exit 2 になるのでここでは使えない）。
  tmux セッション名は `mcbd-<エージェント>-<worktree-id>` である（Antigravity なら `mcbd-antigravity-<worktree-id>`）
- **Antigravity のアンケート画面**（`How's the CLI experience so far? [1] Good … [0] Skip`）で止まっている →
  Auto-Yes は答えず、`respond "0"` は `prompt_no_longer_active` になる。
  `tmux send-keys -t "mcbd-antigravity-$WT" -l -- 0` で閉じる（2026-09-09 実測。2026-09-17 のパイロットでは出なかった）
- **権限プロンプトで停止** → Enter で承認。monitor.sh に自動承認させる場合、送信先は
  capture の `cliToolId` から `mcbd-<cliToolId>-<worktree-id>[-<suffix>]` が導出されるので
  **オプション指定は要らない**（#1601）。`--session-prefix` は導出できないセッションを見るための
  escape hatch で、渡すと導出を丸ごとバイパスするため**混在フリートでは使わない**
  （例えば `mcbd-claude` を渡すと codex / copilot のワーカーまで claude 扱いに固定され、
  存在しないペインへ撃つことになる）。届かなかった介入は stderr に `NOT delivered` と出る
- **セッションが起動していない** → `commandmatedev ls` で存在確認、必要なら再送
- 判別のための知見は orchestrate-monitor skill の STARTED ガード（`verify-completion.sh`）を参照
