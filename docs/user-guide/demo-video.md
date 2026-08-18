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

## 前提

- `tmux` / `git` / `curl` / `node` / `ffmpeg` / `ffprobe`（`brew install ffmpeg`）
- `claude`（`npm install -g @anthropic-ai/claude-code`。実 LLM は使わないが、メッセージ送信 API が
  CLI 未導入を 503 で拒否するため、無いと録画の途中でテイクが死ぬ）
- Playwright の Chromium（`npx playwright install chromium`）
- リポジトリで `npm install` 済みであること

不足があれば 1 本目の録画に入る前に、導入コマンドを提示して停止する。

## 何が起きるのか

ロケールごとに、使い捨ての seed リポジトリと**専用ポートの隔離サーバ**を立て、収録済みの
ターミナル出力を再生する「偽エージェント」を tmux セッションに流し込み、Playwright で 4 シーンを
録画してから ffmpeg で合成する。

実 LLM は使わない。非決定的で、生成に数分かかり 30 秒に収まらないからである。ただし
**置き換えているのは LLM だけ**で、ステータス検出も応答ポーリングも UI も製品コードのまま動く。

開発機で動いている本番インスタンス（`127.0.0.1:3000`）と本番の `cm.db` には一切触れない。
ポート 3000 はスクリプト側が明示的に拒否し、DB は `$HOME/.commandmate-demo/` 配下に隔離される。
異常終了しても `trap` で隔離環境の停止・破棄まで到達する。

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
