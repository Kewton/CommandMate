[English](../en/features/product-highlights.md)

# プロダクトの特徴

> **Vibe Engineering — 作るのは AI。エンジニアリングを保証するのは、あなたの専門知識ではなく仕組み。**

CommandMate は、エンジニアリングの規律をワークフローそのものに組み込みます。作業の前に契約を、
作業の後に検証ゲートを、その全体に証跡を。4 段の梯子は上から、Vision（専門的な開発知識を AI に
丸投げせず、仕組みとして補完する）・Mission（誰でもベストプラクティスに沿って AI とプロダクトを
作れるようにする）・中核原則（どのコーディングエージェントでも、要求から検証済みの成果へ再現可能に
至れること）と下り、最下段の実装が以下で見せるもの — Task Contract / Issue 駆動 / Skills /
並列実行 / 独立検証 / Evidence / PR workflow です。4 段の正本は
[コンセプト](../concept.md) にあります。

以下は主要な特徴を 20 秒ずつのデモで示したものです。各デモは日本語 UI で録画しています。

> **デモの録画方法**
> すべて隔離環境（使い捨ての seed リポジトリ・専用ポート・専用データベース・差し替えた `$HOME`）で
> 録画しており、private リポジトリ名・個人のパス・ソースコードは含まれません。
> 実 LLM は使わず、キャプチャ済みの端末出力を再生する「偽エージェント」を tmux セッションで
> 動かしています。**置き換えているのは LLM だけ**で、状態検出・応答ポーリング・サイドバーの
> 状態ドット・検証ゲートはすべて製品コードのまま動いています。

---

## 1. 「たぶん動く」ではなく検証済み

作業の前に、やってよい範囲と完了条件を契約として宣言します。作業の後は検証ランが合否を返し、
判定は実 exit code です — `0` 合格 / `20` ゲート不合格 / `21` 作業証跡ゼロ。
この映像のゲートはモックせず、本当に実行しています。

![「たぶん動く」ではなく検証済み](../images/features/cm-11-contract-verify.ja.gif)

[mp4](../images/features/cm-11-contract-verify.ja.mp4)

## 2. 方法論を仕組みに

方法論は誰かの頭の中ではなく、公式 Catalog から Skill として必要な worktree に導入され、
以後はコンポーザーから呼び出せる形になります。

![方法論を仕組みに](../images/features/cm-12-install-skill.ja.gif)

[mp4](../images/features/cm-12-install-skill.ja.mp4)

## 3. Git Worktree セッション

worktree ごとに 1 セッションを割り当て、複数ブランチの作業を同時に走らせます。
セッションは互いに干渉しません。CommandMate の外で作られた worktree — 素の `git` でも
エージェントでも — は、作り直すのではなくスキャンで拾います。

![Git Worktree セッション](../images/features/cm-01-parallel-worktrees.ja.gif)

[mp4](../images/features/cm-01-parallel-worktrees.ja.mp4)

## 4. セッション状態の可視化

実行中 / 待機中 / 完了をサイドバーの色とブランチごとの状態ドットで表示し、応答が要るものは
Review 画面に集まります。どのエージェントが止まっているかを、セッションを 1 つずつ開かずに
判断でき、見つけたその場で応答できます。

![セッション状態の可視化](../images/features/cm-02-status-at-a-glance.ja.gif)

[mp4](../images/features/cm-02-status-at-a-glance.ja.mp4)

## 5. 入力待ちが届く

エージェントが確認を求めて停止した瞬間に、サイドバーの「要対応」バッジとトーストで届き、
スマホから応答できます。気づかないまま何時間も止まっている、という状態を避けられます。

![入力待ちが届く](../images/features/cm-03-never-miss-waiting.ja.gif)

[mp4](../images/features/cm-03-never-miss-waiting.ja.mp4)

## 6. マルチエージェント

Claude Code / Codex / Gemini CLI / Copilot / OpenCode / Antigravity / ローカルモデルをタブで
切り替え、タスクごとに使い分けます。1 つの worktree に複数のエージェントセッションを並べられます。

![マルチエージェント](../images/features/cm-04-multi-agent.ja.gif)

[mp4](../images/features/cm-04-multi-agent.ja.mp4)

