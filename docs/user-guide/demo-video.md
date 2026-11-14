# デモ動画の作り方（demo-video スキル）

CommandMate の 30 秒紹介動画（日本語版・英語版）を、隔離環境で全自動生成するためのメンテナ向けツール。

```bash
# 依存と絵コンテだけ先に確認する（録画しない）
.claude/skills/demo-video/scripts/demo-video.sh --check

# 日英まとめて生成（既定の出力先は ~/Desktop/commandmate-demo/）
.claude/skills/demo-video/scripts/demo-video.sh

# 片方だけ／出力先を変える／README 用 GIF も出す
.claude/skills/demo-video/scripts/demo-video.sh --locale ja --out ~/Desktop/cm-demo --gif
```

生成物は `demo-30s.ja.mp4` / `demo-30s.en.mp4`（`--gif` 指定時は同名の `.gif` も）。

LP / README に貼る**静止画 5 点**も、同じ隔離環境から機械生成できる（Issue #1810）。

```bash
.claude/skills/demo-video/scripts/env-up.sh
npx tsx .claude/skills/demo-video/scripts/stills.ts --state "$HOME/.commandmate-demo/state.env"
.claude/skills/demo-video/scripts/env-down.sh --purge
```

`docs/images/screenshot-*.png` と `website/assets/img/*.webp` を書き換える。
hero（`screenshot-desktop`）は `/sessions` を撮る。`/` は最後に開いたブランチ（無ければ `/sessions`）への
振り分けで、撮れる画面がブラウザの履歴次第になるため使わない（Issue #3174）。
`--still <id>` で 1 枚だけ撮り直せる。
**バイト予算はゲート**で、hero（`screenshot-desktop.webp`）が 100KB に収まらなければ
品質と解像度を段階的に落とし、それでも収まらなければ**何も書かずに落ちる**。
撮る前に画面のテキストを読み、個人パス・LAN アドレス・旧製品名が写っていれば失敗させる
（直し方はマスクではなく**構図**）。

## 前提

- `tmux` / `git` / `curl` / `node` / `ffmpeg` / `ffprobe`（`brew install ffmpeg`）
- `claude`（`npm install -g @anthropic-ai/claude-code`。実 LLM は使わないが、メッセージ送信 API が
  CLI 未導入を 503 で拒否するため、無いと録画の途中でテイクが死ぬ）
- Playwright の Chromium（`npx playwright install chromium`）
- リポジトリで `npm install` 済みであること

不足があれば 1 本目の録画に入る前に、導入コマンドを提示して停止する。

## 何が起きるのか

ロケールごとに、使い捨ての seed リポジトリと**専用ポートの隔離サーバ**を立て、収録済みの
ターミナル出力を再生する「偽エージェント」を tmux セッションに流し込み、絵コンテが並べたシーンを
録画してから ffmpeg で合成する。

シーンには 3 種類ある。ブラウザを Playwright で撮るもの、`type: code` の**コードカード**
（絵コンテの隣にある実ファイルを組版した静止フレーム）、そして `contract-verify` の
**ターミナル収録**である。最後のひとつは tmux pane を撮る: Task Contract と検証ゲートは
Web UI に無く、CLI の出力が唯一それを見せる面だからである。そこに映る
`GATE ... PASS` / `RESULT passed` / 終了コードは、サーバが seed の `.commandmate/verify.yaml` を
**本当に実行した**結果であって、作り物ではない。

`install-skill` シーンだけはネットワークが要る（公式 Skill Catalog の URL は
コンパイル時定数で、ローカルの代用に差し替えられない）。到達できないときは理由を出して
**失敗する**。オフラインで残りを撮りたいときは `--allow-skip` を明示する。

実 LLM は使わない。非決定的で、生成に数分かかり 30 秒に収まらないからである。ただし
**置き換えているのは LLM だけ**で、ステータス検出も応答ポーリングも UI も製品コードのまま動く。

開発機で動いている本番インスタンス（`127.0.0.1:3000`）と本番の `cm.db` には一切触れない。
ポート 3000 はスクリプト側が明示的に拒否し、DB は `$HOME/.commandmate-demo/` 配下に隔離される。
異常終了しても `trap` で隔離環境の停止・破棄まで到達する。

## 収録と撮影の罠

スキルの外で画面を撮るとき（`recordVideo` の操作動画・チャット面のスクリーンショット・素の TUI・macOS の GUI）にも当てはまる。
公開する映像では、個人のパス・アカウント名・非公開のリポジトリ名・LAN のアドレスが映らないことを、
合成の前に**区間の境目の等倍のフレーム**を並べて目で確かめる。

### 画面の移動の直後は切る

Playwright の `recordVideo` は、ページの移動（`page.goto`・クリックでの遷移）の直後の最初の描画をそのまま撮る。
撮影スクリプトが DOM を書き換えて隠す処理（`display:none` など）は、移動の後に自分で呼ぶまで効かないので、
**移動の直後 0.3〜0.5 秒ほどは、隠したはずのもの（ヘッダのリポジトリのタブ帯など）が全部映る**。静止画（`page.screenshot`）は撮る前に隠せるので、この罠は出ない。

- 取り込む区間は、移動の直後 1 秒を切る
- 隠す CSS は `context.addInitScript` で最初の描画より前に入れる。タブ帯のように同じ `data-testid` が並ぶものは CSS だけでは絞れないので、init script で `MutationObserver` を先に張る

### Playwright の録画の解像度と時刻

- `recordVideo` は `deviceScaleFactor: 2` でも、CSS の寸法の絵を動画の**左上 1/4** に描くだけ（残りは灰色）。DPR 2 で鮮明に見せたいときは、状態ごとの `page.screenshot` を静止画のジャンプカットにする。動きが要るなら DPR 1 で撮って拡大する（ぼける）。切り出す前に 1 フレーム目を必ず目で見る
- webm のタイムスタンプは壁時計とずれる（送信の直後の 60 秒で 20 秒以上ずれた実測がある）。`ffmpeg -vf fps=30` で一定のフレームレートの mp4 にしてから切る。スクリプトが記録した時刻は目安として使う
- サイドバーに他のリポジトリの群れが映るときは、群れの見出し（`group-header`）の親を隠す（タブ帯と同じ規則）

### チャット面のスクリーンショット

隔離環境（上の `env-up.sh`）に DB の会話を seed し、偽エージェントのセッションを adopt させて撮る。

- assistant の行の `request_id` は `claude-turn:<uuid>` の形にする（`src/types/agent-transcript.ts` の `AGENT_MARKDOWN_REQUEST_ID_PREFIXES`）。無いと `isAgentAuthoredMarkdown` が false になり、本文が Markdown でなく生のテキストで描かれる
- 偽エージェントのセッションが落ちた後に送信すると、サーバーが**本物の CLI を起動**して信頼の確認で止まり、hook の設定も残る。撮影スクリプトの先頭でセッションを起こし直し、その run の中で撮り切る
- ダイアログは**そのプロンプトが出た時点で開いていたページ**にしか描かれない（待ちの始まりはメモリにしか無い）。PC とスマホの両方に出すなら、送信より前に両方の context を開いておく
- 番号付きの選択肢は `PromptPanel`（スマホは `MobilePromptSheet`）に出て、PC では吹き出しの列をほぼ隠す。吹き出しの列とダイアログを 1 枚に収めたいときは、`ChatDialogCard` に出る形のプロンプト（選択リストなど）を作る
- `?view=chat` で出力面を固定できる（`src/config/surface-mode-config.ts` の `SURFACE_MODE_VIEW_PARAM`）。仮想リストはしばらく skeleton を描くので、本文のテキストが出るまで待ってから撮る

### 素の TUI を 1:1 で撮る