## 7. 非同期実行

メッセージを送ったら画面を離れて構いません。進行はサーバ側で追跡され、
戻ってきたときに結果と状態が残っています。

![非同期実行](../images/features/cm-05-send-and-walk-away.ja.gif)

[mp4](../images/features/cm-05-send-and-walk-away.ja.mp4)

## 8. モバイルからの承認

スマートフォン幅では確認プロンプトがシートとして開き、その場で応答できます。
承認のためだけに席へ戻る必要がありません。

![モバイルからの承認](../images/features/cm-06-approve-from-phone.ja.gif)

[mp4](../images/features/cm-06-approve-from-phone.ja.mp4)

## 9. 完了の自動検知

端末出力を解析して応答の完了を判定し、一覧の状態を戻します。
「終わったか」を見に行く必要がありません。

![完了の自動検知](../images/features/cm-07-completion-detected.ja.gif)

[mp4](../images/features/cm-07-completion-detected.ja.mp4)

## 10. ブラウザ内ターミナル

各 worktree の tmux セッションをそのままブラウザに表示します。
既存の tmux 環境を捨てず、その上に載る形で動きます。

![ブラウザ内ターミナル](../images/features/cm-08-tmux-in-browser.ja.gif)

[mp4](../images/features/cm-08-tmux-in-browser.ja.mp4)

## 11. ファイルビューア

セッションの隣に worktree のファイルツリーがあり、未コミットの差分もその隣のペインで開きます。
IDE を開かずに変更内容を読めます。Markdown はブラウザ上で編集もできます。

![ファイルビューア](../images/features/cm-09-files-beside-session.ja.gif)

[mp4](../images/features/cm-09-files-beside-session.ja.mp4)

## 12. 100% ローカル動作

サーバもデータベースもセッションも手元のマシンで動きます。外部サーバもクラウドリレーも
アカウントも不要で、外へ出る通信はエージェント CLI 自身の API 呼び出しだけです。MIT ライセンス。

![100% ローカル動作](../images/features/cm-10-local-and-npx.ja.gif)

[mp4](../images/features/cm-10-local-and-npx.ja.mp4)

---

## デモが映している範囲

デモの信頼性のため、**映像に出ていないことをテロップで主張していない**。読むときの前提として:

- シーンライブラリは 12 本あり、各デモは主張に必要なものだけを並べている。したがってテロップだけで
  なく映像そのものが本ごとに違う。ただし **6. マルチエージェント** / **7. 非同期実行** /
  **9. 完了の自動検知** / **10. ブラウザ内ターミナル** / **12. 100% ローカル動作** の 5 本は、
  今も同じ 3 シーン（ブランチ一覧 / 送信→生成 / 完了後の一覧）を並べ替え・尺配分だけ変えて
  構成している。その 3 画面が、それぞれの主張が指す画面そのものだからである。
- **6. マルチエージェント** はエージェントタブが画面上部に映っているが、タブを切り替える操作
  そのものは撮っていない（それを行うシーンが無い）。
- **5. 入力待ちが届く** が映しているのは、カードが挙げる 4 経路のうち 2 つ — サイドバーの
  「要対応」バッジとトーストである。タブタイトルの件数は実在するが収録が撮らないブラウザ chrome の
  中にあり、Web Push は購読済みの端末が要る。どちらもカードの主張であって映像の主張ではない。
- **11. ファイルビューア** は「ファイルツリーがセッションの隣にあり、Git アクティビティから差分を
  開く」ところまでが実映像で、Markdown エディタでの編集操作はデモに含まれない（機能自体は存在する）。
- **1. 「たぶん動く」ではなく検証済み** はブラウザではなく tmux ペインを撮っている。Task Contract・
  検証ゲート・Evidence は Web UI をまだ持たず、CLI の出力が唯一それを見せる面だからである。
  この映像に stub は 1 つも無く、`GATE unit PASS` は seed リポジトリの `node --test` の実 exit code。
- **2. 方法論を仕組みに** はネットワークに出る。Catalog の URL は完全一致 allowlist つきの
  コンパイル時定数で、ローカル fixture に差し替えられない。到達できない場合、収録スクリプトは
  空のパネルを撮らずに理由つきで skip を報告する。
- 映像に出ない製品主張（100% ローカル・MIT・`npx` で 60 秒）は、**12** の文字カードに置いている。

## GIF と mp4 の使い分け

GitHub の markdown ビューアは `<video>` を描画しない（HTML 許可リストに含まれず、動画添付が
効くのは issue / PR / discussion のコメントのみ）。そのためページ内で再生されるのは GIF で、
mp4 は元の画質の配布用に併置している。

- GIF: 600px / 10fps / 約 1.0〜1.5MB
- mp4: 1280x800 / 30fps / h264 / 約 0.5〜0.7MB

## 再生成

文言は絵コンテが唯一の編集箇所。

```bash
# 文言を変える
$EDITOR docs/images/features/storyboards/01-parallel-worktrees.yaml

# 1 本だけ撮り直す
.claude/skills/demo-video/scripts/demo-video.sh \
  --storyboard docs/images/features/storyboards/01-parallel-worktrees.yaml \
  --out docs/images/features

# ページに表示される GIF を作り直す（mp4 と同じディレクトリに出る）
.claude/skills/video-to-gif/scripts/to-gif.sh \
  docs/images/features/cm-01-parallel-worktrees.ja.mp4 \
  docs/images/features/cm-01-parallel-worktrees.en.mp4
```

GIF はバイト予算（既定 1.5MB）に収まるまで解像度・fps・パレットを段階的に落とし、
収まらなければ**書かずに** exit 1 する。終了時に「コミットすれば何バイト増えるか」を出す。

絵コンテを編集する前に知っておくとよいことが 3 つある。

- `type: code` のシーンはブラウザを録画せず、ファイルを静止カードとして組版する。`source` は
  絵コンテ自身のディレクトリ配下に解決され、そこから出られない。つまり絵コンテは、同じ場所に
  置いてあるファイルしか映せない（`storyboards/code/` と `11-contract-verify.yaml` を参照）。
- `contract-verify` はブラウザではなく tmux ペインを撮り、ゲートを本当に実行する。
  ライブラリの中で群を抜いて遅いシーンである。
- `install-skill` はネットワークが要る。オフラインでは設計どおり run 全体を失敗させる。
  `--allow-skip` を明示したときだけ、報告つきの skip に変わる。

絵コンテの尺は素材の実尺が上限で、**超えた分は頭が落ち**、足りない分は最終フレームの静止で埋まる。
枠を決めるときはこの両方が効く。ブラウザのシーンは見せ場が末尾にあるので短い枠でよいが、
見せ場が**先頭**にあるシーン（応答する前の Review 一覧）は素材の実尺に近い枠が要る。
2026-08-18 の撮り直し全体の実測値: ブランチ一覧 4.1〜4.7s / 送信→生成 20.8〜26.5s /
入力待ちバッジ 5.8〜6.1s / スマホ承認 11.3〜12.8s / Review 画面 15.8〜17.8s /
差分 9.7〜10.2s / スラッシュパレット 12.0〜15.2s / Skill 導入 10.3〜12.7s /
完了後の一覧 3.7〜4.2s / contract-verify 35.1〜36.0s。

動画は圧縮済みで git の delta 圧縮が効かないため、**作り直すたびに全 12 本を再コミットしない**
こと（`docs/images/demo-mobile.gif` は既に履歴へ 4 版残っている）。差し替えは実際に変えた本数だけ。
今回の撮り直しだけは例外で、収録の間に Activity Bar のアイコンが増えたため、部分更新すると
chrome の異なる版が 1 ページに混在してしまう。

`docs/images/` の `demo-desktop.mp4` / `demo-mobile.mp4` は個人環境で撮られた旧素材で、
README の GIF が参照しているために残っているだけ。**再利用しないこと**
（[website/assets/media/README.md](../../website/assets/media/README.md) 参照）。

## 関連ドキュメント

- [README](../../README.md) — Key Features 一覧
- [コンセプト](../concept.md) — Vision / Mission / 中核原則 / 実装
- [アーキテクチャ](../architecture.md)
- [クイックスタートガイド](../user-guide/quick-start.md)
- [サイドバー ステータスインジケーター](./sidebar-status-indicator.md)