- エージェントを **tmux のセッションのコマンドとして**起動する（`tmux new-session -d -s <名前> -c <dir> -x <桁> -y <行> <コマンド>`）。shell 経由で起動すると、shell のプロンプトの行（ユーザー名・ホスト名を含む）がペインに残る
- `capture-pane -p -e` を短い間隔で採り、同じフレームを除いて PNG に描き、ffmpeg でつなぐ
- 起動画面のヘッダにアカウントのメールアドレスを出す CLI がある。描画の段で伏せる。ファイル作成の確認の見出しなど、作業ディレクトリの絶対パスを出す画面があるので、個人の名前を含まない中立のディレクトリで撮る
- ペインの先頭には起動の行やアカウントの表示が在る。末尾へ寄せた窓を撮り、上端を映さない
- Web UI の History の列には hook の行（作業ディレクトリのパスを含む）や起動の行が生のまま出ることがある。収録では History の列を閉じ、サイドバーも畳む
- Playwright で tooltip の要素を `remove()` すると React の描画が落ちる。隠すなら `addStyleTag` の CSS で。ボタンをクリックした後は `blur()` して tooltip を残さない

### テロップの帯の被りを測る

帯の位置は overlay の PNG のアルファから取れるので、目分量で決めない。帯が届かない左端の帯で端末のテキストの最下行の y を測り、
帯の影の上端より上かを見る。これなら全フレームを機械で調べられる。
端末のシーンでは、tmux が最終行をペインの下端に張り付けるので、テキストの y は出力の行数ではなく**ペインの行数**で決まる。
効くのは `cli-scene.sh` の `PANE_HEIGHT` で、`telop.html` の `margin-bottom` は全カット共通なので触らない。
`$HOME` の差し替えなど隔離の設定は SKILL.md の手順に従う。

### macOS の GUI を `osascript` と `screencapture` で撮る

- 権限が 2 つ要る: 画面収録（無いと `could not create image from display`）とアクセシビリティ（無いと `osascript` が `-1719`）。どちらもエージェントを動かすターミナルのアプリに付ける。付けるのは利用者
- tmux の中から `screencapture` を撃つと、ウインドウピッカーを迂回する許可のダイアログが画面の中央に出る。撮影自体は通るが、残っていれば次の撮影に写る。利用者に許可してもらう
- 日本語の入力モードだと `keystroke` が仮名に変わる。文字は `pbcopy` → `keystroke "v" using {command down}` で貼る。作業の前にクリップボードを退避し、終わったら戻す
- 修飾キー付きの `keystroke` の後に同じ `osascript` の中で送ったキーは、修飾キーが残って効かない。1 打ごとに `osascript -e` を分ける
- 修飾キーが落ちると Cmd+数字は素の数字になり、フォーカス中のエージェントの選択肢に届く。プロンプトが出ている間は数字キーを送らない。Escape もプロンプトを取り消すので、送る前に状態を見る
- 前面が別のアプリに移ると貼り付けがそちらへ落ちる。自動操作の間は利用者に触らないよう頼む
- 窓だけを撮るときは、`CGWindowListCopyWindowInfo` で対象アプリの window id を取り、`screencapture -x -o -l <id>` で撮る（`-R` の座標指定は前面の判定やディスプレイの構成に左右される）

## 文言を変えたいとき

`.claude/skills/demo-video/storyboard/default.yaml` だけを編集する。シーンの尺・テロップの
表示区間・合成の切り貼りはすべてそこから機械算出されるので、他の場所にタイムコードは無い。

日本語と英語の文言は両方とも直書きで、生成時に機械翻訳はしない（誰もレビューしていない文字列を
画面に出さないため）。片方が欠けている・尺の合計が合わない・テロップが長すぎる、といった絵コンテは
合成前の検証で `exit 1` になる。

## 生成物をリポジトリに置かないこと

mp4・GIF・中間 PNG は**コミットしない**。既定の出力先はリポジトリ外なので通常は git から見えないが、
`--out` でリポジトリ内を指定しないこと。生成後に `git status` がクリーンであることを確認する。

配布は GitHub Release のアセットなど、リポジトリ履歴の外で行う。動画は差分が取れず、
一度コミットすると以後すべての clone がその重さを引き継ぐ。

## もっと詳しく

内部設計・シーンの同期点・カセットの採取手順・隔離の不変条件は
[`.claude/skills/demo-video/SKILL.md`](../../.claude/skills/demo-video/SKILL.md) を参照。
